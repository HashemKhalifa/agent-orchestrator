import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runOrchestrationCycle } from "../kernel/orchestrator.js";
import { applyRecipeMemory, deriveRecipeMemory } from "./memory.js";
import { getRecipeById } from "./catalog.js";

function latestExecutionPath(runDir: string): string {
  const files = readdirSync(runDir).filter((name) => name.startsWith("execution-")).sort().reverse();
  if (files.length === 0) throw new Error("missing execution artifact");
  return path.join(runDir, files[0]);
}

describe("recipe memory", () => {
  const cleanup: string[] = [];

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        new Response(`<html><title>${url}</title><body>reference without blockers</body></html>`, { status: 200 })),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const target of cleanup.splice(0, cleanup.length)) {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("derives learned probes and gates from recurring failures", async () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), "orchestrator-memory-"));
    cleanup.push(repo);

    writeFileSync(
      path.join(repo, "package.json"),
      JSON.stringify({
        name: "memory-test",
        private: true,
        scripts: {
          "test:run": "node -e \"process.exit(0)\"",
          typecheck: "node -e \"process.exit(0)\"",
          lint: "node -e \"process.exit(0)\"",
        },
      }),
      "utf8",
    );
    mkdirSync(path.join(repo, ".github", "workflows"), { recursive: true });
    writeFileSync(path.join(repo, ".github", "workflows", "ci.yml"), "name: ci\n", "utf8");
    writeFileSync(path.join(repo, "vitest.config.ts"), "export default {};\n", "utf8");

    const runsDir = path.join(repo, "generated", "runs");

    const first = await runOrchestrationCycle({
      goal: {
        goalType: "ci_refactor",
        recipeId: "ci-node-build-test-modernization",
        workspaceRoot: repo,
        sourcePolicy: "primary_plus_curated_secondary",
        riskGateMode: "strict_blockers",
        requireTddTests: true,
        curatedSourceDomains: [],
        additionalContext: {},
        waveStrategy: "big_bang",
      },
      mode: "dry-run",
      runsDir,
    });

    const firstExecPath = latestExecutionPath(path.join(runsDir, first.runId));
    const firstExec = JSON.parse(readFileSync(firstExecPath, "utf8"));
    firstExec.gateResults = [{ gateId: "gate-typecheck", required: true, passed: false, details: "fail" }];
    firstExec.blockerSummary = ["memory leak suspected in teardown path"];
    writeFileSync(firstExecPath, `${JSON.stringify(firstExec, null, 2)}\n`, "utf8");

    const second = await runOrchestrationCycle({
      goal: {
        goalType: "ci_refactor",
        recipeId: "ci-node-build-test-modernization",
        workspaceRoot: repo,
        sourcePolicy: "primary_plus_curated_secondary",
        riskGateMode: "strict_blockers",
        requireTddTests: true,
        curatedSourceDomains: [],
        additionalContext: {},
        waveStrategy: "big_bang",
      },
      mode: "dry-run",
      runsDir,
    });

    const secondExecPath = latestExecutionPath(path.join(runsDir, second.runId));
    const secondExec = JSON.parse(readFileSync(secondExecPath, "utf8"));
    secondExec.gateResults = [{ gateId: "gate-typecheck", required: true, passed: false, details: "fail" }];
    secondExec.blockerSummary = ["memory leak and performance regression detected"];
    writeFileSync(secondExecPath, `${JSON.stringify(secondExec, null, 2)}\n`, "utf8");

    const memory = deriveRecipeMemory({
      runsDir,
      recipeId: "ci-node-build-test-modernization",
    });

    expect(memory.analyzedRuns).toBeGreaterThanOrEqual(2);
    expect(memory.learnedGates.some((gate) => gate.id === "memory-gate-gate-typecheck")).toBe(true);
    expect(memory.learnedRiskProbes.some((probe) => probe.id === "memory-loop-risk-memory")).toBe(true);

    const merged = applyRecipeMemory({
      recipe: getRecipeById("ci-node-build-test-modernization"),
      memory,
    });
    expect(merged.gates.some((gate) => gate.id === "memory-gate-gate-typecheck")).toBe(true);
  });
});
