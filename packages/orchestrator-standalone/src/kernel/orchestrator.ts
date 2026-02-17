import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  DiscoveryEvidenceSchema,
  ExecutionPlanSchema,
  ExecutionReportSchema,
  GateResultSchema,
  type ExecutionPlan,
  type ExecutionReport,
  type ExecutionRecipe,
  type InternetEvidenceItem,
  type OrchestrationGoal,
  type PlanWave,
  type RiskFinding,
  type RiskProbe,
  type RunState,
  RunStateSchema,
  type ValidationIssue,
  ValidationReportSchema,
  type WorkspaceFacts,
} from "../spec/schemas.js";
import { discoverWorkspaceFacts, summarizeWorkspaceFacts } from "../adapters/workspace-discovery.js";
import { collectInternetEvidence } from "../adapters/internet-evidence.js";
import { getRecipeById } from "../recipes/catalog.js";
import { applyRecipeMemory, deriveRecipeMemory, type RecipeMemory } from "../recipes/memory.js";
import {
  loadRunState,
  persistCycleArtifacts,
  resolvePersistedPaths,
  type PersistedPaths,
} from "./state-store.js";

const FILE_SCAN_IGNORES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
]);

const SCAN_FILE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".yml",
  ".yaml",
  ".md",
]);

const DEFAULT_SCAN_FILE_LIMIT = 3000;
const DEFAULT_FILE_READ_MAX_BYTES = 256_000;

function gatherTextFiles(repoRoot: string, maxFiles = DEFAULT_SCAN_FILE_LIMIT): string[] {
  const out: string[] = [];
  const queue: string[] = [repoRoot];

  while (queue.length > 0) {
    const current = queue.shift() as string;
    let entries: string[];

    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry);
      let stats;
      try {
        stats = statSync(fullPath);
      } catch {
        continue;
      }

      if (stats.isDirectory()) {
        if (!FILE_SCAN_IGNORES.has(entry)) queue.push(fullPath);
        continue;
      }

      const ext = path.extname(entry).toLowerCase();
      if (!SCAN_FILE_EXTENSIONS.has(ext)) continue;

      out.push(fullPath);
      if (out.length >= maxFiles) return out;
    }
  }

  return out;
}

function readTextSnippet(filePath: string, maxBytes = DEFAULT_FILE_READ_MAX_BYTES): string {
  try {
    return readFileSync(filePath, "utf8").slice(0, maxBytes);
  } catch {
    return "";
  }
}

function compileRiskProbeRegex(probe: RiskProbe): RegExp | null {
  try {
    return new RegExp(probe.regex, "mi");
  } catch {
    return null;
  }
}

function runRiskProbeScan(args: {
  repoRoot: string;
  probes: RiskProbe[];
}): RiskFinding[] {
  const files = gatherTextFiles(args.repoRoot);
  const findings: RiskFinding[] = [];

  const compiled = args.probes.map((probe) => ({
    probe,
    regex: compileRiskProbeRegex(probe),
  }));

  for (const filePath of files) {
    const text = readTextSnippet(filePath);
    if (!text) continue;

    for (const item of compiled) {
      if (!item.regex) continue;
      if (!item.regex.test(text)) continue;

      const relPath = path.relative(args.repoRoot, filePath) || ".";
      findings.push({
        id: `${item.probe.id}:${relPath}`,
        category: item.probe.category,
        severity: item.probe.severity,
        status: "open",
        title: item.probe.title,
        detail: `${item.probe.advice} (matched ${item.probe.regex})`,
        filePath: relPath,
        evidenceSourceIds: [],
        mitigation: null,
      });
    }
  }

  return findings;
}

function runInternetRiskSynthesis(args: {
  evidence: InternetEvidenceItem[];
  recipe: ExecutionRecipe;
}): RiskFinding[] {
  const findings: RiskFinding[] = [];
  const bySourceId = new Map(args.evidence.map((item) => [item.sourceId, item]));

  for (const source of args.recipe.discoverySources) {
    const evidence = bySourceId.get(source.id);
    if (source.type === "primary" && (!evidence || !evidence.ok)) {
      findings.push({
        id: `missing-primary:${source.id}`,
        category: "breaking_change",
        severity: "high",
        status: "open",
        title: `Primary source unavailable: ${source.title}`,
        detail: `Could not fetch required primary source '${source.url}'.`,
        filePath: null,
        evidenceSourceIds: evidence ? [source.id] : [],
        mitigation: "Retry discovery and confirm docs/release notes coverage.",
      });
      continue;
    }

    if (!evidence || !evidence.ok) continue;

    const matchedSignals = evidence.detectedSignals;
    if (matchedSignals.some((signal) => signal.includes("breaking") || signal.includes("deprecat"))) {
      findings.push({
        id: `doc-signal-breaking:${source.id}`,
        category: "breaking_change",
        severity: "medium",
        status: "open",
        title: `Source contains breaking/deprecation indicators: ${source.title}`,
        detail: `Discovery source mentions: ${matchedSignals.join(", ")}.`,
        filePath: null,
        evidenceSourceIds: [source.id],
        mitigation: "Map breaking/deprecated APIs to concrete migration tasks and tests.",
      });
    }

    if (matchedSignals.some((signal) => signal.includes("memory leak"))) {
      findings.push({
        id: `doc-signal-memory:${source.id}`,
        category: "memory",
        severity: "high",
        status: "open",
        title: `Source highlights memory leak risk: ${source.title}`,
        detail: `Source includes memory leak discussion keywords.`,
        filePath: null,
        evidenceSourceIds: [source.id],
        mitigation: "Add targeted leak/teardown tests and profiling checks before apply.",
      });
    }
  }

  return findings;
}

function dedupeRiskFindings(findings: RiskFinding[]): RiskFinding[] {
  const seen = new Set<string>();
  const out: RiskFinding[] = [];
  for (const finding of findings) {
    const key = `${finding.id}|${finding.filePath ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(finding);
  }
  return out;
}

function buildWaves(args: {
  workspaceFacts: WorkspaceFacts;
  strategy: OrchestrationGoal["waveStrategy"] | undefined;
  recipe: ExecutionRecipe;
}): PlanWave[] {
  const strategy = args.strategy ?? args.recipe.defaultWaveStrategy;
  const targets = args.workspaceFacts.packages.map((pkg) => pkg.name);
  const normalizedTargets = targets.length > 0 ? targets : ["root"];

  if (strategy === "big_bang") {
    return [{ id: "wave-1", title: "Big Bang", packageTargets: normalizedTargets, status: "pending" }];
  }

  if (strategy === "pilot_wave") {
    const [first, ...rest] = normalizedTargets;
    if (rest.length === 0) {
      return [{ id: "wave-1", title: "Pilot", packageTargets: [first], status: "pending" }];
    }
    return [
      { id: "wave-1", title: "Pilot", packageTargets: [first], status: "pending" },
      { id: "wave-2", title: "Rollout", packageTargets: rest, status: "pending" },
    ];
  }

  const chunkSize = strategy === "incremental_dual_build" ? 10 : 8;
  const waves: PlanWave[] = [];
  let waveNum = 1;
  for (let index = 0; index < normalizedTargets.length; index += chunkSize) {
    const slice = normalizedTargets.slice(index, index + chunkSize);
    waves.push({
      id: `wave-${waveNum}`,
      title: `Wave ${waveNum}`,
      packageTargets: slice,
      status: "pending",
    });
    waveNum += 1;
  }

  return waves;
}

function buildPlan(args: {
  runId: string;
  goal: OrchestrationGoal;
  recipe: ExecutionRecipe;
  workspaceFacts: WorkspaceFacts;
  discovery: { localSummary: string; internetEvidence: InternetEvidenceItem[] };
  riskFindings: RiskFinding[];
}): ExecutionPlan {
  const createdAt = new Date().toISOString();
  const planId = `${args.recipe.id}-${createdAt.replace(/[.:]/g, "-")}`;
  const waves = buildWaves({
    workspaceFacts: args.workspaceFacts,
    strategy: args.goal.waveStrategy,
    recipe: args.recipe,
  });

  const orderedSteps = waves.flatMap((wave) => {
    return args.recipe.steps.map((step) => ({
      waveId: wave.id,
      stepId: step.id,
      kind: step.kind,
      title: step.title,
      description: step.description,
      mutating: step.mutating,
    }));
  });

  return ExecutionPlanSchema.parse({
    orchestratorSpecVersion: "1.0.0",
    runId: args.runId,
    planId,
    createdAt,
    goal: args.goal,
    recipe: args.recipe,
    workspaceFacts: args.workspaceFacts,
    discovery: DiscoveryEvidenceSchema.parse({
      generatedAt: createdAt,
      localSummary: args.discovery.localSummary,
      internetEvidence: args.discovery.internetEvidence,
    }),
    riskFindings: args.riskFindings,
    waves,
    orderedSteps,
  });
}

function hasFile(repoRoot: string, filePath: string): boolean {
  return existsSync(path.join(repoRoot, filePath));
}

function validatePreconditions(plan: ExecutionPlan): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const preconditions = plan.recipe.preconditions;

  if (!preconditions.packageManagers.includes(plan.workspaceFacts.packageManager)) {
    issues.push({
      code: "PRECONDITION_PACKAGE_MANAGER",
      severity: "blocker",
      message: `Recipe ${plan.recipe.id} does not support package manager ${plan.workspaceFacts.packageManager}.`,
    });
  }

  for (const requiredFile of preconditions.requiresFiles) {
    if (!hasFile(plan.workspaceFacts.repoRoot, requiredFile)) {
      issues.push({
        code: "PRECONDITION_REQUIRED_FILE",
        severity: "blocker",
        message: `Missing required file '${requiredFile}' for recipe ${plan.recipe.id}.`,
      });
    }
  }

  for (const requiredTool of preconditions.requiresBuildTools) {
    if (!plan.workspaceFacts.detectedBuildTools.includes(requiredTool)) {
      issues.push({
        code: "PRECONDITION_BUILD_TOOL",
        severity: "blocker",
        message: `Recipe ${plan.recipe.id} requires detected build tool '${requiredTool}'.`,
      });
    }
  }

  return issues;
}

function validateRiskGate(plan: ExecutionPlan): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const strictBlocked = plan.goal.riskGateMode === "strict_blockers";
  if (!strictBlocked) return issues;

  for (const finding of plan.riskFindings) {
    if (finding.status !== "open") continue;
    if (finding.severity === "high" || finding.severity === "critical") {
      issues.push({
        code: "RISK_HIGH_OPEN",
        severity: "blocker",
        message: `Open ${finding.severity} risk: ${finding.title}${finding.filePath ? ` (${finding.filePath})` : ""}.`,
      });
    }
  }

  return issues;
}

function validateTestingRequirements(plan: ExecutionPlan): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (plan.goal.requireTddTests && plan.workspaceFacts.detectedTestTools.length === 0) {
    issues.push({
      code: "TEST_TOOL_MISSING",
      severity: "blocker",
      message: "No test framework detected. Add characterization/TDD tests before apply mode.",
    });
  }

  return issues;
}

function validateSourceEvidence(plan: ExecutionPlan): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const primarySources = plan.recipe.discoverySources.filter((source) => source.type === "primary");
  const evidenceBySource = new Map(plan.discovery.internetEvidence.map((item) => [item.sourceId, item]));

  for (const source of primarySources) {
    const evidence = evidenceBySource.get(source.id);
    if (!evidence || !evidence.ok) {
      issues.push({
        code: "PRIMARY_SOURCE_MISSING",
        severity: "blocker",
        message: `Primary source '${source.title}' is missing/unavailable.`,
      });
    }
  }

  return issues;
}

export function validatePlan(plan: ExecutionPlan): ReturnType<typeof ValidationReportSchema.parse> {
  const issues: ValidationIssue[] = [
    ...validatePreconditions(plan),
    ...validateRiskGate(plan),
    ...validateTestingRequirements(plan),
    ...validateSourceEvidence(plan),
  ];

  return ValidationReportSchema.parse({
    orchestratorSpecVersion: "1.0.0",
    planId: plan.planId,
    validatedAt: new Date().toISOString(),
    status: issues.some((issue) => issue.severity === "blocker") ? "blocked" : "passed",
    issues,
  });
}

function runCommand(command: string, cwd: string, timeoutMs: number): { passed: boolean; detail: string } {
  const result = spawnSync(command, {
    cwd,
    shell: true,
    timeout: timeoutMs,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });

  if (result.error) {
    return {
      passed: false,
      detail: `Command error: ${result.error.message}`,
    };
  }

  if (typeof result.status === "number" && result.status === 0) {
    return {
      passed: true,
      detail: "ok",
    };
  }

  const stderr = result.stderr?.trim() ?? "";
  const stdout = result.stdout?.trim() ?? "";
  const message = stderr || stdout || `exit ${result.status ?? "unknown"}`;
  return {
    passed: false,
    detail: message.slice(0, 600),
  };
}

function isApprovalFileApproved(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  try {
    const raw = readFileSync(filePath, "utf8").trim();
    if (!raw) return false;
    if (raw.toLowerCase() === "approved") return true;
    const parsed = JSON.parse(raw);
    return parsed?.approved === true;
  } catch {
    return false;
  }
}

function evaluateGates(args: {
  plan: ExecutionPlan;
  timeoutMs: number;
}): ReturnType<typeof GateResultSchema.parse>[] {
  const gateResults: ReturnType<typeof GateResultSchema.parse>[] = [];

  for (const gate of args.plan.recipe.gates) {
    if (gate.kind === "command") {
      const cmd = gate.command;
      if (!cmd) {
        gateResults.push(
          GateResultSchema.parse({
            gateId: gate.id,
            required: gate.required,
            passed: false,
            details: "Missing command definition",
          }),
        );
        continue;
      }

      const commandResult = runCommand(cmd, args.plan.workspaceFacts.repoRoot, args.timeoutMs);
      gateResults.push(
        GateResultSchema.parse({
          gateId: gate.id,
          required: gate.required,
          passed: commandResult.passed,
          details: commandResult.detail,
        }),
      );
      continue;
    }

    if (gate.kind === "risk") {
      const blockingRisk = args.plan.riskFindings.some(
        (finding) =>
          finding.status === "open" && (finding.severity === "high" || finding.severity === "critical"),
      );
      gateResults.push(
        GateResultSchema.parse({
          gateId: gate.id,
          required: gate.required,
          passed: !blockingRisk,
          details: blockingRisk ? "high/critical risk findings remain open" : "ok",
        }),
      );
      continue;
    }

    if (gate.kind === "artifact") {
      const artifactPath = gate.artifactPath;
      const found = artifactPath ? existsSync(path.join(args.plan.workspaceFacts.repoRoot, artifactPath)) : false;
      gateResults.push(
        GateResultSchema.parse({
          gateId: gate.id,
          required: gate.required,
          passed: found,
          details: found ? "ok" : `missing artifact: ${artifactPath ?? "unknown"}`,
        }),
      );
      continue;
    }

    gateResults.push(
      GateResultSchema.parse({
        gateId: gate.id,
        required: gate.required,
        passed: !gate.required,
        details: gate.required ? "manual gate unresolved" : "manual advisory gate",
      }),
    );
  }

  return gateResults;
}

function createInitialRunState(args: {
  runId: string;
  goal: OrchestrationGoal;
}): RunState {
  return RunStateSchema.parse({
    orchestratorSpecVersion: "1.0.0",
    runId: args.runId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    goal: args.goal,
    iteration: 0,
    status: "running",
    waveAttempts: {},
    completedWaves: [],
    lastPlanPath: null,
    lastValidationPath: null,
    lastExecutionPath: null,
    blockerSummary: [],
  });
}

function nextPendingWave(plan: ExecutionPlan, state: RunState): PlanWave | null {
  for (const wave of plan.waves) {
    if (!state.completedWaves.includes(wave.id)) return wave;
  }
  return null;
}

export function executePlan(args: {
  plan: ExecutionPlan;
  validationStatus: "passed" | "blocked";
  mode: "dry-run" | "apply";
  state: RunState;
  timeoutMs: number;
  requireWaveApproval?: boolean;
  approvalsDir?: string;
  requireEvidenceFile?: boolean;
  evidenceFile?: string;
  rollbackCheckCommand?: string;
}): ExecutionReport {
  const now = new Date().toISOString();

  if (args.validationStatus === "blocked") {
    return ExecutionReportSchema.parse({
      orchestratorSpecVersion: "1.0.0",
      runId: args.plan.runId,
      planId: args.plan.planId,
      executedAt: now,
      mode: args.mode,
      status: "blocked",
      done: false,
      waveResult: null,
      gateResults: [],
      pendingWaves: args.plan.waves
        .map((wave) => wave.id)
        .filter((waveId) => !args.state.completedWaves.includes(waveId)),
      blockerSummary: ["Validation blocked execution"],
    });
  }

  const currentWave = nextPendingWave(args.plan, args.state);
  if (!currentWave) {
    const gateResults = evaluateGates({ plan: args.plan, timeoutMs: args.timeoutMs });
    const requiredFailed = gateResults.filter((gate) => gate.required && !gate.passed);

    return ExecutionReportSchema.parse({
      orchestratorSpecVersion: "1.0.0",
      runId: args.plan.runId,
      planId: args.plan.planId,
      executedAt: now,
      mode: args.mode,
      status: requiredFailed.length > 0 ? "blocked" : "completed",
      done: requiredFailed.length === 0,
      waveResult: null,
      gateResults,
      pendingWaves: [],
      blockerSummary: requiredFailed.map((gate) => `${gate.gateId}: ${gate.details}`),
    });
  }

  if (args.mode === "apply") {
    const requireEvidenceFile = args.requireEvidenceFile ?? true;
    if (requireEvidenceFile) {
      const evidenceFile = path.resolve(
        args.plan.workspaceFacts.repoRoot,
        args.evidenceFile ?? "generated/orchestration/evidence/apply-evidence.md",
      );
      if (!existsSync(evidenceFile)) {
        return ExecutionReportSchema.parse({
          orchestratorSpecVersion: "1.0.0",
          runId: args.plan.runId,
          planId: args.plan.planId,
          executedAt: now,
          mode: args.mode,
          status: "blocked",
          done: false,
          waveResult: null,
          gateResults: [],
          pendingWaves: args.plan.waves
            .map((wave) => wave.id)
            .filter((waveId) => !args.state.completedWaves.includes(waveId)),
          blockerSummary: [
            `Apply evidence file missing: ${path.relative(args.plan.workspaceFacts.repoRoot, evidenceFile)}`,
          ],
        });
      }
    }

    if (args.rollbackCheckCommand) {
      const rollbackCheck = runCommand(
        args.rollbackCheckCommand,
        args.plan.workspaceFacts.repoRoot,
        args.timeoutMs,
      );
      if (!rollbackCheck.passed) {
        return ExecutionReportSchema.parse({
          orchestratorSpecVersion: "1.0.0",
          runId: args.plan.runId,
          planId: args.plan.planId,
          executedAt: now,
          mode: args.mode,
          status: "blocked",
          done: false,
          waveResult: null,
          gateResults: [],
          pendingWaves: args.plan.waves
            .map((wave) => wave.id)
            .filter((waveId) => !args.state.completedWaves.includes(waveId)),
          blockerSummary: [`Rollback check command failed: ${rollbackCheck.detail}`],
        });
      }
    }

    if (args.requireWaveApproval ?? true) {
      const approvalFile = path.resolve(
        args.plan.workspaceFacts.repoRoot,
        args.approvalsDir ?? "generated/orchestration/approvals",
        `${currentWave.id}.approved.json`,
      );
      if (!isApprovalFileApproved(approvalFile)) {
        return ExecutionReportSchema.parse({
          orchestratorSpecVersion: "1.0.0",
          runId: args.plan.runId,
          planId: args.plan.planId,
          executedAt: now,
          mode: args.mode,
          status: "blocked",
          done: false,
          waveResult: null,
          gateResults: [],
          pendingWaves: args.plan.waves
            .map((wave) => wave.id)
            .filter((waveId) => !args.state.completedWaves.includes(waveId)),
          blockerSummary: [
            `Wave approval missing for ${currentWave.id}: ${path.relative(args.plan.workspaceFacts.repoRoot, approvalFile)}`,
          ],
        });
      }
    }
  }

  const notes: string[] = [];
  if (args.mode === "dry-run") {
    notes.push("Dry-run mode: no mutating transforms executed.");
  } else {
    notes.push("Apply mode: mutating steps require recipe-level executor integrations.");
    notes.push("This v1 implementation records checklists and gates but does not auto-patch files.");
  }

  const gateResults = evaluateGates({
    plan: args.plan,
    timeoutMs: args.timeoutMs,
  });

  const requiredFailed = gateResults.filter((gate) => gate.required && !gate.passed);
  const wavePassed = requiredFailed.length === 0;

  const pendingAfterCurrent = args.plan.waves
    .map((wave) => wave.id)
    .filter((waveId) => waveId !== currentWave.id && !args.state.completedWaves.includes(waveId));

  return ExecutionReportSchema.parse({
    orchestratorSpecVersion: "1.0.0",
    runId: args.plan.runId,
    planId: args.plan.planId,
    executedAt: now,
    mode: args.mode,
    status: wavePassed ? "completed" : "blocked",
    done: wavePassed && pendingAfterCurrent.length === 0,
    waveResult: {
      waveId: currentWave.id,
      status: wavePassed ? "passed" : "failed",
      dryRun: args.mode === "dry-run",
      executedAt: now,
      notes,
    },
    gateResults,
    pendingWaves: wavePassed ? pendingAfterCurrent : [currentWave.id, ...pendingAfterCurrent],
    blockerSummary: requiredFailed.map((gate) => `${gate.gateId}: ${gate.details}`),
  });
}

function updateState(args: {
  state: RunState;
  execution: ExecutionReport;
  validationIssues: ValidationIssue[];
  persisted: PersistedPaths;
}): RunState {
  const next = {
    ...args.state,
    updatedAt: new Date().toISOString(),
    iteration: args.state.iteration + 1,
    blockerSummary: args.execution.blockerSummary,
    lastPlanPath: path.relative(process.cwd(), args.persisted.planPath),
    lastValidationPath: path.relative(process.cwd(), args.persisted.validationPath),
    lastExecutionPath: path.relative(process.cwd(), args.persisted.executionPath),
  };

  const waveResult = args.execution.waveResult;
  if (waveResult) {
    const attempts = next.waveAttempts[waveResult.waveId] ?? 0;
    next.waveAttempts[waveResult.waveId] = attempts + 1;

    if (waveResult.status === "passed" && !next.completedWaves.includes(waveResult.waveId)) {
      next.completedWaves = [...next.completedWaves, waveResult.waveId];
    }
  }

  const hasValidationBlocker = args.validationIssues.some((issue) => issue.severity === "blocker");
  if (args.execution.done) {
    next.status = "completed";
  } else if (hasValidationBlocker || args.execution.status === "blocked") {
    next.status = "blocked";
  } else if (args.execution.status === "failed") {
    next.status = "failed";
  } else {
    next.status = "running";
  }

  return RunStateSchema.parse(next);
}

function summarizeCycle(args: {
  runId: string;
  plan: ExecutionPlan;
  validation: ReturnType<typeof ValidationReportSchema.parse>;
  execution: ExecutionReport;
  state: RunState;
  recipeMemory?: RecipeMemory | null;
}): Record<string, unknown> {
  return {
    orchestratorSpecVersion: "1.0.0",
    runId: args.runId,
    timestamp: new Date().toISOString(),
    recipeId: args.plan.recipe.id,
    goalType: args.plan.goal.goalType,
    planId: args.plan.planId,
    validationStatus: args.validation.status,
    executionStatus: args.execution.status,
    done: args.execution.done,
    pendingWaves: args.execution.pendingWaves,
    completedWaves: args.state.completedWaves,
    blockers: args.execution.blockerSummary,
    recipeMemory: args.recipeMemory
      ? {
        analyzedRuns: args.recipeMemory.analyzedRuns,
        learnedRiskProbes: args.recipeMemory.learnedRiskProbes.map((probe) => probe.id),
        learnedGates: args.recipeMemory.learnedGates.map((gate) => gate.id),
      }
      : null,
    artifacts: {
      planPath: args.state.lastPlanPath,
      validationPath: args.state.lastValidationPath,
      executionPath: args.state.lastExecutionPath,
    },
  };
}

export interface OrchestrationCycleResult {
  runId: string;
  state: RunState;
  plan: ExecutionPlan;
  validation: ReturnType<typeof ValidationReportSchema.parse>;
  execution: ExecutionReport;
  cycleSummary: Record<string, unknown>;
  persistedPaths: PersistedPaths;
  recipeMemory: RecipeMemory | null;
}

export interface RunCycleInput {
  runId?: string;
  goal: OrchestrationGoal;
  mode: "dry-run" | "apply";
  runsDir: string;
  commandTimeoutMs?: number;
  recipeOverride?: ExecutionRecipe;
  enableRecipeMemory?: boolean;
  requireWaveApproval?: boolean;
  approvalsDir?: string;
  requireEvidenceFile?: boolean;
  evidenceFile?: string;
  rollbackCheckCommand?: string;
}

export async function runOrchestrationCycle(input: RunCycleInput): Promise<OrchestrationCycleResult> {
  const runId = input.runId ?? randomUUID();
  const paths = resolvePersistedPaths(input.runsDir, runId);
  const existingState = loadRunState(paths.statePath);
  const state = existingState ?? createInitialRunState({ runId, goal: input.goal });

  const baseRecipe = input.recipeOverride ?? getRecipeById(input.goal.recipeId);
  const recipeMemory = input.enableRecipeMemory === false
    ? null
    : deriveRecipeMemory({
      runsDir: path.resolve(input.runsDir),
      recipeId: baseRecipe.id,
    });
  const recipe = recipeMemory ? applyRecipeMemory({ recipe: baseRecipe, memory: recipeMemory }) : baseRecipe;
  if (recipe.goalType !== input.goal.goalType) {
    throw new Error(
      `Recipe '${recipe.id}' has goalType '${recipe.goalType}', incompatible with goal '${input.goal.goalType}'.`,
    );
  }

  const workspaceFacts = discoverWorkspaceFacts(input.goal.workspaceRoot);
  const internetEvidence = await collectInternetEvidence({
    sources: recipe.discoverySources,
    policy: input.goal.sourcePolicy,
    curatedDomains: input.goal.curatedSourceDomains,
  });

  const riskFindings = dedupeRiskFindings([
    ...runRiskProbeScan({
      repoRoot: path.resolve(input.goal.workspaceRoot),
      probes: recipe.riskProbes,
    }),
    ...runInternetRiskSynthesis({ evidence: internetEvidence, recipe }),
  ]);

  const plan = buildPlan({
    runId,
    goal: input.goal,
    recipe,
    workspaceFacts,
    discovery: {
      localSummary: summarizeWorkspaceFacts(workspaceFacts),
      internetEvidence,
    },
    riskFindings,
  });

  const validation = validatePlan(plan);
  const execution = executePlan({
    plan,
    validationStatus: validation.status,
    mode: input.mode,
    state,
    timeoutMs: input.commandTimeoutMs ?? 15 * 60 * 1000,
    requireWaveApproval: input.requireWaveApproval,
    approvalsDir: input.approvalsDir,
    requireEvidenceFile: input.requireEvidenceFile,
    evidenceFile: input.evidenceFile,
    rollbackCheckCommand: input.rollbackCheckCommand,
  });

  const nextState = updateState({
    state,
    execution,
    validationIssues: validation.issues,
    persisted: paths,
  });

  const cycleSummary = summarizeCycle({
    runId,
    plan,
    validation,
    execution,
    state: nextState,
    recipeMemory,
  });

  persistCycleArtifacts({
    paths,
    plan,
    validation,
    execution,
    cycleSummary,
    state: nextState,
  });

  return {
    runId,
    state: nextState,
    plan,
    validation,
    execution,
    cycleSummary,
    persistedPaths: paths,
    recipeMemory,
  };
}

export function getRunStatus(args: {
  runId: string;
  runsDir: string;
}): RunState {
  const paths = resolvePersistedPaths(args.runsDir, args.runId);
  const state = loadRunState(paths.statePath);
  if (!state) {
    throw new Error(`Run '${args.runId}' not found in ${path.dirname(paths.statePath)}`);
  }
  return state;
}
