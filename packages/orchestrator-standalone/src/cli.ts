#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  OrchestrationGoalSchema,
  SourcePolicySchema,
  RiskGateModeSchema,
  WaveStrategySchema,
  ExecutionPlanSchema,
} from "./spec/schemas.js";
import { getRecipeById, getRecipeCatalog } from "./recipes/catalog.js";
import { discoverWorkspaceFacts, summarizeWorkspaceFacts } from "./adapters/workspace-discovery.js";
import { collectInternetEvidence } from "./adapters/internet-evidence.js";
import { getRunStatus, runOrchestrationCycle, validatePlan } from "./kernel/orchestrator.js";
import { DagDependencyModeSchema } from "./dag/types.js";
import { compileRequestDag } from "./dag/compiler.js";
import { runDag } from "./dag/runner.js";

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
  process.stdout.write(`  discover --recipe-id <id> [options]  Run local+internet discovery\n`);
  process.stdout.write(`  plan --goal-type <type> --recipe-id <id> [options]\n`);
  process.stdout.write(`  validate --plan <path>               Validate a plan artifact\n`);
  process.stdout.write(`  execute --goal-type <type> --recipe-id <id> [options]\n`);
  process.stdout.write(`  cycle --goal-type <type> --recipe-id <id> [options]\n`);
  process.stdout.write(`  status --run-id <id> [options]\n\n`);
  process.stdout.write(`  dag-compile --request <path> [options]    Compile request markdown into DAG manifest + parts\n`);
  process.stdout.write(`  dag-run --manifest <path> [options]       Run dependency-aware DAG modules\n\n`);
  process.stdout.write(`Common options:\n`);
  process.stdout.write(`  --workspace-root <path>      (default: .)\n`);
  process.stdout.write(`  --runs-dir <path>            (default: generated/orchestration/standalone/runs)\n`);
  process.stdout.write(`  --run-id <id>\n`);
  process.stdout.write(`  --mode dry-run|apply         (default: dry-run)\n`);
  process.stdout.write(`  --source-policy primary_only|primary_plus_curated_secondary|open_web\n`);
  process.stdout.write(`  --risk-gate-mode strict_blockers|warn_then_apply|manual_override\n`);
  process.stdout.write(`  --wave-strategy incremental_dual_build|pilot_wave|big_bang|custom\n`);
  process.stdout.write(`  --curated-domain <domain>    (repeatable)\n`);
  process.stdout.write(`  --no-require-tdd-tests\n`);
  process.stdout.write(`  --dependency <sequential|parallel|staged> (dag-compile)\n`);
  process.stdout.write(`  --output-dir <path>          (dag-compile; default generated/orchestration/dag)\n`);
  process.stdout.write(`  --executor <cmd-template>    (dag-run; placeholders {id} {title} {partFile} {requestPath})\n`);
  process.stdout.write(`  --fail-policy <graph|global> (dag-run; default graph)\n`);
  process.stdout.write(`  --timeout-ms <n>             (dag-run command timeout)\n`);
  process.stdout.write(`  --dry-run                    (dag-run without executing commands)\n`);
  process.stdout.write(`  --json-out <path>            Write JSON to file\n`);
}

function parseGoal(args: ParsedArgs): ReturnType<typeof OrchestrationGoalSchema.parse> {
  const goalType = option(args, "goal-type");
  const recipeId = option(args, "recipe-id");

  if (!goalType || !recipeId) {
    throw new Error("--goal-type and --recipe-id are required");
  }

  const sourcePolicyRaw = option(args, "source-policy", "primary_plus_curated_secondary") as string;
  const riskGateModeRaw = option(args, "risk-gate-mode", "strict_blockers") as string;
  const waveStrategyRaw = option(args, "wave-strategy");

  const sourcePolicy = SourcePolicySchema.parse(sourcePolicyRaw);
  const riskGateMode = RiskGateModeSchema.parse(riskGateModeRaw);
  const waveStrategy = waveStrategyRaw ? WaveStrategySchema.parse(waveStrategyRaw) : undefined;

  return OrchestrationGoalSchema.parse({
    goalType,
    recipeId,
    workspaceRoot: option(args, "workspace-root", defaultWorkspaceRoot()),
    sourceSystem: option(args, "source-system"),
    targetSystem: option(args, "target-system"),
    sourcePolicy,
    riskGateMode,
    waveStrategy,
    requireTddTests: option(args, "no-require-tdd-tests") ? false : true,
    curatedSourceDomains: optionList(args, "curated-domain"),
  });
}

async function commandRecipes(args: ParsedArgs): Promise<void> {
  const catalog = getRecipeCatalog().map((recipe) => ({
    id: recipe.id,
    goalType: recipe.goalType,
    title: recipe.title,
    version: recipe.version,
  }));
  writeJson(option(args, "json-out"), catalog);
}

async function commandDiscover(args: ParsedArgs): Promise<void> {
  const recipeId = option(args, "recipe-id");
  if (!recipeId) throw new Error("--recipe-id is required for discover");

  const recipe = getRecipeById(recipeId);
  const workspaceRoot = option(args, "workspace-root", ".") as string;
  const sourcePolicy = SourcePolicySchema.parse(
    option(args, "source-policy", "primary_plus_curated_secondary"),
  );

  const facts = discoverWorkspaceFacts(workspaceRoot);
  const evidence = await collectInternetEvidence({
    sources: recipe.discoverySources,
    policy: sourcePolicy,
    curatedDomains: optionList(args, "curated-domain"),
  });

  writeJson(option(args, "json-out"), {
    recipeId: recipe.id,
    workspaceFacts: facts,
    localSummary: summarizeWorkspaceFacts(facts),
    internetEvidence: evidence,
  });
}

async function commandPlan(args: ParsedArgs): Promise<void> {
  const goal = parseGoal(args);
  const mode = (option(args, "mode", "dry-run") as "dry-run" | "apply");
  const runsDir = option(args, "runs-dir", "generated/orchestration/standalone/runs") as string;
  const runId = option(args, "run-id");

  const cycle = await runOrchestrationCycle({
    runId,
    goal,
    mode,
    runsDir,
  });

  writeJson(option(args, "json-out"), {
    runId: cycle.runId,
    plan: cycle.plan,
    validation: cycle.validation,
    persistedPaths: cycle.persistedPaths,
  });
}

async function commandValidate(args: ParsedArgs): Promise<void> {
  const planPath = option(args, "plan");
  if (!planPath) throw new Error("--plan <path> is required");

  const parsed = JSON.parse(readFileSync(path.resolve(planPath), "utf8"));
  const plan = ExecutionPlanSchema.parse(parsed);
  const validation = validatePlan(plan);

  writeJson(option(args, "json-out"), validation);
}

async function commandExecute(args: ParsedArgs): Promise<void> {
  const goal = parseGoal(args);
  const mode = (option(args, "mode", "dry-run") as "dry-run" | "apply");
  const runsDir = option(args, "runs-dir", "generated/orchestration/standalone/runs") as string;
  const runId = option(args, "run-id");

  const cycle = await runOrchestrationCycle({
    runId,
    goal,
    mode,
    runsDir,
  });

  writeJson(option(args, "json-out"), {
    runId: cycle.runId,
    execution: cycle.execution,
    validation: cycle.validation,
    state: cycle.state,
    persistedPaths: cycle.persistedPaths,
  });
}

async function commandCycle(args: ParsedArgs): Promise<void> {
  const goal = parseGoal(args);
  const mode = (option(args, "mode", "dry-run") as "dry-run" | "apply");
  const runsDir = option(args, "runs-dir", "generated/orchestration/standalone/runs") as string;
  const runId = option(args, "run-id");

  const cycle = await runOrchestrationCycle({
    runId,
    goal,
    mode,
    runsDir,
  });

  writeJson(option(args, "json-out"), {
    runId: cycle.runId,
    summary: cycle.cycleSummary,
    state: cycle.state,
    execution: cycle.execution,
    validation: cycle.validation,
    persistedPaths: cycle.persistedPaths,
  });
}

async function commandStatus(args: ParsedArgs): Promise<void> {
  const runId = option(args, "run-id");
  if (!runId) throw new Error("--run-id is required for status");
  const runsDir = option(args, "runs-dir", "generated/orchestration/standalone/runs") as string;
  const state = getRunStatus({ runId, runsDir });
  writeJson(option(args, "json-out"), state);
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

  const timeoutRaw = option(args, "timeout-ms");
  const timeoutMs = timeoutRaw ? Number(timeoutRaw) : undefined;
  if (timeoutRaw && (!Number.isFinite(timeoutMs) || (timeoutMs as number) < 1)) {
    throw new Error("--timeout-ms must be a positive number");
  }

  const summary = runDag({
    workspaceRoot,
    manifestPath,
    executorTemplate: option(args, "executor"),
    failPolicy: failPolicyRaw,
    timeoutMs: timeoutMs as number | undefined,
    outputPath: option(args, "json-out"),
    dryRun: option(args, "dry-run") === "true",
  });

  if (!option(args, "json-out")) {
    writeJson(undefined, summary);
  } else {
    process.stdout.write(
      `${JSON.stringify({ ok: true, status: summary.status, outputPath: option(args, "json-out") }, null, 2)}\n`,
    );
  }
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
    case "dag-compile":
      await commandDagCompile(parsed);
      return;
    case "dag-run":
      await commandDagRun(parsed);
      return;
    default:
      throw new Error(`Unknown command '${parsed.command}'. Use 'help'.`);
  }
}

main().catch((error) => {
  process.stderr.write(`orchestrator CLI error: ${(error as Error).message}\n`);
  process.exitCode = 1;
});
