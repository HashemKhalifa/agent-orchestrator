#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

PKG_DIR="packages/orchestrator-graph-ui"
PM="${ORCHESTRATOR_PM:-npm}"

if [[ "$PM" != "npm" && "$PM" != "pnpm" ]]; then
  echo "ERROR: ORCHESTRATOR_PM must be 'npm' or 'pnpm' (got '$PM')" >&2
  exit 1
fi

if [[ "$PM" == "pnpm" ]]; then
  if ! command -v pnpm >/dev/null 2>&1; then
    echo "ERROR: ORCHESTRATOR_PM=pnpm but pnpm is not installed." >&2
    exit 1
  fi
  if [[ ! -d "$PKG_DIR/node_modules" ]]; then
    pnpm --dir "$PKG_DIR" install
  fi
  exec pnpm --dir "$PKG_DIR" run dev "$@"
fi

if [[ ! -d "$PKG_DIR/node_modules" ]]; then
  npm --prefix "$PKG_DIR" install
fi

exec npm --prefix "$PKG_DIR" run dev -- "$@"
