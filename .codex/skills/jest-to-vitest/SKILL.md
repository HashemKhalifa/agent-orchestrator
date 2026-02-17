---
name: jest-to-vitest
description: Orchestrate Jest to Vitest migrations with API parity checks, teardown leak guards, and staged test validation.
---

# Jest To Vitest

Use this skill when migrating test runners across packages while preserving behavior parity.

## Workflow

1. Run autonomous dry-run:

```bash
bash scripts/run-bot-request-until-done.sh \
  --goal-type test_runner_migration \
  --recipe-id jest-to-vitest \
  --executor-profile codex-safe \
  --apply-mode dry-run
```

2. Validate high-risk patterns from request tasks:
- `jest.*` globals and mocks that need `vi.*` migration
- fake timer differences (`useFakeTimers`, `setSystemTime`)
- unclosed handles and teardown leaks in test workers

3. Switch to guarded apply:

```bash
bash scripts/run-bot-request-until-done.sh \
  --goal-type test_runner_migration \
  --recipe-id jest-to-vitest \
  --executor-profile codex-safe \
  --apply-mode apply \
  --apply-guard-token ALLOW_APPLY
```
