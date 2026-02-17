#!/usr/bin/env bash
set -euo pipefail

MODULE_ID="${1:-}"
TITLE="${2:-}"
PART_FILE="${3:-}"
REQUEST_PATH="${4:-}"

if [[ -z "$MODULE_ID" || -z "$PART_FILE" ]]; then
  echo "usage: openai.sh <moduleId> <title> <partFile> <requestPath>" >&2
  exit 2
fi

OPENAI_CMD="${ORCHESTRATOR_OPENAI_EXECUTABLE:-codex exec --full-auto}"
PROMPT=$(cat <<PROMPT_EOF
DAG module: $MODULE_ID
Title: $TITLE
Request path: $REQUEST_PATH
Part file: $PART_FILE
Execute safely and include validation evidence.
PROMPT_EOF
)

# shellcheck disable=SC2086
$OPENAI_CMD "$PROMPT"
