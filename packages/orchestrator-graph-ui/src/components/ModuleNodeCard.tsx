import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { CSSProperties } from "react";
import type { NodeState } from "../types";
import { formatDuration, statusColor } from "./graphTheme";

export type PathRole = "none" | "selected" | "upstream" | "downstream";

export type GraphNodeData = Record<string, unknown> & {
  module: NodeState;
  emphasized: boolean;
  dimmed: boolean;
  pathRole: PathRole;
  searchMatched: boolean;
  compact?: boolean;
};

export function ModuleNodeCard(props: NodeProps): JSX.Element {
  const data = props.data as GraphNodeData;
  const module = data.module;
  const tint = statusColor(module.status);

  return (
    <article
      className={`rf-node-card ${data.compact ? "is-compact" : ""} ${data.emphasized ? "is-emphasized" : ""} ${data.dimmed ? "is-dimmed" : ""} path-${data.pathRole}`}
      style={{ "--node-tint": tint } as CSSProperties}
      title={`${module.id} · ${module.status}`}
      data-status={module.status}
      data-mode={module.mode}
      data-kind={module.kind}
    >
      <Handle type="target" position={Position.Left} className="rf-handle" />

      <header className="rf-node-head">
        <span className={`rf-status-pill status-${module.status}`}>{module.status}</span>
        <span className="rf-node-id">{module.id}</span>
      </header>

      <p className="rf-node-title">{module.title}</p>

      {data.compact ? (
        <div className="rf-chip-row">
          <span className={`rf-chip chip-kind chip-kind-${module.kind}`}>{module.kind}</span>
          <span className="rf-chip">{module.mode}</span>
          <span className="rf-chip">L{module.level}</span>
        </div>
      ) : (
        <>
          <div className="rf-chip-row">
            <span className="rf-chip">{module.mode}</span>
            <span className={`rf-chip chip-kind chip-kind-${module.kind}`}>{module.kind}</span>
            {module.entryGroup ? <span className="rf-chip">{module.entryGroup}</span> : null}
            <span className="rf-chip">L{module.level}</span>
            <span className="rf-chip">Attempt {module.attempt ?? "-"}</span>
          </div>

          <dl className="rf-metrics">
            <div>
              <dt>Files</dt>
              <dd>{module.changedFilesCount ?? 0}</dd>
            </div>
            <div>
              <dt>Risk</dt>
              <dd>{module.riskNotesCount ?? 0}</dd>
            </div>
            <div>
              <dt>Dur</dt>
              <dd>{formatDuration(module.durationMs)}</dd>
            </div>
            <div>
              <dt>Exit</dt>
              <dd>{module.code == null ? "-" : module.code}</dd>
            </div>
          </dl>
        </>
      )}

      {data.searchMatched ? <div className="rf-search-hit">search match</div> : null}

      <Handle type="source" position={Position.Right} className="rf-handle" />
    </article>
  );
}
