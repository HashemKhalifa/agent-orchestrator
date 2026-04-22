#!/usr/bin/env bash

preset_name="mcp-server-ops-closeout-v2-apply"
description="BOT MCP/server/ops closeout in graph v2 apply mode with critic, repair loop, and auto-skills"
goal_type="custom"
recipe_file="generated/orchestration/recipes/mcp-server-ops-closeout.json"
default_workspace_root="/Users/khalifah/workspace/H/BOT"
default_autonomy_dir="generated/orchestration/autonomy-mcp-server-ops-closeout-v2-apply"

default_args=(
  --graph-mode v2
  --provider-preset codex-timeboxed
  --provider-timeout-ms 900000
  --command-timeout-ms 900000
  --analyze-timeout-ms 120000
  --apply-mode apply
  --apply-guard-token ALLOW_APPLY
  --no-require-wave-approval
  --no-require-evidence-file
  --enable-critic
  --enable-repair-loop
  --bootstrap-workspace true
  --memory-revisit false
  --rag-auto-refine false
  --source-policy primary_only
  --max-parallel 1
  --max-iterations 4
  --max-tasks 18
  --max-repair-attempts 1
  --max-total-attempts 0
  --sleep-seconds 1
  --auto-skills apply
)
