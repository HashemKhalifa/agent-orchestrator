import { z } from "zod";
import {
  DagDependencyModeSchema,
  DagManifestSchema,
  type DagManifest,
  type DagModule,
} from "./types.js";

export const GraphModeSchema = z.enum(["v1", "v2", "auto"]);
export type GraphMode = z.infer<typeof GraphModeSchema>;

export const GraphNodeKindV2Schema = z.enum(["module", "gate", "policy"]);
export const GraphEdgeKindV2Schema = z.enum(["depends_on", "soft_depends_on", "repair", "policy_guard"]);

export const GraphNodeExecutionV2Schema = z.object({
  partPath: z.string().trim().min(1),
  command: z.string().trim().min(1).nullable().default(null),
});

export const GraphNodeV2Schema = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  mode: z.enum(["analyze", "implement"]),
  kind: GraphNodeKindV2Schema,
  entryGroup: z.string().trim().min(1).nullable().default(null),
  lockKeys: z.array(z.string().trim().min(1)).default([]),
  level: z.number().int().nonnegative(),
  execution: GraphNodeExecutionV2Schema,
  dependsOn: z.array(z.string().trim().min(1)).default([]),
});

export const GraphEdgeV2Schema = z.object({
  id: z.string().trim().min(1),
  source: z.string().trim().min(1),
  target: z.string().trim().min(1),
  kind: GraphEdgeKindV2Schema.default("depends_on"),
  blocking: z.boolean().default(true),
  rationale: z.string().trim().min(1).nullable().default(null),
});

export const GraphManifestV2Schema = z.object({
  schemaVersion: z.literal("2.0"),
  name: z.string().trim().min(1),
  description: z.string().trim().min(1),
  requestPath: z.string().trim().min(1),
  generatedAt: z.string().trim().min(1),
  dependencyMode: DagDependencyModeSchema,
  nodes: z.array(GraphNodeV2Schema).min(1),
  edges: z.array(GraphEdgeV2Schema).default([]),
});

export const GraphNodeStatusV2Schema = z.enum(["pending", "ready", "running", "blocked", "success", "failed", "skipped"]);

export const GraphNodeRuntimeV2Schema = z.object({
  id: z.string().trim().min(1),
  status: GraphNodeStatusV2Schema,
  attempt: z.number().int().positive().nullable().default(null),
  code: z.number().int().nullable().default(null),
  durationMs: z.number().int().nonnegative().nullable().default(null),
  artifactPath: z.string().trim().min(1).nullable().default(null),
  repairTaskPath: z.string().trim().min(1).nullable().default(null),
  updatedAt: z.string().trim().min(1).nullable().default(null),
});

export const GraphRunSnapshotV2Schema = z.object({
  schemaVersion: z.literal("2.0"),
  runId: z.string().trim().min(1).nullable().default(null),
  graphMode: z.enum(["v1", "v2", "auto"]).default("v2"),
  graphPath: z.string().trim().min(1).nullable().default(null),
  manifestPath: z.string().trim().min(1).nullable().default(null),
  startedAt: z.string().trim().min(1).nullable().default(null),
  completedAt: z.string().trim().min(1).nullable().default(null),
  status: z.enum(["success", "partial_failure", "failure", "unknown"]).default("unknown"),
  frontier: z.object({
    ready: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
    running: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
  }),
  counts: z.object({
    success: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
  nodes: z.array(GraphNodeRuntimeV2Schema),
});

export const GraphNodeStateSnapshotV2Schema = z.object({
  schemaVersion: z.literal("2.0"),
  runId: z.string().trim().min(1).nullable().default(null),
  graphPath: z.string().trim().min(1).nullable().default(null),
  generatedAt: z.string().trim().min(1),
  nodes: z.array(z.object({
    id: z.string().trim().min(1),
    title: z.string().trim().min(1),
    kind: GraphNodeKindV2Schema,
    entryGroup: z.string().trim().min(1).nullable().default(null),
    mode: z.enum(["analyze", "implement"]),
    level: z.number().int().nonnegative(),
    lockKeys: z.array(z.string().trim().min(1)).default([]),
    dependsOn: z.array(z.string().trim().min(1)).default([]),
    status: GraphNodeStatusV2Schema,
    attempt: z.number().int().positive().nullable().default(null),
    code: z.number().int().nullable().default(null),
    durationMs: z.number().int().nonnegative().nullable().default(null),
    artifactPath: z.string().trim().min(1).nullable().default(null),
    repairTaskPath: z.string().trim().min(1).nullable().default(null),
    updatedAt: z.string().trim().min(1).nullable().default(null),
  })),
});

export type GraphNodeKindV2 = z.infer<typeof GraphNodeKindV2Schema>;
export type GraphNodeV2 = z.infer<typeof GraphNodeV2Schema>;
export type GraphEdgeV2 = z.infer<typeof GraphEdgeV2Schema>;
export type GraphManifestV2 = z.infer<typeof GraphManifestV2Schema>;
export type GraphNodeStatusV2 = z.infer<typeof GraphNodeStatusV2Schema>;
export type GraphRunSnapshotV2 = z.infer<typeof GraphRunSnapshotV2Schema>;
export type GraphNodeStateSnapshotV2 = z.infer<typeof GraphNodeStateSnapshotV2Schema>;

export interface GraphV2RecipeContext {
  policyPackIds?: string[];
  injectPolicyAnchors?: boolean;
}

export function manifestV1ToGraphV2(
  manifest: DagManifest,
  recipeContext?: GraphV2RecipeContext,
): GraphManifestV2 {
  const nodes: GraphNodeV2[] = manifest.modules.map((module) => {
    const kind = normalizeNodeKind(module.kind) ?? inferNodeKind(module);
    const entryGroup = normalizeEntryGroup(module.entryGroup) ?? inferEntryGroup(module, kind);
    return GraphNodeV2Schema.parse({
      id: module.id,
      title: module.title,
      description: module.description,
      mode: module.mode,
      kind,
      entryGroup,
      lockKeys: module.resources,
      level: module.level,
      execution: {
        partPath: module.partPath,
        command: module.command ?? null,
      },
      dependsOn: module.dependsOn,
    });
  });

  const edges: GraphEdgeV2[] = manifest.modules.flatMap((module) =>
    module.dependsOn.map((dep) =>
      GraphEdgeV2Schema.parse({
        id: `${dep}->${module.id}:depends_on`,
        source: dep,
        target: module.id,
        kind: "depends_on",
        blocking: true,
        rationale: "v1 dependsOn projection",
      })
    ),
  );

  const graph = GraphManifestV2Schema.parse({
    schemaVersion: "2.0",
    name: manifest.name,
    description: manifest.description,
    requestPath: manifest.requestPath,
    generatedAt: manifest.generatedAt,
    dependencyMode: manifest.dependencyMode,
    nodes,
    edges,
  });

  if (recipeContext?.injectPolicyAnchors && Array.isArray(recipeContext.policyPackIds)) {
    return injectPolicyAnchors(graph, recipeContext.policyPackIds);
  }

  return graph;
}

export function graphV2ToManifestV1(graph: GraphManifestV2): DagManifest {
  const edgesByTarget = new Map<string, GraphEdgeV2[]>();
  for (const edge of graph.edges) {
    const list = edgesByTarget.get(edge.target) ?? [];
    list.push(edge);
    edgesByTarget.set(edge.target, list);
  }

  const modules: DagModule[] = graph.nodes.map((node) => {
    const derivedDependsOn = (edgesByTarget.get(node.id) ?? [])
      .filter((edge) => edge.blocking && (edge.kind === "depends_on" || edge.kind === "soft_depends_on"))
      .map((edge) => edge.source);
    const canonicalDependsOn = derivedDependsOn.length > 0 ? derivedDependsOn : node.dependsOn;

    return {
      id: node.id,
      title: node.title,
      description: node.description,
      partPath: node.execution.partPath,
      mode: node.mode,
      kind: node.kind,
      entryGroup: node.entryGroup ?? undefined,
      level: node.level,
      dependsOn: Array.from(new Set(canonicalDependsOn)),
      resources: node.lockKeys,
      command: node.execution.command ?? undefined,
    };
  });

  return DagManifestSchema.parse({
    schemaVersion: "1.0",
    name: graph.name,
    description: graph.description,
    requestPath: graph.requestPath,
    generatedAt: graph.generatedAt,
    dependencyMode: graph.dependencyMode,
    modules,
  });
}

function injectPolicyAnchors(graph: GraphManifestV2, policyPackIds: string[]): GraphManifestV2 {
  const seenNodeIds = new Set(graph.nodes.map((node) => node.id));
  const gateTargets = graph.nodes
    .filter((node) => node.kind === "gate")
    .map((node) => node.id);
  const fallbackTargets = gateTargets.length > 0
    ? gateTargets
    : graph.nodes.filter((node) => node.mode === "implement").map((node) => node.id);

  const nextNodes = graph.nodes.slice();
  const nextEdges = graph.edges.slice();

  for (const packIdRaw of policyPackIds) {
    const packId = packIdRaw.trim();
    if (!packId) continue;
    const nodeId = `policy:${slug(packId)}`;
    if (!seenNodeIds.has(nodeId)) {
      seenNodeIds.add(nodeId);
      nextNodes.push(GraphNodeV2Schema.parse({
        id: nodeId,
        title: `Policy Pack: ${packId}`,
        description: `Synthetic policy anchor for policy pack '${packId}'.`,
        mode: "analyze",
        kind: "policy",
        entryGroup: "governance",
        lockKeys: [],
        level: 0,
        execution: {
          partPath: graph.requestPath,
          command: null,
        },
        dependsOn: [],
      }));
    }

    for (const target of fallbackTargets) {
      nextEdges.push(GraphEdgeV2Schema.parse({
        id: `${nodeId}->${target}:policy_guard`,
        source: nodeId,
        target,
        kind: "policy_guard",
        blocking: true,
        rationale: `policy pack '${packId}' gate`,
      }));
    }
  }

  return GraphManifestV2Schema.parse({
    ...graph,
    nodes: nextNodes,
    edges: dedupeEdges(nextEdges),
  });
}

function dedupeEdges(edges: GraphEdgeV2[]): GraphEdgeV2[] {
  const out = new Map<string, GraphEdgeV2>();
  for (const edge of edges) {
    const key = `${edge.source}|${edge.target}|${edge.kind}|${edge.blocking ? "1" : "0"}`;
    if (!out.has(key)) {
      out.set(key, edge);
    }
  }
  return Array.from(out.values());
}

function normalizeNodeKind(value: unknown): GraphNodeKindV2 | null {
  if (value === "module" || value === "gate" || value === "policy") {
    return value;
  }
  return null;
}

function normalizeEntryGroup(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function inferNodeKind(module: Pick<DagModule, "title" | "mode">): GraphNodeKindV2 {
  const title = module.title.toLowerCase();
  if (
    title.includes("gate") ||
    title.includes("verify") ||
    title.includes("validation") ||
    title.includes("acceptance")
  ) {
    return "gate";
  }
  if (title.includes("policy")) return "policy";
  return "module";
}

function inferEntryGroup(module: Pick<DagModule, "title" | "mode">, kind: GraphNodeKindV2): string {
  if (kind === "policy" || kind === "gate") return "governance";
  if (module.mode === "analyze") return "core-context";
  return `workstream:${slug(module.title)}`;
}

function slug(input: string): string {
  const normalized = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36);
  return normalized || "node";
}
