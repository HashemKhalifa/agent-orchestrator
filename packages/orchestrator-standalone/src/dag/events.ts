import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  GraphNodeStateSnapshotV2Schema,
  GraphRunSnapshotV2Schema,
  type GraphManifestV2,
  type GraphNodeStatusV2,
  type GraphNodeStateSnapshotV2,
  type GraphRunSnapshotV2,
} from "./graph-v2.js";

export const DagRunEventBaseSchema = z.object({
  runId: z.string().trim().min(1),
  at: z.string().trim().min(1),
});

export const DagRunStartedEventSchema = DagRunEventBaseSchema.extend({
  type: z.literal("run_started"),
  manifestPath: z.string().trim().min(1),
  graphPath: z.string().trim().min(1).nullable().default(null),
  moduleCount: z.number().int().nonnegative(),
});

export const DagNodeStartedEventSchema = DagRunEventBaseSchema.extend({
  type: z.literal("node_started"),
  nodeId: z.string().trim().min(1),
  attempt: z.number().int().positive(),
});

export const DagNodeCompletedEventSchema = DagRunEventBaseSchema.extend({
  type: z.literal("node_completed"),
  nodeId: z.string().trim().min(1),
  attempt: z.number().int().positive(),
  status: z.enum(["success", "failed", "blocked", "skipped"]),
  code: z.number().int().nullable().default(null),
  durationMs: z.number().int().nonnegative().default(0),
  artifactPath: z.string().trim().min(1).nullable().default(null),
  repairTaskPath: z.string().trim().min(1).nullable().default(null),
});

export const DagRepairGeneratedEventSchema = DagRunEventBaseSchema.extend({
  type: z.literal("repair_generated"),
  nodeId: z.string().trim().min(1),
  attempt: z.number().int().positive(),
  repairTaskPath: z.string().trim().min(1),
});

export const DagCriticEvaluatedEventSchema = DagRunEventBaseSchema.extend({
  type: z.literal("critic_evaluated"),
  nodeId: z.string().trim().min(1),
  attempt: z.number().int().positive(),
  passed: z.boolean(),
  severity: z.enum(["info", "warning", "blocker"]).nullable().default(null),
  findingCount: z.number().int().nonnegative().default(0),
});

export const DagBudgetExhaustedEventSchema = DagRunEventBaseSchema.extend({
  type: z.literal("budget_exhausted"),
  reasons: z.array(z.string().trim().min(1)).default([]),
});

export const DagRunCompletedEventSchema = DagRunEventBaseSchema.extend({
  type: z.literal("run_completed"),
  status: z.enum(["success", "partial_failure", "failure"]),
  successCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
  blockedCount: z.number().int().nonnegative(),
  skippedCount: z.number().int().nonnegative(),
  totalCount: z.number().int().nonnegative(),
});

export const DagRunEventSchema = z.discriminatedUnion("type", [
  DagRunStartedEventSchema,
  DagNodeStartedEventSchema,
  DagNodeCompletedEventSchema,
  DagRepairGeneratedEventSchema,
  DagCriticEvaluatedEventSchema,
  DagBudgetExhaustedEventSchema,
  DagRunCompletedEventSchema,
]);

export type DagRunEvent = z.infer<typeof DagRunEventSchema>;

interface RuntimeNodeState {
  status: GraphNodeStatusV2;
  attempt: number | null;
  code: number | null;
  durationMs: number | null;
  artifactPath: string | null;
  repairTaskPath: string | null;
  updatedAt: string | null;
}

export function appendDagRunEventFile(filePath: string, event: DagRunEvent): void {
  const parsed = DagRunEventSchema.parse(event);
  mkdirSync(path.dirname(filePath), { recursive: true });
  appendFileSync(filePath, `${JSON.stringify(parsed)}\n`, "utf8");
}

export function readDagRunEventsFromFile(filePath: string): {
  events: DagRunEvent[];
  errors: string[];
} {
  if (!existsSync(filePath)) {
    return { events: [], errors: [] };
  }

  const raw = readFileSync(filePath, "utf8");
  const lines = raw.split("\n");
  const events: DagRunEvent[] = [];
  const errors: string[] = [];
  const hasTrailingNewline = raw.endsWith("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line || line.trim().length === 0) continue;
    try {
      const parsed = DagRunEventSchema.parse(JSON.parse(line));
      events.push(parsed);
    } catch (error) {
      const isTrailingTruncate = index === lines.length - 1 && !hasTrailingNewline;
      if (isTrailingTruncate) continue;
      errors.push(`events parse error at line ${index + 1}: ${(error as Error).message}`);
    }
  }

  return { events, errors };
}

export function materializeDagRunSnapshots(args: {
  graph: GraphManifestV2;
  events: DagRunEvent[];
  runId: string;
  graphMode?: "v1" | "v2" | "auto";
  graphPath?: string | null;
  manifestPath?: string | null;
  processActive?: boolean;
}): {
  runSummary: GraphRunSnapshotV2;
  nodeState: GraphNodeStateSnapshotV2;
} {
  const runtimeByNode = new Map<string, RuntimeNodeState>();
  for (const node of args.graph.nodes) {
    runtimeByNode.set(node.id, {
      status: "pending",
      attempt: null,
      code: null,
      durationMs: null,
      artifactPath: null,
      repairTaskPath: null,
      updatedAt: null,
    });
  }

  let startedAt: string | null = null;
  let completedAt: string | null = null;
  let runStatus: "success" | "partial_failure" | "failure" | "unknown" = "unknown";
  let budgetExhaustedReasons: string[] = [];

  for (const event of args.events) {
    if (event.type === "run_started") {
      startedAt = event.at;
      continue;
    }

    if (event.type === "node_started") {
      const state = runtimeByNode.get(event.nodeId);
      if (!state) continue;
      state.status = "running";
      state.attempt = event.attempt;
      state.updatedAt = event.at;
      continue;
    }

    if (event.type === "node_completed") {
      const state = runtimeByNode.get(event.nodeId);
      if (!state) continue;
      state.status = event.status;
      state.attempt = event.attempt;
      state.code = event.code;
      state.durationMs = event.durationMs;
      state.artifactPath = event.artifactPath;
      state.repairTaskPath = event.repairTaskPath;
      state.updatedAt = event.at;
      continue;
    }

    if (event.type === "repair_generated") {
      const state = runtimeByNode.get(event.nodeId);
      if (!state) continue;
      state.repairTaskPath = event.repairTaskPath;
      state.updatedAt = event.at;
      continue;
    }

    if (event.type === "budget_exhausted") {
      budgetExhaustedReasons = event.reasons.slice();
      continue;
    }

    if (event.type === "run_completed") {
      completedAt = event.at;
      runStatus = event.status;
      continue;
    }
  }

  const completedStatuses = new Set<GraphNodeStatusV2>(["success", "failed", "skipped"]);
  const dependencyMap = new Map(args.graph.nodes.map((node) => [node.id, node.dependsOn]));

  if (!args.processActive) {
    for (const [nodeId, state] of runtimeByNode.entries()) {
      if (state.status !== "running") continue;
      const deps = dependencyMap.get(nodeId) ?? [];
      const depStates = deps.map((dep) => runtimeByNode.get(dep)?.status ?? "pending");
      const hasFailedDep = depStates.some((status) => status === "failed" || status === "blocked");
      const allDepsDone = depStates.every((status) => completedStatuses.has(status));
      state.status = hasFailedDep ? "blocked" : allDepsDone ? "ready" : "pending";
    }
  }

  let ready = 0;
  let blocked = 0;
  let running = 0;
  let completed = 0;
  let pending = 0;
  let successCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  let blockedCount = 0;

  for (const node of args.graph.nodes) {
    const state = runtimeByNode.get(node.id) as RuntimeNodeState;
    const deps = dependencyMap.get(node.id) ?? [];
    const depStates = deps.map((dep) => runtimeByNode.get(dep)?.status ?? "pending");
    const hasFailedDep = depStates.some((status) => status === "failed" || status === "blocked");
    const allDepsDone = depStates.every((status) => completedStatuses.has(status));

    if (state.status === "pending") {
      if (hasFailedDep) state.status = "blocked";
      else if (allDepsDone) state.status = "ready";
    }

    if (state.status === "ready") ready += 1;
    else if (state.status === "running") running += 1;
    else if (state.status === "blocked") blocked += 1;
    else if (state.status === "pending") pending += 1;
    else completed += 1;

    if (state.status === "success") successCount += 1;
    else if (state.status === "failed") failedCount += 1;
    else if (state.status === "skipped") skippedCount += 1;
    else if (state.status === "blocked") blockedCount += 1;
  }

  if (runStatus === "unknown") {
    runStatus =
      failedCount > 0
        ? successCount === 0
          ? "failure"
          : "partial_failure"
        : blockedCount > 0
        ? "partial_failure"
        : successCount > 0
        ? "success"
        : "unknown";
  }

  if (budgetExhaustedReasons.length > 0 && blocked === 0 && pending > 0) {
    blocked += pending;
    pending = 0;
  }

  const runtimeNodes = args.graph.nodes.map((node) => {
    const state = runtimeByNode.get(node.id) as RuntimeNodeState;
    return {
      id: node.id,
      status: state.status,
      attempt: state.attempt,
      code: state.code,
      durationMs: state.durationMs,
      artifactPath: state.artifactPath,
      repairTaskPath: state.repairTaskPath,
      updatedAt: state.updatedAt,
    };
  });

  const runSummary = GraphRunSnapshotV2Schema.parse({
    schemaVersion: "2.0",
    runId: args.runId,
    graphMode: args.graphMode ?? "v2",
    graphPath: args.graphPath ?? null,
    manifestPath: args.manifestPath ?? null,
    startedAt,
    completedAt,
    status: runStatus,
    frontier: {
      ready,
      blocked,
      running,
      completed,
      pending,
    },
    counts: {
      success: successCount,
      failed: failedCount,
      skipped: skippedCount,
      blocked: blockedCount,
      total: args.graph.nodes.length,
    },
    nodes: runtimeNodes,
  });

  const nodeState = GraphNodeStateSnapshotV2Schema.parse({
    schemaVersion: "2.0",
    runId: args.runId,
    graphPath: args.graphPath ?? null,
    generatedAt: new Date().toISOString(),
    nodes: args.graph.nodes.map((node) => {
      const runtime = runtimeByNode.get(node.id) as RuntimeNodeState;
      return {
        id: node.id,
        title: node.title,
        kind: node.kind,
        entryGroup: node.entryGroup,
        mode: node.mode,
        level: node.level,
        lockKeys: node.lockKeys,
        dependsOn: node.dependsOn,
        status: runtime.status,
        attempt: runtime.attempt,
        code: runtime.code,
        durationMs: runtime.durationMs,
        artifactPath: runtime.artifactPath,
        repairTaskPath: runtime.repairTaskPath,
        updatedAt: runtime.updatedAt,
      };
    }),
  });

  return { runSummary, nodeState };
}
