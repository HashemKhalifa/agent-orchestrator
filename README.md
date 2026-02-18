# orchestrator-core

Standalone, recipe-driven orchestration engine for cross-repo migrations and refactors.

This repo packages a reusable orchestration core with deep discovery, strict risk gating, and loop execution.

## Reuse In Another Repo

```bash
git clone git@github.com:HashemKhalifa/orchestrator-core.git tools/orchestrator-core
npm --prefix tools/orchestrator-core/packages/orchestrator-standalone install
npm --prefix tools/orchestrator-core/packages/orchestrator-standalone run cli -- recipes
```

You can also package `packages/orchestrator-standalone` and publish/install it as an internal npm package.

## Structure

- `packages/orchestrator-standalone` - core package (spec, adapters, kernel, recipes, CLI)
- `packages/orchestrator-graph-ui` - React DAG graph + inspector for live orchestration runs
- `scripts/run-standalone-orchestrator-until-done.sh` - run-until-done controller
- `scripts/run-bot-request-until-done.sh` - autonomous discovery -> RAG -> DAG -> execute loop
- `scripts/run-autonomy-worker.sh` - long-running queue worker (heartbeat + stale-run recovery)
- `scripts/run-request-dag-with-provider.sh` - run DAG with provider presets (codex/claude/openai/anthropic)
- `scripts/run-graph-ui.sh` - launch local graph dashboard (API + React app)
- `.github/workflows/orchestration.yml` - CI-native plan/dry-run/apply orchestration workflow
- `unpack.config.ts` - request-splitting strategy config used by DAG compiler
- `.codex/skills` - reusable Codex skills (system + project skills)

## Quick start

```bash
npm --prefix packages/orchestrator-standalone install
npm --prefix packages/orchestrator-standalone run typecheck
npm --prefix packages/orchestrator-standalone run build
npm --prefix packages/orchestrator-standalone run cli -- recipes
```

Example one-cycle dry run:

```bash
npm --prefix packages/orchestrator-standalone run cli -- cycle \
  --goal-type dependency_upgrade \
  --recipe-id react18-to-react19 \
  --mode dry-run
```

Compile and run request DAG:

```bash
npm --prefix packages/orchestrator-standalone run cli -- dag-compile --request request.md
npm --prefix packages/orchestrator-standalone run cli -- dag-run \
  --manifest generated/orchestration/dag/manifest.json \
  --executor "codex exec --full-auto \"Process {partFile}\""
```

Autonomous end-to-end loop (recipe + RAG + DAG + execution + optional skill autogen):

```bash
bash scripts/run-bot-request-until-done.sh \
  --goal-type build_migration \
  --recipe-id webpack-to-rsbuild-incremental \
  --executor-profile codex-safe \
  --apply-mode dry-run
```

Commit after a successful run:

```bash
bash scripts/run-bot-request-until-done.sh \
  --goal-type custom \
  --recipe-id backlog-recipe-init-scaffold \
  --recipe-file recipes/backlog/03-recipe-init-scaffold.json \
  --provider-preset claude-timeboxed \
  --provider-timeout-ms 120000 \
  --commit
```

Claude-backed execution (provider abstraction):

```bash
bash scripts/run-bot-request-until-done.sh \
  --goal-type dependency_upgrade \
  --recipe-id react18-to-react19 \
  --provider-preset claude-subscription \
  --apply-mode dry-run
```

Provider preset matrix:
- `codex`: `--provider-preset codex`
- `codex-timeboxed`: `--provider-preset codex-timeboxed`
- `claude`/subscription: `--provider-preset claude-subscription`
- `claude-timeboxed`: `--provider-preset claude-timeboxed`
- `openai` wrapper: `--provider-preset openai`
- `anthropic` wrapper: `--provider-preset anthropic`

If a provider CLI hangs beyond `--timeout-ms`, use the hard timeboxed wrapper:

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

`--executor-profile none` is required when using `--executor-provider custom`; otherwise the default profile command takes precedence.
`ORCHESTRATOR_PROVIDER_HEARTBEAT_MS` controls periodic in-flight progress logs from timeboxed executors (default `10000`).

Template-style wrapper usage (recommended):

```bash
./scripts/run-request-dag-with-provider.sh \
  --provider-preset codex-timeboxed \
  --provider-timeout-ms 120000 \
  --manifest generated/orchestration/dag/manifest.json \
  --fail-fast
```

Until-done loop progress line:
- `progress=1:S>2:F>3:P...`: `S=success`, `F=failed`, `B=blocked`, `K=skipped`, `P=pending`.
- `cursor=N/T next=<moduleId>`: next blocking step in full DAG order.
- `note=stuck repeatFailureStreak=...`: same failure point repeated across iterations.

## Reference Projects (Not Dependencies)

These are idea references only. The runtime implementation stays native to this repo.

- [`oh-my-claudecode`](https://github.com/Yeachan-Heo/oh-my-claudecode): command/layout inspiration
- [`wingman-ai`](https://github.com/RussellCanfield/wingman-ai): integration pattern inspiration
- [`AutoRefine`](https://github.com/syr-cn/AutoRefine): iterative retrieval/refinement strategy inspiration

We do not import or depend on these projects at runtime.

Backlog recipe files:
- `packages/orchestrator-standalone/recipes/backlog/01-worker-timeout-guard.json`
- `packages/orchestrator-standalone/recipes/backlog/02-worker-cancel-retry-cli.json`
- `packages/orchestrator-standalone/recipes/backlog/03-recipe-init-scaffold.json`

Automate recipe authoring from discovery + run memory:

```bash
npm --prefix packages/orchestrator-standalone run cli -- recipe-generate \
  --goal-type test_runner_migration \
  --recipe-id autogen-jest-vitest \
  --recipe-output generated/orchestration/recipes/autogen-jest-vitest.json
```

Deterministic golden suite:

```bash
npm --prefix packages/orchestrator-standalone run cli -- eval-golden
```

Benchmark scorecards:

```bash
npm --prefix packages/orchestrator-standalone run cli -- eval-benchmark \
  --benchmark-history-path generated/orchestration/benchmark/history.json \
  --benchmark-max-time-increase-ms 500 \
  --benchmark-max-quality-drop 2
```

Auto-refine RAG query:

```bash
npm --prefix packages/orchestrator-standalone run cli -- rag-query \
  --query "react 19 migration deprecations" \
  --auto-refine \
  --refine-iterations 3 \
  --refine-queries 20 \
  --refine-runtime-ms 5000 \
  --refine-token-budget 12000 \
  --refine-max-stall-iterations 2 \
  --refine-convergence-epsilon 0.005
```

Set `--refine-token-budget 0` (or `--rag-refine-token-budget 0`) to disable token-based throttling in subscription workflows.

Quick DAG run with provider preset:

```bash
bash scripts/run-request-dag-with-provider.sh --provider-preset claude-subscription
```

Use `pnpm` instead of `npm` for all shell wrappers:

```bash
ORCHESTRATOR_PM=pnpm bash scripts/run-request-dag-with-provider.sh --provider-preset claude-subscription
ORCHESTRATOR_PM=pnpm bash scripts/run-bot-request-until-done.sh --goal-type custom --recipe-id ci-node-build-test-modernization
```

Live DAG graph UI:

```bash
./scripts/run-graph-ui.sh
```

Or with pnpm:

```bash
ORCHESTRATOR_PM=pnpm ./scripts/run-graph-ui.sh
```

Then open `http://localhost:5178` to inspect module progress, cursor position, artifacts, and errors in real time.

Graph UI highlights:
- dagre-based DAG layout for cleaner dependency routing
- custom module cards (status/mode/attempt/files/risk/duration)
- path tracing (upstream/downstream) on node selection
- live SSE stream endpoint: `/api/stream` (with poll fallback)
- run history and telemetry summary (attempts, elapsed, tokens)

DAG run with critic, repair loops, budgets, artifact contracts, test-impact, and canary:

```bash
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
  --policy-critic-config .orchestrator/policy-critic.json \
  --policy-pack security \
  --policy-pack release
```

`--policy-critic-config` supports pack-specific critic templates and custom regex parsers. Use `{policyCriticPrompts}` in `--critic-command` templates to inject rendered policy instructions.

Auto-run with bounded auto-refine retrieval:

```bash
bash scripts/run-bot-request-until-done.sh \
  --goal-type build_migration \
  --recipe-id webpack-to-rsbuild-incremental \
  --provider-preset claude-subscription \
  --rag-auto-refine true \
  --include-generated false \
  --rag-refine-iterations 3 \
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
```

One-shot intake (generate recipe + enqueue long-running worker job):

```bash
npm --prefix packages/orchestrator-standalone run cli -- recipe-intake \
  --goal-type custom \
  --recipe-id my-new-recipe \
  --title "My migration objective" \
  --description "Generate + execute safely" \
  --workspace-root packages/orchestrator-standalone \
  --apply-mode dry-run \
  --enable-critic \
  --enable-repair-loop
```

Long-running worker mode (queue + heartbeat + resume-on-crash):

```bash
# enqueue an auto-run job
npm --prefix packages/orchestrator-standalone run cli -- worker-enqueue \
  --goal-type build_migration \
  --recipe-id webpack-to-rsbuild-incremental \
  --workspace-root packages/orchestrator-standalone \
  --apply-mode dry-run \
  --enable-critic \
  --enable-repair-loop

# run worker loop continuously
./scripts/run-autonomy-worker.sh \
  --workspace-root packages/orchestrator-standalone \
  --worker-state-path packages/orchestrator-standalone/generated/orchestration/worker/state.json \
  --poll-interval-ms 2000 \
  --stale-heartbeat-ms 180000

# inspect worker queue
npm --prefix packages/orchestrator-standalone run cli -- worker-status \
  --workspace-root packages/orchestrator-standalone \
  --worker-state-path packages/orchestrator-standalone/generated/orchestration/worker/state.json \
  --limit 20

# cancel a pending/running job
npm --prefix packages/orchestrator-standalone run cli -- worker-cancel \
  --workspace-root packages/orchestrator-standalone \
  --worker-state-path packages/orchestrator-standalone/generated/orchestration/worker/state.json \
  --job-id <job-id> \
  --reason "operator canceled"

# retry a failed/canceled job
npm --prefix packages/orchestrator-standalone run cli -- worker-retry \
  --workspace-root packages/orchestrator-standalone \
  --worker-state-path packages/orchestrator-standalone/generated/orchestration/worker/state.json \
  --job-id <job-id> \
  --reason "retry after fix"
```

`scripts/run-autonomy-worker.sh` resolves relative paths against repo root and now avoids stale-recovering jobs still owned by a live worker PID on the same host.
Queued jobs now default to `--timeout-ms 300000` (5 minutes) unless explicitly overridden.

## Claude Subscription Setup

1. Authenticate Claude CLI once (subscription account session).
2. Run orchestration with the subscription preset:

```bash
bash scripts/run-bot-request-until-done.sh \
  --goal-type dependency_upgrade \
  --recipe-id react18-to-react19 \
  --provider-preset claude-subscription \
  --auto-recipe \
  --apply-mode dry-run
```

3. Promote to apply mode only with explicit safeguards:

```bash
bash scripts/run-bot-request-until-done.sh \
  --goal-type dependency_upgrade \
  --recipe-id react18-to-react19 \
  --provider-preset claude-subscription \
  --apply-mode apply \
  --apply-guard-token ALLOW_APPLY \
  --evidence-file generated/orchestration/evidence/apply-evidence.md \
  --rollback-check-command "npm run test:run"
```

4. For GitHub Actions apply mode, configure:
- protected environment: `orchestration-apply`
- required secret: `ORCHESTRATION_APPLY_GUARD_TOKEN`
- optional secret allowlist: `ORCHESTRATION_APPLY_ACTORS` (comma-separated GitHub usernames)
- optional dispatch input: `evidence_sha256` to verify apply evidence checksum

## Skills

Core migration/orchestration skills are in `.codex/skills`, including:
- `claude-orchestration`
- `claude-webpack-rsbuild`
- `claude-react19-upgrade`
- `claude-jest-to-vitest`
- `recipe-autogen`

## Recommended Next Additions

- Add benchmark baseline seeding from prior commits in CI (for immediate delta checks on fresh history).
- Add richer policy critic parser macros (`{groupN}` expansion for more capture groups).
- Add replay-memory compaction by semantic clustering to reduce near-duplicate query expansions.
- Add signed artifact attestation for apply-mode evidence bundles.
