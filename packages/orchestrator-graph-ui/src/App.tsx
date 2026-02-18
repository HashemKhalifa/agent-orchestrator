import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchRunState, subscribeRunState } from "./api/client";
import { GraphCanvas } from "./components/GraphCanvas";
import { HeaderStats } from "./components/HeaderStats";
import { InspectorPanel } from "./components/InspectorPanel";
import { StatusLegend } from "./components/StatusLegend";
import type { EdgeRef, ModuleStatus, NodeState, RunStateResponse } from "./types";

const DEFAULT_WORKSPACE_ROOT = "packages/orchestrator-standalone";
const DEFAULT_AUTONOMY_DIR = "generated/orchestration/autonomy";
const INITIAL_QUERY = typeof window === "undefined" ? null : new URLSearchParams(window.location.search);
const INITIAL_WORKSPACE_ROOT = INITIAL_QUERY?.get("workspaceRoot")?.trim() || DEFAULT_WORKSPACE_ROOT;
const INITIAL_AUTONOMY_DIR = INITIAL_QUERY?.get("autonomyDir")?.trim() || DEFAULT_AUTONOMY_DIR;

const statuses: ModuleStatus[] = ["success", "failed", "blocked", "skipped", "pending"];

type StatusFilter = Record<ModuleStatus, boolean>;

const defaultStatusFilter: StatusFilter = {
  success: true,
  failed: true,
  blocked: true,
  skipped: true,
  pending: true,
};

export default function App(): JSX.Element {
  const [workspaceRoot, setWorkspaceRoot] = useState(INITIAL_WORKSPACE_ROOT);
  const [autonomyDir, setAutonomyDir] = useState(INITIAL_AUTONOMY_DIR);
  const [pollMs, setPollMs] = useState(2000);
  const [paused, setPaused] = useState(false);
  const [transport, setTransport] = useState<"stream" | "poll">("stream");

  const [runState, setRunState] = useState<RunStateResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(defaultStatusFilter);
  const [showAnalyze, setShowAnalyze] = useState(true);
  const [showImplement, setShowImplement] = useState(true);
  const [highlightPath, setHighlightPath] = useState(true);
  const [dimOutsidePath, setDimOutsidePath] = useState(true);

  const ingestState = useCallback((next: RunStateResponse) => {
    setRunState(next);
    setError(next.errors.length > 0 ? next.errors[0] : null);
    setLoading(false);
    setSelectedNodeId((current) => {
      if (!current) return current;
      const exists = next.nodes.some((node) => node.id === current);
      return exists ? current : null;
    });
  }, []);

  const loadState = useCallback(async () => {
    setLoading(true);
    try {
      const next = await fetchRunState({ workspaceRoot, autonomyDir });
      ingestState(next);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      setLoading(false);
    }
  }, [workspaceRoot, autonomyDir, ingestState]);

  useEffect(() => {
    void loadState();
  }, [loadState]);

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    query.set("workspaceRoot", workspaceRoot);
    query.set("autonomyDir", autonomyDir);
    const next = `${window.location.pathname}?${query.toString()}`;
    window.history.replaceState(null, "", next);
  }, [workspaceRoot, autonomyDir]);

  useEffect(() => {
    if (paused) return;
    if (transport === "stream") {
      const unsubscribe = subscribeRunState(
        { workspaceRoot, autonomyDir, intervalMs: Math.max(500, pollMs) },
        {
          onState: ingestState,
          onError: (message) => setError(message),
        },
      );
      return unsubscribe;
    }

    const interval = window.setInterval(() => {
      void loadState();
    }, Math.max(500, pollMs));
    return () => window.clearInterval(interval);
  }, [paused, pollMs, loadState, workspaceRoot, autonomyDir, ingestState, transport]);

  const graphView = useMemo(() => {
    const nodes = runState?.nodes ?? [];
    const edges = runState?.edges ?? [];
    const search = query.trim().toLowerCase();

    const selectedNode = selectedNodeId ? nodes.find((node) => node.id === selectedNodeId) : null;
    const selectedNodeMustBeVisible = selectedNode ? [selectedNode.id] : [];

    const searchMatchedNodeIds = new Set(
      search.length === 0
        ? []
        : nodes
            .filter((node) => node.id.toLowerCase().includes(search) || node.title.toLowerCase().includes(search))
            .map((node) => node.id),
    );

    const filteredNodes = nodes.filter((node) => {
      if (!statusFilter[node.status]) return false;
      if (!showAnalyze && node.mode === "analyze") return false;
      if (!showImplement && node.mode === "implement") return false;
      if (search.length > 0 && !searchMatchedNodeIds.has(node.id) && !selectedNodeMustBeVisible.includes(node.id)) return false;
      return true;
    });

    const visibleNodeIds = new Set(filteredNodes.map((node) => node.id));
    for (const id of selectedNodeMustBeVisible) {
      visibleNodeIds.add(id);
    }
    const visibleNodes = nodes.filter((node) => visibleNodeIds.has(node.id));

    const visibleEdges = edges.filter((edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target));
    const { highlightedNodeIds, highlightedEdgeIds } = highlightPath && selectedNodeId
      ? derivePathHighlights(selectedNodeId, visibleEdges)
      : { highlightedNodeIds: new Set<string>(), highlightedEdgeIds: new Set<string>() };

    return { visibleNodes, visibleEdges, highlightedNodeIds, highlightedEdgeIds, searchMatchedNodeIds };
  }, [runState, query, selectedNodeId, statusFilter, showAnalyze, showImplement, highlightPath]);

  const selectedNode = useMemo(
    () => runState?.nodes.find((node) => node.id === selectedNodeId) ?? null,
    [runState, selectedNodeId],
  );

  return (
    <main className="app-root">
      <div className="aurora" />

      <HeaderStats runState={runState} loading={loading} error={error} />

      <section className="control-row">
        <label>
          Workspace root
          <input value={workspaceRoot} onChange={(event) => setWorkspaceRoot(event.target.value)} />
        </label>
        <label>
          Autonomy dir
          <input value={autonomyDir} onChange={(event) => setAutonomyDir(event.target.value)} />
        </label>
        <label>
          Poll (ms)
          <input
            type="number"
            min={500}
            step={500}
            value={pollMs}
            onChange={(event) => setPollMs(Number(event.target.value) || 2000)}
          />
        </label>
        <label>
          Transport
          <select value={transport} onChange={(event) => setTransport(event.target.value as "stream" | "poll")}>
            <option value="stream">stream (SSE)</option>
            <option value="poll">poll</option>
          </select>
        </label>
        <div className="control-actions">
          <button type="button" onClick={() => void loadState()}>
            Refresh now
          </button>
          <button type="button" onClick={() => setPaused((current) => !current)} className={paused ? "warn" : ""}>
            {paused ? "Resume" : "Pause"}
          </button>
        </div>
      </section>

      <section className="filter-row">
        <label className="search-box">
          Search module
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="id or title" />
        </label>
        <div className="toggle-cluster">
          {statuses.map((status) => (
            <button
              key={status}
              type="button"
              className={statusFilter[status] ? "is-on" : "is-off"}
              onClick={() => setStatusFilter((current) => ({ ...current, [status]: !current[status] }))}
            >
              {status}
            </button>
          ))}
        </div>
        <div className="toggle-cluster">
          <button type="button" className={showAnalyze ? "is-on" : "is-off"} onClick={() => setShowAnalyze((v) => !v)}>
            analyze
          </button>
          <button type="button" className={showImplement ? "is-on" : "is-off"} onClick={() => setShowImplement((v) => !v)}>
            implement
          </button>
          <button
            type="button"
            className={highlightPath ? "is-on" : "is-off"}
            onClick={() => setHighlightPath((v) => !v)}
          >
            path highlight
          </button>
          <button
            type="button"
            className={dimOutsidePath ? "is-on" : "is-off"}
            onClick={() => setDimOutsidePath((v) => !v)}
          >
            dim others
          </button>
        </div>
      </section>

      <section className="workspace-grid">
        <GraphCanvas
          nodes={graphView.visibleNodes}
          edges={graphView.visibleEdges}
          selectedNodeId={selectedNodeId}
          highlightedNodeIds={graphView.highlightedNodeIds}
          highlightedEdgeIds={graphView.highlightedEdgeIds}
          searchMatchedNodeIds={graphView.searchMatchedNodeIds}
          dimOutsidePath={dimOutsidePath}
          onSelectNode={setSelectedNodeId}
        />
        <InspectorPanel selected={selectedNode} runState={runState} />
      </section>

      <footer className="footer-row">
        <StatusLegend />
        <p>
          {paused
            ? "updates paused"
            : transport === "stream"
              ? `live stream every ~${Math.max(500, pollMs)}ms`
              : `polling every ${Math.max(500, pollMs)}ms`}
        </p>
      </footer>
    </main>
  );
}

function derivePathHighlights(
  selectedNodeId: string,
  edges: EdgeRef[],
): { highlightedNodeIds: Set<string>; highlightedEdgeIds: Set<string> } {
  const incoming = new Map<string, EdgeRef[]>();
  const outgoing = new Map<string, EdgeRef[]>();
  for (const edge of edges) {
    const inList = incoming.get(edge.target) ?? [];
    inList.push(edge);
    incoming.set(edge.target, inList);

    const outList = outgoing.get(edge.source) ?? [];
    outList.push(edge);
    outgoing.set(edge.source, outList);
  }

  const highlightedNodeIds = new Set<string>([selectedNodeId]);
  const highlightedEdgeIds = new Set<string>();

  const walk = (seed: string, direction: "incoming" | "outgoing") => {
    const stack = [seed];
    const seen = new Set<string>([seed]);

    while (stack.length > 0) {
      const current = stack.pop() as string;
      const list = direction === "incoming" ? incoming.get(current) ?? [] : outgoing.get(current) ?? [];
      for (const edge of list) {
        const next = direction === "incoming" ? edge.source : edge.target;
        highlightedNodeIds.add(next);
        highlightedEdgeIds.add(edge.id);
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
  };

  walk(selectedNodeId, "incoming");
  walk(selectedNodeId, "outgoing");

  return { highlightedNodeIds, highlightedEdgeIds };
}
