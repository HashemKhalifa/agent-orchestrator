#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

GOAL_TYPE=""
RECIPE_ID=""
WORKSPACE_ROOT="."
AUTONOMY_DIR="generated/orchestration/autonomy"
MAX_ITERATIONS=20
SLEEP_SECONDS=3
SOURCE_POLICY="primary_plus_curated_secondary"
RISK_GATE_MODE="strict_blockers"
WAVE_STRATEGY=""
DEPENDENCY_MODE="staged"
MAX_TASKS=24
MAX_FILES=3000
EXECUTOR_PROFILE="codex-safe"
EXECUTOR_TEMPLATE=""
APPLY_MODE="dry-run"
APPLY_GUARD_TOKEN=""
APPLY_GUARD_VALUE=""
FAIL_POLICY="graph"
AUTO_SKILLS="suggest"
SKILLS_DIR=".codex/skills/generated"
MIN_OCCURRENCES=2
JSON_OUT=""
CURATED_DOMAINS=()

print_help() {
  cat <<'USAGE'
run-bot-request-until-done.sh

Usage:
  ./scripts/run-bot-request-until-done.sh --goal-type <type> --recipe-id <id> [options]

Required:
  --goal-type <build_migration|dependency_upgrade|ci_refactor|test_runner_migration|custom>
  --recipe-id <recipe-id>

Core options:
  --workspace-root <path>         Target repo root (default: .)
  --autonomy-dir <path>           Output dir for generated artifacts (default: generated/orchestration/autonomy)
  --max-iterations <n>            Max autonomous iterations (default: 20)
  --sleep-seconds <n>             Delay between iterations while not done (default: 3)

Planning/discovery options:
  --source-policy <policy>        primary_only|primary_plus_curated_secondary|open_web
  --risk-gate-mode <mode>         strict_blockers|warn_then_apply|manual_override
  --wave-strategy <strategy>      incremental_dual_build|pilot_wave|big_bang|custom
  --dependency <mode>             sequential|parallel|staged
  --curated-domain <domain>       Curated source domain allowlist (repeatable)
  --max-files <n>                 RAG indexing cap (default: 3000)
  --max-tasks <n>                 Max synthesized tasks (default: 24)

Execution options:
  --executor-profile <profile>    none|codex-safe (default: codex-safe)
  --executor <template>           Optional command template override for DAG modules
  --apply-mode <mode>             dry-run|apply (default: dry-run)
  --apply-guard-token <token>     Required in apply mode unless default guard is used
  --apply-guard-value <token>     Expected guard value (default: ALLOW_APPLY)
  --fail-policy <policy>          graph|global (default: graph)

Skill options:
  --auto-skills <mode>            off|suggest|apply (default: suggest)
  --skills-dir <path>             Skill output dir (default: .codex/skills/generated)
  --min-occurrences <n>           Pattern threshold for skill generation (default: 2)

Output options:
  --json-out <path>               Final loop summary path (default: <autonomy-dir>/until-done-summary.json)
  -h, --help                      Show help
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --goal-type)
      GOAL_TYPE="${2:-}"
      shift 2
      ;;
    --recipe-id)
      RECIPE_ID="${2:-}"
      shift 2
      ;;
    --workspace-root)
      WORKSPACE_ROOT="${2:-}"
      shift 2
      ;;
    --autonomy-dir)
      AUTONOMY_DIR="${2:-}"
      shift 2
      ;;
    --max-iterations)
      MAX_ITERATIONS="${2:-}"
      shift 2
      ;;
    --sleep-seconds)
      SLEEP_SECONDS="${2:-}"
      shift 2
      ;;
    --source-policy)
      SOURCE_POLICY="${2:-}"
      shift 2
      ;;
    --risk-gate-mode)
      RISK_GATE_MODE="${2:-}"
      shift 2
      ;;
    --wave-strategy)
      WAVE_STRATEGY="${2:-}"
      shift 2
      ;;
    --dependency)
      DEPENDENCY_MODE="${2:-}"
      shift 2
      ;;
    --curated-domain)
      CURATED_DOMAINS+=("${2:-}")
      shift 2
      ;;
    --max-files)
      MAX_FILES="${2:-}"
      shift 2
      ;;
    --max-tasks)
      MAX_TASKS="${2:-}"
      shift 2
      ;;
    --executor-profile)
      EXECUTOR_PROFILE="${2:-}"
      shift 2
      ;;
    --executor)
      EXECUTOR_TEMPLATE="${2:-}"
      shift 2
      ;;
    --apply-mode)
      APPLY_MODE="${2:-}"
      shift 2
      ;;
    --apply-guard-token)
      APPLY_GUARD_TOKEN="${2:-}"
      shift 2
      ;;
    --apply-guard-value)
      APPLY_GUARD_VALUE="${2:-}"
      shift 2
      ;;
    --fail-policy)
      FAIL_POLICY="${2:-}"
      shift 2
      ;;
    --auto-skills)
      AUTO_SKILLS="${2:-}"
      shift 2
      ;;
    --skills-dir)
      SKILLS_DIR="${2:-}"
      shift 2
      ;;
    --min-occurrences)
      MIN_OCCURRENCES="${2:-}"
      shift 2
      ;;
    --json-out)
      JSON_OUT="${2:-}"
      shift 2
      ;;
    -h|--help)
      print_help
      exit 0
      ;;
    *)
      echo "ERROR: unknown arg '$1'" >&2
      print_help
      exit 1
      ;;
  esac
done

if [[ -z "$GOAL_TYPE" || -z "$RECIPE_ID" ]]; then
  echo "ERROR: --goal-type and --recipe-id are required" >&2
  exit 1
fi

if ! [[ "$MAX_ITERATIONS" =~ ^[0-9]+$ ]] || [[ "$MAX_ITERATIONS" -lt 1 ]]; then
  echo "ERROR: --max-iterations must be >= 1" >&2
  exit 1
fi

if ! [[ "$SLEEP_SECONDS" =~ ^[0-9]+$ ]] || [[ "$SLEEP_SECONDS" -lt 0 ]]; then
  echo "ERROR: --sleep-seconds must be >= 0" >&2
  exit 1
fi

if [[ "$APPLY_MODE" != "dry-run" && "$APPLY_MODE" != "apply" ]]; then
  echo "ERROR: --apply-mode must be dry-run or apply" >&2
  exit 1
fi

if [[ "$EXECUTOR_PROFILE" != "none" && "$EXECUTOR_PROFILE" != "codex-safe" ]]; then
  echo "ERROR: --executor-profile must be none or codex-safe" >&2
  exit 1
fi

if [[ "$AUTO_SKILLS" != "off" && "$AUTO_SKILLS" != "suggest" && "$AUTO_SKILLS" != "apply" ]]; then
  echo "ERROR: --auto-skills must be off, suggest, or apply" >&2
  exit 1
fi

if [[ "$FAIL_POLICY" != "graph" && "$FAIL_POLICY" != "global" ]]; then
  echo "ERROR: --fail-policy must be graph or global" >&2
  exit 1
fi

WORKSPACE_ROOT_ABS="$(cd "$WORKSPACE_ROOT" && pwd)"
if [[ "$AUTONOMY_DIR" = /* ]]; then
  AUTONOMY_DIR_FS="$AUTONOMY_DIR"
else
  AUTONOMY_DIR_FS="$WORKSPACE_ROOT_ABS/$AUTONOMY_DIR"
fi
mkdir -p "$AUTONOMY_DIR_FS/iterations"

LAST_SUMMARY=""
DONE=0
LAST_DAG_STATUS=""
LAST_FAILED=""
LAST_BLOCKED=""

for ((iteration=1; iteration<=MAX_ITERATIONS; iteration++)); do
  ITER_SUMMARY="$AUTONOMY_DIR/iterations/auto-run-$(printf "%03d" "$iteration").json"
  LAST_SUMMARY="$ITER_SUMMARY"

  CMD=(
    npm --prefix packages/orchestrator-standalone run cli -- auto-run
    --goal-type "$GOAL_TYPE"
    --recipe-id "$RECIPE_ID"
    --workspace-root "$WORKSPACE_ROOT"
    --autonomy-dir "$AUTONOMY_DIR"
    --source-policy "$SOURCE_POLICY"
    --risk-gate-mode "$RISK_GATE_MODE"
    --dependency "$DEPENDENCY_MODE"
    --max-files "$MAX_FILES"
    --max-tasks "$MAX_TASKS"
    --executor-profile "$EXECUTOR_PROFILE"
    --apply-mode "$APPLY_MODE"
    --fail-policy "$FAIL_POLICY"
    --auto-skills "$AUTO_SKILLS"
    --skills-dir "$SKILLS_DIR"
    --min-occurrences "$MIN_OCCURRENCES"
    --json-out "$ITER_SUMMARY"
  )

  if [[ -n "$EXECUTOR_TEMPLATE" ]]; then
    CMD+=(--executor "$EXECUTOR_TEMPLATE")
  fi

  if [[ -n "$WAVE_STRATEGY" ]]; then
    CMD+=(--wave-strategy "$WAVE_STRATEGY")
  fi

  if [[ -n "$APPLY_GUARD_TOKEN" ]]; then
    CMD+=(--apply-guard-token "$APPLY_GUARD_TOKEN")
  fi

  if [[ -n "$APPLY_GUARD_VALUE" ]]; then
    CMD+=(--apply-guard-value "$APPLY_GUARD_VALUE")
  fi

  for domain in "${CURATED_DOMAINS[@]}"; do
    CMD+=(--curated-domain "$domain")
  done

  echo "==> [iteration $iteration/$MAX_ITERATIONS] auto-run for recipe '$RECIPE_ID'"
  "${CMD[@]}"

  STATUS_LINE="$(
    node - "$WORKSPACE_ROOT" "$ITER_SUMMARY" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const workspaceRoot = path.resolve(process.argv[2]);
const summaryPath = path.resolve(workspaceRoot, process.argv[3]);

if (!fs.existsSync(summaryPath)) {
  process.stderr.write(`missing summary: ${summaryPath}\n`);
  process.exit(2);
}

const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
const dagStatus = summary.dagStatus ?? "unknown";
const artifacts = summary.artifacts ?? {};
const dagRunSummaryPath = artifacts.dagRunSummaryPath
  ? path.resolve(workspaceRoot, artifacts.dagRunSummaryPath)
  : null;

const failed = [];
const blocked = [];
let success = 0;
let skipped = 0;

if (dagRunSummaryPath && fs.existsSync(dagRunSummaryPath)) {
  const dagRun = JSON.parse(fs.readFileSync(dagRunSummaryPath, "utf8"));
  for (const result of dagRun.results ?? []) {
    if (result.status === "failed") failed.push(result.moduleId);
    else if (result.status === "blocked") blocked.push(result.moduleId);
    else if (result.status === "success") success += 1;
    else if (result.status === "skipped") skipped += 1;
  }
}

const done = dagStatus === "success" && failed.length === 0 && blocked.length === 0;
const taskCount = summary.synthesizedTaskCount ?? 0;

process.stdout.write(
  [
    done ? "1" : "0",
    dagStatus,
    failed.join(","),
    blocked.join(","),
    String(success),
    String(skipped),
    String(taskCount),
  ].join("\t"),
);
NODE
  )"

  IFS=$'\t' read -r DONE LAST_DAG_STATUS LAST_FAILED LAST_BLOCKED LAST_SUCCESS LAST_SKIPPED LAST_TASKS <<<"$STATUS_LINE"

  echo "    dagStatus=$LAST_DAG_STATUS tasks=$LAST_TASKS success=$LAST_SUCCESS failed=${LAST_FAILED:-none} blocked=${LAST_BLOCKED:-none}"

  if [[ "$DONE" == "1" ]]; then
    break
  fi

  if [[ "$iteration" -lt "$MAX_ITERATIONS" && "$SLEEP_SECONDS" -gt 0 ]]; then
    sleep "$SLEEP_SECONDS"
  fi
done

FINAL_JSON_OUT="${JSON_OUT:-$AUTONOMY_DIR/until-done-summary.json}"
node - "$WORKSPACE_ROOT" "$FINAL_JSON_OUT" "$LAST_SUMMARY" "$DONE" "$LAST_DAG_STATUS" "$LAST_FAILED" "$LAST_BLOCKED" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const workspaceRoot = path.resolve(process.argv[2]);
const outPath = path.resolve(workspaceRoot, process.argv[3]);
const lastSummaryPath = process.argv[4] ? path.resolve(workspaceRoot, process.argv[4]) : null;
const done = process.argv[5] === "1";
const dagStatus = process.argv[6] ?? "unknown";
const failed = (process.argv[7] ?? "").split(",").filter(Boolean);
const blocked = (process.argv[8] ?? "").split(",").filter(Boolean);

const payload = {
  completed: done,
  dagStatus,
  failedModules: failed,
  blockedModules: blocked,
  lastIterationSummaryPath: lastSummaryPath ? path.relative(workspaceRoot, lastSummaryPath).replace(/\\/g, "/") : null,
  generatedAt: new Date().toISOString(),
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
process.stdout.write(`${path.relative(workspaceRoot, outPath).replace(/\\/g, "/")}\n`);
NODE

if [[ "$DONE" != "1" ]]; then
  echo "Loop did not complete successfully after $MAX_ITERATIONS iterations." >&2
  exit 2
fi

echo "Completed successfully. Summary written to $FINAL_JSON_OUT"
