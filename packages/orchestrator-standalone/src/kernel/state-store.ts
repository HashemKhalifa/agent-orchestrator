import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  type ExecutionReport,
  type ExecutionPlan,
  type RunState,
  RunStateSchema,
  type ValidationReport,
} from "../spec/schemas.js";

export interface PersistedPaths {
  runDir: string;
  statePath: string;
  planPath: string;
  validationPath: string;
  executionPath: string;
  cyclePath: string;
}

function timestampForFile(date = new Date()): string {
  return date.toISOString().replace(/[.:]/g, "-");
}

export function resolvePersistedPaths(baseRunsDir: string, runId: string): PersistedPaths {
  const runDir = path.resolve(baseRunsDir, runId);
  const stamp = timestampForFile();
  return {
    runDir,
    statePath: path.join(runDir, "state.json"),
    planPath: path.join(runDir, `plan-${stamp}.json`),
    validationPath: path.join(runDir, `validation-${stamp}.json`),
    executionPath: path.join(runDir, `execution-${stamp}.json`),
    cyclePath: path.join(runDir, `cycle-${stamp}.json`),
  };
}

function ensureRunDir(paths: PersistedPaths): void {
  mkdirSync(paths.runDir, { recursive: true });
}

export function loadRunState(statePath: string): RunState | null {
  if (!existsSync(statePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8"));
    return RunStateSchema.parse(parsed);
  } catch {
    return null;
  }
}

export function saveRunState(statePath: string, state: RunState): void {
  const valid = RunStateSchema.parse(state);
  writeFileSync(statePath, `${JSON.stringify(valid, null, 2)}\n`, "utf8");
}

export function persistCycleArtifacts(args: {
  paths: PersistedPaths;
  plan: ExecutionPlan;
  validation: ValidationReport;
  execution: ExecutionReport;
  cycleSummary: unknown;
  state: RunState;
}): void {
  ensureRunDir(args.paths);
  writeFileSync(args.paths.planPath, `${JSON.stringify(args.plan, null, 2)}\n`, "utf8");
  writeFileSync(args.paths.validationPath, `${JSON.stringify(args.validation, null, 2)}\n`, "utf8");
  writeFileSync(args.paths.executionPath, `${JSON.stringify(args.execution, null, 2)}\n`, "utf8");
  writeFileSync(args.paths.cyclePath, `${JSON.stringify(args.cycleSummary, null, 2)}\n`, "utf8");
  saveRunState(args.paths.statePath, args.state);
}
