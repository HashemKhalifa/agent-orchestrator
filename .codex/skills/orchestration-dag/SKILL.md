---
name: orchestration-dag
description: Compile large requirement documents into DAG manifests using unpack split strategies, then run modules with dependency-aware execution and retry-safe reporting.
---

# Orchestration DAG

Use this skill when the user asks to split a large request and execute it as dependency-aware modules.

## Workflow

1. Compile DAG:

```bash
npm --prefix packages/orchestrator-standalone run cli -- dag-compile --request <path>
```

2. Inspect manifest and parts:
- `generated/orchestration/dag/manifest.json`
- `generated/orchestration/dag/parts/*.md`

3. Run DAG:

```bash
npm --prefix packages/orchestrator-standalone run cli -- dag-run --manifest generated/orchestration/dag/manifest.json --executor "codex exec --full-auto \"Process {partFile}\""
```

## Notes

- `unpack.config.ts` is auto-used when present.
- Fallback splitter uses markdown headings.
- Dependency modes: `staged`, `sequential`, `parallel`.
- Runner is non-destructive by default unless executor command performs mutations.
