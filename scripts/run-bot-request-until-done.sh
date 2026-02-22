#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

GOAL_TYPE=""
RECIPE_ID=""
RECIPE_FILE=""
WORKSPACE_ROOT="."
AUTONOMY_DIR="generated/orchestration/autonomy"
MAX_ITERATIONS=20
SLEEP_SECONDS=3
HEARTBEAT_SECONDS=10
SOURCE_POLICY="primary_plus_curated_secondary"
RISK_GATE_MODE="strict_blockers"
WAVE_STRATEGY=""
DEPENDENCY_MODE="staged"
MAX_TASKS=24
MAX_FILES=3000
MAX_FILE_BYTES=1500000
MAX_CHUNKS=10000
MAX_TOTAL_CHARS=20000000
INCLUDE_GENERATED=false
EXECUTOR_PROFILE="codex-safe"
EXECUTOR_PROVIDER=""
PROVIDER_TEMPLATE=""
PROVIDER_PRESET=""
PROVIDER_TIMEOUT_MS=""
COMMAND_TIMEOUT_MS=""
ANALYZE_TIMEOUT_MS=""
EXECUTOR_TEMPLATE=""
APPLY_MODE="dry-run"
APPLY_GUARD_TOKEN=""
APPLY_GUARD_VALUE=""
APPROVALS_DIR=""
REQUIRE_WAVE_APPROVAL=true
EVIDENCE_FILE=""
REQUIRE_EVIDENCE_FILE=true
ROLLBACK_CHECK_COMMAND=""
FAIL_POLICY="graph"
AUTO_SKILLS="suggest"
AUTO_RECIPE=false
AUTO_RECIPE_ID=""
SKILLS_DIR=".codex/skills/generated"
MIN_OCCURRENCES=2
JSON_OUT=""
AUTO_COMMIT=false
CURATED_DOMAINS=()
POLICY_PACKS=()
ENABLE_CRITIC=false
CRITIC_COMMAND=""
POLICY_CRITIC_CONFIG=""
CRITIC_FAIL_LEVEL="blocker"
ENABLE_REPAIR_LOOP=true
MEMORY_REVISIT=true
MEMORY_REVISIT_RECIPE_ID=""
MEMORY_REVISIT_AUTONOMY_DIR=""
MEMORY_REVISIT_SEMANTIC_PATH=""
MEMORY_REVISIT_REPLAY_PATH=""
MEMORY_REVISIT_MAX_CALLS_PER_MODULE=1
MEMORY_REVISIT_TOP_K=3
MEMORY_REVISIT_MIN_SCORE=0
MAX_REPAIR_ATTEMPTS=1
MAX_TOTAL_ATTEMPTS=0
MAX_TOTAL_TOKENS=0
MAX_RUN_RUNTIME_MS=0
FAIL_FAST=false
ARTIFACTS_DIR=""
REPAIRS_DIR=""
REQUIRE_ARTIFACT_CONTRACT=true
TEST_IMPACT_MODE="off"
FULL_TEST_COMMAND=""
FULL_TEST_IN_DRY_RUN=false
CANARY_MODULES=0
CANARY_COMPARE_COMMAND=""
MAX_PARALLEL=1
RESUME_SUCCESS_MODULES=true
SEMANTIC_MEMORY=true
SEMANTIC_MEMORY_PATH=""
RAG_AUTO_REFINE=true
RAG_REFINE_ITERATIONS=3
RAG_REFINE_QUERIES_PER_ITERATION=4
RAG_REFINE_QUERIES=20
RAG_REFINE_RUNTIME_MS=5000
RAG_REFINE_TOKEN_BUDGET=12000
RAG_REFINE_MAX_STALL_ITERATIONS=2
RAG_REFINE_CONVERGENCE_EPSILON=0.005
RAG_REPLAY_MEMORY=true
RAG_REPLAY_MEMORY_PATH=""
RAG_REPLAY_MAX_ENTRIES=240
RAG_REPLAY_MAX_AGE_DAYS=90
RAG_REPLAY_MIN_SCORE=0
RAG_REPLAY_MIN_SUCCESS_COUNT=1

apply_provider_preset() {
  local preset="$1"
  case "$preset" in
    codex)
      EXECUTOR_PROFILE="codex-safe"
      EXECUTOR_PROVIDER=""
      PROVIDER_TEMPLATE=""
      ;;
    codex-timeboxed)
      EXECUTOR_PROFILE="none"
      EXECUTOR_PROVIDER="custom"
      PROVIDER_TEMPLATE="bash $ROOT_DIR/scripts/executors/codex-timeboxed.sh \"{moduleId}\" \"{title}\" \"{partFile}\" \"{requestPath}\""
      ;;
    claude|claude-subscription)
      EXECUTOR_PROFILE="claude-safe"
      EXECUTOR_PROVIDER=""
      PROVIDER_TEMPLATE=""
      ;;
    claude-timeboxed)
      EXECUTOR_PROFILE="none"
      EXECUTOR_PROVIDER="custom"
      PROVIDER_TEMPLATE="bash $ROOT_DIR/scripts/executors/claude-timeboxed.sh \"{moduleId}\" \"{title}\" \"{partFile}\" \"{requestPath}\""
      ;;
    openai)
      EXECUTOR_PROFILE="none"
      EXECUTOR_PROVIDER="custom"
      PROVIDER_TEMPLATE="bash $ROOT_DIR/scripts/executors/openai.sh \"{moduleId}\" \"{title}\" \"{partFile}\" \"{requestPath}\""
      ;;
    anthropic)
      EXECUTOR_PROFILE="none"
      EXECUTOR_PROVIDER="custom"
      PROVIDER_TEMPLATE="bash $ROOT_DIR/scripts/executors/anthropic.sh \"{moduleId}\" \"{title}\" \"{partFile}\" \"{requestPath}\""
      ;;
    *)
      echo "ERROR: --provider-preset must be codex, codex-timeboxed, claude, claude-subscription, claude-timeboxed, openai, or anthropic" >&2
      exit 1
      ;;
  esac
}

cleanup_orphan_provider_processes() {
  local killed=0
  local pid=""
  local cmd=""
  local ppid=""
  local etimes=""
  local workspace_match=""
  if [[ -n "${WORKSPACE_ROOT_ABS:-}" ]]; then
    workspace_match="$WORKSPACE_ROOT_ABS"
  fi

  for pattern in 'claude -p .*DAG module:' 'codex .*DAG module:'; do
    while IFS= read -r pid; do
      [[ -z "$pid" ]] && continue
      ppid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ' || true)"
      [[ "$ppid" != "1" ]] && continue
      etimes="$(ps -o etimes= -p "$pid" 2>/dev/null | tr -d ' ' || true)"
      if [[ "$etimes" =~ ^[0-9]+$ ]] && [[ "$etimes" -lt 10 ]]; then
        continue
      fi
      cmd="$(ps -o command= -p "$pid" 2>/dev/null || true)"
      [[ "$cmd" != *"DAG module:"* ]] && continue
      if [[ -n "$workspace_match" && "$cmd" != *"$workspace_match"* ]]; then
        continue
      fi
      kill "$pid" 2>/dev/null || true
      killed=$((killed + 1))
    done < <(pgrep -f "$pattern" 2>/dev/null || true)
  done

  if [[ -n "$workspace_match" ]]; then
    for pattern in \
      "run-bot-request-until-done\\.sh .*--workspace-root ${workspace_match}" \
      "src/cli\\.ts auto-run .*--workspace-root ${workspace_match}" \
      "run cli auto-run .*--workspace-root ${workspace_match}"
    do
      while IFS= read -r pid; do
        [[ -z "$pid" ]] && continue
        [[ "$pid" == "$$" ]] && continue
        [[ "$pid" == "${BASHPID:-}" ]] && continue
        ppid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ' || true)"
        [[ "$ppid" != "1" ]] && continue
        etimes="$(ps -o etimes= -p "$pid" 2>/dev/null | tr -d ' ' || true)"
        if [[ "$etimes" =~ ^[0-9]+$ ]] && [[ "$etimes" -lt 10 ]]; then
          continue
        fi
        kill "$pid" 2>/dev/null || true
        killed=$((killed + 1))
      done < <(pgrep -f "$pattern" 2>/dev/null || true)
    done
  fi

  if [[ "$killed" -gt 0 ]]; then
    echo "hygiene: terminated $killed stale orchestration/provider process(es)"
  fi
}

print_help() {
  cat <<'USAGE'
run-bot-request-until-done.sh

Usage:
  ./scripts/run-bot-request-until-done.sh --goal-type <type> --recipe-id <id> [options]
  ./scripts/run-bot-request-until-done.sh --goal-type <type> --recipe-file <path> [options]

Required:
  --goal-type <build_migration|dependency_upgrade|ci_refactor|test_runner_migration|custom>
  --recipe-id <recipe-id> | --recipe-file <path>

Core options:
  --workspace-root <path>         Target repo root (default: .)
  --autonomy-dir <path>           Output dir for generated artifacts (default: generated/orchestration/autonomy)
  --max-iterations <n>            Max autonomous iterations (default: 20)
  --sleep-seconds <n>             Delay between iterations while not done (default: 3)
  --heartbeat-seconds <n>         In-flight heartbeat interval while auto-run executes (default: 10, 0 disables)

Planning/discovery options:
  --source-policy <policy>        primary_only|primary_plus_curated_secondary|open_web
  --risk-gate-mode <mode>         strict_blockers|warn_then_apply|manual_override
  --wave-strategy <strategy>      incremental_dual_build|pilot_wave|big_bang|custom
  --dependency <mode>             sequential|parallel|staged
  --policy-pack <id>              Policy pack ids to inject (repeatable)
  --curated-domain <domain>       Curated source domain allowlist (repeatable)
  --max-files <n>                 RAG indexing cap (default: 3000)
  --max-file-bytes <n>            Skip files larger than n bytes during RAG indexing (default: 1500000)
  --max-chunks <n>                Cap indexed chunks to prevent oversized indices (default: 10000)
  --max-total-chars <n>           Cap total indexed chunk characters (default: 20000000)
  --include-generated <bool>      Include generated/ dir in RAG index (default: false)
  --max-tasks <n>                 Max synthesized tasks (default: 24)

Execution options:
  --provider-preset <preset>     codex|codex-timeboxed|claude|claude-subscription|claude-timeboxed|openai|anthropic
  --provider-timeout-ms <n>      Sets ORCHESTRATOR_PROVIDER_TIMEOUT_MS for timeboxed presets
  --command-timeout-ms <n>       Command timeout for each module execution
  --analyze-timeout-ms <n>       Cap analyze/query module timeout (default: min(command-timeout-ms, 45000))
  --claude-subscription          Alias for --provider-preset claude-subscription
  --executor-profile <profile>    none|codex-safe|claude-safe (default: codex-safe)
  --executor-provider <provider>  codex|claude|custom (optional)
  --provider-template <cmd>       Template for custom provider ({prompt}, {moduleId}, {title}, {partFile})
  --executor <template>           Optional command template override for DAG modules
  --apply-mode <mode>             dry-run|apply (default: dry-run)
  --apply-guard-token <token>     Required in apply mode unless default guard is used
  --apply-guard-value <token>     Expected guard value (default: ALLOW_APPLY)
  --approvals-dir <path>          Apply approvals directory
  --no-require-wave-approval      Disable apply wave approval requirement
  --evidence-file <path>          Apply evidence file path
  --no-require-evidence-file      Disable apply evidence requirement
  --rollback-check-command <cmd>  Command that must pass before apply mode
  --fail-policy <policy>          graph|global (default: graph)
  --fail-fast                     Stop on first failed/blocked module
  --enable-critic                 Run critic pass per module
  --critic-command <template>     Critic command template
  --policy-critic-config <path>   JSON config for policy-pack critic templates/parsers
  --critic-fail-level <level>     Critic threshold: info|warning|blocker (default: blocker)
  --disable-repair-loop           Disable focused repair loop
  --memory-revisit <bool>         Enable repair-time memory recall (default: true)
  --memory-revisit-recipe-id <id> Recipe id used to locate semantic/replay memory
  --memory-revisit-autonomy-dir <path> Autonomy dir used for memory lookups
  --memory-revisit-semantic-path <path> Semantic memory path override
  --memory-revisit-replay-path <path> Replay memory path override
  --memory-revisit-max-calls-per-module <n> Max recall calls per module (default: 1)
  --memory-revisit-top-k <n>      Max recalled evidence items per repair task (default: 3)
  --memory-revisit-min-score <n>  Minimum recall score threshold (default: 0)
  --max-repair-attempts <n>       Max focused repair attempts per module (default: 1)
  --max-total-attempts <n>        Run budget: max module attempts (0 disables)
  --max-total-tokens <n>          Run budget: max estimated token usage (0 disables)
  --max-run-runtime-ms <n>        Run budget: max runtime in ms (0 disables)
  --artifacts-dir <path>          Module artifact contracts output dir
  --repairs-dir <path>            Focused repair task output dir
  --no-require-artifact-contract  Disable strict artifact contract requirement
  --test-impact <mode>            off|targeted|targeted_then_full (default: off)
  --full-test-command <cmd>       Full-suite command for targeted_then_full
  --full-test-in-dry-run <bool>   Enforce full-suite gate in apply-mode dry-run (default: false)
  --canary-modules <n>            Canary checkpoint after N successful modules
  --canary-compare-command <cmd>  Compare command before full rollout
  --max-parallel <n>              Max concurrent modules per DAG level (default: 1)
  --resume-success-modules <bool> Reuse successful module artifacts when digest matches (default: true)
  --no-resume-success-modules     Disable successful-module artifact resume
  --rag-auto-refine <bool>        Enable auto-refine retrieval in synthesis (default: true)
  --rag-refine-iterations <n>     Auto-refine max iterations (default: 3)
  --rag-refine-queries-per-iteration <n> Auto-refine max queries/iteration (default: 4)
  --rag-refine-queries <n>        Auto-refine max total queries (default: 20)
  --rag-refine-runtime-ms <n>     Auto-refine runtime budget (default: 5000)
  --rag-refine-token-budget <n>   Auto-refine token budget (default: 12000; 0 disables)
  --rag-refine-max-stall-iterations <n> Auto-refine critic stall limit (default: 2)
  --rag-refine-convergence-epsilon <n> Auto-refine convergence epsilon (default: 0.005)
  --rag-replay-memory <bool>      Enable replay-memory query seeding (default: true)
  --rag-replay-memory-path <path> Replay-memory file path override
  --rag-replay-max-entries <n>    Replay-memory max retained entries (default: 240)
  --rag-replay-max-age-days <n>   Replay-memory max age in days (default: 90)
  --rag-replay-min-score <n>      Replay-memory minimum score/confidence (default: 0)
  --rag-replay-min-success-count <n> Replay-memory minimum success count (default: 1)

Skill options:
  --auto-skills <mode>            off|suggest|apply (default: suggest)
  --auto-recipe                   Generate recipe from discovery + memory each iteration
  --auto-recipe-id <id>           Override generated recipe id
  --skills-dir <path>             Skill output dir (default: .codex/skills/generated)
  --min-occurrences <n>           Pattern threshold for skill generation (default: 2)

Output options:
  --json-out <path>               Final loop summary path (default: <autonomy-dir>/until-done-summary.json)
  --commit                        Create a git commit after successful completion
  --semantic-memory-path <path>   Semantic memory state path override
  --no-semantic-memory            Disable semantic memory persistence
  -h, --help                      Show help

Runtime hygiene:
  - Automatically terminates orphaned provider child processes (PPID=1) carrying DAG prompts before/after each iteration.
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
    --recipe-file)
      RECIPE_FILE="${2:-}"
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
    --heartbeat-seconds)
      HEARTBEAT_SECONDS="${2:-}"
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
    --policy-pack)
      POLICY_PACKS+=("${2:-}")
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
    --max-file-bytes)
      MAX_FILE_BYTES="${2:-}"
      shift 2
      ;;
    --max-chunks)
      MAX_CHUNKS="${2:-}"
      shift 2
      ;;
    --max-total-chars)
      MAX_TOTAL_CHARS="${2:-}"
      shift 2
      ;;
    --include-generated)
      INCLUDE_GENERATED="${2:-}"
      shift 2
      ;;
    --max-tasks)
      MAX_TASKS="${2:-}"
      shift 2
      ;;
    --provider-preset)
      PROVIDER_PRESET="${2:-}"
      apply_provider_preset "$PROVIDER_PRESET"
      shift 2
      ;;
    --provider-timeout-ms)
      PROVIDER_TIMEOUT_MS="${2:-}"
      shift 2
      ;;
    --command-timeout-ms)
      COMMAND_TIMEOUT_MS="${2:-}"
      shift 2
      ;;
    --analyze-timeout-ms)
      ANALYZE_TIMEOUT_MS="${2:-}"
      shift 2
      ;;
    --claude-subscription)
      PROVIDER_PRESET="claude-subscription"
      apply_provider_preset "$PROVIDER_PRESET"
      shift
      ;;
    --executor-profile)
      EXECUTOR_PROFILE="${2:-}"
      shift 2
      ;;
    --executor-provider)
      EXECUTOR_PROVIDER="${2:-}"
      shift 2
      ;;
    --provider-template)
      PROVIDER_TEMPLATE="${2:-}"
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
    --approvals-dir)
      APPROVALS_DIR="${2:-}"
      shift 2
      ;;
    --no-require-wave-approval)
      REQUIRE_WAVE_APPROVAL=false
      shift
      ;;
    --evidence-file)
      EVIDENCE_FILE="${2:-}"
      shift 2
      ;;
    --no-require-evidence-file)
      REQUIRE_EVIDENCE_FILE=false
      shift
      ;;
    --rollback-check-command)
      ROLLBACK_CHECK_COMMAND="${2:-}"
      shift 2
      ;;
    --fail-policy)
      FAIL_POLICY="${2:-}"
      shift 2
      ;;
    --fail-fast)
      FAIL_FAST=true
      shift
      ;;
    --enable-critic)
      ENABLE_CRITIC=true
      shift
      ;;
    --critic-command)
      CRITIC_COMMAND="${2:-}"
      shift 2
      ;;
    --policy-critic-config)
      POLICY_CRITIC_CONFIG="${2:-}"
      shift 2
      ;;
    --critic-fail-level)
      CRITIC_FAIL_LEVEL="${2:-}"
      shift 2
      ;;
    --disable-repair-loop)
      ENABLE_REPAIR_LOOP=false
      shift
      ;;
    --enable-repair-loop)
      ENABLE_REPAIR_LOOP=true
      shift
      ;;
    --memory-revisit)
      MEMORY_REVISIT="${2:-}"
      shift 2
      ;;
    --memory-revisit-recipe-id)
      MEMORY_REVISIT_RECIPE_ID="${2:-}"
      shift 2
      ;;
    --memory-revisit-autonomy-dir)
      MEMORY_REVISIT_AUTONOMY_DIR="${2:-}"
      shift 2
      ;;
    --memory-revisit-semantic-path)
      MEMORY_REVISIT_SEMANTIC_PATH="${2:-}"
      shift 2
      ;;
    --memory-revisit-replay-path)
      MEMORY_REVISIT_REPLAY_PATH="${2:-}"
      shift 2
      ;;
    --memory-revisit-max-calls-per-module)
      MEMORY_REVISIT_MAX_CALLS_PER_MODULE="${2:-}"
      shift 2
      ;;
    --memory-revisit-top-k)
      MEMORY_REVISIT_TOP_K="${2:-}"
      shift 2
      ;;
    --memory-revisit-min-score)
      MEMORY_REVISIT_MIN_SCORE="${2:-}"
      shift 2
      ;;
    --max-repair-attempts)
      MAX_REPAIR_ATTEMPTS="${2:-}"
      shift 2
      ;;
    --max-total-attempts)
      MAX_TOTAL_ATTEMPTS="${2:-}"
      shift 2
      ;;
    --max-total-tokens)
      MAX_TOTAL_TOKENS="${2:-}"
      shift 2
      ;;
    --max-run-runtime-ms)
      MAX_RUN_RUNTIME_MS="${2:-}"
      shift 2
      ;;
    --artifacts-dir)
      ARTIFACTS_DIR="${2:-}"
      shift 2
      ;;
    --repairs-dir)
      REPAIRS_DIR="${2:-}"
      shift 2
      ;;
    --no-require-artifact-contract)
      REQUIRE_ARTIFACT_CONTRACT=false
      shift
      ;;
    --test-impact)
      TEST_IMPACT_MODE="${2:-}"
      shift 2
      ;;
    --full-test-command)
      FULL_TEST_COMMAND="${2:-}"
      shift 2
      ;;
    --full-test-in-dry-run)
      FULL_TEST_IN_DRY_RUN="${2:-}"
      shift 2
      ;;
    --canary-modules)
      CANARY_MODULES="${2:-}"
      shift 2
      ;;
    --canary-compare-command)
      CANARY_COMPARE_COMMAND="${2:-}"
      shift 2
      ;;
    --max-parallel)
      MAX_PARALLEL="${2:-}"
      shift 2
      ;;
    --resume-success-modules)
      RESUME_SUCCESS_MODULES="${2:-}"
      shift 2
      ;;
    --no-resume-success-modules)
      RESUME_SUCCESS_MODULES=false
      shift
      ;;
    --rag-auto-refine)
      RAG_AUTO_REFINE="${2:-}"
      shift 2
      ;;
    --rag-refine-iterations)
      RAG_REFINE_ITERATIONS="${2:-}"
      shift 2
      ;;
    --rag-refine-queries-per-iteration)
      RAG_REFINE_QUERIES_PER_ITERATION="${2:-}"
      shift 2
      ;;
    --rag-refine-queries)
      RAG_REFINE_QUERIES="${2:-}"
      shift 2
      ;;
    --rag-refine-runtime-ms)
      RAG_REFINE_RUNTIME_MS="${2:-}"
      shift 2
      ;;
    --rag-refine-token-budget)
      RAG_REFINE_TOKEN_BUDGET="${2:-}"
      shift 2
      ;;
    --rag-refine-max-stall-iterations)
      RAG_REFINE_MAX_STALL_ITERATIONS="${2:-}"
      shift 2
      ;;
    --rag-refine-convergence-epsilon)
      RAG_REFINE_CONVERGENCE_EPSILON="${2:-}"
      shift 2
      ;;
    --rag-replay-memory)
      RAG_REPLAY_MEMORY="${2:-}"
      shift 2
      ;;
    --rag-replay-memory-path)
      RAG_REPLAY_MEMORY_PATH="${2:-}"
      shift 2
      ;;
    --rag-replay-max-entries)
      RAG_REPLAY_MAX_ENTRIES="${2:-}"
      shift 2
      ;;
    --rag-replay-max-age-days)
      RAG_REPLAY_MAX_AGE_DAYS="${2:-}"
      shift 2
      ;;
    --rag-replay-min-score)
      RAG_REPLAY_MIN_SCORE="${2:-}"
      shift 2
      ;;
    --rag-replay-min-success-count)
      RAG_REPLAY_MIN_SUCCESS_COUNT="${2:-}"
      shift 2
      ;;
    --auto-skills)
      AUTO_SKILLS="${2:-}"
      shift 2
      ;;
    --auto-recipe)
      AUTO_RECIPE=true
      shift
      ;;
    --auto-recipe-id)
      AUTO_RECIPE_ID="${2:-}"
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
    --commit)
      AUTO_COMMIT=true
      shift
      ;;
    --semantic-memory-path)
      SEMANTIC_MEMORY_PATH="${2:-}"
      shift 2
      ;;
    --no-semantic-memory)
      SEMANTIC_MEMORY=false
      shift
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

if [[ -z "$GOAL_TYPE" ]]; then
  echo "ERROR: --goal-type is required" >&2
  exit 1
fi

if [[ -z "$RECIPE_ID" && -z "$RECIPE_FILE" ]]; then
  echo "ERROR: either --recipe-id or --recipe-file is required" >&2
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

if ! [[ "$HEARTBEAT_SECONDS" =~ ^[0-9]+$ ]] || [[ "$HEARTBEAT_SECONDS" -lt 0 ]]; then
  echo "ERROR: --heartbeat-seconds must be >= 0" >&2
  exit 1
fi

if [[ "$APPLY_MODE" != "dry-run" && "$APPLY_MODE" != "apply" ]]; then
  echo "ERROR: --apply-mode must be dry-run or apply" >&2
  exit 1
fi

if [[ "$EXECUTOR_PROFILE" != "none" && "$EXECUTOR_PROFILE" != "codex-safe" && "$EXECUTOR_PROFILE" != "claude-safe" ]]; then
  echo "ERROR: --executor-profile must be none, codex-safe, or claude-safe" >&2
  exit 1
fi

if [[ -n "$EXECUTOR_PROVIDER" && "$EXECUTOR_PROVIDER" != "codex" && "$EXECUTOR_PROVIDER" != "claude" && "$EXECUTOR_PROVIDER" != "custom" ]]; then
  echo "ERROR: --executor-provider must be codex, claude, or custom" >&2
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

if [[ "$TEST_IMPACT_MODE" != "off" && "$TEST_IMPACT_MODE" != "targeted" && "$TEST_IMPACT_MODE" != "targeted_then_full" ]]; then
  echo "ERROR: --test-impact must be off, targeted, or targeted_then_full" >&2
  exit 1
fi

if [[ "$CRITIC_FAIL_LEVEL" != "info" && "$CRITIC_FAIL_LEVEL" != "warning" && "$CRITIC_FAIL_LEVEL" != "blocker" ]]; then
  echo "ERROR: --critic-fail-level must be info, warning, or blocker" >&2
  exit 1
fi

if [[ "$RAG_AUTO_REFINE" != "true" && "$RAG_AUTO_REFINE" != "false" ]]; then
  echo "ERROR: --rag-auto-refine must be true or false" >&2
  exit 1
fi

if [[ "$RAG_REPLAY_MEMORY" != "true" && "$RAG_REPLAY_MEMORY" != "false" ]]; then
  echo "ERROR: --rag-replay-memory must be true or false" >&2
  exit 1
fi

if [[ "$INCLUDE_GENERATED" != "true" && "$INCLUDE_GENERATED" != "false" ]]; then
  echo "ERROR: --include-generated must be true or false" >&2
  exit 1
fi

if [[ "$MEMORY_REVISIT" != "true" && "$MEMORY_REVISIT" != "false" ]]; then
  echo "ERROR: --memory-revisit must be true or false" >&2
  exit 1
fi

if [[ "$FULL_TEST_IN_DRY_RUN" != "true" && "$FULL_TEST_IN_DRY_RUN" != "false" ]]; then
  echo "ERROR: --full-test-in-dry-run must be true or false" >&2
  exit 1
fi

if [[ "$RESUME_SUCCESS_MODULES" != "true" && "$RESUME_SUCCESS_MODULES" != "false" ]]; then
  echo "ERROR: --resume-success-modules must be true or false" >&2
  exit 1
fi

validate_non_negative_int() {
  local value="$1"
  local flag_name="$2"
  if ! [[ "$value" =~ ^[0-9]+$ ]]; then
    echo "ERROR: --$flag_name must be a non-negative integer" >&2
    exit 1
  fi
}

validate_non_negative_int "$MAX_REPAIR_ATTEMPTS" "max-repair-attempts"
validate_non_negative_int "$MEMORY_REVISIT_MAX_CALLS_PER_MODULE" "memory-revisit-max-calls-per-module"
validate_non_negative_int "$MEMORY_REVISIT_TOP_K" "memory-revisit-top-k"
validate_non_negative_int "$MAX_TOTAL_ATTEMPTS" "max-total-attempts"
validate_non_negative_int "$MAX_TOTAL_TOKENS" "max-total-tokens"
validate_non_negative_int "$MAX_RUN_RUNTIME_MS" "max-run-runtime-ms"
validate_non_negative_int "$CANARY_MODULES" "canary-modules"
validate_non_negative_int "$MAX_PARALLEL" "max-parallel"
validate_non_negative_int "$MAX_FILE_BYTES" "max-file-bytes"
validate_non_negative_int "$MAX_CHUNKS" "max-chunks"
validate_non_negative_int "$MAX_TOTAL_CHARS" "max-total-chars"
validate_non_negative_int "$RAG_REFINE_ITERATIONS" "rag-refine-iterations"
validate_non_negative_int "$RAG_REFINE_QUERIES_PER_ITERATION" "rag-refine-queries-per-iteration"
validate_non_negative_int "$RAG_REFINE_QUERIES" "rag-refine-queries"
validate_non_negative_int "$RAG_REFINE_RUNTIME_MS" "rag-refine-runtime-ms"
validate_non_negative_int "$RAG_REFINE_TOKEN_BUDGET" "rag-refine-token-budget"
validate_non_negative_int "$RAG_REFINE_MAX_STALL_ITERATIONS" "rag-refine-max-stall-iterations"
validate_non_negative_int "$RAG_REPLAY_MAX_ENTRIES" "rag-replay-max-entries"
validate_non_negative_int "$RAG_REPLAY_MAX_AGE_DAYS" "rag-replay-max-age-days"
validate_non_negative_int "$RAG_REPLAY_MIN_SUCCESS_COUNT" "rag-replay-min-success-count"

if [[ -n "$PROVIDER_TIMEOUT_MS" ]]; then
  if ! [[ "$PROVIDER_TIMEOUT_MS" =~ ^[0-9]+$ ]] || [[ "$PROVIDER_TIMEOUT_MS" -lt 1 ]]; then
    echo "ERROR: --provider-timeout-ms must be a positive integer" >&2
    exit 1
  fi
fi

if [[ -n "$COMMAND_TIMEOUT_MS" ]]; then
  if ! [[ "$COMMAND_TIMEOUT_MS" =~ ^[0-9]+$ ]] || [[ "$COMMAND_TIMEOUT_MS" -lt 1000 ]]; then
    echo "ERROR: --command-timeout-ms must be an integer >= 1000" >&2
    exit 1
  fi
fi

if [[ -n "$ANALYZE_TIMEOUT_MS" ]]; then
  if ! [[ "$ANALYZE_TIMEOUT_MS" =~ ^[0-9]+$ ]] || [[ "$ANALYZE_TIMEOUT_MS" -lt 1000 ]]; then
    echo "ERROR: --analyze-timeout-ms must be an integer >= 1000" >&2
    exit 1
  fi
fi

if [[ -z "$COMMAND_TIMEOUT_MS" ]]; then
  if [[ -n "$PROVIDER_TIMEOUT_MS" ]]; then
    COMMAND_TIMEOUT_MS="$((PROVIDER_TIMEOUT_MS + 30000))"
  else
    COMMAND_TIMEOUT_MS=600000
  fi
fi

if [[ -z "$ANALYZE_TIMEOUT_MS" ]]; then
  if [[ "$COMMAND_TIMEOUT_MS" -lt 45000 ]]; then
    ANALYZE_TIMEOUT_MS="$COMMAND_TIMEOUT_MS"
  else
    ANALYZE_TIMEOUT_MS=45000
  fi
fi

if ! [[ "$RAG_REFINE_CONVERGENCE_EPSILON" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
  echo "ERROR: --rag-refine-convergence-epsilon must be a non-negative number" >&2
  exit 1
fi

if ! [[ "$RAG_REPLAY_MIN_SCORE" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
  echo "ERROR: --rag-replay-min-score must be a non-negative number" >&2
  exit 1
fi

if ! [[ "$MEMORY_REVISIT_MIN_SCORE" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
  echo "ERROR: --memory-revisit-min-score must be a non-negative number" >&2
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
LAST_CURSOR_STEP="0"
LAST_TOTAL_MODULES="0"
LAST_CURSOR_MODULE=""
LAST_FLOW_PREVIEW=""
LAST_RESUMED="0"
PREV_FAILURE_SIGNATURE=""
SAME_FAILURE_STREAK=0
CURRENT_RUN_PID=""

terminate_active_run() {
  local pid="${CURRENT_RUN_PID:-}"
  [[ -z "$pid" ]] && return 0
  if kill -0 "$pid" 2>/dev/null; then
    if kill -0 "-$pid" 2>/dev/null; then
      kill "-$pid" 2>/dev/null || true
      sleep 1
      kill -9 "-$pid" 2>/dev/null || true
    fi
    kill "$pid" 2>/dev/null || true
    sleep 1
    kill -9 "$pid" 2>/dev/null || true
  fi
  CURRENT_RUN_PID=""
}

on_exit() {
  terminate_active_run || true
  cleanup_orphan_provider_processes || true
}

trap on_exit EXIT INT TERM

emit_plan_preview() {
  local manifest_path="$AUTONOMY_DIR_FS/dag/manifest.json"
  local preview_line=""
  preview_line="$(
    node - "$manifest_path" "$DEPENDENCY_MODE" <<'NODE'
const fs = require("node:fs");

const manifestPath = process.argv[2];
const dependencyMode = process.argv[3] || "staged";
const phases = "discover>rag>synthesize>compile>execute";

if (!fs.existsSync(manifestPath)) {
  process.stdout.write(`${phases} (manifest:pending mode=${dependencyMode})`);
  process.exit(0);
}

try {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const modules = Array.isArray(manifest.modules) ? manifest.modules : [];
  const levelCounts = new Map();
  for (const module of modules) {
    const levelRaw = Number(module?.level ?? 0);
    const level = Number.isFinite(levelRaw) ? levelRaw : 0;
    levelCounts.set(level, (levelCounts.get(level) ?? 0) + 1);
  }
  const levels = Array.from(levelCounts.keys()).sort((a, b) => a - b);
  const widths = levels.map((level) => levelCounts.get(level) ?? 0);
  const levelText = widths.length > 0
    ? widths.map((width, idx) => `L${idx}(${width})`).join(" -> ")
    : "none";
  const startParallel = widths.length > 0 ? widths[0] : 0;
  const maxParallel = widths.length > 0 ? Math.max(...widths) : 0;
  process.stdout.write(
    `${phases} | modules=${modules.length} | levels=${levelText} | startParallel=${startParallel} | maxParallel=${maxParallel} | mode=${manifest.dependencyMode ?? dependencyMode}`,
  );
} catch (_error) {
  process.stdout.write(`${phases} (manifest:unreadable mode=${dependencyMode})`);
}
NODE
  )"
  echo "    planPreview=$preview_line"
}

for ((iteration=1; iteration<=MAX_ITERATIONS; iteration++)); do
  cleanup_orphan_provider_processes

  ITER_SUMMARY="$AUTONOMY_DIR/iterations/auto-run-$(printf "%03d" "$iteration").json"
  LAST_SUMMARY="$ITER_SUMMARY"

  CMD=(
    bash scripts/run-orchestrator-cli.sh auto-run
    --goal-type "$GOAL_TYPE"
    --workspace-root "$WORKSPACE_ROOT_ABS"
    --autonomy-dir "$AUTONOMY_DIR"
    --source-policy "$SOURCE_POLICY"
    --risk-gate-mode "$RISK_GATE_MODE"
    --dependency "$DEPENDENCY_MODE"
    --max-files "$MAX_FILES"
    --max-file-bytes "$MAX_FILE_BYTES"
    --max-chunks "$MAX_CHUNKS"
    --max-total-chars "$MAX_TOTAL_CHARS"
    --include-generated "$INCLUDE_GENERATED"
    --max-tasks "$MAX_TASKS"
    --timeout-ms "$COMMAND_TIMEOUT_MS"
    --analyze-timeout-ms "$ANALYZE_TIMEOUT_MS"
    --executor-profile "$EXECUTOR_PROFILE"
    --apply-mode "$APPLY_MODE"
    --fail-policy "$FAIL_POLICY"
    --test-impact "$TEST_IMPACT_MODE"
    --full-test-in-dry-run "$FULL_TEST_IN_DRY_RUN"
    --memory-revisit "$MEMORY_REVISIT"
    --memory-revisit-max-calls-per-module "$MEMORY_REVISIT_MAX_CALLS_PER_MODULE"
    --memory-revisit-top-k "$MEMORY_REVISIT_TOP_K"
    --memory-revisit-min-score "$MEMORY_REVISIT_MIN_SCORE"
    --max-repair-attempts "$MAX_REPAIR_ATTEMPTS"
    --max-total-attempts "$MAX_TOTAL_ATTEMPTS"
    --max-total-tokens "$MAX_TOTAL_TOKENS"
    --max-run-runtime-ms "$MAX_RUN_RUNTIME_MS"
    --canary-modules "$CANARY_MODULES"
    --max-parallel "$MAX_PARALLEL"
    --resume-success-modules "$RESUME_SUCCESS_MODULES"
    --critic-fail-level "$CRITIC_FAIL_LEVEL"
    --rag-auto-refine "$RAG_AUTO_REFINE"
    --rag-refine-iterations "$RAG_REFINE_ITERATIONS"
    --rag-refine-queries-per-iteration "$RAG_REFINE_QUERIES_PER_ITERATION"
    --rag-refine-queries "$RAG_REFINE_QUERIES"
    --rag-refine-runtime-ms "$RAG_REFINE_RUNTIME_MS"
    --rag-refine-token-budget "$RAG_REFINE_TOKEN_BUDGET"
    --rag-refine-max-stall-iterations "$RAG_REFINE_MAX_STALL_ITERATIONS"
    --rag-refine-convergence-epsilon "$RAG_REFINE_CONVERGENCE_EPSILON"
    --rag-replay-memory "$RAG_REPLAY_MEMORY"
    --rag-replay-max-entries "$RAG_REPLAY_MAX_ENTRIES"
    --rag-replay-max-age-days "$RAG_REPLAY_MAX_AGE_DAYS"
    --rag-replay-min-score "$RAG_REPLAY_MIN_SCORE"
    --rag-replay-min-success-count "$RAG_REPLAY_MIN_SUCCESS_COUNT"
    --auto-skills "$AUTO_SKILLS"
    --skills-dir "$SKILLS_DIR"
    --min-occurrences "$MIN_OCCURRENCES"
    --json-out "$ITER_SUMMARY"
  )

  if [[ -n "$RECIPE_ID" ]]; then
    CMD+=(--recipe-id "$RECIPE_ID")
  fi

  if [[ -n "$RECIPE_FILE" ]]; then
    CMD+=(--recipe-file "$RECIPE_FILE")
  fi

  if [[ -n "$EXECUTOR_TEMPLATE" ]]; then
    CMD+=(--executor "$EXECUTOR_TEMPLATE")
  fi

  if [[ -n "$EXECUTOR_PROVIDER" ]]; then
    CMD+=(--executor-provider "$EXECUTOR_PROVIDER")
  fi

  if [[ -n "$PROVIDER_TEMPLATE" ]]; then
    CMD+=(--provider-template "$PROVIDER_TEMPLATE")
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

  if [[ -n "$APPROVALS_DIR" ]]; then
    CMD+=(--approvals-dir "$APPROVALS_DIR")
  fi

  if [[ "$REQUIRE_WAVE_APPROVAL" == "false" ]]; then
    CMD+=(--no-require-wave-approval)
  fi

  if [[ -n "$EVIDENCE_FILE" ]]; then
    CMD+=(--evidence-file "$EVIDENCE_FILE")
  fi

  if [[ "$REQUIRE_EVIDENCE_FILE" == "false" ]]; then
    CMD+=(--no-require-evidence-file)
  fi

  if [[ -n "$ROLLBACK_CHECK_COMMAND" ]]; then
    CMD+=(--rollback-check-command "$ROLLBACK_CHECK_COMMAND")
  fi

  if [[ "$FAIL_FAST" == "true" ]]; then
    CMD+=(--fail-fast)
  fi

  if [[ "$ENABLE_CRITIC" == "true" ]]; then
    CMD+=(--enable-critic)
  fi

  if [[ -n "$CRITIC_COMMAND" ]]; then
    CMD+=(--critic-command "$CRITIC_COMMAND")
  fi

  if [[ -n "$POLICY_CRITIC_CONFIG" ]]; then
    CMD+=(--policy-critic-config "$POLICY_CRITIC_CONFIG")
  fi

  if [[ "$ENABLE_REPAIR_LOOP" == "true" ]]; then
    CMD+=(--enable-repair-loop)
  fi

  if [[ -n "$ARTIFACTS_DIR" ]]; then
    CMD+=(--artifacts-dir "$ARTIFACTS_DIR")
  fi

  if [[ -n "$REPAIRS_DIR" ]]; then
    CMD+=(--repairs-dir "$REPAIRS_DIR")
  fi

  if [[ "$REQUIRE_ARTIFACT_CONTRACT" == "false" ]]; then
    CMD+=(--no-require-artifact-contract)
  fi

  if [[ -n "$FULL_TEST_COMMAND" ]]; then
    CMD+=(--full-test-command "$FULL_TEST_COMMAND")
  fi

  if [[ -n "$CANARY_COMPARE_COMMAND" ]]; then
    CMD+=(--canary-compare-command "$CANARY_COMPARE_COMMAND")
  fi

  if [[ "$AUTO_RECIPE" == "true" ]]; then
    CMD+=(--auto-recipe)
  fi

  if [[ -n "$AUTO_RECIPE_ID" ]]; then
    CMD+=(--auto-recipe-id "$AUTO_RECIPE_ID")
  fi

  if [[ -n "$RAG_REPLAY_MEMORY_PATH" ]]; then
    CMD+=(--rag-replay-memory-path "$RAG_REPLAY_MEMORY_PATH")
  fi

  if [[ -n "$MEMORY_REVISIT_RECIPE_ID" ]]; then
    CMD+=(--memory-revisit-recipe-id "$MEMORY_REVISIT_RECIPE_ID")
  fi

  if [[ -n "$MEMORY_REVISIT_AUTONOMY_DIR" ]]; then
    CMD+=(--memory-revisit-autonomy-dir "$MEMORY_REVISIT_AUTONOMY_DIR")
  fi

  if [[ -n "$MEMORY_REVISIT_SEMANTIC_PATH" ]]; then
    CMD+=(--memory-revisit-semantic-path "$MEMORY_REVISIT_SEMANTIC_PATH")
  fi

  if [[ -n "$MEMORY_REVISIT_REPLAY_PATH" ]]; then
    CMD+=(--memory-revisit-replay-path "$MEMORY_REVISIT_REPLAY_PATH")
  fi

  if ((${#CURATED_DOMAINS[@]:-0} > 0)); then
    for domain in "${CURATED_DOMAINS[@]}"; do
      CMD+=(--curated-domain "$domain")
    done
  fi

  if ((${#POLICY_PACKS[@]:-0} > 0)); then
    for pack in "${POLICY_PACKS[@]}"; do
      CMD+=(--policy-pack "$pack")
    done
  fi

  if [[ "$SEMANTIC_MEMORY" == "false" ]]; then
    CMD+=(--no-semantic-memory)
  fi

  if [[ -n "$SEMANTIC_MEMORY_PATH" ]]; then
    CMD+=(--semantic-memory-path "$SEMANTIC_MEMORY_PATH")
  fi

  RECIPE_LABEL="${RECIPE_ID:-$RECIPE_FILE}"
  echo "==> [iteration $iteration/$MAX_ITERATIONS] auto-run for recipe '$RECIPE_LABEL'"
  emit_plan_preview
  ITERATION_STARTED_EPOCH="$(date +%s)"
  ITERATION_STARTED_MS="$((ITERATION_STARTED_EPOCH * 1000))"
  LATEST_HEARTBEAT_ARTIFACT=""
  if [[ -n "$PROVIDER_TIMEOUT_MS" ]]; then
    ORCHESTRATOR_PROVIDER_TIMEOUT_MS="$PROVIDER_TIMEOUT_MS" "${CMD[@]}" &
  else
    "${CMD[@]}" &
  fi

  RUN_PID="$!"
  CURRENT_RUN_PID="$RUN_PID"

  if [[ "$HEARTBEAT_SECONDS" -gt 0 ]]; then
    while kill -0 "$RUN_PID" 2>/dev/null; do
      sleep "$HEARTBEAT_SECONDS"
      if ! kill -0 "$RUN_PID" 2>/dev/null; then
        break
      fi

      NOW_EPOCH="$(date +%s)"
      ELAPSED_SECONDS=$((NOW_EPOCH - ITERATION_STARTED_EPOCH))
      HEARTBEAT_LINE="    heartbeat iteration=$iteration elapsed=${ELAPSED_SECONDS}s status=running"

      LATEST_ARTIFACT_FILE="$(
        node - "$AUTONOMY_DIR_FS" "$WORKSPACE_ROOT_ABS" "$ITERATION_STARTED_MS" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const autonomyDirFs = process.argv[2];
const workspaceRootAbs = process.argv[3];
const iterationStartedMs = Number(process.argv[4]) || 0;
const roots = [
  path.resolve(autonomyDirFs, "dag", "artifacts"),
  path.resolve(workspaceRootAbs, "generated", "orchestration", "dag", "artifacts"),
];

let bestPath = "";
let bestMtime = 0;

for (const root of roots) {
  let entries = [];
  try {
    entries = fs.readdirSync(root);
  } catch {
    continue;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".artifact.json")) continue;
    if (!entry.includes(".attempt-")) continue;
    const filePath = path.resolve(root, entry);
    let stats;
    try {
      stats = fs.statSync(filePath);
    } catch {
      continue;
    }
    const mtime = stats.mtimeMs || 0;
    if (mtime < iterationStartedMs) continue;
    if (mtime > bestMtime) {
      bestMtime = mtime;
      bestPath = filePath;
    }
  }
}

process.stdout.write(bestPath);
NODE
      )"
      if [[ -n "$LATEST_ARTIFACT_FILE" && "$LATEST_ARTIFACT_FILE" != "$LATEST_HEARTBEAT_ARTIFACT" ]]; then
        ARTIFACT_SNIPPET="$(
          node - "$LATEST_ARTIFACT_FILE" "$WORKSPACE_ROOT_ABS" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const artifactPath = process.argv[2];
const workspaceRoot = path.resolve(process.argv[3]);

try {
  const payload = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const moduleId = payload.moduleId ?? "unknown";
  const status = payload.status ?? "unknown";
  const attempt = payload.attempt ?? "?";
  const code = payload.command?.code ?? "null";
  const durationMs = payload.command?.durationMs ?? 0;
  const rel = path.relative(workspaceRoot, artifactPath).replace(/\\/g, "/");
  process.stdout.write(`${moduleId}:${status}:attempt=${attempt}:code=${code}:durationMs=${durationMs}:file=${rel}`);
} catch (_error) {
  process.stdout.write("artifact=unreadable");
}
NODE
        )"
        HEARTBEAT_LINE="$HEARTBEAT_LINE lastArtifact=$ARTIFACT_SNIPPET"
        LATEST_HEARTBEAT_ARTIFACT="$LATEST_ARTIFACT_FILE"
      fi

      echo "$HEARTBEAT_LINE"
    done
  fi

  set +e
  wait "$RUN_PID"
  RUN_STATUS="$?"
  set -e
  CURRENT_RUN_PID=""

  cleanup_orphan_provider_processes

  if [[ "$RUN_STATUS" -ne 0 ]]; then
    echo "auto-run command failed with exit code $RUN_STATUS" >&2
    exit "$RUN_STATUS"
  fi

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
const dagManifestPath = artifacts.dagManifestPath
  ? path.resolve(workspaceRoot, artifacts.dagManifestPath)
  : null;

const failed = [];
const blocked = [];
let success = 0;
let skipped = 0;
let results = [];
let manifestModules = [];
let levelWidthsPreview = "";
let startParallel = 0;
let maxParallel = 0;
let levelEdgesPreview = "";
let memoryCalls = 0;
let memoryHits = 0;
let memoryCandidatesLoaded = 0;
let memorySelectedPreview = "";
let memorySkippedPreview = "";
let resumedModules = 0;

if (dagRunSummaryPath && fs.existsSync(dagRunSummaryPath)) {
  const dagRun = JSON.parse(fs.readFileSync(dagRunSummaryPath, "utf8"));
  results = Array.isArray(dagRun.results) ? dagRun.results : [];
  resumedModules = Number.isFinite(Number(dagRun.resumedModules)) ? Number(dagRun.resumedModules) : 0;
  for (const result of results) {
    if (result.status === "failed") failed.push(result.moduleId);
    else if (result.status === "blocked") blocked.push(result.moduleId);
    else if (result.status === "success") success += 1;
    else if (result.status === "skipped") skipped += 1;
  }

  const memory = dagRun?.memoryRevisit ?? {};
  memoryCalls = Number.isFinite(Number(memory.totalCalls)) ? Number(memory.totalCalls) : 0;
  memoryHits = Number.isFinite(Number(memory.hitsUsed)) ? Number(memory.hitsUsed) : 0;
  const candidates = memory?.candidatesLoadedBySource ?? {};
  const selected = memory?.selectedBySource ?? {};
  const skippedReasons = memory?.skippedByReason ?? {};
  memoryCandidatesLoaded =
    (Number(candidates.semanticMemory) || 0) +
    (Number(candidates.replayMemory) || 0) +
    (Number(candidates.artifactContract) || 0);
  memorySelectedPreview = Object.entries(selected)
    .filter(([, value]) => Number(value) > 0)
    .map(([key, value]) => `${key}:${Number(value)}`)
    .join(",");
  memorySkippedPreview = Object.entries(skippedReasons)
    .filter(([, value]) => Number(value) > 0)
    .map(([key, value]) => `${key}:${Number(value)}`)
    .join(",");
}

if (dagManifestPath && fs.existsSync(dagManifestPath)) {
  const manifest = JSON.parse(fs.readFileSync(dagManifestPath, "utf8"));
  const modules = Array.isArray(manifest.modules) ? manifest.modules : [];
  manifestModules = modules
    .map((module) => String(module?.id ?? ""))
    .filter((moduleId) => moduleId.length > 0);

  const levelCounts = new Map();
  const moduleLevel = new Map();
  for (const module of modules) {
    const moduleId = String(module?.id ?? "");
    const levelRaw = Number(module?.level ?? 0);
    const level = Number.isFinite(levelRaw) ? levelRaw : 0;
    if (moduleId) moduleLevel.set(moduleId, level);
    levelCounts.set(level, (levelCounts.get(level) ?? 0) + 1);
  }
  const sortedLevels = Array.from(levelCounts.keys()).sort((a, b) => a - b);
  const widths = sortedLevels.map((level) => levelCounts.get(level) ?? 0);
  if (widths.length > 0) {
    levelWidthsPreview = widths.length <= 12
      ? widths.join("->")
      : `${widths.slice(0, 12).join("->")}->...`;
    startParallel = widths[0] ?? 0;
    maxParallel = Math.max(...widths);
  }

  const levelEdges = new Map();
  for (const module of modules) {
    const targetId = String(module?.id ?? "");
    const targetLevel = moduleLevel.get(targetId);
    const deps = Array.isArray(module?.dependsOn) ? module.dependsOn : [];
    if (!targetId || targetLevel === undefined) continue;
    for (const dep of deps) {
      const depId = String(dep ?? "");
      const depLevel = moduleLevel.get(depId);
      if (depLevel === undefined) continue;
      const key = `${depLevel}->${targetLevel}`;
      levelEdges.set(key, (levelEdges.get(key) ?? 0) + 1);
    }
  }
  const sortedEdgeEntries = Array.from(levelEdges.entries()).sort((a, b) => {
    const [fromA, toA] = a[0].split("->").map((value) => Number(value));
    const [fromB, toB] = b[0].split("->").map((value) => Number(value));
    if (fromA !== fromB) return fromA - fromB;
    return toA - toB;
  });
  if (sortedEdgeEntries.length > 0) {
    const edgeTokens = sortedEdgeEntries.map(([key, count]) => `${key}:${count}`);
    levelEdgesPreview = edgeTokens.length <= 12
      ? edgeTokens.join(",")
      : `${edgeTokens.slice(0, 12).join(",")},...`;
  }
}

const done = dagStatus === "success" && failed.length === 0 && blocked.length === 0;
const taskCount = summary.synthesizedTaskCount ?? 0;
const moduleOrder = manifestModules.length > 0
  ? manifestModules
  : results
      .map((result) => String(result?.moduleId ?? ""))
      .filter((moduleId) => moduleId.length > 0);
const statusByModule = new Map();
for (const result of results) {
  const moduleId = String(result?.moduleId ?? "");
  if (!moduleId) continue;
  statusByModule.set(moduleId, String(result?.status ?? "unknown"));
}
const statusSequence = moduleOrder.map((moduleId) => statusByModule.get(moduleId) ?? "pending");
const totalModules = moduleOrder.length;
const firstNonSuccessIndex = statusSequence.findIndex((status) => status !== "success");
const cursorStep = totalModules === 0
  ? 0
  : firstNonSuccessIndex === -1
    ? totalModules
    : firstNonSuccessIndex + 1;
const cursorModule = firstNonSuccessIndex === -1 ? "" : moduleOrder[firstNonSuccessIndex] ?? "";
const statusToken = (status) => {
  if (status === "success") return "S";
  if (status === "failed") return "F";
  if (status === "blocked") return "B";
  if (status === "skipped") return "K";
  if (status === "pending") return "P";
  return "U";
};
const flowTokens = statusSequence.map((status, index) => `${index + 1}:${statusToken(status)}`);
const flowPreview = flowTokens.length <= 12
  ? flowTokens.join(">")
  : `${flowTokens.slice(0, 12).join(">")}>...`;

process.stdout.write(
  [
    done ? "1" : "0",
    dagStatus,
    failed.join(","),
    blocked.join(","),
    String(success),
    String(skipped),
    String(taskCount),
    String(cursorStep),
    String(totalModules),
    cursorModule,
    flowPreview,
    levelWidthsPreview,
    String(startParallel),
    String(maxParallel),
    levelEdgesPreview,
    String(memoryCalls),
    String(memoryHits),
    String(memoryCandidatesLoaded),
    String(resumedModules),
    memorySelectedPreview || "none",
    memorySkippedPreview || "none",
  ].join("\u001f"),
);
NODE
  )"

  IFS=$'\x1f' read -r DONE LAST_DAG_STATUS LAST_FAILED LAST_BLOCKED LAST_SUCCESS LAST_SKIPPED LAST_TASKS LAST_CURSOR_STEP LAST_TOTAL_MODULES LAST_CURSOR_MODULE LAST_FLOW_PREVIEW LAST_LEVEL_WIDTHS LAST_START_PARALLEL LAST_MAX_PARALLEL LAST_LEVEL_EDGES LAST_MEMORY_CALLS LAST_MEMORY_HITS LAST_MEMORY_CANDIDATES LAST_RESUMED LAST_MEMORY_SELECTED LAST_MEMORY_SKIPPED <<<"$STATUS_LINE"

  CURRENT_FAILURE_SIGNATURE="${LAST_FAILED}|${LAST_BLOCKED}|${LAST_CURSOR_STEP}"
  if [[ -n "$LAST_FAILED" || -n "$LAST_BLOCKED" ]]; then
    if [[ "$CURRENT_FAILURE_SIGNATURE" == "$PREV_FAILURE_SIGNATURE" ]]; then
      SAME_FAILURE_STREAK=$((SAME_FAILURE_STREAK + 1))
    else
      SAME_FAILURE_STREAK=1
      PREV_FAILURE_SIGNATURE="$CURRENT_FAILURE_SIGNATURE"
    fi
  else
    SAME_FAILURE_STREAK=0
    PREV_FAILURE_SIGNATURE=""
  fi

  echo "    dagStatus=$LAST_DAG_STATUS tasks=$LAST_TASKS success=$LAST_SUCCESS failed=${LAST_FAILED:-none} blocked=${LAST_BLOCKED:-none}"
  if [[ "${LAST_TOTAL_MODULES:-0}" =~ ^[0-9]+$ ]] && [[ "$LAST_TOTAL_MODULES" -gt 0 ]]; then
    NEXT_MODULE="${LAST_CURSOR_MODULE:-done}"
    echo "    progress=${LAST_FLOW_PREVIEW:-none} cursor=${LAST_CURSOR_STEP}/${LAST_TOTAL_MODULES} next=$NEXT_MODULE"
    echo "    topology=${LAST_TOTAL_MODULES} across levels (${LAST_LEVEL_WIDTHS:-unknown}) startParallel=${LAST_START_PARALLEL:-0} maxParallel=${LAST_MAX_PARALLEL:-0} edges=${LAST_LEVEL_EDGES:-none}"
    echo "    memory=calls=${LAST_MEMORY_CALLS:-0} hits=${LAST_MEMORY_HITS:-0} loaded=${LAST_MEMORY_CANDIDATES:-0} resumed=${LAST_RESUMED:-0} selected=${LAST_MEMORY_SELECTED:-none} skipped=${LAST_MEMORY_SKIPPED:-none}"
  else
    echo "    progress=none cursor=0/0 next=unknown"
  fi
  if [[ "$SAME_FAILURE_STREAK" -ge 2 ]]; then
    echo "    note=stuck repeatFailureStreak=$SAME_FAILURE_STREAK at step ${LAST_CURSOR_STEP:-0} (${LAST_CURSOR_MODULE:-unknown})"
  fi

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

if [[ "$AUTO_COMMIT" == "true" ]]; then
  if ! git -C "$WORKSPACE_ROOT_ABS" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "ERROR: --commit requested but '$WORKSPACE_ROOT_ABS' is not a git worktree." >&2
    exit 3
  fi

  git -C "$WORKSPACE_ROOT_ABS" add -A

  if git -C "$WORKSPACE_ROOT_ABS" diff --cached --quiet; then
    echo "No staged changes after successful run; skipping commit."
  else
    RECIPE_LABEL="${RECIPE_ID:-$(basename "${RECIPE_FILE:-recipe}")}"
    COMMIT_MESSAGE="orchestrator: ${RECIPE_LABEL} until-done success"
    git -C "$WORKSPACE_ROOT_ABS" commit -m "$COMMIT_MESSAGE"
    COMMIT_SHA="$(git -C "$WORKSPACE_ROOT_ABS" rev-parse --short HEAD)"
    echo "Created commit $COMMIT_SHA in $WORKSPACE_ROOT_ABS"
  fi
fi
