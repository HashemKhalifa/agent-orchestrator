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
  artifacts?: {
    dagManifestPath?: string;
    dagRunSummaryPath?: string;
  };
  recipe?: {
    id?: string;
    title?: string;
    policyPacks?: unknown[];
  };
  dagSummary?: {
    startedAt?: string;
    completedAt?: string;
    status?: string;
    resumedModules?: number;
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
    memoryRevisit?: {
      totalCalls?: number;
      hitsUsed?: number;
      candidatesLoadedBySource?: {
        semanticMemory?: number;
        replayMemory?: number;
        artifactContract?: number;
      };
      selectedBySource?: {
        semanticMemory?: number;
        replayMemory?: number;
        artifactContract?: number;
      };
      skippedByReason?: {
        disabled?: number;
        maxCallsPerModule?: number;
        emptyQuery?: number;
        noCandidates?: number;
        negativeMemoryBlocked?: number;
        belowThreshold?: number;
      };
    };
  };
}

function normalizeGraphMode(value: string | undefined): "v1" | "v2" | "auto" {
  if (!value || value === "auto") return "auto";
  if (value === "v1" || value === "v2") return value;
  return "auto";
}

function compactPaths(values: Array<string | null | undefined>): string[] {
  return values.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function resolveRunArtifactPath(workspaceRoot: string, artifactPath?: string): string | null {
  if (!artifactPath || artifactPath.trim().length === 0) return null;
  const raw = artifactPath.trim();
  return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(workspaceRoot, raw);
}

function selectManifestByMode(args: {
  mode: "v1" | "v2" | "auto";
  manifestV1: ManifestInput | null;
  graphV2: GraphManifestV2Input | null;
  graphPath: string | null;
  errors: string[];
}): ManifestInput {
  if (args.mode === "v2") {
    if (!args.graphV2) {
      throw new Error(
        `mode=v2 requested but graph.json is missing or invalid (expected near ${args.graphPath ?? "generated/orchestration/dag/graph.json"}).`,
      );
    }
    return toManifestFromGraph(args.graphV2);
  }

  if (args.mode === "auto") {
    if (args.manifestV1) {
      return args.manifestV1;
    }
    if (args.graphV2) {
      args.errors.push("auto mode fallback: v1 manifest unavailable; using v2 graph projection.");
      return toManifestFromGraph(args.graphV2);
    }
    return { modules: [] };
  }

  return args.manifestV1 ?? { modules: [] };
}

function toManifestFromGraph(graph: GraphManifestV2Input): ManifestInput {
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph.edges)
    ? graph.edges
        .filter((edge) => edge.source && edge.target)
        .map((edge) => ({
          id: edge.id ?? `${edge.source}->${edge.target}:${edge.kind ?? "depends_on"}`,
          source: edge.source as string,
          target: edge.target as string,
          kind: edge.kind,
          blocking: edge.blocking,
          rationale: edge.rationale ?? null,
        }))
    : [];
  const depsByTarget = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.kind === "depends_on" || edge.kind === "soft_depends_on") {
      const list = depsByTarget.get(edge.target) ?? [];
      list.push(edge.source);
      depsByTarget.set(edge.target, list);
    }
  }

  return {
    modules: nodes
      .filter((node) => typeof node.id === "string" && node.id.trim().length > 0)
      .map((node) => ({
        id: node.id as string,
        title: (node.title ?? node.id) as string,
        description: node.description ?? undefined,
        level: typeof node.level === "number" ? node.level : 0,
        mode: node.mode === "analyze" ? "analyze" : "implement",
        kind: node.kind,
        entryGroup: typeof node.entryGroup === "string" ? node.entryGroup : null,
        lockKeys: Array.isArray(node.lockKeys) ? node.lockKeys : [],
        execution: {
          partPath: node.execution?.partPath ?? "",
          command: node.execution?.command ?? null,
        },
        dependsOn: Array.from(new Set(Array.isArray(node.dependsOn) && node.dependsOn.length > 0
          ? node.dependsOn.filter((dep): dep is string => typeof dep === "string" && dep.trim().length > 0)
          : depsByTarget.get(node.id as string) ?? [])),
      })),
    edges,
  };
}

function toRunSummaryInputFromV2(value: GraphRunSummaryV2Input | null): RunSummaryInput | null {
  if (!value) return null;
  const nodes = Array.isArray(value.nodes) ? value.nodes : [];
  return {
    status: value.status,
    startedAt: value.startedAt ?? undefined,
    completedAt: value.completedAt ?? undefined,
    results: nodes
      .filter((node) => typeof node.id === "string" && node.id.trim().length > 0)
      .map((node) => ({
        moduleId: node.id as string,
        status: toModuleStatus(node.status) ?? "pending",
        attempt: typeof node.attempt === "number" && node.attempt > 0 ? node.attempt : undefined,
        code: typeof node.code === "number" || node.code === null ? node.code : undefined,
        durationMs: typeof node.durationMs === "number" && node.durationMs >= 0 ? node.durationMs : undefined,
        artifactPath: typeof node.artifactPath === "string" ? node.artifactPath : undefined,
        repairTaskPath: typeof node.repairTaskPath === "string" ? node.repairTaskPath : undefined,
      })),
  };
}

function mergeNodeStateArtifacts(
  nodeState: GraphNodeStateV2Input | null,
  artifacts: Map<string, ArtifactInput>,
  mtimeMs: number,
): void {
  if (!nodeState || !Array.isArray(nodeState.nodes)) return;
  for (const node of nodeState.nodes) {
    if (typeof node.id !== "string" || node.id.trim().length === 0) continue;
    const status = toModuleStatus(node.status);
    if (!status) continue;
    artifacts.set(node.id, {
      moduleId: node.id,
      status,
      attempt: typeof node.attempt === "number" && node.attempt > 0 ? node.attempt : undefined,
      code: typeof node.code === "number" || node.code === null ? node.code : null,
      durationMs: typeof node.durationMs === "number" ? node.durationMs : undefined,
      repairTaskPath: typeof node.repairTaskPath === "string" ? node.repairTaskPath : null,
      artifactPath: typeof node.artifactPath === "string" ? node.artifactPath : undefined,
      updatedAt: typeof node.updatedAt === "string" ? node.updatedAt : undefined,
      mtimeMs,
    });
  }
}

function findIterationSummaryByRunId(
  iterationsDir: string | null,
  runId: string,
  errors: string[],
): string | null {
  if (!iterationsDir || !fs.existsSync(iterationsDir)) return null;
  const files = fs
    .readdirSync(iterationsDir)
    .filter((file) => /^auto-run-\d+\.json$/.test(file))
    .map((file) => path.resolve(iterationsDir, file))
    .sort((a, b) => fileMtimeMs(b) - fileMtimeMs(a));

  for (const filePath of files) {
    const payload = readJsonFile<IterationSummaryInput>(filePath, errors, "iteration-summary-select");
    if (!payload) continue;
    if (typeof payload.runId === "string" && payload.runId.trim() === runId.trim()) {
      return filePath;
    }
    if (path.basename(filePath, ".json") === runId.trim()) {
      return filePath;
    }
  }

  errors.push(`runId '${runId}' not found in iteration summaries; using latest run state.`);
  return latestIterationSummary(iterationsDir);
}

interface GraphManifestV2Input {
  schemaVersion?: string;
  nodes?: Array<{
    id?: string;
    title?: string;
    description?: string;
    level?: number;
    mode?: "analyze" | "implement";
    kind?: "module" | "gate" | "policy";
    entryGroup?: string | null;
    lockKeys?: string[];
    execution?: {
      partPath?: string;
      command?: string | null;
    };
    dependsOn?: string[];
  }>;
  edges?: Array<{
    id?: string;
    source?: string;
    target?: string;
    kind?: "depends_on" | "soft_depends_on" | "repair" | "policy_guard";
    blocking?: boolean;
    rationale?: string | null;
  }>;
}

interface GraphRunSummaryV2Input {
  schemaVersion?: string;
  status?: RunStatus;
  startedAt?: string | null;
  completedAt?: string | null;
  nodes?: Array<{
    id?: string;
    status?: string;
    attempt?: number | null;
    code?: number | null;
    durationMs?: number | null;
    artifactPath?: string | null;
    repairTaskPath?: string | null;
  }>;
}

interface GraphNodeStateV2Input {
  schemaVersion?: string;
  nodes?: Array<{
    id?: string;
    status?: string;
    attempt?: number | null;
    code?: number | null;
    durationMs?: number | null;
    artifactPath?: string | null;
    repairTaskPath?: string | null;
    updatedAt?: string | null;
  }>;
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

export interface LoadedRunState {
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
  modeInput?: string;
  runIdInput?: string;
}): LoadedRunState {
  const errors: string[] = [];
  const graphMode = normalizeGraphMode(args.modeInput);
  const workspaceRoot = resolveWorkspaceRoot(args.repoRoot, args.workspaceRootInput);
  const autonomyDirAbs = resolveAutonomyDir(workspaceRoot, args.autonomyDirInput);
  const requestedRunId = args.runIdInput?.trim() || null;

  const iterationDir = pickExistingDir([
    path.resolve(autonomyDirAbs, "iterations"),
    path.resolve(workspaceRoot, "generated", "orchestration", "autonomy", "iterations"),
  ]);
  const iterationSummaryPath = requestedRunId
    ? findIterationSummaryByRunId(iterationDir, requestedRunId, errors)
    : latestIterationSummary(iterationDir);
  const iterationSummary = readJsonFile<IterationSummaryInput>(iterationSummaryPath, errors, "iteration-summary");
  const iterationManifestPath = resolveRunArtifactPath(workspaceRoot, iterationSummary?.artifacts?.dagManifestPath);
  const iterationRunSummaryPath = resolveRunArtifactPath(workspaceRoot, iterationSummary?.artifacts?.dagRunSummaryPath);

  const manifestPath = pickNewestFile(compactPaths([
    iterationManifestPath,
    path.resolve(autonomyDirAbs, "dag", "manifest.json"),
    path.resolve(workspaceRoot, "generated", "orchestration", "dag", "manifest.json"),
  ]));
  const graphPath = pickNewestFile(compactPaths([
    manifestPath ? path.resolve(path.dirname(manifestPath), "graph.json") : null,
    iterationManifestPath ? path.resolve(path.dirname(iterationManifestPath), "graph.json") : null,
    path.resolve(autonomyDirAbs, "dag", "graph.json"),
    path.resolve(workspaceRoot, "generated", "orchestration", "dag", "graph.json"),
  ]));
  const runSummaryPath = pickNewestFile(compactPaths([
    iterationRunSummaryPath,
    path.resolve(autonomyDirAbs, "dag", "run-summary.json"),
    path.resolve(workspaceRoot, "generated", "orchestration", "dag", "run-summary.json"),
  ]));
  const runSummaryV2Path = pickNewestFile(compactPaths([
    runSummaryPath ? path.resolve(path.dirname(runSummaryPath), "run-summary.v2.json") : null,
    path.resolve(autonomyDirAbs, "dag", "run-summary.v2.json"),
    path.resolve(workspaceRoot, "generated", "orchestration", "dag", "run-summary.v2.json"),
  ]));
  const nodeStateV2Path = pickNewestFile(compactPaths([
    runSummaryPath ? path.resolve(path.dirname(runSummaryPath), "node-state.v2.json") : null,
    path.resolve(autonomyDirAbs, "dag", "node-state.v2.json"),
    path.resolve(workspaceRoot, "generated", "orchestration", "dag", "node-state.v2.json"),
  ]));
  const eventsPath = pickNewestFile(compactPaths([
    runSummaryPath && runSummaryPath.endsWith(".json")
      ? `${runSummaryPath.slice(0, Math.max(0, runSummaryPath.length - 5))}.events.ndjson`
      : null,
    path.resolve(autonomyDirAbs, "dag", "run-summary.events.ndjson"),
    path.resolve(workspaceRoot, "generated", "orchestration", "dag", "run-summary.events.ndjson"),
  ]));

  const manifestV1 = readJsonFile<ManifestInput>(manifestPath, errors, "manifest");
  const graphV2 = readJsonFile<GraphManifestV2Input>(graphPath, errors, "graph");
  const manifest = selectManifestByMode({
    mode: graphMode,
    manifestV1,
    graphV2,
    graphPath,
    errors,
  });

  const runSummaryV1 = readJsonFile<RunSummaryInput>(runSummaryPath, errors, "run-summary");
  const runSummaryV2 = readJsonFile<GraphRunSummaryV2Input>(runSummaryV2Path, errors, "run-summary.v2");
  const nodeStateV2 = readJsonFile<GraphNodeStateV2Input>(nodeStateV2Path, errors, "node-state.v2");
  const runSummary = runSummaryV1 ?? toRunSummaryInputFromV2(runSummaryV2);
  const runSummaryMtimeMs = Math.max(fileMtimeMs(runSummaryPath), fileMtimeMs(runSummaryV2Path), fileMtimeMs(nodeStateV2Path));

  const artifactsSearch = [
    runSummaryPath ? path.resolve(path.dirname(runSummaryPath), "artifacts") : null,
    path.resolve(autonomyDirAbs, "dag", "artifacts"),
    path.resolve(workspaceRoot, "generated", "orchestration", "dag", "artifacts"),
  ];
  const artifactsDir = pickArtifactsDir(compactPaths(artifactsSearch));
  const artifacts = artifactsDir
    ? loadArtifactsByModule(artifactsDir, workspaceRoot, errors)
    : new Map<string, ArtifactInput>();
  mergeNodeStateArtifacts(nodeStateV2, artifacts, fileMtimeMs(nodeStateV2Path));

  const normalized = normalizeRunState({
    manifest,
    runSummary,
    artifacts,
    runSummaryMtimeMs,
  });
  const history = loadRunHistory(iterationDir, workspaceRoot, errors, 30);
  const telemetry = buildTelemetry(iterationSummary, runSummary);

  return {
    graphMode,
    sourcePaths: {
      manifestPath: manifestPath ? toPortable(path.relative(workspaceRoot, manifestPath)) : null,
      graphPath: graphPath ? toPortable(path.relative(workspaceRoot, graphPath)) : null,
      runSummaryPath: runSummaryPath ? toPortable(path.relative(workspaceRoot, runSummaryPath)) : null,
      runSummaryV2Path: runSummaryV2Path ? toPortable(path.relative(workspaceRoot, runSummaryV2Path)) : null,
      nodeStateV2Path: nodeStateV2Path ? toPortable(path.relative(workspaceRoot, nodeStateV2Path)) : null,
      eventsPath: eventsPath ? toPortable(path.relative(workspaceRoot, eventsPath)) : null,
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
    const status = toModuleStatus(raw?.status);
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

function toModuleStatus(value: unknown): ArtifactInput["status"] | null {
  if (value === "success" || value === "failed" || value === "blocked" || value === "skipped" || value === "pending") {
    return value;
  }
  if (value === "ready" || value === "running") return "pending";
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
  const memory = iterationSummary?.dagSummary?.memoryRevisit;
  const memoryCandidatesSemantic = numberOrNull(memory?.candidatesLoadedBySource?.semanticMemory) ?? 0;
  const memoryCandidatesReplay = numberOrNull(memory?.candidatesLoadedBySource?.replayMemory) ?? 0;
  const memoryCandidatesArtifact = numberOrNull(memory?.candidatesLoadedBySource?.artifactContract) ?? 0;
  const memorySelectedSemantic = numberOrNull(memory?.selectedBySource?.semanticMemory) ?? 0;
  const memorySelectedReplay = numberOrNull(memory?.selectedBySource?.replayMemory) ?? 0;
  const memorySelectedArtifact = numberOrNull(memory?.selectedBySource?.artifactContract) ?? 0;
  const skippedReasons = memory?.skippedByReason;
  const skippedTokens = skippedReasons
    ? Object.entries(skippedReasons)
      .map(([key, value]) => [key, numberOrNull(value) ?? 0] as const)
      .filter(([, value]) => value > 0)
      .map(([key, value]) => `${key}:${value}`)
    : [];
  const memorySkippedTotal = skippedReasons
    ? (numberOrNull(skippedReasons.disabled) ?? 0) +
      (numberOrNull(skippedReasons.maxCallsPerModule) ?? 0) +
      (numberOrNull(skippedReasons.emptyQuery) ?? 0) +
      (numberOrNull(skippedReasons.noCandidates) ?? 0) +
      (numberOrNull(skippedReasons.negativeMemoryBlocked) ?? 0) +
      (numberOrNull(skippedReasons.belowThreshold) ?? 0)
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
    resumedModules: numberOrNull(iterationSummary?.dagSummary?.resumedModules) ?? 0,
    repairsGenerated: numberOrNull(iterationSummary?.dagSummary?.repairsGenerated) ?? 0,
    policyPackCount,
    memoryCalls: numberOrNull(memory?.totalCalls) ?? 0,
    memoryHits: numberOrNull(memory?.hitsUsed) ?? 0,
    memoryCandidatesLoaded: memoryCandidatesSemantic + memoryCandidatesReplay + memoryCandidatesArtifact,
    memoryCandidatesSemantic,
    memoryCandidatesReplay,
    memoryCandidatesArtifact,
    memorySelectedSemantic,
    memorySelectedReplay,
    memorySelectedArtifact,
    memorySkippedTotal,
    memorySkippedPreview: skippedTokens.length > 0 ? skippedTokens.join(", ") : null,
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
