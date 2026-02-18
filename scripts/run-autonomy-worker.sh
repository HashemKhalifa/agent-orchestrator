#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

WORKSPACE_ROOT_INPUT="${WORKSPACE_ROOT:-$ROOT_DIR}"
WORKER_STATE_PATH_INPUT="${WORKER_STATE_PATH:-generated/orchestration/worker/state.json}"

resolve_path() {
  local value="$1"
  if [[ "$value" = /* ]]; then
    printf '%s\n' "$value"
  else
    printf '%s\n' "$ROOT_DIR/$value"
  fi
}

WORKSPACE_ROOT="$(resolve_path "$WORKSPACE_ROOT_INPUT")"
WORKER_STATE_PATH="$(resolve_path "$WORKER_STATE_PATH_INPUT")"

print_help() {
  cat <<'USAGE'
run-autonomy-worker.sh

Usage:
  ./scripts/run-autonomy-worker.sh [worker-run args...]

Environment:
  WORKSPACE_ROOT      Workspace root for queued jobs (default: repo root)
  WORKER_STATE_PATH   Worker queue state file path (default: generated/orchestration/worker/state.json)

Examples:
  ./scripts/run-autonomy-worker.sh --stop-when-empty
  ./scripts/run-autonomy-worker.sh --poll-interval-ms 2000 --stale-heartbeat-ms 180000
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  print_help
  exit 0
fi

HAS_WORKSPACE_ROOT=false
HAS_WORKER_STATE=false
ARGS=("$@")
NORMALIZED_ARGS=()

for ((i=0; i<${#ARGS[@]}; i++)); do
  token="${ARGS[$i]}"
  NORMALIZED_ARGS+=("$token")

  if [[ "$token" == "--workspace-root" || "$token" == "--worker-state-path" || "$token" == "--json-out" ]]; then
    if (( i + 1 >= ${#ARGS[@]} )); then
      echo "ERROR: $token requires a value." >&2
      exit 1
    fi
    i=$((i + 1))
    NORMALIZED_ARGS+=("$(resolve_path "${ARGS[$i]}")")
  fi
done

ARGS=("${NORMALIZED_ARGS[@]}")

for ((i=0; i<${#ARGS[@]}; i++)); do
  if [[ "${ARGS[$i]}" == "--workspace-root" ]]; then
    HAS_WORKSPACE_ROOT=true
  elif [[ "${ARGS[$i]}" == "--worker-state-path" ]]; then
    HAS_WORKER_STATE=true
  fi
done

CMD=(bash scripts/run-orchestrator-cli.sh worker-run)
if [[ "$HAS_WORKSPACE_ROOT" == "false" ]]; then
  CMD+=(--workspace-root "$WORKSPACE_ROOT")
fi
if [[ "$HAS_WORKER_STATE" == "false" ]]; then
  CMD+=(--worker-state-path "$WORKER_STATE_PATH")
fi
CMD+=("${ARGS[@]}")

exec "${CMD[@]}"
