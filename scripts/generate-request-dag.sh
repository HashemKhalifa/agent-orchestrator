#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

REQUEST_PATH="${1:-request.md}"

npm --prefix packages/orchestrator-standalone run cli -- dag-compile --request "$REQUEST_PATH" "${@:2}"
