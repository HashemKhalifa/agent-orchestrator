#!/usr/bin/env bash

preset_name="jest-to-vitest-v2-dryrun"
description="Jest -> Vitest migration in graph v2 dry-run with critic, repair loop, and auto-skills"
goal_type="test_runner_migration"
recipe_id="jest-to-vitest"

default_args=(
  --graph-mode v2
  --provider-preset codex-timeboxed
  --provider-timeout-ms 180000
  --command-timeout-ms 300000
  --analyze-timeout-ms 45000
  --apply-mode dry-run
  --enable-critic
  --enable-repair-loop
  --bootstrap-workspace true
  --memory-revisit false
  --rag-auto-refine false
  --max-parallel 1
  --max-iterations 2
  --max-tasks 18
  --max-repair-attempts 1
  --max-total-attempts 0
  --sleep-seconds 1
  --auto-skills apply
)
