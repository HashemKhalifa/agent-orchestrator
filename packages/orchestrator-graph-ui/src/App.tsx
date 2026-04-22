import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
const INITIAL_MODE = asGraphMode(INITIAL_QUERY?.get("mode") ?? null) ?? "auto";
const INITIAL_RUN_ID = INITIAL_QUERY?.get("runId")?.trim() || "";

const statuses: ModuleStatus[] = ["success", "failed", "blocked", "skipped", "pending"];
const edgeKinds = ["depends_on", "soft_depends_on", "repair", "policy_guard"] as const;
type EdgeKind = (typeof edgeKinds)[number];
type PathMode = "none" | "upstream" | "downstream";
type ViewPreset = "overview" | "dependencies" | "focus";

type StatusFilter = Record<ModuleStatus, boolean>;
type EdgeFilter = Record<EdgeKind, boolean>;

const defaultStatusFilter: StatusFilter = {
  success: true,
  failed: true,
  blocked: true,
  skipped: true,
  pending: true,
};

const defaultEdgeFilter: EdgeFilter = {
  depends_on: true,
  soft_depends_on: true,
  repair: true,
  policy_guard: true,
};

const edgeKindLabels: Record<EdgeKind, string> = {
  depends_on: "Chunk Import",
  soft_depends_on: "Delegation",
  repair: "Agent Needs",
  policy_guard: "Context Share",
};

const screenshotLegendOnly = [
  { id: "group_membership", label: "Group Membership", tone: "neutral" },
  { id: "chunk_agent", label: "Chunk -> Agent", tone: "neutral" },
  { id: "chunk_asset", label: "Chunk -> Asset", tone: "neutral" },
  { id: "asset_link", label: "Asset Link", tone: "green" },
  { id: "agent_produces", label: "Agent Produces", tone: "green" },
] as const;

export default function App(): JSX.Element {
  const [workspaceRoot, setWorkspaceRoot] = useState(INITIAL_WORKSPACE_ROOT);
  const [autonomyDir, setAutonomyDir] = useState(INITIAL_AUTONOMY_DIR);
  const [graphMode, setGraphMode] = useState<"v1" | "v2" | "auto">(INITIAL_MODE);
  const [runId, setRunId] = useState(INITIAL_RUN_ID);
  const [pollMs, setPollMs] = useState(2000);
  const [paused, setPaused] = useState(false);
  const [transport, setTransport] = useState<"stream" | "poll">("stream");

  const [runState, setRunState] = useState<RunStateResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(defaultStatusFilter);
  const [edgeFilter, setEdgeFilter] = useState<EdgeFilter>(defaultEdgeFilter);
  const [showAnalyze, setShowAnalyze] = useState(true);
  const [showImplement, setShowImplement] = useState(true);
  const [pathMode, setPathMode] = useState<PathMode>("none");
  const [dimOutsidePath, setDimOutsidePath] = useState(true);
  const [collapseAll, setCollapseAll] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

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
      const next = await fetchRunState({
        workspaceRoot,
        autonomyDir,
        mode: graphMode,
        runId: runId.trim() || undefined,
      });
      ingestState(next);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      setLoading(false);
    }
  }, [workspaceRoot, autonomyDir, graphMode, runId, ingestState]);

  useEffect(() => {
    void loadState();
  }, [loadState]);

  useEffect(() => {
    const url = new URLSearchParams(window.location.search);
    url.set("workspaceRoot", workspaceRoot);
    url.set("autonomyDir", autonomyDir);
    url.set("mode", graphMode);
    if (runId.trim().length > 0) url.set("runId", runId.trim());
    else url.delete("runId");
    const next = `${window.location.pathname}?${url.toString()}`;
    window.history.replaceState(null, "", next);
  }, [workspaceRoot, autonomyDir, graphMode, runId]);

  useEffect(() => {
    if (paused) return;
    if (transport === "stream") {
      const unsubscribe = subscribeRunState(
        {
          workspaceRoot,
          autonomyDir,
          mode: graphMode,
          runId: runId.trim() || undefined,
          intervalMs: Math.max(500, pollMs),
        },
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
  }, [paused, pollMs, loadState, workspaceRoot, autonomyDir, graphMode, runId, ingestState, transport]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;
      if (event.key === "?") {
        event.preventDefault();
        setShowShortcuts((current) => !current);
        return;
      }
      if (event.key === "Escape") {
        setShowShortcuts(false);
        return;
      }
      if (event.key === "/" || event.key.toLowerCase() === "f") {
        event.preventDefault();
        searchInputRef.current?.focus();
        return;
      }
      if (event.key.toLowerCase() === "c") {
        event.preventDefault();
        setCollapseAll((current) => !current);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const searchMatches = useMemo(() => {
    const nodes = runState?.nodes ?? [];
    const search = query.trim().toLowerCase();
    if (search.length === 0) return [];
    return nodes
      .filter((node) => node.id.toLowerCase().includes(search) || node.title.toLowerCase().includes(search))
      .map((node) => node.id);
  }, [runState, query]);

  useEffect(() => {
    if (searchMatches.length === 0) {
      setMatchIndex(0);
      return;
    }
    const normalized = Math.min(Math.max(0, matchIndex), searchMatches.length - 1);
    if (normalized !== matchIndex) setMatchIndex(normalized);
  }, [searchMatches, matchIndex]);

  const graphView = useMemo(() => {
    const nodes = runState?.nodes ?? [];
    const edges = runState?.edges ?? [];
    const selectedNode = selectedNodeId ? nodes.find((node) => node.id === selectedNodeId) : null;
    const selectedNodeMustBeVisible = selectedNode ? [selectedNode.id] : [];
    const expandedSearchMatches = new Set(searchMatches);

    const filteredNodes = nodes.filter((node) => {
      if (!statusFilter[node.status]) return false;
      if (!showAnalyze && node.mode === "analyze") return false;
      if (!showImplement && node.mode === "implement") return false;
      if (searchMatches.length > 0 && !expandedSearchMatches.has(node.id) && !selectedNodeMustBeVisible.includes(node.id)) {
        return false;
      }
      return true;
    });

    const visibleNodeIds = new Set(filteredNodes.map((node) => node.id));
    for (const id of selectedNodeMustBeVisible) visibleNodeIds.add(id);

    const expandedNodes = nodes.filter((node) => visibleNodeIds.has(node.id));
    const expandedEdges = edges.filter((edge) =>
      visibleNodeIds.has(edge.source) &&
      visibleNodeIds.has(edge.target) &&
      edgeFilter[edge.kind]
    );

    const collapsed = collapseAll ? collapseGraph(expandedNodes, expandedEdges) : null;
    const visibleNodes = collapsed?.nodes ?? expandedNodes;
    const visibleEdges = collapsed?.edges ?? expandedEdges;

    const searchMatchedNodeIds = collapsed
      ? new Set(
        searchMatches
          .map((nodeId) => collapsed.memberToGroupId.get(nodeId))
          .filter((groupId): groupId is string => Boolean(groupId)),
      )
      : expandedSearchMatches;

    const selectedGraphNodeId = collapseAll && selectedNodeId
      ? collapsed?.memberToGroupId.get(selectedNodeId) ?? null
      : selectedNodeId;

    const resolvedSelectedNodeId = selectedGraphNodeId && visibleNodes.some((node) => node.id === selectedGraphNodeId)
      ? selectedGraphNodeId
      : null;

    const path = resolvedSelectedNodeId
      ? derivePathHighlights(resolvedSelectedNodeId, visibleEdges, pathMode)
      : { highlightedNodeIds: new Set<string>(), highlightedEdgeIds: new Set<string>() };

    return {
      visibleNodes,
      visibleEdges,
      selectedGraphNodeId: resolvedSelectedNodeId,
      highlightedNodeIds: path.highlightedNodeIds,
      highlightedEdgeIds: path.highlightedEdgeIds,
      searchMatchedNodeIds,
    };
  }, [
    runState,
    searchMatches,
    selectedNodeId,
    statusFilter,
    edgeFilter,
    showAnalyze,
    showImplement,
    pathMode,
    collapseAll,
  ]);

  const selectedNode = useMemo(
    () => graphView.visibleNodes.find((node) => node.id === graphView.selectedGraphNodeId) ?? null,
    [graphView.visibleNodes, graphView.selectedGraphNodeId],
  );

  const matchedKinds = useMemo(() => {
    const kinds = new Set<EdgeKind>();
    for (const edge of runState?.edges ?? []) {
      kinds.add(edge.kind);
    }
    return edgeKinds.filter((kind) => kinds.has(kind));
  }, [runState]);

  const focusNextMatch = (direction: 1 | -1) => {
    if (searchMatches.length === 0) return;
    const nextIndex = (matchIndex + direction + searchMatches.length) % searchMatches.length;
    setMatchIndex(nextIndex);
    setSelectedNodeId(searchMatches[nextIndex] ?? null);
  };

  const applyPreset = (preset: ViewPreset) => {
    if (preset === "overview") {
      setPathMode("none");
      setDimOutsidePath(false);
      setShowAnalyze(true);
      setShowImplement(true);
      return;
    }
    if (preset === "dependencies") {
      setPathMode("upstream");
      setDimOutsidePath(true);
      return;
    }
    setPathMode("downstream");
    setDimOutsidePath(true);
  };

  const resetGraphView = () => {
    setQuery("");
    setMatchIndex(0);
    setSelectedNodeId(null);
    setPathMode("none");
    setDimOutsidePath(false);
    setShowAnalyze(true);
    setShowImplement(true);
    setStatusFilter(defaultStatusFilter);
    setEdgeFilter(defaultEdgeFilter);
    setCollapseAll(false);
  };

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
          Graph mode
          <select value={graphMode} onChange={(event) => setGraphMode(asGraphMode(event.target.value) ?? "auto")}>
            <option value="auto">auto</option>
            <option value="v1">v1</option>
            <option value="v2">v2</option>
          </select>
        </label>
        <label>
          Run ID (optional)
          <input value={runId} onChange={(event) => setRunId(event.target.value)} placeholder="latest when empty" />
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

      <section className="toolbar-row">
        <label className="search-box">
          <input
            ref={searchInputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search node/chunk/lane"
          />
        </label>
        <button type="button" onClick={() => focusNextMatch(-1)} disabled={searchMatches.length === 0}>Prev</button>
        <button type="button" onClick={() => focusNextMatch(1)} disabled={searchMatches.length === 0}>Next</button>

        <span className="toolbar-group-label">VIEW</span>
        <button type="button" onClick={() => applyPreset("overview")} className={pathMode === "none" ? "is-on" : ""}>Overview</button>
        <button type="button" onClick={() => applyPreset("dependencies")} className={pathMode === "upstream" ? "is-on" : ""}>Dependencies</button>
        <button type="button" onClick={() => applyPreset("focus")} className={pathMode === "downstream" ? "is-on" : ""}>Focus</button>

        <span className="toolbar-group-label">PATH</span>
        <button type="button" className={pathMode === "none" ? "is-on" : ""} onClick={() => setPathMode("none")}>None</button>
        <button type="button" className={pathMode === "upstream" ? "is-on" : ""} onClick={() => setPathMode("upstream")}>Upstream</button>
        <button type="button" className={pathMode === "downstream" ? "is-on" : ""} onClick={() => setPathMode("downstream")}>Downstream</button>

        <button type="button" onClick={resetGraphView}>Clear</button>
        <button type="button" onClick={() => setCollapseAll((current) => !current)}>
          {collapseAll ? "Expand all" : "Collapse all"}
        </button>
      </section>

      <section className="edge-legend-row">
        <span className="toolbar-group-label">Edge Legend</span>
        {matchedKinds.map((kind) => (
          <button
            key={kind}
            type="button"
            className={`legend-chip ${edgeFilter[kind] ? "is-on" : "is-off"} tone-${kind}`}
            onClick={() => setEdgeFilter((current) => ({ ...current, [kind]: !current[kind] }))}
          >
            <span className="legend-dot-mini" />
            {edgeKindLabels[kind]}
          </button>
        ))}
        {screenshotLegendOnly.map((item) => (
          <span key={item.id} className={`legend-chip is-disabled tone-${item.tone}`}>
            <span className="legend-dot-mini" />
            {item.label}
          </span>
        ))}
        <button type="button" onClick={() => setShowShortcuts((current) => !current)}>Shortcuts</button>
        <span className="mini-hint">Press ? for quick keys</span>
      </section>

      <section className="status-row">
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
          <button type="button" className={dimOutsidePath ? "is-on" : "is-off"} onClick={() => setDimOutsidePath((v) => !v)}>
            dim others
          </button>
          <span className="mini-hint">{searchMatches.length === 0 ? "0 matches" : `${matchIndex + 1}/${searchMatches.length}`}</span>
        </div>
      </section>

      <section className="workspace-grid">
        <GraphCanvas
          nodes={graphView.visibleNodes}
          edges={graphView.visibleEdges}
          selectedNodeId={graphView.selectedGraphNodeId}
          highlightedNodeIds={graphView.highlightedNodeIds}
          highlightedEdgeIds={graphView.highlightedEdgeIds}
          searchMatchedNodeIds={graphView.searchMatchedNodeIds}
          dimOutsidePath={dimOutsidePath}
          compactMode={collapseAll}
          onSelectNode={setSelectedNodeId}
        />
        <InspectorPanel selected={selectedNode} runState={runState} />
      </section>

      {showShortcuts ? (
        <section className="shortcuts-modal" role="dialog" aria-modal="true">
          <article>
            <h3>Shortcuts</h3>
            <ul>
              <li><kbd>?</kbd> Toggle shortcuts</li>
              <li><kbd>/</kbd> or <kbd>f</kbd> Focus search</li>
              <li><kbd>c</kbd> Toggle collapse all</li>
              <li><kbd>Esc</kbd> Close modal</li>
            </ul>
            <button type="button" onClick={() => setShowShortcuts(false)}>Close</button>
          </article>
        </section>
      ) : null}

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
  mode: PathMode,
): { highlightedNodeIds: Set<string>; highlightedEdgeIds: Set<string> } {
  if (mode === "none") {
    return { highlightedNodeIds: new Set<string>(), highlightedEdgeIds: new Set<string>() };
  }

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
  const direction = mode === "upstream" ? "incoming" : "outgoing";
  const stack = [selectedNodeId];
  const seen = new Set<string>([selectedNodeId]);

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

  return { highlightedNodeIds, highlightedEdgeIds };
}

function asGraphMode(value: string | null): "v1" | "v2" | "auto" | null {
  if (value === "v1" || value === "v2" || value === "auto") return value;
  return null;
}

function asPathMode(value: string | null): PathMode | null {
  if (value === "none" || value === "upstream" || value === "downstream") return value;
  return null;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || target.isContentEditable;
}

function collapseGraph(
  nodes: NodeState[],
  edges: EdgeRef[],
): { nodes: NodeState[]; edges: EdgeRef[]; memberToGroupId: Map<string, string> } {
  const groups = new Map<string, NodeState[]>();
  const memberToGroupId = new Map<string, string>();

  for (const node of nodes) {
    const groupName = (node.entryGroup?.trim() || node.mode).toLowerCase();
    const groupId = `group:${groupName.replace(/[^a-z0-9_-]+/g, "-")}`;
    const list = groups.get(groupId) ?? [];
    list.push(node);
    groups.set(groupId, list);
    memberToGroupId.set(node.id, groupId);
  }

  const collapsedNodes: NodeState[] = [];
  for (const [groupId, members] of groups) {
    const title = members[0]?.entryGroup || members[0]?.mode || groupId;
    const status = deriveGroupStatus(members);
    const attempt = members.reduce((max, node) => Math.max(max, node.attempt ?? 0), 0);
    const durationMs = members.reduce((sum, node) => sum + (node.durationMs ?? 0), 0);
    const changedFilesCount = members.reduce((sum, node) => sum + (node.changedFilesCount ?? 0), 0);
    const riskNotesCount = members.reduce((sum, node) => sum + (node.riskNotesCount ?? 0), 0);
    const lockKeys = Array.from(new Set(members.flatMap((node) => node.lockKeys)));
    const allAnalyze = members.every((node) => node.mode === "analyze");

    collapsedNodes.push({
      id: groupId,
      title: `${title} (${members.length})`,
      level: Math.min(...members.map((node) => node.level)),
      mode: allAnalyze ? "analyze" : "implement",
      kind: "module",
      entryGroup: title,
      lockKeys,
      dependsOn: [],
      status,
      attempt: attempt > 0 ? attempt : undefined,
      durationMs,
      code: null,
      changedFilesCount,
      riskNotesCount,
      updatedAt: members
        .map((node) => node.updatedAt || "")
        .filter((value) => value.length > 0)
        .sort()
        .at(-1) || null,
    });
  }

  const edgeMap = new Map<string, EdgeRef & { _count: number }>();
  for (const edge of edges) {
    const sourceGroup = memberToGroupId.get(edge.source);
    const targetGroup = memberToGroupId.get(edge.target);
    if (!sourceGroup || !targetGroup || sourceGroup === targetGroup) continue;
    const id = `${sourceGroup}->${targetGroup}:${edge.kind}`;
    const existing = edgeMap.get(id);
    if (!existing) {
      edgeMap.set(id, {
        ...edge,
        id,
        source: sourceGroup,
        target: targetGroup,
        rationale: edge.rationale,
        _count: 1,
      });
      continue;
    }
    existing._count += 1;
    existing.blocking = existing.blocking || edge.blocking;
    if (!existing.rationale && edge.rationale) existing.rationale = edge.rationale;
  }

  const collapsedEdges: EdgeRef[] = Array.from(edgeMap.values()).map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    kind: edge.kind,
    blocking: edge.blocking,
    rationale: edge._count > 1
      ? `${edge._count} aggregated ${edge.kind} edges`
      : edge.rationale ?? edge.kind,
  }));

  const depsByNode = new Map<string, string[]>();
  for (const edge of collapsedEdges) {
    if (!edge.blocking) continue;
    const deps = depsByNode.get(edge.target) ?? [];
    deps.push(edge.source);
    depsByNode.set(edge.target, deps);
  }
  for (const node of collapsedNodes) {
    node.dependsOn = Array.from(new Set(depsByNode.get(node.id) ?? []));
  }

  return { nodes: collapsedNodes, edges: collapsedEdges, memberToGroupId };
}

function deriveGroupStatus(nodes: NodeState[]): ModuleStatus {
  if (nodes.some((node) => node.status === "failed")) return "failed";
  if (nodes.some((node) => node.status === "blocked")) return "blocked";
  if (nodes.some((node) => node.status === "pending")) return "pending";
  if (nodes.some((node) => node.status === "skipped")) return "skipped";
  return "success";
}
