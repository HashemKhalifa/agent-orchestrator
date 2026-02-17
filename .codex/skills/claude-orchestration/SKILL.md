---
name: claude-orchestration
description: Run DAG orchestration with Claude as the execution provider using safe prompts, dependency-aware module execution, and apply guards.
---

# Claude Orchestration

Use this skill when you want the orchestration DAG to execute with Claude instead of Codex.

If you use Claude subscription mode, authenticate once in Claude CLI (logged-in session), then use the preset below.

## Workflow

```bash
npm --prefix packages/orchestrator-standalone run cli -- dag-run \
  --manifest generated/orchestration/dag/manifest.json \
  --provider-preset claude-subscription \
  --apply-mode dry-run
```

For custom provider commands:

```bash
npm --prefix packages/orchestrator-standalone run cli -- dag-run \
  --manifest generated/orchestration/dag/manifest.json \
  --executor-provider custom \
  --provider-template 'bash scripts/executors/claude.sh {moduleId} {title} {partFile} {requestPath}'
```

## Apply Safety

- Use `--apply-guard-token ALLOW_APPLY` explicitly.
- Provide approval files in `generated/orchestration/approvals/wave-<n>.approved.json`.
- Provide evidence file and rollback check command before apply.
