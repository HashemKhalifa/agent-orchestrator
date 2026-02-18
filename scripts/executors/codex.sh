#!/usr/bin/env bash
set -euo pipefail

MODULE_ID="${1:-}"
TITLE="${2:-}"
PART_FILE="${3:-}"
REQUEST_PATH="${4:-}"

if [[ -z "$MODULE_ID" || -z "$PART_FILE" ]]; then
  echo "usage: codex.sh <moduleId> <title> <partFile> <requestPath>" >&2
  exit 2
fi

CODEX_CMD="${ORCHESTRATOR_CODEX_EXECUTABLE:-codex exec --full-auto}"
PROMPT=$(cat <<PROMPT_EOF
DAG module: $MODULE_ID
Title: $TITLE
Request path: $REQUEST_PATH
Part file: $PART_FILE
Execute the requested migration safely. Include commands and validation evidence.
PROMPT_EOF
)

STDOUT_FILE="$(mktemp)"
STDERR_FILE="$(mktemp)"
cleanup() {
  rm -f "$STDOUT_FILE" "$STDERR_FILE"
}
trap cleanup EXIT

set +e
# shellcheck disable=SC2086
$CODEX_CMD "$PROMPT" >"$STDOUT_FILE" 2>"$STDERR_FILE"
STATUS="$?"
set -e

cat "$STDOUT_FILE"
cat "$STDERR_FILE" >&2
bash "$(dirname "$0")/emit-token-receipt.sh" "codex" "$STDOUT_FILE" "$STDERR_FILE" || true

exit "$STATUS"
