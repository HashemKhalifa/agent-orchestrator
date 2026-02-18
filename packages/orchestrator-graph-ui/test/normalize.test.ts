import { describe, expect, it } from "vitest";
import {
  normalizeRunState,
  type ArtifactInput,
  type ManifestInput,
  type RunSummaryInput,
} from "../server/normalize.js";

function artifactMap(items: ArtifactInput[]): Map<string, ArtifactInput> {
  return new Map(items.map((item) => [item.moduleId, item]));
}

describe("normalizeRunState", () => {
  it("marks all modules pending when no run summary or artifacts exist", () => {
    const manifest: ManifestInput = {
      modules: [
        { id: "01-objective", title: "Objective", level: 0, mode: "analyze", dependsOn: [] },
        { id: "02-plan", title: "Plan", level: 1, mode: "analyze", dependsOn: ["01-objective"] },
        { id: "03-apply", title: "Apply", level: 2, mode: "implement", dependsOn: ["02-plan"] },
      ],
    };

    const state = normalizeRunState({
      manifest,
      runSummary: null,
      artifacts: new Map(),
      runSummaryMtimeMs: 0,
    });

    expect(state.run.status).toBe("unknown");
    expect(state.run.cursorStep).toBe(1);
    expect(state.run.totalModules).toBe(3);
    expect(state.nodes.map((node) => node.status)).toEqual(["pending", "pending", "pending"]);
    expect(state.edges.map((edge) => edge.id)).toEqual(["01-objective->02-plan", "02-plan->03-apply"]);
  });

  it("prefers newer artifact data over run-summary result for each module", () => {
    const manifest: ManifestInput = {
      modules: [
        { id: "01-objective", title: "Objective", level: 0, mode: "analyze", dependsOn: [] },
        { id: "02-plan", title: "Plan", level: 1, mode: "implement", dependsOn: ["01-objective"] },
        { id: "03-verify", title: "Verify", level: 2, mode: "implement", dependsOn: ["02-plan"] },
      ],
    };

    const runSummary: RunSummaryInput = {
      status: "partial_failure",
      startedAt: "2026-02-18T20:00:00.000Z",
      completedAt: "2026-02-18T20:10:00.000Z",
      results: [
        { moduleId: "01-objective", status: "failed", attempt: 1, code: 1, durationMs: 4500 },
        { moduleId: "02-plan", status: "success", attempt: 1, code: 0, durationMs: 3200 },
        { moduleId: "03-verify", status: "blocked", attempt: 1, code: null, durationMs: 0 },
      ],
    };

    const artifacts = artifactMap([
      {
        moduleId: "01-objective",
        status: "success",
        attempt: 2,
        code: 0,
        durationMs: 2100,
        criticSeverity: "info",
        repairTaskPath: "generated/orchestration/autonomy/repair/01-objective.md",
        artifactPath: "generated/orchestration/dag/artifacts/01-objective.attempt-2.artifact.json",
        changedFilesCount: 3,
        riskNotesCount: 1,
        updatedAt: "2026-02-18T20:06:00.000Z",
        mtimeMs: 2_000,
      },
    ]);

    const state = normalizeRunState({
      manifest,
      runSummary,
      artifacts,
      runSummaryMtimeMs: 1_000,
    });

    const objective = state.nodes.find((node) => node.id === "01-objective");
    expect(objective?.status).toBe("success");
    expect(objective?.attempt).toBe(2);
    expect(objective?.changedFilesCount).toBe(3);
    expect(objective?.riskNotesCount).toBe(1);
    expect(objective?.artifactPath).toContain("01-objective.attempt-2.artifact.json");

    expect(state.run.status).toBe("partial_failure");
    expect(state.run.successCount).toBe(2);
    expect(state.run.blockedCount).toBe(1);
    expect(state.run.failedCount).toBe(0);
    expect(state.run.cursorStep).toBe(3);
  });

  it("infers success when all modules are successful without run summary status", () => {
    const manifest: ManifestInput = {
      modules: [
        { id: "01", title: "One", level: 0, mode: "analyze", dependsOn: [] },
        { id: "02", title: "Two", level: 1, mode: "implement", dependsOn: ["01"] },
      ],
    };

    const artifacts = artifactMap([
      { moduleId: "01", status: "success", attempt: 1, mtimeMs: 1_000 },
      { moduleId: "02", status: "success", attempt: 1, mtimeMs: 1_100 },
    ]);

    const state = normalizeRunState({
      manifest,
      runSummary: null,
      artifacts,
      runSummaryMtimeMs: 0,
    });

    expect(state.run.status).toBe("success");
    expect(state.run.cursorStep).toBe(2);
    expect(state.run.successCount).toBe(2);
    expect(state.run.failedCount).toBe(0);
    expect(state.run.blockedCount).toBe(0);
  });

  it("infers failure when only failed modules are present", () => {
    const manifest: ManifestInput = {
      modules: [{ id: "01", title: "One", level: 0, mode: "analyze", dependsOn: [] }],
    };

    const artifacts = artifactMap([{ moduleId: "01", status: "failed", attempt: 1, code: 124, mtimeMs: 1_000 }]);

    const state = normalizeRunState({
      manifest,
      runSummary: null,
      artifacts,
      runSummaryMtimeMs: 0,
    });

    expect(state.run.status).toBe("failure");
    expect(state.run.cursorStep).toBe(1);
    expect(state.run.failedCount).toBe(1);
  });
});
