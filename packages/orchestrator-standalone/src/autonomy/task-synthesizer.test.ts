import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildRagIndex, saveRagIndex } from "../rag/indexer.js";
import { synthesizeTaskRequest } from "./task-synthesizer.js";

describe("synthesizeTaskRequest", () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const target of cleanup.splice(0, cleanup.length)) {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("creates request markdown from recipe + discovery + rag", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-task-synth-"));
    cleanup.push(root);

    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "demo", version: "1.0.0" }), "utf8");
    writeFileSync(
      path.join(root, "src", "build.ts"),
      "export const migration = 'webpack to rsbuild migration with plugin compatibility checks';\n",
      "utf8",
    );

    const ragIndex = buildRagIndex({ workspaceRoot: root, maxFiles: 100 });
    const ragPath = saveRagIndex({
      index: ragIndex,
      outputPath: path.join(root, "generated", "rag", "index.json"),
    });

    const discoveryPath = path.join(root, "generated", "autonomy", "discovery.json");
    mkdirSync(path.dirname(discoveryPath), { recursive: true });
    writeFileSync(
      discoveryPath,
      JSON.stringify(
        {
          recipeId: "webpack-to-rsbuild-incremental",
          localSummary: "Monorepo with webpack references",
          workspaceFacts: {
            packageCount: 1,
            detectedBuildTools: ["webpack"],
            detectedTestTools: ["vitest"],
            detectedCiProviders: ["github_actions"],
          },
          internetEvidence: [
            {
              sourceId: "rsbuild-migrate",
              title: "Rsbuild Migration",
              ok: true,
              statusCode: 200,
              detectedSignals: ["migration", "compatibility"],
              url: "https://rsbuild.dev/guide/migration/webpack",
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = synthesizeTaskRequest({
      workspaceRoot: root,
      goalType: "build_migration",
      recipeId: "webpack-to-rsbuild-incremental",
      discoveryPath,
      ragIndexPath: ragPath,
      outputPath: "generated/autonomy/request.generated.md",
      maxTasks: 20,
    });

    expect(result.taskCount).toBeGreaterThan(4);
    expect(existsSync(result.requestPath)).toBe(true);
    expect(readFileSync(result.requestPath, "utf8")).toContain("Auto-Generated Orchestration Request");

    const generated = path.relative(root, result.requestPath).replace(/\\/g, "/");
    expect(generated).toBe("generated/autonomy/request.generated.md");
  });
});
