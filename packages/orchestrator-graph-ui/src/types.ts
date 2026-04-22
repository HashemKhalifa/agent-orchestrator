export type ModuleStatus = "success" | "failed" | "blocked" | "skipped" | "pending";

export type RunStatus = "success" | "partial_failure" | "failure" | "unknown";

export interface NodeState {
  id: string;
  title: string;
  level: number;
  mode: "analyze" | "implement";
  kind: "module" | "gate" | "policy";
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

export interface EdgeRef {
  id: string;
  source: string;
  target: string;
  kind: "depends_on" | "soft_depends_on" | "repair" | "policy_guard";
  blocking: boolean;
  rationale: string | null;
}

export interface RunHistoryEntry {
  runId: string;
  recipeId: string | null;
  generatedAt: string | null;
  status: RunStatus;
  successCount: number;
  failedCount: number;
  blockedCount: number;
  skippedCount: number;
  totalModules: number;
  elapsedMs: number | null;
  totalTokensEffective: number | null;
  totalTokensEstimated: number | null;
  summaryPath: string;
}

export interface RunTelemetry {
  totalModules: number;
  totalAttempts: number | null;
  totalDurationMs: number;
  averageModuleDurationMs: number;
  longestModuleDurationMs: number;
  elapsedMs: number | null;
  totalTokensEffective: number | null;
  totalTokensEstimated: number | null;
  totalTokensObserved: number | null;
  resumedModules: number;
  repairsGenerated: number;
  policyPackCount: number;
  memoryCalls: number;
  memoryHits: number;
  memoryCandidatesLoaded: number;
  memoryCandidatesSemantic: number;
  memoryCandidatesReplay: number;
  memoryCandidatesArtifact: number;
  memorySelectedSemantic: number;
  memorySelectedReplay: number;
  memorySelectedArtifact: number;
  memorySkippedTotal: number;
  memorySkippedPreview: string | null;
  generatedAt: string | null;
}

export interface RunStateResponse {
  ok: boolean;
  graphMode: "v1" | "v2" | "auto";
  sourcePaths: {
    manifestPath: string | null;
    graphPath: string | null;
    runSummaryPath: string | null;
    runSummaryV2Path: string | null;
    nodeStateV2Path: string | null;
    eventsPath: string | null;
    artifactsDir: string | null;
    iterationSummaryPath: string | null;
  };
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
  edges: EdgeRef[];
  history: RunHistoryEntry[];
  telemetry: RunTelemetry | null;
  errors: string[];
  refreshedAt: string;
}
