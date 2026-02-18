import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { discoverWorkspaceFacts } from "../adapters/workspace-discovery.js";
import { synthesizeTaskRequest } from "../autonomy/task-synthesizer.js";
import { compileRequestDag } from "../dag/compiler.js";
import { runDag } from "../dag/runner.js";
import { buildRagIndex } from "../rag/indexer.js";
import { queryRagIndex } from "../rag/retriever.js";
import { GoalTypeSchema } from "../spec/schemas.js";

interface BenchmarkScenario {
  id: string;
  goalType: string;
  recipeId: string;
  query: string;
  expected?: {
    buildTools?: string[];
    testTools?: string[];
    topHitPathIncludes?: string;
  };
}

interface BenchmarkCheck {
  name: string;
  passed: boolean;
  detail: string;
}

interface FailureDrillResult {
  id: "canary_failure" | "budget_exhaustion";
  passed: boolean;
  status: "success" | "partial_failure" | "failure";
  detail: string;
  timeMs: number;
  costTokens: number;
}

interface ScenarioScorecard {
  id: string;
  qualityScore: number;
  timeMs: number;
  costTokens: number;
  failureRate: number;
  dagStatus: "success" | "partial_failure" | "failure";
  modules: {
    total: number;
    failed: number;
    blocked: number;
  };
  checks: BenchmarkCheck[];
  failureDrills: FailureDrillResult[];
}

interface BenchmarkTotals {
  scenarios: number;
  avgQualityScore: number;
  avgTimeMs: number;
  avgCostTokens: number;
  avgFailureRate: number;
  passRate: number;
}

interface BenchmarkHistoryEntry {
  generatedAt: string;
  commit: string;
  totals: BenchmarkTotals;
}

interface BenchmarkDelta {
  previousCommit: string;
  qualityScoreDelta: number;
  timeMsDelta: number;
  costTokensDelta: number;
  failureRateDelta: number;
  passRateDelta: number;
}

interface BenchmarkTrendThresholds {
  maxQualityScoreDrop: number | null;
  maxTimeMsIncrease: number | null;
  maxCostTokensIncrease: number | null;
  maxFailureRateIncrease: number | null;
  maxPassRateDrop: number | null;
}

interface BenchmarkTrendGate {
  enabled: boolean;
  checked: boolean;
  passed: boolean;
  violations: string[];
  thresholds: BenchmarkTrendThresholds;
}

function loadScenarios(fixturesDir: string): BenchmarkScenario[] {
  const scenariosPath = path.join(fixturesDir, "scenarios.json");
  const parsed = JSON.parse(readFileSync(scenariosPath, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error(`Invalid scenarios file: ${scenariosPath}`);
  }
  return parsed as BenchmarkScenario[];
}

function checkIncludes(all: string[], expected: string[]): { passed: boolean; missing: string[] } {
  const lower = new Set(all.map((item) => item.toLowerCase()));
  const missing = expected.filter((item) => !lower.has(item.toLowerCase()));
  return { passed: missing.length === 0, missing };
}

function qualityFromChecks(checks: Array<{ passed: boolean }>): number {
  if (checks.length === 0) return 100;
  const passed = checks.filter((check) => check.passed).length;
  return Math.round((passed / checks.length) * 100);
}

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) / 100;
}

function roundDelta(value: number): number {
  return Math.round(value * 100) / 100;
}

function normalizeThreshold(value: number | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value >= 0 ? value : null;
}

function resolveTrendThresholds(args?: {
  maxQualityScoreDrop?: number;
  maxTimeMsIncrease?: number;
  maxCostTokensIncrease?: number;
  maxFailureRateIncrease?: number;
  maxPassRateDrop?: number;
}): BenchmarkTrendThresholds {
  return {
    maxQualityScoreDrop: normalizeThreshold(args?.maxQualityScoreDrop),
    maxTimeMsIncrease: normalizeThreshold(args?.maxTimeMsIncrease),
    maxCostTokensIncrease: normalizeThreshold(args?.maxCostTokensIncrease),
    maxFailureRateIncrease: normalizeThreshold(args?.maxFailureRateIncrease),
    maxPassRateDrop: normalizeThreshold(args?.maxPassRateDrop),
  };
}

function trendGateEnabled(thresholds: BenchmarkTrendThresholds): boolean {
  return Object.values(thresholds).some((value) => value !== null);
}

function evaluateTrendGate(args: {
  thresholds: BenchmarkTrendThresholds;
  delta: BenchmarkDelta | null;
}): BenchmarkTrendGate {
  const enabled = trendGateEnabled(args.thresholds);
  if (!enabled) {
    return {
      enabled: false,
      checked: false,
      passed: true,
      violations: [],
      thresholds: args.thresholds,
    };
  }

  if (!args.delta) {
    return {
      enabled: true,
      checked: false,
      passed: true,
      violations: [],
      thresholds: args.thresholds,
    };
  }

  const violations: string[] = [];
  const qualityDrop = -args.delta.qualityScoreDelta;
  const passRateDrop = -args.delta.passRateDelta;

  if (
    args.thresholds.maxQualityScoreDrop !== null &&
    qualityDrop > args.thresholds.maxQualityScoreDrop
  ) {
    violations.push(
      `quality score dropped by ${roundDelta(qualityDrop)} (> ${args.thresholds.maxQualityScoreDrop})`,
    );
  }
  if (
    args.thresholds.maxTimeMsIncrease !== null &&
    args.delta.timeMsDelta > args.thresholds.maxTimeMsIncrease
  ) {
    violations.push(
      `avg time increased by ${roundDelta(args.delta.timeMsDelta)}ms (> ${args.thresholds.maxTimeMsIncrease}ms)`,
    );
  }
  if (
    args.thresholds.maxCostTokensIncrease !== null &&
    args.delta.costTokensDelta > args.thresholds.maxCostTokensIncrease
  ) {
    violations.push(
      `avg cost increased by ${roundDelta(args.delta.costTokensDelta)} tokens (> ${args.thresholds.maxCostTokensIncrease})`,
    );
  }
  if (
    args.thresholds.maxFailureRateIncrease !== null &&
    args.delta.failureRateDelta > args.thresholds.maxFailureRateIncrease
  ) {
    violations.push(
      `avg failure rate increased by ${roundDelta(args.delta.failureRateDelta)} (> ${args.thresholds.maxFailureRateIncrease})`,
    );
  }
  if (
    args.thresholds.maxPassRateDrop !== null &&
    passRateDrop > args.thresholds.maxPassRateDrop
  ) {
    violations.push(
      `pass rate dropped by ${roundDelta(passRateDrop)} (> ${args.thresholds.maxPassRateDrop})`,
    );
  }

  return {
    enabled: true,
    checked: true,
    passed: violations.length === 0,
    violations,
    thresholds: args.thresholds,
  };
}

function resolveCommit(commitOverride?: string): string {
  if (commitOverride) return commitOverride;
  const envCommit = process.env.GITHUB_SHA || process.env.CI_COMMIT_SHA;
  if (envCommit) return envCommit.slice(0, 12);

  const rev = spawnSync("git rev-parse --short=12 HEAD", {
    shell: true,
    encoding: "utf8",
    timeout: 5000,
  });
  if (rev.status === 0 && rev.stdout.trim()) return rev.stdout.trim();
  return "unknown";
}

function loadHistory(historyPath: string): BenchmarkHistoryEntry[] {
  if (!existsSync(historyPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(historyPath, "utf8"));
    return Array.isArray(parsed) ? parsed as BenchmarkHistoryEntry[] : [];
  } catch {
    return [];
  }
}

function saveHistory(historyPath: string, history: BenchmarkHistoryEntry[]): void {
  mkdirSync(path.dirname(historyPath), { recursive: true });
  writeFileSync(historyPath, `${JSON.stringify(history, null, 2)}\n`, "utf8");
}

async function runFailureDrills(args: {
  repoRoot: string;
  manifestPath: string;
  includeFailureDrills: boolean;
}): Promise<FailureDrillResult[]> {
  if (!args.includeFailureDrills) return [];

  const drills: FailureDrillResult[] = [];

  {
    const startedAt = Date.now();
    const run = await runDag({
      workspaceRoot: args.repoRoot,
      manifestPath: args.manifestPath,
      executorTemplate: "echo module {id}",
      dryRun: true,
      canaryLimitModules: 1,
      canaryCompareCommand: "node -e \"process.exit(1)\"",
    });
    drills.push({
      id: "canary_failure",
      passed: run.status === "partial_failure" && run.results.some((result) => result.status === "blocked"),
      status: run.status,
      detail: `status=${run.status}; blocked=${run.results.filter((result) => result.status === "blocked").length}`,
      timeMs: Math.max(0, Date.now() - startedAt),
      costTokens: run.budget?.totalTokensEffective ?? run.budget?.totalTokensEstimate ?? 0,
    });
  }

  {
    const startedAt = Date.now();
    const run = await runDag({
      workspaceRoot: args.repoRoot,
      manifestPath: args.manifestPath,
      executorTemplate: "echo module {id}",
      dryRun: true,
      maxTotalAttempts: 1,
    });
    drills.push({
      id: "budget_exhaustion",
      passed: Boolean(run.budget?.exhausted),
      status: run.status,
      detail: `status=${run.status}; exhausted=${run.budget?.exhausted ? "true" : "false"}`,
      timeMs: Math.max(0, Date.now() - startedAt),
      costTokens: run.budget?.totalTokensEffective ?? run.budget?.totalTokensEstimate ?? 0,
    });
  }

  return drills;
}

export async function runBenchmarkEvaluation(args?: {
  fixturesDir?: string;
  topK?: number;
  includeFailureDrills?: boolean;
  historyPath?: string;
  persistHistory?: boolean;
  commit?: string;
  trendThresholds?: {
    maxQualityScoreDrop?: number;
    maxTimeMsIncrease?: number;
    maxCostTokensIncrease?: number;
    maxFailureRateIncrease?: number;
    maxPassRateDrop?: number;
  };
}): Promise<{
  fixturesDir: string;
  generatedAt: string;
  commit: string;
  totals: BenchmarkTotals;
  scorecards: ScenarioScorecard[];
  trend: {
    historyPath: string | null;
    entryCount: number;
    deltaFromPrevious: BenchmarkDelta | null;
    gate: BenchmarkTrendGate;
  };
}> {
  const fixturesDir = path.resolve(
    args?.fixturesDir ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../testdata/golden"),
  );
  const scenarios = loadScenarios(fixturesDir);
  const scorecards: ScenarioScorecard[] = [];
  const includeFailureDrills = args?.includeFailureDrills ?? true;

  for (const scenario of scenarios) {
    GoalTypeSchema.parse(scenario.goalType);
    const repoRoot = path.join(fixturesDir, scenario.id);

    if (!existsSync(repoRoot)) {
      scorecards.push({
        id: scenario.id,
        qualityScore: 0,
        timeMs: 0,
        costTokens: 0,
        failureRate: 1,
        dagStatus: "failure",
        modules: {
          total: 0,
          failed: 0,
          blocked: 0,
        },
        checks: [{ name: "fixture-exists", passed: false, detail: `missing fixture ${repoRoot}` }],
        failureDrills: [],
      });
      continue;
    }

    const startedAt = Date.now();
    const checks: BenchmarkCheck[] = [];

    const facts = discoverWorkspaceFacts(repoRoot);

    const expectedBuildTools = scenario.expected?.buildTools ?? [];
    if (expectedBuildTools.length > 0) {
      const includes = checkIncludes(facts.detectedBuildTools, expectedBuildTools);
      checks.push({
        name: "build-tools-detected",
        passed: includes.passed,
        detail: includes.passed
          ? `detected: ${facts.detectedBuildTools.join(", ")}`
          : `missing: ${includes.missing.join(", ")}`,
      });
    }

    const expectedTestTools = scenario.expected?.testTools ?? [];
    if (expectedTestTools.length > 0) {
      const includes = checkIncludes(facts.detectedTestTools, expectedTestTools);
      checks.push({
        name: "test-tools-detected",
        passed: includes.passed,
        detail: includes.passed
          ? `detected: ${facts.detectedTestTools.join(", ")}`
          : `missing: ${includes.missing.join(", ")}`,
      });
    }

    const index = buildRagIndex({
      workspaceRoot: repoRoot,
      maxFiles: 200,
      linesPerChunk: 80,
      maxCharsPerChunk: 2500,
    });
    const query = queryRagIndex({
      index,
      query: scenario.query,
      topK: args?.topK ?? 5,
    });

    if (scenario.expected?.topHitPathIncludes) {
      const topHitPath = query.hits[0]?.filePath ?? "";
      const passed = topHitPath.includes(scenario.expected.topHitPathIncludes);
      checks.push({
        name: "rag-top-hit",
        passed,
        detail: passed
          ? `top hit: ${topHitPath}`
          : `expected '${scenario.expected.topHitPathIncludes}', got '${topHitPath || "none"}'`,
      });
    }

    mkdirSync(path.join(repoRoot, "generated", "benchmark"), { recursive: true });

    const synthesized = synthesizeTaskRequest({
      workspaceRoot: repoRoot,
      goalType: scenario.goalType,
      recipeId: scenario.recipeId,
      outputPath: "generated/benchmark/request.generated.md",
      maxTasks: 18,
      ragAutoRefine: true,
      ragRefineMaxTokenBudget: 0,
    });

    await compileRequestDag({
      workspaceRoot: repoRoot,
      requestPath: path.relative(repoRoot, synthesized.requestPath).replace(/\\/g, "/"),
      outputDir: "generated/benchmark/dag",
      dependencyMode: "staged",
    });

    const manifestPath = "generated/benchmark/dag/manifest.json";
    const dagRun = await runDag({
      workspaceRoot: repoRoot,
      manifestPath,
      executorTemplate: "echo module {id}",
      dryRun: true,
      enableCritic: false,
      testImpactMode: "off",
    });

    const failed = dagRun.results.filter((result) => result.status === "failed").length;
    const blocked = dagRun.results.filter((result) => result.status === "blocked").length;
    const totalModules = dagRun.results.length;
    const failureRate = totalModules === 0 ? 1 : (failed + blocked) / totalModules;

    checks.push({
      name: "dag-status",
      passed: dagRun.status === "success",
      detail: `status=${dagRun.status}`,
    });

    const failureDrills = await runFailureDrills({
      repoRoot,
      manifestPath,
      includeFailureDrills,
    });
    for (const drill of failureDrills) {
      checks.push({
        name: `drill-${drill.id}`,
        passed: drill.passed,
        detail: drill.detail,
      });
    }

    const qualityScore = qualityFromChecks(checks);
    const timeMs = Math.max(0, Date.now() - startedAt) + failureDrills.reduce((sum, drill) => sum + drill.timeMs, 0);
    const costTokens =
      (dagRun.budget?.totalTokensEffective ?? dagRun.budget?.totalTokensEstimate ?? 0) +
      failureDrills.reduce((sum, drill) => sum + drill.costTokens, 0);

    scorecards.push({
      id: scenario.id,
      qualityScore,
      timeMs,
      costTokens,
      failureRate,
      dagStatus: dagRun.status,
      modules: {
        total: totalModules,
        failed,
        blocked,
      },
      checks,
      failureDrills,
    });
  }

  const scenariosCount = scorecards.length;
  const passRate = scenariosCount === 0
    ? 0
    : scorecards.filter((scorecard) => scorecard.dagStatus === "success").length / scenariosCount;

  const totals: BenchmarkTotals = {
    scenarios: scenariosCount,
    avgQualityScore: avg(scorecards.map((scorecard) => scorecard.qualityScore)),
    avgTimeMs: avg(scorecards.map((scorecard) => scorecard.timeMs)),
    avgCostTokens: avg(scorecards.map((scorecard) => scorecard.costTokens)),
    avgFailureRate: avg(scorecards.map((scorecard) => scorecard.failureRate)),
    passRate: Math.round(passRate * 10000) / 100,
  };

  const generatedAt = new Date().toISOString();
  const commit = resolveCommit(args?.commit);
  const persistHistory = args?.persistHistory ?? false;
  const historyPath = args?.historyPath ? path.resolve(args.historyPath) : null;
  const thresholds = resolveTrendThresholds(args?.trendThresholds);
  const history = historyPath ? loadHistory(historyPath) : [];
  const previous = history.length > 0 ? history[history.length - 1] : null;
  const deltaFromPrevious: BenchmarkDelta | null = previous
    ? {
      previousCommit: previous.commit,
      qualityScoreDelta: roundDelta(totals.avgQualityScore - previous.totals.avgQualityScore),
      timeMsDelta: roundDelta(totals.avgTimeMs - previous.totals.avgTimeMs),
      costTokensDelta: roundDelta(totals.avgCostTokens - previous.totals.avgCostTokens),
      failureRateDelta: roundDelta(totals.avgFailureRate - previous.totals.avgFailureRate),
      passRateDelta: roundDelta(totals.passRate - previous.totals.passRate),
    }
    : null;

  let entryCount = history.length;
  if (historyPath && persistHistory) {
    const next = history
      .concat([
        {
          generatedAt,
          commit,
          totals,
        },
      ])
      .slice(-200);
    saveHistory(historyPath, next);
    entryCount = next.length;
  }

  const trend: {
    historyPath: string | null;
    entryCount: number;
    deltaFromPrevious: BenchmarkDelta | null;
    gate: BenchmarkTrendGate;
  } = {
    historyPath,
    entryCount,
    deltaFromPrevious,
    gate: evaluateTrendGate({
      thresholds,
      delta: deltaFromPrevious,
    }),
  };

  return {
    fixturesDir,
    generatedAt,
    commit,
    totals,
    scorecards,
    trend,
  };
}
