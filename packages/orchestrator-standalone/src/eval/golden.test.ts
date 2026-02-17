import path from "node:path";
import { describe, expect, it } from "vitest";
import { runGoldenEvaluation } from "./golden.js";

describe("runGoldenEvaluation", () => {
  it("passes deterministic fixture suite", async () => {
    const fixturesDir = path.resolve(process.cwd(), "testdata", "golden");
    const result = await runGoldenEvaluation({ fixturesDir });

    expect(result.total).toBeGreaterThan(0);
    expect(result.failed).toBe(0);
  });
});
