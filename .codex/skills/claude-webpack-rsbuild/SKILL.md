---
name: claude-webpack-rsbuild
description: Run Webpack to Rsbuild migration orchestration with Claude-safe execution profile and guarded apply controls.
---

# Claude Webpack To Rsbuild

```bash
bash scripts/run-bot-request-until-done.sh \
  --goal-type build_migration \
  --recipe-id webpack-to-rsbuild-incremental \
  --provider-preset claude-subscription \
  --auto-recipe \
  --apply-mode dry-run
```

Promote to apply with explicit safeguards:

```bash
bash scripts/run-bot-request-until-done.sh \
  --goal-type build_migration \
  --recipe-id webpack-to-rsbuild-incremental \
  --provider-preset claude-subscription \
  --apply-mode apply \
  --apply-guard-token ALLOW_APPLY \
  --evidence-file generated/orchestration/evidence/apply-evidence.md \
  --rollback-check-command "npm run test:run"
```
