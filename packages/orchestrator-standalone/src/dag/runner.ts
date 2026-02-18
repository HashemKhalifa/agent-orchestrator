import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
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
  type DagManifest,
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

const SNAPSHOT_IGNORES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
]);

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

    const finish = (payload: CommandCheckResult) => {
      if (settled) return;
      settled = true;
      resolve(payload);
    };

    const child = spawn(command, {
      cwd,
      shell: true,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

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

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timeout);
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

function shouldIgnoreRelativePath(args: { relativePath: string; artifactsDirRel: string; repairsDirRel: string }): boolean {
  const rel = normalizePathForOutput(args.relativePath);
  if (!rel || rel === ".") return false;

  const ignoredPrefixes = [
    normalizePathForOutput(args.artifactsDirRel).replace(/\/$/, ""),
    normalizePathForOutput(args.repairsDirRel).replace(/\/$/, ""),
  ];

  return ignoredPrefixes.some((prefix) => prefix && (rel === prefix || rel.startsWith(`${prefix}/`)));
}

function snapshotWorkspace(args: {
  workspaceRoot: string;
  artifactsDirRel: string;
  repairsDirRel: string;
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
      };
    }
  }

  if (args.mode === "targeted_then_full") {
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
      };
    }
  }

  if (commands.length === 0) {
    return {
      passed: true,
      traces,
      commands,
      detail: "no impacted packages with test:run script",
    };
  }

  return {
    passed: true,
    traces,
    commands,
    detail: "ok",
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
  changedFiles: DagDiffFile[];
}): DagCriticFinding[] {
  const findings: DagCriticFinding[] = [];

  if (args.moduleMode === "implement" && args.changedFiles.length === 0) {
    findings.push({
      severity: "blocker",
      message: "No file changes detected for implement module.",
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

function renderPolicyCriticPrompts(args: {
  rules: ResolvedPolicyCriticRule[];
  module: DagManifest["modules"][number];
  applyMode: ApplyMode;
  requestPath: string;
  partFileAbs: string;
  changedFiles: DagDiffFile[];
}): string {
  if (args.rules.length === 0) return "";

  const changedFiles = JSON.stringify(args.changedFiles.map((change) => `${change.change}:${change.path}`));
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

  const changedFilesJson = JSON.stringify(args.changedFiles.map((change) => `${change.change}:${change.path}`));
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
}): string {
  const artifactPathRel = normalizePathForOutput(path.join(args.artifactsDirRel, `${args.moduleId}.attempt-${args.attempt}.artifact.json`));
  const artifactAbs = path.resolve(args.workspaceRoot, artifactPathRel);

  const artifact = DagModuleArtifactSchema.parse({
    moduleId: args.moduleId,
    generatedAt: new Date().toISOString(),
    attempt: args.attempt,
    status: args.status,
    changedFiles: args.changedFiles,
    command: args.command,
    critic: args.critic,
    criticFindings: args.criticFindings,
    testImpact: args.testImpact,
    riskNotes: args.riskNotes,
    policyPacks: args.policyPacks,
    repairTaskPath: args.repairTaskPath,
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
  canaryLimitModules?: number;
  canaryCompareCommand?: string;
  maxParallel?: number;
  policyPacks?: string[];
  policyCriticConfigPath?: string;
}): Promise<DagRunSummary> {
  const runStartedAt = new Date().toISOString();
  const runStartedAtMs = Date.now();
  const workspaceRoot = path.resolve(args.workspaceRoot);
  const manifestAbs = path.resolve(workspaceRoot, args.manifestPath);
  const manifest = loadManifest(manifestAbs);
  const timeoutMs = Math.max(1000, args.timeoutMs ?? 10 * 60 * 1000);
  const failPolicy = args.failPolicy ?? "graph";
  const dryRun = Boolean(args.dryRun);
  const executorProfile = args.executorProfile ?? "none";
  const applyMode = args.applyMode ?? "dry-run";
  const artifactsDirRel = normalizePathForOutput(args.artifactsDir ?? "generated/orchestration/dag/artifacts");
  const repairsDirRel = normalizePathForOutput(args.repairsDir ?? "generated/orchestration/dag/repairs");
  const requireArtifactContract = args.requireArtifactContract ?? true;
  const testImpactMode = args.testImpactMode ?? "off";
  const fullTestCommand = args.fullTestCommand ?? "npm run test:run";
  const enableRepairLoop = args.enableRepairLoop ?? false;
  const maxRepairAttempts = Math.max(0, args.maxRepairAttempts ?? 1);
  const maxParallel = Math.max(1, Math.trunc(args.maxParallel ?? 1));
  const policyPacks = (args.policyPacks ?? []).filter((entry) => entry.trim().length > 0);
  const criticFailLevel = DagCriticSeveritySchema.parse(args.criticFailLevel ?? "blocker");
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
  const failedModules = new Set<string>();
  const resultByModule = new Map<string, DagRunResult>();

  const levels = topoLevelOrder(manifest.modules);
  const workspaceFacts = testImpactMode === "off" ? null : discoverWorkspaceFacts(workspaceRoot);

  let repairsGenerated = 0;
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

    let attempt = 1;
    let repairTaskPath: string | null = null;
    let commandForAttempt: string | null = initialCommand;
    let partFileForAttempt = modulePartAbs;
    let lastResult: DagRunResult | null = null;

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
        });

      budgetState.totalAttempts += 1;

      const commandResult = dryRun
        ? DagRunResultSchema.parse({
          moduleId: module.id,
          status: "success",
          command: commandForAttempt,
          code: 0,
          stdout: "dry-run",
          stderr: "",
          durationMs: 0,
        })
        : DagRunResultSchema.parse({
          ...(await runModuleCommand(commandForAttempt, workspaceRoot, timeoutMs)),
          moduleId: module.id,
        });

      const commandTrace: DagCommandTrace = {
        command: commandForAttempt,
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
        });

      const changedFiles = dryRun ? [] : diffSnapshots(beforeSnapshot, afterSnapshot);

      const critic = await runCritic({
        enabled: !dryRun && (args.enableCritic ?? false),
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

      const testImpact = !dryRun && commandTrace.passed && critic.passed && workspaceFacts
        ? await runTestImpact({
          mode: testImpactMode,
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
        };

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
      riskNotes.push(...critic.riskNotes);
      if (!testImpact.passed) riskNotes.push(testImpact.detail);

      let artifactPath: string | null = null;
      let artifactError: string | null = null;
      try {
        artifactPath = writeModuleArtifact({
          workspaceRoot,
          artifactsDirRel,
          moduleId: module.id,
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
        command: commandForAttempt,
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
      });

      lastResult = outputResult;

      if (outputResult.status === "success") {
        break;
      }

      if (!enableRepairLoop || attempt > maxRepairAttempts) {
        break;
      }

      repairTaskPath = createRepairTask({
        workspaceRoot,
        repairsDirRel,
        module,
        attempt,
        command: commandForAttempt,
        stderr: outputResult.stderr,
        artifactPath: outputResult.artifactPath,
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
  });

  if (args.outputPath) {
    const outAbs = path.resolve(workspaceRoot, args.outputPath);
    mkdirSync(path.dirname(outAbs), { recursive: true });
    writeFileSync(outAbs, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  }

  return summary;
}
