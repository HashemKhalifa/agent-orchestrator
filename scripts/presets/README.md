# Migration Presets

Preset files let you run repeatable orchestration workflows with a stable flag set.

Use the launcher:

```bash
./scripts/run-migration-preset.sh --list
./scripts/run-migration-preset.sh react19-v2-dryrun --workspace-root /abs/path/to/repo
```

The launcher is `pnpm`-first:
- If `ORCHESTRATOR_PM` is not set, it defaults to `pnpm`.
- You can still override with `ORCHESTRATOR_PM=npm` or `ORCHESTRATOR_PM=yarn`.

## Available presets

- `react19-v2-dryrun`
- `react19-v2-apply`
- `jest-to-vitest-v2-dryrun`
- `webpack-to-rsbuild-v2-dryrun`
- `webpack-to-rolldown-v2-dryrun`
- `webpack-to-rolldown-v2-apply`
- `webpack-to-rolldown-pwa-v2-dryrun`
- `webpack-to-rolldown-pwa-v2-apply`
- `mcp-server-ops-closeout-v2-dryrun`
- `mcp-server-ops-closeout-v2-apply`

## Override defaults

All additional flags are forwarded to `scripts/run-bot-request-until-done.sh`:

```bash
./scripts/run-migration-preset.sh react19-v2-dryrun \
  --workspace-root /abs/path/to/repo \
  --max-iterations 3 \
  --provider-timeout-ms 240000
```

## Adding a new preset

1. Create `scripts/presets/<name>.preset.sh`.
2. Define `goal_type`, and either `recipe_id` or `recipe_file`.
3. Provide `default_args=(...)` as a bash array.
4. Run with `./scripts/run-migration-preset.sh <name> --workspace-root <repo>`.
