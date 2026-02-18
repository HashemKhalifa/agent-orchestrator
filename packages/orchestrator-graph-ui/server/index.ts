import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRunState } from "./reader.js";

const app = express();

const packageRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const repoRoot = path.resolve(packageRoot, "..", "..");
const port = Number(process.env.ORCH_GRAPH_UI_API_PORT ?? process.env.PORT ?? 4319);

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "orchestrator-graph-ui-api",
    now: new Date().toISOString(),
  });
});

app.get("/api/run-state", (req, res) => {
  try {
    res.json(buildRunStateResponse(req.query.workspaceRoot, req.query.autonomyDir));
  } catch (error) {
    res.status(500).json(toRunStateErrorResponse(error));
  }
});

app.get("/api/stream", (req, res) => {
  const intervalMs = clampIntervalMs(readQueryNumber(req.query.intervalMs));
  const workspaceRootValue = req.query.workspaceRoot;
  const autonomyDirValue = req.query.autonomyDir;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const writePayload = () => {
    try {
      const payload = buildRunStateResponse(workspaceRootValue, autonomyDirValue);
      res.write(`event: run-state\n`);
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch (error) {
      const payload = toRunStateErrorResponse(error);
      res.write(`event: run-error\n`);
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    }
  };

  writePayload();
  const interval = setInterval(writePayload, intervalMs);
  const ping = setInterval(() => {
    res.write(`event: heartbeat\ndata: {"ok":true,"now":"${new Date().toISOString()}"}\n\n`);
  }, Math.max(1000, intervalMs));

  req.on("close", () => {
    clearInterval(interval);
    clearInterval(ping);
  });
});

app.listen(port, () => {
  process.stdout.write(`[graph-ui] api listening on http://localhost:${port}\n`);
});

function readQueryString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) return value;
  if (Array.isArray(value) && typeof value[0] === "string" && value[0].trim().length > 0) return value[0];
  return undefined;
}

function readQueryNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (Array.isArray(value) && typeof value[0] === "string") return readQueryNumber(value[0]);
  return null;
}

function clampIntervalMs(value: number | null): number {
  if (value == null) return 2000;
  return Math.max(500, Math.min(10000, Math.round(value)));
}

function buildRunStateResponse(workspaceRootValue: unknown, autonomyDirValue: unknown) {
  const workspaceRootInput = readQueryString(workspaceRootValue);
  const autonomyDirInput = readQueryString(autonomyDirValue);
  const state = loadRunState({
    repoRoot,
    workspaceRootInput,
    autonomyDirInput,
  });

  return {
    ok: true,
    sourcePaths: state.sourcePaths,
    run: state.run,
    nodes: state.nodes,
    edges: state.edges,
    history: state.history,
    telemetry: state.telemetry,
    errors: state.errors,
    refreshedAt: new Date().toISOString(),
  };
}

function toRunStateErrorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    sourcePaths: {
      manifestPath: null,
      runSummaryPath: null,
      artifactsDir: null,
      iterationSummaryPath: null,
    },
    run: {
      status: "unknown",
      cursorStep: 0,
      totalModules: 0,
      successCount: 0,
      failedCount: 0,
      blockedCount: 0,
      skippedCount: 0,
    },
    nodes: [],
    edges: [],
    history: [],
    telemetry: null,
    errors: [message],
    refreshedAt: new Date().toISOString(),
  };
}
