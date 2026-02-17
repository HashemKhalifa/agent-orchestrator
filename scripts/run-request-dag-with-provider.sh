#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

PROVIDER_PRESET="codex"
MANIFEST_PATH="generated/orchestration/dag/manifest.json"
EXTRA_ARGS=()

print_help() {
  cat <<'USAGE'
run-request-dag-with-provider.sh

Usage:
  ./scripts/run-request-dag-with-provider.sh [options] [extra dag-run args]

Options:
  --provider-preset <codex|claude|claude-subscription|openai|anthropic>
  --manifest <path>              DAG manifest path (default: generated/orchestration/dag/manifest.json)
  --claude-subscription          Alias for --provider-preset claude-subscription
  -h, --help                     Show help

Examples:
  ./scripts/run-request-dag-with-provider.sh --provider-preset claude
  ./scripts/run-request-dag-with-provider.sh --provider-preset openai --dry-run
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --provider-preset)
      PROVIDER_PRESET="${2:-}"
      shift 2
      ;;
    --manifest)
      MANIFEST_PATH="${2:-}"
      shift 2
      ;;
    --claude-subscription)
      PROVIDER_PRESET="claude-subscription"
      shift
      ;;
    -h|--help)
      print_help
      exit 0
      ;;
    *)
      EXTRA_ARGS+=("$1")
      shift
      ;;
  esac
done

CMD=(
  npm --prefix packages/orchestrator-standalone run cli -- dag-run
  --manifest "$MANIFEST_PATH"
)

case "$PROVIDER_PRESET" in
  codex)
    CMD+=(--executor-profile codex-safe)
    ;;
  claude|claude-subscription)
    CMD+=(--executor-profile claude-safe)
    ;;
  openai)
    CMD+=(
      --executor-profile none
      --executor-provider custom
      --provider-template "bash scripts/executors/openai.sh {moduleId} {title} {partFile} {requestPath}"
    )
    ;;
  anthropic)
    CMD+=(
      --executor-profile none
      --executor-provider custom
      --provider-template "bash scripts/executors/anthropic.sh {moduleId} {title} {partFile} {requestPath}"
    )
    ;;
  *)
    echo "ERROR: unknown provider preset '$PROVIDER_PRESET'" >&2
    exit 1
    ;;
esac

CMD+=("${EXTRA_ARGS[@]}")
"${CMD[@]}"
