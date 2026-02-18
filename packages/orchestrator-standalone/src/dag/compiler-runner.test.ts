import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileRequestDag } from "./compiler.js";
import { runDag } from "./runner.js";

describe("request DAG compile/run", () => {
  const cleanupPaths: string[] = [];

  afterEach(() => {
    for (const p of cleanupPaths.splice(0, cleanupPaths.length)) {
      rmSync(p, { recursive: true, force: true });
    }
  });

  it("compiles request into manifest and runs dry-run executor", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-core-dag-"));
    cleanupPaths.push(root);

    const requestPath = path.join(root, "request.md");
    writeFileSync(
      requestPath,
      `# Migration\n\n## Objective\nDo things.\n\n## Wave 1\nImplement phase one.\n\n## Delivery Requirements\nValidate outputs.\n`,
      "utf8",
    );

    const manifest = await compileRequestDag({
      workspaceRoot: root,
      requestPath: "request.md",
      outputDir: "generated/orchestration/dag",
      dependencyMode: "staged",
    });

    expect(manifest.modules.length).toBeGreaterThanOrEqual(1);
    expect(existsSync(path.join(root, "generated", "orchestration", "dag", "manifest.json"))).toBe(true);

    const summary = await runDag({
      workspaceRoot: root,
      manifestPath: "generated/orchestration/dag/manifest.json",
      executorTemplate: "echo processing {partFile}",
      dryRun: true,
      outputPath: "generated/orchestration/dag/run-summary.json",
    });

    expect(summary.results.length).toBe(manifest.modules.length);
    expect(summary.status).toBe("success");
    expect(existsSync(path.join(root, "generated", "orchestration", "dag", "run-summary.json"))).toBe(true);
  });

  it("blocks apply mode when guard token is missing", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-core-dag-guard-"));
    cleanupPaths.push(root);

    const requestPath = path.join(root, "request.md");
    writeFileSync(
      requestPath,
      `# Request\n\n## Scope\nSmall scope.\n\n## Task\nDo one thing.\n`,
      "utf8",
    );

    await compileRequestDag({
      workspaceRoot: root,
      requestPath: "request.md",
      outputDir: "generated/orchestration/dag",
      dependencyMode: "staged",
    });

    await expect(
      runDag({
        workspaceRoot: root,
        manifestPath: "generated/orchestration/dag/manifest.json",
        executorProfile: "codex-safe",
        applyMode: "apply",
      }),
    ).rejects.toThrow(/Apply mode blocked/);
  });

  it("supports claude-safe executor profile", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-core-dag-claude-"));
    cleanupPaths.push(root);

    writeFileSync(path.join(root, "request.md"), "# Req\n\n## Task\nDo it.\n", "utf8");

    await compileRequestDag({
      workspaceRoot: root,
      requestPath: "request.md",
      outputDir: "generated/orchestration/dag",
      dependencyMode: "staged",
    });

    const summary = await runDag({
      workspaceRoot: root,
      manifestPath: "generated/orchestration/dag/manifest.json",
      executorProfile: "claude-safe",
      dryRun: true,
    });

    expect(summary.results.length).toBeGreaterThan(0);
    expect(summary.results[0].command).toContain("claude -p");
  });

  it("blocks apply when wave approval is missing", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-core-dag-approval-"));
    cleanupPaths.push(root);

    writeFileSync(path.join(root, "request.md"), "# Req\n\n## Task\nDo it.\n", "utf8");
    await compileRequestDag({
      workspaceRoot: root,
      requestPath: "request.md",
      outputDir: "generated/orchestration/dag",
      dependencyMode: "staged",
    });

    writeFileSync(path.join(root, "evidence.md"), "evidence", "utf8");

    const summary = await runDag({
      workspaceRoot: root,
      manifestPath: "generated/orchestration/dag/manifest.json",
      executorTemplate: "echo ok",
      applyMode: "apply",
      applyGuardToken: "ALLOW_APPLY",
      evidenceFilePath: "evidence.md",
      dryRun: false,
    });

    expect(summary.status).toBe("partial_failure");
    expect(summary.results.every((result) => result.status === "blocked")).toBe(true);
    expect(summary.results[0].stderr).toContain("wave approval missing");
  });

  it("blocks apply when evidence file is missing", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-core-dag-evidence-"));
    cleanupPaths.push(root);

    writeFileSync(path.join(root, "request.md"), "# Req\n\n## Task\nDo it.\n", "utf8");
    await compileRequestDag({
      workspaceRoot: root,
      requestPath: "request.md",
      outputDir: "generated/orchestration/dag",
      dependencyMode: "staged",
    });

    await expect(
      runDag({
        workspaceRoot: root,
        manifestPath: "generated/orchestration/dag/manifest.json",
        executorTemplate: "echo ok",
        applyMode: "apply",
        applyGuardToken: "ALLOW_APPLY",
      }),
    ).rejects.toThrow(/missing evidence file/i);
  });

  it("writes artifact contract and runs critic pass per module", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-core-dag-critic-"));
    cleanupPaths.push(root);

    writeFileSync(path.join(root, "request.md"), "# Req\n\n## Task\nImplement.\n", "utf8");
    await compileRequestDag({
      workspaceRoot: root,
      requestPath: "request.md",
      outputDir: "generated/orchestration/dag",
      dependencyMode: "staged",
    });

    const summary = await runDag({
      workspaceRoot: root,
      manifestPath: "generated/orchestration/dag/manifest.json",
      executorTemplate: `node -e "require('node:fs').writeFileSync('changed.txt','ok')"`,
      enableCritic: true,
      dryRun: false,
    });

    const first = summary.results[0];
    expect(first.status).toBe("success");
    expect(first.artifactPath).toBeTruthy();
    const artifactAbs = path.resolve(root, first.artifactPath as string);
    expect(existsSync(artifactAbs)).toBe(true);

    const artifact = JSON.parse(readFileSync(artifactAbs, "utf8"));
    expect(Array.isArray(artifact.changedFiles)).toBe(true);
    expect(artifact.critic).toBeTruthy();
  });

  it("enforces critic severity threshold with policy-pack findings", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-core-dag-critic-tier-"));
    cleanupPaths.push(root);

    writeFileSync(path.join(root, "request.md"), "# Req\n\n## Task\nTouch infra config.\n", "utf8");
    await compileRequestDag({
      workspaceRoot: root,
      requestPath: "request.md",
      outputDir: "generated/orchestration/dag",
      dependencyMode: "staged",
    });

    const summary = await runDag({
      workspaceRoot: root,
      manifestPath: "generated/orchestration/dag/manifest.json",
      executorTemplate: "node -e \"const fs=require('node:fs');fs.mkdirSync('.github/workflows',{recursive:true});fs.writeFileSync('.github/workflows/ci.yml','name: ci\\n');\"",
      enableCritic: true,
      criticFailLevel: "warning",
      policyPacks: ["infra"],
      dryRun: false,
    });

    expect(summary.results[0].status).toBe("failed");
    expect(summary.results[0].criticSeverity).toBe("warning");
    expect(summary.results[0].criticFindings.some((finding) => finding.source === "policy:infra")).toBe(true);
  });

  it("parses policy-pack-specific critic findings from org config templates", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-core-dag-policy-critic-config-"));
    cleanupPaths.push(root);

    writeFileSync(path.join(root, "request.md"), "# Req\n\n## Task\nSecurity-sensitive module.\n", "utf8");
    await compileRequestDag({
      workspaceRoot: root,
      requestPath: "request.md",
      outputDir: "generated/orchestration/dag",
      dependencyMode: "staged",
    });

    mkdirSync(path.join(root, ".orchestrator"), { recursive: true });
    writeFileSync(
      path.join(root, ".orchestrator", "policy-critic.json"),
      JSON.stringify({
        schemaVersion: "1.0",
        packs: {
          security: {
            templateMode: "replace",
            template: "CRITIC SECURITY TEMPLATE: module={moduleId}",
            parsers: [
              {
                severity: "blocker",
                regex: "CRITIC SECURITY TEMPLATE",
                flags: "gi",
                messageTemplate: "Policy parser matched: {match}",
              },
            ],
          },
        },
      }),
      "utf8",
    );

    const summary = await runDag({
      workspaceRoot: root,
      manifestPath: "generated/orchestration/dag/manifest.json",
      executorTemplate: "node -e \"require('node:fs').writeFileSync('security.ts','ok')\"",
      enableCritic: true,
      criticFailLevel: "warning",
      criticCommandTemplate: "printf '%s\\n' \"{policyCriticPrompts}\"",
      policyPacks: ["security"],
      policyCriticConfigPath: ".orchestrator/policy-critic.json",
      dryRun: false,
    });

    expect(summary.results[0].status).toBe("failed");
    expect(summary.results[0].criticFindings.some((finding) => finding.source === "policy:security:parser")).toBe(true);
  });

  it("supports policy parser capture-group macros including {groupN+}", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-core-dag-policy-critic-groups-"));
    cleanupPaths.push(root);

    writeFileSync(path.join(root, "request.md"), "# Req\n\n## Task\nCustom parser groups.\n", "utf8");
    await compileRequestDag({
      workspaceRoot: root,
      requestPath: "request.md",
      outputDir: "generated/orchestration/dag",
      dependencyMode: "staged",
    });

    mkdirSync(path.join(root, ".orchestrator"), { recursive: true });
    writeFileSync(
      path.join(root, ".orchestrator", "policy-critic.json"),
      JSON.stringify({
        schemaVersion: "1.0",
        packs: {
          custom: {
            parsers: [
              {
                severity: "warning",
                regex: "(alpha)-(beta)-(gamma)-(delta)-(epsilon)",
                flags: "gi",
                messageTemplate: "groups:{group1}|{group3}|{group4+}|{group5}|{group9}|{match}",
              },
            ],
          },
        },
      }),
      "utf8",
    );

    const summary = await runDag({
      workspaceRoot: root,
      manifestPath: "generated/orchestration/dag/manifest.json",
      executorTemplate: "node -e \"require('node:fs').writeFileSync('custom.txt','ok')\"",
      enableCritic: true,
      criticFailLevel: "warning",
      criticCommandTemplate: "printf '%s\\n' \"alpha-beta-gamma-delta-epsilon\"",
      policyPacks: ["custom"],
      policyCriticConfigPath: ".orchestrator/policy-critic.json",
      dryRun: false,
    });

    expect(summary.results[0].status).toBe("failed");
    const parserFinding = summary.results[0].criticFindings.find((finding) => finding.source === "policy:custom:parser");
    expect(parserFinding?.message).toBe("groups:alpha|gamma|delta epsilon|epsilon||alpha-beta-gamma-delta-epsilon");
  });

  it("uses focused repair loop for failing module without rerunning full graph", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-core-dag-repair-"));
    cleanupPaths.push(root);

    writeFileSync(path.join(root, "request.md"), "# Req\n\n## Task\nRepair target.\n", "utf8");
    await compileRequestDag({
      workspaceRoot: root,
      requestPath: "request.md",
      outputDir: "generated/orchestration/dag",
      dependencyMode: "staged",
    });

    const summary = await runDag({
      workspaceRoot: root,
      manifestPath: "generated/orchestration/dag/manifest.json",
      executorTemplate: "if [ -f .repair-ok ]; then node -e \"require('node:fs').writeFileSync('fixed.txt','ok')\"; else touch .repair-ok; exit 1; fi",
      enableRepairLoop: true,
      maxRepairAttempts: 1,
      dryRun: false,
    });

    expect(summary.repairsGenerated).toBeGreaterThan(0);
    expect(summary.results[0].status).toBe("success");
    expect(summary.results[0].attempt).toBe(2);
    expect(summary.results[0].repairTaskPath).toBeTruthy();
  });

  it("enforces strict attempt budget and blocks remaining modules", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-core-dag-budget-"));
    cleanupPaths.push(root);

    writeFileSync(
      path.join(root, "request.md"),
      "# Req\n\n## Objective\nDo objective.\n\n## Task 1\nA\n\n## Task 2\nB\n",
      "utf8",
    );

    await compileRequestDag({
      workspaceRoot: root,
      requestPath: "request.md",
      outputDir: "generated/orchestration/dag",
      dependencyMode: "sequential",
    });

    const summary = await runDag({
      workspaceRoot: root,
      manifestPath: "generated/orchestration/dag/manifest.json",
      executorTemplate: "echo module",
      dryRun: true,
      maxTotalAttempts: 1,
    });

    expect(summary.status).toBe("partial_failure");
    expect(summary.budget?.exhausted).toBe(true);
    expect(summary.results.some((result) => result.status === "blocked")).toBe(true);
  });

  it("uses observed provider token usage for budget enforcement", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-core-dag-token-accounting-"));
    cleanupPaths.push(root);

    writeFileSync(
      path.join(root, "request.md"),
      "# Req\n\n## Objective\nDo objective.\n\n## Task 1\nA\n\n## Task 2\nB\n",
      "utf8",
    );
    await compileRequestDag({
      workspaceRoot: root,
      requestPath: "request.md",
      outputDir: "generated/orchestration/dag",
      dependencyMode: "sequential",
    });

    const summary = await runDag({
      workspaceRoot: root,
      manifestPath: "generated/orchestration/dag/manifest.json",
      executorTemplate: "node -e \"console.log(JSON.stringify({usage:{total_tokens:42,prompt_tokens:30,completion_tokens:12}}))\"",
      dryRun: false,
      maxTotalTokens: 40,
      enableCritic: false,
    });

    expect(summary.budget?.exhausted).toBe(true);
    expect(summary.budget?.totalTokensObserved).toBeGreaterThan(0);
    expect(summary.budget?.observedTraceCount).toBeGreaterThan(0);
    expect(summary.budget?.tokenAccountingMode).toBe("observed_or_estimated");
    expect(summary.results.some((result) => result.status === "blocked")).toBe(true);
  });

  it("runs targeted test impact command for changed package", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-core-dag-impact-"));
    cleanupPaths.push(root);

    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "impact-root",
        private: true,
        scripts: {
          "test:run": "node -e \"process.exit(0)\"",
        },
      }),
      "utf8",
    );
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(path.join(root, "src", "index.ts"), "export const x = 1;\n", "utf8");
    writeFileSync(path.join(root, "request.md"), "# Req\n\n## Task\nChange src file.\n", "utf8");

    await compileRequestDag({
      workspaceRoot: root,
      requestPath: "request.md",
      outputDir: "generated/orchestration/dag",
      dependencyMode: "staged",
    });

    const summary = await runDag({
      workspaceRoot: root,
      manifestPath: "generated/orchestration/dag/manifest.json",
      executorTemplate: `node -e "require('node:fs').writeFileSync('src/index.ts','export const x = 2;\\n')"`,
      dryRun: false,
      testImpactMode: "targeted",
    });

    expect(summary.results[0].status).toBe("success");
    expect(summary.results[0].testImpactCommands.some((command) => command.includes("test:run"))).toBe(true);
  });

  it("supports canary checkpoint compare before full rollout", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-core-dag-canary-"));
    cleanupPaths.push(root);

    writeFileSync(
      path.join(root, "request.md"),
      "# Req\n\n## Objective\nGoal.\n\n## Task A\nA\n\n## Task B\nB\n",
      "utf8",
    );
    await compileRequestDag({
      workspaceRoot: root,
      requestPath: "request.md",
      outputDir: "generated/orchestration/dag",
      dependencyMode: "sequential",
    });

    const summary = await runDag({
      workspaceRoot: root,
      manifestPath: "generated/orchestration/dag/manifest.json",
      executorTemplate: "echo ok",
      dryRun: true,
      canaryLimitModules: 1,
      canaryCompareCommand: "node -e \"process.exit(1)\"",
    });

    expect(summary.canary?.enabled).toBe(true);
    expect(summary.canary?.checkpointPassed).toBe(false);
    expect(summary.results.some((result) => result.status === "blocked")).toBe(true);
  });

  it("runs independent same-level modules in parallel when max-parallel > 1", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-core-dag-parallel-"));
    cleanupPaths.push(root);

    mkdirSync(path.join(root, "generated", "orchestration", "dag"), { recursive: true });
    writeFileSync(path.join(root, "request.md"), "# Req", "utf8");
    const manifestPath = path.join(root, "generated", "orchestration", "dag", "manifest.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: "1.0",
        name: "parallel-test",
        description: "parallel level test",
        requestPath: "request.md",
        generatedAt: new Date().toISOString(),
        dependencyMode: "parallel",
        modules: [
          {
            id: "01-a",
            title: "A",
            description: "A",
            partPath: "request.md",
            mode: "implement",
            level: 0,
            dependsOn: [],
            resources: [],
            command: "node -e \"setTimeout(()=>process.exit(0), 500)\"",
          },
          {
            id: "02-b",
            title: "B",
            description: "B",
            partPath: "request.md",
            mode: "implement",
            level: 0,
            dependsOn: [],
            resources: [],
            command: "node -e \"setTimeout(()=>process.exit(0), 500)\"",
          },
        ],
      }, null, 2),
      "utf8",
    );

    const startedAt = Date.now();
    const summary = await runDag({
      workspaceRoot: root,
      manifestPath: "generated/orchestration/dag/manifest.json",
      timeoutMs: 30_000,
      dryRun: false,
      maxParallel: 2,
      enableCritic: false,
      testImpactMode: "off",
    });
    const elapsedMs = Date.now() - startedAt;

    expect(summary.status).toBe("success");
    expect(summary.results.filter((result) => result.status === "success").length).toBe(2);
    expect(elapsedMs).toBeLessThan(900);
  });

  it("serializes modules that share a resource lock even with max-parallel > 1", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-core-dag-resource-lock-"));
    cleanupPaths.push(root);

    mkdirSync(path.join(root, "generated", "orchestration", "dag"), { recursive: true });
    writeFileSync(path.join(root, "request.md"), "# Req", "utf8");
    const manifestPath = path.join(root, "generated", "orchestration", "dag", "manifest.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: "1.0",
        name: "resource-lock-test",
        description: "resource lock test",
        requestPath: "request.md",
        generatedAt: new Date().toISOString(),
        dependencyMode: "parallel",
        modules: [
          {
            id: "01-a",
            title: "A",
            description: "A",
            partPath: "request.md",
            mode: "implement",
            level: 0,
            dependsOn: [],
            resources: ["repo-main"],
            command: "node -e \"setTimeout(()=>process.exit(0), 500)\"",
          },
          {
            id: "02-b",
            title: "B",
            description: "B",
            partPath: "request.md",
            mode: "implement",
            level: 0,
            dependsOn: [],
            resources: ["repo-main"],
            command: "node -e \"setTimeout(()=>process.exit(0), 500)\"",
          },
        ],
      }, null, 2),
      "utf8",
    );

    const startedAt = Date.now();
    const summary = await runDag({
      workspaceRoot: root,
      manifestPath: "generated/orchestration/dag/manifest.json",
      timeoutMs: 30_000,
      dryRun: false,
      maxParallel: 4,
      enableCritic: false,
      testImpactMode: "off",
    });
    const elapsedMs = Date.now() - startedAt;

    expect(summary.status).toBe("success");
    expect(summary.results.filter((result) => result.status === "success").length).toBe(2);
    expect(elapsedMs).toBeGreaterThan(900);
  });
});
