#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
import { generateRecipeFromContext, scaffoldRecipeTemplate } from "./recipes/generator.js";
import { applyRecipeMemory, deriveRecipeMemory } from "./recipes/memory.js";
import { discoverWorkspaceFacts, summarizeWorkspaceFacts } from "./adapters/workspace-discovery.js";
import { collectInternetEvidence } from "./adapters/internet-evidence.js";
import { getRunStatus, runOrchestrationCycle, validatePlan } from "./kernel/orchestrator.js";
import { DagDependencyModeSchema } from "./dag/types.js";
import { compileRequestDag } from "./dag/compiler.js";
import { runDag } from "./dag/runner.js";
import { buildRagIndex, saveRagIndex } from "./rag/indexer.js";
import { loadRagIndex, queryRagIndex } from "./rag/retriever.js";
import { runAutoRefineQuery } from "./rag/refine.js";
import { startRagServer } from "./rag/server.js";
import { synthesizeTaskRequest } from "./autonomy/task-synthesizer.js";
import { compactSemanticMemory, recordSemanticState } from "./autonomy/semantic-memory.js";
import { compactReplayMemory } from "./rag/replay-memory.js";
import {
  cancelWorkerJob,
  defaultWorkerId,
  defaultWorkerStatePath,
  enqueueWorkerJob,
  loadWorkerState,
  retryWorkerJob,
  runWorkerLoop,
  summarizeWorkerState,
} from "./autonomy/worker.js";
import { autoGenerateSkills } from "./skills/autogen.js";
import { runGoldenEvaluation } from "./eval/golden.js";
import { runBenchmarkEvaluation } from "./eval/benchmark.js";
import { applyPolicyPacksToRecipe, listPolicyPacks } from "./policy/packs.js";

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
    if (token === "--") {
      index += 1;
      continue;
    }
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

function parseOptionalNumber(args: ParsedArgs, key: string): number | undefined {
  const raw = option(args, key);
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`--${key} must be a number`);
  return n;
}

function copyOptionsRecord(args: ParsedArgs, omitKeys: Set<string>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [key, values] of args.options.entries()) {
    if (omitKeys.has(key)) continue;
    out[key] = values.slice();
  }
  return out;
}

function pickOptionsRecord(args: ParsedArgs, allowKeys: Set<string>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [key, values] of args.options.entries()) {
    if (!allowKeys.has(key)) continue;
    out[key] = values.slice();
  }
  return out;
}

function parsedArgsFromOptionRecord(command: string, options: Record<string, string[]>): ParsedArgs {
  const map = new Map<string, string[]>();
  for (const [key, values] of Object.entries(options)) {
    map.set(key, values.slice());
  }
  return {
    command,
    options: map,
    positionals: [],
  };
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

function parseProviderPreset(value: string | undefined): {
  executorProfile?: "none" | "codex-safe" | "claude-safe";
  executorProvider?: "codex" | "claude" | "custom";
  providerTemplate?: string;
} {
  if (!value) return {};
  if (value === "codex") {
    return { executorProfile: "codex-safe" };
  }
  if (value === "claude" || value === "claude-subscription") {
    return { executorProfile: "claude-safe" };
  }
  if (value === "openai") {
    return {
      executorProfile: "none",
      executorProvider: "codex",
    };
  }
  if (value === "anthropic") {
    return {
      executorProfile: "none",
      executorProvider: "claude",
    };
  }
  throw new Error("--provider-preset must be codex, claude, claude-subscription, openai, or anthropic");
}

function parseTestImpactMode(value: string | undefined): "off" | "targeted" | "targeted_then_full" {
  if (!value) return "off";
  if (value === "off" || value === "targeted" || value === "targeted_then_full") return value;
  throw new Error("--test-impact must be off, targeted, or targeted_then_full");
}

function parseGraphMode(value: string | undefined): "v1" | "v2" | "auto" {
  if (!value || value === "auto") return "auto";
  if (value === "v1" || value === "v2") return value;
  throw new Error("--graph-mode must be v1, v2, or auto");
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
  process.stdout.write(`  policy-packs                         List built-in policy packs\n`);
  process.stdout.write(`  recipe-generate [options]            Generate recipe JSON from discovery + memory\n`);
  process.stdout.write(`  recipe-init [options]                Scaffold a new recipe JSON with safe defaults\n`);
  process.stdout.write(`  recipe-intake [options]              Generate recipe and enqueue autonomous worker job\n`);
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
  process.stdout.write(`  memory-hygiene [options]              Compact/prune semantic + replay memory state\n\n`);
  process.stdout.write(`  worker-enqueue --goal-type <type> --recipe-id <id> [options]\n`);
  process.stdout.write(`  worker-run [options]                  Run long-lived worker loop\n`);
  process.stdout.write(`  worker-status [options]               Inspect worker queue and heartbeat status\n\n`);
  process.stdout.write(`  worker-cancel --job-id <id> [options] Cancel pending/running worker job\n`);
  process.stdout.write(`  worker-retry --job-id <id> [options]  Re-queue failed/canceled worker job\n\n`);
  process.stdout.write(`  eval-golden [options]                Run deterministic golden fixture suite\n\n`);
  process.stdout.write(`  eval-benchmark [options]             Run benchmark scorecard suite\n\n`);

  process.stdout.write(`Common options:\n`);
  process.stdout.write(`  --workspace-root <path>      (default: INIT_CWD or .)\n`);
  process.stdout.write(`  --json-out <path>            Write JSON to file\n`);
  process.stdout.write(`  --run-id <id>\n`);
  process.stdout.write(`  --runs-dir <path>            (default: generated/orchestration/standalone/runs)\n`);
  process.stdout.write(`  --mode dry-run|apply         (recipe cycle mode; default: dry-run)\n`);
  process.stdout.write(`  --recipe-output <path>       output path for recipe-generate/recipe-init\n`);
  process.stdout.write(`  --recipe-file <path>         load recipe from JSON instead of catalog id\n`);
  process.stdout.write(`  --overwrite                  allow recipe-init to overwrite existing output path\n`);
  process.stdout.write(`  --source-policy primary_only|primary_plus_curated_secondary|open_web\n`);
  process.stdout.write(`  --risk-gate-mode strict_blockers|warn_then_apply|manual_override\n`);
  process.stdout.write(`  --wave-strategy incremental_dual_build|pilot_wave|big_bang|custom\n`);
  process.stdout.write(`  --policy-pack <id>           apply reusable org policy pack (repeatable)\n`);
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
  process.stdout.write(`  --max-file-bytes <n>         (rag-index/auto-run; skip files larger than n bytes; default: 1500000)\n`);
  process.stdout.write(`  --max-chunks <n>             (rag-index/auto-run; cap indexed chunks; default: 10000)\n`);
  process.stdout.write(`  --max-total-chars <n>        (rag-index/auto-run; cap total indexed chunk chars; default: 20000000)\n`);
  process.stdout.write(`  --include-generated <bool>   (rag-index/auto-run; include generated/ dir; default: false)\n`);
  process.stdout.write(`  --bm25-weight <n>            (rag-query; default: 0.75)\n`);
  process.stdout.write(`  --embedding-weight <n>       (rag-query; default: 0.25)\n`);
  process.stdout.write(`  --auto-refine                (rag-query; iterative query refinement)\n`);
  process.stdout.write(`  --refine-iterations <n>      (rag-query; default: 3)\n`);
  process.stdout.write(`  --refine-queries <n>         (rag-query; max total refined queries; default: 20)\n`);
  process.stdout.write(`  --refine-queries-per-iteration <n> (rag-query; default: 4)\n`);
  process.stdout.write(`  --refine-runtime-ms <n>      (rag-query; runtime budget; default: 5000)\n`);
  process.stdout.write(`  --refine-token-budget <n>    (rag-query; token budget; default: 12000; 0 disables)\n`);
  process.stdout.write(`  --refine-max-stall-iterations <n> (rag-query; default: 2)\n`);
  process.stdout.write(`  --refine-convergence-epsilon <n> (rag-query; default: 0.005)\n`);
  process.stdout.write(`  --host <addr>                (rag-serve; default: 127.0.0.1)\n`);
  process.stdout.write(`  --port <n>                   (rag-serve; default: 8787)\n\n`);

  process.stdout.write(`DAG options:\n`);
  process.stdout.write(`  --request <path>             (dag-compile)\n`);
  process.stdout.write(`  --dependency <sequential|parallel|staged>\n`);
  process.stdout.write(`  --run-id <id>                (dag-run/auto-run correlation id)\n`);
  process.stdout.write(`  --graph-mode <v1|v2|auto>   (dag-compile/dag-run/auto-run; default: auto)\n`);
  process.stdout.write(`  --graph-v2-inject-policy-anchors <bool> (auto-run; default: false)\n`);
  process.stdout.write(`  --output-dir <path>          (dag-compile; default: generated/orchestration/dag)\n`);
  process.stdout.write(`  --manifest <path>            (dag-run / skills-autogen)\n`);
  process.stdout.write(`  --executor <cmd-template>    placeholders: {id} {title} {partFile} {requestPath}\n`);
  process.stdout.write(`  --executor-profile <none|codex-safe|claude-safe> (dag-run/auto-run; default: codex-safe)\n`);
  process.stdout.write(`  --executor-provider <codex|claude|custom>\n`);
  process.stdout.write(`  --provider-preset <codex|claude|claude-subscription|openai|anthropic>\n`);
  process.stdout.write(`  --claude-subscription        alias for --provider-preset claude-subscription\n`);
  process.stdout.write(`  --provider-template <cmd-template> placeholders: {prompt} {moduleId} {title} {partFile}\n`);
  process.stdout.write(`  --apply-mode <dry-run|apply> (dag-run; default: dry-run)\n`);
  process.stdout.write(`  --events-path <path>         (dag-run; default: <summary>.events.ndjson)\n`);
  process.stdout.write(`  --apply-guard-token <token>  (required for apply mode unless matching default guard)\n`);
  process.stdout.write(`  --apply-guard-value <token>  (default guard is ALLOW_APPLY)\n`);
  process.stdout.write(`  --approvals-dir <path>       apply approvals dir (default: generated/orchestration/approvals)\n`);
  process.stdout.write(`  --no-require-wave-approval   disable per-wave approval requirement in apply mode\n`);
  process.stdout.write(`  --evidence-file <path>       apply evidence file (default: generated/orchestration/evidence/apply-evidence.md)\n`);
  process.stdout.write(`  --no-require-evidence-file   disable evidence-file requirement in apply mode\n`);
  process.stdout.write(`  --rollback-check-command <c> command that must pass before apply mode proceeds\n`);
  process.stdout.write(`  --fail-policy <graph|global> (default: graph)\n`);
  process.stdout.write(`  --fail-fast                  stop immediately on first failed/blocked module\n`);
  process.stdout.write(`  --timeout-ms <n>             command timeout (default: 600000; queued jobs default: 300000)\n`);
  process.stdout.write(`  --analyze-timeout-ms <n>     cap analyze/query module timeout (default: min(timeout-ms, 45000))\n`);
  process.stdout.write(`  --resume-success-modules <bool> reuse prior successful module artifacts when input digest matches (default: true)\n`);
  process.stdout.write(`  --enable-critic              run critic pass after each successful module command\n`);
  process.stdout.write(`  --critic-command <template>  critic command template with module placeholders\n`);
  process.stdout.write(`  --policy-critic-config <p>   JSON config for policy-pack critic templates/parsers\n`);
  process.stdout.write(`  --critic-fail-level <level>  info|warning|blocker threshold (default: blocker)\n`);
  process.stdout.write(`  --enable-repair-loop         auto-generate focused module repair task on failure\n`);
  process.stdout.write(`  --max-repair-attempts <n>    max focused repair attempts per module (default: 1)\n`);
  process.stdout.write(`  --memory-revisit <bool>      enable recall from semantic/replay/artifact memory for repairs (default: true)\n`);
  process.stdout.write(`  --memory-revisit-recipe-id <id> recipe id used to locate semantic/replay memory (defaults to current recipe in auto-run)\n`);
  process.stdout.write(`  --memory-revisit-autonomy-dir <p> autonomy root for memory files (default: generated/orchestration/autonomy)\n`);
  process.stdout.write(`  --memory-revisit-semantic-path <p> semantic memory path override\n`);
  process.stdout.write(`  --memory-revisit-replay-path <p> replay memory path override\n`);
  process.stdout.write(`  --memory-revisit-max-calls-per-module <n> max recall passes per module (default: 1)\n`);
  process.stdout.write(`  --memory-revisit-top-k <n>   max recalled evidence items attached to repair task (default: 3)\n`);
  process.stdout.write(`  --memory-revisit-min-score <n> minimum recall score threshold (default: 0)\n`);
  process.stdout.write(`  --max-total-attempts <n>     strict run budget for module attempts\n`);
  process.stdout.write(`  --max-total-tokens <n>       strict run budget for estimated token usage\n`);
  process.stdout.write(`  --max-run-runtime-ms <n>     strict run budget for elapsed runtime\n`);
  process.stdout.write(`  --artifacts-dir <path>       module artifact contract output dir\n`);
  process.stdout.write(`  --repairs-dir <path>         focused repair-task output dir\n`);
  process.stdout.write(`  --no-require-artifact-contract disable required module artifact contract writes\n`);
  process.stdout.write(`  --test-impact <mode>         off|targeted|targeted_then_full\n`);
  process.stdout.write(`  --full-test-command <cmd>    full-suite command for targeted_then_full mode\n`);
  process.stdout.write(`  --full-test-in-dry-run <bool> run full-suite gate in apply-mode dry-run (default: false)\n`);
  process.stdout.write(`  --canary-modules <n>         run canary checkpoint after N successful modules\n`);
  process.stdout.write(`  --canary-compare-command <c> command to compare metrics before full rollout\n`);
  process.stdout.write(`  --max-parallel <n>           max concurrent modules per level (default: 1)\n`);
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
  process.stdout.write(`  --rag-auto-refine <bool>     (auto-run/synthesize-tasks; default true)\n`);
  process.stdout.write(`  --rag-refine-iterations <n>  (auto-run/synthesize-tasks; default: 3)\n`);
  process.stdout.write(`  --rag-refine-queries-per-iteration <n> (auto-run/synthesize-tasks; default: 4)\n`);
  process.stdout.write(`  --rag-refine-queries <n>     (auto-run/synthesize-tasks; default: 20)\n`);
  process.stdout.write(`  --rag-refine-runtime-ms <n>  (auto-run/synthesize-tasks; default: 5000)\n`);
  process.stdout.write(`  --rag-refine-token-budget <n> (auto-run/synthesize-tasks; default: 12000; 0 disables)\n`);
  process.stdout.write(`  --rag-refine-max-stall-iterations <n> (auto-run/synthesize-tasks; default: 2)\n`);
  process.stdout.write(`  --rag-refine-convergence-epsilon <n> (auto-run/synthesize-tasks; default: 0.005)\n`);
  process.stdout.write(`  --rag-replay-memory <bool>   (auto-run/synthesize-tasks; default: true)\n`);
  process.stdout.write(`  --rag-replay-memory-path <p> (auto-run/synthesize-tasks; replay memory path override)\n`);
  process.stdout.write(`  --rag-replay-max-entries <n> (auto-run/synthesize-tasks; replay retention cap; default: 240)\n`);
  process.stdout.write(`  --rag-replay-max-age-days <n> (auto-run/synthesize-tasks; replay max age days; default: 90)\n`);
  process.stdout.write(`  --rag-replay-min-score <n>   (auto-run/synthesize-tasks; replay min confidence score; default: 0)\n`);
  process.stdout.write(`  --rag-replay-min-success-count <n> (auto-run/synthesize-tasks; replay min success count; default: 1)\n`);
  process.stdout.write(`  --recipe-output <path>       (recipe-generate output; default: generated/orchestration/recipes/<id>.json)\n`);
  process.stdout.write(`  --base-recipe-id <id>        (recipe-generate; seed from existing recipe)\n`);
  process.stdout.write(`  --semantic-memory-path <p>   semantic memory state path override\n`);
  process.stdout.write(`  --no-semantic-memory         disable semantic memory persistence for auto-run\n`);
  process.stdout.write(`  --memory-hygiene-max-entries <n> (memory-hygiene; semantic max entries; default: 500)\n`);
  process.stdout.write(`  --memory-hygiene-max-age-days <n> (memory-hygiene; semantic max age in days; default: 180)\n`);
  process.stdout.write(`  --memory-hygiene-scan <bool> (memory-hygiene; compact every memory file under autonomy dir; default: true)\n`);
  process.stdout.write(`  --include-internet <bool>    (recipe-generate; default: true)\n`);
  process.stdout.write(`  --fixtures-dir <path>        (eval-golden fixtures root)\n`);
  process.stdout.write(`  --allow-failed true          (eval-golden: do not throw on failures)\n`);
  process.stdout.write(`  --benchmark-history-path <p> (eval-benchmark history path; default: generated/orchestration/benchmark/history.json)\n`);
  process.stdout.write(`  --no-benchmark-history       (eval-benchmark disable history persistence)\n`);
  process.stdout.write(`  --no-benchmark-failure-drills (eval-benchmark disable injected failure drills)\n`);
  process.stdout.write(`  --benchmark-commit <id>      (eval-benchmark override commit identifier)\n`);
  process.stdout.write(`  --benchmark-max-quality-drop <n> (eval-benchmark fail if quality drop exceeds n)\n`);
  process.stdout.write(`  --benchmark-max-time-increase-ms <n> (eval-benchmark fail if avg time increase exceeds n)\n`);
  process.stdout.write(`  --benchmark-max-cost-increase-tokens <n> (eval-benchmark fail if avg token cost increase exceeds n)\n`);
  process.stdout.write(`  --benchmark-max-failure-rate-increase <n> (eval-benchmark fail if failure-rate increase exceeds n)\n`);
  process.stdout.write(`  --benchmark-max-pass-rate-drop <n> (eval-benchmark fail if pass-rate drop exceeds n)\n`);

  process.stdout.write(`\nWorker options:\n`);
  process.stdout.write(`  --worker-state-path <path>  Queue state file (default: generated/orchestration/worker/state.json)\n`);
  process.stdout.write(`  --worker-id <id>            Worker identity (default: <hostname>-<pid>)\n`);
  process.stdout.write(`  --job-id <id>               Optional deterministic job id (worker-enqueue)\n`);
  process.stdout.write(`  --job-summary-path <path>   Auto-run summary path for job output\n`);
  process.stdout.write(`  --max-attempts <n>          Max retries per queued job (default: 3)\n`);
  process.stdout.write(`  --reason <text>             Optional operator reason for worker-cancel/worker-retry\n`);
  process.stdout.write(`  --reset-attempts            Reset attempt counter to 0 on worker-retry\n`);
  process.stdout.write(`  --once                      Process at most one queued job then exit\n`);
  process.stdout.write(`  --stop-when-empty           Exit worker loop when queue has no pending jobs\n`);
  process.stdout.write(`  --max-jobs <n>              Process at most N jobs before exit\n`);
  process.stdout.write(`  --poll-interval-ms <n>      Idle poll interval (default: 5000)\n`);
  process.stdout.write(`  --heartbeat-interval-ms <n> Heartbeat update interval for running jobs (default: 5000)\n`);
  process.stdout.write(`  --stale-heartbeat-ms <n>    Stale-running threshold for crash recovery (default: 120000)\n`);
  process.stdout.write(`  --idle-timeout-ms <n>       Exit after idle duration with no pending jobs\n`);
  process.stdout.write(`  --limit <n>                 Limit jobs in worker-status output (default: 100)\n`);
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

function resolveRecipeWithPolicies(args: ParsedArgs, workspaceRoot: string): {
  recipe: ReturnType<typeof ExecutionRecipeSchema.parse>;
  policyPackIds: string[];
  policyRules: string[];
} {
  const recipe = resolveRecipe(args, workspaceRoot);
  const policyPackIds = optionList(args, "policy-pack");
  const withPolicies = applyPolicyPacksToRecipe({
    recipe,
    policyPackIds,
  });

  return {
    recipe: withPolicies.recipe,
    policyPackIds: withPolicies.appliedPacks.map((pack) => pack.id),
    policyRules: withPolicies.policyRules,
  };
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

  const policyApplied = applyPolicyPacksToRecipe({
    recipe: result.recipe,
    policyPackIds: optionList(args, "policy-pack"),
  });

  if (result.outputPath && policyApplied.appliedPacks.length > 0) {
    const abs = path.resolve(workspaceRoot, result.outputPath);
    writeFileSync(abs, `${JSON.stringify(policyApplied.recipe, null, 2)}\n`, "utf8");
  }

  writeJson(option(args, "json-out"), {
    recipeId: policyApplied.recipe.id,
    outputPath: result.outputPath,
    baseRecipeId: result.baseRecipeId,
    policyPacks: policyApplied.appliedPacks.map((pack) => pack.id),
    policyRules: policyApplied.policyRules,
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

async function commandRecipeInit(args: ParsedArgs): Promise<void> {
  const workspaceRoot = path.resolve(option(args, "workspace-root", defaultWorkspaceRoot()) as string);
  const recipeId = option(args, "recipe-id");
  if (!recipeId) {
    throw new Error("--recipe-id is required for recipe-init");
  }

  const goalType = GoalTypeSchema.parse(option(args, "goal-type", "custom"));
  const recipeIdSlug = recipeId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
  const outputPath = option(
    args,
    "recipe-output",
    `generated/orchestration/recipes/${recipeIdSlug || "new-recipe"}.json`,
  ) as string;

  const scaffolded = scaffoldRecipeTemplate({
    workspaceRoot,
    goalType,
    recipeId,
    title: option(args, "title"),
    description: option(args, "description"),
    outputPath,
    overwrite: flag(args, "overwrite"),
  });

  writeJson(option(args, "json-out"), {
    recipeId: scaffolded.recipe.id,
    outputPath: scaffolded.outputPath
      ? path.relative(workspaceRoot, scaffolded.outputPath).replace(/\\/g, "/")
      : null,
    summary: scaffolded.summary,
    inferredPreconditions: scaffolded.recipe.preconditions,
  }, workspaceRoot);
}

async function commandRecipeIntake(args: ParsedArgs): Promise<void> {
  const workspaceRoot = path.resolve(option(args, "workspace-root", defaultWorkspaceRoot()) as string);
  const goalType = GoalTypeSchema.parse(option(args, "goal-type", "custom"));
  const recipeId = option(args, "recipe-id", `intake-${goalType}-${Date.now()}`) as string;
  const outputPath = option(args, "recipe-output", `generated/orchestration/recipes/${recipeId}.json`) as string;

  const generated = await generateRecipeFromContext({
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

  const policyApplied = applyPolicyPacksToRecipe({
    recipe: generated.recipe,
    policyPackIds: optionList(args, "policy-pack"),
  });

  if (generated.outputPath && policyApplied.appliedPacks.length > 0) {
    const abs = path.resolve(workspaceRoot, generated.outputPath);
    writeFileSync(abs, `${JSON.stringify(policyApplied.recipe, null, 2)}\n`, "utf8");
  }

  const recipeOutputAbs = generated.outputPath
    ? path.resolve(generated.outputPath)
    : path.resolve(workspaceRoot, outputPath);
  const recipeOutputRel = path.relative(workspaceRoot, recipeOutputAbs).replace(/\\/g, "/");
  const workerStatePath = path.resolve(
    workspaceRoot,
    option(args, "worker-state-path", path.relative(workspaceRoot, defaultWorkerStatePath(workspaceRoot))) as string,
  );

  const autoRunOptions = pickOptionsRecord(args, AUTO_RUN_ALLOWED_KEYS);
  autoRunOptions["workspace-root"] = [workspaceRoot];
  autoRunOptions["goal-type"] = [goalType];
  autoRunOptions["recipe-file"] = [recipeOutputRel];
  delete autoRunOptions["recipe-id"];
  if (!autoRunOptions["apply-mode"]) autoRunOptions["apply-mode"] = ["dry-run"];
  if (!autoRunOptions["timeout-ms"]) autoRunOptions["timeout-ms"] = [DEFAULT_QUEUED_TIMEOUT_MS];

  const enqueued = enqueueWorkerJob({
    statePath: workerStatePath,
    workspaceRoot,
    autoRunOptions,
    maxAttempts: parseNumber(args, "max-attempts", 3),
    jobId: option(args, "job-id"),
    summaryPath: option(args, "job-summary-path"),
  });

  writeJson(option(args, "json-out"), {
    generatedRecipe: {
      recipeId: policyApplied.recipe.id,
      outputPath: recipeOutputRel,
      baseRecipeId: generated.baseRecipeId,
      policyPacks: policyApplied.appliedPacks.map((pack) => pack.id),
      policyRules: policyApplied.policyRules,
      summary: generated.summary,
    },
    worker: {
      statePath: workerStatePath,
      job: enqueued.job,
      summary: summarizeWorkerState({
        state: enqueued.state,
        staleHeartbeatMs: parseNumber(args, "stale-heartbeat-ms", 120_000),
      }),
    },
  }, workspaceRoot);
}

async function commandEvalGolden(args: ParsedArgs): Promise<void> {
  const workspaceRoot = option(args, "workspace-root", defaultWorkspaceRoot()) as string;
  const fixturesDirRaw = option(args, "fixtures-dir");
  const result = await runGoldenEvaluation({
    fixturesDir: fixturesDirRaw
      ? path.isAbsolute(fixturesDirRaw)
        ? fixturesDirRaw
        : path.resolve(workspaceRoot, fixturesDirRaw)
      : undefined,
    topK: parseNumber(args, "top-k", 5),
  });

  if (result.failed > 0 && option(args, "allow-failed", "false") !== "true") {
    writeJson(option(args, "json-out"), result, workspaceRoot);
    throw new Error(`Golden suite failed: ${result.failed}/${result.total} scenarios failing.`);
  }

  writeJson(option(args, "json-out"), result, workspaceRoot);
}

async function commandEvalBenchmark(args: ParsedArgs): Promise<void> {
  const workspaceRoot = option(args, "workspace-root", defaultWorkspaceRoot()) as string;
  const fixturesDirRaw = option(args, "fixtures-dir");
  const jsonOut = option(args, "json-out");
  const result = await runBenchmarkEvaluation({
    fixturesDir: fixturesDirRaw
      ? path.isAbsolute(fixturesDirRaw)
        ? fixturesDirRaw
        : path.resolve(workspaceRoot, fixturesDirRaw)
      : undefined,
    topK: parseNumber(args, "top-k", 5),
    includeFailureDrills: !flag(args, "no-benchmark-failure-drills"),
    historyPath: path.resolve(
      workspaceRoot,
      option(args, "benchmark-history-path", "generated/orchestration/benchmark/history.json") as string,
    ),
    persistHistory: !flag(args, "no-benchmark-history"),
    commit: option(args, "benchmark-commit"),
    trendThresholds: {
      maxQualityScoreDrop: parseOptionalNumber(args, "benchmark-max-quality-drop"),
      maxTimeMsIncrease: parseOptionalNumber(args, "benchmark-max-time-increase-ms"),
      maxCostTokensIncrease: parseOptionalNumber(args, "benchmark-max-cost-increase-tokens"),
      maxFailureRateIncrease: parseOptionalNumber(args, "benchmark-max-failure-rate-increase"),
      maxPassRateDrop: parseOptionalNumber(args, "benchmark-max-pass-rate-drop"),
    },
  });

  writeJson(jsonOut, result, workspaceRoot);

  if (result.trend.gate.enabled && result.trend.gate.checked && !result.trend.gate.passed) {
    throw new Error(`Benchmark trend threshold violations: ${result.trend.gate.violations.join("; ")}`);
  }
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

async function commandPolicyPacks(args: ParsedArgs): Promise<void> {
  const packs = listPolicyPacks().map((pack) => ({
    id: pack.id,
    title: pack.title,
    description: pack.description,
    rules: pack.rules,
    gates: pack.gates.map((gate) => gate.id),
  }));
  writeJson(option(args, "json-out"), packs, defaultWorkspaceRoot());
}

async function commandDiscover(args: ParsedArgs): Promise<void> {
  const workspaceRoot = option(args, "workspace-root", defaultWorkspaceRoot()) as string;
  const { recipe, policyPackIds } = resolveRecipeWithPolicies(args, workspaceRoot);
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
      policyPacks: policyPackIds,
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
  const baseRecipe = recipeOverride ?? getRecipeById(goal.recipeId);
  const policyApplied = applyPolicyPacksToRecipe({
    recipe: baseRecipe,
    policyPackIds: optionList(args, "policy-pack"),
  });

  const cycle = await runOrchestrationCycle({
    runId,
    goal,
    mode,
    runsDir,
    recipeOverride: policyApplied.recipe,
    requireWaveApproval: flag(args, "no-require-wave-approval") ? false : undefined,
    approvalsDir: option(args, "approvals-dir"),
    requireEvidenceFile: flag(args, "no-require-evidence-file") ? false : undefined,
    evidenceFile: option(args, "evidence-file"),
    rollbackCheckCommand: option(args, "rollback-check-command"),
  });
  writeJson(option(args, "json-out"), {
    runId: cycle.runId,
    policyPacks: policyApplied.appliedPacks.map((pack) => pack.id),
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
  const baseRecipe = recipeOverride ?? getRecipeById(goal.recipeId);
  const policyApplied = applyPolicyPacksToRecipe({
    recipe: baseRecipe,
    policyPackIds: optionList(args, "policy-pack"),
  });

  const cycle = await runOrchestrationCycle({
    runId,
    goal,
    mode,
    runsDir,
    recipeOverride: policyApplied.recipe,
    requireWaveApproval: flag(args, "no-require-wave-approval") ? false : undefined,
    approvalsDir: option(args, "approvals-dir"),
    requireEvidenceFile: flag(args, "no-require-evidence-file") ? false : undefined,
    evidenceFile: option(args, "evidence-file"),
    rollbackCheckCommand: option(args, "rollback-check-command"),
  });
  writeJson(option(args, "json-out"), {
    runId: cycle.runId,
    policyPacks: policyApplied.appliedPacks.map((pack) => pack.id),
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
  const baseRecipe = recipeOverride ?? getRecipeById(goal.recipeId);
  const policyApplied = applyPolicyPacksToRecipe({
    recipe: baseRecipe,
    policyPackIds: optionList(args, "policy-pack"),
  });

  const cycle = await runOrchestrationCycle({
    runId,
    goal,
    mode,
    runsDir,
    recipeOverride: policyApplied.recipe,
    requireWaveApproval: flag(args, "no-require-wave-approval") ? false : undefined,
    approvalsDir: option(args, "approvals-dir"),
    requireEvidenceFile: flag(args, "no-require-evidence-file") ? false : undefined,
    evidenceFile: option(args, "evidence-file"),
    rollbackCheckCommand: option(args, "rollback-check-command"),
  });
  writeJson(option(args, "json-out"), {
    runId: cycle.runId,
    policyPacks: policyApplied.appliedPacks.map((pack) => pack.id),
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

const WORKER_ENQUEUE_OMIT_KEYS = new Set([
  "json-out",
  "worker-state-path",
  "job-id",
  "job-summary-path",
  "max-attempts",
  "worker-id",
  "once",
  "stop-when-empty",
  "max-jobs",
  "poll-interval-ms",
  "heartbeat-interval-ms",
  "stale-heartbeat-ms",
  "idle-timeout-ms",
]);

const DEFAULT_QUEUED_TIMEOUT_MS = "300000";

const AUTO_RUN_ALLOWED_KEYS = new Set([
  "goal-type",
  "workspace-root",
  "source-system",
  "target-system",
  "source-policy",
  "risk-gate-mode",
  "wave-strategy",
  "no-require-tdd-tests",
  "curated-domain",
  "run-id",
  "runs-dir",
  "policy-pack",
  "autonomy-dir",
  "auto-recipe",
  "auto-recipe-id",
  "recipe-output",
  "max-files",
  "max-file-bytes",
  "max-chunks",
  "max-total-chars",
  "include-generated",
  "max-tasks",
  "executor",
  "executor-profile",
  "executor-provider",
  "provider-template",
  "provider-preset",
  "claude-subscription",
  "apply-mode",
  "apply-guard-token",
  "apply-guard-value",
  "approvals-dir",
  "no-require-wave-approval",
  "evidence-file",
  "no-require-evidence-file",
  "rollback-check-command",
  "fail-policy",
  "fail-fast",
  "timeout-ms",
  "dry-run",
  "enable-critic",
  "critic-command",
  "policy-critic-config",
  "critic-fail-level",
  "enable-repair-loop",
  "max-repair-attempts",
  "memory-revisit",
  "memory-revisit-recipe-id",
  "memory-revisit-autonomy-dir",
  "memory-revisit-semantic-path",
  "memory-revisit-replay-path",
  "memory-revisit-max-calls-per-module",
  "memory-revisit-top-k",
  "memory-revisit-min-score",
  "max-total-attempts",
  "max-total-tokens",
  "max-run-runtime-ms",
  "artifacts-dir",
  "repairs-dir",
  "no-require-artifact-contract",
  "test-impact",
  "full-test-command",
  "full-test-in-dry-run",
  "canary-modules",
  "canary-compare-command",
  "dependency",
  "output-dir",
  "skills-dir",
  "min-occurrences",
  "auto-skills",
  "no-semantic-memory",
  "semantic-memory-path",
  "rag-auto-refine",
  "rag-refine-iterations",
  "rag-refine-queries-per-iteration",
  "rag-refine-queries",
  "rag-refine-runtime-ms",
  "rag-refine-token-budget",
  "rag-refine-max-stall-iterations",
  "rag-refine-convergence-epsilon",
  "rag-replay-memory",
  "rag-replay-memory-path",
  "rag-replay-max-entries",
  "rag-replay-max-age-days",
  "rag-replay-min-score",
  "rag-replay-min-success-count",
]);

async function commandWorkerEnqueue(args: ParsedArgs): Promise<void> {
  // Validate goal/recipe payload early so invalid jobs fail before queueing.
  const { goal } = parseGoal(args);
  const workspaceRoot = path.resolve(option(args, "workspace-root", goal.workspaceRoot) as string);
  const workerStatePath = path.resolve(
    workspaceRoot,
    option(args, "worker-state-path", path.relative(workspaceRoot, defaultWorkerStatePath(workspaceRoot))) as string,
  );

  const autoRunOptions = copyOptionsRecord(args, WORKER_ENQUEUE_OMIT_KEYS);
  autoRunOptions["workspace-root"] = [workspaceRoot];
  if (!autoRunOptions["apply-mode"]) autoRunOptions["apply-mode"] = ["dry-run"];
  if (!autoRunOptions["timeout-ms"]) autoRunOptions["timeout-ms"] = [DEFAULT_QUEUED_TIMEOUT_MS];
  if (!autoRunOptions["goal-type"]) autoRunOptions["goal-type"] = [goal.goalType];
  if (!autoRunOptions["recipe-id"] && option(args, "recipe-id")) {
    autoRunOptions["recipe-id"] = [option(args, "recipe-id") as string];
  }
  if (!autoRunOptions["recipe-file"] && option(args, "recipe-file")) {
    autoRunOptions["recipe-file"] = [option(args, "recipe-file") as string];
  }

  const enqueued = enqueueWorkerJob({
    statePath: workerStatePath,
    workspaceRoot,
    autoRunOptions,
    maxAttempts: parseNumber(args, "max-attempts", 3),
    jobId: option(args, "job-id"),
    summaryPath: option(args, "job-summary-path"),
  });

  writeJson(option(args, "json-out"), {
    workerStatePath: workerStatePath,
    job: enqueued.job,
    summary: summarizeWorkerState({
      state: enqueued.state,
      staleHeartbeatMs: parseNumber(args, "stale-heartbeat-ms", 120_000),
    }),
  }, workspaceRoot);
}

async function commandWorkerStatus(args: ParsedArgs): Promise<void> {
  const workspaceRoot = path.resolve(option(args, "workspace-root", defaultWorkspaceRoot()) as string);
  const workerStatePath = path.resolve(
    workspaceRoot,
    option(args, "worker-state-path", path.relative(workspaceRoot, defaultWorkerStatePath(workspaceRoot))) as string,
  );
  const state = loadWorkerState(workerStatePath);
  const staleHeartbeatMs = parseNumber(args, "stale-heartbeat-ms", 120_000);
  const jobs = state.jobs
    .slice()
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, parseNumber(args, "limit", 100));

  writeJson(option(args, "json-out"), {
    workerStatePath,
    summary: summarizeWorkerState({ state, staleHeartbeatMs }),
    jobs,
  }, workspaceRoot);
}

async function commandWorkerCancel(args: ParsedArgs): Promise<void> {
  const jobId = option(args, "job-id");
  if (!jobId) throw new Error("--job-id is required for worker-cancel");

  const workspaceRoot = path.resolve(option(args, "workspace-root", defaultWorkspaceRoot()) as string);
  const workerStatePath = path.resolve(
    workspaceRoot,
    option(args, "worker-state-path", path.relative(workspaceRoot, defaultWorkerStatePath(workspaceRoot))) as string,
  );
  const staleHeartbeatMs = parseNumber(args, "stale-heartbeat-ms", 120_000);
  const canceled = cancelWorkerJob({
    statePath: workerStatePath,
    jobId,
    reason: option(args, "reason"),
  });

  writeJson(option(args, "json-out"), {
    workerStatePath,
    job: canceled.job,
    summary: summarizeWorkerState({
      state: canceled.state,
      staleHeartbeatMs,
    }),
  }, workspaceRoot);
}

async function commandWorkerRetry(args: ParsedArgs): Promise<void> {
  const jobId = option(args, "job-id");
  if (!jobId) throw new Error("--job-id is required for worker-retry");

  const workspaceRoot = path.resolve(option(args, "workspace-root", defaultWorkspaceRoot()) as string);
  const workerStatePath = path.resolve(
    workspaceRoot,
    option(args, "worker-state-path", path.relative(workspaceRoot, defaultWorkerStatePath(workspaceRoot))) as string,
  );
  const staleHeartbeatMs = parseNumber(args, "stale-heartbeat-ms", 120_000);
  const retried = retryWorkerJob({
    statePath: workerStatePath,
    jobId,
    reason: option(args, "reason"),
    resetAttempts: flag(args, "reset-attempts"),
  });

  writeJson(option(args, "json-out"), {
    workerStatePath,
    job: retried.job,
    summary: summarizeWorkerState({
      state: retried.state,
      staleHeartbeatMs,
    }),
  }, workspaceRoot);
}

async function commandWorkerRun(args: ParsedArgs): Promise<void> {
  const workspaceRoot = path.resolve(option(args, "workspace-root", defaultWorkspaceRoot()) as string);
  const workerStatePath = path.resolve(
    workspaceRoot,
    option(args, "worker-state-path", path.relative(workspaceRoot, defaultWorkerStatePath(workspaceRoot))) as string,
  );
  const workerId = option(args, "worker-id", defaultWorkerId()) as string;
  const staleHeartbeatMs = parseNumber(args, "stale-heartbeat-ms", 120_000);

  const stats = await runWorkerLoop({
    statePath: workerStatePath,
    workerId,
    once: flag(args, "once"),
    stopWhenEmpty: flag(args, "stop-when-empty"),
    maxJobs: parseOptionalNumber(args, "max-jobs"),
    pollIntervalMs: parseNumber(args, "poll-interval-ms", 5_000),
    heartbeatIntervalMs: parseNumber(args, "heartbeat-interval-ms", 5_000),
    staleHeartbeatMs,
    idleTimeoutMs: parseOptionalNumber(args, "idle-timeout-ms"),
    runJob: async (job) => {
      const parsed = parsedArgsFromOptionRecord("auto-run", job.autoRunOptions);
      parsed.options.set("workspace-root", [job.workspaceRoot]);
      parsed.options.set("json-out", [job.summaryPath]);
      await commandAutoRun(parsed);
      return { summaryPath: job.summaryPath };
    },
  });

  const finalState = loadWorkerState(workerStatePath);
  writeJson(option(args, "json-out"), {
    workerStatePath,
    stats,
    summary: summarizeWorkerState({
      state: finalState,
      staleHeartbeatMs,
    }),
  }, workspaceRoot);
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
    maxFileBytes: parseNumber(args, "max-file-bytes", 1_500_000),
    maxChunks: parseNumber(args, "max-chunks", 10_000),
    maxTotalChars: parseNumber(args, "max-total-chars", 20_000_000),
    includeGenerated: option(args, "include-generated", "false") === "true",
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
  const topK = parseNumber(args, "top-k", 8);
  const bm25Weight = parseNumber(args, "bm25-weight", 0.75);
  const embeddingWeight = parseNumber(args, "embedding-weight", 0.25);
  const autoRefine = flag(args, "auto-refine");

  const result = autoRefine
    ? (() => {
      const refined = runAutoRefineQuery({
        index,
        seedQueries: [query],
        topK,
        filePathIncludes: option(args, "path"),
        bm25Weight,
        embeddingWeight,
        maxIterations: parseNumber(args, "refine-iterations", 3),
        maxQueriesPerIteration: parseNumber(args, "refine-queries-per-iteration", 4),
        maxQueries: parseNumber(args, "refine-queries", 20),
        maxRuntimeMs: parseNumber(args, "refine-runtime-ms", 5000),
        maxTokenBudget: parseNumber(args, "refine-token-budget", 12000),
        maxStallIterations: parseNumber(args, "refine-max-stall-iterations", 2),
        convergenceEpsilon: parseNumber(args, "refine-convergence-epsilon", 0.005),
      });

      return {
        query,
        topK,
        totalChunks: index.chunkCount,
        hits: refined.hits,
        autoRefine: refined,
      };
    })()
    : queryRagIndex({
      index,
      query,
      topK,
      filePathIncludes: option(args, "path"),
      bm25Weight,
      embeddingWeight,
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
  const baseRecipe = recipeOverride ?? getRecipeById(goal.recipeId);
  const policyApplied = applyPolicyPacksToRecipe({
    recipe: baseRecipe,
    policyPackIds: optionList(args, "policy-pack"),
  });

  const synthesized = synthesizeTaskRequest({
    workspaceRoot,
    goalType: goal.goalType,
    recipeId: goal.recipeId,
    recipe: policyApplied.recipe,
    discoveryPath: option(args, "discovery-file"),
    ragIndexPath: option(args, "rag-index"),
    ragAutoRefine: option(args, "rag-auto-refine", "true") !== "false",
    ragRefineMaxIterations: parseNumber(args, "rag-refine-iterations", 3),
    ragRefineMaxQueriesPerIteration: parseNumber(args, "rag-refine-queries-per-iteration", 4),
    ragRefineMaxQueries: parseNumber(args, "rag-refine-queries", 20),
    ragRefineMaxRuntimeMs: parseNumber(args, "rag-refine-runtime-ms", 5000),
    ragRefineMaxTokenBudget: parseNumber(args, "rag-refine-token-budget", 12000),
    ragRefineMaxStallIterations: parseNumber(args, "rag-refine-max-stall-iterations", 2),
    ragRefineConvergenceEpsilon: parseNumber(args, "rag-refine-convergence-epsilon", 0.005),
    ragReplayMemoryEnabled: option(args, "rag-replay-memory", "true") !== "false",
    ragReplayMemoryPath: option(args, "rag-replay-memory-path"),
    ragReplayMaxEntries: parseNumber(args, "rag-replay-max-entries", 240),
    ragReplayMaxAgeDays: parseNumber(args, "rag-replay-max-age-days", 90),
    ragReplayMinScore: parseNumber(args, "rag-replay-min-score", 0),
    ragReplayMinSuccessCount: parseNumber(args, "rag-replay-min-success-count", 1),
    autonomyDir: option(args, "autonomy-dir"),
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
      graphMode: parseGraphMode(option(args, "graph-mode", "auto")),
    });
    manifestPath = path.resolve(workspaceRoot, outputDir, "manifest.json");
  }

  writeJson(option(args, "json-out"), {
    requestPath: synthesized.requestPath,
    taskCount: synthesized.taskCount,
    policyPacks: policyApplied.appliedPacks.map((pack) => pack.id),
    manifestPath,
  }, workspaceRoot);
}

async function commandDagCompile(args: ParsedArgs): Promise<void> {
  const requestPath = option(args, "request");
  if (!requestPath) throw new Error("--request <path> is required");

  const workspaceRoot = option(args, "workspace-root", defaultWorkspaceRoot()) as string;
  const outputDir = option(args, "output-dir", "generated/orchestration/dag") as string;
  const dependencyMode = DagDependencyModeSchema.parse(option(args, "dependency", "staged"));
  const graphMode = parseGraphMode(option(args, "graph-mode", "auto"));

  const manifest = await compileRequestDag({
    workspaceRoot,
    requestPath,
    outputDir,
    dependencyMode,
    graphMode,
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

  let executorProfileRaw = parseExecutorProfile(option(args, "executor-profile", "codex-safe") as string);
  let executorProviderRaw = parseExecutorProvider(option(args, "executor-provider"));
  let providerTemplateRaw = option(args, "provider-template");
  const preset = parseProviderPreset(
    flag(args, "claude-subscription") ? "claude-subscription" : option(args, "provider-preset"),
  );
  if (preset.executorProfile) executorProfileRaw = preset.executorProfile;
  if (preset.executorProvider !== undefined) executorProviderRaw = preset.executorProvider;
  if (preset.providerTemplate) providerTemplateRaw = preset.providerTemplate;

  const applyModeRaw = option(args, "apply-mode", "dry-run");
  if (applyModeRaw !== "dry-run" && applyModeRaw !== "apply") {
    throw new Error("--apply-mode must be dry-run or apply");
  }

  const policyPackIds = optionList(args, "policy-pack");
  const timeoutMs = parseNumber(args, "timeout-ms", 10 * 60 * 1000);
  const testImpactMode = parseTestImpactMode(option(args, "test-impact", "off"));
  const graphMode = parseGraphMode(option(args, "graph-mode", "auto"));
  const runId = option(args, "run-id");

  const summary = await runDag({
    workspaceRoot,
    manifestPath,
    graphMode,
    runId,
    eventsPath: option(args, "events-path"),
    executorTemplate: option(args, "executor"),
    executorProfile: executorProfileRaw,
    executorProvider: executorProviderRaw,
    providerTemplate: providerTemplateRaw,
    applyMode: applyModeRaw,
    applyGuardToken: option(args, "apply-guard-token"),
    applyGuardValue: option(args, "apply-guard-value"),
    approvalDir: option(args, "approvals-dir"),
    requireWaveApproval: flag(args, "no-require-wave-approval") ? false : undefined,
    evidenceFilePath: option(args, "evidence-file"),
    requireEvidenceFile: flag(args, "no-require-evidence-file") ? false : undefined,
    rollbackCheckCommand: option(args, "rollback-check-command"),
    failPolicy: failPolicyRaw,
    failFast: flag(args, "fail-fast"),
    timeoutMs,
    analyzeTimeoutMs: parseOptionalNumber(args, "analyze-timeout-ms"),
    outputPath: option(args, "json-out"),
    dryRun: flag(args, "dry-run"),
    resumeSuccessModules: option(args, "resume-success-modules", "true") !== "false",
    enableCritic: flag(args, "enable-critic"),
    criticCommandTemplate: option(args, "critic-command"),
    policyCriticConfigPath: option(args, "policy-critic-config"),
    criticFailLevel: option(args, "critic-fail-level") as "info" | "warning" | "blocker" | undefined,
    enableRepairLoop: flag(args, "enable-repair-loop"),
    maxRepairAttempts: parseNumber(args, "max-repair-attempts", 1),
    memoryRevisitEnabled: option(args, "memory-revisit", "true") !== "false",
    memoryRevisitRecipeId: option(args, "memory-revisit-recipe-id"),
    memoryRevisitAutonomyDir: option(args, "memory-revisit-autonomy-dir"),
    memoryRevisitSemanticMemoryPath: option(args, "memory-revisit-semantic-path"),
    memoryRevisitReplayMemoryPath: option(args, "memory-revisit-replay-path"),
    memoryRevisitMaxCallsPerModule: parseNumber(args, "memory-revisit-max-calls-per-module", 1),
    memoryRevisitTopK: parseNumber(args, "memory-revisit-top-k", 3),
    memoryRevisitMinScore: parseNumber(args, "memory-revisit-min-score", 0),
    maxTotalAttempts: parseNumber(args, "max-total-attempts", 0),
    maxTotalTokens: parseNumber(args, "max-total-tokens", 0),
    maxRunDurationMs: parseNumber(args, "max-run-runtime-ms", 0),
    artifactsDir: option(args, "artifacts-dir"),
    repairsDir: option(args, "repairs-dir"),
    requireArtifactContract: flag(args, "no-require-artifact-contract") ? false : undefined,
    testImpactMode,
    fullTestCommand: option(args, "full-test-command"),
    fullTestInDryRun: option(args, "full-test-in-dry-run", "false") === "true",
    canaryLimitModules: parseNumber(args, "canary-modules", 0),
    canaryCompareCommand: option(args, "canary-compare-command"),
    maxParallel: parseNumber(args, "max-parallel", 1),
    policyPacks: policyPackIds,
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

async function commandMemoryHygiene(args: ParsedArgs): Promise<void> {
  const workspaceRoot = path.resolve(option(args, "workspace-root", defaultWorkspaceRoot()) as string);
  const autonomyDir = option(args, "autonomy-dir", "generated/orchestration/autonomy") as string;
  const autonomyDirAbs = path.isAbsolute(autonomyDir) ? path.resolve(autonomyDir) : path.resolve(workspaceRoot, autonomyDir);
  const recipeIdOverride = option(args, "recipe-id");
  const policyPacks = optionList(args, "policy-pack");
  const semanticMemoryPathOverride = option(args, "semantic-memory-path");
  const replayMemoryPathOverride = option(args, "rag-replay-memory-path");
  const runScan = option(args, "memory-hygiene-scan", "true") !== "false";
  const semanticMaxEntries = parseNumber(args, "memory-hygiene-max-entries", 500);
  const semanticMaxAgeDays = parseNumber(args, "memory-hygiene-max-age-days", 180);
  const replayMaxEntries = parseNumber(args, "rag-replay-max-entries", 240);
  const replayMaxAgeDays = parseNumber(args, "rag-replay-max-age-days", 90);
  const replayMinScore = parseNumber(args, "rag-replay-min-score", 0);
  const replayMinSuccessCount = parseNumber(args, "rag-replay-min-success-count", 1);

  const toPortable = (input: string): string => path.relative(workspaceRoot, input).replace(/\\/g, "/");
  const safeRecipeId = (filePath: string): string | null => {
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as { recipeId?: unknown };
      return typeof parsed.recipeId === "string" && parsed.recipeId.trim().length > 0
        ? parsed.recipeId.trim()
        : null;
    } catch {
      return null;
    }
  };
  const listJsonFiles = (dirPath: string): string[] => {
    if (!existsSync(dirPath)) return [];
    try {
      return readdirSync(dirPath)
        .filter((entry) => entry.endsWith(".json"))
        .map((entry) => path.resolve(dirPath, entry))
        .sort((a, b) => a.localeCompare(b));
    } catch {
      return [];
    }
  };

  const semanticTargets = runScan
    ? listJsonFiles(path.resolve(autonomyDirAbs, "memory"))
    : (semanticMemoryPathOverride
      ? [path.resolve(workspaceRoot, semanticMemoryPathOverride)]
      : []);
  const replayTargets = runScan
    ? listJsonFiles(path.resolve(autonomyDirAbs, "rag", "replay"))
    : (replayMemoryPathOverride
      ? [path.resolve(workspaceRoot, replayMemoryPathOverride)]
      : []);

  const semanticResults: Array<{
    path: string;
    recipeId: string;
    before: { decisions: number; failedAttempts: number; mitigations: number; pendingEventCount: number };
    after: { decisions: number; failedAttempts: number; mitigations: number; pendingEventCount: number };
    compacted: boolean;
  }> = [];
  const replayResults: Array<{
    path: string;
    recipeId: string;
    before: { entryCount: number; pendingEventCount: number };
    after: { entryCount: number; pendingEventCount: number };
    compacted: boolean;
  }> = [];
  const errors: string[] = [];

  const runSemanticCompaction = (filePath: string | undefined, recipeId: string) => {
    const compacted = compactSemanticMemory({
      workspaceRoot,
      recipeId,
      policyPacks,
      autonomyDir,
      memoryPath: filePath,
      maxEntries: semanticMaxEntries,
      maxAgeDays: semanticMaxAgeDays,
    });
    semanticResults.push({
      path: toPortable(compacted.memoryPath),
      recipeId,
      before: compacted.before,
      after: compacted.after,
      compacted:
        compacted.before.pendingEventCount > 0 ||
        compacted.before.decisions !== compacted.after.decisions ||
        compacted.before.failedAttempts !== compacted.after.failedAttempts ||
        compacted.before.mitigations !== compacted.after.mitigations,
    });
  };

  const runReplayCompaction = (filePath: string | undefined, recipeId: string) => {
    const compacted = compactReplayMemory({
      workspaceRoot,
      recipeId,
      autonomyDir,
      memoryPath: filePath,
      retentionMaxEntries: replayMaxEntries,
      retentionMaxAgeDays: replayMaxAgeDays,
      retentionMinScore: replayMinScore,
      retentionMinSuccessCount: replayMinSuccessCount,
    });
    replayResults.push({
      path: toPortable(compacted.memoryPath),
      recipeId,
      before: compacted.before,
      after: compacted.after,
      compacted:
        compacted.before.pendingEventCount > 0 ||
        compacted.before.entryCount !== compacted.after.entryCount,
    });
  };

  for (const filePath of semanticTargets) {
    const recipeId = recipeIdOverride ?? safeRecipeId(filePath);
    if (!recipeId) {
      errors.push(`semantic memory skipped (missing recipeId): ${toPortable(filePath)}`);
      continue;
    }
    try {
      runSemanticCompaction(filePath, recipeId);
    } catch (error) {
      errors.push(`semantic memory failed (${toPortable(filePath)}): ${(error as Error).message}`);
    }
  }

  for (const filePath of replayTargets) {
    const recipeId = recipeIdOverride ?? safeRecipeId(filePath);
    if (!recipeId) {
      errors.push(`replay memory skipped (missing recipeId): ${toPortable(filePath)}`);
      continue;
    }
    try {
      runReplayCompaction(filePath, recipeId);
    } catch (error) {
      errors.push(`replay memory failed (${toPortable(filePath)}): ${(error as Error).message}`);
    }
  }

  if (!runScan && semanticTargets.length === 0 && replayTargets.length === 0 && recipeIdOverride) {
    try {
      runSemanticCompaction(
        semanticMemoryPathOverride ? path.resolve(workspaceRoot, semanticMemoryPathOverride) : undefined,
        recipeIdOverride,
      );
    } catch (error) {
      errors.push(`semantic memory failed (default): ${(error as Error).message}`);
    }
    try {
      runReplayCompaction(
        replayMemoryPathOverride ? path.resolve(workspaceRoot, replayMemoryPathOverride) : undefined,
        recipeIdOverride,
      );
    } catch (error) {
      errors.push(`replay memory failed (default): ${(error as Error).message}`);
    }
  }

  writeJson(option(args, "json-out"), {
    workspaceRoot,
    autonomyDir: path.relative(workspaceRoot, autonomyDirAbs).replace(/\\/g, "/"),
    scanMode: runScan ? "scan" : "targeted",
    semantic: {
      processed: semanticResults.length,
      compacted: semanticResults.filter((item) => item.compacted).length,
      files: semanticResults,
    },
    replay: {
      processed: replayResults.length,
      compacted: replayResults.filter((item) => item.compacted).length,
      files: replayResults,
    },
    errors,
    generatedAt: new Date().toISOString(),
  }, workspaceRoot);
}

async function commandAutoRun(args: ParsedArgs): Promise<void> {
  const { goal, recipeOverride } = parseGoal(args);
  const workspaceRoot = goal.workspaceRoot;
  const autonomyDir = option(args, "autonomy-dir", "generated/orchestration/autonomy") as string;
  const requestedPolicyPacks = optionList(args, "policy-pack");
  const semanticRunId = option(args, "run-id", `auto-${Date.now()}`) as string;

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
  let policyApplied = applyPolicyPacksToRecipe({
    recipe,
    policyPackIds: requestedPolicyPacks,
  });
  recipe = policyApplied.recipe;

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
      policyPacks: policyApplied.appliedPacks.map((pack) => pack.id),
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
    policyApplied = applyPolicyPacksToRecipe({
      recipe: generated.recipe,
      policyPackIds: requestedPolicyPacks,
    });
    recipe = policyApplied.recipe;

    if (generated.outputPath && policyApplied.appliedPacks.length > 0) {
      writeFileSync(generated.outputPath, `${JSON.stringify(recipe, null, 2)}\n`, "utf8");
    }

    generatedRecipePath = generated.outputPath
      ? path.relative(workspaceRoot, generated.outputPath).replace(/\\/g, "/")
      : null;
  }

  const ragIndex = buildRagIndex({
    workspaceRoot,
    maxFiles: parseNumber(args, "max-files", 3000),
    maxFileBytes: parseNumber(args, "max-file-bytes", 1_500_000),
    maxChunks: parseNumber(args, "max-chunks", 10_000),
    maxTotalChars: parseNumber(args, "max-total-chars", 20_000_000),
    includeGenerated: option(args, "include-generated", "false") === "true",
  });
  saveRagIndex({ index: ragIndex, outputPath: ragIndexPath });

  const ragAutoRefine = option(args, "rag-auto-refine", "true") !== "false";
  const ragRefineIterations = parseNumber(args, "rag-refine-iterations", 3);
  const ragRefineQueriesPerIteration = parseNumber(args, "rag-refine-queries-per-iteration", 4);
  const ragRefineQueries = parseNumber(args, "rag-refine-queries", 20);
  const ragRefineRuntimeMs = parseNumber(args, "rag-refine-runtime-ms", 5000);
  const ragRefineTokenBudget = parseNumber(args, "rag-refine-token-budget", 12000);
  const ragRefineMaxStallIterations = parseNumber(args, "rag-refine-max-stall-iterations", 2);
  const ragRefineConvergenceEpsilon = parseNumber(args, "rag-refine-convergence-epsilon", 0.005);
  const ragReplayMemoryEnabled = option(args, "rag-replay-memory", "true") !== "false";
  const ragReplayMemoryPath = option(args, "rag-replay-memory-path");
  const ragReplayMaxEntries = parseNumber(args, "rag-replay-max-entries", 240);
  const ragReplayMaxAgeDays = parseNumber(args, "rag-replay-max-age-days", 90);
  const ragReplayMinScore = parseNumber(args, "rag-replay-min-score", 0);
  const ragReplayMinSuccessCount = parseNumber(args, "rag-replay-min-success-count", 1);
  const graphMode = parseGraphMode(option(args, "graph-mode", "auto"));

  const synthesized = synthesizeTaskRequest({
    workspaceRoot,
    goalType: goal.goalType,
    recipeId: goal.recipeId,
    recipe,
    discoveryPath,
    ragIndexPath,
    ragAutoRefine,
    ragRefineMaxIterations: ragRefineIterations,
    ragRefineMaxQueriesPerIteration: ragRefineQueriesPerIteration,
    ragRefineMaxQueries: ragRefineQueries,
    ragRefineMaxRuntimeMs: ragRefineRuntimeMs,
    ragRefineMaxTokenBudget: ragRefineTokenBudget,
    ragRefineMaxStallIterations,
    ragRefineConvergenceEpsilon,
    ragReplayMemoryEnabled,
    ragReplayMemoryPath,
    ragReplayMaxEntries,
    ragReplayMaxAgeDays,
    ragReplayMinScore,
    ragReplayMinSuccessCount,
    autonomyDir,
    outputPath: path.relative(workspaceRoot, requestPath),
    maxTasks: parseNumber(args, "max-tasks", 24),
  });

  await compileRequestDag({
    workspaceRoot,
    requestPath: path.relative(workspaceRoot, synthesized.requestPath).replace(/\\/g, "/"),
    outputDir: dagOutputDir,
    dependencyMode: DagDependencyModeSchema.parse(option(args, "dependency", "staged")),
    graphMode,
    recipeContext: {
      policyPackIds: policyApplied.appliedPacks.map((pack) => pack.id),
      injectPolicyAnchors: option(args, "graph-v2-inject-policy-anchors", "false") === "true",
    },
  });

  let executorProfileRaw = parseExecutorProfile(option(args, "executor-profile", "codex-safe") as string);
  let executorProviderRaw = parseExecutorProvider(option(args, "executor-provider"));
  let providerTemplateRaw = option(args, "provider-template");
  const preset = parseProviderPreset(
    flag(args, "claude-subscription") ? "claude-subscription" : option(args, "provider-preset"),
  );
  if (preset.executorProfile) executorProfileRaw = preset.executorProfile;
  if (preset.executorProvider !== undefined) executorProviderRaw = preset.executorProvider;
  if (preset.providerTemplate) providerTemplateRaw = preset.providerTemplate;

  const applyModeRaw = option(args, "apply-mode", "dry-run");
  if (applyModeRaw !== "dry-run" && applyModeRaw !== "apply") {
    throw new Error("--apply-mode must be dry-run or apply");
  }

  const failPolicyRaw = option(args, "fail-policy", "graph");
  if (failPolicyRaw !== "graph" && failPolicyRaw !== "global") {
    throw new Error("--fail-policy must be graph or global");
  }
  const testImpactMode = parseTestImpactMode(option(args, "test-impact", "off"));

  const dagSummary = await runDag({
    workspaceRoot,
    manifestPath: path.relative(workspaceRoot, dagManifestPath),
    graphMode,
    runId: semanticRunId,
    eventsPath: option(args, "events-path"),
    executorTemplate: option(args, "executor"),
    executorProfile: executorProfileRaw,
    executorProvider: executorProviderRaw,
    providerTemplate: providerTemplateRaw,
    applyMode: applyModeRaw,
    applyGuardToken: option(args, "apply-guard-token"),
    applyGuardValue: option(args, "apply-guard-value"),
    approvalDir: option(args, "approvals-dir"),
    requireWaveApproval: flag(args, "no-require-wave-approval") ? false : undefined,
    evidenceFilePath: option(args, "evidence-file"),
    requireEvidenceFile: flag(args, "no-require-evidence-file") ? false : undefined,
    rollbackCheckCommand: option(args, "rollback-check-command"),
    failPolicy: failPolicyRaw,
    failFast: flag(args, "fail-fast"),
    timeoutMs: parseNumber(args, "timeout-ms", 10 * 60 * 1000),
    analyzeTimeoutMs: parseOptionalNumber(args, "analyze-timeout-ms"),
    outputPath: path.relative(workspaceRoot, dagRunSummaryPath),
    dryRun: flag(args, "dry-run"),
    resumeSuccessModules: option(args, "resume-success-modules", "true") !== "false",
    enableCritic: flag(args, "enable-critic"),
    criticCommandTemplate: option(args, "critic-command"),
    policyCriticConfigPath: option(args, "policy-critic-config"),
    criticFailLevel: option(args, "critic-fail-level") as "info" | "warning" | "blocker" | undefined,
    enableRepairLoop: flag(args, "enable-repair-loop"),
    maxRepairAttempts: parseNumber(args, "max-repair-attempts", 1),
    memoryRevisitEnabled: option(args, "memory-revisit", "true") !== "false",
    memoryRevisitRecipeId: option(args, "memory-revisit-recipe-id", recipe.id),
    memoryRevisitAutonomyDir: option(args, "memory-revisit-autonomy-dir", autonomyDir),
    memoryRevisitSemanticMemoryPath: option(args, "memory-revisit-semantic-path", option(args, "semantic-memory-path")),
    memoryRevisitReplayMemoryPath: option(args, "memory-revisit-replay-path", ragReplayMemoryPath),
    memoryRevisitMaxCallsPerModule: parseNumber(args, "memory-revisit-max-calls-per-module", 1),
    memoryRevisitTopK: parseNumber(args, "memory-revisit-top-k", 3),
    memoryRevisitMinScore: parseNumber(args, "memory-revisit-min-score", 0),
    maxTotalAttempts: parseNumber(args, "max-total-attempts", 0),
    maxTotalTokens: parseNumber(args, "max-total-tokens", 0),
    maxRunDurationMs: parseNumber(args, "max-run-runtime-ms", 0),
    artifactsDir: option(args, "artifacts-dir"),
    repairsDir: option(args, "repairs-dir"),
    requireArtifactContract: flag(args, "no-require-artifact-contract") ? false : undefined,
    testImpactMode,
    fullTestCommand: option(args, "full-test-command"),
    fullTestInDryRun: option(args, "full-test-in-dry-run", "false") === "true",
    canaryLimitModules: parseNumber(args, "canary-modules", 0),
    canaryCompareCommand: option(args, "canary-compare-command"),
    maxParallel: parseNumber(args, "max-parallel", 1),
    policyPacks: policyApplied.appliedPacks.map((pack) => pack.id),
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

  let semanticMemory: {
    fingerprint: string;
    path: string;
    decisionCount: number;
    failedAttemptCount: number;
    mitigationCount: number;
  } | null = null;

  if (!flag(args, "no-semantic-memory")) {
    const recorded = recordSemanticState({
      workspaceRoot,
      recipeId: recipe.id,
      runId: semanticRunId,
      policyPacks: policyApplied.appliedPacks.map((pack) => pack.id),
      autonomyDir,
      memoryPath: option(args, "semantic-memory-path"),
      decisions: [
        {
          decision: "auto-run-config",
          detail: "Recorded auto-run execution profile and budget controls.",
          metadata: {
            applyMode: applyModeRaw,
            failPolicy: failPolicyRaw,
            failFast: flag(args, "fail-fast"),
            dependencyMode: option(args, "dependency", "staged"),
            maxParallel: parseNumber(args, "max-parallel", 1),
            analyzeTimeoutMs: parseOptionalNumber(args, "analyze-timeout-ms") ?? null,
            resumeSuccessModules: option(args, "resume-success-modules", "true") !== "false",
            testImpactMode,
            memoryRevisitEnabled: option(args, "memory-revisit", "true") !== "false",
            memoryRevisitRecipeId: option(args, "memory-revisit-recipe-id", recipe.id),
            memoryRevisitAutonomyDir: option(args, "memory-revisit-autonomy-dir", autonomyDir),
            memoryRevisitSemanticPath: option(args, "memory-revisit-semantic-path", option(args, "semantic-memory-path")),
            memoryRevisitReplayPath: option(args, "memory-revisit-replay-path", ragReplayMemoryPath),
            memoryRevisitMaxCallsPerModule: parseNumber(args, "memory-revisit-max-calls-per-module", 1),
            memoryRevisitTopK: parseNumber(args, "memory-revisit-top-k", 3),
            memoryRevisitMinScore: parseNumber(args, "memory-revisit-min-score", 0),
            ragAutoRefine,
            ragRefineIterations,
            ragRefineQueriesPerIteration,
            ragRefineQueries,
            ragRefineRuntimeMs,
            ragRefineTokenBudget,
            ragRefineMaxStallIterations,
            ragRefineConvergenceEpsilon,
            ragReplayMemoryEnabled,
            ragReplayMemoryPath: ragReplayMemoryPath ?? null,
            ragReplayMaxEntries,
            ragReplayMaxAgeDays,
            ragReplayMinScore,
            ragReplayMinSuccessCount,
            policyCriticConfigPath: option(args, "policy-critic-config") ?? null,
            policyPacks: policyApplied.appliedPacks.map((pack) => pack.id),
          },
        },
        ...policyApplied.policyRules.map((rule) => ({
          decision: "policy-rule",
          detail: rule,
          metadata: {},
        })),
      ],
      failedAttempts: dagSummary.results
        .filter((result) => result.status === "failed" || result.status === "blocked")
        .map((result) => ({
          moduleId: result.moduleId,
          reason: result.stderr || result.status,
          attempt: result.attempt ?? 1,
        })),
      mitigations: dagSummary.results
        .filter((result) => result.repairTaskPath)
        .map((result) => ({
          moduleId: result.moduleId,
          mitigation: result.repairTaskPath ?? "repair-attempt",
          accepted: result.status === "success",
        })),
    });

    semanticMemory = {
      fingerprint: recorded.fingerprint,
      path: path.relative(workspaceRoot, recorded.memoryPath).replace(/\\/g, "/"),
      decisionCount: recorded.state.decisions.length,
      failedAttemptCount: recorded.state.failedAttempts.length,
      mitigationCount: recorded.state.mitigations.length,
    };
  }

  const summary = {
    runId: semanticRunId,
    goal,
    recipe: {
      id: recipe.id,
      title: recipe.title,
      riskProbeCount: recipe.riskProbes.length,
      gateCount: recipe.gates.length,
      policyPacks: policyApplied.appliedPacks.map((pack) => pack.id),
      policyRules: policyApplied.policyRules,
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
    dagSummary,
    ragRefine: {
      enabled: ragAutoRefine,
      iterations: ragRefineIterations,
      queriesPerIteration: ragRefineQueriesPerIteration,
      maxQueries: ragRefineQueries,
      maxRuntimeMs: ragRefineRuntimeMs,
      maxTokenBudget: ragRefineTokenBudget,
      maxStallIterations: ragRefineMaxStallIterations,
      convergenceEpsilon: ragRefineConvergenceEpsilon,
      replayMemoryEnabled: ragReplayMemoryEnabled,
      replayMemoryPath: ragReplayMemoryPath ?? null,
      replayMaxEntries: ragReplayMaxEntries,
      replayMaxAgeDays: ragReplayMaxAgeDays,
      replayMinScore: ragReplayMinScore,
      replayMinSuccessCount: ragReplayMinSuccessCount,
    },
    synthesizedTaskCount: synthesized.taskCount,
    autoSkills,
    semanticMemory,
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
    case "policy-packs":
      await commandPolicyPacks(parsed);
      return;
    case "recipe-generate":
      await commandRecipeGenerate(parsed);
      return;
    case "recipe-init":
      await commandRecipeInit(parsed);
      return;
    case "recipe-intake":
      await commandRecipeIntake(parsed);
      return;
    case "eval-golden":
      await commandEvalGolden(parsed);
      return;
    case "eval-benchmark":
      await commandEvalBenchmark(parsed);
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
    case "worker-enqueue":
      await commandWorkerEnqueue(parsed);
      return;
    case "worker-run":
      await commandWorkerRun(parsed);
      return;
    case "worker-status":
      await commandWorkerStatus(parsed);
      return;
    case "worker-cancel":
      await commandWorkerCancel(parsed);
      return;
    case "worker-retry":
      await commandWorkerRetry(parsed);
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
    case "memory-hygiene":
      await commandMemoryHygiene(parsed);
      return;
    default:
      throw new Error(`Unknown command '${parsed.command}'. Use 'help'.`);
  }
}

main().catch((error) => {
  process.stderr.write(`orchestrator CLI error: ${(error as Error).message}\n`);
  process.exitCode = 1;
});
