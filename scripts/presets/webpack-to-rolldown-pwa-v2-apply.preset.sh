#!/usr/bin/env bash

preset_name="webpack-to-rolldown-pwa-v2-apply"
description="Webpack -> Rolldown PWA-first migration in graph v2 apply mode with critic, repair loop, and auto-skills"
goal_type="build_migration"
recipe_file="generated/orchestration/recipes/webpack-to-rolldown-pwa-wave.json"
default_workspace_root="/Users/khalifah/workspace/MMS/old-pva-withFederation_27_10/PR-HASHEM-REVIEW02"
default_autonomy_dir="generated/orchestration/autonomy-rolldown-pwa-v2-apply"

default_args=(
  --graph-mode v2
  --provider-preset codex-timeboxed
  --provider-timeout-ms 4500000
  --command-timeout-ms 6000000
  --analyze-timeout-ms 600000
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
  --max-iterations 3
  --max-tasks 26
  --max-repair-attempts 1
  --max-total-attempts 0
  --sleep-seconds 1
  --auto-skills apply
)
