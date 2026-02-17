import { z } from "zod";

export const GoalTypeSchema = z.enum([
  "build_migration",
  "dependency_upgrade",
  "ci_refactor",
  "test_runner_migration",
  "custom",
]);

export const SourcePolicySchema = z.enum([
  "primary_only",
  "primary_plus_curated_secondary",
  "open_web",
]);

export const RiskGateModeSchema = z.enum([
  "strict_blockers",
  "warn_then_apply",
  "manual_override",
]);

export const DiscoverySourceSchema = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  url: z.string().url(),
  type: z.enum(["primary", "curated_secondary"]),
  tags: z.array(z.string().trim().min(1)).default([]),
});

export const GateDefinitionSchema = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  kind: z.enum(["command", "risk", "artifact", "manual"]),
  required: z.boolean().default(true),
  command: z.string().trim().min(1).optional(),
  artifactPath: z.string().trim().min(1).optional(),
  note: z.string().optional(),
});

export const RecipeStepSchema = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  kind: z.enum(["analyze", "transform", "verify", "gate", "notify"]),
  description: z.string().trim().min(1),
  command: z.string().trim().min(1).optional(),
  mutating: z.boolean().default(false),
});

export const RiskProbeSchema = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  category: z.enum(["breaking_change", "memory", "performance", "compatibility"]),
  severity: z.enum(["low", "medium", "high", "critical"]),
  regex: z.string().trim().min(1),
  fileGlobsHint: z.array(z.string().trim().min(1)).default([]),
  advice: z.string().trim().min(1),
});

export const RecipePreconditionsSchema = z.object({
  packageManagers: z.array(z.enum(["npm", "pnpm", "yarn", "unknown"]))
    .default(["npm", "pnpm", "yarn", "unknown"]),
  requiresFiles: z.array(z.string().trim().min(1)).default([]),
  requiresBuildTools: z.array(z.string().trim().min(1)).default([]),
});

export const WaveStrategySchema = z.enum([
  "incremental_dual_build",
  "pilot_wave",
  "big_bang",
  "custom",
]);

export const ExecutionRecipeSchema = z.object({
  id: z.string().trim().min(1),
  version: z.string().trim().min(1),
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  goalType: GoalTypeSchema,
  defaultWaveStrategy: WaveStrategySchema,
  preconditions: RecipePreconditionsSchema,
  discoverySources: z.array(DiscoverySourceSchema).min(1),
  riskProbes: z.array(RiskProbeSchema).default([]),
  steps: z.array(RecipeStepSchema).min(1),
  gates: z.array(GateDefinitionSchema).min(1),
  rollbackHints: z.array(z.string().trim().min(1)).default([]),
  edgeCases: z.array(z.string().trim().min(1)).default([]),
});

export const OrchestrationGoalSchema = z.object({
  goalType: GoalTypeSchema,
  recipeId: z.string().trim().min(1),
  sourceSystem: z.string().trim().min(1).optional(),
  targetSystem: z.string().trim().min(1).optional(),
  waveStrategy: WaveStrategySchema.optional(),
  workspaceRoot: z.string().trim().min(1).default("."),
  sourcePolicy: SourcePolicySchema.default("primary_plus_curated_secondary"),
  riskGateMode: RiskGateModeSchema.default("strict_blockers"),
  requireTddTests: z.boolean().default(true),
  curatedSourceDomains: z.array(z.string().trim().min(1)).default([]),
  additionalContext: z.record(z.string(), z.unknown()).default({}),
});

export const PackageFactSchema = z.object({
  name: z.string(),
  path: z.string(),
  private: z.boolean(),
  scripts: z.array(z.string()).default([]),
  dependencies: z.array(z.string()).default([]),
});

export const WorkspaceFactsSchema = z.object({
  repoRoot: z.string(),
  packageManager: z.enum(["npm", "pnpm", "yarn", "unknown"]),
  packageCount: z.number().int().nonnegative(),
  packages: z.array(PackageFactSchema),
  detectedBuildTools: z.array(z.string()),
  detectedTestTools: z.array(z.string()),
  detectedCiProviders: z.array(z.string()),
  lockfiles: z.array(z.string()),
});

export const InternetEvidenceItemSchema = z.object({
  sourceId: z.string(),
  url: z.string().url(),
  fetchedAt: z.string(),
  ok: z.boolean(),
  statusCode: z.number().int().nullable(),
  title: z.string().nullable(),
  summary: z.string().nullable(),
  contentBytes: z.number().int().nonnegative(),
  detectedSignals: z.array(z.string()).default([]),
  error: z.string().nullable(),
});

export const DiscoveryEvidenceSchema = z.object({
  generatedAt: z.string(),
  localSummary: z.string(),
  internetEvidence: z.array(InternetEvidenceItemSchema),
});

export const RiskFindingSchema = z.object({
  id: z.string().trim().min(1),
  category: z.enum(["breaking_change", "memory", "performance", "compatibility"]),
  severity: z.enum(["low", "medium", "high", "critical"]),
  status: z.enum(["open", "mitigated"]),
  title: z.string().trim().min(1),
  detail: z.string().trim().min(1),
  filePath: z.string().nullable(),
  evidenceSourceIds: z.array(z.string()).default([]),
  mitigation: z.string().trim().min(1).nullable(),
});

export const PlanStepSchema = z.object({
  waveId: z.string().trim().min(1),
  stepId: z.string().trim().min(1),
  kind: z.enum(["analyze", "transform", "verify", "gate", "notify"]),
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  mutating: z.boolean(),
});

export const PlanWaveSchema = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  packageTargets: z.array(z.string()),
  status: z.enum(["pending", "passed", "failed"]).default("pending"),
});

export const ExecutionPlanSchema = z.object({
  orchestratorSpecVersion: z.literal("1.0.0"),
  planId: z.string().trim().min(1),
  runId: z.string().trim().min(1),
  createdAt: z.string(),
  goal: OrchestrationGoalSchema,
  recipe: ExecutionRecipeSchema,
  workspaceFacts: WorkspaceFactsSchema,
  discovery: DiscoveryEvidenceSchema,
  riskFindings: z.array(RiskFindingSchema),
  waves: z.array(PlanWaveSchema).min(1),
  orderedSteps: z.array(PlanStepSchema).min(1),
});

export const ValidationIssueSchema = z.object({
  code: z.string().trim().min(1),
  severity: z.enum(["warning", "blocker"]),
  message: z.string().trim().min(1),
});

export const ValidationReportSchema = z.object({
  orchestratorSpecVersion: z.literal("1.0.0"),
  planId: z.string(),
  validatedAt: z.string(),
  status: z.enum(["passed", "blocked"]),
  issues: z.array(ValidationIssueSchema),
});

export const GateResultSchema = z.object({
  gateId: z.string(),
  required: z.boolean(),
  passed: z.boolean(),
  details: z.string(),
});

export const WaveExecutionResultSchema = z.object({
  waveId: z.string(),
  status: z.enum(["passed", "failed"]),
  dryRun: z.boolean(),
  executedAt: z.string(),
  notes: z.array(z.string()),
});

export const ExecutionReportSchema = z.object({
  orchestratorSpecVersion: z.literal("1.0.0"),
  runId: z.string(),
  planId: z.string(),
  executedAt: z.string(),
  mode: z.enum(["dry-run", "apply"]),
  status: z.enum(["completed", "blocked", "failed"]),
  done: z.boolean(),
  waveResult: WaveExecutionResultSchema.nullable(),
  gateResults: z.array(GateResultSchema),
  pendingWaves: z.array(z.string()),
  blockerSummary: z.array(z.string()),
});

export const RunStateSchema = z.object({
  orchestratorSpecVersion: z.literal("1.0.0"),
  runId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  goal: OrchestrationGoalSchema,
  iteration: z.number().int().nonnegative(),
  status: z.enum(["running", "completed", "blocked", "failed"]),
  waveAttempts: z.record(z.string(), z.number().int().nonnegative()),
  completedWaves: z.array(z.string()),
  lastPlanPath: z.string().nullable(),
  lastValidationPath: z.string().nullable(),
  lastExecutionPath: z.string().nullable(),
  blockerSummary: z.array(z.string()),
});

export type GoalType = z.infer<typeof GoalTypeSchema>;
export type SourcePolicy = z.infer<typeof SourcePolicySchema>;
export type RiskGateMode = z.infer<typeof RiskGateModeSchema>;
export type DiscoverySource = z.infer<typeof DiscoverySourceSchema>;
export type GateDefinition = z.infer<typeof GateDefinitionSchema>;
export type RecipeStep = z.infer<typeof RecipeStepSchema>;
export type RiskProbe = z.infer<typeof RiskProbeSchema>;
export type ExecutionRecipe = z.infer<typeof ExecutionRecipeSchema>;
export type OrchestrationGoal = z.infer<typeof OrchestrationGoalSchema>;
export type WorkspaceFacts = z.infer<typeof WorkspaceFactsSchema>;
export type InternetEvidenceItem = z.infer<typeof InternetEvidenceItemSchema>;
export type DiscoveryEvidence = z.infer<typeof DiscoveryEvidenceSchema>;
export type RiskFinding = z.infer<typeof RiskFindingSchema>;
export type PlanWave = z.infer<typeof PlanWaveSchema>;
export type ExecutionPlan = z.infer<typeof ExecutionPlanSchema>;
export type ValidationIssue = z.infer<typeof ValidationIssueSchema>;
export type ValidationReport = z.infer<typeof ValidationReportSchema>;
export type GateResult = z.infer<typeof GateResultSchema>;
export type ExecutionReport = z.infer<typeof ExecutionReportSchema>;
export type RunState = z.infer<typeof RunStateSchema>;
