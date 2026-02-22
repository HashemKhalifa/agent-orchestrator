import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { buildRagIndex } from "./indexer.js";
import { queryRagIndex } from "./retriever.js";
import { runAutoRefineQuery } from "./refine.js";

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

  it("iteratively refines retrieval queries within budgets", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-rag-refine-"));
    cleanup.push(root);

    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(
      path.join(root, "src", "notes.ts"),
      [
        "export const notes = 'webpack plugin compatibility and bundler migration checklist';",
        "export const risk = 'loader deprecation and rsbuild migration edge cases';",
      ].join("\n"),
      "utf8",
    );

    const index = buildRagIndex({ workspaceRoot: root, maxFiles: 50 });
    const refined = runAutoRefineQuery({
      index,
      seedQueries: ["webpack migration"],
      topK: 5,
      maxIterations: 3,
      maxQueries: 12,
      maxRuntimeMs: 3000,
      maxTokenBudget: 6000,
    });

    expect(refined.hits.length).toBeGreaterThan(0);
    expect(refined.iterations.length).toBeGreaterThan(0);
    expect(refined.budget.usedQueries).toBeGreaterThan(0);
    expect(refined.budget.maxStallIterations).toBe(2);
    expect(refined.budget.convergenceEpsilon).toBeCloseTo(0.005, 6);
    expect(refined.iterations[0]?.critique).toBe("cold_start");
    expect(refined.hits[0].filePath).toContain("notes.ts");
  });

  it("excludes generated directory by default and can opt in", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-rag-generated-"));
    cleanup.push(root);

    mkdirSync(path.join(root, "src"), { recursive: true });
    mkdirSync(path.join(root, "generated"), { recursive: true });
    writeFileSync(
      path.join(root, "src", "real.ts"),
      "export const source = 'primary source of truth';\n",
      "utf8",
    );
    writeFileSync(
      path.join(root, "generated", "noise.ts"),
      "export const generated = 'generated output should be ignored by default';\n",
      "utf8",
    );

    const defaultIndex = buildRagIndex({ workspaceRoot: root, maxFiles: 50 });
    expect(defaultIndex.chunks.some((chunk) => chunk.filePath.startsWith("generated/"))).toBe(false);

    const withGenerated = buildRagIndex({ workspaceRoot: root, maxFiles: 50, includeGenerated: true });
    expect(withGenerated.chunks.some((chunk) => chunk.filePath.startsWith("generated/"))).toBe(true);
  });

  it("can stop early on convergence critic", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-rag-converged-"));
    cleanup.push(root);

    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(
      path.join(root, "src", "same.ts"),
      "export const note = 'webpack rsbuild migration compatibility checklist and migration risks';\n",
      "utf8",
    );

    const index = buildRagIndex({ workspaceRoot: root, maxFiles: 50 });
    const refined = runAutoRefineQuery({
      index,
      seedQueries: ["webpack migration", "rsbuild migration"],
      topK: 5,
      maxIterations: 5,
      maxQueriesPerIteration: 1,
      maxQueries: 10,
      maxRuntimeMs: 3000,
      maxTokenBudget: 6000,
      maxStallIterations: 1,
      convergenceEpsilon: 1,
    });

    expect(refined.budget.stopReason).toBe("converged");
    expect(refined.budget.stalledIterations).toBeGreaterThanOrEqual(1);
  });

  it("treats zero token budget as disabled throttling", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-rag-no-token-limit-"));
    cleanup.push(root);

    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(
      path.join(root, "src", "content.ts"),
      "export const value = 'react migration hooks hydration regression checklist';\n",
      "utf8",
    );

    const index = buildRagIndex({ workspaceRoot: root, maxFiles: 50 });
    const refined = runAutoRefineQuery({
      index,
      seedQueries: ["react migration"],
      maxIterations: 2,
      maxQueries: 6,
      maxTokenBudget: 0,
    });

    expect(refined.budget.maxTokenBudget).toBe(0);
    expect(refined.budget.usedTokensEstimate).toBeGreaterThan(0);
    expect(refined.budget.stopReason).not.toBe("token_budget_reached");
  });

  it("enforces index size guards for large inputs", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-rag-size-guards-"));
    cleanup.push(root);

    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(path.join(root, "src", "small.ts"), "export const x = 1;\n", "utf8");
    writeFileSync(path.join(root, "src", "huge.ts"), "a".repeat(300_000), "utf8");

    const index = buildRagIndex({
      workspaceRoot: root,
      maxFiles: 50,
      maxFileBytes: 100_000,
      maxChunks: 2,
      maxTotalChars: 60,
      maxCharsPerChunk: 100,
      linesPerChunk: 1,
    });

    expect(index.chunkCount).toBeLessThanOrEqual(2);
    expect(index.chunks.every((chunk) => chunk.filePath !== "src/huge.ts")).toBe(true);
  });

  it("respects gitignored paths in nested workspace roots", () => {
    const repoRoot = mkdtempSync(path.join(os.tmpdir(), "orchestrator-rag-gitignore-"));
    const workspaceRoot = path.join(repoRoot, "packages", "app");
    cleanup.push(repoRoot);

    try {
      execFileSync("git", ["--version"], { stdio: "ignore" });
    } catch {
      return;
    }

    mkdirSync(path.join(workspaceRoot, "src"), { recursive: true });
    mkdirSync(path.join(workspaceRoot, ".custom-cache"), { recursive: true });
    writeFileSync(path.join(repoRoot, ".gitignore"), "packages/app/.custom-cache/\n", "utf8");
    writeFileSync(path.join(workspaceRoot, "src", "real.ts"), "export const real = true;\n", "utf8");
    writeFileSync(path.join(workspaceRoot, ".custom-cache", "noise.ts"), "export const noise = true;\n", "utf8");
    execFileSync("git", ["-C", repoRoot, "init", "-q"], { stdio: "ignore" });

    const index = buildRagIndex({ workspaceRoot, maxFiles: 50 });
    expect(index.chunks.some((chunk) => chunk.filePath.startsWith(".custom-cache/"))).toBe(false);
    expect(index.chunks.some((chunk) => chunk.filePath === "src/real.ts")).toBe(true);
  });
});
