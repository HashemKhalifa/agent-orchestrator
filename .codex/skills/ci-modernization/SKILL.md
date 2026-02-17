---
name: ci-modernization
description: Modernize Node build/test CI pipelines with recipe-guided discovery, staged changes, and deterministic validation.
---

# CI Modernization

Use this skill when updating CI workflows, caching strategy, and build/test orchestration.

## Workflow

```bash
bash scripts/run-bot-request-until-done.sh \
  --goal-type ci_refactor \
  --recipe-id ci-node-build-test-modernization \
  --executor-profile codex-safe \
  --apply-mode dry-run
```

After stable dry-runs, run guarded apply mode and keep rollback points for workflow files.
