#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRESETS_DIR="$SCRIPT_DIR/presets"
UNTIL_DONE_SCRIPT="$SCRIPT_DIR/run-bot-request-until-done.sh"

usage() {
  cat <<'USAGE'
run-migration-preset.sh

Usage:
  ./scripts/run-migration-preset.sh --list
  ./scripts/run-migration-preset.sh <preset-name> --workspace-root <abs-path> [options...]

Options:
  --list                    List available preset names and descriptions
  --workspace-root <path>   Target repository root (required unless preset provides one)
  --autonomy-dir <path>     Override output directory (default: generated/orchestration/<preset>-<timestamp>)
  --run-id <id>             Optional run id override forwarded to until-done
  --help                    Show this help

All other flags are passed directly to run-bot-request-until-done.sh.

Examples:
  ./scripts/run-migration-preset.sh react19-v2-dryrun \
    --workspace-root /abs/path/to/repo

  ./scripts/run-migration-preset.sh jest-to-vitest-v2-dryrun \
    --workspace-root /abs/path/to/repo \
    --max-iterations 3 --max-parallel 2
USAGE
}

list_presets() {
  if [[ ! -d "$PRESETS_DIR" ]]; then
    echo "No presets directory found at $PRESETS_DIR"
    return 0
  fi

  local preset_file
  while IFS= read -r preset_file; do
    local preset_name=""
    local description=""
    # shellcheck disable=SC1090
    source "$preset_file"
    local basename
    basename="$(basename "$preset_file")"
    local slug="${basename%.preset.sh}"
    local name="${preset_name:-$slug}"
    local desc="${description:-No description}"
    printf '%-32s %s\n' "$name" "$desc"
  done < <(find "$PRESETS_DIR" -maxdepth 1 -type f -name '*.preset.sh' | sort)
}

contains_flag() {
  local needle="$1"
  shift
  local value
  for value in "$@"; do
    if [[ "$value" == "$needle" ]]; then
      return 0
    fi
  done
  return 1
}

if [[ $# -eq 0 ]]; then
  usage
  exit 1
fi

case "${1:-}" in
  --help|-h)
    usage
    exit 0
    ;;
  --list)
    list_presets
    exit 0
    ;;
esac

if [[ ! -x "$UNTIL_DONE_SCRIPT" ]]; then
  echo "ERROR: missing executable $UNTIL_DONE_SCRIPT" >&2
  exit 1
fi

preset_slug="${1:-}"
shift

preset_path="$PRESETS_DIR/${preset_slug}.preset.sh"
if [[ ! -f "$preset_path" ]]; then
  echo "ERROR: preset '$preset_slug' not found at $preset_path" >&2
  echo "Use --list to see available presets." >&2
  exit 1
fi

preset_name=""
description=""
goal_type=""
recipe_id=""
recipe_file=""
default_workspace_root=""
default_autonomy_dir=""
declare -a default_args=()

# shellcheck disable=SC1090
source "$preset_path"

if [[ -z "${goal_type:-}" ]]; then
  echo "ERROR: preset '$preset_slug' must define goal_type" >&2
  exit 1
fi

if [[ -z "${recipe_id:-}" && -z "${recipe_file:-}" ]]; then
  echo "ERROR: preset '$preset_slug' must define recipe_id or recipe_file" >&2
  exit 1
fi

workspace_root=""
autonomy_dir=""
run_id=""
declare -a passthrough_args=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --workspace-root)
      workspace_root="${2:-}"
      shift 2
      ;;
    --autonomy-dir)
      autonomy_dir="${2:-}"
      shift 2
      ;;
    --run-id)
      run_id="${2:-}"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    --)
      shift
      passthrough_args+=("$@")
      break
      ;;
    *)
      passthrough_args+=("$1")
      shift
      ;;
  esac
done

if [[ -z "$workspace_root" ]]; then
  workspace_root="${default_workspace_root:-}"
fi

if [[ -z "$workspace_root" ]]; then
  echo "ERROR: --workspace-root is required for preset '$preset_slug'" >&2
  exit 1
fi

if [[ -z "$autonomy_dir" ]]; then
  if [[ -n "${default_autonomy_dir:-}" ]]; then
    autonomy_dir="$default_autonomy_dir"
  else
    timestamp="$(date +%Y%m%d-%H%M%S)"
    autonomy_dir="generated/orchestration/${preset_slug}-${timestamp}"
  fi
fi

if [[ -z "${ORCHESTRATOR_PM:-}" ]]; then
  export ORCHESTRATOR_PM="pnpm"
fi

cmd=(
  bash "$UNTIL_DONE_SCRIPT"
  --goal-type "$goal_type"
  --workspace-root "$workspace_root"
  --autonomy-dir "$autonomy_dir"
)

if [[ -n "${recipe_id:-}" ]]; then
  cmd+=(--recipe-id "$recipe_id")
fi
if [[ -n "${recipe_file:-}" ]]; then
  cmd+=(--recipe-file "$recipe_file")
fi
if [[ -n "$run_id" ]]; then
  cmd+=(--run-id "$run_id")
fi

if [[ -n "${default_args+set}" && ${#default_args[@]} -gt 0 ]]; then
  cmd+=("${default_args[@]}")
fi

json_flag_inputs=()
if [[ -n "${default_args+set}" && ${#default_args[@]} -gt 0 ]]; then
  json_flag_inputs+=("${default_args[@]}")
fi
if [[ -n "${passthrough_args+set}" && ${#passthrough_args[@]} -gt 0 ]]; then
  json_flag_inputs+=("${passthrough_args[@]}")
fi

if ! contains_flag "--json-out" "${json_flag_inputs[@]}"; then
  cmd+=(--json-out "$autonomy_dir/until-done-summary.json")
fi

if [[ -n "${passthrough_args+set}" && ${#passthrough_args[@]} -gt 0 ]]; then
  cmd+=("${passthrough_args[@]}")
fi

echo "Preset: ${preset_name:-$preset_slug}"
echo "Description: ${description:-No description}"
echo "Workspace root: $workspace_root"
echo "Autonomy dir: $autonomy_dir"
echo "Package manager: ${ORCHESTRATOR_PM}"
echo "Executing:"
printf '  %q' "${cmd[@]}"
printf '\n'

exec "${cmd[@]}"
