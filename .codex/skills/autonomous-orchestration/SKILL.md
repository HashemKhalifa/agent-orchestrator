---
name: autonomous-orchestration
description: Run end-to-end orchestration autonomously with discovery, RAG retrieval, DAG execution, and iterative retries until all modules are complete.
---

# Autonomous Orchestration

Use this skill when you need the orchestrator to discover tasks, execute implementation modules, validate outcomes, and keep looping until done.

## Workflow

1. Start autonomous loop:

```bash
bash scripts/run-bot-request-until-done.sh \
  --goal-type <goal-type> \
  --recipe-id <recipe-id> \
  --executor-profile codex-safe \
  --apply-mode dry-run
```

2. Inspect artifacts:
- `generated/orchestration/autonomy/discovery.json`
- `generated/orchestration/autonomy/rag/index.json`
- `generated/orchestration/autonomy/request.generated.md`
- `generated/orchestration/autonomy/dag/manifest.json`
- `generated/orchestration/autonomy/dag/run-summary.json`

3. Promote to apply mode only after dry-run is stable:

```bash
bash scripts/run-bot-request-until-done.sh \
  --goal-type <goal-type> \
  --recipe-id <recipe-id> \
  --executor-profile codex-safe \
  --apply-mode apply \
  --apply-guard-token ALLOW_APPLY
```

## Safety

- Keep `strict_blockers` risk mode unless explicitly overridden.
- Use `--auto-skills suggest` first, then `apply` after review.
- Persist summaries and failed module IDs for deterministic retries.
