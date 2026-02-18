# Orchestrator Standalone

Standalone recipe-driven orchestration engine for migration and refactor workflows.

## Goals

- Reusable across repositories via package import or CLI.
- Supports multiple use cases (build migration, dependency upgrades, CI/test refactors).
- Deep discovery with local workspace analysis + internet evidence from docs/changelogs.
- Strict blocker mode for unresolved breaking/memory/performance risks.

## Commands

```bash
# List built-in recipes
npm --prefix packages/orchestrator-standalone run cli -- recipes

# Discovery only
npm --prefix packages/orchestrator-standalone run cli -- discover --recipe-id webpack-to-rsbuild-incremental

# Execute one orchestration cycle (discover -> plan -> validate -> execute)
npm --prefix packages/orchestrator-standalone run cli -- cycle \
  --goal-type build_migration \
  --recipe-id webpack-to-rsbuild-incremental \
  --mode dry-run

# Check run state
npm --prefix packages/orchestrator-standalone run cli -- status --run-id <run-id>

# Compile large request docs into DAG modules (uses unpack.config.ts when present)
npm --prefix packages/orchestrator-standalone run cli -- dag-compile --request request.md

# Run DAG modules with an executor template
npm --prefix packages/orchestrator-standalone run cli -- dag-run \
  --manifest generated/orchestration/dag/manifest.json \
  --executor "codex exec --full-auto \"Process {partFile}\""

# Build/query local RAG index (generated/ excluded by default)
npm --prefix packages/orchestrator-standalone run cli -- rag-index --include-generated false
npm --prefix packages/orchestrator-standalone run cli -- rag-query --query "webpack rsbuild compatibility"

# Auto-refine RAG query (iterative retrieval with runtime/token/query budgets)
npm --prefix packages/orchestrator-standalone run cli -- rag-query \
  --query "webpack rsbuild migration risks" \
  --auto-refine \
  --refine-iterations 3 \
  --refine-queries 20 \
  --refine-runtime-ms 5000 \
  --refine-token-budget 12000 \
  --refine-max-stall-iterations 2 \
  --refine-convergence-epsilon 0.005

# Disable token throttling for subscription-only workflows
npm --prefix packages/orchestrator-standalone run cli -- rag-query \
  --query "webpack rsbuild migration risks" \
  --auto-refine \
  --refine-token-budget 0

# Synthesize request.md from discovery + RAG and compile DAG
npm --prefix packages/orchestrator-standalone run cli -- synthesize-tasks \
  --goal-type build_migration \
  --recipe-id webpack-to-rsbuild-incremental \
  --compile-dag

# End-to-end autonomous pass (discover -> RAG -> synthesize -> DAG run -> skills)
npm --prefix packages/orchestrator-standalone run cli -- auto-run \
  --goal-type build_migration \
  --recipe-id webpack-to-rsbuild-incremental \
  --executor-profile codex-safe \
  --apply-mode dry-run

# Claude subscription preset
npm --prefix packages/orchestrator-standalone run cli -- auto-run \
  --goal-type dependency_upgrade \
  --recipe-id react18-to-react19 \
  --provider-preset claude-subscription \
  --apply-mode dry-run

# Auto-generate a recipe from discovery + historical run memory
npm --prefix packages/orchestrator-standalone run cli -- recipe-generate \
  --goal-type dependency_upgrade \
  --recipe-id autogen-react-upgrade \
  --recipe-output generated/orchestration/recipes/autogen-react-upgrade.json

# Scaffold a new recipe file with inferred workspace preconditions
npm --prefix packages/orchestrator-standalone run cli -- recipe-init \
  --goal-type custom \
  --recipe-id my-new-migration \
  --title "My New Migration" \
  --description "Describe migration scope, risks, and gates" \
  --recipe-output recipes/backlog/my-new-migration.json

# One-shot: generate recipe + enqueue worker job
npm --prefix packages/orchestrator-standalone run cli -- recipe-intake \
  --goal-type custom \
  --recipe-id my-new-recipe \
  --title "My migration objective" \
  --description "Generate + execute safely" \
  --workspace-root packages/orchestrator-standalone \
  --apply-mode dry-run \
  --enable-critic \
  --enable-repair-loop

# Golden deterministic evaluation suite
npm --prefix packages/orchestrator-standalone run cli -- eval-golden

# Enqueue auto-run jobs into long-running worker queue
npm --prefix packages/orchestrator-standalone run cli -- worker-enqueue \
  --goal-type build_migration \
  --recipe-id webpack-to-rsbuild-incremental \
  --workspace-root packages/orchestrator-standalone \
  --apply-mode dry-run

# Run worker loop (poll queue, heartbeat running jobs, recover stale jobs)
npm --prefix packages/orchestrator-standalone run cli -- worker-run \
  --workspace-root packages/orchestrator-standalone \
  --worker-state-path packages/orchestrator-standalone/generated/orchestration/worker/state.json \
  --poll-interval-ms 2000 \
  --stale-heartbeat-ms 180000

# Inspect worker queue + heartbeat health
npm --prefix packages/orchestrator-standalone run cli -- worker-status \
  --workspace-root packages/orchestrator-standalone \
  --worker-state-path packages/orchestrator-standalone/generated/orchestration/worker/state.json \
  --limit 20

# Cancel a pending/running job
npm --prefix packages/orchestrator-standalone run cli -- worker-cancel \
  --workspace-root packages/orchestrator-standalone \
  --worker-state-path packages/orchestrator-standalone/generated/orchestration/worker/state.json \
  --job-id <job-id> \
  --reason "operator canceled"

# Retry a failed/canceled job
npm --prefix packages/orchestrator-standalone run cli -- worker-retry \
  --workspace-root packages/orchestrator-standalone \
  --worker-state-path packages/orchestrator-standalone/generated/orchestration/worker/state.json \
  --job-id <job-id> \
  --reason "retry after fix"

# Benchmark scorecards (quality/time/cost/failure-rate)
npm --prefix packages/orchestrator-standalone run cli -- eval-benchmark \
  --benchmark-history-path generated/orchestration/benchmark/history.json \
  --benchmark-max-time-increase-ms 500 \
  --benchmark-max-quality-drop 2

# Provider preset shortcut
npm --prefix packages/orchestrator-standalone run cli -- dag-run \
  --manifest generated/orchestration/dag/manifest.json \
  --provider-preset claude-subscription

# List reusable policy packs
npm --prefix packages/orchestrator-standalone run cli -- policy-packs

# Synthesize tasks with auto-refine retrieval controls
npm --prefix packages/orchestrator-standalone run cli -- synthesize-tasks \
  --goal-type build_migration \
  --recipe-id webpack-to-rsbuild-incremental \
  --rag-auto-refine true \
  --rag-refine-iterations 3 \
  --rag-refine-queries-per-iteration 4 \
  --rag-refine-queries 20 \
  --rag-refine-runtime-ms 5000 \
  --rag-refine-token-budget 12000 \
  --rag-refine-max-stall-iterations 2 \
  --rag-refine-convergence-epsilon 0.005 \
  --rag-replay-memory true \
  --rag-replay-max-entries 240 \
  --rag-replay-max-age-days 90 \
  --rag-replay-min-score 0.05 \
  --rag-replay-min-success-count 1

# Load generated recipe JSON directly
npm --prefix packages/orchestrator-standalone run cli -- auto-run \
  --goal-type test_runner_migration \
  --recipe-file generated/orchestration/recipes/autogen-jest-vitest.json \
  --provider-preset claude-subscription \
  --apply-mode dry-run

# DAG run with critic, repair loops, budgets, and canary checkpoint
npm --prefix packages/orchestrator-standalone run cli -- dag-run \
  --manifest generated/orchestration/dag/manifest.json \
  --executor-profile codex-safe \
  --enable-critic \
  --critic-fail-level warning \
  --enable-repair-loop \
  --max-total-attempts 200 \
  --max-total-tokens 250000 \
  --max-run-runtime-ms 1800000 \
  --test-impact targeted_then_full \
  --canary-modules 3 \
  --policy-pack security \
  --policy-critic-config .orchestrator/policy-critic.json
```

## Built-in Recipes (v1)

- `webpack-to-rsbuild-incremental`
- `react18-to-react19`
- `jest-to-vitest`
- `ci-node-build-test-modernization`

## Backlog Recipe Files

- `recipes/backlog/01-worker-timeout-guard.json`
- `recipes/backlog/02-worker-cancel-retry-cli.json`
- `recipes/backlog/03-recipe-init-scaffold.json`

## Recipe Authoring Guide

### 1. Scaffold a new recipe

Use `recipe-init` to generate a schema-valid recipe JSON with inferred workspace preconditions:

```bash
npm --prefix packages/orchestrator-standalone run cli -- recipe-init \
  --workspace-root packages/orchestrator-standalone \
  --goal-type custom \
  --recipe-id backlog-my-recipe \
  --title "My Migration" \
  --description "Describe migration scope, risks, and gates" \
  --recipe-output recipes/backlog/backlog-my-recipe.json
```

This writes a starter JSON file that conforms to `ExecutionRecipeSchema`. The scaffold infers `preconditions.packageManagers` and `preconditions.requiresFiles` from the workspace when possible.

### 2. Recipe JSON structure

Every recipe must include these top-level fields:

| Field | Description |
|---|---|
| `id` | Unique kebab-case identifier |
| `version` | Semver string (e.g. `"1.0.0"`) |
| `title` | Human-readable name |
| `description` | Scope, risks, and purpose |
| `goalType` | One of `build_migration`, `dependency_upgrade`, `ci_refactor`, `test_runner_migration`, `custom` |
| `defaultWaveStrategy` | One of `incremental_dual_build`, `pilot_wave`, `big_bang`, `custom` |
| `preconditions` | `{ packageManagers, requiresFiles, requiresBuildTools }` |
| `steps` | Array of `{ id, title, kind, description, mutating }` |
| `gates` | Array of `{ id, title, kind, required }` with optional `command`/`note` |

Optional fields: `discoverySources`, `riskProbes`, `rollbackHints`, `edgeCases`.

Step `kind` values: `analyze`, `transform`, `verify`, `gate`, `notify`.
Gate `kind` values: `command`, `risk`, `artifact`, `manual`.

See `recipes/backlog/03-recipe-init-scaffold.json` for a complete example.

### 3. Edit and customize

Open the generated JSON and tailor `steps`, `gates`, and `riskProbes` to your workflow. At minimum:

- Add concrete `steps` describing what the migration does.
- Add a `command` gate for typecheck or test validation.
- Add `riskProbes` for known failure patterns (regex matched against source files).

### 4. Validate the recipe

The scaffold validates output through `ExecutionRecipeSchema` before writing. To re-validate a hand-edited recipe, load it with `--recipe-file` in dry-run mode:

```bash
npm --prefix packages/orchestrator-standalone run cli -- auto-run \
  --goal-type custom \
  --recipe-file recipes/backlog/backlog-my-recipe.json \
  --apply-mode dry-run
```

Schema validation errors surface immediately before any execution begins.

### 5. Run end-to-end

Run the recipe through the full orchestration cycle (discover, RAG, synthesize, DAG, execute):

```bash
npm --prefix packages/orchestrator-standalone run cli -- auto-run \
  --workspace-root packages/orchestrator-standalone \
  --goal-type custom \
  --recipe-file recipes/backlog/backlog-my-recipe.json \
  --apply-mode dry-run \
  --executor-profile codex-safe
```

Add `--enable-critic` and `--enable-repair-loop` for per-module quality checks with automatic retry on failure. Attach policy packs with `--policy-pack security` for domain-specific critic rules.

### 6. Promote to apply

Once dry-run results are satisfactory, switch to apply mode with the apply guard:

```bash
npm --prefix packages/orchestrator-standalone run cli -- auto-run \
  --workspace-root packages/orchestrator-standalone \
  --goal-type custom \
  --recipe-file recipes/backlog/backlog-my-recipe.json \
  --apply-mode apply \
  --apply-guard-token ALLOW_APPLY \
  --enable-critic \
  --enable-repair-loop
```

## Run Artifacts

Default runs directory:

`generated/orchestration/standalone/runs/<run-id>/`

Artifacts per cycle:

- `plan-*.json`
- `validation-*.json`
- `execution-*.json`
- `cycle-*.json`
- `state.json`

## Risk Gates

`strict_blockers` mode blocks apply/progress when unresolved high/critical risks exist, including:

- breaking changes
- memory leak indicators
- performance regressions
- missing primary-source evidence

## Advanced Runtime Controls

- Per-module critic pass and focused repair loops.
- Strict run budgets: attempts, token estimate, and runtime ceilings.
- Module artifact contracts with structured evidence (changes, tests, risk notes).
- Test-impact mode for targeted package tests before optional full-suite.
- Policy packs (`security`, `legal`, `release`, `infra`) injected via `--policy-pack`.
- Pack-specific critic templates + parser rules via `--policy-critic-config` and `{policyCriticPrompts}` in `--critic-command`.
- Policy parser `messageTemplate` supports `{match}`, `{groupN}`, and `{groupN+}` (for example, `{group4+}` joins capture groups 4+ with spaces).
- Critic severity tiers with configurable threshold via `--critic-fail-level info|warning|blocker`.
- Canary checkpoint via `--canary-modules` and `--canary-compare-command`.
- Semantic run memory persisted by repo+recipe fingerprint during `auto-run`.
- Auto-refined RAG retrieval in `auto-run` / `synthesize-tasks` with critic convergence controls (bounded by iteration/query/runtime/token budgets).
- Replay-memory query seeding persists successful refine expansions by repo+recipe fingerprint with retention caps (`--rag-replay-max-entries`, `--rag-replay-max-age-days`, `--rag-replay-min-score`, `--rag-replay-min-success-count`).
- `generated/` is excluded from RAG indexing by default, with opt-in override via `--include-generated true`.
- Token budgets prefer observed provider usage (including normalized wrapper token receipts) and fall back to estimates.
- Benchmark trend thresholds can fail runs via `--benchmark-max-*-*` flags when deltas exceed budget.
- Long-running worker orchestration via `worker-enqueue`/`worker-run`/`worker-status` plus operator controls `worker-cancel`/`worker-retry`, with persisted queue state, heartbeats, stale-run recovery, retry caps, and live-owner PID protection for long-running jobs.
- Queued jobs default to `--timeout-ms 300000` (5 minutes); override per job when longer modules are expected.

## Reference Inputs (Not Dependencies)

External projects used only as design references:

- [`oh-my-claudecode`](https://github.com/Yeachan-Heo/oh-my-claudecode)
- [`wingman-ai`](https://github.com/RussellCanfield/wingman-ai)
- [`AutoRefine`](https://github.com/syr-cn/AutoRefine)

This package does not depend on these repositories at runtime.

## Recommended Next Additions

- Add benchmark baseline seeding from prior commits in CI for immediate first-run delta checks.
- Add replay-memory semantic deduplication for near-identical expansions.
- Add artifact signing/attestation for apply evidence bundles.

## Notes

- Existing MCP and legacy orchestration flows are unchanged by default.
- This package is opt-in via CLI invocation.
- Root-level `unpack.config.ts` enables custom split rules for large request files.
- `dag-run --apply-mode apply` is guard-protected; pass `--apply-guard-token ALLOW_APPLY` (or custom guard value) explicitly.
- Apply mode supports stronger controls: wave approvals (`--approvals-dir`), evidence file requirement (`--evidence-file`), and rollback readiness command (`--rollback-check-command`).
- Executor abstraction supports Codex and Claude profiles (`--executor-profile codex-safe|claude-safe`), provider presets (`--provider-preset codex|claude|claude-subscription|openai|anthropic`), and custom templates.
- RAG retrieval uses hybrid BM25 + embedding scoring with tunable weights.
- Profile commands are resolved before provider commands. If you pass `--executor-provider custom`, also set `--executor-profile none`.

## Provider Presets

- `--provider-preset codex`: uses `codex-safe`
- `--provider-preset codex-timeboxed`: routes through `scripts/executors/codex-timeboxed.sh`
- `--provider-preset claude` or `--provider-preset claude-subscription`: uses `claude-safe`
- `--provider-preset claude-timeboxed`: routes through `scripts/executors/claude-timeboxed.sh`
- `--provider-preset openai`: routes through OpenAI executor settings
- `--provider-preset anthropic`: routes through Anthropic executor settings

Preset helper scripts:
- `scripts/run-request-dag-with-provider.sh`
- `scripts/run-orchestrator-cli.sh` (`ORCHESTRATOR_PM=pnpm` to run wrappers via pnpm)
- `scripts/executors/codex.sh`
- `scripts/executors/codex-timeboxed.sh`
- `scripts/executors/claude.sh`
- `scripts/executors/claude-timeboxed.sh`
- `scripts/executors/openai.sh`
- `scripts/executors/anthropic.sh`

Timeboxed custom provider example:

```bash
ORCHESTRATOR_PROVIDER_TIMEOUT_MS=120000 \
npm --prefix packages/orchestrator-standalone run cli -- auto-run \
  --workspace-root . \
  --goal-type custom \
  --recipe-id backlog-worker-cancel-retry-cli \
  --recipe-file recipes/backlog/02-worker-cancel-retry-cli.json \
  --executor-profile none \
  --executor-provider custom \
  --provider-template "bash /Users/khalifah/workspace/H/orchestrator-core/scripts/executors/codex-timeboxed.sh {moduleId} {title} {partFile} {requestPath}" \
  --apply-mode dry-run
```

`scripts/run-bot-request-until-done.sh` supports `--commit` to create a git commit after successful completion (auto-generated commit message).

`ORCHESTRATOR_PROVIDER_HEARTBEAT_MS` controls periodic in-flight progress logs from timeboxed executors (default `10000`).

Until-done loop progress line:
- `progress=1:S>2:F>3:P...`: `S=success`, `F=failed`, `B=blocked`, `K=skipped`, `P=pending`.
- `cursor=N/T next=<moduleId>`: next blocking step in full DAG order.
- `note=stuck repeatFailureStreak=...`: same failure point repeated across iterations.
