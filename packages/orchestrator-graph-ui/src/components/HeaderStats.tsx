import type { RunStateResponse } from "../types";

interface HeaderStatsProps {
  runState: RunStateResponse | null;
  loading: boolean;
  error: string | null;
}

export function HeaderStats(props: HeaderStatsProps): JSX.Element {
  const stats = props.runState?.run;
  const telemetry = props.runState?.telemetry;
  const lastRun = props.runState?.history?.[0] ?? null;

  return (
    <header className="header-shell">
      <div className="header-title-wrap">
        <p className="eyebrow">Orchestrator</p>
        <h1>Execution Graph</h1>
        <p className="subtitle">Live DAG state with path tracing, history context, and execution telemetry.</p>
      </div>

      <div className="header-meta">
        <div className="pill">status: {stats?.status ?? "unknown"}</div>
        <div className="pill">cursor: {stats ? `${stats.cursorStep}/${stats.totalModules}` : "0/0"}</div>
        <div className="pill">updated: {props.runState ? new Date(props.runState.refreshedAt).toLocaleTimeString() : "-"}</div>
        <div className="pill">
          latest run: {lastRun ? `${lastRun.status} (${lastRun.totalModules} modules)` : "n/a"}
        </div>
      </div>

      <div className="metrics-grid">
        <MetricCard label="Modules" value={stats?.totalModules ?? 0} tone="neutral" />
        <MetricCard label="Success" value={stats?.successCount ?? 0} tone="success" />
        <MetricCard label="Failed" value={stats?.failedCount ?? 0} tone="failed" />
        <MetricCard label="Blocked" value={stats?.blockedCount ?? 0} tone="blocked" />
        <MetricCard label="Skipped" value={stats?.skippedCount ?? 0} tone="skipped" />
        <MetricCard label="Pending" value={Math.max(0, (stats?.totalModules ?? 0) - ((stats?.successCount ?? 0) + (stats?.failedCount ?? 0) + (stats?.blockedCount ?? 0) + (stats?.skippedCount ?? 0)))} tone="pending" />
        <MetricCard label="Attempts" value={telemetry?.totalAttempts ?? 0} tone="neutral" />
        <MetricCard label="Repairs" value={telemetry?.repairsGenerated ?? 0} tone="neutral" />
        <MetricCard label="Token k" value={Math.round((telemetry?.totalTokensEffective ?? 0) / 1000)} tone="neutral" />
        <MetricCard label="Elapsed s" value={Math.round((telemetry?.elapsedMs ?? 0) / 1000)} tone="neutral" />
      </div>

      {props.loading ? <p className="notice">Refreshing run state...</p> : null}
      {props.error ? <p className="notice error">{props.error}</p> : null}
    </header>
  );
}

function MetricCard(props: { label: string; value: number; tone: "neutral" | "success" | "failed" | "blocked" | "skipped" | "pending" }): JSX.Element {
  return (
    <article className={`metric-card tone-${props.tone}`}>
      <p>{props.label}</p>
      <strong>{props.value}</strong>
    </article>
  );
}
