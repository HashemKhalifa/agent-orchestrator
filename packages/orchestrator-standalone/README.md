# Orchestrator Standalone

Standalone recipe-driven orchestration engine for migration and refactor workflows.

## Goals

- Reusable across repositories via package import or CLI.
- Supports multiple use cases (build migration, dependency upgrades, CI/test refactors).
- Deep discovery with local workspace analysis + internet evidence from docs/changelogs.
- Strict blocker mode for unresolved breaking/memory/performance risks.

## Commands

```bash
# List built-in recipes
npm --prefix packages/orchestrator-standalone run cli -- recipes

# Discovery only
npm --prefix packages/orchestrator-standalone run cli -- discover --recipe-id webpack-to-rsbuild-incremental

# Execute one orchestration cycle (discover -> plan -> validate -> execute)
npm --prefix packages/orchestrator-standalone run cli -- cycle \
  --goal-type build_migration \
  --recipe-id webpack-to-rsbuild-incremental \
  --mode dry-run

# Check run state
npm --prefix packages/orchestrator-standalone run cli -- status --run-id <run-id>
```

## Built-in Recipes (v1)

- `webpack-to-rsbuild-incremental`
- `react18-to-react19`
- `jest-to-vitest`
- `ci-node-build-test-modernization`

## Run Artifacts

Default runs directory:

`generated/orchestration/standalone/runs/<run-id>/`

Artifacts per cycle:

- `plan-*.json`
- `validation-*.json`
- `execution-*.json`
- `cycle-*.json`
- `state.json`

## Risk Gates

`strict_blockers` mode blocks apply/progress when unresolved high/critical risks exist, including:

- breaking changes
- memory leak indicators
- performance regressions
- missing primary-source evidence

## Notes

- Existing MCP and legacy orchestration flows are unchanged by default.
- This package is opt-in via CLI invocation.
