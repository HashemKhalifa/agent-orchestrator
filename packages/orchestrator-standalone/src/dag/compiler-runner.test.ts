import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileRequestDag } from "./compiler.js";
import { runDag } from "./runner.js";

describe("request DAG compile/run", () => {
  const cleanupPaths: string[] = [];

  afterEach(() => {
    for (const p of cleanupPaths.splice(0, cleanupPaths.length)) {
      rmSync(p, { recursive: true, force: true });
    }
  });

  it("compiles request into manifest and runs dry-run executor", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-core-dag-"));
    cleanupPaths.push(root);

    const requestPath = path.join(root, "request.md");
    writeFileSync(
      requestPath,
      `# Migration\n\n## Objective\nDo things.\n\n## Wave 1\nImplement phase one.\n\n## Delivery Requirements\nValidate outputs.\n`,
      "utf8",
    );

    const manifest = await compileRequestDag({
      workspaceRoot: root,
      requestPath: "request.md",
      outputDir: "generated/orchestration/dag",
      dependencyMode: "staged",
    });

    expect(manifest.modules.length).toBeGreaterThanOrEqual(1);
    expect(existsSync(path.join(root, "generated", "orchestration", "dag", "manifest.json"))).toBe(true);

    const summary = runDag({
      workspaceRoot: root,
      manifestPath: "generated/orchestration/dag/manifest.json",
      executorTemplate: "echo processing {partFile}",
      dryRun: true,
      outputPath: "generated/orchestration/dag/run-summary.json",
    });

    expect(summary.results.length).toBe(manifest.modules.length);
    expect(summary.status).toBe("success");
    expect(existsSync(path.join(root, "generated", "orchestration", "dag", "run-summary.json"))).toBe(true);
  });
});
