---
name: claude-jest-to-vitest
description: Run Jest to Vitest migration with Claude profile, recipe autogen, and deterministic validation gates.
---

# Claude Jest To Vitest

```bash
bash scripts/run-bot-request-until-done.sh \
  --goal-type test_runner_migration \
  --recipe-id jest-to-vitest \
  --provider-preset claude-subscription \
  --auto-recipe \
  --apply-mode dry-run
```

Key parity checks:
- `jest.*` API replacement
- fake timer parity
- teardown/unclosed handle leaks
