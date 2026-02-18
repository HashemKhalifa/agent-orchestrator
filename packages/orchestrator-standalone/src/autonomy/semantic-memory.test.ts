import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readSemanticState, recordSemanticState, semanticFingerprint } from "./semantic-memory.js";

describe("semantic memory", () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const dir of cleanup.splice(0, cleanup.length)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists decisions, failures, and mitigations by fingerprint", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-semantic-memory-"));
    cleanup.push(root);

    const first = recordSemanticState({
      workspaceRoot: root,
      recipeId: "jest-to-vitest",
      runId: "run-1",
      policyPacks: ["security"],
      decisions: [
        {
          decision: "config",
          detail: "initial decision",
          metadata: { mode: "dry-run" },
        },
      ],
      failedAttempts: [
        {
          moduleId: "01-scope",
          reason: "gate failure",
          attempt: 1,
        },
      ],
      mitigations: [
        {
          moduleId: "01-scope",
          mitigation: "added teardown",
          accepted: true,
        },
      ],
    });

    const second = recordSemanticState({
      workspaceRoot: root,
      recipeId: "jest-to-vitest",
      runId: "run-2",
      policyPacks: ["security"],
      decisions: [
        {
          decision: "retry",
          detail: "follow-up repair",
          metadata: {},
        },
      ],
    });

    expect(first.fingerprint).toBe(second.fingerprint);
    expect(second.state.decisions.length).toBeGreaterThanOrEqual(2);
    expect(second.state.failedAttempts.length).toBeGreaterThanOrEqual(1);
    expect(second.state.mitigations.length).toBeGreaterThanOrEqual(1);

    const loaded = readSemanticState({
      workspaceRoot: root,
      recipeId: "jest-to-vitest",
      policyPacks: ["security"],
    });
    expect(loaded.state).not.toBeNull();
    expect(loaded.fingerprint).toBe(
      semanticFingerprint({ repoRoot: root, recipeId: "jest-to-vitest", policyPacks: ["security"] }),
    );
  });
});
