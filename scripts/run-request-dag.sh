#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

MANIFEST_PATH="${1:-generated/orchestration/dag/manifest.json}"

bash scripts/run-orchestrator-cli.sh dag-run --manifest "$MANIFEST_PATH" "${@:2}"
