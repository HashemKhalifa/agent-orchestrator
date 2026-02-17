# orchestrator-core

Standalone, recipe-driven orchestration engine for cross-repo migrations and refactors.

This repo packages a reusable orchestration core with deep discovery, strict risk gating, and loop execution.

## Reuse In Another Repo

```bash
git clone git@github.com:HashemKhalifa/orchestrator-core.git tools/orchestrator-core
npm --prefix tools/orchestrator-core/packages/orchestrator-standalone install
npm --prefix tools/orchestrator-core/packages/orchestrator-standalone run cli -- recipes
```

You can also package `packages/orchestrator-standalone` and publish/install it as an internal npm package.

## Structure

- `packages/orchestrator-standalone` - core package (spec, adapters, kernel, recipes, CLI)
- `scripts/run-standalone-orchestrator-until-done.sh` - run-until-done controller
- `scripts/run-bot-request-until-done.sh` - autonomous discovery -> RAG -> DAG -> execute loop
- `unpack.config.ts` - request-splitting strategy config used by DAG compiler
- `.codex/skills` - reusable Codex skills (system + project skills)

## Quick start

```bash
npm --prefix packages/orchestrator-standalone install
npm --prefix packages/orchestrator-standalone run typecheck
npm --prefix packages/orchestrator-standalone run build
npm --prefix packages/orchestrator-standalone run cli -- recipes
```

Example one-cycle dry run:

```bash
npm --prefix packages/orchestrator-standalone run cli -- cycle \
  --goal-type dependency_upgrade \
  --recipe-id react18-to-react19 \
  --mode dry-run
```

Compile and run request DAG:

```bash
npm --prefix packages/orchestrator-standalone run cli -- dag-compile --request request.md
npm --prefix packages/orchestrator-standalone run cli -- dag-run \
  --manifest generated/orchestration/dag/manifest.json \
  --executor "codex exec --full-auto \"Process {partFile}\""
```

Autonomous end-to-end loop (recipe + RAG + DAG + execution + optional skill autogen):

```bash
bash scripts/run-bot-request-until-done.sh \
  --goal-type build_migration \
  --recipe-id webpack-to-rsbuild-incremental \
  --executor-profile codex-safe \
  --apply-mode dry-run
```

Claude-backed execution (provider abstraction):

```bash
bash scripts/run-bot-request-until-done.sh \
  --goal-type dependency_upgrade \
  --recipe-id react18-to-react19 \
  --executor-profile claude-safe \
  --apply-mode dry-run
```

Automate recipe authoring from discovery + run memory:

```bash
npm --prefix packages/orchestrator-standalone run cli -- recipe-generate \
  --goal-type test_runner_migration \
  --recipe-id autogen-jest-vitest \
  --recipe-output generated/orchestration/recipes/autogen-jest-vitest.json
```

Deterministic golden suite:

```bash
npm --prefix packages/orchestrator-standalone run cli -- eval-golden
```
