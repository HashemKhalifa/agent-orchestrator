#!/usr/bin/env bash

preset_name="webpack-to-rolldown-v2-dryrun"
description="Webpack -> Rolldown Nx monorepo pilot in graph v2 dry-run with critic, repair loop, and auto-skills"
goal_type="build_migration"
recipe_file="generated/orchestration/recipes/webpack-to-rolldown-monorepo-pilot.json"
default_workspace_root="/Users/khalifah/workspace/MMS/old-pva-withFederation_27_10/PR-HASHEM-REVIEW02"
default_autonomy_dir="generated/orchestration/autonomy-rolldown-v2-dryrun"

default_args=(
  --graph-mode v2
  --provider-preset codex-timeboxed
  --provider-timeout-ms 900000
  --command-timeout-ms 1200000
  --analyze-timeout-ms 120000
  --apply-mode dry-run
  --enable-critic
  --enable-repair-loop
  --bootstrap-workspace true
  --memory-revisit false
  --rag-auto-refine false
  --source-policy primary_only
  --max-parallel 1
  --max-iterations 2
  --max-tasks 24
  --max-repair-attempts 1
  --max-total-attempts 0
  --sleep-seconds 1
  --auto-skills apply
)
