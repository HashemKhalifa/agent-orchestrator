#!/usr/bin/env bash
set -euo pipefail

MODULE_ID="${1:-}"
TITLE="${2:-}"
PART_FILE="${3:-}"
REQUEST_PATH="${4:-}"

if [[ -z "$MODULE_ID" || -z "$PART_FILE" ]]; then
  echo "usage: claude.sh <moduleId> <title> <partFile> <requestPath>" >&2
  exit 2
fi

CLAUDE_CMD="${ORCHESTRATOR_CLAUDE_EXECUTABLE:-claude -p}"
PROMPT=$(cat <<PROMPT_EOF
DAG module: $MODULE_ID
Title: $TITLE
Request path: $REQUEST_PATH
Part file: $PART_FILE
Execute the requested migration safely. Include commands and validation evidence.
PROMPT_EOF
)

# shellcheck disable=SC2086
$CLAUDE_CMD "$PROMPT"
