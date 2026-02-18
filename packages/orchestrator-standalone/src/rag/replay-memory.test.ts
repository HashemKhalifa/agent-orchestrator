import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runAutoRefineQuery } from "./refine.js";
import { buildRagIndex } from "./indexer.js";
import { recordReplayOutcome, suggestReplayQueries } from "./replay-memory.js";

describe("replay memory", () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const target of cleanup.splice(0, cleanup.length)) {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("records successful refine outcomes and suggests replay queries", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-rag-replay-"));
    cleanup.push(root);

    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(
      path.join(root, "src", "notes.ts"),
      [
        "export const notes = 'react migration hydration createRoot deprecation checklist';",
        "export const tests = 'add regression tests for hydration and hooks behavior';",
      ].join("\n"),
      "utf8",
    );

    const index = buildRagIndex({ workspaceRoot: root, maxFiles: 50 });
    const refined = runAutoRefineQuery({
      index,
      seedQueries: ["react migration hydration"],
      maxIterations: 2,
      maxQueries: 8,
      maxTokenBudget: 0,
    });
    expect(refined.hits.length).toBeGreaterThan(0);

    const recorded = recordReplayOutcome({
      workspaceRoot: root,
      recipeId: "react18-to-react19",
      seedQueries: ["react migration hydration"],
      refined,
    });
    expect(existsSync(recorded.memoryPath)).toBe(true);
    expect(recorded.entryCount).toBeGreaterThan(0);

    const suggested = suggestReplayQueries({
      workspaceRoot: root,
      recipeId: "react18-to-react19",
      seedQueries: ["react createRoot migration"],
      maxQueries: 4,
    });
    expect(suggested.querySuggestions.length).toBeGreaterThan(0);
  });

  it("applies replay retention by age, confidence, and max entry caps", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-rag-replay-retention-"));
    cleanup.push(root);

    const now = Date.now();
    const oldDate = new Date(now - 120 * 24 * 60 * 60 * 1000).toISOString();
    const recentDate = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString();

    const replayPath = path.join(root, "generated", "orchestration", "autonomy", "rag", "replay", "state.json");
    mkdirSync(path.dirname(replayPath), { recursive: true });
    writeFileSync(
      replayPath,
      JSON.stringify({
        schemaVersion: "1.0",
        fingerprint: "demo",
        repoRoot: root,
        recipeId: "react18-to-react19",
        updatedAt: recentDate,
        entries: [
          {
            seedKey: "old-low",
            seedQueries: ["old query"],
            recommendedQueries: ["old suggestion"],
            topHitPaths: ["src/old.ts"],
            score: 0.01,
            successCount: 1,
            usageCount: 1,
            updatedAt: oldDate,
            stopReason: "converged",
          },
          {
            seedKey: "recent-good",
            seedQueries: ["react migration"],
            recommendedQueries: ["react hydration checklist"],
            topHitPaths: ["src/new.ts"],
            score: 0.65,
            successCount: 2,
            usageCount: 2,
            updatedAt: recentDate,
            stopReason: "converged",
          },
        ],
      }),
      "utf8",
    );

    const suggested = suggestReplayQueries({
      workspaceRoot: root,
      recipeId: "react18-to-react19",
      memoryPath: replayPath,
      seedQueries: ["react createRoot"],
      retentionMaxAgeDays: 30,
      retentionMinScore: 0.2,
      retentionMaxEntries: 1,
    });
    expect(suggested.querySuggestions).toContain("react hydration checklist");
    expect(suggested.querySuggestions).not.toContain("old suggestion");

    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(path.join(root, "src", "new.ts"), "export const x = 'react hydration';", "utf8");
    const index = buildRagIndex({ workspaceRoot: root, maxFiles: 50 });
    const refined = runAutoRefineQuery({
      index,
      seedQueries: ["react hydration"],
      maxIterations: 1,
      maxQueries: 4,
      maxTokenBudget: 0,
    });

    const recorded = recordReplayOutcome({
      workspaceRoot: root,
      recipeId: "react18-to-react19",
      memoryPath: replayPath,
      seedQueries: ["react hydration"],
      refined,
      retentionMaxEntries: 1,
      retentionMaxAgeDays: 30,
      retentionMinScore: 0.2,
    });

    expect(recorded.entryCount).toBe(1);
    const state = JSON.parse(readFileSync(replayPath, "utf8"));
    expect(state.retention.maxEntries).toBe(1);
    expect(state.entries.length).toBe(1);
  });
});
