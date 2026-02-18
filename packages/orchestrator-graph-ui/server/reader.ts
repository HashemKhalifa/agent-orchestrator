import fs from "node:fs";
import path from "node:path";
import {
  normalizeRunState,
  type ArtifactInput,
  type ManifestInput,
  type RunStatus,
  type RunSummaryInput,
} from "./normalize.js";

interface IterationSummaryInput {
  runId?: string;
  generatedAt?: string;
  dagStatus?: string;
  recipe?: {
    id?: string;
    title?: string;
    policyPacks?: unknown[];
  };
  dagSummary?: {
    startedAt?: string;
    completedAt?: string;
    status?: string;
    repairsGenerated?: number;
    policyPacks?: unknown[];
    results?: Array<{
      moduleId?: string;
      status?: string;
      durationMs?: number;
      attempt?: number;
    }>;
    budget?: {
      totalAttempts?: number;
      totalTokensEffective?: number;
      totalTokensEstimated?: number;
      totalTokensObserved?: number;
      elapsedMs?: number;
    };
  };
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

export interface LoadedRunState {
  sourcePaths: {
    manifestPath: string | null;
    runSummaryPath: string | null;
    artifactsDir: string | null;
    iterationSummaryPath: string | null;
  };
  run: ReturnType<typeof normalizeRunState>["run"];
  nodes: ReturnType<typeof normalizeRunState>["nodes"];
  edges: ReturnType<typeof normalizeRunState>["edges"];
  history: RunHistoryEntry[];
  telemetry: RunTelemetry | null;
  errors: string[];
}

export function loadRunState(args: {
  repoRoot: string;
  workspaceRootInput?: string;
  autonomyDirInput?: string;
}): LoadedRunState {
  const errors: string[] = [];
  const workspaceRoot = resolveWorkspaceRoot(args.repoRoot, args.workspaceRootInput);
  const autonomyDirAbs = resolveAutonomyDir(workspaceRoot, args.autonomyDirInput);

  const iterationDir = pickExistingDir([
    path.resolve(autonomyDirAbs, "iterations"),
    path.resolve(workspaceRoot, "generated", "orchestration", "autonomy", "iterations"),
  ]);
  const manifestPath = pickNewestFile([
    path.resolve(autonomyDirAbs, "dag", "manifest.json"),
    path.resolve(workspaceRoot, "generated", "orchestration", "dag", "manifest.json"),
  ]);
  const runSummaryPath = pickNewestFile([
    path.resolve(autonomyDirAbs, "dag", "run-summary.json"),
    path.resolve(workspaceRoot, "generated", "orchestration", "dag", "run-summary.json"),
  ]);
  const iterationSummaryPath = latestIterationSummary(iterationDir);

  const manifest = readJsonFile<ManifestInput>(manifestPath, errors, "manifest") ?? { modules: [] };
  const runSummary = readJsonFile<RunSummaryInput>(runSummaryPath, errors, "run-summary");
  const iterationSummary = readJsonFile<IterationSummaryInput>(iterationSummaryPath, errors, "iteration-summary");
  const runSummaryMtimeMs = fileMtimeMs(runSummaryPath);

  const artifactsSearch = [
    path.resolve(autonomyDirAbs, "dag", "artifacts"),
    path.resolve(workspaceRoot, "generated", "orchestration", "dag", "artifacts"),
  ];
  const artifactsDir = pickArtifactsDir(artifactsSearch);
  const artifacts = artifactsDir
    ? loadArtifactsByModule(artifactsDir, workspaceRoot, errors)
    : new Map<string, ArtifactInput>();

  const normalized = normalizeRunState({
    manifest,
    runSummary,
    artifacts,
    runSummaryMtimeMs,
  });
  const history = loadRunHistory(iterationDir, workspaceRoot, errors, 30);
  const telemetry = buildTelemetry(iterationSummary, runSummary);

  return {
    sourcePaths: {
      manifestPath: manifestPath ? toPortable(path.relative(workspaceRoot, manifestPath)) : null,
      runSummaryPath: runSummaryPath ? toPortable(path.relative(workspaceRoot, runSummaryPath)) : null,
      artifactsDir: artifactsDir ? toPortable(path.relative(workspaceRoot, artifactsDir)) : null,
      iterationSummaryPath: iterationSummaryPath ? toPortable(path.relative(workspaceRoot, iterationSummaryPath)) : null,
    },
    run: normalized.run,
    nodes: normalized.nodes,
    edges: normalized.edges,
    history,
    telemetry,
    errors,
  };
}

function resolveWorkspaceRoot(repoRoot: string, workspaceRootInput?: string): string {
  const raw = workspaceRootInput?.trim() || "packages/orchestrator-standalone";
  if (path.isAbsolute(raw)) return path.resolve(raw);
  return path.resolve(repoRoot, raw);
}

function resolveAutonomyDir(workspaceRoot: string, autonomyDirInput?: string): string {
  const raw = autonomyDirInput?.trim() || "generated/orchestration/autonomy";
  if (path.isAbsolute(raw)) return path.resolve(raw);
  return path.resolve(workspaceRoot, raw);
}

function latestIterationSummary(iterationsDir: string | null): string | null {
  if (!iterationsDir || !fs.existsSync(iterationsDir)) return null;
  const files = fs
    .readdirSync(iterationsDir)
    .filter((file) => /^auto-run-\d+\.json$/.test(file))
    .map((file) => path.resolve(iterationsDir, file));

  files.sort((a, b) => fileMtimeMs(b) - fileMtimeMs(a));
  return files[0] ?? null;
}

function readJsonFile<T>(filePath: string | null, errors: string[], label: string): T | null {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    errors.push(`${label} parse error (${toPortable(filePath)}): ${(error as Error).message}`);
    return null;
  }
}

function fileMtimeMs(filePath: string | null): number {
  if (!filePath) return 0;
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function pickNewestFile(candidates: string[]): string | null {
  let best: { path: string; mtime: number } | null = null;
  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) continue;
    const mtime = fileMtimeMs(filePath);
    if (!best || mtime > best.mtime) best = { path: filePath, mtime };
  }
  return best?.path ?? null;
}

function pickExistingDir(candidates: string[]): string | null {
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

function pickArtifactsDir(candidates: string[]): string | null {
  let best: { path: string; mtime: number } | null = null;

  for (const dir of candidates) {
    if (!fs.existsSync(dir)) continue;

    const files = fs
      .readdirSync(dir)
      .filter((file) => file.endsWith(".artifact.json") && file.includes(".attempt-"))
      .map((file) => path.resolve(dir, file));

    if (files.length === 0) continue;

    const newest = Math.max(...files.map((file) => fileMtimeMs(file)));
    if (!best || newest > best.mtime) {
      best = { path: dir, mtime: newest };
    }
  }

  return best?.path ?? null;
}

function loadArtifactsByModule(
  artifactsDir: string,
  workspaceRoot: string,
  errors: string[],
): Map<string, ArtifactInput> {
  const out = new Map<string, ArtifactInput>();

  const files = fs
    .readdirSync(artifactsDir)
    .filter((file) => file.endsWith(".artifact.json") && file.includes(".attempt-"))
    .map((file) => path.resolve(artifactsDir, file));

  for (const filePath of files) {
    let raw: any;
    try {
      raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
      errors.push(`artifact parse error (${toPortable(filePath)}): ${(error as Error).message}`);
      continue;
    }

    const moduleId = String(raw?.moduleId ?? "").trim();
    if (!moduleId) continue;

    const attempt = typeof raw?.attempt === "number" ? raw.attempt : parseAttemptFromFile(path.basename(filePath));
    const status = toStatus(raw?.status);
    if (!status) continue;

    const artifact: ArtifactInput = {
      moduleId,
      status,
      attempt,
      code: typeof raw?.command?.code === "number" || raw?.command?.code === null ? raw.command.code : null,
      durationMs: typeof raw?.command?.durationMs === "number" ? raw.command.durationMs : undefined,
      criticSeverity: typeof raw?.criticSeverity === "string" ? raw.criticSeverity : null,
      repairTaskPath: typeof raw?.repairTaskPath === "string" ? raw.repairTaskPath : null,
      artifactPath: toPortable(path.relative(workspaceRoot, filePath)),
      changedFilesCount: Array.isArray(raw?.changedFiles) ? raw.changedFiles.length : 0,
      riskNotesCount: Array.isArray(raw?.riskNotes) ? raw.riskNotes.length : 0,
      updatedAt: typeof raw?.generatedAt === "string" ? raw.generatedAt : null,
      mtimeMs: fileMtimeMs(filePath),
    };

    const existing = out.get(moduleId);
    if (!existing) {
      out.set(moduleId, artifact);
      continue;
    }

    const existingAttempt = existing.attempt ?? 0;
    const nextAttempt = artifact.attempt ?? 0;

    if (nextAttempt > existingAttempt || (nextAttempt === existingAttempt && (artifact.mtimeMs ?? 0) > (existing.mtimeMs ?? 0))) {
      out.set(moduleId, artifact);
    }
  }

  return out;
}

function parseAttemptFromFile(fileName: string): number | undefined {
  const match = fileName.match(/\.attempt-(\d+)\.artifact\.json$/);
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toStatus(value: unknown): ArtifactInput["status"] | null {
  if (value === "success" || value === "failed" || value === "blocked" || value === "skipped" || value === "pending") {
    return value;
  }
  return null;
}

function toPortable(input: string): string {
  return input.replace(/\\/g, "/");
}

function loadRunHistory(
  iterationsDir: string | null,
  workspaceRoot: string,
  errors: string[],
  limit: number,
): RunHistoryEntry[] {
  if (!iterationsDir || !fs.existsSync(iterationsDir)) return [];

  const files = fs
    .readdirSync(iterationsDir)
    .filter((file) => /^auto-run-\d+\.json$/.test(file))
    .map((file) => path.resolve(iterationsDir, file))
    .sort((a, b) => fileMtimeMs(b) - fileMtimeMs(a))
    .slice(0, Math.max(1, limit));

  const out: RunHistoryEntry[] = [];

  for (const filePath of files) {
    const payload = readJsonFile<IterationSummaryInput>(filePath, errors, "history");
    if (!payload) continue;

    const results = payload.dagSummary?.results ?? [];
    const counts = summarizeResultStatuses(results.map((result) => String(result?.status ?? "")));
    const elapsedMs = numberOrNull(payload.dagSummary?.budget?.elapsedMs);
    const runId = typeof payload.runId === "string" && payload.runId.trim().length > 0
      ? payload.runId
      : path.basename(filePath, ".json");

    out.push({
      runId,
      recipeId: typeof payload.recipe?.id === "string" ? payload.recipe.id : null,
      generatedAt: typeof payload.generatedAt === "string" ? payload.generatedAt : null,
      status: toRunStatus(payload.dagStatus ?? payload.dagSummary?.status),
      successCount: counts.successCount,
      failedCount: counts.failedCount,
      blockedCount: counts.blockedCount,
      skippedCount: counts.skippedCount,
      totalModules: results.length,
      elapsedMs,
      totalTokensEffective: numberOrNull(payload.dagSummary?.budget?.totalTokensEffective),
      totalTokensEstimated: numberOrNull(payload.dagSummary?.budget?.totalTokensEstimated),
      summaryPath: toPortable(path.relative(workspaceRoot, filePath)),
    });
  }

  return out;
}

function buildTelemetry(
  iterationSummary: IterationSummaryInput | null,
  runSummary: RunSummaryInput | null,
): RunTelemetry | null {
  const iterationResults = iterationSummary?.dagSummary?.results ?? [];
  const fallbackResults = runSummary?.results ?? [];
  const results = iterationResults.length > 0 ? iterationResults : fallbackResults;
  if (results.length === 0 && !iterationSummary) return null;

  const durations = results
    .map((result) => numberOrNull((result as { durationMs?: number }).durationMs))
    .filter((value): value is number => value != null && value >= 0);

  const totalDurationMs = durations.reduce((sum, duration) => sum + duration, 0);
  const longestModuleDurationMs = durations.length > 0 ? Math.max(...durations) : 0;
  const averageModuleDurationMs = durations.length > 0 ? Math.round(totalDurationMs / durations.length) : 0;

  const policyPackCount = Array.isArray(iterationSummary?.dagSummary?.policyPacks)
    ? iterationSummary!.dagSummary!.policyPacks!.length
    : Array.isArray(iterationSummary?.recipe?.policyPacks)
      ? iterationSummary!.recipe!.policyPacks!.length
      : 0;

  return {
    totalModules: results.length,
    totalAttempts: numberOrNull(iterationSummary?.dagSummary?.budget?.totalAttempts),
    totalDurationMs,
    averageModuleDurationMs,
    longestModuleDurationMs,
    elapsedMs: numberOrNull(iterationSummary?.dagSummary?.budget?.elapsedMs),
    totalTokensEffective: numberOrNull(iterationSummary?.dagSummary?.budget?.totalTokensEffective),
    totalTokensEstimated: numberOrNull(iterationSummary?.dagSummary?.budget?.totalTokensEstimated),
    totalTokensObserved: numberOrNull(iterationSummary?.dagSummary?.budget?.totalTokensObserved),
    repairsGenerated: numberOrNull(iterationSummary?.dagSummary?.repairsGenerated) ?? 0,
    policyPackCount,
    generatedAt: typeof iterationSummary?.generatedAt === "string" ? iterationSummary.generatedAt : null,
  };
}

function summarizeResultStatuses(statuses: string[]): {
  successCount: number;
  failedCount: number;
  blockedCount: number;
  skippedCount: number;
} {
  let successCount = 0;
  let failedCount = 0;
  let blockedCount = 0;
  let skippedCount = 0;

  for (const status of statuses) {
    if (status === "success") successCount += 1;
    else if (status === "failed") failedCount += 1;
    else if (status === "blocked") blockedCount += 1;
    else if (status === "skipped") skippedCount += 1;
  }

  return { successCount, failedCount, blockedCount, skippedCount };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toRunStatus(value: unknown): RunStatus {
  if (value === "success" || value === "partial_failure" || value === "failure" || value === "unknown") {
    return value;
  }
  return "unknown";
}
