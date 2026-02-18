export type ModuleStatus = "success" | "failed" | "blocked" | "skipped" | "pending";

export type RunStatus = "success" | "partial_failure" | "failure" | "unknown";

export interface NodeState {
  id: string;
  title: string;
  level: number;
  mode: "analyze" | "implement";
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
  repairsGenerated: number;
  policyPackCount: number;
  generatedAt: string | null;
}

export interface RunStateResponse {
  ok: boolean;
  sourcePaths: {
    manifestPath: string | null;
    runSummaryPath: string | null;
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
