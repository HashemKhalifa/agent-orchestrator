import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
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

function applyExecutorTemplate(template: string, args: {
  id: string;
  title: string;
  partFile: string;
  requestPath: string;
}): string {
  return template
    .replaceAll("{id}", args.id)
    .replaceAll("{title}", args.title)
    .replaceAll("{partFile}", args.partFile)
    .replaceAll("{requestPath}", args.requestPath);
}

function runCommand(command: string, cwd: string, timeoutMs: number): DagRunResult {
  const startedAt = Date.now();
  const result = spawnSync(command, {
    cwd,
    shell: true,
    timeout: timeoutMs,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });

  return DagRunResultSchema.parse({
    moduleId: "",
    status: typeof result.status === "number" && result.status === 0 ? "success" : "failed",
    command,
    code: typeof result.status === "number" ? result.status : null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? (result.error ? result.error.message : ""),
    durationMs: Math.max(0, Date.now() - startedAt),
  });
}

export function runDag(args: {
  workspaceRoot: string;
  manifestPath: string;
  executorTemplate?: string;
  failPolicy?: "graph" | "global";
  timeoutMs?: number;
  outputPath?: string;
  dryRun?: boolean;
}): DagRunSummary {
  const runStartedAt = new Date().toISOString();
  const manifestAbs = path.resolve(args.workspaceRoot, args.manifestPath);
  const manifest = loadManifest(manifestAbs);
  const timeoutMs = Math.max(1000, args.timeoutMs ?? 10 * 60 * 1000);
  const failPolicy = args.failPolicy ?? "graph";
  const dryRun = Boolean(args.dryRun);

  const moduleById = new Map(manifest.modules.map((module) => [module.id, module]));
  const failedModules = new Set<string>();
  const results: DagRunResult[] = [];

  const levels = topoLevelOrder(manifest.modules);

  for (const level of levels) {
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

      const modulePartAbs = path.resolve(args.workspaceRoot, module.partPath);
      const command = module.command
        ? module.command
        : args.executorTemplate
        ? applyExecutorTemplate(args.executorTemplate, {
            id: module.id,
            title: module.title,
            partFile: modulePartAbs,
            requestPath: manifest.requestPath,
          })
        : null;

      if (!command) {
        results.push(
          DagRunResultSchema.parse({
            moduleId: module.id,
            status: "skipped",
            command: null,
            code: null,
            stdout: "",
            stderr: "no module command or executor template provided",
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

      const commandResult = runCommand(command, args.workspaceRoot, timeoutMs);
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
    manifestPath: path.relative(args.workspaceRoot, manifestAbs).replace(/\\/g, "/"),
    startedAt: runStartedAt,
    completedAt: new Date().toISOString(),
    status,
    results,
  });

  if (args.outputPath) {
    const outAbs = path.resolve(args.workspaceRoot, args.outputPath);
    mkdirSync(path.dirname(outAbs), { recursive: true });
    writeFileSync(outAbs, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  }

  return summary;
}
