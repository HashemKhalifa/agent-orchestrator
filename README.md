# orchestrator-core

Standalone, recipe-driven orchestration engine for cross-repo migrations and refactors.

This repo packages a reusable orchestration core with deep discovery, strict risk gating, and loop execution.

## Structure

- `packages/orchestrator-standalone` - core package (spec, adapters, kernel, recipes, CLI)
- `scripts/run-standalone-orchestrator-until-done.sh` - run-until-done controller
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
