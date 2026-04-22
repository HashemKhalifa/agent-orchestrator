import { useMemo } from "react";
import dagre from "@dagrejs/dagre";
import {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  type Edge,
  type Node,
  type NodeMouseHandler,
} from "@xyflow/react";
import type { EdgeRef, NodeState } from "../types";
import { ModuleNodeCard, type GraphNodeData, type PathRole } from "./ModuleNodeCard";
import { statusColor } from "./graphTheme";

const NODE_WIDTH = 324;
const NODE_HEIGHT = 178;

interface GraphCanvasProps {
  nodes: NodeState[];
  edges: EdgeRef[];
  selectedNodeId: string | null;
  highlightedNodeIds: Set<string>;
  highlightedEdgeIds: Set<string>;
  searchMatchedNodeIds: Set<string>;
  dimOutsidePath: boolean;
  compactMode: boolean;
  onSelectNode: (nodeId: string | null) => void;
}

const nodeTypes = { moduleNode: ModuleNodeCard };

export function GraphCanvas(props: GraphCanvasProps): JSX.Element {
  const graph = useMemo(
    () => buildGraph(props),
    [
      props.nodes,
      props.edges,
      props.selectedNodeId,
      props.highlightedNodeIds,
      props.highlightedEdgeIds,
      props.searchMatchedNodeIds,
      props.dimOutsidePath,
      props.compactMode,
    ],
  );

  const onNodeClick: NodeMouseHandler<Node<GraphNodeData>> = (_event, node) => {
    props.onSelectNode(node.id);
  };

  return (
    <section className="graph-shell">
      <ReactFlow<Node<GraphNodeData>, Edge>
        nodes={graph.nodes}
        edges={graph.edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1.05 }}
        minZoom={0.2}
        maxZoom={1.8}
        onNodeClick={onNodeClick}
        onPaneClick={() => props.onSelectNode(null)}
      >
        <Background gap={24} color="rgba(129, 154, 196, 0.14)" />
        <MiniMap
          pannable
          zoomable
          nodeColor={(node) => {
            const module = (node.data as GraphNodeData | undefined)?.module;
            return module ? statusColor(module.status) : "#6f83a8";
          }}
          style={{
            backgroundColor: "rgba(8, 17, 36, 0.9)",
            border: "1px solid rgba(121, 149, 196, 0.25)",
          }}
        />
        <Controls />
      </ReactFlow>
    </section>
  );
}

function buildGraph(args: GraphCanvasProps): { nodes: Array<Node<GraphNodeData>>; edges: Edge[] } {
  if (args.nodes.length === 0) return { nodes: [], edges: [] };

  const graph = new dagre.graphlib.Graph();
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({
    rankdir: "LR",
    ranksep: 140,
    nodesep: 56,
    marginx: 24,
    marginy: 24,
    ranker: "network-simplex",
    acyclicer: "greedy",
  });

  const nodeWidth = args.compactMode ? 214 : NODE_WIDTH;
  const nodeHeight = args.compactMode ? 62 : NODE_HEIGHT;
  for (const module of args.nodes) {
    graph.setNode(module.id, { width: nodeWidth, height: nodeHeight });
  }
  for (const edge of args.edges) {
    graph.setEdge(edge.source, edge.target);
  }

  dagre.layout(graph);

  const hasPathHighlights = args.highlightedNodeIds.size > 0;
  const nodes: Array<Node<GraphNodeData>> = args.nodes.map((module, index) => {
    const point = graph.node(module.id) as { x: number; y: number } | undefined;
    const emphasized = hasPathHighlights ? args.highlightedNodeIds.has(module.id) : true;
    const selected = args.selectedNodeId === module.id;
    const pathRole = resolvePathRole(module.id, args.selectedNodeId, args.highlightedNodeIds, args.edges);
    const dimmed = args.dimOutsidePath && hasPathHighlights && !emphasized;

    return {
      id: module.id,
      type: "moduleNode",
      draggable: false,
      selectable: true,
      position: point
        ? { x: point.x - nodeWidth / 2, y: point.y - nodeHeight / 2 }
        : { x: module.level * 280, y: index * (nodeHeight + 18) },
      data: {
        module,
        emphasized: selected || emphasized,
        dimmed,
        pathRole: selected ? "selected" : pathRole,
        searchMatched: args.searchMatchedNodeIds.has(module.id),
        compact: args.compactMode,
      },
    };
  });

  const edges: Edge[] = args.edges.map((edge) => {
    const highlighted = args.highlightedEdgeIds.has(edge.id);
    const muted = args.dimOutsidePath && hasPathHighlights && !highlighted;
    const stroke = edgeStroke(edge.kind, highlighted);
    const dashed = edge.kind === "soft_depends_on";

    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: "smoothstep",
      markerEnd: {
        type: MarkerType.ArrowClosed,
        width: highlighted ? 14 : 12,
        height: highlighted ? 14 : 12,
        color: stroke,
      },
      animated: highlighted,
      style: {
        stroke,
        strokeWidth: highlighted ? 2.2 : 1.4,
        strokeDasharray: dashed ? "6 5" : undefined,
        opacity: muted ? 0.2 : 0.95,
      },
    };
  });

  return { nodes, edges };
}

function resolvePathRole(
  moduleId: string,
  selectedNodeId: string | null,
  highlightedNodeIds: Set<string>,
  edges: EdgeRef[],
): PathRole {
  if (!selectedNodeId || !highlightedNodeIds.has(moduleId) || moduleId === selectedNodeId) return "none";
  const edgeToSelected = edges.some((edge) => edge.source === moduleId && edge.target === selectedNodeId);
  if (edgeToSelected) return "upstream";
  const edgeFromSelected = edges.some((edge) => edge.source === selectedNodeId && edge.target === moduleId);
  if (edgeFromSelected) return "downstream";

  const touchesInbound = edges.some((edge) => edge.source === moduleId && highlightedNodeIds.has(edge.target));
  if (touchesInbound) return "upstream";
  return "downstream";
}

function edgeStroke(kind: EdgeRef["kind"], highlighted: boolean): string {
  if (highlighted) return "rgba(142, 219, 255, 0.95)";
  if (kind === "repair") return "rgba(255, 184, 96, 0.9)";
  if (kind === "policy_guard") return "rgba(120, 207, 173, 0.9)";
  if (kind === "soft_depends_on") return "rgba(173, 187, 220, 0.8)";
  return "rgba(127, 154, 196, 0.56)";
}
