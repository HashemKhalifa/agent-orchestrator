import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { z } from "zod";

export const WorkerJobStatusSchema = z.enum(["pending", "running", "completed", "failed", "canceled"]);

export const WorkerJobSchema = z.object({
  id: z.string().trim().min(1),
  createdAt: z.string().trim().min(1),
  updatedAt: z.string().trim().min(1),
  status: WorkerJobStatusSchema,
  attempt: z.number().int().nonnegative().default(0),
  maxAttempts: z.number().int().positive().default(3),
  workspaceRoot: z.string().trim().min(1),
  summaryPath: z.string().trim().min(1),
  autoRunOptions: z.record(z.string(), z.array(z.string())).default({}),
  workerId: z.string().nullable().default(null),
  startedAt: z.string().nullable().default(null),
  lastHeartbeatAt: z.string().nullable().default(null),
  completedAt: z.string().nullable().default(null),
  lastError: z.string().nullable().default(null),
});

export const WorkerStateSchema = z.object({
  schemaVersion: z.literal("1.0"),
  updatedAt: z.string().trim().min(1),
  jobs: z.array(WorkerJobSchema).default([]),
});

export type WorkerJobStatus = z.infer<typeof WorkerJobStatusSchema>;
export type WorkerJob = z.infer<typeof WorkerJobSchema>;
export type WorkerState = z.infer<typeof WorkerStateSchema>;

export interface WorkerSummary {
  totalJobs: number;
  pending: number;
  running: number;
  completed: number;
  failed: number;
  canceled: number;
  staleRunning: number;
}

export interface WorkerRunStats {
  workerId: string;
  startedAt: string;
  completedAt: string;
  processedJobs: number;
  completedJobs: number;
  failedJobs: number;
  recoveredStaleJobs: number;
  finalSummary: WorkerSummary;
}

function nowIso(): string {
  return new Date().toISOString();
}

function toMs(value: string | null): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizePositiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const rounded = Math.trunc(value);
  return rounded > 0 ? rounded : fallback;
}

function defaultWorkerState(): WorkerState {
  return WorkerStateSchema.parse({
    schemaVersion: "1.0",
    updatedAt: nowIso(),
    jobs: [],
  });
}

function setStateUpdatedAt(state: WorkerState): WorkerState {
  return WorkerStateSchema.parse({
    ...state,
    updatedAt: nowIso(),
  });
}

function withUpdatedJob(state: WorkerState, jobId: string, updater: (job: WorkerJob) => WorkerJob): WorkerState {
  let changed = false;
  const nextJobs = state.jobs.map((job) => {
    if (job.id !== jobId) return job;
    changed = true;
    return WorkerJobSchema.parse(updater(job));
  });
  return changed ? setStateUpdatedAt({ ...state, jobs: nextJobs }) : state;
}

function sortJobsByCreatedAt(jobs: WorkerJob[]): WorkerJob[] {
  return jobs.slice().sort((a, b) => {
    const createdDelta = toMs(a.createdAt) - toMs(b.createdAt);
    if (createdDelta !== 0) return createdDelta;
    return a.id.localeCompare(b.id);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

function parseWorkerIdentity(workerId: string | null): { host: string; pid: number } | null {
  const raw = workerId?.trim();
  if (!raw) return null;
  const splitIndex = raw.lastIndexOf("-");
  if (splitIndex <= 0 || splitIndex >= raw.length - 1) return null;
  const host = raw.slice(0, splitIndex);
  const pidRaw = raw.slice(splitIndex + 1);
  const pid = Number(pidRaw);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return { host, pid };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function hasLiveWorkerOwner(job: WorkerJob): boolean {
  const worker = parseWorkerIdentity(job.workerId);
  if (!worker) return false;
  if (worker.host !== os.hostname()) return false;
  if (worker.pid === process.pid) return true;
  return isProcessAlive(worker.pid);
}

function isStaleRunningJob(job: WorkerJob, nowMs: number, staleHeartbeatMs: number): boolean {
  if (job.status !== "running") return false;
  if (hasLiveWorkerOwner(job)) return false;
  const heartbeatAt = toMs(job.lastHeartbeatAt) || toMs(job.startedAt);
  if (heartbeatAt <= 0) return true;
  return nowMs - heartbeatAt >= staleHeartbeatMs;
}

export function defaultWorkerStatePath(workspaceRoot: string): string {
  return path.resolve(workspaceRoot, "generated/orchestration/worker/state.json");
}

export function defaultWorkerId(): string {
  return `${os.hostname()}-${process.pid}`;
}

export function loadWorkerState(statePath: string): WorkerState {
  const absolute = path.resolve(statePath);
  if (!existsSync(absolute)) return defaultWorkerState();
  const parsed = JSON.parse(readFileSync(absolute, "utf8"));
  return WorkerStateSchema.parse(parsed);
}

export function saveWorkerState(statePath: string, state: WorkerState): void {
  const absolute = path.resolve(statePath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(WorkerStateSchema.parse(state), null, 2)}\n`, "utf8");
}

export function summarizeWorkerState(args: {
  state: WorkerState;
  staleHeartbeatMs?: number;
  nowMs?: number;
}): WorkerSummary {
  const staleMs = normalizePositiveInt(args.staleHeartbeatMs, 120_000);
  const nowMs = args.nowMs ?? Date.now();

  const summary: WorkerSummary = {
    totalJobs: args.state.jobs.length,
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
    canceled: 0,
    staleRunning: 0,
  };

  for (const job of args.state.jobs) {
    if (job.status === "pending") summary.pending += 1;
    else if (job.status === "running") summary.running += 1;
    else if (job.status === "completed") summary.completed += 1;
    else if (job.status === "failed") summary.failed += 1;
    else if (job.status === "canceled") summary.canceled += 1;

    if (isStaleRunningJob(job, nowMs, staleMs)) summary.staleRunning += 1;
  }

  return summary;
}

export function enqueueWorkerJob(args: {
  statePath: string;
  workspaceRoot: string;
  autoRunOptions: Record<string, string[]>;
  maxAttempts?: number;
  jobId?: string;
  summaryPath?: string;
}): {
  state: WorkerState;
  job: WorkerJob;
} {
  const absoluteStatePath = path.resolve(args.statePath);
  const workspaceRoot = path.resolve(args.workspaceRoot);
  const maxAttempts = normalizePositiveInt(args.maxAttempts, 3);
  const state = loadWorkerState(absoluteStatePath);
  const createdAt = nowIso();
  const id = args.jobId?.trim() || `job-${Date.now()}-${randomUUID().slice(0, 8)}`;

  if (state.jobs.some((job) => job.id === id)) {
    throw new Error(`Worker job '${id}' already exists.`);
  }

  const summaryPath = args.summaryPath && args.summaryPath.trim().length > 0
    ? args.summaryPath.trim()
    : `generated/orchestration/worker/jobs/${id}/auto-run-summary.json`;

  const job = WorkerJobSchema.parse({
    id,
    createdAt,
    updatedAt: createdAt,
    status: "pending",
    attempt: 0,
    maxAttempts,
    workspaceRoot,
    summaryPath,
    autoRunOptions: args.autoRunOptions,
    workerId: null,
    startedAt: null,
    lastHeartbeatAt: null,
    completedAt: null,
    lastError: null,
  });

  const nextState = setStateUpdatedAt({
    ...state,
    jobs: [...state.jobs, job],
  });
  saveWorkerState(absoluteStatePath, nextState);

  return {
    state: nextState,
    job,
  };
}

function findJobById(state: WorkerState, jobId: string): WorkerJob {
  const job = state.jobs.find((candidate) => candidate.id === jobId);
  if (!job) {
    throw new Error(`Worker job '${jobId}' not found.`);
  }
  return job;
}

export function cancelWorkerJob(args: {
  statePath: string;
  jobId: string;
  reason?: string;
}): {
  state: WorkerState;
  job: WorkerJob;
} {
  const absoluteStatePath = path.resolve(args.statePath);
  const state = loadWorkerState(absoluteStatePath);
  const existing = findJobById(state, args.jobId);
  if (existing.status === "completed" || existing.status === "failed" || existing.status === "canceled") {
    throw new Error(
      `Worker job '${args.jobId}' cannot be canceled from status '${existing.status}'.`,
    );
  }

  const timestamp = nowIso();
  const nextState = withUpdatedJob(state, args.jobId, (current) => ({
    ...current,
    status: "canceled",
    workerId: null,
    updatedAt: timestamp,
    lastHeartbeatAt: timestamp,
    completedAt: timestamp,
    lastError: args.reason?.trim() || "Canceled by operator.",
  }));
  saveWorkerState(absoluteStatePath, nextState);

  return {
    state: nextState,
    job: findJobById(nextState, args.jobId),
  };
}

export function retryWorkerJob(args: {
  statePath: string;
  jobId: string;
  reason?: string;
  resetAttempts?: boolean;
}): {
  state: WorkerState;
  job: WorkerJob;
} {
  const absoluteStatePath = path.resolve(args.statePath);
  const state = loadWorkerState(absoluteStatePath);
  const existing = findJobById(state, args.jobId);
  if (existing.status !== "failed" && existing.status !== "canceled") {
    throw new Error(
      `Worker job '${args.jobId}' cannot be retried from status '${existing.status}'.`,
    );
  }
  if (!args.resetAttempts && existing.attempt >= existing.maxAttempts) {
    throw new Error(
      `Worker job '${args.jobId}' exhausted attempts (${existing.attempt}/${existing.maxAttempts}); use --reset-attempts.`,
    );
  }

  const timestamp = nowIso();
  const nextState = withUpdatedJob(state, args.jobId, (current) => ({
    ...current,
    status: "pending",
    attempt: args.resetAttempts ? 0 : current.attempt,
    workerId: null,
    startedAt: null,
    updatedAt: timestamp,
    lastHeartbeatAt: timestamp,
    completedAt: null,
    lastError: args.reason?.trim() || "Retry requested by operator.",
  }));
  saveWorkerState(absoluteStatePath, nextState);

  return {
    state: nextState,
    job: findJobById(nextState, args.jobId),
  };
}

export function recoverStaleRunningJobs(args: {
  state: WorkerState;
  staleHeartbeatMs?: number;
  nowMs?: number;
}): {
  state: WorkerState;
  recoveredCount: number;
  exhaustedCount: number;
} {
  const staleMs = normalizePositiveInt(args.staleHeartbeatMs, 120_000);
  const nowMs = args.nowMs ?? Date.now();
  const timestamp = nowIso();

  let recoveredCount = 0;
  let exhaustedCount = 0;
  let nextState = args.state;

  for (const job of args.state.jobs) {
    if (!isStaleRunningJob(job, nowMs, staleMs)) continue;

    if (job.attempt >= job.maxAttempts) {
      exhaustedCount += 1;
      nextState = withUpdatedJob(nextState, job.id, (current) => ({
        ...current,
        status: "failed",
        workerId: null,
        lastHeartbeatAt: timestamp,
        completedAt: timestamp,
        updatedAt: timestamp,
        lastError: `stale heartbeat recovery exceeded max attempts (${current.attempt}/${current.maxAttempts})`,
      }));
      continue;
    }

    recoveredCount += 1;
    nextState = withUpdatedJob(nextState, job.id, (current) => ({
      ...current,
      status: "pending",
      workerId: null,
      updatedAt: timestamp,
      lastHeartbeatAt: timestamp,
      lastError: "Recovered stale running job; re-queued for retry.",
    }));
  }

  return {
    state: nextState,
    recoveredCount,
    exhaustedCount,
  };
}

function claimNextPendingJob(args: {
  state: WorkerState;
  workerId: string;
}): {
  state: WorkerState;
  job: WorkerJob | null;
} {
  const pending = sortJobsByCreatedAt(args.state.jobs).find((job) => job.status === "pending");
  if (!pending) {
    return {
      state: args.state,
      job: null,
    };
  }

  const timestamp = nowIso();
  const claimedState = withUpdatedJob(args.state, pending.id, (current) => {
    const nextAttempt = current.attempt + 1;
    if (nextAttempt > current.maxAttempts) {
      return {
        ...current,
        status: "failed",
        updatedAt: timestamp,
        completedAt: timestamp,
        workerId: null,
        lastError: `max attempts exceeded before claim (${nextAttempt}/${current.maxAttempts})`,
      };
    }

    return {
      ...current,
      status: "running",
      attempt: nextAttempt,
      workerId: args.workerId,
      startedAt: current.startedAt ?? timestamp,
      updatedAt: timestamp,
      lastHeartbeatAt: timestamp,
      completedAt: null,
      lastError: null,
    };
  });

  const claimed = claimedState.jobs.find((job) => job.id === pending.id) ?? null;
  if (!claimed || claimed.status !== "running") {
    return {
      state: claimedState,
      job: null,
    };
  }

  return {
    state: claimedState,
    job: claimed,
  };
}

function markJobHeartbeat(state: WorkerState, jobId: string, workerId: string): WorkerState {
  const timestamp = nowIso();
  return withUpdatedJob(state, jobId, (current) => {
    if (current.status !== "running" || current.workerId !== workerId) return current;
    return {
      ...current,
      updatedAt: timestamp,
      lastHeartbeatAt: timestamp,
    };
  });
}

function markJobCompleted(args: {
  state: WorkerState;
  jobId: string;
  summaryPath?: string;
}): WorkerState {
  const timestamp = nowIso();
  return withUpdatedJob(args.state, args.jobId, (current) => {
    if (current.status !== "running") return current;
    return {
      ...current,
      status: "completed",
      workerId: null,
      updatedAt: timestamp,
      lastHeartbeatAt: timestamp,
      completedAt: timestamp,
      summaryPath: args.summaryPath ?? current.summaryPath,
      lastError: null,
    };
  });
}

function markJobFailedOrRequeue(args: {
  state: WorkerState;
  jobId: string;
  errorMessage: string;
}): WorkerState {
  const timestamp = nowIso();
  return withUpdatedJob(args.state, args.jobId, (current) => {
    if (current.status !== "running") return current;
    const exhausted = current.attempt >= current.maxAttempts;
    return {
      ...current,
      status: exhausted ? "failed" : "pending",
      workerId: null,
      updatedAt: timestamp,
      lastHeartbeatAt: timestamp,
      completedAt: exhausted ? timestamp : null,
      lastError: args.errorMessage,
    };
  });
}

export async function runWorkerLoop(args: {
  statePath: string;
  runJob: (job: WorkerJob) => Promise<{ summaryPath?: string | null }>;
  workerId?: string;
  once?: boolean;
  stopWhenEmpty?: boolean;
  maxJobs?: number;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  staleHeartbeatMs?: number;
  idleTimeoutMs?: number;
}): Promise<WorkerRunStats> {
  const statePath = path.resolve(args.statePath);
  const workerId = args.workerId?.trim() || defaultWorkerId();
  const pollIntervalMs = normalizePositiveInt(args.pollIntervalMs, 5_000);
  const heartbeatIntervalMs = normalizePositiveInt(args.heartbeatIntervalMs, 5_000);
  const staleHeartbeatMs = normalizePositiveInt(args.staleHeartbeatMs, 120_000);
  const maxJobs = args.maxJobs && Number.isFinite(args.maxJobs) ? Math.max(0, Math.trunc(args.maxJobs)) : null;
  const idleTimeoutMs = args.idleTimeoutMs && Number.isFinite(args.idleTimeoutMs)
    ? Math.max(0, Math.trunc(args.idleTimeoutMs))
    : null;

  const startedAt = nowIso();
  let processedJobs = 0;
  let completedJobs = 0;
  let failedJobs = 0;
  let recoveredStaleJobs = 0;
  let idleSinceMs = Date.now();

  while (true) {
    let state = loadWorkerState(statePath);

    const recovered = recoverStaleRunningJobs({
      state,
      staleHeartbeatMs,
    });
    state = recovered.state;
    recoveredStaleJobs += recovered.recoveredCount;
    if (recovered.recoveredCount > 0 || recovered.exhaustedCount > 0) {
      saveWorkerState(statePath, state);
    }

    const claimed = claimNextPendingJob({
      state,
      workerId,
    });
    state = claimed.state;

    if (!claimed.job) {
      if (args.once || args.stopWhenEmpty) break;
      if (maxJobs !== null && processedJobs >= maxJobs) break;
      if (idleTimeoutMs !== null && Date.now() - idleSinceMs >= idleTimeoutMs) break;
      await sleep(pollIntervalMs);
      continue;
    }
    const job = claimed.job;

    idleSinceMs = Date.now();
    saveWorkerState(statePath, state);

    let heartbeatTimer: NodeJS.Timeout | null = setInterval(() => {
      const current = loadWorkerState(statePath);
      const withHeartbeat = markJobHeartbeat(current, job.id, workerId);
      saveWorkerState(statePath, withHeartbeat);
    }, heartbeatIntervalMs);

    const stopHeartbeat = (): void => {
      if (!heartbeatTimer) return;
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    };

    try {
      const result = await args.runJob(job);
      stopHeartbeat();

      const current = loadWorkerState(statePath);
      const completedState = markJobCompleted({
        state: current,
        jobId: job.id,
        summaryPath: result.summaryPath ?? undefined,
      });
      saveWorkerState(statePath, completedState);
      processedJobs += 1;
      completedJobs += 1;
    } catch (error) {
      stopHeartbeat();
      const message = (error as Error).message || "worker job execution failed";
      const current = loadWorkerState(statePath);
      const nextState = markJobFailedOrRequeue({
        state: current,
        jobId: job.id,
        errorMessage: message,
      });
      const finalJob = nextState.jobs.find((candidate) => candidate.id === job.id);
      if (finalJob?.status === "failed") failedJobs += 1;
      processedJobs += 1;
      saveWorkerState(statePath, nextState);
    }

    if (args.once) break;
    if (maxJobs !== null && processedJobs >= maxJobs) break;
  }

  const finalState = loadWorkerState(statePath);
  return {
    workerId,
    startedAt,
    completedAt: nowIso(),
    processedJobs,
    completedJobs,
    failedJobs,
    recoveredStaleJobs,
    finalSummary: summarizeWorkerState({
      state: finalState,
      staleHeartbeatMs,
    }),
  };
}
