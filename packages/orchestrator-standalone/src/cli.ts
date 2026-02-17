#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  ExecutionRecipeSchema,
  GoalTypeSchema,
  OrchestrationGoalSchema,
  SourcePolicySchema,
  RiskGateModeSchema,
  WaveStrategySchema,
  ExecutionPlanSchema,
} from "./spec/schemas.js";
import { getRecipeById, getRecipeCatalog } from "./recipes/catalog.js";
import { generateRecipeFromContext } from "./recipes/generator.js";
import { applyRecipeMemory, deriveRecipeMemory } from "./recipes/memory.js";
import { discoverWorkspaceFacts, summarizeWorkspaceFacts } from "./adapters/workspace-discovery.js";
import { collectInternetEvidence } from "./adapters/internet-evidence.js";
import { getRunStatus, runOrchestrationCycle, validatePlan } from "./kernel/orchestrator.js";
import { DagDependencyModeSchema } from "./dag/types.js";
import { compileRequestDag } from "./dag/compiler.js";
import { runDag } from "./dag/runner.js";
import { buildRagIndex, saveRagIndex } from "./rag/indexer.js";
import { loadRagIndex, queryRagIndex } from "./rag/retriever.js";
import { startRagServer } from "./rag/server.js";
import { synthesizeTaskRequest } from "./autonomy/task-synthesizer.js";
import { autoGenerateSkills } from "./skills/autogen.js";
import { runGoldenEvaluation } from "./eval/golden.js";

interface ParsedArgs {
  command: string;
  options: Map<string, string[]>;
  positionals: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const options = new Map<string, string[]>();
  const positionals: string[] = [];

  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      index += 1;
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    const hasValue = next !== undefined && !next.startsWith("--");
    const value = hasValue ? next : "true";

    if (!options.has(key)) options.set(key, []);
    (options.get(key) as string[]).push(value);

    index += hasValue ? 2 : 1;
  }

  const command = positionals[0] ?? "help";
  return { command, options, positionals: positionals.slice(1) };
}

function option(args: ParsedArgs, key: string, fallback?: string): string | undefined {
  const values = args.options.get(key);
  if (!values || values.length === 0) return fallback;
  return values[values.length - 1];
}

function optionList(args: ParsedArgs, key: string): string[] {
  return args.options.get(key) ?? [];
}

function flag(args: ParsedArgs, key: string): boolean {
  return option(args, key) === "true";
}

function parseNumber(args: ParsedArgs, key: string, fallback: number): number {
  const raw = option(args, key);
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`--${key} must be a number`);
  return n;
}

function parseExecutorProfile(value: string): "none" | "codex-safe" | "claude-safe" {
  if (value === "none" || value === "codex-safe" || value === "claude-safe") {
    return value;
  }
  throw new Error("--executor-profile must be none, codex-safe, or claude-safe");
}

function parseExecutorProvider(value: string | undefined): "codex" | "claude" | "custom" | undefined {
  if (!value) return undefined;
  if (value === "codex" || value === "claude" || value === "custom") return value;
  throw new Error("--executor-provider must be codex, claude, or custom");
}

function loadRecipeFile(workspaceRoot: string, recipeFile: string) {
  const absolute = path.isAbsolute(recipeFile) ? recipeFile : path.resolve(workspaceRoot, recipeFile);
  const parsed = JSON.parse(readFileSync(absolute, "utf8"));
  return ExecutionRecipeSchema.parse(parsed);
}

function defaultWorkspaceRoot(): string {
  return process.env.INIT_CWD ? path.resolve(process.env.INIT_CWD) : ".";
}

function writeJson(outPath: string | undefined, payload: unknown, baseDir = process.cwd()): void {
  if (!outPath) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  const absolute = path.isAbsolute(outPath) ? outPath : path.resolve(baseDir, outPath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ ok: true, path: absolute }, null, 2)}\n`);
}

function printHelp(): void {
  process.stdout.write(`orchestrator standalone CLI\n\n`);
  process.stdout.write(`Commands:\n`);
  process.stdout.write(`  recipes                              List available recipe ids\n`);
  process.stdout.write(`  recipe-generate [options]            Generate recipe JSON from discovery + memory\n`);
  process.stdout.write(`  discover --recipe-id <id> [options]  Run local+internet discovery\n`);
  process.stdout.write(`  plan --goal-type <type> --recipe-id <id> [options]\n`);
  process.stdout.write(`  validate --plan <path>               Validate a plan artifact\n`);
  process.stdout.write(`  execute --goal-type <type> --recipe-id <id> [options]\n`);
  process.stdout.write(`  cycle --goal-type <type> --recipe-id <id> [options]\n`);
  process.stdout.write(`  status --run-id <id> [options]\n`);
  process.stdout.write(`  rag-index [options]                  Build local RAG index\n`);
  process.stdout.write(`  rag-query --query <q> [options]      Query local RAG index\n`);
  process.stdout.write(`  rag-serve [options]                  Serve retrieval API over HTTP\n`);
  process.stdout.write(`  synthesize-tasks [options]           Create request.md from discovery + RAG\n`);
  process.stdout.write(`  dag-compile --request <path> [options]\n`);
  process.stdout.write(`  dag-run --manifest <path> [options]\n`);
  process.stdout.write(`  skills-autogen --manifest <path> [options]\n`);
  process.stdout.write(`  auto-run --goal-type <type> --recipe-id <id> [options]\n\n`);
  process.stdout.write(`  eval-golden [options]                Run deterministic golden fixture suite\n\n`);

  process.stdout.write(`Common options:\n`);
  process.stdout.write(`  --workspace-root <path>      (default: INIT_CWD or .)\n`);
  process.stdout.write(`  --json-out <path>            Write JSON to file\n`);
  process.stdout.write(`  --run-id <id>\n`);
  process.stdout.write(`  --runs-dir <path>            (default: generated/orchestration/standalone/runs)\n`);
  process.stdout.write(`  --mode dry-run|apply         (recipe cycle mode; default: dry-run)\n`);
  process.stdout.write(`  --recipe-file <path>         load recipe from JSON instead of catalog id\n`);
  process.stdout.write(`  --source-policy primary_only|primary_plus_curated_secondary|open_web\n`);
  process.stdout.write(`  --risk-gate-mode strict_blockers|warn_then_apply|manual_override\n`);
  process.stdout.write(`  --wave-strategy incremental_dual_build|pilot_wave|big_bang|custom\n`);
  process.stdout.write(`  --curated-domain <domain>    (repeatable)\n`);
  process.stdout.write(`  --no-require-tdd-tests\n\n`);

  process.stdout.write(`RAG options:\n`);
  process.stdout.write(`  --index-path <path>          (default: generated/orchestration/rag/index.json)\n`);
  process.stdout.write(`  --query <text>               (rag-query)\n`);
  process.stdout.write(`  --top-k <n>                  (default: 8)\n`);
  process.stdout.write(`  --max-files <n>              (rag-index; default: 3000)\n`);
  process.stdout.write(`  --lines-per-chunk <n>        (rag-index; default: 120)\n`);
  process.stdout.write(`  --max-chars-per-chunk <n>    (rag-index; default: 5000)\n`);
  process.stdout.write(`  --embedding-dims <n>         (rag-index; default: 96)\n`);
  process.stdout.write(`  --max-terms-per-chunk <n>    (rag-index; default: 180)\n`);
  process.stdout.write(`  --bm25-weight <n>            (rag-query; default: 0.75)\n`);
  process.stdout.write(`  --embedding-weight <n>       (rag-query; default: 0.25)\n`);
  process.stdout.write(`  --host <addr>                (rag-serve; default: 127.0.0.1)\n`);
  process.stdout.write(`  --port <n>                   (rag-serve; default: 8787)\n\n`);

  process.stdout.write(`DAG options:\n`);
  process.stdout.write(`  --request <path>             (dag-compile)\n`);
  process.stdout.write(`  --dependency <sequential|parallel|staged>\n`);
  process.stdout.write(`  --output-dir <path>          (dag-compile; default: generated/orchestration/dag)\n`);
  process.stdout.write(`  --manifest <path>            (dag-run / skills-autogen)\n`);
  process.stdout.write(`  --executor <cmd-template>    placeholders: {id} {title} {partFile} {requestPath}\n`);
  process.stdout.write(`  --executor-profile <none|codex-safe|claude-safe>\n`);
  process.stdout.write(`  --executor-provider <codex|claude|custom>\n`);
  process.stdout.write(`  --provider-template <cmd-template> placeholders: {prompt} {moduleId} {title} {partFile}\n`);
  process.stdout.write(`  --apply-mode <dry-run|apply> (dag-run; default: dry-run)\n`);
  process.stdout.write(`  --apply-guard-token <token>  (required for apply mode unless matching default guard)\n`);
  process.stdout.write(`  --apply-guard-value <token>  (default guard is ALLOW_APPLY)\n`);
  process.stdout.write(`  --approvals-dir <path>       apply approvals dir (default: generated/orchestration/approvals)\n`);
  process.stdout.write(`  --no-require-wave-approval   disable per-wave approval requirement in apply mode\n`);
  process.stdout.write(`  --evidence-file <path>       apply evidence file (default: generated/orchestration/evidence/apply-evidence.md)\n`);
  process.stdout.write(`  --no-require-evidence-file   disable evidence-file requirement in apply mode\n`);
  process.stdout.write(`  --rollback-check-command <c> command that must pass before apply mode proceeds\n`);
  process.stdout.write(`  --fail-policy <graph|global> (default: graph)\n`);
  process.stdout.write(`  --timeout-ms <n>             command timeout\n`);
  process.stdout.write(`  --dry-run                    skip executing module commands in dag-run\n\n`);

  process.stdout.write(`Autonomy options:\n`);
  process.stdout.write(`  --discovery-file <path>      input for synthesize-tasks\n`);
  process.stdout.write(`  --rag-index <path>           input for synthesize-tasks\n`);
  process.stdout.write(`  --request-out <path>         synthesized request path\n`);
  process.stdout.write(`  --max-tasks <n>              cap synthesized tasks\n`);
  process.stdout.write(`  --compile-dag                synthesize command also compiles DAG\n`);
  process.stdout.write(`  --run-summary <path>         run summary path for skills-autogen\n`);
  process.stdout.write(`  --skills-dir <path>          output dir for generated skills\n`);
  process.stdout.write(`  --min-occurrences <n>        threshold for auto skills\n`);
  process.stdout.write(`  --apply-skills               write generated skills\n`);
  process.stdout.write(`  --auto-skills <off|suggest|apply> (auto-run; default: suggest)\n`);
  process.stdout.write(`  --autonomy-dir <path>        (auto-run output root; default: generated/orchestration/autonomy)\n`);
  process.stdout.write(`  --auto-recipe                (auto-run: generate recipe from discovery + memory)\n`);
  process.stdout.write(`  --auto-recipe-id <id>        (auto-run: id for generated recipe)\n`);
  process.stdout.write(`  --recipe-output <path>       (recipe-generate output; default: generated/orchestration/recipes/<id>.json)\n`);
  process.stdout.write(`  --base-recipe-id <id>        (recipe-generate; seed from existing recipe)\n`);
  process.stdout.write(`  --include-internet <bool>    (recipe-generate; default: true)\n`);
  process.stdout.write(`  --fixtures-dir <path>        (eval-golden fixtures root)\n`);
  process.stdout.write(`  --allow-failed true          (eval-golden: do not throw on failures)\n`);
}

function parseGoal(args: ParsedArgs): {
  goal: ReturnType<typeof OrchestrationGoalSchema.parse>;
  recipeOverride: ReturnType<typeof ExecutionRecipeSchema.parse> | undefined;
} {
  const goalType = option(args, "goal-type");
  const recipeId = option(args, "recipe-id");
  const workspaceRoot = option(args, "workspace-root", defaultWorkspaceRoot()) as string;
  const recipeFile = option(args, "recipe-file");

  if (!goalType) {
    throw new Error("--goal-type is required");
  }

  let recipeOverride: ReturnType<typeof ExecutionRecipeSchema.parse> | undefined;
  if (recipeFile) {
    recipeOverride = loadRecipeFile(workspaceRoot, recipeFile);
  }

  const resolvedRecipeId = recipeOverride?.id ?? recipeId;
  if (!resolvedRecipeId) {
    throw new Error("--recipe-id (or --recipe-file) is required");
  }

  const sourcePolicy = SourcePolicySchema.parse(option(args, "source-policy", "primary_plus_curated_secondary"));
  const riskGateMode = RiskGateModeSchema.parse(option(args, "risk-gate-mode", "strict_blockers"));
  const waveStrategyRaw = option(args, "wave-strategy");
  const waveStrategy = waveStrategyRaw ? WaveStrategySchema.parse(waveStrategyRaw) : undefined;

  if (recipeOverride && recipeOverride.goalType !== goalType) {
    throw new Error(
      `Goal type '${goalType}' does not match recipe-file goal type '${recipeOverride.goalType}'.`,
    );
  }

  return {
    goal: OrchestrationGoalSchema.parse({
      goalType,
      recipeId: resolvedRecipeId,
      workspaceRoot,
      sourceSystem: option(args, "source-system"),
      targetSystem: option(args, "target-system"),
      sourcePolicy,
      riskGateMode,
      waveStrategy,
      requireTddTests: flag(args, "no-require-tdd-tests") ? false : true,
      curatedSourceDomains: optionList(args, "curated-domain"),
    }),
    recipeOverride,
  };
}

function resolveRecipe(args: ParsedArgs, workspaceRoot: string): ReturnType<typeof ExecutionRecipeSchema.parse> {
  const recipeFile = option(args, "recipe-file");
  if (recipeFile) {
    return loadRecipeFile(workspaceRoot, recipeFile);
  }

  const recipeId = option(args, "recipe-id");
  if (!recipeId) {
    throw new Error("--recipe-id (or --recipe-file) is required");
  }
  return getRecipeById(recipeId);
}

async function commandRecipeGenerate(args: ParsedArgs): Promise<void> {
  const workspaceRoot = option(args, "workspace-root", defaultWorkspaceRoot()) as string;
  const goalType = GoalTypeSchema.parse(option(args, "goal-type", "custom"));
  const recipeId = option(args, "recipe-id", `autogen-${goalType}-${Date.now()}`) as string;
  const outputPath = option(args, "recipe-output", `generated/orchestration/recipes/${recipeId}.json`) as string;

  const result = await generateRecipeFromContext({
    workspaceRoot,
    goalType,
    recipeId,
    title: option(args, "title"),
    description: option(args, "description"),
    baseRecipeId: option(args, "base-recipe-id"),
    discoveryPath: option(args, "discovery-file"),
    runsDir: option(args, "runs-dir", "generated/orchestration/standalone/runs"),
    sourcePolicy: SourcePolicySchema.parse(option(args, "source-policy", "primary_plus_curated_secondary")),
    curatedDomains: optionList(args, "curated-domain"),
    includeInternet: option(args, "include-internet", "true") !== "false",
    outputPath,
  });

  writeJson(option(args, "json-out"), {
    recipeId: result.recipe.id,
    outputPath: result.outputPath,
    baseRecipeId: result.baseRecipeId,
    summary: result.summary,
    memory: result.memory
      ? {
        analyzedRuns: result.memory.analyzedRuns,
        learnedRiskProbes: result.memory.learnedRiskProbes.map((probe) => probe.id),
        learnedGates: result.memory.learnedGates.map((gate) => gate.id),
      }
      : null,
  }, workspaceRoot);
}

async function commandEvalGolden(args: ParsedArgs): Promise<void> {
  const workspaceRoot = option(args, "workspace-root", defaultWorkspaceRoot()) as string;
  const result = await runGoldenEvaluation({
    fixturesDir: option(args, "fixtures-dir"),
    topK: parseNumber(args, "top-k", 5),
  });

  if (result.failed > 0 && option(args, "allow-failed", "false") !== "true") {
    writeJson(option(args, "json-out"), result, workspaceRoot);
    throw new Error(`Golden suite failed: ${result.failed}/${result.total} scenarios failing.`);
  }

  writeJson(option(args, "json-out"), result, workspaceRoot);
}

async function commandRecipes(args: ParsedArgs): Promise<void> {
  const catalog = getRecipeCatalog().map((recipe) => ({
    id: recipe.id,
    goalType: recipe.goalType,
    title: recipe.title,
    version: recipe.version,
  }));
  writeJson(option(args, "json-out"), catalog, defaultWorkspaceRoot());
}

async function commandDiscover(args: ParsedArgs): Promise<void> {
  const workspaceRoot = option(args, "workspace-root", defaultWorkspaceRoot()) as string;
  const recipe = resolveRecipe(args, workspaceRoot);
  const sourcePolicy = SourcePolicySchema.parse(option(args, "source-policy", "primary_plus_curated_secondary"));

  const facts = discoverWorkspaceFacts(workspaceRoot);
  const evidence = await collectInternetEvidence({
    sources: recipe.discoverySources,
    policy: sourcePolicy,
    curatedDomains: optionList(args, "curated-domain"),
  });

  writeJson(
    option(args, "json-out"),
    {
      recipeId: recipe.id,
      workspaceFacts: facts,
      localSummary: summarizeWorkspaceFacts(facts),
      internetEvidence: evidence,
    },
    workspaceRoot,
  );
}

async function commandPlan(args: ParsedArgs): Promise<void> {
  const { goal, recipeOverride } = parseGoal(args);
  const mode = option(args, "mode", "dry-run") as "dry-run" | "apply";
  const runsDir = option(args, "runs-dir", "generated/orchestration/standalone/runs") as string;
  const runId = option(args, "run-id");

  const cycle = await runOrchestrationCycle({
    runId,
    goal,
    mode,
    runsDir,
    recipeOverride,
    requireWaveApproval: flag(args, "no-require-wave-approval") ? false : undefined,
    approvalsDir: option(args, "approvals-dir"),
    requireEvidenceFile: flag(args, "no-require-evidence-file") ? false : undefined,
    evidenceFile: option(args, "evidence-file"),
    rollbackCheckCommand: option(args, "rollback-check-command"),
  });
  writeJson(option(args, "json-out"), {
    runId: cycle.runId,
    plan: cycle.plan,
    validation: cycle.validation,
    persistedPaths: cycle.persistedPaths,
  }, goal.workspaceRoot);
}

async function commandValidate(args: ParsedArgs): Promise<void> {
  const planPath = option(args, "plan");
  if (!planPath) throw new Error("--plan <path> is required");

  const parsed = JSON.parse(readFileSync(path.resolve(planPath), "utf8"));
  const plan = ExecutionPlanSchema.parse(parsed);
  const validation = validatePlan(plan);
  writeJson(option(args, "json-out"), validation, defaultWorkspaceRoot());
}

async function commandExecute(args: ParsedArgs): Promise<void> {
  const { goal, recipeOverride } = parseGoal(args);
  const mode = option(args, "mode", "dry-run") as "dry-run" | "apply";
  const runsDir = option(args, "runs-dir", "generated/orchestration/standalone/runs") as string;
  const runId = option(args, "run-id");

  const cycle = await runOrchestrationCycle({
    runId,
    goal,
    mode,
    runsDir,
    recipeOverride,
    requireWaveApproval: flag(args, "no-require-wave-approval") ? false : undefined,
    approvalsDir: option(args, "approvals-dir"),
    requireEvidenceFile: flag(args, "no-require-evidence-file") ? false : undefined,
    evidenceFile: option(args, "evidence-file"),
    rollbackCheckCommand: option(args, "rollback-check-command"),
  });
  writeJson(option(args, "json-out"), {
    runId: cycle.runId,
    execution: cycle.execution,
    validation: cycle.validation,
    state: cycle.state,
    persistedPaths: cycle.persistedPaths,
  }, goal.workspaceRoot);
}

async function commandCycle(args: ParsedArgs): Promise<void> {
  const { goal, recipeOverride } = parseGoal(args);
  const mode = option(args, "mode", "dry-run") as "dry-run" | "apply";
  const runsDir = option(args, "runs-dir", "generated/orchestration/standalone/runs") as string;
  const runId = option(args, "run-id");

  const cycle = await runOrchestrationCycle({
    runId,
    goal,
    mode,
    runsDir,
    recipeOverride,
    requireWaveApproval: flag(args, "no-require-wave-approval") ? false : undefined,
    approvalsDir: option(args, "approvals-dir"),
    requireEvidenceFile: flag(args, "no-require-evidence-file") ? false : undefined,
    evidenceFile: option(args, "evidence-file"),
    rollbackCheckCommand: option(args, "rollback-check-command"),
  });
  writeJson(option(args, "json-out"), {
    runId: cycle.runId,
    summary: cycle.cycleSummary,
    state: cycle.state,
    execution: cycle.execution,
    validation: cycle.validation,
    persistedPaths: cycle.persistedPaths,
  }, goal.workspaceRoot);
}

async function commandStatus(args: ParsedArgs): Promise<void> {
  const runId = option(args, "run-id");
  if (!runId) throw new Error("--run-id is required for status");
  const workspaceRoot = option(args, "workspace-root", defaultWorkspaceRoot()) as string;
  const runsDir = option(args, "runs-dir", "generated/orchestration/standalone/runs") as string;
  const state = getRunStatus({ runId, runsDir });
  writeJson(option(args, "json-out"), state, workspaceRoot);
}

async function commandRagIndex(args: ParsedArgs): Promise<void> {
  const workspaceRoot = option(args, "workspace-root", defaultWorkspaceRoot()) as string;
  const indexPath = option(args, "index-path", "generated/orchestration/rag/index.json") as string;

  const index = buildRagIndex({
    workspaceRoot,
    maxFiles: parseNumber(args, "max-files", 3000),
    linesPerChunk: parseNumber(args, "lines-per-chunk", 120),
    maxCharsPerChunk: parseNumber(args, "max-chars-per-chunk", 5000),
    embeddingDims: parseNumber(args, "embedding-dims", 96),
    maxTermsPerChunk: parseNumber(args, "max-terms-per-chunk", 180),
  });

  const savedPath = saveRagIndex({
    index,
    outputPath: path.isAbsolute(indexPath) ? indexPath : path.resolve(workspaceRoot, indexPath),
  });

  writeJson(option(args, "json-out"), {
    savedPath,
    fileCount: index.fileCount,
    chunkCount: index.chunkCount,
    generatedAt: index.generatedAt,
  }, workspaceRoot);
}

async function commandRagQuery(args: ParsedArgs): Promise<void> {
  const workspaceRoot = option(args, "workspace-root", defaultWorkspaceRoot()) as string;
  const indexPath = option(args, "index-path", "generated/orchestration/rag/index.json") as string;
  const query = option(args, "query");

  if (!query || !query.trim()) {
    throw new Error("--query is required for rag-query");
  }

  const index = loadRagIndex(path.isAbsolute(indexPath) ? indexPath : path.resolve(workspaceRoot, indexPath));
  const result = queryRagIndex({
    index,
    query,
    topK: parseNumber(args, "top-k", 8),
    filePathIncludes: option(args, "path"),
    bm25Weight: parseNumber(args, "bm25-weight", 0.75),
    embeddingWeight: parseNumber(args, "embedding-weight", 0.25),
  });

  writeJson(option(args, "json-out"), result, workspaceRoot);
}

async function commandRagServe(args: ParsedArgs): Promise<void> {
  const workspaceRoot = option(args, "workspace-root", defaultWorkspaceRoot()) as string;
  const indexPath = option(args, "index-path", "generated/orchestration/rag/index.json") as string;
  const host = option(args, "host", "127.0.0.1") as string;
  const port = parseNumber(args, "port", 8787);

  const server = startRagServer({
    indexPath: path.isAbsolute(indexPath) ? indexPath : path.resolve(workspaceRoot, indexPath),
    host,
    port,
  });

  process.stdout.write(`${JSON.stringify({ ok: true, host, port }, null, 2)}\n`);

  await new Promise<void>((resolve) => {
    const shutdown = () => {
      server.close(() => resolve());
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}

async function commandSynthesizeTasks(args: ParsedArgs): Promise<void> {
  const { goal, recipeOverride } = parseGoal(args);
  const workspaceRoot = goal.workspaceRoot;
  const requestOut = option(args, "request-out", "generated/orchestration/autonomy/request.generated.md") as string;

  const synthesized = synthesizeTaskRequest({
    workspaceRoot,
    goalType: goal.goalType,
    recipeId: goal.recipeId,
    recipe: recipeOverride,
    discoveryPath: option(args, "discovery-file"),
    ragIndexPath: option(args, "rag-index"),
    outputPath: requestOut,
    maxTasks: parseNumber(args, "max-tasks", 24),
  });

  let manifestPath: string | null = null;
  if (flag(args, "compile-dag")) {
    const outputDir = option(args, "output-dir", "generated/orchestration/autonomy/dag") as string;
    await compileRequestDag({
      workspaceRoot,
      requestPath: path.relative(workspaceRoot, synthesized.requestPath).replace(/\\/g, "/"),
      outputDir,
      dependencyMode: DagDependencyModeSchema.parse(option(args, "dependency", "staged")),
    });
    manifestPath = path.resolve(workspaceRoot, outputDir, "manifest.json");
  }

  writeJson(option(args, "json-out"), {
    requestPath: synthesized.requestPath,
    taskCount: synthesized.taskCount,
    manifestPath,
  }, workspaceRoot);
}

async function commandDagCompile(args: ParsedArgs): Promise<void> {
  const requestPath = option(args, "request");
  if (!requestPath) throw new Error("--request <path> is required");

  const workspaceRoot = option(args, "workspace-root", defaultWorkspaceRoot()) as string;
  const outputDir = option(args, "output-dir", "generated/orchestration/dag") as string;
  const dependencyMode = DagDependencyModeSchema.parse(option(args, "dependency", "staged"));

  const manifest = await compileRequestDag({
    workspaceRoot,
    requestPath,
    outputDir,
    dependencyMode,
    name: option(args, "name"),
    description: option(args, "description"),
  });

  writeJson(option(args, "json-out"), manifest, workspaceRoot);
}

async function commandDagRun(args: ParsedArgs): Promise<void> {
  const manifestPath = option(args, "manifest");
  if (!manifestPath) throw new Error("--manifest <path> is required");

  const workspaceRoot = option(args, "workspace-root", defaultWorkspaceRoot()) as string;
  const failPolicyRaw = option(args, "fail-policy", "graph");
  if (failPolicyRaw !== "graph" && failPolicyRaw !== "global") {
    throw new Error("--fail-policy must be graph or global");
  }

  const executorProfileRaw = parseExecutorProfile(option(args, "executor-profile", "none") as string);
  const executorProviderRaw = parseExecutorProvider(option(args, "executor-provider"));

  const applyModeRaw = option(args, "apply-mode", "dry-run");
  if (applyModeRaw !== "dry-run" && applyModeRaw !== "apply") {
    throw new Error("--apply-mode must be dry-run or apply");
  }

  const timeoutMs = parseNumber(args, "timeout-ms", 10 * 60 * 1000);

  const summary = runDag({
    workspaceRoot,
    manifestPath,
    executorTemplate: option(args, "executor"),
    executorProfile: executorProfileRaw,
    executorProvider: executorProviderRaw,
    providerTemplate: option(args, "provider-template"),
    applyMode: applyModeRaw,
    applyGuardToken: option(args, "apply-guard-token"),
    applyGuardValue: option(args, "apply-guard-value"),
    approvalDir: option(args, "approvals-dir"),
    requireWaveApproval: flag(args, "no-require-wave-approval") ? false : undefined,
    evidenceFilePath: option(args, "evidence-file"),
    requireEvidenceFile: flag(args, "no-require-evidence-file") ? false : undefined,
    rollbackCheckCommand: option(args, "rollback-check-command"),
    failPolicy: failPolicyRaw,
    timeoutMs,
    outputPath: option(args, "json-out"),
    dryRun: flag(args, "dry-run"),
  });

  if (!option(args, "json-out")) {
    writeJson(undefined, summary);
  } else {
    process.stdout.write(
      `${JSON.stringify({ ok: true, status: summary.status, outputPath: option(args, "json-out") }, null, 2)}\n`,
    );
  }
}

async function commandSkillsAutogen(args: ParsedArgs): Promise<void> {
  const manifestPath = option(args, "manifest");
  if (!manifestPath) throw new Error("--manifest <path> is required for skills-autogen");

  const workspaceRoot = option(args, "workspace-root", defaultWorkspaceRoot()) as string;
  const result = autoGenerateSkills({
    workspaceRoot,
    manifestPath,
    runSummaryPath: option(args, "run-summary"),
    outputDir: option(args, "skills-dir", ".codex/skills/generated"),
    minOccurrences: parseNumber(args, "min-occurrences", 2),
    apply: flag(args, "apply-skills"),
  });

  writeJson(option(args, "json-out"), result, workspaceRoot);
}

async function commandAutoRun(args: ParsedArgs): Promise<void> {
  const { goal, recipeOverride } = parseGoal(args);
  const workspaceRoot = goal.workspaceRoot;
  const autonomyDir = option(args, "autonomy-dir", "generated/orchestration/autonomy") as string;

  const discoveryPath = path.resolve(workspaceRoot, autonomyDir, "discovery.json");
  const ragIndexPath = path.resolve(workspaceRoot, autonomyDir, "rag", "index.json");
  const requestPath = path.resolve(workspaceRoot, option(args, "request-out", `${autonomyDir}/request.generated.md`) as string);
  const dagOutputDir = option(args, "output-dir", `${autonomyDir}/dag`) as string;
  const dagManifestPath = path.resolve(workspaceRoot, dagOutputDir, "manifest.json");
  const dagRunSummaryPath = path.resolve(workspaceRoot, autonomyDir, "dag", "run-summary.json");

  const baseRecipe = recipeOverride ?? getRecipeById(goal.recipeId);
  const memory = deriveRecipeMemory({
    runsDir: path.resolve(workspaceRoot, option(args, "runs-dir", "generated/orchestration/standalone/runs") as string),
    recipeId: baseRecipe.id,
  });
  let recipe = applyRecipeMemory({ recipe: baseRecipe, memory });
  const facts = discoverWorkspaceFacts(workspaceRoot);
  const evidence = await collectInternetEvidence({
    sources: recipe.discoverySources,
    policy: goal.sourcePolicy,
    curatedDomains: goal.curatedSourceDomains,
  });

  writeJson(
    path.relative(workspaceRoot, discoveryPath),
    {
      recipeId: recipe.id,
      workspaceFacts: facts,
      localSummary: summarizeWorkspaceFacts(facts),
      internetEvidence: evidence,
    },
    workspaceRoot,
  );

  const autoRecipeEnabled = flag(args, "auto-recipe");
  let generatedRecipePath: string | null = null;
  if (autoRecipeEnabled) {
    const autoRecipeId = option(args, "auto-recipe-id", `${recipe.id}-autogen`) as string;
    const recipeOutputPath = option(args, "recipe-output", `${autonomyDir}/recipe.generated.json`) as string;
    const generated = await generateRecipeFromContext({
      workspaceRoot,
      goalType: goal.goalType,
      recipeId: autoRecipeId,
      baseRecipeId: recipeOverride ? undefined : goal.recipeId,
      discoveryPath,
      runsDir: path.resolve(workspaceRoot, option(args, "runs-dir", "generated/orchestration/standalone/runs") as string),
      sourcePolicy: goal.sourcePolicy,
      curatedDomains: goal.curatedSourceDomains,
      includeInternet: false,
      outputPath: recipeOutputPath,
    });
    recipe = generated.recipe;
    generatedRecipePath = generated.outputPath
      ? path.relative(workspaceRoot, generated.outputPath).replace(/\\/g, "/")
      : null;
  }

  const ragIndex = buildRagIndex({
    workspaceRoot,
    maxFiles: parseNumber(args, "max-files", 3000),
  });
  saveRagIndex({ index: ragIndex, outputPath: ragIndexPath });

  const synthesized = synthesizeTaskRequest({
    workspaceRoot,
    goalType: goal.goalType,
    recipeId: goal.recipeId,
    recipe,
    discoveryPath,
    ragIndexPath,
    outputPath: path.relative(workspaceRoot, requestPath),
    maxTasks: parseNumber(args, "max-tasks", 24),
  });

  await compileRequestDag({
    workspaceRoot,
    requestPath: path.relative(workspaceRoot, synthesized.requestPath).replace(/\\/g, "/"),
    outputDir: dagOutputDir,
    dependencyMode: DagDependencyModeSchema.parse(option(args, "dependency", "staged")),
  });

  const executorProfileRaw = parseExecutorProfile(option(args, "executor-profile", "codex-safe") as string);
  const executorProviderRaw = parseExecutorProvider(option(args, "executor-provider"));

  const applyModeRaw = option(args, "apply-mode", "dry-run");
  if (applyModeRaw !== "dry-run" && applyModeRaw !== "apply") {
    throw new Error("--apply-mode must be dry-run or apply");
  }

  const failPolicyRaw = option(args, "fail-policy", "graph");
  if (failPolicyRaw !== "graph" && failPolicyRaw !== "global") {
    throw new Error("--fail-policy must be graph or global");
  }

  const dagSummary = runDag({
    workspaceRoot,
    manifestPath: path.relative(workspaceRoot, dagManifestPath),
    executorTemplate: option(args, "executor"),
    executorProfile: executorProfileRaw,
    executorProvider: executorProviderRaw,
    providerTemplate: option(args, "provider-template"),
    applyMode: applyModeRaw,
    applyGuardToken: option(args, "apply-guard-token"),
    applyGuardValue: option(args, "apply-guard-value"),
    approvalDir: option(args, "approvals-dir"),
    requireWaveApproval: flag(args, "no-require-wave-approval") ? false : undefined,
    evidenceFilePath: option(args, "evidence-file"),
    requireEvidenceFile: flag(args, "no-require-evidence-file") ? false : undefined,
    rollbackCheckCommand: option(args, "rollback-check-command"),
    failPolicy: failPolicyRaw,
    timeoutMs: parseNumber(args, "timeout-ms", 10 * 60 * 1000),
    outputPath: path.relative(workspaceRoot, dagRunSummaryPath),
    dryRun: flag(args, "dry-run"),
  });

  const autoSkillsMode = option(args, "auto-skills", "suggest");
  if (autoSkillsMode !== "off" && autoSkillsMode !== "suggest" && autoSkillsMode !== "apply") {
    throw new Error("--auto-skills must be off, suggest, or apply");
  }

  const autoSkills = autoSkillsMode === "off"
    ? { candidates: [], created: [] }
    : autoGenerateSkills({
      workspaceRoot,
      manifestPath: path.relative(workspaceRoot, dagManifestPath),
      runSummaryPath: path.relative(workspaceRoot, dagRunSummaryPath),
      outputDir: option(args, "skills-dir", ".codex/skills/generated"),
      minOccurrences: parseNumber(args, "min-occurrences", 2),
      apply: autoSkillsMode === "apply",
    });

  const summary = {
    goal,
    recipe: {
      id: recipe.id,
      title: recipe.title,
      riskProbeCount: recipe.riskProbes.length,
      gateCount: recipe.gates.length,
      memory: {
        analyzedRuns: memory.analyzedRuns,
        learnedRiskProbes: memory.learnedRiskProbes.map((probe) => probe.id),
        learnedGates: memory.learnedGates.map((gate) => gate.id),
      },
      generatedRecipePath,
    },
    artifacts: {
      discoveryPath: path.relative(workspaceRoot, discoveryPath).replace(/\\/g, "/"),
      ragIndexPath: path.relative(workspaceRoot, ragIndexPath).replace(/\\/g, "/"),
      requestPath: path.relative(workspaceRoot, synthesized.requestPath).replace(/\\/g, "/"),
      dagManifestPath: path.relative(workspaceRoot, dagManifestPath).replace(/\\/g, "/"),
      dagRunSummaryPath: path.relative(workspaceRoot, dagRunSummaryPath).replace(/\\/g, "/"),
    },
    dagStatus: dagSummary.status,
    synthesizedTaskCount: synthesized.taskCount,
    autoSkills,
    generatedAt: new Date().toISOString(),
  };

  writeJson(option(args, "json-out", `${autonomyDir}/auto-run-summary.json`), summary, workspaceRoot);
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));

  switch (parsed.command) {
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;
    case "recipes":
      await commandRecipes(parsed);
      return;
    case "recipe-generate":
      await commandRecipeGenerate(parsed);
      return;
    case "eval-golden":
      await commandEvalGolden(parsed);
      return;
    case "discover":
      await commandDiscover(parsed);
      return;
    case "plan":
      await commandPlan(parsed);
      return;
    case "validate":
      await commandValidate(parsed);
      return;
    case "execute":
      await commandExecute(parsed);
      return;
    case "cycle":
      await commandCycle(parsed);
      return;
    case "status":
      await commandStatus(parsed);
      return;
    case "rag-index":
      await commandRagIndex(parsed);
      return;
    case "rag-query":
      await commandRagQuery(parsed);
      return;
    case "rag-serve":
      await commandRagServe(parsed);
      return;
    case "synthesize-tasks":
      await commandSynthesizeTasks(parsed);
      return;
    case "dag-compile":
      await commandDagCompile(parsed);
      return;
    case "dag-run":
      await commandDagRun(parsed);
      return;
    case "skills-autogen":
      await commandSkillsAutogen(parsed);
      return;
    case "auto-run":
      await commandAutoRun(parsed);
      return;
    default:
      throw new Error(`Unknown command '${parsed.command}'. Use 'help'.`);
  }
}

main().catch((error) => {
  process.stderr.write(`orchestrator CLI error: ${(error as Error).message}\n`);
  process.exitCode = 1;
});
