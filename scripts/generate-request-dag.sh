#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

REQUEST_PATH="${1:-request.md}"

bash scripts/run-orchestrator-cli.sh dag-compile --request "$REQUEST_PATH" "${@:2}"
