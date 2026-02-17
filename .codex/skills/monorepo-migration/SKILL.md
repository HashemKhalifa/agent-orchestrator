---
name: monorepo-migration
description: Drive large monorepo migrations with recipe-first orchestration, deep discovery from official docs/changelogs, and strict blocker gates for breaking changes, memory, and performance risks.
---

# Monorepo Migration

Use this skill for migrations like Webpack->Rsbuild, React 18->19, Jest->Vitest, and CI refactors.

## Workflow

1. Discovery:

```bash
npm --prefix packages/orchestrator-standalone run cli -- discover --recipe-id <recipe-id>
```

2. One cycle dry-run:

```bash
npm --prefix packages/orchestrator-standalone run cli -- cycle --goal-type <goal-type> --recipe-id <recipe-id> --mode dry-run
```

3. Until done loop:

```bash
bash scripts/run-standalone-orchestrator-until-done.sh --goal-type <goal-type> --recipe-id <recipe-id>
```

## Safety

- Keep `--mode dry-run` by default.
- Use `strict_blockers` for unresolved high/critical risk findings.
- Require test gates before apply.
- Persist blocker reports and iteration artifacts.
