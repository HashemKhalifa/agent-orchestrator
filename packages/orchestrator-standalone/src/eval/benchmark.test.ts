import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runBenchmarkEvaluation } from "./benchmark.js";

describe("runBenchmarkEvaluation", () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const target of cleanup.splice(0, cleanup.length)) {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("produces benchmark scorecards, failure drills, and trend deltas", async () => {
    const fixturesDir = path.resolve(process.cwd(), "testdata", "golden");
    const temp = mkdtempSync(path.join(os.tmpdir(), "orchestrator-benchmark-history-"));
    cleanup.push(temp);
    const historyPath = path.join(temp, "history.json");

    const first = await runBenchmarkEvaluation({
      fixturesDir,
      historyPath,
      persistHistory: true,
      commit: "bench-a",
    });
    const second = await runBenchmarkEvaluation({
      fixturesDir,
      historyPath,
      persistHistory: true,
      commit: "bench-b",
    });

    expect(first.totals.scenarios).toBeGreaterThan(0);
    expect(first.scorecards.length).toBe(first.totals.scenarios);
    expect(first.totals.avgQualityScore).toBeGreaterThanOrEqual(0);
    expect(first.totals.avgFailureRate).toBeLessThanOrEqual(1);
    expect(first.scorecards[0].failureDrills.length).toBeGreaterThanOrEqual(2);

    expect(second.trend.historyPath).toBe(historyPath);
    expect(second.trend.entryCount).toBeGreaterThanOrEqual(2);
    expect(second.trend.deltaFromPrevious?.previousCommit).toBe("bench-a");
    expect(second.trend.gate.passed).toBe(true);
    expect(second.trend.gate.checked).toBe(false);
  });

  it("flags threshold violations from trend deltas", async () => {
    const fixturesDir = path.resolve(process.cwd(), "testdata", "golden");
    const temp = mkdtempSync(path.join(os.tmpdir(), "orchestrator-benchmark-threshold-"));
    cleanup.push(temp);
    const historyPath = path.join(temp, "history.json");

    writeFileSync(
      historyPath,
      JSON.stringify(
        [
          {
            generatedAt: new Date().toISOString(),
            commit: "baseline",
            totals: {
              scenarios: 3,
              avgQualityScore: 100,
              avgTimeMs: 0,
              avgCostTokens: 0,
              avgFailureRate: 0,
              passRate: 100,
            },
          },
        ],
        null,
        2,
      ),
      "utf8",
    );

    const result = await runBenchmarkEvaluation({
      fixturesDir,
      historyPath,
      persistHistory: false,
      commit: "bench-threshold",
      trendThresholds: {
        maxTimeMsIncrease: 0,
      },
    });

    expect(result.trend.deltaFromPrevious).not.toBeNull();
    expect(result.trend.gate.enabled).toBe(true);
    expect(result.trend.gate.checked).toBe(true);
    expect(result.trend.gate.passed).toBe(false);
    expect(result.trend.gate.violations.some((item) => item.includes("avg time increased"))).toBe(true);
  });
});
