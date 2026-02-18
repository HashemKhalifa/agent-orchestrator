import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  WorkerStateSchema,
  cancelWorkerJob,
  enqueueWorkerJob,
  loadWorkerState,
  retryWorkerJob,
  runWorkerLoop,
  saveWorkerState,
  summarizeWorkerState,
} from "./worker.js";

describe("autonomy worker", () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const target of cleanup.splice(0, cleanup.length)) {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("enqueues and processes a job to completion", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-worker-"));
    cleanup.push(root);
    const statePath = path.join(root, "worker-state.json");

    const enqueued = enqueueWorkerJob({
      statePath,
      workspaceRoot: root,
      autoRunOptions: {
        "goal-type": ["build_migration"],
        "recipe-id": ["webpack-to-rsbuild-incremental"],
      },
      maxAttempts: 2,
    });

    const stats = await runWorkerLoop({
      statePath,
      once: true,
      workerId: "test-worker",
      pollIntervalMs: 10,
      heartbeatIntervalMs: 5,
      runJob: async () => ({ summaryPath: "generated/orchestration/autonomy/summary.json" }),
    });

    const state = loadWorkerState(statePath);
    const job = state.jobs.find((item) => item.id === enqueued.job.id);
    expect(job?.status).toBe("completed");
    expect(job?.attempt).toBe(1);
    expect(job?.summaryPath).toBe("generated/orchestration/autonomy/summary.json");
    expect(stats.completedJobs).toBe(1);
    expect(stats.processedJobs).toBe(1);
  });

  it("recovers stale running job and retries it", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-worker-stale-"));
    cleanup.push(root);
    const statePath = path.join(root, "worker-state.json");

    const staleAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const state = WorkerStateSchema.parse({
      schemaVersion: "1.0",
      updatedAt: new Date().toISOString(),
      jobs: [
        {
          id: "job-stale",
          createdAt: staleAt,
          updatedAt: staleAt,
          status: "running",
          attempt: 1,
          maxAttempts: 3,
          workspaceRoot: root,
          summaryPath: "generated/orchestration/worker/jobs/job-stale/auto-run-summary.json",
          autoRunOptions: {
            "goal-type": ["build_migration"],
            "recipe-id": ["webpack-to-rsbuild-incremental"],
          },
          workerId: "dead-worker",
          startedAt: staleAt,
          lastHeartbeatAt: staleAt,
          completedAt: null,
          lastError: null,
        },
      ],
    });
    saveWorkerState(statePath, state);

    let runs = 0;
    const stats = await runWorkerLoop({
      statePath,
      stopWhenEmpty: true,
      staleHeartbeatMs: 1000,
      heartbeatIntervalMs: 5,
      runJob: async () => {
        runs += 1;
        return { summaryPath: "generated/orchestration/autonomy/stale-summary.json" };
      },
    });

    const nextState = loadWorkerState(statePath);
    const job = nextState.jobs.find((item) => item.id === "job-stale");
    expect(runs).toBe(1);
    expect(job?.status).toBe("completed");
    expect(job?.attempt).toBe(2);
    expect(stats.recoveredStaleJobs).toBeGreaterThanOrEqual(1);
  });

  it("marks stale running job failed when max attempts exhausted", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-worker-stale-exhausted-"));
    cleanup.push(root);
    const statePath = path.join(root, "worker-state.json");

    const staleAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const state = WorkerStateSchema.parse({
      schemaVersion: "1.0",
      updatedAt: new Date().toISOString(),
      jobs: [
        {
          id: "job-exhausted",
          createdAt: staleAt,
          updatedAt: staleAt,
          status: "running",
          attempt: 3,
          maxAttempts: 3,
          workspaceRoot: root,
          summaryPath: "generated/orchestration/worker/jobs/job-exhausted/auto-run-summary.json",
          autoRunOptions: {
            "goal-type": ["build_migration"],
            "recipe-id": ["webpack-to-rsbuild-incremental"],
          },
          workerId: "dead-worker",
          startedAt: staleAt,
          lastHeartbeatAt: staleAt,
          completedAt: null,
          lastError: null,
        },
      ],
    });
    saveWorkerState(statePath, state);

    let runs = 0;
    await runWorkerLoop({
      statePath,
      stopWhenEmpty: true,
      staleHeartbeatMs: 1000,
      runJob: async () => {
        runs += 1;
        return {};
      },
    });

    const next = loadWorkerState(statePath);
    expect(runs).toBe(0);
    expect(next.jobs[0]?.status).toBe("failed");
    expect(next.jobs[0]?.lastError).toMatch(/stale heartbeat recovery exceeded max attempts/i);
  });

  it("does not recover stale heartbeat when owner worker process is still alive", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-worker-live-owner-"));
    cleanup.push(root);
    const statePath = path.join(root, "worker-state.json");

    const staleAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const state = WorkerStateSchema.parse({
      schemaVersion: "1.0",
      updatedAt: new Date().toISOString(),
      jobs: [
        {
          id: "job-live-owner",
          createdAt: staleAt,
          updatedAt: staleAt,
          status: "running",
          attempt: 1,
          maxAttempts: 3,
          workspaceRoot: root,
          summaryPath: "generated/orchestration/worker/jobs/job-live-owner/auto-run-summary.json",
          autoRunOptions: {
            "goal-type": ["build_migration"],
            "recipe-id": ["webpack-to-rsbuild-incremental"],
          },
          workerId: `${os.hostname()}-${process.pid}`,
          startedAt: staleAt,
          lastHeartbeatAt: staleAt,
          completedAt: null,
          lastError: null,
        },
      ],
    });
    saveWorkerState(statePath, state);

    let runs = 0;
    const stats = await runWorkerLoop({
      statePath,
      once: true,
      staleHeartbeatMs: 1000,
      runJob: async () => {
        runs += 1;
        return {};
      },
    });

    const nextState = loadWorkerState(statePath);
    const summary = summarizeWorkerState({ state: nextState, staleHeartbeatMs: 1000 });
    expect(runs).toBe(0);
    expect(stats.recoveredStaleJobs).toBe(0);
    expect(nextState.jobs[0]?.status).toBe("running");
    expect(summary.staleRunning).toBe(0);
  });

  it("requeues failed attempts until max attempts, then completes", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-worker-retry-"));
    cleanup.push(root);
    const statePath = path.join(root, "worker-state.json");

    enqueueWorkerJob({
      statePath,
      workspaceRoot: root,
      autoRunOptions: {
        "goal-type": ["build_migration"],
        "recipe-id": ["webpack-to-rsbuild-incremental"],
      },
      maxAttempts: 2,
      jobId: "job-retry",
    });

    let runs = 0;
    await runWorkerLoop({
      statePath,
      stopWhenEmpty: true,
      heartbeatIntervalMs: 5,
      runJob: async () => {
        runs += 1;
        if (runs === 1) throw new Error("first attempt failed");
        return { summaryPath: "generated/orchestration/autonomy/retry-summary.json" };
      },
    });

    const state = JSON.parse(readFileSync(statePath, "utf8"));
    const parsed = WorkerStateSchema.parse(state);
    const job = parsed.jobs.find((item) => item.id === "job-retry");
    const summary = summarizeWorkerState({ state: parsed });

    expect(runs).toBe(2);
    expect(job?.status).toBe("completed");
    expect(job?.attempt).toBe(2);
    expect(summary.completed).toBe(1);
    expect(summary.failed).toBe(0);
  });

  it("supports canceling pending job and retrying canceled job", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-worker-cancel-retry-"));
    cleanup.push(root);
    const statePath = path.join(root, "worker-state.json");

    enqueueWorkerJob({
      statePath,
      workspaceRoot: root,
      autoRunOptions: {
        "goal-type": ["custom"],
        "recipe-id": ["backlog-worker-cancel-retry-cli"],
      },
      maxAttempts: 3,
      jobId: "job-cancel-retry",
    });

    const canceled = cancelWorkerJob({
      statePath,
      jobId: "job-cancel-retry",
      reason: "operator-cancel",
    });
    expect(canceled.job.status).toBe("canceled");
    expect(canceled.job.lastError).toContain("operator-cancel");

    const retried = retryWorkerJob({
      statePath,
      jobId: "job-cancel-retry",
      reason: "operator-retry",
    });
    expect(retried.job.status).toBe("pending");
    expect(retried.job.attempt).toBe(0);
    expect(retried.job.lastError).toContain("operator-retry");
  });

  it("requires reset-attempts when retrying exhausted jobs", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-worker-retry-exhausted-"));
    cleanup.push(root);
    const statePath = path.join(root, "worker-state.json");

    const now = new Date().toISOString();
    saveWorkerState(statePath, WorkerStateSchema.parse({
      schemaVersion: "1.0",
      updatedAt: now,
      jobs: [
        {
          id: "job-exhausted-retry",
          createdAt: now,
          updatedAt: now,
          status: "failed",
          attempt: 3,
          maxAttempts: 3,
          workspaceRoot: root,
          summaryPath: "generated/orchestration/worker/jobs/job-exhausted-retry/auto-run-summary.json",
          autoRunOptions: {
            "goal-type": ["custom"],
            "recipe-id": ["backlog-worker-cancel-retry-cli"],
          },
          workerId: null,
          startedAt: now,
          lastHeartbeatAt: now,
          completedAt: now,
          lastError: "max attempts exhausted",
        },
      ],
    }));

    expect(() => retryWorkerJob({
      statePath,
      jobId: "job-exhausted-retry",
    })).toThrow(/reset-attempts/i);

    const retried = retryWorkerJob({
      statePath,
      jobId: "job-exhausted-retry",
      resetAttempts: true,
      reason: "manual-reset-retry",
    });
    expect(retried.job.status).toBe("pending");
    expect(retried.job.attempt).toBe(0);
  });
});
