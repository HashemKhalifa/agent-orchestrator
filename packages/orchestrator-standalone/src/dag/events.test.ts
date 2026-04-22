import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendDagRunEventFile, materializeDagRunSnapshots, readDagRunEventsFromFile } from "./events.js";
import type { GraphManifestV2 } from "./graph-v2.js";

describe("dag events reducer", () => {
  const cleanupPaths: string[] = [];

  afterEach(() => {
    for (const p of cleanupPaths.splice(0, cleanupPaths.length)) {
      rmSync(p, { recursive: true, force: true });
    }
  });

  it("materializes run-summary.v2 and node-state.v2 from ordered events", () => {
    const graph: GraphManifestV2 = {
      schemaVersion: "2.0",
      name: "demo",
      description: "demo graph",
      requestPath: "request.md",
      generatedAt: "2026-02-26T00:00:00.000Z",
      dependencyMode: "staged",
      nodes: [
        {
          id: "01",
          title: "one",
          description: "one",
          mode: "implement",
          kind: "module",
          entryGroup: "workstream:one",
          lockKeys: [],
          level: 0,
          execution: { partPath: "parts/01.md", command: "echo one" },
          dependsOn: [],
        },
      ],
      edges: [],
    };

    const result = materializeDagRunSnapshots({
      graph,
      runId: "run-1",
      events: [
        {
          type: "run_started",
          runId: "run-1",
          at: "2026-02-26T00:00:00.000Z",
          manifestPath: "generated/orchestration/dag/manifest.json",
          graphPath: "generated/orchestration/dag/graph.json",
          moduleCount: 1,
        },
        {
          type: "node_started",
          runId: "run-1",
          at: "2026-02-26T00:00:01.000Z",
          nodeId: "01",
          attempt: 1,
        },
        {
          type: "node_completed",
          runId: "run-1",
          at: "2026-02-26T00:00:03.000Z",
          nodeId: "01",
          attempt: 1,
          status: "success",
          code: 0,
          durationMs: 2000,
          artifactPath: "generated/orchestration/dag/artifacts/01.attempt-1.artifact.json",
          repairTaskPath: null,
        },
        {
          type: "run_completed",
          runId: "run-1",
          at: "2026-02-26T00:00:04.000Z",
          status: "success",
          successCount: 1,
          failedCount: 0,
          blockedCount: 0,
          skippedCount: 0,
          totalCount: 1,
        },
      ],
    });

    expect(result.runSummary.schemaVersion).toBe("2.0");
    expect(result.runSummary.status).toBe("success");
    expect(result.runSummary.counts.success).toBe(1);
    expect(result.runSummary.frontier.completed).toBe(1);
    expect(result.nodeState.nodes[0]?.status).toBe("success");
  });

  it("reads ndjson events and skips malformed trailing partial line", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-events-read-"));
    cleanupPaths.push(root);
    const filePath = path.join(root, "run-summary.events.ndjson");

    appendDagRunEventFile(filePath, {
      type: "run_started",
      runId: "run-2",
      at: "2026-02-26T00:00:00.000Z",
      manifestPath: "generated/orchestration/dag/manifest.json",
      graphPath: null,
      moduleCount: 1,
    });

    const raw = `${readFileSync(filePath, "utf8")}{"type":"node_started"`;
    // Simulate a truncated final write.
    writeFileSync(filePath, raw, "utf8");

    const loaded = readDagRunEventsFromFile(filePath);
    expect(loaded.events.length).toBe(1);
    expect(loaded.errors.length).toBe(0);
    expect(loaded.events[0]?.type).toBe("run_started");
  });
});
