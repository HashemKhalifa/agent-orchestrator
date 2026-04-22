export type ModuleStatus = "success" | "failed" | "blocked" | "skipped" | "pending";
export type RunStatus = "success" | "partial_failure" | "failure" | "unknown";
export type NodeKind = "module" | "gate" | "policy";
export type EdgeKind = "depends_on" | "soft_depends_on" | "repair" | "policy_guard";

export interface ManifestModule {
  id: string;
  title: string;
  description?: string;
  level: number;
  mode: "analyze" | "implement";
  kind?: NodeKind;
  entryGroup?: string | null;
  lockKeys?: string[];
  execution?: {
    partPath?: string;
    command?: string | null;
  };
  dependsOn: string[];
}

export interface ManifestInput {
  modules: ManifestModule[];
  edges?: EdgeInput[];
}

export interface EdgeInput {
  id: string;
  source: string;
  target: string;
  kind?: EdgeKind;
  blocking?: boolean;
  rationale?: string | null;
}

export interface RunResultInput {
  moduleId: string;
  status: ModuleStatus;
  attempt?: number;
  code?: number | null;
  durationMs?: number;
  criticSeverity?: "info" | "warning" | "blocker" | null;
  repairTaskPath?: string | null;
  artifactPath?: string | null;
}

export interface RunSummaryInput {
  status?: RunStatus;
  startedAt?: string;
  completedAt?: string;
  results?: RunResultInput[];
}

export interface ArtifactInput {
  moduleId: string;
  status: ModuleStatus;
  attempt?: number;
  code?: number | null;
  durationMs?: number;
  criticSeverity?: "info" | "warning" | "blocker" | null;
  repairTaskPath?: string | null;
  artifactPath?: string;
  changedFilesCount?: number;
  riskNotesCount?: number;
  updatedAt?: string;
  mtimeMs?: number;
}

export interface NodeState {
  id: string;
  title: string;
  level: number;
  mode: "analyze" | "implement";
  kind: NodeKind;
  entryGroup: string | null;
  lockKeys: string[];
  dependsOn: string[];
  status: ModuleStatus;
  attempt?: number;
  code?: number | null;
  durationMs?: number;
  artifactPath?: string | null;
  repairTaskPath?: string | null;
  riskNotesCount?: number;
  criticSeverity?: "info" | "warning" | "blocker" | null;
  changedFilesCount?: number;
  updatedAt?: string | null;
}

export interface NormalizedRunState {
  run: {
    status: RunStatus;
    startedAt?: string;
    completedAt?: string;
    cursorStep: number;
    totalModules: number;
    successCount: number;
    failedCount: number;
    blockedCount: number;
    skippedCount: number;
  };
  nodes: NodeState[];
  edges: Array<{
    id: string;
    source: string;
    target: string;
    kind: EdgeKind;
    blocking: boolean;
    rationale: string | null;
  }>;
}

export function normalizeRunState(args: {
  manifest: ManifestInput;
  runSummary: RunSummaryInput | null;
  artifacts: Map<string, ArtifactInput>;
  runSummaryMtimeMs: number;
}): NormalizedRunState {
  const resultByModule = new Map<string, RunResultInput>();
  for (const result of args.runSummary?.results ?? []) {
    resultByModule.set(result.moduleId, result);
  }

  const nodes: NodeState[] = args.manifest.modules.map((module) => {
    const result = resultByModule.get(module.id);
    const artifact = args.artifacts.get(module.id);

    let source: RunResultInput | ArtifactInput | null = result ?? null;
    if (artifact) {
      if (!result) {
        source = artifact;
      } else if ((artifact.mtimeMs ?? 0) >= args.runSummaryMtimeMs) {
        source = artifact;
      }
    }

    return {
      id: module.id,
      title: module.title,
      level: module.level,
      mode: module.mode,
      kind: module.kind ?? inferNodeKind(module),
      entryGroup: module.entryGroup ?? inferEntryGroup(module),
      lockKeys: Array.isArray(module.lockKeys) ? module.lockKeys : [],
      dependsOn: module.dependsOn,
      status: source?.status ?? "pending",
      attempt: source?.attempt,
      code: source?.code,
      durationMs: source?.durationMs,
      artifactPath: source?.artifactPath ?? null,
      repairTaskPath: source?.repairTaskPath ?? null,
      riskNotesCount: artifact?.riskNotesCount,
      criticSeverity: source?.criticSeverity ?? null,
      changedFilesCount: artifact?.changedFilesCount,
      updatedAt: artifact?.updatedAt ?? null,
    };
  });

  const fallbackEdges = args.manifest.modules.flatMap((module) =>
    module.dependsOn.map((dep) => ({
      id: `${dep}->${module.id}:depends_on`,
      source: dep,
      target: module.id,
      kind: "depends_on" as const,
      blocking: true,
      rationale: "v1 dependsOn",
    })),
  );
  const edges = Array.isArray(args.manifest.edges) && args.manifest.edges.length > 0
    ? args.manifest.edges.map((edge) => ({
      id: edge.id || `${edge.source}->${edge.target}:${edge.kind ?? "depends_on"}`,
      source: edge.source,
      target: edge.target,
      kind: edge.kind ?? "depends_on",
      blocking: edge.blocking ?? true,
      rationale: edge.rationale ?? null,
    }))
    : fallbackEdges;

  const totalModules = nodes.length;
  const successCount = nodes.filter((node) => node.status === "success").length;
  const failedCount = nodes.filter((node) => node.status === "failed").length;
  const blockedCount = nodes.filter((node) => node.status === "blocked").length;
  const skippedCount = nodes.filter((node) => node.status === "skipped").length;

  const firstNonSuccessIndex = nodes.findIndex((node) => node.status !== "success");
  const cursorStep = totalModules === 0
    ? 0
    : firstNonSuccessIndex === -1
    ? totalModules
    : firstNonSuccessIndex + 1;

  const status = args.runSummary?.status ?? inferRunStatus({
    totalModules,
    successCount,
    failedCount,
    blockedCount,
  });

  return {
    run: {
      status,
      startedAt: args.runSummary?.startedAt,
      completedAt: args.runSummary?.completedAt,
      cursorStep,
      totalModules,
      successCount,
      failedCount,
      blockedCount,
      skippedCount,
    },
    nodes,
    edges,
  };
}

function inferNodeKind(module: ManifestModule): NodeKind {
  const title = module.title.toLowerCase();
  if (title.includes("policy")) return "policy";
  if (
    title.includes("gate") ||
    title.includes("verify") ||
    title.includes("validation") ||
    title.includes("acceptance")
  ) {
    return "gate";
  }
  return "module";
}

function inferEntryGroup(module: ManifestModule): string | null {
  if (module.kind === "policy" || module.kind === "gate") return "governance";
  if (module.mode === "analyze") return "core-context";
  return null;
}

function inferRunStatus(args: {
  totalModules: number;
  successCount: number;
  failedCount: number;
  blockedCount: number;
}): RunStatus {
  if (args.totalModules === 0) return "unknown";
  if (args.successCount === args.totalModules && args.failedCount === 0 && args.blockedCount === 0) {
    return "success";
  }
  if (args.failedCount > 0 && args.successCount === 0) return "failure";
  if (args.failedCount > 0 || args.blockedCount > 0) return "partial_failure";
  return "unknown";
}
