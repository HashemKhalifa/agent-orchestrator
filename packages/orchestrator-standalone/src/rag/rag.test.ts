import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildRagIndex } from "./indexer.js";
import { queryRagIndex } from "./retriever.js";

describe("RAG index + query", () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const target of cleanup.splice(0, cleanup.length)) {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("indexes repository files and returns relevant chunks", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-rag-"));
    cleanup.push(root);

    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(
      path.join(root, "src", "migration.ts"),
      "export const plan = 'migrate webpack config to rsbuild with plugin compatibility checks';\n",
      "utf8",
    );
    writeFileSync(
      path.join(root, "README.md"),
      "React 19 upgrade notes with hydration and hooks caveats.\n",
      "utf8",
    );

    const index = buildRagIndex({ workspaceRoot: root, maxFiles: 50 });
    expect(index.chunkCount).toBeGreaterThan(0);

    const query = queryRagIndex({
      index,
      query: "webpack rsbuild plugin migration",
      topK: 3,
    });

    expect(query.hits.length).toBeGreaterThan(0);
    expect(query.hits[0].filePath).toContain("migration.ts");
  });
});
