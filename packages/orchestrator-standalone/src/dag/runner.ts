import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { discoverWorkspaceFacts } from "../adapters/workspace-discovery.js";
import type { WorkspaceFacts } from "../spec/schemas.js";
import {
  DagCriticSeveritySchema,
  DagManifestSchema,
  DagModuleArtifactSchema,
  DagRunResultSchema,
  DagRunSummarySchema,
  type DagCriticFinding,
  type DagCriticSeverity,
  type DagCommandTrace,
  type DagDiffFile,
  type DagModuleArtifact,
  type DagManifest,
  type DagMemoryRevisitHit,
  type DagRunResult,
  type DagRunSummary,
} from "./types.js";
import {
  applyExecutorTemplate,
  buildProfileCommand,
  buildProviderCommand,
  isWaveApproved,
  type ApplyMode,
  type ExecutorProfile,
  type ExecutorProvider,
} from "./executors.js";
import {
  loadPolicyCriticConfig,
  resolvePolicyCriticRules,
  type PolicyCriticParser,
  type ResolvedPolicyCriticRule,
} from "../policy/critic.js";
import { readSemanticState } from "../autonomy/semantic-memory.js";

const SNAPSHOT_IGNORES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".jest-cache",
  ".next",
  ".nx",
  ".turbo",
  ".cache",
  ".omc",
]);
const CHANGED_FILES_CONTEXT_LIMIT = 400;
const CHANGED_FILES_ARTIFACT_LIMIT = 2000;
const DEFAULT_ANALYZE_TIMEOUT_MS = 45_000;

interface CommandCheckResult {
  passed: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

interface BudgetConfig {
  maxTotalAttempts: number | null;
  maxTotalTokens: number | null;
  maxRunDurationMs: number | null;
  failFast: boolean;
}

interface BudgetState {
  totalAttempts: number;
  totalTokensEstimate: number;
  totalTokensObserved: number;
  totalTokensEstimated: number;
  totalTokensEffective: number;
  observedTraceCount: number;
  estimatedTraceCount: number;
  exhausted: boolean;
  reasons: string[];
}

interface TokenAccounting {
  totalTokensObserved: number;
  totalTokensEstimated: number;
  totalTokensEffective: number;
  observedTraceCount: number;
  estimatedTraceCount: number;
}

interface TestImpactResult {
  passed: boolean;
  traces: DagCommandTrace[];
  commands: string[];
  detail: string;
  fullSuiteRan: boolean;
}

type MemoryRevisitSource = DagMemoryRevisitHit["source"];
type MemoryRevisitSkipReason =
  | "disabled"
  | "max_calls_per_module"
  | "empty_query"
  | "no_candidates"
  | "negative_memory_blocked"
  | "below_threshold";

interface MemoryRevisitSourceCounters {
  semanticMemory: number;
  replayMemory: number;
  artifactContract: number;
}

interface MemoryRevisitSkipCounters {
  disabled: number;
  maxCallsPerModule: number;
  emptyQuery: number;
  noCandidates: number;
  negativeMemoryBlocked: number;
  belowThreshold: number;
}

interface MemoryRevisitConfig {
  enabled: boolean;
  recipeId: string | null;
  autonomyDir: string;
  semanticMemoryPath?: string;
  replayMemoryPath?: string;
  maxCallsPerModule: number;
  topK: number;
  minScore: number;
  maxArtifactCandidates: number;
}

interface MemoryRevisitState {
  totalCalls: number;
  hitsUsed: number;
  callsByModule: Map<string, number>;
  candidatesLoadedBySource: MemoryRevisitSourceCounters;
  selectedBySource: MemoryRevisitSourceCounters;
  skippedByReason: MemoryRevisitSkipCounters;
}

interface MemoryRevisitCandidate {
  source: MemoryRevisitSource;
  summary: string;
  reference: string | null;
  tokens: Set<string>;
  baseScore: number;
  timestampMs: number;
  acceptedMitigation: boolean;
  failureFrequency: number;
  negativeMitigation: boolean;
}

interface ResumeArtifactEntry {
  moduleId: string;
  inputDigest: string | null;
  attempt: number;
  generatedAtMs: number;
  artifactPathRel: string;
  artifact: DagModuleArtifact;
}

function loadManifest(manifestPath: string): DagManifest {
  const raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  return DagManifestSchema.parse(raw);
}

function topoLevelOrder(modules: DagManifest["modules"]): Array<{ level: number; moduleIds: string[] }> {
  const idSet = new Set(modules.map((module) => module.id));
  const indegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const module of modules) {
    indegree.set(module.id, 0);
    adjacency.set(module.id, []);
  }

  for (const module of modules) {
    for (const dep of module.dependsOn) {
      if (!idSet.has(dep)) {
        throw new Error(`Module '${module.id}' depends on unknown module '${dep}'.`);
      }
      indegree.set(module.id, (indegree.get(module.id) ?? 0) + 1);
      const list = adjacency.get(dep) ?? [];
      list.push(module.id);
      adjacency.set(dep, list);
    }
  }

  const queue = modules.filter((module) => (indegree.get(module.id) ?? 0) === 0).map((module) => module.id);
  const levels: Array<{ level: number; moduleIds: string[] }> = [];
  const visited = new Set<string>();
  let levelIndex = 0;

  let current = queue;
  while (current.length > 0) {
    const next: string[] = [];
    levels.push({ level: levelIndex, moduleIds: current.slice() });

    for (const id of current) {
      if (visited.has(id)) continue;
      visited.add(id);

      for (const child of adjacency.get(id) ?? []) {
        indegree.set(child, (indegree.get(child) ?? 0) - 1);
        if ((indegree.get(child) ?? 0) === 0) next.push(child);
      }
    }

    current = next;
    levelIndex += 1;
  }

  if (visited.size !== modules.length) {
    throw new Error("Manifest dependency graph contains cycles.");
  }

  return levels;
}

async function runCommandCheck(command: string, cwd: string, timeoutMs: number): Promise<CommandCheckResult> {
  const startedAt = Date.now();
  const maxBuffer = 8 * 1024 * 1024;

  return await new Promise<CommandCheckResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let stdoutOverflow = false;
    let stderrOverflow = false;
    let timedOut = false;
    let settled = false;
    let timeoutFinalizeTimer: NodeJS.Timeout | null = null;

    const finish = (payload: CommandCheckResult) => {
      if (settled) return;
      settled = true;
      if (timeoutFinalizeTimer) clearTimeout(timeoutFinalizeTimer);
      resolve(payload);
    };

    const supportsProcessGroups = process.platform !== "win32";
    const child = spawn(command, {
      cwd,
      shell: true,
      env: process.env,
      detached: supportsProcessGroups,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const killChildTree = (signal: NodeJS.Signals) => {
      if (child.pid == null) return;
      try {
        if (supportsProcessGroups) {
          process.kill(-child.pid, signal);
        } else {
          child.kill(signal);
        }
      } catch {
        // Process may already be gone.
      }
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < maxBuffer) {
        const next = stdout.length + chunk.length;
        if (next <= maxBuffer) {
          stdout += chunk;
          return;
        }
        stdout += chunk.slice(0, Math.max(0, maxBuffer - stdout.length));
      }
      stdoutOverflow = true;
    });

    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < maxBuffer) {
        const next = stderr.length + chunk.length;
        if (next <= maxBuffer) {
          stderr += chunk;
          return;
        }
        stderr += chunk.slice(0, Math.max(0, maxBuffer - stderr.length));
      }
      stderrOverflow = true;
    });

    let forceKillTimer: NodeJS.Timeout | null = null;
    const timeout = setTimeout(() => {
      timedOut = true;
      killChildTree("SIGTERM");
      forceKillTimer = setTimeout(() => {
        killChildTree("SIGKILL");
      }, 1000);
      timeoutFinalizeTimer = setTimeout(() => {
        try {
          child.stdout?.destroy();
          child.stderr?.destroy();
        } catch {
          // ignore stream close errors
        }
        const overflowSuffix = [
          stdoutOverflow ? "stdout truncated" : "",
          stderrOverflow ? "stderr truncated" : "",
        ]
          .filter((line) => line.length > 0)
          .join("; ");
        const timeoutSuffix = `command timed out after ${timeoutMs}ms`;
        const stderrParts = [stderr, timeoutSuffix, overflowSuffix].filter((part) => part.length > 0);
        finish({
          passed: false,
          code: 124,
          stdout,
          stderr: stderrParts.join("\n"),
          durationMs: Math.max(0, Date.now() - startedAt),
        });
      }, 1500);
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      finish({
        passed: false,
        code: null,
        stdout,
        stderr: `${stderr}${stderr ? "\n" : ""}${error.message}`,
        durationMs: Math.max(0, Date.now() - startedAt),
      });
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      const statusCode = timedOut ? 124 : typeof code === "number" ? code : null;
      const overflowSuffix = [
        stdoutOverflow ? "stdout truncated" : "",
        stderrOverflow ? "stderr truncated" : "",
      ]
        .filter((line) => line.length > 0)
        .join("; ");
      const timeoutSuffix = timedOut ? `command timed out after ${timeoutMs}ms` : "";
      const stderrParts = [stderr, timeoutSuffix, overflowSuffix].filter((part) => part.length > 0);

      finish({
        passed: !timedOut && statusCode === 0,
        code: statusCode,
        stdout,
        stderr: stderrParts.join("\n"),
        durationMs: Math.max(0, Date.now() - startedAt),
      });
    });
  });
}

function toCommandTrace(command: string, result: CommandCheckResult): DagCommandTrace {
  return {
    command,
    passed: result.passed,
    code: result.code,
    durationMs: result.durationMs,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function maybeInjectProviderTimeout(command: string, timeoutMs: number): string {
  if (!command.includes("timeboxed.sh")) return command;
  if (/ORCHESTRATOR_PROVIDER_TIMEOUT_MS=\d+/i.test(command)) return command;
  return `ORCHESTRATOR_PROVIDER_TIMEOUT_MS=${Math.max(1000, Math.trunc(timeoutMs))} ${command}`;
}

function computeRetryTimeoutBudgetMs(currentTimeoutMs: number, baseTimeoutMs: number): number {
  const floorStep = 90_000;
  const candidate = currentTimeoutMs + floorStep;
  const cap = Math.max(180_000, baseTimeoutMs + 240_000);
  return Math.max(currentTimeoutMs, Math.min(candidate, cap));
}

const AUTONOMY_REFUSAL_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bwhat would you like to do\b/i, label: "asks for user direction" },
  { pattern: /\bwould you like me to\b/i, label: "asks for user confirmation" },
  { pattern: /\bi need to pause\b/i, label: "explicit pause request" },
  { pattern: /\bbefore I (?:can|do)\b/i, label: "preconditioned on user response" },
  { pattern: /\bi (?:can'?t|cannot) proceed\b/i, label: "cannot proceed statement" },
  { pattern: /\bneed (?:your|human) (?:approval|confirmation)\b/i, label: "requires approval text" },
];

function detectAutonomyRefusal(text: string): string | null {
  if (!text.trim()) return null;
  for (const rule of AUTONOMY_REFUSAL_PATTERNS) {
    if (rule.pattern.test(text)) return rule.label;
  }
  return null;
}

function parseModuleStatusMarker(text: string): "success" | "failed" | null {
  if (!text.trim()) return null;
  const strictLinePattern = /^\s*MODULE_STATUS:\s*(success|failed)\s*$/gim;
  let match: RegExpExecArray | null;
  let last: "success" | "failed" | null = null;
  while ((match = strictLinePattern.exec(text)) !== null) {
    const value = String(match[1] ?? "").toLowerCase();
    if (value === "success" || value === "failed") {
      last = value;
    }
  }
  if (last) return last;

  const keyValuePattern = /\bmodule_status\s*[:=]\s*(success|failed)\b/gi;
  while ((match = keyValuePattern.exec(text)) !== null) {
    const value = String(match[1] ?? "").toLowerCase();
    if (value === "success" || value === "failed") {
      last = value;
    }
  }
  return last;
}

function estimateTokens(value: string): number {
  if (!value) return 0;
  return Math.max(0, Math.ceil(value.length / 4));
}

function estimateTokensFromTrace(trace: DagCommandTrace | null): number {
  if (!trace) return 0;
  return estimateTokens(trace.command) + estimateTokens(trace.stdout) + estimateTokens(trace.stderr);
}

function parseLastInt(input: string, pattern: RegExp): number | null {
  let match: RegExpExecArray | null;
  let value: number | null = null;
  const regex = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  while ((match = regex.exec(input)) !== null) {
    const next = Number(match[1]);
    if (Number.isFinite(next) && next >= 0) value = Math.trunc(next);
  }
  return value;
}

function parseObservedTokens(trace: DagCommandTrace | null): number | null {
  if (!trace) return null;
  const blob = `${trace.stdout}\n${trace.stderr}`;
  if (!blob.trim()) return null;

  const total =
    parseLastInt(blob, /"total_tokens"\s*:\s*(\d+)/i) ??
    parseLastInt(blob, /"totalTokens"\s*:\s*(\d+)/i) ??
    parseLastInt(blob, /\btotal[_\s-]?tokens?\s*[:=]\s*(\d+)/i);

  const prompt =
    parseLastInt(blob, /"prompt_tokens"\s*:\s*(\d+)/i) ??
    parseLastInt(blob, /"input_tokens"\s*:\s*(\d+)/i) ??
    parseLastInt(blob, /"promptTokens"\s*:\s*(\d+)/i) ??
    parseLastInt(blob, /"inputTokens"\s*:\s*(\d+)/i) ??
    parseLastInt(blob, /\b(?:prompt|input)[_\s-]?tokens?\s*[:=]\s*(\d+)/i);

  const completion =
    parseLastInt(blob, /"completion_tokens"\s*:\s*(\d+)/i) ??
    parseLastInt(blob, /"output_tokens"\s*:\s*(\d+)/i) ??
    parseLastInt(blob, /"completionTokens"\s*:\s*(\d+)/i) ??
    parseLastInt(blob, /"outputTokens"\s*:\s*(\d+)/i) ??
    parseLastInt(blob, /\b(?:completion|output)[_\s-]?tokens?\s*[:=]\s*(\d+)/i);

  if (typeof total === "number" && total >= 0) return total;
  if (typeof prompt === "number" || typeof completion === "number") {
    return Math.max(0, (prompt ?? 0) + (completion ?? 0));
  }
  return null;
}

function accumulateTraceTokens(trace: DagCommandTrace | null): TokenAccounting {
  if (!trace) {
    return {
      totalTokensObserved: 0,
      totalTokensEstimated: 0,
      totalTokensEffective: 0,
      observedTraceCount: 0,
      estimatedTraceCount: 0,
    };
  }

  const observed = parseObservedTokens(trace);
  if (typeof observed === "number") {
    return {
      totalTokensObserved: observed,
      totalTokensEstimated: 0,
      totalTokensEffective: observed,
      observedTraceCount: 1,
      estimatedTraceCount: 0,
    };
  }

  const estimated = estimateTokensFromTrace(trace);
  return {
    totalTokensObserved: 0,
    totalTokensEstimated: estimated,
    totalTokensEffective: estimated,
    observedTraceCount: 0,
    estimatedTraceCount: 1,
  };
}

function accumulateTokenAccounting(traces: Array<DagCommandTrace | null>): TokenAccounting {
  const out: TokenAccounting = {
    totalTokensObserved: 0,
    totalTokensEstimated: 0,
    totalTokensEffective: 0,
    observedTraceCount: 0,
    estimatedTraceCount: 0,
  };

  for (const trace of traces) {
    const next = accumulateTraceTokens(trace);
    out.totalTokensObserved += next.totalTokensObserved;
    out.totalTokensEstimated += next.totalTokensEstimated;
    out.totalTokensEffective += next.totalTokensEffective;
    out.observedTraceCount += next.observedTraceCount;
    out.estimatedTraceCount += next.estimatedTraceCount;
  }

  return out;
}

function renderTemplate(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce(
    (acc, [key, value]) => acc.replaceAll(`{${key}}`, value),
    template,
  );
}

function normalizePathForOutput(value: string): string {
  return value.replace(/\\/g, "/");
}

function clampNonNegativeNumber(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, value);
}

function clampAtLeastInt(value: number | undefined, fallback: number, min: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.trunc(value));
}

function tokenizeForRecall(input: string): Set<string> {
  const matches = input.toLowerCase().match(/[a-z0-9][a-z0-9._/-]{1,}/g) ?? [];
  return new Set(matches);
}

function overlapScore(queryTokens: Set<string>, candidateTokens: Set<string>): number {
  if (queryTokens.size === 0 || candidateTokens.size === 0) return 0;
  let overlap = 0;
  for (const token of queryTokens) {
    if (candidateTokens.has(token)) overlap += 1;
  }
  return overlap === 0 ? 0 : overlap / queryTokens.size;
}

function toScore(value: number, precision = 4): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  const scale = 10 ** precision;
  return Math.round(value * scale) / scale;
}

function parseTimeMs(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function sha256File(filePathAbs: string): string {
  try {
    return createHash("sha256").update(readFileSync(filePathAbs)).digest("hex");
  } catch {
    return "";
  }
}

function computeModuleInputDigest(args: {
  module: DagManifest["modules"][number];
  partFileAbs: string;
  requestDigest: string;
  applyMode: ApplyMode;
  policyPacks: string[];
  resolvedCommand: string;
}): string {
  const payload = [
    `id=${args.module.id}`,
    `title=${args.module.title}`,
    `mode=${args.module.mode}`,
    `partPath=${normalizePathForOutput(args.module.partPath)}`,
    `partDigest=${sha256File(args.partFileAbs)}`,
    `requestDigest=${args.requestDigest}`,
    `applyMode=${args.applyMode}`,
    `policyPacks=${args.policyPacks.slice().sort().join(",")}`,
    `resolvedCommand=${args.resolvedCommand}`,
  ].join("\n");
  return sha256(payload);
}

function loadLatestSuccessfulArtifacts(args: {
  workspaceRoot: string;
  artifactsDirRel: string;
}): Map<string, ResumeArtifactEntry> {
  const out = new Map<string, ResumeArtifactEntry>();
  const artifactsAbs = path.resolve(args.workspaceRoot, args.artifactsDirRel);
  if (!existsSync(artifactsAbs)) return out;

  let entries: string[] = [];
  try {
    entries = readdirSync(artifactsAbs);
  } catch {
    return out;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".artifact.json")) continue;
    const artifactAbs = path.resolve(artifactsAbs, entry);
    let parsed: DagModuleArtifact | null = null;
    try {
      parsed = DagModuleArtifactSchema.parse(JSON.parse(readFileSync(artifactAbs, "utf8")));
    } catch {
      parsed = null;
    }
    if (!parsed || parsed.status !== "success") continue;

    const nextGeneratedAtMs = parseTimeMs(parsed.generatedAt);
    const current = out.get(parsed.moduleId);
    if (current && current.generatedAtMs >= nextGeneratedAtMs) continue;

    out.set(parsed.moduleId, {
      moduleId: parsed.moduleId,
      inputDigest: parsed.inputDigest,
      attempt: parsed.attempt,
      generatedAtMs: nextGeneratedAtMs,
      artifactPathRel: normalizePathForOutput(path.relative(args.workspaceRoot, artifactAbs)),
      artifact: parsed,
    });
  }

  return out;
}

function emptySourceCounters(): MemoryRevisitSourceCounters {
  return {
    semanticMemory: 0,
    replayMemory: 0,
    artifactContract: 0,
  };
}

function emptySkipCounters(): MemoryRevisitSkipCounters {
  return {
    disabled: 0,
    maxCallsPerModule: 0,
    emptyQuery: 0,
    noCandidates: 0,
    negativeMemoryBlocked: 0,
    belowThreshold: 0,
  };
}

function sourceKey(source: MemoryRevisitSource): keyof MemoryRevisitSourceCounters {
  if (source === "semantic-memory") return "semanticMemory";
  if (source === "replay-memory") return "replayMemory";
  return "artifactContract";
}

function incrementSourceCounter(counters: MemoryRevisitSourceCounters, source: MemoryRevisitSource, by = 1): void {
  const key = sourceKey(source);
  counters[key] += Math.max(0, by);
}

function incrementSkipCounter(state: MemoryRevisitState, reason: MemoryRevisitSkipReason, by = 1): void {
  const amount = Math.max(0, by);
  if (reason === "disabled") state.skippedByReason.disabled += amount;
  else if (reason === "max_calls_per_module") state.skippedByReason.maxCallsPerModule += amount;
  else if (reason === "empty_query") state.skippedByReason.emptyQuery += amount;
  else if (reason === "no_candidates") state.skippedByReason.noCandidates += amount;
  else if (reason === "negative_memory_blocked") state.skippedByReason.negativeMemoryBlocked += amount;
  else if (reason === "below_threshold") state.skippedByReason.belowThreshold += amount;
}

function recencyScore(timestampMs: number, nowMs: number): number {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return 0.35;
  const ageMs = Math.max(0, nowMs - timestampMs);
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  return Math.exp(-ageDays / 45);
}

function trimText(value: string, maxChars: number): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function toRelativeOrAbsolute(workspaceRoot: string, filePath: string): string {
  const rel = normalizePathForOutput(path.relative(workspaceRoot, filePath));
  if (!rel || rel.startsWith("..")) {
    return normalizePathForOutput(filePath);
  }
  return rel;
}

function normalizeModuleResources(module: DagManifest["modules"][number]): string[] {
  const resources = Array.isArray(module.resources) ? module.resources : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const resource of resources) {
    const normalized = String(resource ?? "").trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function buildFileFingerprint(filePath: string): string {
  const stats = statSync(filePath);
  const hash = createHash("sha1");
  hash.update(String(stats.size));
  hash.update(String(Math.trunc(stats.mtimeMs)));

  if (stats.size <= 512_000) {
    try {
      hash.update(readFileSync(filePath));
    } catch {
      // Keep metadata-based hash when file cannot be read.
    }
  }

  return hash.digest("hex");
}

function shouldIgnoreDirName(name: string): boolean {
  return SNAPSHOT_IGNORES.has(name);
}

function resolveGitRepoRoot(workspaceRoot: string): string | null {
  try {
    const repoRoot = execFileSync(
      "git",
      ["-C", workspaceRoot, "rev-parse", "--show-toplevel"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return repoRoot ? path.resolve(repoRoot) : null;
  } catch {
    return null;
  }
}

function loadGitIgnoredPrefixes(args: {
  workspaceRoot: string;
  gitRepoRoot: string | null;
}): string[] {
  try {
    if (!args.gitRepoRoot) return [];

    const output = execFileSync(
      "git",
      ["-C", args.workspaceRoot, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const repoRootAbs = path.resolve(args.gitRepoRoot);
    const workspaceRootAbs = path.resolve(args.workspaceRoot);
    const prefixes = new Set<string>();

    for (const rawLine of output.split(/\r?\n/)) {
      const line = normalizePathForOutput(rawLine.trim()).replace(/\/$/, "");
      if (!line) continue;
      const candidateAbsPaths = [path.resolve(workspaceRootAbs, line), path.resolve(repoRootAbs, line)];
      for (const candidateAbs of candidateAbsPaths) {
        const rel = normalizePathForOutput(path.relative(workspaceRootAbs, candidateAbs)).replace(/\/$/, "");
        if (!rel || rel === "." || rel.startsWith("..")) continue;
        prefixes.add(rel);
      }
    }

    return Array.from(prefixes).sort();
  } catch {
    return [];
  }
}

function isGitIgnoredPath(relativePath: string, prefixes: string[]): boolean {
  if (prefixes.length === 0) return false;
  return prefixes.some((prefix) => relativePath === prefix || relativePath.startsWith(`${prefix}/`));
}

function mergeGitIgnoredPrefixes(base: string[], next: string[]): string[] {
  if (next.length === 0) return base;
  if (base.length === 0) return Array.from(new Set(next)).sort();
  const out = new Set<string>(base);
  for (const prefix of next) {
    if (!prefix) continue;
    out.add(prefix);
  }
  return Array.from(out).sort();
}

function shouldIgnoreRelativePath(args: {
  relativePath: string;
  artifactsDirRel: string;
  repairsDirRel: string;
  gitIgnoredPrefixes: string[];
}): boolean {
  const rel = normalizePathForOutput(args.relativePath);
  if (!rel || rel === ".") return false;

  const ignoredPrefixes = [
    normalizePathForOutput(args.artifactsDirRel).replace(/\/$/, ""),
    normalizePathForOutput(args.repairsDirRel).replace(/\/$/, ""),
  ];

  if (ignoredPrefixes.some((prefix) => prefix && (rel === prefix || rel.startsWith(`${prefix}/`)))) {
    return true;
  }

  return isGitIgnoredPath(rel, args.gitIgnoredPrefixes);
}

function snapshotWorkspace(args: {
  workspaceRoot: string;
  artifactsDirRel: string;
  repairsDirRel: string;
  gitIgnoredPrefixes: string[];
  maxFiles?: number;
}): Map<string, string> {
  const out = new Map<string, string>();
  const queue: string[] = [args.workspaceRoot];
  const maxFiles = Math.max(500, args.maxFiles ?? 7000);

  while (queue.length > 0 && out.size < maxFiles) {
    const dir = queue.shift() as string;
    let entries: string[];

    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry);
      let stats;
      try {
        stats = statSync(fullPath);
      } catch {
        continue;
      }

      const relativePath = normalizePathForOutput(path.relative(args.workspaceRoot, fullPath));
      if (shouldIgnoreRelativePath({
        relativePath,
        artifactsDirRel: args.artifactsDirRel,
        repairsDirRel: args.repairsDirRel,
        gitIgnoredPrefixes: args.gitIgnoredPrefixes,
      })) {
        continue;
      }

      if (stats.isDirectory()) {
        if (!shouldIgnoreDirName(entry)) {
          queue.push(fullPath);
        }
        continue;
      }

      out.set(relativePath, buildFileFingerprint(fullPath));
      if (out.size >= maxFiles) break;
    }
  }

  return out;
}

function diffSnapshots(before: Map<string, string>, after: Map<string, string>): DagDiffFile[] {
  const keys = new Set<string>([...before.keys(), ...after.keys()]);
  const changes: DagDiffFile[] = [];

  for (const filePath of Array.from(keys).sort()) {
    const prev = before.get(filePath);
    const next = after.get(filePath);

    if (prev === undefined && next !== undefined) {
      changes.push({ path: filePath, change: "added" });
      continue;
    }

    if (prev !== undefined && next === undefined) {
      changes.push({ path: filePath, change: "deleted" });
      continue;
    }

    if (prev !== undefined && next !== undefined && prev !== next) {
      changes.push({ path: filePath, change: "modified" });
    }
  }

  return changes;
}

function loadReplayMemoryEntries(args: { workspaceRoot: string; replayPathAbs: string }): MemoryRevisitCandidate[] {
  const out: MemoryRevisitCandidate[] = [];

  if (existsSync(args.replayPathAbs)) {
    try {
      const parsed = JSON.parse(readFileSync(args.replayPathAbs, "utf8")) as {
        entries?: Array<{
          recommendedQueries?: string[];
          seedQueries?: string[];
          topHitPaths?: string[];
          score?: number;
          successCount?: number;
          updatedAt?: string;
        }>;
      };

      for (const entry of parsed.entries ?? []) {
        const recommended = (entry.recommendedQueries ?? []).slice(0, 4);
        const seedQueries = (entry.seedQueries ?? []).slice(0, 3);
        const topHitPaths = (entry.topHitPaths ?? []).slice(0, 3);
        if (recommended.length === 0 && seedQueries.length === 0 && topHitPaths.length === 0) {
          continue;
        }

        const summaryParts: string[] = [];
        if (recommended.length > 0) {
          summaryParts.push(`Recommended retrieval queries: ${recommended.join(" | ")}`);
        }
        if (seedQueries.length > 0) {
          summaryParts.push(`Seed context: ${seedQueries.join(" | ")}`);
        }
        if (topHitPaths.length > 0) {
          summaryParts.push(`Top prior hits: ${topHitPaths.join(", ")}`);
        }
        const summary = trimText(summaryParts.join(". "), 420);
        const tokens = tokenizeForRecall(`${summary} ${recommended.join(" ")} ${seedQueries.join(" ")}`);
        if (tokens.size === 0) continue;

        const score = clampNonNegativeNumber(entry.score, 0);
        const successCount = clampAtLeastInt(entry.successCount, 1, 1);
        const baseScore = Math.min(1, score + Math.min(0.35, successCount * 0.05));
        out.push({
          source: "replay-memory",
          summary,
          reference: toRelativeOrAbsolute(args.workspaceRoot, args.replayPathAbs),
          tokens,
          baseScore,
          timestampMs: parseTimeMs(entry.updatedAt),
          acceptedMitigation: false,
          failureFrequency: 1,
          negativeMitigation: false,
        });
      }
    } catch {
      // Ignore malformed replay snapshot and continue with event log fallback.
    }
  }

  const eventsPath = args.replayPathAbs.endsWith(".json")
    ? `${args.replayPathAbs.slice(0, Math.max(0, args.replayPathAbs.length - 5))}.events.ndjson`
    : `${args.replayPathAbs}.events.ndjson`;
  if (!existsSync(eventsPath)) return out;

  try {
    const raw = readFileSync(eventsPath, "utf8");
    const lines = raw
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .slice(-500);
    for (const line of lines) {
      let parsed: {
        type?: string;
        recommendedQueries?: string[];
        seedQueries?: string[];
        topHitPaths?: string[];
        score?: number;
        timestamp?: string;
      } | null = null;
      try {
        parsed = JSON.parse(line);
      } catch {
        parsed = null;
      }
      if (!parsed || parsed.type !== "replay_outcome") continue;
      const recommended = (parsed.recommendedQueries ?? []).slice(0, 3);
      const seedQueries = (parsed.seedQueries ?? []).slice(0, 3);
      const topHitPaths = (parsed.topHitPaths ?? []).slice(0, 2);
      if (recommended.length === 0 && seedQueries.length === 0 && topHitPaths.length === 0) continue;

      const summary = trimText(
        `Recent replay outcome. Recommended retrieval queries: ${recommended.join(" | ")}. Seed context: ${
          seedQueries.join(" | ")
        }. Top prior hits: ${topHitPaths.join(", ")}`,
        420,
      );
      const tokens = tokenizeForRecall(`${summary} ${recommended.join(" ")} ${seedQueries.join(" ")}`);
      if (tokens.size === 0) continue;

      out.push({
        source: "replay-memory",
        summary,
        reference: toRelativeOrAbsolute(args.workspaceRoot, eventsPath),
        tokens,
        baseScore: Math.min(1, clampNonNegativeNumber(parsed.score, 0) + 0.2),
        timestampMs: parseTimeMs(parsed.timestamp),
        acceptedMitigation: false,
        failureFrequency: 1,
        negativeMitigation: false,
      });
    }
  } catch {
    return out;
  }

  return out;
}

function loadArtifactMemoryCandidates(args: {
  workspaceRoot: string;
  artifactsDirRel: string;
  maxCandidates: number;
}): MemoryRevisitCandidate[] {
  const artifactsDirAbs = path.resolve(args.workspaceRoot, args.artifactsDirRel);
  if (!existsSync(artifactsDirAbs)) return [];

  type ArtifactEntry = { filePath: string; mtimeMs: number };
  const files: ArtifactEntry[] = [];
  const queue = [artifactsDirAbs];

  while (queue.length > 0) {
    const dir = queue.shift() as string;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry);
      let stats;
      try {
        stats = statSync(full);
      } catch {
        continue;
      }

      if (stats.isDirectory()) {
        queue.push(full);
        continue;
      }

      if (!entry.endsWith(".artifact.json")) continue;
      files.push({ filePath: full, mtimeMs: stats.mtimeMs || 0 });
    }
  }

  files.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const out: MemoryRevisitCandidate[] = [];
  for (const item of files.slice(0, Math.max(1, args.maxCandidates))) {
    let parsed: {
      moduleId?: string;
      status?: string;
      riskNotes?: string[];
      criticFindings?: Array<{ severity?: string; message?: string; source?: string }>;
      changedFiles?: Array<{ path?: string; change?: string }>;
      repairTaskPath?: string | null;
    } | null = null;

    try {
      parsed = JSON.parse(readFileSync(item.filePath, "utf8"));
    } catch {
      parsed = null;
    }
    if (!parsed) continue;

    const moduleId = String(parsed.moduleId ?? "unknown-module").trim();
    const status = String(parsed.status ?? "unknown").trim();
    const riskNotes = (parsed.riskNotes ?? []).filter((value): value is string => typeof value === "string").slice(0, 2);
    const criticNotes = (parsed.criticFindings ?? [])
      .slice(0, 2)
      .map((finding) => `${finding.severity ?? "info"}:${finding.source ?? "critic"}:${finding.message ?? ""}`.trim());
    const changedPaths = (parsed.changedFiles ?? [])
      .slice(0, 3)
      .map((change) => `${change.change ?? "mod"}:${change.path ?? "unknown"}`);

    const summary = trimText(
      [
        `Module ${moduleId} finished ${status}.`,
        riskNotes.length > 0 ? `Risk notes: ${riskNotes.join(" | ")}` : "",
        criticNotes.length > 0 ? `Critic: ${criticNotes.join(" | ")}` : "",
        changedPaths.length > 0 ? `Changed files: ${changedPaths.join(", ")}` : "",
        parsed.repairTaskPath ? `Repair path: ${parsed.repairTaskPath}` : "",
      ]
        .filter((line) => line.length > 0)
        .join(" "),
      420,
    );

    const tokens = tokenizeForRecall(`${summary} ${moduleId} ${status} ${riskNotes.join(" ")} ${criticNotes.join(" ")}`);
    if (tokens.size === 0) continue;

    const baseScore = status === "success" && parsed.repairTaskPath ? 0.8 : status === "failed" ? 0.65 : 0.55;
    out.push({
      source: "artifact-contract",
      summary,
      reference: toRelativeOrAbsolute(args.workspaceRoot, item.filePath),
      tokens,
      baseScore,
      timestampMs: item.mtimeMs || 0,
      acceptedMitigation: false,
      failureFrequency: 1,
      negativeMitigation: false,
    });
  }

  return out;
}

function loadSemanticMemoryCandidates(args: {
  workspaceRoot: string;
  recipeId: string;
  policyPacks: string[];
  autonomyDir: string;
  memoryPath?: string;
}): MemoryRevisitCandidate[] {
  const semantic = readSemanticState({
    workspaceRoot: args.workspaceRoot,
    recipeId: args.recipeId,
    policyPacks: args.policyPacks,
    autonomyDir: args.autonomyDir,
    memoryPath: args.memoryPath,
  });
  if (!semantic.state) return [];

  const reference = toRelativeOrAbsolute(args.workspaceRoot, semantic.memoryPath);
  const out: MemoryRevisitCandidate[] = [];
  const failureFrequency = new Map<string, number>();
  for (const failure of semantic.state.failedAttempts) {
    const key = `${failure.moduleId.toLowerCase()}|${failure.reason.toLowerCase()}`;
    failureFrequency.set(key, (failureFrequency.get(key) ?? 0) + 1);
  }

  for (const failure of semantic.state.failedAttempts.slice(-80)) {
    const summary = trimText(
      `Failed module ${failure.moduleId} attempt ${failure.attempt}: ${failure.reason}`,
      420,
    );
    const tokens = tokenizeForRecall(`${summary} ${failure.moduleId}`);
    if (tokens.size === 0) continue;
    const failureKey = `${failure.moduleId.toLowerCase()}|${failure.reason.toLowerCase()}`;
    out.push({
      source: "semantic-memory",
      summary,
      reference,
      tokens,
      baseScore: 0.72,
      timestampMs: parseTimeMs(failure.timestamp),
      acceptedMitigation: false,
      failureFrequency: failureFrequency.get(failureKey) ?? 1,
      negativeMitigation: false,
    });
  }

  for (const mitigation of semantic.state.mitigations.slice(-80)) {
    const accepted = mitigation.accepted ? "accepted" : "rejected";
    const summary = trimText(
      `Mitigation ${accepted} for module ${mitigation.moduleId}: ${mitigation.mitigation}`,
      420,
    );
    const tokens = tokenizeForRecall(`${summary} ${mitigation.moduleId} ${accepted}`);
    if (tokens.size === 0) continue;
    out.push({
      source: "semantic-memory",
      summary,
      reference,
      tokens,
      baseScore: mitigation.accepted ? 0.85 : 0.45,
      timestampMs: parseTimeMs(mitigation.timestamp),
      acceptedMitigation: mitigation.accepted,
      failureFrequency: 1,
      negativeMitigation: !mitigation.accepted,
    });
  }

  for (const decision of semantic.state.decisions.slice(-80)) {
    const summary = trimText(`Decision ${decision.decision}: ${decision.detail}`, 420);
    const tokens = tokenizeForRecall(`${summary} ${decision.decision}`);
    if (tokens.size === 0) continue;
    out.push({
      source: "semantic-memory",
      summary,
      reference,
      tokens,
      baseScore: 0.55,
      timestampMs: parseTimeMs(decision.timestamp),
      acceptedMitigation: false,
      failureFrequency: 1,
      negativeMitigation: false,
    });
  }

  return out;
}

function defaultReplayMemoryPath(args: {
  workspaceRoot: string;
  recipeId: string;
  autonomyDir: string;
}): string {
  const digest = createHash("sha1");
  digest.update(path.resolve(args.workspaceRoot));
  digest.update("|");
  digest.update(args.recipeId);
  const fingerprint = digest.digest("hex").slice(0, 20);
  return path.resolve(args.workspaceRoot, args.autonomyDir, "rag", "replay", `${fingerprint}.json`);
}

function collectMemoryRevisitHits(args: {
  config: MemoryRevisitConfig;
  state: MemoryRevisitState;
  workspaceRoot: string;
  artifactsDirRel: string;
  module: DagManifest["modules"][number];
  attempt: number;
  stderr: string;
  criticFindings: DagCriticFinding[];
  changedFiles: DagDiffFile[];
  policyPacks: string[];
}): DagMemoryRevisitHit[] {
  if (!args.config.enabled) {
    incrementSkipCounter(args.state, "disabled");
    return [];
  }

  const usedCalls = args.state.callsByModule.get(args.module.id) ?? 0;
  if (usedCalls >= args.config.maxCallsPerModule) {
    incrementSkipCounter(args.state, "max_calls_per_module");
    return [];
  }

  args.state.callsByModule.set(args.module.id, usedCalls + 1);
  args.state.totalCalls += 1;

  const queryText = trimText(
    [
      args.module.id,
      args.module.title,
      args.module.description,
      `attempt ${args.attempt}`,
      args.stderr,
      args.criticFindings.map((finding) => `${finding.severity}:${finding.message}`).join(" "),
      args.changedFiles.map((file) => `${file.change}:${file.path}`).join(" "),
      args.policyPacks.join(" "),
    ].join("\n"),
    2200,
  );
  const queryTokens = tokenizeForRecall(queryText);
  if (queryTokens.size === 0) {
    incrementSkipCounter(args.state, "empty_query");
    return [];
  }

  const candidates: MemoryRevisitCandidate[] = [];
  if (args.config.recipeId) {
    candidates.push(
      ...loadSemanticMemoryCandidates({
        workspaceRoot: args.workspaceRoot,
        recipeId: args.config.recipeId,
        policyPacks: args.policyPacks,
        autonomyDir: args.config.autonomyDir,
        memoryPath: args.config.semanticMemoryPath,
      }),
    );
    candidates.push(
      ...loadReplayMemoryEntries({
        workspaceRoot: args.workspaceRoot,
        replayPathAbs: args.config.replayMemoryPath
          ? path.resolve(args.workspaceRoot, args.config.replayMemoryPath)
          : defaultReplayMemoryPath({
            workspaceRoot: args.workspaceRoot,
            recipeId: args.config.recipeId,
            autonomyDir: args.config.autonomyDir,
          }),
      }),
    );
  } else if (args.config.replayMemoryPath) {
    candidates.push(
      ...loadReplayMemoryEntries({
        workspaceRoot: args.workspaceRoot,
        replayPathAbs: path.resolve(args.workspaceRoot, args.config.replayMemoryPath),
      }),
    );
  }

  candidates.push(
    ...loadArtifactMemoryCandidates({
      workspaceRoot: args.workspaceRoot,
      artifactsDirRel: args.artifactsDirRel,
      maxCandidates: args.config.maxArtifactCandidates,
    }),
  );

  for (const candidate of candidates) {
    incrementSourceCounter(args.state.candidatesLoadedBySource, candidate.source);
  }
  if (candidates.length === 0) {
    incrementSkipCounter(args.state, "no_candidates");
    return [];
  }

  const nowMs = Date.now();
  let belowThresholdCount = 0;
  let negativeBlockedCount = 0;

  const ranked = candidates
    .map((candidate) => {
      const overlap = overlapScore(queryTokens, candidate.tokens);
      const recency = recencyScore(candidate.timestampMs, nowMs);
      const acceptedBoost = candidate.acceptedMitigation ? 0.12 : 0;
      const failurePenalty = Math.min(0.22, Math.max(0, candidate.failureFrequency - 1) * 0.035);
      const negativePenalty = candidate.negativeMitigation ? 0.24 : 0;
      const rawScore =
        (overlap * 0.6) +
        (Math.min(1, candidate.baseScore) * 0.2) +
        (recency * 0.2) +
        acceptedBoost -
        failurePenalty -
        negativePenalty;
      const score = toScore(Math.max(0, Math.min(1, rawScore)));
      return {
        source: candidate.source,
        overlap,
        score,
        summary: candidate.summary,
        reference: candidate.reference,
        negativeMitigation: candidate.negativeMitigation,
      };
    })
    .filter((candidate) => {
      if (candidate.negativeMitigation && candidate.overlap >= 0.45) {
        negativeBlockedCount += 1;
        return false;
      }
      if (candidate.score < args.config.minScore) {
        belowThresholdCount += 1;
        return false;
      }
      return true;
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.source !== b.source) return a.source.localeCompare(b.source);
      return a.summary.localeCompare(b.summary);
    });
  if (negativeBlockedCount > 0) {
    incrementSkipCounter(args.state, "negative_memory_blocked", negativeBlockedCount);
  }
  if (belowThresholdCount > 0) {
    incrementSkipCounter(args.state, "below_threshold", belowThresholdCount);
  }

  const unique = new Set<string>();
  const hits: DagMemoryRevisitHit[] = [];
  for (const item of ranked) {
    const key = `${item.source}|${item.summary}|${item.reference ?? ""}`;
    if (unique.has(key)) continue;
    unique.add(key);
    hits.push(item);
    if (hits.length >= args.config.topK) break;
  }

  if (hits.length > 0) {
    args.state.hitsUsed += hits.length;
    for (const hit of hits) {
      incrementSourceCounter(args.state.selectedBySource, hit.source);
    }
  }
  return hits;
}

function mergeMemoryRevisitHits(base: DagMemoryRevisitHit[], next: DagMemoryRevisitHit[]): DagMemoryRevisitHit[] {
  if (next.length === 0) return base;
  const out = base.slice();
  const seen = new Set(out.map((item) => `${item.source}|${item.summary}|${item.reference ?? ""}`));
  for (const item of next) {
    const key = `${item.source}|${item.summary}|${item.reference ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

async function runModuleCommand(command: string, cwd: string, timeoutMs: number): Promise<DagRunResult> {
  const check = await runCommandCheck(command, cwd, timeoutMs);
  return DagRunResultSchema.parse({
    moduleId: "",
    status: check.passed ? "success" : "failed",
    command,
    code: check.code,
    stdout: check.stdout,
    stderr: check.stderr,
    durationMs: check.durationMs,
  });
}

function resolveModuleCommand(args: {
  moduleCommand?: string;
  executorTemplate?: string;
  executorProfile: ExecutorProfile;
  executorProvider?: ExecutorProvider;
  providerTemplate?: string;
  applyMode: ApplyMode;
  moduleId: string;
  title: string;
  partFile: string;
  requestPath: string;
}): string | null {
  if (args.moduleCommand) return args.moduleCommand;

  if (args.executorTemplate) {
    return applyExecutorTemplate(args.executorTemplate, {
      id: args.moduleId,
      title: args.title,
      partFile: args.partFile,
      requestPath: args.requestPath,
    });
  }

  const profileCommand = buildProfileCommand({
    profile: args.executorProfile,
    applyMode: args.applyMode,
    moduleId: args.moduleId,
    title: args.title,
    partFile: args.partFile,
    requestPath: args.requestPath,
  });
  if (profileCommand) return profileCommand;

  if (!args.executorProvider) return null;

  return buildProviderCommand({
    provider: args.executorProvider,
    applyMode: args.applyMode,
    moduleId: args.moduleId,
    title: args.title,
    partFile: args.partFile,
    requestPath: args.requestPath,
    providerTemplate: args.providerTemplate,
  });
}

function resolveRepairCommand(args: {
  moduleCommand?: string;
  executorTemplate?: string;
  executorProfile: ExecutorProfile;
  executorProvider?: ExecutorProvider;
  providerTemplate?: string;
  applyMode: ApplyMode;
  moduleId: string;
  title: string;
  repairPartFile: string;
  requestPath: string;
}): string | null {
  const canUseTemplatedExecutor = Boolean(
    args.executorTemplate || args.executorProfile !== "none" || args.executorProvider,
  );

  if (canUseTemplatedExecutor) {
    return resolveModuleCommand({
      moduleCommand: undefined,
      executorTemplate: args.executorTemplate,
      executorProfile: args.executorProfile,
      executorProvider: args.executorProvider,
      providerTemplate: args.providerTemplate,
      applyMode: args.applyMode,
      moduleId: args.moduleId,
      title: args.title,
      partFile: args.repairPartFile,
      requestPath: args.requestPath,
    });
  }

  return args.moduleCommand ?? null;
}

function resolveApprovalPath(args: {
  workspaceRoot: string;
  approvalDir?: string;
  level: number;
}): string {
  const approvalDir = args.approvalDir ?? "generated/orchestration/approvals";
  const approvalDirAbs = path.resolve(args.workspaceRoot, approvalDir);
  return path.join(approvalDirAbs, `wave-${args.level + 1}.approved.json`);
}

function isGateLikeModule(module: DagManifest["modules"][number]): boolean {
  const haystack = `${module.id} ${module.title}`.toLowerCase();
  return /\bgate\b/.test(haystack) ||
    /\bsignoff\b/.test(haystack) ||
    /\bchecklist\b/.test(haystack) ||
    /\bverification\b/.test(haystack) ||
    /\bvalidate\b/.test(haystack) ||
    haystack.includes("delivery");
}

function isTestImpactEligibleModule(module: DagManifest["modules"][number]): boolean {
  return module.mode === "implement";
}

function selectFullSuiteCheckpointModuleIds(modules: DagManifest["modules"]): Set<string> {
  const implementModules = modules.filter((module) => module.mode === "implement");
  if (implementModules.length === 0) return new Set<string>();

  const dependents = new Map<string, number>();
  for (const module of modules) {
    for (const dep of module.dependsOn) {
      dependents.set(dep, (dependents.get(dep) ?? 0) + 1);
    }
  }

  const gateLike = implementModules
    .filter((module) => isGateLikeModule(module))
    .map((module) => module.id);
  if (gateLike.length > 0) return new Set(gateLike);

  const sinks = implementModules
    .filter((module) => (dependents.get(module.id) ?? 0) === 0)
    .map((module) => module.id);
  if (sinks.length > 0) return new Set(sinks);

  const fallback = implementModules[implementModules.length - 1]?.id;
  return fallback ? new Set([fallback]) : new Set<string>();
}

function impactedPackages(args: {
  facts: WorkspaceFacts;
  changedFiles: DagDiffFile[];
}): Array<{ name: string; path: string; scripts: string[] }> {
  const changed = args.changedFiles.map((item) => normalizePathForOutput(item.path));
  if (changed.length === 0) return [];

  const nonRoot = args.facts.packages.filter((pkg) => pkg.path !== ".");
  const hitNonRoot = new Set<string>();

  for (const pkg of nonRoot) {
    const prefix = `${normalizePathForOutput(pkg.path)}/`;
    if (changed.some((filePath) => filePath === normalizePathForOutput(pkg.path) || filePath.startsWith(prefix))) {
      hitNonRoot.add(pkg.path);
    }
  }

  const selected = args.facts.packages
    .filter((pkg) => {
      if (hitNonRoot.size > 0) {
        return pkg.path !== "." && hitNonRoot.has(pkg.path);
      }

      if (pkg.path === ".") {
        return true;
      }

      const prefix = `${normalizePathForOutput(pkg.path)}/`;
      return changed.some((filePath) => filePath === normalizePathForOutput(pkg.path) || filePath.startsWith(prefix));
    })
    .filter((pkg) => pkg.scripts.includes("test:run"))
    .map((pkg) => ({ name: pkg.name, path: pkg.path, scripts: pkg.scripts }));

  return selected;
}

function testCommandForPackage(pkgPath: string): string {
  if (pkgPath === ".") return "npm run test:run";
  const safe = pkgPath.replace(/'/g, `'"'"'`);
  return `npm --prefix '${safe}' run test:run`;
}

async function runTestImpact(args: {
  mode: "off" | "targeted" | "targeted_then_full";
  applyMode: ApplyMode;
  runFullSuiteInDryRun: boolean;
  allowFullSuite: boolean;
  workspaceRoot: string;
  changedFiles: DagDiffFile[];
  facts: WorkspaceFacts;
  timeoutMs: number;
  fullTestCommand: string;
}): Promise<TestImpactResult> {
  if (args.mode === "off") {
    return {
      passed: true,
      traces: [],
      commands: [],
      detail: "test impact disabled",
      fullSuiteRan: false,
    };
  }

  const traces: DagCommandTrace[] = [];
  const commands: string[] = [];
  const packages = impactedPackages({ facts: args.facts, changedFiles: args.changedFiles });

  for (const pkg of packages) {
    const command = testCommandForPackage(pkg.path);
    commands.push(command);
    const result = await runCommandCheck(command, args.workspaceRoot, args.timeoutMs);
    const trace = toCommandTrace(command, result);
    traces.push(trace);

    if (!trace.passed) {
      return {
        passed: false,
        traces,
        commands,
        detail: `targeted test failed for ${pkg.name}: ${trace.stderr || trace.stdout || "unknown error"}`,
        fullSuiteRan: false,
      };
    }
  }

  const shouldRunFullSuite = args.mode === "targeted_then_full" &&
    args.allowFullSuite &&
    (args.applyMode === "apply" || args.runFullSuiteInDryRun);

  if (shouldRunFullSuite) {
    commands.push(args.fullTestCommand);
    const full = await runCommandCheck(args.fullTestCommand, args.workspaceRoot, args.timeoutMs);
    const fullTrace = toCommandTrace(args.fullTestCommand, full);
    traces.push(fullTrace);

    if (!fullTrace.passed) {
      return {
        passed: false,
        traces,
        commands,
        detail: `full test suite failed: ${fullTrace.stderr || fullTrace.stdout || "unknown error"}`,
        fullSuiteRan: true,
      };
    }
  }

  if (commands.length === 0) {
    return {
      passed: true,
      traces,
      commands,
      detail: "no impacted packages with test:run script",
      fullSuiteRan: false,
    };
  }

  if (args.mode === "targeted_then_full" && args.allowFullSuite && !shouldRunFullSuite) {
    return {
      passed: true,
      traces,
      commands,
      detail: "full-suite test gate skipped in dry-run mode",
      fullSuiteRan: false,
    };
  }

  return {
    passed: true,
    traces,
    commands,
    detail: "ok",
    fullSuiteRan: shouldRunFullSuite,
  };
}

function severityRank(severity: DagCriticSeverity): number {
  if (severity === "blocker") return 2;
  if (severity === "warning") return 1;
  return 0;
}

function highestSeverity(findings: DagCriticFinding[]): DagCriticSeverity {
  let best: DagCriticSeverity = "info";
  for (const finding of findings) {
    if (severityRank(finding.severity) > severityRank(best)) {
      best = finding.severity;
    }
  }
  return best;
}

function shouldFailForSeverity(args: {
  severity: DagCriticSeverity;
  failLevel: DagCriticSeverity;
}): boolean {
  return severityRank(args.severity) >= severityRank(args.failLevel);
}

function runBasicCritic(args: {
  moduleMode: "analyze" | "implement";
  applyMode: ApplyMode;
  moduleId: string;
  moduleTitle: string;
  changedFiles: DagDiffFile[];
}): DagCriticFinding[] {
  const findings: DagCriticFinding[] = [];

  if (args.moduleMode === "implement" && args.changedFiles.length === 0) {
    const hint = `${args.moduleId} ${args.moduleTitle}`.toLowerCase();
    const isGateLike = /\bgate\b/.test(hint) || hint.includes("verify") || hint.includes("validation");
    findings.push({
      severity: isGateLike ? "info" : args.applyMode === "apply" ? "warning" : "info",
      message: isGateLike
        ? "No file changes detected for gate/verification module (allowed)."
        : args.applyMode === "apply"
        ? "No file changes detected for implement module; verify this is an intended no-op."
        : "No file changes detected in dry-run mode (expected for planning-only providers).",
      source: "basic-critic",
    });
  }

  if (args.changedFiles.some((change) => change.path.endsWith("package-lock.json")) && args.changedFiles.length === 1) {
    findings.push({
      severity: "warning",
      message: "Only lockfile changed; verify functional migration scope.",
      source: "basic-critic",
    });
  }

  return findings;
}

interface ResolvedCriticParser extends PolicyCriticParser {
  packId: string;
}

function captureGroup(match: RegExpExecArray, index: number): string {
  if (!Number.isInteger(index) || index <= 0) return "";
  return match[index]?.trim() || "";
}

function captureGroupRange(match: RegExpExecArray, startIndex: number): string {
  if (!Number.isInteger(startIndex) || startIndex <= 0 || startIndex >= match.length) return "";
  const values: string[] = [];
  for (let index = startIndex; index < match.length; index += 1) {
    const value = match[index]?.trim() || "";
    if (!value) continue;
    values.push(value);
  }
  return values.join(" ");
}

function renderCriticParserMessageTemplate(template: string, match: RegExpExecArray): string {
  return template
    .replaceAll("{match}", match[0]?.trim() || "match")
    .replace(/\{group(\d+)\+\}/g, (_token, group) => captureGroupRange(match, Number(group)))
    .replace(/\{group(\d+)\}/g, (_token, group) => captureGroup(match, Number(group)));
}

function parseCriticFindingsFromText(args: {
  text: string;
  source: string;
  customParsers?: ResolvedCriticParser[];
}): DagCriticFinding[] {
  const findings: DagCriticFinding[] = [];
  if (!args.text.trim()) return findings;

  const markerPattern = /\[CRITIC:(INFO|WARNING|BLOCKER)\]\s*(.+)/gi;
  let marker: RegExpExecArray | null;
  while ((marker = markerPattern.exec(args.text)) !== null) {
    findings.push({
      severity: DagCriticSeveritySchema.parse(marker[1].toLowerCase()),
      message: marker[2].trim() || "critic marker emitted without message",
      source: args.source,
    });
  }

  const jsonPattern = /"severity"\s*:\s*"(info|warning|blocker)"[\s\S]{0,220}?"message"\s*:\s*"([^"]+)"/gi;
  let jsonMatch: RegExpExecArray | null;
  while ((jsonMatch = jsonPattern.exec(args.text)) !== null) {
    findings.push({
      severity: DagCriticSeveritySchema.parse(jsonMatch[1].toLowerCase()),
      message: jsonMatch[2].trim(),
      source: args.source,
    });
  }

  for (const parser of args.customParsers ?? []) {
    const parserFlags = parser.flags?.trim() || "gi";
    let regex: RegExp;
    try {
      const ensuredGlobal = parserFlags.includes("g") ? parserFlags : `${parserFlags}g`;
      regex = new RegExp(parser.regex, ensuredGlobal);
    } catch {
      continue;
    }

    let match: RegExpExecArray | null;
    while ((match = regex.exec(args.text)) !== null) {
      const renderedMessage = renderCriticParserMessageTemplate(
        parser.messageTemplate ?? "Matched policy critic parser: {match}",
        match,
      );

      findings.push({
        severity: DagCriticSeveritySchema.parse(parser.severity),
        message: renderedMessage.trim(),
        source: `policy:${parser.packId}:parser`,
      });

      // Guard against zero-width regex patterns.
      if (match[0] === "") {
        regex.lastIndex += 1;
      }
    }
  }

  return findings;
}

function runPolicyCriticChecks(args: {
  policyPacks: string[];
  changedFiles: DagDiffFile[];
}): DagCriticFinding[] {
  if (args.policyPacks.length === 0 || args.changedFiles.length === 0) return [];

  const findings: DagCriticFinding[] = [];
  const changedPaths = args.changedFiles.map((file) => normalizePathForOutput(file.path).toLowerCase());

  if (args.policyPacks.includes("security")) {
    if (changedPaths.some((filePath) => filePath.includes("auth") || filePath.includes("security") || filePath.includes("secret"))) {
      findings.push({
        severity: "warning",
        message: "Security-related paths changed; require security review sign-off.",
        source: "policy:security",
      });
    }
  }

  if (args.policyPacks.includes("legal")) {
    if (changedPaths.some((filePath) => filePath.includes("license") || filePath.includes("copying"))) {
      findings.push({
        severity: "warning",
        message: "License-related files changed; require legal review sign-off.",
        source: "policy:legal",
      });
    }
  }

  if (args.policyPacks.includes("release")) {
    if (changedPaths.some((filePath) => filePath.endsWith("package.json") || filePath.endsWith("changeset.md"))) {
      findings.push({
        severity: "info",
        message: "Release-facing metadata changed; verify rollout notes and versioning.",
        source: "policy:release",
      });
    }
  }

  if (args.policyPacks.includes("infra")) {
    if (changedPaths.some((filePath) =>
      filePath.startsWith(".github/workflows/") ||
      filePath.includes("dockerfile") ||
      filePath.includes("terraform") ||
      filePath.includes("/k8s/") ||
      filePath.includes("/helm/"),
    )) {
      findings.push({
        severity: "warning",
        message: "Infra-sensitive files changed; require infrastructure review sign-off.",
        source: "policy:infra",
      });
    }
  }

  return findings;
}

function dedupeFindings(findings: DagCriticFinding[]): DagCriticFinding[] {
  const seen = new Set<string>();
  const out: DagCriticFinding[] = [];
  for (const finding of findings) {
    const key = `${finding.source}|${finding.severity}|${finding.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(finding);
  }
  return out;
}

function limitChangedFiles(changedFiles: DagDiffFile[], limit: number): {
  items: DagDiffFile[];
  omitted: number;
} {
  const safeLimit = Math.max(1, Math.trunc(limit));
  if (changedFiles.length <= safeLimit) {
    return { items: changedFiles, omitted: 0 };
  }
  return {
    items: changedFiles.slice(0, safeLimit),
    omitted: changedFiles.length - safeLimit,
  };
}

function serializeChangedFilesForContext(changedFiles: DagDiffFile[]): string {
  const limited = limitChangedFiles(changedFiles, CHANGED_FILES_CONTEXT_LIMIT);
  const compact = limited.items.map((change) => `${change.change}:${change.path}`);
  if (limited.omitted > 0) {
    compact.push(`truncated:${limited.omitted}`);
  }
  return JSON.stringify(compact);
}

function changedFilesForArtifact(changedFiles: DagDiffFile[]): DagDiffFile[] {
  const limited = limitChangedFiles(changedFiles, CHANGED_FILES_ARTIFACT_LIMIT);
  if (limited.omitted === 0) return limited.items;
  return [
    ...limited.items,
    {
      path: `__omitted__:${limited.omitted} additional file changes`,
      change: "modified",
    },
  ];
}

function renderPolicyCriticPrompts(args: {
  rules: ResolvedPolicyCriticRule[];
  module: DagManifest["modules"][number];
  applyMode: ApplyMode;
  requestPath: string;
  partFileAbs: string;
  changedFiles: DagDiffFile[];
}): string {
  if (args.rules.length === 0) return "";

  const changedFiles = serializeChangedFilesForContext(args.changedFiles);
  const sections: string[] = [];

  for (const rule of args.rules) {
    if (!rule.template.trim()) continue;
    sections.push(
      [`[policy-pack:${rule.packId}]`, renderTemplate(rule.template, {
        packId: rule.packId,
        moduleId: args.module.id,
        title: args.module.title,
        partFile: args.partFileAbs,
        requestPath: args.requestPath,
        applyMode: args.applyMode,
        changedFiles,
      })].join("\n"),
    );
  }

  return sections.join("\n\n");
}

function flattenPolicyParsers(rules: ResolvedPolicyCriticRule[]): ResolvedCriticParser[] {
  const out: ResolvedCriticParser[] = [];
  for (const rule of rules) {
    for (const parser of rule.parsers) {
      out.push({
        ...parser,
        packId: rule.packId,
      });
    }
  }
  return out;
}

async function runCritic(args: {
  enabled: boolean;
  workspaceRoot: string;
  timeoutMs: number;
  module: DagManifest["modules"][number];
  applyMode: ApplyMode;
  requestPath: string;
  partFileAbs: string;
  changedFiles: DagDiffFile[];
  criticCommandTemplate?: string;
  artifactPathRel: string;
  repairTaskPath: string | null;
  policyPacks: string[];
  policyCriticRules: ResolvedPolicyCriticRule[];
  failLevel: DagCriticSeverity;
}): Promise<{
  passed: boolean;
  trace: DagCommandTrace | null;
  detail: string;
  riskNotes: string[];
  severity: DagCriticSeverity;
  findings: DagCriticFinding[];
}> {
  if (!args.enabled) {
    return {
      passed: true,
      trace: null,
      detail: "critic disabled",
      riskNotes: [],
      severity: "info",
      findings: [],
    };
  }

  const baseFindings = dedupeFindings([
    ...runBasicCritic({
      moduleMode: args.module.mode,
      applyMode: args.applyMode,
      moduleId: args.module.id,
      moduleTitle: args.module.title,
      changedFiles: args.changedFiles,
    }),
    ...runPolicyCriticChecks({
      policyPacks: args.policyPacks,
      changedFiles: args.changedFiles,
    }),
  ]);

  if (!args.criticCommandTemplate) {
    const severity = highestSeverity(baseFindings);
    const passed = !shouldFailForSeverity({ severity, failLevel: args.failLevel });
    const detail = passed
      ? "critic passed"
      : `critic failed at severity ${severity} (threshold ${args.failLevel})`;

    return {
      passed,
      trace: {
        command: "internal-basic-critic",
        passed,
        code: passed ? 0 : 1,
        durationMs: 0,
        stdout: detail,
        stderr: passed ? "" : detail,
      },
      detail,
      riskNotes: baseFindings
        .filter((finding) => finding.severity !== "info")
        .map((finding) => `${finding.source}: ${finding.message}`),
      severity,
      findings: baseFindings,
    };
  }

  const changedFilesJson = serializeChangedFilesForContext(args.changedFiles);
  const policyCriticPrompts = renderPolicyCriticPrompts({
    rules: args.policyCriticRules,
    module: args.module,
    applyMode: args.applyMode,
    requestPath: args.requestPath,
    partFileAbs: args.partFileAbs,
    changedFiles: args.changedFiles,
  });
  const policyCriticParsers = flattenPolicyParsers(args.policyCriticRules);

  const command = renderTemplate(args.criticCommandTemplate, {
    moduleId: args.module.id,
    title: args.module.title,
    partFile: args.partFileAbs,
    requestPath: args.requestPath,
    applyMode: args.applyMode,
    artifactPath: args.artifactPathRel,
    changedFiles: changedFilesJson,
    repairTaskPath: args.repairTaskPath ?? "",
    policyPacks: args.policyPacks.join(","),
    policyCriticPrompts,
  });

  const result = await runCommandCheck(command, args.workspaceRoot, args.timeoutMs);
  const trace = toCommandTrace(command, result);
  const commandFindings = parseCriticFindingsFromText({
    text: `${result.stdout}\n${result.stderr}`,
    source: "external-critic",
    customParsers: policyCriticParsers,
  });
  if (!result.passed) {
    commandFindings.push({
      severity: "blocker",
      message: result.stderr || result.stdout || "external critic command failed",
      source: "external-critic",
    });
  }

  const findings = dedupeFindings([...baseFindings, ...commandFindings]);
  const severity = highestSeverity(findings);
  const passesSeverityThreshold = !shouldFailForSeverity({
    severity,
    failLevel: args.failLevel,
  });
  const passed = result.passed && passesSeverityThreshold;
  const detail = passed
    ? "critic passed"
    : `critic failed at severity ${severity} (threshold ${args.failLevel})`;

  return {
    passed,
    trace,
    detail,
    riskNotes: findings
      .filter((finding) => finding.severity !== "info")
      .map((finding) => `${finding.source}: ${finding.message}`),
    severity,
    findings,
  };
}

function writeModuleArtifact(args: {
  workspaceRoot: string;
  artifactsDirRel: string;
  moduleId: string;
  inputDigest: string | null;
  attempt: number;
  status: DagRunResult["status"];
  changedFiles: DagDiffFile[];
  command: DagCommandTrace | null;
  critic: DagCommandTrace | null;
  criticFindings: DagCriticFinding[];
  testImpact: DagCommandTrace[];
  riskNotes: string[];
  policyPacks: string[];
  repairTaskPath: string | null;
  memoryRevisit: DagMemoryRevisitHit[];
}): string {
  const artifactPathRel = normalizePathForOutput(path.join(args.artifactsDirRel, `${args.moduleId}.attempt-${args.attempt}.artifact.json`));
  const artifactAbs = path.resolve(args.workspaceRoot, artifactPathRel);
  const artifactChangedFiles = changedFilesForArtifact(args.changedFiles);
  const riskNotes = args.riskNotes.slice();
  const omittedMarker = artifactChangedFiles.find((file) => file.path.startsWith("__omitted__:"));
  if (omittedMarker) {
    const omitted = omittedMarker.path.replace("__omitted__:", "");
    riskNotes.push(`changedFiles truncated for artifact contract (${omitted})`);
  }

  const artifact = DagModuleArtifactSchema.parse({
    moduleId: args.moduleId,
    generatedAt: new Date().toISOString(),
    attempt: args.attempt,
    status: args.status,
    inputDigest: args.inputDigest,
    changedFiles: artifactChangedFiles,
    command: args.command,
    critic: args.critic,
    criticFindings: args.criticFindings,
    testImpact: args.testImpact,
    riskNotes,
    policyPacks: args.policyPacks,
    repairTaskPath: args.repairTaskPath,
    memoryRevisit: args.memoryRevisit,
  });

  mkdirSync(path.dirname(artifactAbs), { recursive: true });
  writeFileSync(artifactAbs, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

  return artifactPathRel;
}

function createRepairTask(args: {
  workspaceRoot: string;
  repairsDirRel: string;
  module: DagManifest["modules"][number];
  attempt: number;
  command: string | null;
  stderr: string;
  artifactPath: string | null;
  memoryRevisit: DagMemoryRevisitHit[];
}): string {
  const taskPathRel = normalizePathForOutput(path.join(
    args.repairsDirRel,
    args.module.id,
    `repair-attempt-${args.attempt}.md`,
  ));
  const taskAbs = path.resolve(args.workspaceRoot, taskPathRel);

  const lines = [
    `# Repair Task: ${args.module.id}`,
    "",
    `Module title: ${args.module.title}`,
    `Original part: ${args.module.partPath}`,
    `Attempt: ${args.attempt}`,
    "",
    "## Failure Context",
    `- Command: ${args.command ?? "n/a"}`,
    `- Artifact: ${args.artifactPath ?? "n/a"}`,
    `- Error: ${(args.stderr || "unknown error").slice(0, 2000)}`,
    "",
    "## Focused Follow-Up",
    "- Fix only the failing gate/path from this module.",
    "- Avoid unrelated refactors.",
    "- Re-run only impacted tests for changed package(s) before marking done.",
    "- Record risk notes and mitigation in the next artifact.",
    "",
  ];

  if (args.memoryRevisit.length > 0) {
    lines.push("## Recalled Evidence");
    for (const hit of args.memoryRevisit) {
      lines.push(`- [${hit.source}] score=${hit.score.toFixed(3)} ${hit.summary}`);
      if (hit.reference) {
        lines.push(`  ref: ${hit.reference}`);
      }
    }
    lines.push("");
  }

  mkdirSync(path.dirname(taskAbs), { recursive: true });
  writeFileSync(taskAbs, `${lines.join("\n")}\n`, "utf8");

  return taskPathRel;
}

function normalizePositive(value: number | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.trunc(value);
  return rounded > 0 ? rounded : null;
}

function computeBudgetExhaustion(args: {
  config: BudgetConfig;
  state: BudgetState;
  startedAtMs: number;
}): string[] {
  const reasons: string[] = [];
  const elapsedMs = Math.max(0, Date.now() - args.startedAtMs);

  if (args.config.maxRunDurationMs !== null && elapsedMs >= args.config.maxRunDurationMs) {
    reasons.push(`runtime budget exceeded (${elapsedMs}ms >= ${args.config.maxRunDurationMs}ms)`);
  }

  if (args.config.maxTotalAttempts !== null && args.state.totalAttempts >= args.config.maxTotalAttempts) {
    reasons.push(`attempt budget exceeded (${args.state.totalAttempts} >= ${args.config.maxTotalAttempts})`);
  }

  if (args.config.maxTotalTokens !== null && args.state.totalTokensEffective >= args.config.maxTotalTokens) {
    reasons.push(
      `token budget exceeded (${args.state.totalTokensEffective} >= ${args.config.maxTotalTokens})`,
    );
  }

  return reasons;
}

function buildBudgetSnapshot(args: {
  config: BudgetConfig;
  state: BudgetState;
  startedAtMs: number;
}) {
  return {
    maxTotalAttempts: args.config.maxTotalAttempts,
    maxTotalTokens: args.config.maxTotalTokens,
    maxRunDurationMs: args.config.maxRunDurationMs,
    failFast: args.config.failFast,
    totalAttempts: args.state.totalAttempts,
    totalTokensEstimate: args.state.totalTokensEstimate,
    totalTokensObserved: args.state.totalTokensObserved,
    totalTokensEstimated: args.state.totalTokensEstimated,
    totalTokensEffective: args.state.totalTokensEffective,
    observedTraceCount: args.state.observedTraceCount,
    estimatedTraceCount: args.state.estimatedTraceCount,
    tokenAccountingMode: args.state.observedTraceCount > 0 ? "observed_or_estimated" : "estimated_only",
    elapsedMs: Math.max(0, Date.now() - args.startedAtMs),
    exhausted: args.state.exhausted,
    reasons: args.state.reasons,
  };
}

export async function runDag(args: {
  workspaceRoot: string;
  manifestPath: string;
  executorTemplate?: string;
  executorProfile?: ExecutorProfile;
  executorProvider?: ExecutorProvider;
  providerTemplate?: string;
  applyMode?: ApplyMode;
  applyGuardToken?: string;
  applyGuardValue?: string;
  failPolicy?: "graph" | "global";
  timeoutMs?: number;
  outputPath?: string;
  dryRun?: boolean;
  requireWaveApproval?: boolean;
  approvalDir?: string;
  requireEvidenceFile?: boolean;
  evidenceFilePath?: string;
  rollbackCheckCommand?: string;
  enableCritic?: boolean;
  criticCommandTemplate?: string;
  criticFailLevel?: DagCriticSeverity;
  enableRepairLoop?: boolean;
  maxRepairAttempts?: number;
  maxTotalAttempts?: number;
  maxTotalTokens?: number;
  maxRunDurationMs?: number;
  failFast?: boolean;
  artifactsDir?: string;
  repairsDir?: string;
  requireArtifactContract?: boolean;
  testImpactMode?: "off" | "targeted" | "targeted_then_full";
  fullTestCommand?: string;
  fullTestInDryRun?: boolean;
  runAnalyzeInDryRun?: boolean;
  analyzeTimeoutMs?: number;
  resumeSuccessModules?: boolean;
  canaryLimitModules?: number;
  canaryCompareCommand?: string;
  maxParallel?: number;
  policyPacks?: string[];
  policyCriticConfigPath?: string;
  memoryRevisitEnabled?: boolean;
  memoryRevisitRecipeId?: string;
  memoryRevisitAutonomyDir?: string;
  memoryRevisitSemanticMemoryPath?: string;
  memoryRevisitReplayMemoryPath?: string;
  memoryRevisitMaxCallsPerModule?: number;
  memoryRevisitTopK?: number;
  memoryRevisitMinScore?: number;
  memoryRevisitMaxArtifactCandidates?: number;
}): Promise<DagRunSummary> {
  const runStartedAt = new Date().toISOString();
  const runStartedAtMs = Date.now();
  const workspaceRoot = path.resolve(args.workspaceRoot);
  const manifestAbs = path.resolve(workspaceRoot, args.manifestPath);
  const manifest = loadManifest(manifestAbs);
  const gitRepoRoot = resolveGitRepoRoot(workspaceRoot);
  const timeoutMs = Math.max(1000, args.timeoutMs ?? 10 * 60 * 1000);
  const analyzeTimeoutMs = clampAtLeastInt(
    args.analyzeTimeoutMs,
    Math.min(timeoutMs, DEFAULT_ANALYZE_TIMEOUT_MS),
    1000,
  );
  const failPolicy = args.failPolicy ?? "graph";
  const dryRun = Boolean(args.dryRun);
  const executorProfile = args.executorProfile ?? "none";
  const applyMode = args.applyMode ?? "dry-run";
  const artifactsDirRel = normalizePathForOutput(args.artifactsDir ?? "generated/orchestration/dag/artifacts");
  const repairsDirRel = normalizePathForOutput(args.repairsDir ?? "generated/orchestration/dag/repairs");
  const requireArtifactContract = args.requireArtifactContract ?? true;
  const testImpactMode = args.testImpactMode ?? "off";
  const fullTestCommand = args.fullTestCommand ?? "npm run test:run";
  const runAnalyzeInDryRun = args.runAnalyzeInDryRun ?? false;
  const resumeSuccessModules = args.resumeSuccessModules ?? true;
  const enableRepairLoop = args.enableRepairLoop ?? false;
  const maxRepairAttempts = Math.max(0, args.maxRepairAttempts ?? 1);
  const maxParallel = Math.max(1, Math.trunc(args.maxParallel ?? 1));
  const policyPacks = (args.policyPacks ?? []).filter((entry) => entry.trim().length > 0);
  const criticFailLevel = DagCriticSeveritySchema.parse(args.criticFailLevel ?? "blocker");
  const memoryRevisitConfig: MemoryRevisitConfig = {
    enabled: (args.memoryRevisitEnabled ?? true) && enableRepairLoop,
    recipeId: args.memoryRevisitRecipeId?.trim() ? args.memoryRevisitRecipeId.trim() : null,
    autonomyDir: normalizePathForOutput(args.memoryRevisitAutonomyDir ?? "generated/orchestration/autonomy"),
    semanticMemoryPath: args.memoryRevisitSemanticMemoryPath,
    replayMemoryPath: args.memoryRevisitReplayMemoryPath,
    maxCallsPerModule: clampAtLeastInt(args.memoryRevisitMaxCallsPerModule, 1, 0),
    topK: clampAtLeastInt(args.memoryRevisitTopK, 3, 1),
    minScore: clampNonNegativeNumber(args.memoryRevisitMinScore, 0),
    maxArtifactCandidates: clampAtLeastInt(args.memoryRevisitMaxArtifactCandidates, 120, 1),
  };
  const memoryRevisitState: MemoryRevisitState = {
    totalCalls: 0,
    hitsUsed: 0,
    callsByModule: new Map<string, number>(),
    candidatesLoadedBySource: emptySourceCounters(),
    selectedBySource: emptySourceCounters(),
    skippedByReason: emptySkipCounters(),
  };
  const policyCriticConfig = loadPolicyCriticConfig({
    workspaceRoot,
    configPath: args.policyCriticConfigPath,
  });
  const policyCriticRules = resolvePolicyCriticRules({
    policyPackIds: policyPacks,
    config: policyCriticConfig.config,
  });

  const budgetConfig: BudgetConfig = {
    maxTotalAttempts: normalizePositive(args.maxTotalAttempts),
    maxTotalTokens: normalizePositive(args.maxTotalTokens),
    maxRunDurationMs: normalizePositive(args.maxRunDurationMs),
    failFast: args.failFast ?? false,
  };
  const budgetState: BudgetState = {
    totalAttempts: 0,
    totalTokensEstimate: 0,
    totalTokensObserved: 0,
    totalTokensEstimated: 0,
    totalTokensEffective: 0,
    observedTraceCount: 0,
    estimatedTraceCount: 0,
    exhausted: false,
    reasons: [],
  };

  const canaryLimitModules = Math.max(0, Math.trunc(args.canaryLimitModules ?? 0));
  const canaryEnabled = canaryLimitModules > 0;
  let canaryCheckpointPassed: boolean | null = canaryEnabled ? null : null;
  let canaryFailureDetail: string | null = null;
  let canaryCheckpointDone = !canaryEnabled;
  let canaryBlocked = false;
  let successfulModules = 0;

  if (applyMode === "apply") {
    const required = args.applyGuardValue ?? "ALLOW_APPLY";
    if (args.applyGuardToken !== required) {
      throw new Error(
        `Apply mode blocked: invalid apply guard token. Provide --apply-guard-token ${required}`,
      );
    }

    const requireEvidenceFile = args.requireEvidenceFile ?? true;
    if (requireEvidenceFile) {
      const evidenceFile = path.resolve(workspaceRoot, args.evidenceFilePath ?? "generated/orchestration/evidence/apply-evidence.md");
      if (!existsSync(evidenceFile)) {
        throw new Error(`Apply mode blocked: missing evidence file ${path.relative(workspaceRoot, evidenceFile)}.`);
      }
    }

    if (args.rollbackCheckCommand) {
      const rollbackCheck = await runCommandCheck(args.rollbackCheckCommand, workspaceRoot, timeoutMs);
      if (!rollbackCheck.passed) {
        const details = rollbackCheck.stderr.trim() || rollbackCheck.stdout.trim() || "rollback check failed";
        throw new Error(`Apply mode blocked: rollback check command failed (${details.slice(0, 240)}).`);
      }
    }
  }

  const moduleById = new Map(manifest.modules.map((module) => [module.id, module]));
  const requestAbs = path.resolve(workspaceRoot, manifest.requestPath);
  const requestDigest = sha256File(requestAbs);
  const gitIgnoredPrefixesBase = dryRun
    ? []
    : loadGitIgnoredPrefixes({
      workspaceRoot,
      gitRepoRoot,
    });
  const resumeArtifactsByModule = resumeSuccessModules
    ? loadLatestSuccessfulArtifacts({
      workspaceRoot,
      artifactsDirRel,
    })
    : new Map<string, ResumeArtifactEntry>();
  const fullSuiteCheckpointModuleIds = selectFullSuiteCheckpointModuleIds(manifest.modules);
  let fullSuiteCheckpointSatisfied = false;
  const failedModules = new Set<string>();
  const resultByModule = new Map<string, DagRunResult>();

  const levels = topoLevelOrder(manifest.modules);
  const workspaceFacts = testImpactMode === "off" ? null : discoverWorkspaceFacts(workspaceRoot);

  let repairsGenerated = 0;
  let resumedModules = 0;
  const shouldHalt = (): boolean => {
    if (failPolicy === "global" && failedModules.size > 0) return true;
    if (budgetConfig.failFast && failedModules.size > 0) return true;
    if (budgetState.exhausted) return true;
    if (canaryBlocked) return true;
    return false;
  };

  const addResult = (result: DagRunResult) => {
    resultByModule.set(result.moduleId, result);
    if (result.status !== "success") {
      failedModules.add(result.moduleId);
    } else {
      successfulModules += 1;
    }
  };

  const evaluateCanaryCheckpoint = async () => {
    if (canaryCheckpointDone || successfulModules < canaryLimitModules) return;
    canaryCheckpointDone = true;

    if (!args.canaryCompareCommand) {
      canaryCheckpointPassed = true;
      return;
    }

    const compare = await runCommandCheck(args.canaryCompareCommand, workspaceRoot, timeoutMs);
    const compareTrace = toCommandTrace(args.canaryCompareCommand, compare);
    const compareTokens = accumulateTokenAccounting([compareTrace]);
    budgetState.totalTokensEstimate += compareTokens.totalTokensEffective;
    budgetState.totalTokensObserved += compareTokens.totalTokensObserved;
    budgetState.totalTokensEstimated += compareTokens.totalTokensEstimated;
    budgetState.totalTokensEffective += compareTokens.totalTokensEffective;
    budgetState.observedTraceCount += compareTokens.observedTraceCount;
    budgetState.estimatedTraceCount += compareTokens.estimatedTraceCount;

    if (!compare.passed) {
      canaryCheckpointPassed = false;
      canaryFailureDetail =
        `canary compare command failed: ${compare.stderr || compare.stdout || "unknown error"}`;
      canaryBlocked = true;
      return;
    }

    canaryCheckpointPassed = true;
  };

  const executeModule = async (module: DagManifest["modules"][number]): Promise<DagRunResult> => {
    const modulePartAbs = path.resolve(workspaceRoot, module.partPath);
    const initialCommand = resolveModuleCommand({
      moduleCommand: module.command,
      executorTemplate: args.executorTemplate,
      executorProfile,
      executorProvider: args.executorProvider,
      providerTemplate: args.providerTemplate,
      applyMode,
      moduleId: module.id,
      title: module.title,
      partFile: modulePartAbs,
      requestPath: manifest.requestPath,
    });

    if (!initialCommand) {
      return DagRunResultSchema.parse({
        moduleId: module.id,
        status: "skipped",
        command: null,
        code: null,
        stdout: "",
        stderr: "no module command, executor template, profile, or provider configured",
        durationMs: 0,
        changedFiles: [],
        artifactPath: null,
        repairTaskPath: null,
        criticPassed: null,
        testImpactCommands: [],
      });
    }

    const moduleInputDigest = computeModuleInputDigest({
      module,
      partFileAbs: modulePartAbs,
      requestDigest,
      applyMode,
      policyPacks,
      resolvedCommand: initialCommand,
    });

    const resumeHit = resumeArtifactsByModule.get(module.id);
    if (
      resumeHit &&
      resumeHit.inputDigest &&
      resumeHit.inputDigest === moduleInputDigest
    ) {
      resumedModules += 1;
      return DagRunResultSchema.parse({
        moduleId: module.id,
        status: "success",
        command: resumeHit.artifact.command?.command ?? initialCommand,
        code: resumeHit.artifact.command?.code ?? 0,
        stdout: `resumed from prior successful artifact (${resumeHit.artifactPathRel})`,
        stderr: "",
        durationMs: 0,
        attempt: resumeHit.attempt,
        tokensEstimate: 0,
        changedFiles: [],
        artifactPath: resumeHit.artifactPathRel,
        criticPassed: true,
        criticSeverity: highestSeverity(resumeHit.artifact.criticFindings ?? []),
        criticFindings: resumeHit.artifact.criticFindings ?? [],
        repairTaskPath: resumeHit.artifact.repairTaskPath ?? null,
        memoryRevisit: resumeHit.artifact.memoryRevisit ?? [],
        testImpactCommands: (resumeHit.artifact.testImpact ?? []).map((trace) => trace.command),
        tokenAccountingMode: "estimated",
        tokensObserved: 0,
        tokensEstimated: 0,
        tokensEffective: 0,
        resumedFromArtifact: true,
      });
    }

    let attempt = 1;
    let repairTaskPath: string | null = null;
    let commandForAttempt: string | null = initialCommand;
    let partFileForAttempt = modulePartAbs;
    let lastResult: DagRunResult | null = null;
    let accumulatedMemoryRevisit: DagMemoryRevisitHit[] = [];
    let attemptTimeoutMs = timeoutMs;

    while (commandForAttempt && attempt <= 1 + maxRepairAttempts) {
      const budgetReasons = computeBudgetExhaustion({
        config: budgetConfig,
        state: budgetState,
        startedAtMs: runStartedAtMs,
      });
      if (budgetReasons.length > 0) {
        budgetState.exhausted = true;
        budgetState.reasons = budgetReasons;

        lastResult = DagRunResultSchema.parse({
          moduleId: module.id,
          status: "blocked",
          command: commandForAttempt,
          code: null,
          stdout: "",
          stderr: `budget exhausted: ${budgetReasons.join("; ")}`,
          durationMs: 0,
          attempt,
          tokensEstimate: 0,
          changedFiles: [],
          artifactPath: null,
          criticPassed: null,
          repairTaskPath,
          testImpactCommands: [],
        });
        break;
      }

      const artifactPathCandidate = normalizePathForOutput(path.join(
        artifactsDirRel,
        `${module.id}.attempt-${attempt}.artifact.json`,
      ));

      const beforeSnapshot = dryRun
        ? new Map<string, string>()
        : snapshotWorkspace({
          workspaceRoot,
          artifactsDirRel,
          repairsDirRel,
          gitIgnoredPrefixes: gitIgnoredPrefixesBase,
        });

      const shouldAutoPassAnalyzeInDryRun =
        !dryRun && applyMode === "dry-run" && module.mode === "analyze" && !runAnalyzeInDryRun;

      const moduleTimeoutBudgetMs = module.mode === "analyze"
        ? Math.min(attemptTimeoutMs, analyzeTimeoutMs)
        : attemptTimeoutMs;
      const commandForExecution = maybeInjectProviderTimeout(commandForAttempt, moduleTimeoutBudgetMs);
      const commandTimeoutMs = commandForExecution.includes("timeboxed.sh")
        ? Math.max(1_000, moduleTimeoutBudgetMs + 30_000)
        : Math.max(1_000, moduleTimeoutBudgetMs);

      let commandResult = shouldAutoPassAnalyzeInDryRun
        ? DagRunResultSchema.parse({
          moduleId: module.id,
          status: "success",
          command: commandForExecution,
          code: 0,
          stdout: "analyze auto-pass in apply-mode dry-run",
          stderr: "",
          durationMs: 0,
        })
        : dryRun
        ? DagRunResultSchema.parse({
          moduleId: module.id,
          status: "success",
          command: commandForExecution,
          code: 0,
          stdout: "dry-run",
          stderr: "",
          durationMs: 0,
        })
        : DagRunResultSchema.parse({
          ...(await runModuleCommand(commandForExecution, workspaceRoot, commandTimeoutMs)),
          moduleId: module.id,
        });

      let analyzeTimeoutFallbackNote = "";
      const shouldSoftPassAnalyzeTimeout =
        !dryRun &&
        module.mode === "analyze" &&
        commandResult.status === "failed" &&
        commandResult.code === 124;

      if (shouldSoftPassAnalyzeTimeout) {
        const timeoutDetail = (commandResult.stderr || commandResult.stdout || "provider timeout").trim();
        const compactTimeoutDetail = timeoutDetail.length > 240
          ? `${timeoutDetail.slice(0, 240)}...`
          : timeoutDetail;
        analyzeTimeoutFallbackNote = `analyze-timeout-fallback applied (${compactTimeoutDetail})`;
        commandResult = DagRunResultSchema.parse({
          ...commandResult,
          status: "success",
          code: 0,
          stdout: [commandResult.stdout, analyzeTimeoutFallbackNote].filter((line) => line.trim().length > 0).join("\n"),
          stderr: "",
        });
      }

      let implementGateTimeoutFallbackNote = "";
      const shouldSoftPassImplementGateTimeout =
        !dryRun &&
        applyMode === "dry-run" &&
        module.mode === "implement" &&
        isGateLikeModule(module) &&
        commandResult.status === "failed" &&
        commandResult.code === 124;

      if (shouldSoftPassImplementGateTimeout) {
        const timeoutDetail = (commandResult.stderr || commandResult.stdout || "provider timeout").trim();
        const compactTimeoutDetail = timeoutDetail.length > 240
          ? `${timeoutDetail.slice(0, 240)}...`
          : timeoutDetail;
        implementGateTimeoutFallbackNote = `implement-gate-timeout-fallback applied (${compactTimeoutDetail})`;
        commandResult = DagRunResultSchema.parse({
          ...commandResult,
          status: "success",
          code: 0,
          stdout: [commandResult.stdout, implementGateTimeoutFallbackNote]
            .filter((line) => line.trim().length > 0)
            .join("\n"),
          stderr: "",
        });
      }

      let moduleStatusMarkerFallbackNote = "";
      const moduleStatusMarker = parseModuleStatusMarker(`${commandResult.stdout}\n${commandResult.stderr}`);
      if (!dryRun && commandResult.status === "failed" && commandResult.code === 124 && moduleStatusMarker === "success") {
        moduleStatusMarkerFallbackNote = "module-status-timeout-fallback applied (MODULE_STATUS: success)";
        commandResult = DagRunResultSchema.parse({
          ...commandResult,
          status: "success",
          code: 0,
          stdout: [commandResult.stdout, moduleStatusMarkerFallbackNote]
            .filter((line) => line.trim().length > 0)
            .join("\n"),
          stderr: "",
        });
      } else if (!dryRun && commandResult.status === "success" && moduleStatusMarker === "failed") {
        commandResult = DagRunResultSchema.parse({
          ...commandResult,
          status: "failed",
          code: commandResult.code ?? 2,
          stderr: [commandResult.stderr, "provider reported MODULE_STATUS: failed"]
            .filter((line) => line.trim().length > 0)
            .join("\n"),
        });
      }

      if (module.mode === "implement") {
        budgetState.totalAttempts += 1;
      }

      const refusalLabel =
        !dryRun && module.mode === "implement" && commandResult.status === "success"
          ? detectAutonomyRefusal(`${commandResult.stdout}\n${commandResult.stderr}`)
          : null;

      if (refusalLabel) {
        commandResult = DagRunResultSchema.parse({
          ...commandResult,
          status: "failed",
          code: commandResult.code ?? 2,
          stderr: [commandResult.stderr, `non-actionable provider response detected (${refusalLabel})`]
            .filter((line) => line.trim().length > 0)
            .join("\n"),
        });
      }

      const commandTrace: DagCommandTrace = {
        command: commandForExecution,
        passed: commandResult.status === "success",
        code: commandResult.code,
        durationMs: commandResult.durationMs,
        stdout: commandResult.stdout,
        stderr: commandResult.stderr,
      };

      const afterSnapshot = dryRun
        ? beforeSnapshot
        : snapshotWorkspace({
          workspaceRoot,
          artifactsDirRel,
          repairsDirRel,
          gitIgnoredPrefixes: mergeGitIgnoredPrefixes(
            gitIgnoredPrefixesBase,
            loadGitIgnoredPrefixes({
              workspaceRoot,
              gitRepoRoot,
            }),
          ),
        });

      const changedFiles = dryRun ? [] : diffSnapshots(beforeSnapshot, afterSnapshot);

      const critic = await runCritic({
        enabled: !shouldAutoPassAnalyzeInDryRun && !dryRun && (args.enableCritic ?? false),
        workspaceRoot,
        timeoutMs,
        module,
        applyMode,
        requestPath: manifest.requestPath,
        partFileAbs: partFileForAttempt,
        changedFiles,
        criticCommandTemplate: args.criticCommandTemplate,
        artifactPathRel: artifactPathCandidate,
        repairTaskPath,
        policyPacks,
        policyCriticRules,
        failLevel: criticFailLevel,
      });

      const shouldRunTestImpact =
        !dryRun &&
        commandTrace.passed &&
        critic.passed &&
        workspaceFacts &&
        isTestImpactEligibleModule(module);

      const allowFullSuite = !fullSuiteCheckpointSatisfied && fullSuiteCheckpointModuleIds.has(module.id);
      const testImpact = shouldRunTestImpact
        ? await runTestImpact({
          mode: testImpactMode,
          applyMode,
          runFullSuiteInDryRun: args.fullTestInDryRun ?? false,
          allowFullSuite,
          workspaceRoot,
          changedFiles,
          facts: workspaceFacts,
          timeoutMs,
          fullTestCommand,
        })
        : {
          passed: true,
          traces: [] as DagCommandTrace[],
          commands: [] as string[],
          detail: dryRun ? "dry-run" : "test impact skipped",
          fullSuiteRan: false,
        };
      if (testImpact.fullSuiteRan) {
        fullSuiteCheckpointSatisfied = true;
      }

      const status: DagRunResult["status"] =
        !commandTrace.passed
          ? "failed"
          : !critic.passed
          ? "failed"
          : !testImpact.passed
          ? "failed"
          : "success";

      const riskNotes: string[] = [];
      if (!commandTrace.passed && commandTrace.stderr) riskNotes.push(commandTrace.stderr.slice(0, 500));
      if (shouldAutoPassAnalyzeInDryRun) riskNotes.push("analyze auto-pass in apply-mode dry-run");
      if (analyzeTimeoutFallbackNote) riskNotes.push(analyzeTimeoutFallbackNote);
      if (implementGateTimeoutFallbackNote) riskNotes.push(implementGateTimeoutFallbackNote);
      if (moduleStatusMarkerFallbackNote) riskNotes.push(moduleStatusMarkerFallbackNote);
      riskNotes.push(...critic.riskNotes);
      if (!testImpact.passed) riskNotes.push(testImpact.detail);

      const memoryRevisit = status === "success"
        ? []
        : collectMemoryRevisitHits({
          config: memoryRevisitConfig,
          state: memoryRevisitState,
          workspaceRoot,
          artifactsDirRel,
          module,
          attempt,
          stderr: [commandTrace.stderr, critic.detail, testImpact.detail].filter((line) => line).join("\n"),
          criticFindings: critic.findings,
          changedFiles,
          policyPacks,
        });
      accumulatedMemoryRevisit = mergeMemoryRevisitHits(accumulatedMemoryRevisit, memoryRevisit);
      const memoryRevisitForResult = accumulatedMemoryRevisit.length > 0
        ? accumulatedMemoryRevisit
        : memoryRevisit;

      let artifactPath: string | null = null;
      let artifactError: string | null = null;
      try {
        artifactPath = writeModuleArtifact({
          workspaceRoot,
          artifactsDirRel,
          moduleId: module.id,
          inputDigest: moduleInputDigest,
          attempt,
          status,
          changedFiles,
          command: commandTrace,
          critic: critic.trace,
          criticFindings: critic.findings,
          testImpact: testImpact.traces,
          riskNotes,
          policyPacks,
          repairTaskPath,
          memoryRevisit,
        });
      } catch (error) {
        artifactError = (error as Error).message;
      }

      const tokenAccounting = accumulateTokenAccounting([
        commandTrace,
        critic.trace,
        ...testImpact.traces,
      ]);
      budgetState.totalTokensEstimate += tokenAccounting.totalTokensEffective;
      budgetState.totalTokensObserved += tokenAccounting.totalTokensObserved;
      budgetState.totalTokensEstimated += tokenAccounting.totalTokensEstimated;
      budgetState.totalTokensEffective += tokenAccounting.totalTokensEffective;
      budgetState.observedTraceCount += tokenAccounting.observedTraceCount;
      budgetState.estimatedTraceCount += tokenAccounting.estimatedTraceCount;

      const stderrParts = [
        commandTrace.passed ? "" : commandTrace.stderr || commandTrace.stdout,
        critic.passed ? "" : critic.detail,
        testImpact.passed ? "" : testImpact.detail,
        artifactError ? `artifact contract write failed: ${artifactError}` : "",
      ].filter((part) => part && part.trim().length > 0);

      const finalStatus: DagRunResult["status"] =
        artifactError && requireArtifactContract ? "failed" : status;

      const outputResult = DagRunResultSchema.parse({
        moduleId: module.id,
        status: finalStatus,
        command: commandForExecution,
        code: commandTrace.code,
        stdout: commandTrace.stdout,
        stderr: stderrParts.join("\n"),
        durationMs:
          commandTrace.durationMs +
          (critic.trace?.durationMs ?? 0) +
          testImpact.traces.reduce((sum, trace) => sum + trace.durationMs, 0),
        attempt,
        tokensEstimate: tokenAccounting.totalTokensEffective,
        changedFiles,
        artifactPath,
        criticPassed: critic.passed,
        criticSeverity: critic.severity,
        criticFindings: critic.findings,
        repairTaskPath,
        memoryRevisit: memoryRevisitForResult,
        testImpactCommands: testImpact.commands,
        tokenAccountingMode:
          tokenAccounting.observedTraceCount > 0 && tokenAccounting.estimatedTraceCount > 0
            ? "mixed"
            : tokenAccounting.observedTraceCount > 0
            ? "observed"
            : "estimated",
        tokensObserved: tokenAccounting.totalTokensObserved,
        tokensEstimated: tokenAccounting.totalTokensEstimated,
        tokensEffective: tokenAccounting.totalTokensEffective,
        resumedFromArtifact: false,
      });

      lastResult = outputResult;

      if (outputResult.status === "success") {
        break;
      }

      if (!enableRepairLoop || attempt > maxRepairAttempts) {
        break;
      }

      let retryTimeoutNote = "";
      if (outputResult.code === 124 && module.mode === "implement") {
        const nextTimeout = computeRetryTimeoutBudgetMs(attemptTimeoutMs, timeoutMs);
        if (nextTimeout > attemptTimeoutMs) {
          retryTimeoutNote = `retry timeout budget increased from ${attemptTimeoutMs}ms to ${nextTimeout}ms`;
          attemptTimeoutMs = nextTimeout;
        }
      }

      repairTaskPath = createRepairTask({
        workspaceRoot,
        repairsDirRel,
        module,
        attempt,
        command: commandForExecution,
        stderr: [outputResult.stderr, retryTimeoutNote].filter((line) => line.trim().length > 0).join("\n"),
        artifactPath: outputResult.artifactPath,
        memoryRevisit: memoryRevisit,
      });
      repairsGenerated += 1;

      const repairPartAbs = path.resolve(workspaceRoot, repairTaskPath);
      partFileForAttempt = repairPartAbs;
      commandForAttempt = resolveRepairCommand({
        moduleCommand: module.command,
        executorTemplate: args.executorTemplate,
        executorProfile,
        executorProvider: args.executorProvider,
        providerTemplate: args.providerTemplate,
        applyMode,
        moduleId: module.id,
        title: `${module.title} (repair)`,
        repairPartFile: repairPartAbs,
        requestPath: manifest.requestPath,
      });

      if (!commandForAttempt) {
        break;
      }

      attempt += 1;
    }

    if (!lastResult) {
      return DagRunResultSchema.parse({
        moduleId: module.id,
        status: "failed",
        command: initialCommand,
        code: null,
        stdout: "",
        stderr: "module did not execute",
        durationMs: 0,
        changedFiles: [],
        artifactPath: null,
        repairTaskPath,
        criticPassed: null,
        testImpactCommands: [],
      });
    }

    return lastResult;
  };

  for (const level of levels) {
    if (applyMode === "apply" && (args.requireWaveApproval ?? true)) {
      const approvalPath = resolveApprovalPath({
        workspaceRoot,
        approvalDir: args.approvalDir,
        level: level.level,
      });

      if (!isWaveApproved(approvalPath)) {
        for (const moduleId of level.moduleIds) {
          const module = moduleById.get(moduleId);
          if (!module) continue;

          addResult(
            DagRunResultSchema.parse({
              moduleId: module.id,
              status: "blocked",
              command: null,
              code: null,
              stdout: "",
              stderr: `wave approval missing: ${path.relative(workspaceRoot, approvalPath).replace(/\\/g, "/")}`,
              durationMs: 0,
              changedFiles: [],
              artifactPath: null,
              repairTaskPath: null,
              criticPassed: null,
              testImpactCommands: [],
            }),
          );
        }

        if (shouldHalt()) {
          break;
        }

        continue;
      }
    }

    const queue = level.moduleIds
      .map((moduleId) => moduleById.get(moduleId))
      .filter((module): module is DagManifest["modules"][number] => Boolean(module));
    const active = new Map<string, Promise<{ moduleId: string; result: DagRunResult; resources: string[] }>>();
    const resourceOwners = new Map<string, string>();

    const tryLaunch = () => {
      const parallelLimit = canaryEnabled && !canaryCheckpointDone ? 1 : maxParallel;
      let launched = false;

      for (let index = 0; index < queue.length && active.size < parallelLimit;) {
        const module = queue[index];
        if (!module) {
          queue.splice(index, 1);
          continue;
        }

        if (canaryBlocked || shouldHalt()) break;

        const failedDeps = module.dependsOn.filter((dep) => failedModules.has(dep));
        if (failedDeps.length > 0) {
          addResult(
            DagRunResultSchema.parse({
              moduleId: module.id,
              status: "blocked",
              command: null,
              code: null,
              stdout: "",
              stderr: `blocked by failed dependencies: ${failedDeps.join(", ")}`,
              durationMs: 0,
              changedFiles: [],
              artifactPath: null,
              repairTaskPath: null,
              criticPassed: null,
              testImpactCommands: [],
            }),
          );
          queue.splice(index, 1);
          launched = true;
          continue;
        }

        const resources = normalizeModuleResources(module);
        if (resources.some((resource) => resourceOwners.has(resource))) {
          index += 1;
          continue;
        }

        queue.splice(index, 1);
        for (const resource of resources) {
          resourceOwners.set(resource, module.id);
        }

        const task = executeModule(module)
          .then((result) => ({ moduleId: module.id, result, resources }))
          .catch((error) => ({
            moduleId: module.id,
            resources,
            result: DagRunResultSchema.parse({
              moduleId: module.id,
              status: "failed",
              command: null,
              code: null,
              stdout: "",
              stderr: `internal module execution error: ${(error as Error).message}`,
              durationMs: 0,
              changedFiles: [],
              artifactPath: null,
              repairTaskPath: null,
              criticPassed: null,
              testImpactCommands: [],
            }),
          }));

        active.set(module.id, task);
        launched = true;
      }

      return launched;
    };

    while (queue.length > 0 || active.size > 0) {
      if (!canaryBlocked && !shouldHalt()) {
        tryLaunch();
      }

      if (active.size === 0) {
        break;
      }

      const completed = await Promise.race(active.values());
      active.delete(completed.moduleId);
      for (const resource of completed.resources) {
        if (resourceOwners.get(resource) === completed.moduleId) {
          resourceOwners.delete(resource);
        }
      }

      addResult(completed.result);
      await evaluateCanaryCheckpoint();

      if (shouldHalt() && active.size === 0) {
        break;
      }
    }

    if (shouldHalt()) {
      break;
    }
  }

  const results = manifest.modules
    .map((module) => resultByModule.get(module.id))
    .filter((result): result is DagRunResult => Boolean(result));

  if (canaryBlocked) {
    const seen = new Set(resultByModule.keys());
    for (const module of manifest.modules) {
      if (seen.has(module.id)) continue;
      const blockedResult = DagRunResultSchema.parse({
        moduleId: module.id,
        status: "blocked",
        command: null,
        code: null,
        stdout: "",
        stderr: canaryFailureDetail ?? "blocked by canary checkpoint failure",
        durationMs: 0,
        changedFiles: [],
        artifactPath: null,
        repairTaskPath: null,
        criticPassed: null,
        testImpactCommands: [],
      });
      resultByModule.set(module.id, blockedResult);
      failedModules.add(module.id);
    }
  }

  const finalResults = manifest.modules
    .map((module) => resultByModule.get(module.id))
    .filter((result): result is DagRunResult => Boolean(result));

  const successes = finalResults.filter((result) => result.status === "success").length;
  const failures = finalResults.filter((result) => result.status === "failed").length;
  const blocked = finalResults.filter((result) => result.status === "blocked").length;

  const status = failures > 0
    ? failures === finalResults.length
      ? "failure"
      : "partial_failure"
    : blocked > 0
    ? "partial_failure"
    : successes > 0
    ? "success"
    : "failure";

  const summary = DagRunSummarySchema.parse({
    manifestPath: path.relative(workspaceRoot, manifestAbs).replace(/\\/g, "/"),
    startedAt: runStartedAt,
    completedAt: new Date().toISOString(),
    status,
    results: finalResults,
    resumedModules,
    repairsGenerated,
    policyPacks,
    artifactsDir: artifactsDirRel,
    budget: buildBudgetSnapshot({
      config: budgetConfig,
      state: budgetState,
      startedAtMs: runStartedAtMs,
    }),
    canary: canaryEnabled
      ? {
        enabled: true,
        limitModules: canaryLimitModules,
        checkpointPassed: canaryCheckpointPassed,
        compareCommand: args.canaryCompareCommand ?? null,
        failureDetail: canaryFailureDetail,
      }
      : undefined,
    memoryRevisit: {
      enabled: memoryRevisitConfig.enabled,
      maxCallsPerModule: memoryRevisitConfig.maxCallsPerModule,
      topK: memoryRevisitConfig.topK,
      minScore: memoryRevisitConfig.minScore,
      totalCalls: memoryRevisitState.totalCalls,
      hitsUsed: memoryRevisitState.hitsUsed,
      candidatesLoadedBySource: memoryRevisitState.candidatesLoadedBySource,
      selectedBySource: memoryRevisitState.selectedBySource,
      skippedByReason: memoryRevisitState.skippedByReason,
    },
  });

  if (args.outputPath) {
    const outAbs = path.resolve(workspaceRoot, args.outputPath);
    mkdirSync(path.dirname(outAbs), { recursive: true });
    writeFileSync(outAbs, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  }

  return summary;
}
