import { z } from "zod";

export const DagDependencyModeSchema = z.enum(["sequential", "parallel", "staged"]);

export const DagModuleSchema = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  partPath: z.string().trim().min(1),
  mode: z.enum(["analyze", "implement"]).default("implement"),
  kind: z.enum(["module", "gate", "policy"]).optional(),
  entryGroup: z.string().trim().min(1).optional(),
  level: z.number().int().nonnegative(),
  dependsOn: z.array(z.string().trim().min(1)).default([]),
  resources: z.array(z.string().trim().min(1)).default([]),
  command: z.string().trim().min(1).optional(),
});

export const DagDiffFileSchema = z.object({
  path: z.string().trim().min(1),
  change: z.enum(["added", "modified", "deleted"]),
});

export const DagCommandTraceSchema = z.object({
  command: z.string().trim().min(1),
  passed: z.boolean(),
  code: z.number().int().nullable(),
  durationMs: z.number().int().nonnegative(),
  stdout: z.string(),
  stderr: z.string(),
});

export const DagCriticSeveritySchema = z.enum(["info", "warning", "blocker"]);

export const DagCriticFindingSchema = z.object({
  severity: DagCriticSeveritySchema,
  message: z.string().trim().min(1),
  source: z.string().trim().min(1).default("critic"),
});

export const DagMemoryRevisitHitSchema = z.object({
  source: z.enum(["semantic-memory", "replay-memory", "artifact-contract"]),
  score: z.number().nonnegative(),
  summary: z.string().trim().min(1),
  reference: z.string().trim().min(1).nullable().default(null),
});

export const DagModuleArtifactSchema = z.object({
  moduleId: z.string().trim().min(1),
  generatedAt: z.string().trim().min(1),
  attempt: z.number().int().positive(),
  status: z.enum(["success", "failed", "blocked", "skipped"]),
  inputDigest: z.string().trim().min(1).nullable().default(null),
  changedFiles: z.array(DagDiffFileSchema).default([]),
  command: DagCommandTraceSchema.nullable().default(null),
  critic: DagCommandTraceSchema.nullable().default(null),
  criticFindings: z.array(DagCriticFindingSchema).default([]),
  testImpact: z.array(DagCommandTraceSchema).default([]),
  riskNotes: z.array(z.string()).default([]),
  policyPacks: z.array(z.string()).default([]),
  repairTaskPath: z.string().nullable().default(null),
  memoryRevisit: z.array(DagMemoryRevisitHitSchema).default([]),
});

export const DagManifestSchema = z.object({
  schemaVersion: z.literal("1.0"),
  name: z.string().trim().min(1),
  description: z.string().trim().min(1),
  requestPath: z.string().trim().min(1),
  generatedAt: z.string().trim().min(1),
  dependencyMode: DagDependencyModeSchema,
  modules: z.array(DagModuleSchema).min(1),
});

export const DagRunResultSchema = z.object({
  moduleId: z.string(),
  status: z.enum(["success", "failed", "blocked", "skipped"]),
  command: z.string().nullable(),
  code: z.number().int().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  durationMs: z.number().int().nonnegative(),
  attempt: z.number().int().positive().default(1),
  tokensEstimate: z.number().int().nonnegative().default(0),
  changedFiles: z.array(DagDiffFileSchema).default([]),
  artifactPath: z.string().nullable().default(null),
  criticPassed: z.boolean().nullable().default(null),
  criticSeverity: DagCriticSeveritySchema.nullable().default(null),
  criticFindings: z.array(DagCriticFindingSchema).default([]),
  repairTaskPath: z.string().nullable().default(null),
  memoryRevisit: z.array(DagMemoryRevisitHitSchema).default([]),
  testImpactCommands: z.array(z.string()).default([]),
  tokenAccountingMode: z.enum(["estimated", "observed", "mixed"]).default("estimated"),
  tokensObserved: z.number().int().nonnegative().default(0),
  tokensEstimated: z.number().int().nonnegative().default(0),
  tokensEffective: z.number().int().nonnegative().default(0),
  resumedFromArtifact: z.boolean().default(false),
});

export const DagBudgetSnapshotSchema = z.object({
  maxTotalAttempts: z.number().int().positive().nullable(),
  maxTotalTokens: z.number().int().positive().nullable(),
  maxRunDurationMs: z.number().int().positive().nullable(),
  failFast: z.boolean(),
  totalAttempts: z.number().int().nonnegative(),
  totalTokensEstimate: z.number().int().nonnegative(),
  totalTokensObserved: z.number().int().nonnegative().default(0),
  totalTokensEstimated: z.number().int().nonnegative().default(0),
  totalTokensEffective: z.number().int().nonnegative().default(0),
  observedTraceCount: z.number().int().nonnegative().default(0),
  estimatedTraceCount: z.number().int().nonnegative().default(0),
  tokenAccountingMode: z.enum(["estimated_only", "observed_or_estimated"]).default("estimated_only"),
  elapsedMs: z.number().int().nonnegative(),
  exhausted: z.boolean(),
  reasons: z.array(z.string()).default([]),
});

export const DagCanarySummarySchema = z.object({
  enabled: z.boolean(),
  limitModules: z.number().int().nonnegative(),
  checkpointPassed: z.boolean().nullable(),
  compareCommand: z.string().nullable(),
  failureDetail: z.string().nullable(),
});

export const DagMemoryRevisitSummarySchema = z.object({
  enabled: z.boolean(),
  maxCallsPerModule: z.number().int().nonnegative(),
  topK: z.number().int().positive(),
  minScore: z.number().nonnegative(),
  totalCalls: z.number().int().nonnegative(),
  hitsUsed: z.number().int().nonnegative(),
  candidatesLoadedBySource: z.object({
    semanticMemory: z.number().int().nonnegative().default(0),
    replayMemory: z.number().int().nonnegative().default(0),
    artifactContract: z.number().int().nonnegative().default(0),
  }).default({
    semanticMemory: 0,
    replayMemory: 0,
    artifactContract: 0,
  }),
  selectedBySource: z.object({
    semanticMemory: z.number().int().nonnegative().default(0),
    replayMemory: z.number().int().nonnegative().default(0),
    artifactContract: z.number().int().nonnegative().default(0),
  }).default({
    semanticMemory: 0,
    replayMemory: 0,
    artifactContract: 0,
  }),
  skippedByReason: z.object({
    disabled: z.number().int().nonnegative().default(0),
    maxCallsPerModule: z.number().int().nonnegative().default(0),
    emptyQuery: z.number().int().nonnegative().default(0),
    noCandidates: z.number().int().nonnegative().default(0),
    negativeMemoryBlocked: z.number().int().nonnegative().default(0),
    belowThreshold: z.number().int().nonnegative().default(0),
  }).default({
    disabled: 0,
    maxCallsPerModule: 0,
    emptyQuery: 0,
    noCandidates: 0,
    negativeMemoryBlocked: 0,
    belowThreshold: 0,
  }),
});

export const DagRunSummarySchema = z.object({
  runId: z.string().trim().min(1).optional(),
  graphMode: z.enum(["v1", "v2", "auto"]).optional(),
  eventsPath: z.string().trim().min(1).nullable().default(null),
  manifestPath: z.string(),
  startedAt: z.string(),
  completedAt: z.string(),
  status: z.enum(["success", "partial_failure", "failure"]),
  results: z.array(DagRunResultSchema),
  resumedModules: z.number().int().nonnegative().default(0),
  repairsGenerated: z.number().int().nonnegative().default(0),
  policyPacks: z.array(z.string()).default([]),
  artifactsDir: z.string().nullable().default(null),
  budget: DagBudgetSnapshotSchema.optional(),
  canary: DagCanarySummarySchema.optional(),
  memoryRevisit: DagMemoryRevisitSummarySchema.optional(),
});

export type DagDependencyMode = z.infer<typeof DagDependencyModeSchema>;
export type DagModule = z.infer<typeof DagModuleSchema>;
export type DagDiffFile = z.infer<typeof DagDiffFileSchema>;
export type DagCommandTrace = z.infer<typeof DagCommandTraceSchema>;
export type DagCriticSeverity = z.infer<typeof DagCriticSeveritySchema>;
export type DagCriticFinding = z.infer<typeof DagCriticFindingSchema>;
export type DagMemoryRevisitHit = z.infer<typeof DagMemoryRevisitHitSchema>;
export type DagModuleArtifact = z.infer<typeof DagModuleArtifactSchema>;
export type DagManifest = z.infer<typeof DagManifestSchema>;
export type DagRunResult = z.infer<typeof DagRunResultSchema>;
export type DagBudgetSnapshot = z.infer<typeof DagBudgetSnapshotSchema>;
export type DagCanarySummary = z.infer<typeof DagCanarySummarySchema>;
export type DagMemoryRevisitSummary = z.infer<typeof DagMemoryRevisitSummarySchema>;
export type DagRunSummary = z.infer<typeof DagRunSummarySchema>;

export type SplitPart = {
  content: string;
  title?: string;
  startLine?: number;
  endLine?: number;
};
