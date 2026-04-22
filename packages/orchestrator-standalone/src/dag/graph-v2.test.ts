import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileRequestDag } from "./compiler.js";
import { graphV2ToManifestV1, manifestV1ToGraphV2 } from "./graph-v2.js";
import type { DagManifest } from "./types.js";

describe("graph v2 adapters", () => {
  const cleanupPaths: string[] = [];

  afterEach(() => {
    for (const p of cleanupPaths.splice(0, cleanupPaths.length)) {
      rmSync(p, { recursive: true, force: true });
    }
  });

  it("round-trips v1 manifest to v2 graph and preserves execution-critical fields", () => {
    const manifest: DagManifest = {
      schemaVersion: "1.0",
      name: "demo",
      description: "demo manifest",
      requestPath: "request.md",
      generatedAt: new Date().toISOString(),
      dependencyMode: "staged",
      modules: [
        {
          id: "01-core",
          title: "Core context",
          description: "core context",
          partPath: "parts/p01.md",
          mode: "analyze",
          kind: "module",
          entryGroup: "core-context",
          level: 0,
          dependsOn: [],
          resources: ["pkg:core"],
          command: "echo hi",
        },
        {
          id: "02-gate",
          title: "Acceptance gate",
          description: "gate check",
          partPath: "parts/p02.md",
          mode: "implement",
          kind: "gate",
          entryGroup: "governance",
          level: 1,
          dependsOn: ["01-core"],
          resources: ["pkg:core"],
        },
      ],
    };

    const graph = manifestV1ToGraphV2(manifest);
    expect(graph.schemaVersion).toBe("2.0");
    expect(graph.nodes[0]?.execution.partPath).toBe("parts/p01.md");
    expect(graph.nodes[0]?.execution.command).toBe("echo hi");
    expect(graph.nodes[0]?.lockKeys).toEqual(["pkg:core"]);
    expect(graph.edges[0]?.kind).toBe("depends_on");

    const projected = graphV2ToManifestV1(graph);
    expect(projected.schemaVersion).toBe("1.0");
    expect(projected.modules[0]?.partPath).toBe("parts/p01.md");
    expect(projected.modules[0]?.command).toBe("echo hi");
    expect(projected.modules[0]?.resources).toEqual(["pkg:core"]);
    expect(projected.modules[1]?.dependsOn).toEqual(["01-core"]);
  });

  it("writes graph.json in graph-mode v2 and keeps projected manifest.json", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-graph-v2-"));
    cleanupPaths.push(root);
    writeFileSync(path.join(root, "request.md"), "# Req\n\n## Objective\nA\n\n## Delivery Requirements\nB\n", "utf8");

    await compileRequestDag({
      workspaceRoot: root,
      requestPath: "request.md",
      outputDir: "generated/orchestration/dag",
      dependencyMode: "staged",
      graphMode: "v2",
    });

    const manifestPath = path.join(root, "generated", "orchestration", "dag", "manifest.json");
    const graphPath = path.join(root, "generated", "orchestration", "dag", "graph.json");
    expect(existsSync(manifestPath)).toBe(true);
    expect(existsSync(graphPath)).toBe(true);

    const graph = JSON.parse(readFileSync(graphPath, "utf8")) as { schemaVersion?: string; nodes?: unknown[] };
    expect(graph.schemaVersion).toBe("2.0");
    expect(Array.isArray(graph.nodes)).toBe(true);
  });

  it("keeps v1-only outputs when graph-mode is auto", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-graph-v2-auto-"));
    cleanupPaths.push(root);
    writeFileSync(path.join(root, "request.md"), "# Req\n\n## Scope\nA\n", "utf8");

    await compileRequestDag({
      workspaceRoot: root,
      requestPath: "request.md",
      outputDir: "generated/orchestration/dag",
      dependencyMode: "staged",
      graphMode: "auto",
    });

    expect(existsSync(path.join(root, "generated", "orchestration", "dag", "manifest.json"))).toBe(true);
    expect(existsSync(path.join(root, "generated", "orchestration", "dag", "graph.json"))).toBe(false);
  });
});
