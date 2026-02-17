---
name: claude-react19-upgrade
description: Execute React 18 to React 19 migration with Claude subscription mode, memory-informed recipes, and strict apply guards.
---

# Claude React19 Upgrade

```bash
bash scripts/run-bot-request-until-done.sh \
  --goal-type dependency_upgrade \
  --recipe-id react18-to-react19 \
  --provider-preset claude-subscription \
  --auto-recipe \
  --apply-mode dry-run
```

Focus checks:
- `ReactDOM.render` -> root APIs
- hydration behavior
- effect cleanup/leak risks
