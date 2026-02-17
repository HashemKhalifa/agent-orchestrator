import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  DagManifestSchema,
  DagRunResultSchema,
  DagRunSummarySchema,
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

function runCommandCheck(command: string, cwd: string, timeoutMs: number): {
  passed: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
} {
  const startedAt = Date.now();
  const result = spawnSync(command, {
    cwd,
    shell: true,
    timeout: timeoutMs,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });

  const statusCode = typeof result.status === "number" ? result.status : null;
  const stderr = result.stderr ?? (result.error ? result.error.message : "");

  return {
    passed: statusCode === 0,
    code: statusCode,
    stdout: result.stdout ?? "",
    stderr,
    durationMs: Math.max(0, Date.now() - startedAt),
  };
}

function runModuleCommand(command: string, cwd: string, timeoutMs: number): DagRunResult {
  const check = runCommandCheck(command, cwd, timeoutMs);
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

function resolveApprovalPath(args: {
  workspaceRoot: string;
  approvalDir?: string;
  level: number;
}): string {
  const approvalDir = args.approvalDir ?? "generated/orchestration/approvals";
  const approvalDirAbs = path.resolve(args.workspaceRoot, approvalDir);
  return path.join(approvalDirAbs, `wave-${args.level + 1}.approved.json`);
}

export function runDag(args: {
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
}): DagRunSummary {
  const runStartedAt = new Date().toISOString();
  const workspaceRoot = path.resolve(args.workspaceRoot);
  const manifestAbs = path.resolve(workspaceRoot, args.manifestPath);
  const manifest = loadManifest(manifestAbs);
  const timeoutMs = Math.max(1000, args.timeoutMs ?? 10 * 60 * 1000);
  const failPolicy = args.failPolicy ?? "graph";
  const dryRun = Boolean(args.dryRun);
  const executorProfile = args.executorProfile ?? "none";
  const applyMode = args.applyMode ?? "dry-run";

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
      const rollbackCheck = runCommandCheck(args.rollbackCheckCommand, workspaceRoot, timeoutMs);
      if (!rollbackCheck.passed) {
        const details = rollbackCheck.stderr.trim() || rollbackCheck.stdout.trim() || "rollback check failed";
        throw new Error(`Apply mode blocked: rollback check command failed (${details.slice(0, 240)}).`);
      }
    }
  }

  const moduleById = new Map(manifest.modules.map((module) => [module.id, module]));
  const failedModules = new Set<string>();
  const results: DagRunResult[] = [];

  const levels = topoLevelOrder(manifest.modules);

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

          results.push(
            DagRunResultSchema.parse({
              moduleId: module.id,
              status: "blocked",
              command: null,
              code: null,
              stdout: "",
              stderr: `wave approval missing: ${path.relative(workspaceRoot, approvalPath).replace(/\\/g, "/")}`,
              durationMs: 0,
            }),
          );
          failedModules.add(module.id);
        }

        if (failPolicy === "global") {
          break;
        }

        continue;
      }
    }

    for (const moduleId of level.moduleIds) {
      const module = moduleById.get(moduleId);
      if (!module) continue;

      const failedDeps = module.dependsOn.filter((dep) => failedModules.has(dep));
      if (failedDeps.length > 0) {
        results.push(
          DagRunResultSchema.parse({
            moduleId: module.id,
            status: "blocked",
            command: null,
            code: null,
            stdout: "",
            stderr: `blocked by failed dependencies: ${failedDeps.join(", ")}`,
            durationMs: 0,
          }),
        );
        failedModules.add(module.id);
        continue;
      }

      const modulePartAbs = path.resolve(workspaceRoot, module.partPath);
      const command = resolveModuleCommand({
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

      if (!command) {
        results.push(
          DagRunResultSchema.parse({
            moduleId: module.id,
            status: "skipped",
            command: null,
            code: null,
            stdout: "",
            stderr: "no module command, executor template, profile, or provider configured",
            durationMs: 0,
          }),
        );
        continue;
      }

      if (dryRun) {
        results.push(
          DagRunResultSchema.parse({
            moduleId: module.id,
            status: "success",
            command,
            code: 0,
            stdout: "dry-run",
            stderr: "",
            durationMs: 0,
          }),
        );
        continue;
      }

      const commandResult = runModuleCommand(command, workspaceRoot, timeoutMs);
      const normalized = DagRunResultSchema.parse({
        ...commandResult,
        moduleId: module.id,
      });
      results.push(normalized);

      if (normalized.status !== "success") {
        failedModules.add(module.id);
        if (failPolicy === "global") {
          break;
        }
      }
    }

    if (failPolicy === "global" && failedModules.size > 0) {
      break;
    }
  }

  const successes = results.filter((result) => result.status === "success").length;
  const failures = results.filter((result) => result.status === "failed").length;
  const blocked = results.filter((result) => result.status === "blocked").length;

  const status = failures > 0
    ? failures === results.length
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
    results,
  });

  if (args.outputPath) {
    const outAbs = path.resolve(workspaceRoot, args.outputPath);
    mkdirSync(path.dirname(outAbs), { recursive: true });
    writeFileSync(outAbs, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  }

  return summary;
}
