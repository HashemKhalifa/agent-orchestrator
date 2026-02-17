---
name: react19-upgrade
description: Orchestrate React 18 to React 19 upgrades with breaking-change discovery, leak checks, and staged validation.
---

# React 19 Upgrade

Use this skill for React runtime upgrades in single repos or monorepos.

## Workflow

1. Dry-run autonomous loop:

```bash
bash scripts/run-bot-request-until-done.sh \
  --goal-type dependency_upgrade \
  --recipe-id react18-to-react19 \
  --executor-profile codex-safe \
  --apply-mode dry-run
```

2. Validate critical findings in generated request and DAG output:
- legacy `ReactDOM.render` usage
- hydration/root API migration points
- effect cleanup risks (`setInterval`, event listeners, subscriptions)

3. Apply when gates are consistently green:

```bash
bash scripts/run-bot-request-until-done.sh \
  --goal-type dependency_upgrade \
  --recipe-id react18-to-react19 \
  --executor-profile codex-safe \
  --apply-mode apply \
  --apply-guard-token ALLOW_APPLY
```
