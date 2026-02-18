# orchestrator-graph-ui

React operator dashboard for visualizing orchestration DAG progress in real time.

It reads:
- DAG manifest (`.../autonomy/dag/manifest.json`)
- run summary (`.../autonomy/dag/run-summary.json`)
- latest artifacts (`.../autonomy/dag/artifacts` or `.../generated/orchestration/dag/artifacts`)
- latest iteration summary (`.../autonomy/iterations/auto-run-*.json`)

## What You Get

- Dagre-based DAG layout (better edge routing and reduced crossings vs static level placement)
- Custom node cards with status/mode/attempt/file-risk/duration context
- Dependency path highlight (upstream + downstream) when a node is selected
- Streamed live updates over SSE (`/api/stream`) with polling fallback
- Run history timeline (latest iteration summaries)
- Telemetry panel (attempts, elapsed, module durations, token totals)
- Filters: status, mode, and text search

## Run

From repo root:

```bash
./scripts/run-graph-ui.sh
```

Or direct package commands:

```bash
npm --prefix packages/orchestrator-graph-ui install
npm --prefix packages/orchestrator-graph-ui run dev
```

With pnpm:

```bash
ORCHESTRATOR_PM=pnpm ./scripts/run-graph-ui.sh
```

Client: `http://localhost:5178`  
API: `http://localhost:4319`

## API

- `GET /api/health`
- `GET /api/run-state?workspaceRoot=packages/orchestrator-standalone&autonomyDir=generated/orchestration/autonomy`
- `GET /api/stream?workspaceRoot=...&autonomyDir=...&intervalMs=2000`

`workspaceRoot` and `autonomyDir` are also editable in the UI.

## Validation

```bash
npm --prefix packages/orchestrator-graph-ui run typecheck
npm --prefix packages/orchestrator-graph-ui run test:run
npm --prefix packages/orchestrator-graph-ui run build
```
