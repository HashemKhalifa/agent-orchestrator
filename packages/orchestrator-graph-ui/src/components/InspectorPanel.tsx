import type { NodeState, RunStateResponse } from "../types";
import { formatDuration } from "./graphTheme";

interface InspectorPanelProps {
  selected: NodeState | null;
  runState: RunStateResponse | null;
}

export function InspectorPanel(props: InspectorPanelProps): JSX.Element {
  const selectedDependencies = getDependencySummary(props.selected?.id ?? null, props.runState);

  return (
    <aside className="inspector">
      <h2>Inspector</h2>

      <section className="inspector-block">
        <h3>Sources</h3>
        <Field label="Manifest" value={props.runState?.sourcePaths.manifestPath ?? "-"} mono />
        <Field label="Run summary" value={props.runState?.sourcePaths.runSummaryPath ?? "-"} mono />
        <Field label="Artifacts" value={props.runState?.sourcePaths.artifactsDir ?? "-"} mono />
        <Field label="Iteration" value={props.runState?.sourcePaths.iterationSummaryPath ?? "-"} mono />
      </section>

      <section className="inspector-block">
        <h3>Telemetry</h3>
        <Field label="Attempts" value={String(props.runState?.telemetry?.totalAttempts ?? "-")} />
        <Field label="Resumed" value={String(props.runState?.telemetry?.resumedModules ?? 0)} />
        <Field label="Elapsed" value={formatDuration(props.runState?.telemetry?.elapsedMs ?? undefined)} />
        <Field label="Total duration" value={formatDuration(props.runState?.telemetry?.totalDurationMs ?? undefined)} />
        <Field label="Avg/module" value={formatDuration(props.runState?.telemetry?.averageModuleDurationMs ?? undefined)} />
        <Field label="Longest module" value={formatDuration(props.runState?.telemetry?.longestModuleDurationMs ?? undefined)} />
        <Field label="Tokens effective" value={String(props.runState?.telemetry?.totalTokensEffective ?? "-")} />
        <Field label="Policy packs" value={String(props.runState?.telemetry?.policyPackCount ?? 0)} />
        <Field label="Memory calls" value={String(props.runState?.telemetry?.memoryCalls ?? 0)} />
        <Field label="Memory hits" value={String(props.runState?.telemetry?.memoryHits ?? 0)} />
        <Field label="Memory loaded" value={String(props.runState?.telemetry?.memoryCandidatesLoaded ?? 0)} />
        <Field
          label="Memory sources"
          value={`sem=${props.runState?.telemetry?.memoryCandidatesSemantic ?? 0}, replay=${props.runState?.telemetry?.memoryCandidatesReplay ?? 0}, artifact=${props.runState?.telemetry?.memoryCandidatesArtifact ?? 0}`}
        />
        <Field
          label="Memory selected"
          value={`sem=${props.runState?.telemetry?.memorySelectedSemantic ?? 0}, replay=${props.runState?.telemetry?.memorySelectedReplay ?? 0}, artifact=${props.runState?.telemetry?.memorySelectedArtifact ?? 0}`}
        />
        <Field label="Memory skipped" value={props.runState?.telemetry?.memorySkippedPreview ?? "-"} />
      </section>

      {!props.selected ? (
        <section className="inspector-block empty">
          <p>Select a module node to inspect details and dependency paths.</p>
        </section>
      ) : (
        <section className="inspector-block">
          <h3>{props.selected.id}</h3>
          <p className="inspector-title">{props.selected.title}</p>
          <div className="status-chip-wrap">
            <span className={`status-chip status-${props.selected.status}`}>{props.selected.status}</span>
            <span className="status-chip subtle">{props.selected.mode}</span>
            <span className="status-chip subtle">level {props.selected.level}</span>
          </div>

          <Field label="Attempt" value={String(props.selected.attempt ?? "-")} />
          <Field label="Exit code" value={props.selected.code == null ? "-" : String(props.selected.code)} />
          <Field label="Duration" value={formatDuration(props.selected.durationMs)} />
          <Field label="Depends on" value={props.selected.dependsOn.length > 0 ? props.selected.dependsOn.join(", ") : "none"} />
          <Field label="Dependents" value={selectedDependencies.downstream.length > 0 ? selectedDependencies.downstream.join(", ") : "none"} />
          <Field label="Changed files" value={String(props.selected.changedFilesCount ?? 0)} />
          <Field label="Risk notes" value={String(props.selected.riskNotesCount ?? 0)} />
          <Field label="Critic" value={props.selected.criticSeverity ?? "-"} />
          <Field label="Artifact path" value={props.selected.artifactPath ?? "-"} mono />
          <Field label="Repair task" value={props.selected.repairTaskPath ?? "-"} mono />
          <Field label="Updated" value={props.selected.updatedAt ? new Date(props.selected.updatedAt).toLocaleString() : "-"} />
        </section>
      )}

      <section className="inspector-block">
        <h3>Recent runs</h3>
        {props.runState?.history?.length ? (
          <ul className="history-list">
            {props.runState.history.slice(0, 8).map((entry) => (
              <li key={entry.runId}>
                <div className="history-head">
                  <span className={`status-chip status-${entry.status === "partial_failure" ? "blocked" : entry.status}`}>{entry.status}</span>
                  <strong>{entry.runId}</strong>
                </div>
                <p>
                  {entry.successCount}/{entry.totalModules} ok, {entry.failedCount} failed, {entry.blockedCount} blocked
                </p>
                <p>
                  {entry.elapsedMs == null ? "-" : `${Math.round(entry.elapsedMs / 1000)}s`} ·{" "}
                  {entry.totalTokensEffective == null ? "-" : `${entry.totalTokensEffective} tokens`}
                </p>
                <code>{entry.summaryPath}</code>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty-note">No iteration history found yet.</p>
        )}
      </section>

      {props.runState?.errors && props.runState.errors.length > 0 ? (
        <section className="inspector-block">
          <h3>Read Errors</h3>
          <ul className="error-list">
            {props.runState.errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </aside>
  );
}

function Field(props: { label: string; value: string; mono?: boolean }): JSX.Element {
  return (
    <div className="field-row">
      <span>{props.label}</span>
      <code className={props.mono ? "mono" : ""}>{props.value}</code>
    </div>
  );
}

function getDependencySummary(
  selectedNodeId: string | null,
  runState: RunStateResponse | null,
): { upstream: string[]; downstream: string[] } {
  if (!selectedNodeId || !runState) return { upstream: [], downstream: [] };
  const upstream = runState.edges
    .filter((edge) => edge.target === selectedNodeId)
    .map((edge) => edge.source)
    .sort((a, b) => a.localeCompare(b));
  const downstream = runState.edges
    .filter((edge) => edge.source === selectedNodeId)
    .map((edge) => edge.target)
    .sort((a, b) => a.localeCompare(b));
  return { upstream, downstream };
}
