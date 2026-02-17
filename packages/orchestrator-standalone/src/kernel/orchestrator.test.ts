import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runOrchestrationCycle } from "./orchestrator.js";

function createTempRepo(): string {
  return mkdtempSync(path.join(os.tmpdir(), "orchestrator-standalone-test-"));
}

function writeJson(filePath: string, data: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

describe("runOrchestrationCycle", () => {
  const cleanupDirs: string[] = [];

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        return new Response(
          `<html><head><title>Doc for ${url}</title></head><body>Migration guide without breaking details.</body></html>`,
          { status: 200 },
        );
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of cleanupDirs.splice(0, cleanupDirs.length)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("blocks when strict blockers detect high-risk findings", async () => {
    const repo = createTempRepo();
    cleanupDirs.push(repo);

    writeJson(path.join(repo, "package.json"), {
      name: "sample",
      private: true,
      scripts: {
        "test:run": "node -e \"process.exit(0)\"",
        typecheck: "node -e \"process.exit(0)\"",
      },
    });

    mkdirSync(path.join(repo, "src"), { recursive: true });
    writeFileSync(path.join(repo, "src", "main.tsx"), "ReactDOM.render(App, root);\n", "utf8");
    writeFileSync(path.join(repo, "vitest.config.ts"), "export default {};\n", "utf8");

    const result = await runOrchestrationCycle({
      goal: {
        goalType: "dependency_upgrade",
        recipeId: "react18-to-react19",
        workspaceRoot: repo,
        sourcePolicy: "primary_plus_curated_secondary",
        riskGateMode: "strict_blockers",
        requireTddTests: true,
        curatedSourceDomains: [],
        additionalContext: {},
        waveStrategy: "big_bang",
      },
      mode: "dry-run",
      runsDir: path.join(repo, "generated", "runs"),
    });

    expect(result.validation.status).toBe("blocked");
    expect(result.execution.status).toBe("blocked");
    expect(
      result.validation.issues.some((issue) => issue.code === "RISK_HIGH_OPEN"),
    ).toBe(true);
  });

  it("completes one-wave dry-run when gates pass", async () => {
    const repo = createTempRepo();
    cleanupDirs.push(repo);

    writeJson(path.join(repo, "package.json"), {
      name: "ci-sample",
      private: true,
      scripts: {
        "test:run": "node -e \"process.exit(0)\"",
        typecheck: "node -e \"process.exit(0)\"",
        lint: "node -e \"process.exit(0)\"",
      },
      workspaces: ["packages/*"],
    });

    mkdirSync(path.join(repo, "packages", "app"), { recursive: true });
    writeJson(path.join(repo, "packages", "app", "package.json"), {
      name: "app",
      private: true,
    });

    writeFileSync(path.join(repo, "vitest.config.ts"), "export default {};\n", "utf8");
    mkdirSync(path.join(repo, ".github", "workflows"), { recursive: true });
    writeFileSync(path.join(repo, ".github", "workflows", "ci.yml"), "name: ci\n", "utf8");

    const result = await runOrchestrationCycle({
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
      runsDir: path.join(repo, "generated", "runs"),
    });

    expect(result.validation.status).toBe("passed");
    expect(result.execution.status).toBe("completed");
    expect(result.execution.done).toBe(true);
  });
});
