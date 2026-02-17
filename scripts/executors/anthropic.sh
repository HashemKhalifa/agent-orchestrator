#!/usr/bin/env bash
set -euo pipefail

MODULE_ID="${1:-}"
TITLE="${2:-}"
PART_FILE="${3:-}"
REQUEST_PATH="${4:-}"

if [[ -z "$MODULE_ID" || -z "$PART_FILE" ]]; then
  echo "usage: anthropic.sh <moduleId> <title> <partFile> <requestPath>" >&2
  exit 2
fi

ANTHROPIC_CMD="${ORCHESTRATOR_ANTHROPIC_EXECUTABLE:-claude -p}"
PROMPT=$(cat <<PROMPT_EOF
DAG module: $MODULE_ID
Title: $TITLE
Request path: $REQUEST_PATH
Part file: $PART_FILE
Execute safely and include validation evidence.
PROMPT_EOF
)

# shellcheck disable=SC2086
$ANTHROPIC_CMD "$PROMPT"
