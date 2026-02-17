#!/usr/bin/env bash
# Run standalone orchestration cycles until completion criteria are met.
# Default: dry-run mode with strict retry/pause behavior on failed waves.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

GOAL_TYPE=""
RECIPE_ID=""
RECIPE_FILE=""
MODE="dry-run"
WORKSPACE_ROOT="."
RUNS_DIR="generated/orchestration/standalone/runs"
MAX_CYCLES=30
MAX_RETRIES_PER_WAVE=3
BACKOFF_SECONDS=60
SLEEP_SECONDS=3
SOURCE_POLICY="primary_plus_curated_secondary"
RISK_GATE_MODE="strict_blockers"
WAVE_STRATEGY=""
REQUIRE_TDD_TESTS=true
RUN_ID=""
JSON_OUT=""
APPROVALS_DIR=""
REQUIRE_WAVE_APPROVAL=true
EVIDENCE_FILE=""
REQUIRE_EVIDENCE_FILE=true
ROLLBACK_CHECK_COMMAND=""

CURATED_DOMAINS=()

print_help() {
  cat <<'USAGE'
run-standalone-orchestrator-until-done.sh

Usage:
  ./scripts/run-standalone-orchestrator-until-done.sh --goal-type <type> --recipe-id <id> [options]
  ./scripts/run-standalone-orchestrator-until-done.sh --goal-type <type> --recipe-file <path> [options]

Required:
  --goal-type <build_migration|dependency_upgrade|ci_refactor|test_runner_migration|custom>
  --recipe-id <recipe-id> | --recipe-file <path>

Options:
  --mode <dry-run|apply>         Execution mode (default: dry-run)
  --workspace-root <path>        Target repo root (default: .)
  --runs-dir <path>              Runs output dir (default: generated/orchestration/standalone/runs)
  --max-cycles <n>               Max loop cycles (default: 30)
  --max-retries-per-wave <n>     Retry cap per wave (default: 3)
  --backoff-seconds <n>          Sleep after failed wave before retry (default: 60)
  --sleep-seconds <n>            Sleep between successful non-final cycles (default: 3)
  --source-policy <policy>       primary_only|primary_plus_curated_secondary|open_web
  --risk-gate-mode <mode>        strict_blockers|warn_then_apply|manual_override
  --wave-strategy <strategy>     incremental_dual_build|pilot_wave|big_bang|custom
  --curated-domain <domain>      Curated secondary allowlist domain (repeatable)
  --no-require-tdd-tests         Disable mandatory test-tool gate
  --run-id <id>                  Resume/continue a specific run id
  --approvals-dir <path>         Apply approvals dir
  --no-require-wave-approval     Disable apply wave approval requirement
  --evidence-file <path>         Apply evidence file path
  --no-require-evidence-file     Disable apply evidence requirement
  --rollback-check-command <cmd> Command that must pass before apply mode
  --json-out <path>              Final summary JSON output path
  -h, --help                     Show help
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
    --mode)
      MODE="${2:-}"
      shift 2
      ;;
    --workspace-root)
      WORKSPACE_ROOT="${2:-}"
      shift 2
      ;;
    --runs-dir)
      RUNS_DIR="${2:-}"
      shift 2
      ;;
    --max-cycles)
      MAX_CYCLES="${2:-}"
      shift 2
      ;;
    --max-retries-per-wave)
      MAX_RETRIES_PER_WAVE="${2:-}"
      shift 2
      ;;
    --backoff-seconds)
      BACKOFF_SECONDS="${2:-}"
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
    --curated-domain)
      CURATED_DOMAINS+=("${2:-}")
      shift 2
      ;;
    --no-require-tdd-tests)
      REQUIRE_TDD_TESTS=false
      shift
      ;;
    --run-id)
      RUN_ID="${2:-}"
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

if [[ -z "$GOAL_TYPE" ]]; then
  echo "ERROR: --goal-type is required" >&2
  exit 1
fi

if [[ -z "$RECIPE_ID" && -z "$RECIPE_FILE" ]]; then
  echo "ERROR: either --recipe-id or --recipe-file is required" >&2
  exit 1
fi

if [[ "$MODE" != "dry-run" && "$MODE" != "apply" ]]; then
  echo "ERROR: --mode must be dry-run or apply" >&2
  exit 1
fi

if ! [[ "$MAX_CYCLES" =~ ^[0-9]+$ ]] || [[ "$MAX_CYCLES" -lt 1 ]]; then
  echo "ERROR: --max-cycles must be >= 1" >&2
  exit 1
fi

if ! [[ "$MAX_RETRIES_PER_WAVE" =~ ^[0-9]+$ ]] || [[ "$MAX_RETRIES_PER_WAVE" -lt 1 ]]; then
  echo "ERROR: --max-retries-per-wave must be >= 1" >&2
  exit 1
fi

mkdir -p "$RUNS_DIR"

LAST_CYCLE_JSON=""
RETRY_STATE_FILE="$(mktemp /tmp/orchestrator-wave-retries-XXXXXX.json)"
printf '{}' > "$RETRY_STATE_FILE"

cleanup() {
  rm -f "$RETRY_STATE_FILE"
}
trap cleanup EXIT

bump_wave_retry_count() {
  local wave_id="$1"
  python3 - "$RETRY_STATE_FILE" "$wave_id" <<'PY'
import json
import sys
from pathlib import Path

state_path = Path(sys.argv[1])
wave_id = sys.argv[2]

data = {}
if state_path.exists():
    try:
        data = json.loads(state_path.read_text(encoding="utf-8"))
    except Exception:
        data = {}

current = int(data.get(wave_id, 0)) + 1
data[wave_id] = current
state_path.write_text(json.dumps(data), encoding="utf-8")
print(current)
PY
}

write_blocker_report() {
  local run_id="$1"
  local cycle_json="$2"
  local blocker_dir="$RUNS_DIR/$run_id/blockers"
  mkdir -p "$blocker_dir"
  local blocker_report="$blocker_dir/latest.md"

  python3 - "$cycle_json" "$blocker_report" <<'PY'
import json
import sys
from pathlib import Path

cycle_path = Path(sys.argv[1])
report_path = Path(sys.argv[2])

data = json.loads(cycle_path.read_text(encoding="utf-8"))
run_id = data.get("runId", "unknown")
execution = data.get("execution", {})
validation = data.get("validation", {})
state = data.get("state", {})
summary = data.get("summary", {})

lines = []
lines.append(f"# Orchestrator Blocker Report ({run_id})")
lines.append("")
lines.append(f"- Timestamp: {summary.get('timestamp', 'unknown')}")
lines.append(f"- Validation status: {validation.get('status', 'unknown')}")
lines.append(f"- Execution status: {execution.get('status', 'unknown')}")
lines.append(f"- Pending waves: {', '.join(execution.get('pendingWaves', [])) or 'none'}")
lines.append("")

issues = validation.get("issues", [])
if issues:
  lines.append("## Validation Issues")
  for issue in issues:
    sev = issue.get("severity", "unknown")
    msg = issue.get("message", "")
    code = issue.get("code", "")
    lines.append(f"- [{sev}] {code}: {msg}")
  lines.append("")

blockers = execution.get("blockerSummary", [])
if blockers:
  lines.append("## Execution Blockers")
  for item in blockers:
    lines.append(f"- {item}")
  lines.append("")

wave_result = execution.get("waveResult")
if wave_result:
  lines.append("## Last Wave Result")
  lines.append(f"- Wave: {wave_result.get('waveId', 'unknown')}")
  lines.append(f"- Status: {wave_result.get('status', 'unknown')}")
  notes = wave_result.get("notes", [])
  if notes:
    for note in notes:
      lines.append(f"- Note: {note}")
  lines.append("")

artifacts = summary.get("artifacts", {})
if artifacts:
  lines.append("## Artifact Paths")
  for key, value in artifacts.items():
    lines.append(f"- {key}: {value}")

report_path.write_text("\n".join(lines).strip() + "\n", encoding="utf-8")
print(str(report_path))
PY
}

for ((cycle=1; cycle<=MAX_CYCLES; cycle++)); do
  CYCLE_JSON_PATH="$(mktemp /tmp/orchestrator-cycle-XXXXXX)"

  CMD=(
    npm --prefix packages/orchestrator-standalone run cli --
    cycle
    --goal-type "$GOAL_TYPE"
    --workspace-root "$WORKSPACE_ROOT"
    --runs-dir "$RUNS_DIR"
    --mode "$MODE"
    --source-policy "$SOURCE_POLICY"
    --risk-gate-mode "$RISK_GATE_MODE"
    --json-out "$CYCLE_JSON_PATH"
  )

  if [[ -n "$RECIPE_ID" ]]; then
    CMD+=(--recipe-id "$RECIPE_ID")
  fi

  if [[ -n "$RECIPE_FILE" ]]; then
    CMD+=(--recipe-file "$RECIPE_FILE")
  fi

  if [[ -n "$RUN_ID" ]]; then
    CMD+=(--run-id "$RUN_ID")
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

  if [[ -n "$WAVE_STRATEGY" ]]; then
    CMD+=(--wave-strategy "$WAVE_STRATEGY")
  fi

  if [[ "$REQUIRE_TDD_TESTS" == "false" ]]; then
    CMD+=(--no-require-tdd-tests)
  fi

  if [[ ${#CURATED_DOMAINS[@]} -gt 0 ]]; then
    for domain in "${CURATED_DOMAINS[@]}"; do
      CMD+=(--curated-domain "$domain")
    done
  fi

  "${CMD[@]}" >/tmp/orchestrator-cycle-stdout.log

  PARSE_ENV_FILE="$(mktemp /tmp/orchestrator-parse-env-XXXXXX)"
  python3 - "$CYCLE_JSON_PATH" > "$PARSE_ENV_FILE" <<'PY'
import json
import sys
from pathlib import Path

data = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
run_id = data.get("runId", "")
execution = data.get("execution", {})
state = data.get("state", {})
wave_result = execution.get("waveResult") or {}
pending = execution.get("pendingWaves", [])
blockers = execution.get("blockerSummary", [])

def esc(value: str) -> str:
    return value.replace("\\\\", "\\\\\\\\").replace("\"", "\\\\\"")

def emit(name: str, value) -> None:
    print(f'{name}=\"{esc(str(value))}\"')

emit("PARSED_RUN_ID", run_id)
emit("DONE_FLAG", str(execution.get("done", False)).lower())
emit("EXEC_STATUS", execution.get("status", "unknown"))
emit("WAVE_ID", wave_result.get("waveId", ""))
emit("WAVE_STATUS", wave_result.get("status", ""))
emit("PENDING_COUNT", str(len(pending)))
emit("BLOCKER_COUNT", str(len(blockers)))
emit("STATE_STATUS", state.get("status", "unknown"))
PY

  # shellcheck source=/dev/null
  source "$PARSE_ENV_FILE"
  rm -f "$PARSE_ENV_FILE"

  if [[ -z "$RUN_ID" ]]; then
    RUN_ID="$PARSED_RUN_ID"
  fi

  LAST_CYCLE_JSON="$CYCLE_JSON_PATH"

  echo "cycle=$cycle run_id=$RUN_ID execution_status=$EXEC_STATUS state_status=$STATE_STATUS wave=$WAVE_ID wave_status=$WAVE_STATUS pending=$PENDING_COUNT blockers=$BLOCKER_COUNT"

  if [[ "$DONE_FLAG" == "true" ]]; then
    echo "DONE: all required gates passed and no pending waves."
    if [[ -n "$JSON_OUT" ]]; then
      mkdir -p "$(dirname "$JSON_OUT")"
      cp "$CYCLE_JSON_PATH" "$JSON_OUT"
    fi
    exit 0
  fi

  if [[ -n "$WAVE_ID" && "$WAVE_STATUS" == "failed" ]]; then
    CURRENT_RETRIES="$(bump_wave_retry_count "$WAVE_ID")"

    if [[ "$CURRENT_RETRIES" -gt "$MAX_RETRIES_PER_WAVE" ]]; then
      REPORT_PATH="$(write_blocker_report "$RUN_ID" "$CYCLE_JSON_PATH")"
      echo "PAUSED: wave '$WAVE_ID' exceeded retries ($MAX_RETRIES_PER_WAVE). Blocker report: $REPORT_PATH" >&2
      if [[ -n "$JSON_OUT" ]]; then
        mkdir -p "$(dirname "$JSON_OUT")"
        cp "$CYCLE_JSON_PATH" "$JSON_OUT"
      fi
      exit 1
    fi

    echo "wave '$WAVE_ID' failed; retry $CURRENT_RETRIES/$MAX_RETRIES_PER_WAVE after ${BACKOFF_SECONDS}s"
    sleep "$BACKOFF_SECONDS"
    continue
  fi

  if [[ "$EXEC_STATUS" == "blocked" && "$BLOCKER_COUNT" -gt 0 && -z "$WAVE_ID" ]]; then
    REPORT_PATH="$(write_blocker_report "$RUN_ID" "$CYCLE_JSON_PATH")"
    echo "PAUSED: validation/execution blockers with no active wave. Blocker report: $REPORT_PATH" >&2
    if [[ -n "$JSON_OUT" ]]; then
      mkdir -p "$(dirname "$JSON_OUT")"
      cp "$CYCLE_JSON_PATH" "$JSON_OUT"
    fi
    exit 1
  fi

  sleep "$SLEEP_SECONDS"
done

if [[ -n "$LAST_CYCLE_JSON" && -n "$RUN_ID" ]]; then
  REPORT_PATH="$(write_blocker_report "$RUN_ID" "$LAST_CYCLE_JSON")"
  echo "STOPPED: max cycles ($MAX_CYCLES) reached before completion. Blocker report: $REPORT_PATH" >&2
  if [[ -n "$JSON_OUT" ]]; then
    mkdir -p "$(dirname "$JSON_OUT")"
    cp "$LAST_CYCLE_JSON" "$JSON_OUT"
  fi
fi

exit 1
