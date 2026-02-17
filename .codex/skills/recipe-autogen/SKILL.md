---
name: recipe-autogen
description: Generate and iterate orchestration recipes automatically from discovery artifacts and historical run memory.
---

# Recipe Autogen

Use this skill when a migration pattern is new or recurring and you want recipe creation to be automated.

## Workflow

1. Generate recipe JSON:

```bash
npm --prefix packages/orchestrator-standalone run cli -- recipe-generate \
  --goal-type build_migration \
  --recipe-id autogen-build-migration \
  --discovery-file generated/orchestration/autonomy/discovery.json \
  --recipe-output generated/orchestration/recipes/autogen-build-migration.json
```

2. Use generated recipe in cycle/auto-run:

```bash
npm --prefix packages/orchestrator-standalone run cli -- auto-run \
  --goal-type build_migration \
  --recipe-file generated/orchestration/recipes/autogen-build-migration.json \
  --executor-profile codex-safe \
  --apply-mode dry-run
```

3. Optional: enable inline recipe generation inside auto-run:

```bash
bash scripts/run-bot-request-until-done.sh \
  --goal-type build_migration \
  --recipe-id webpack-to-rsbuild-incremental \
  --auto-recipe \
  --auto-recipe-id autogen-webpack-rsbuild
```
