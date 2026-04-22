import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
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

  it("classifies query sections as analyze modules", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-core-dag-query-classify-"));
    cleanupPaths.push(root);

    writeFileSync(
      path.join(root, "request.md"),
      "# Req\n\n## Objective\nA\n\n## Query: validate legacy usage\nB\n\n## Delivery Requirements\nC\n",
      "utf8",
    );

    const manifest = await compileRequestDag({
      workspaceRoot: root,
      requestPath: "request.md",
      outputDir: "generated/orchestration/dag",
      dependencyMode: "staged",
    });

    const queryModule = manifest.modules.find((module) => module.title.toLowerCase().startsWith("query:"));
    expect(queryModule).toBeTruthy();
    expect(queryModule?.mode).toBe("analyze");
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

  it("soft-passes timed-out analyze modules in apply-mode dry-run", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-core-dag-analyze-timeout-"));
    cleanupPaths.push(root);

    writeFileSync(path.join(root, "request.md"), "# Req\n\n## Task\nDo it.\n", "utf8");
    mkdirSync(path.join(root, "generated", "orchestration", "dag"), { recursive: true });
    writeFileSync(path.join(root, "part-01.md"), "# part 01\n", "utf8");
    writeFileSync(path.join(root, "part-02.md"), "# part 02\n", "utf8");

    writeFileSync(
      path.join(root, "generated", "orchestration", "dag", "manifest.json"),
      JSON.stringify({
        schemaVersion: "1.0",
        name: "analyze-timeout-fallback",
        description: "validate dry-run analyze fallback",
        requestPath: "request.md",
        generatedAt: new Date().toISOString(),
        dependencyMode: "staged",
        modules: [
          {
            id: "01-analyze",
            title: "Analyze module",
            description: "Analyze and summarize",
            partPath: "part-01.md",
            mode: "analyze",
            level: 0,
            dependsOn: [],
            resources: [],
            command: `node -e "setTimeout(() => process.exit(0), 3000)"`,
          },
          {
            id: "02-implement",
            title: "Implement module",
            description: "Implement change",
            partPath: "part-02.md",
            mode: "implement",
            level: 1,
            dependsOn: ["01-analyze"],
            resources: [],
            command: `node -e "setTimeout(() => process.exit(0), 3000)"`,
          },
        ],
      }, null, 2),
      "utf8",
    );

    const summary = await runDag({
      workspaceRoot: root,
      manifestPath: "generated/orchestration/dag/manifest.json",
      applyMode: "dry-run",
      dryRun: false,
      runAnalyzeInDryRun: true,
      timeoutMs: 1000,
      maxRepairAttempts: 0,
    });

    const analyze = summary.results.find((result) => result.moduleId === "01-analyze");
    const implement = summary.results.find((result) => result.moduleId === "02-implement");

    expect(analyze?.status).toBe("success");
    expect(analyze?.stdout).toContain("analyze-timeout-fallback");
    expect(implement?.status).toBe("failed");
    expect(implement?.code).toBe(124);
  });

  it("caps analyze timeout budget to avoid long-running query stalls", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-core-dag-analyze-timeout-cap-"));
    cleanupPaths.push(root);

    writeFileSync(path.join(root, "request.md"), "# Req\n\n## Task\nDo it.\n", "utf8");
    mkdirSync(path.join(root, "generated", "orchestration", "dag"), { recursive: true });
    writeFileSync(path.join(root, "part-01.md"), "# part 01\n", "utf8");

    writeFileSync(
      path.join(root, "generated", "orchestration", "dag", "manifest.json"),
      JSON.stringify({
        schemaVersion: "1.0",
        name: "analyze-timeout-cap-check",
        description: "validate analyze timeout cap",
        requestPath: "request.md",
        generatedAt: new Date().toISOString(),
        dependencyMode: "staged",
        modules: [
          {
            id: "01-analyze",
            title: "Analyze module",
            description: "Analyze and summarize",
            partPath: "part-01.md",
            mode: "analyze",
            level: 0,
            dependsOn: [],
            resources: [],
            command: `node -e "setTimeout(() => process.exit(0), 3000)"`,
          },
        ],
      }, null, 2),
      "utf8",
    );

    const summary = await runDag({
      workspaceRoot: root,
      manifestPath: "generated/orchestration/dag/manifest.json",
      applyMode: "dry-run",
      dryRun: false,
      runAnalyzeInDryRun: true,
      timeoutMs: 60_000,
      analyzeTimeoutMs: 700,
      maxRepairAttempts: 0,
    });

    const analyze = summary.results.find((result) => result.moduleId === "01-analyze");
    expect(analyze?.status).toBe("success");
    expect(analyze?.stdout).toContain("analyze-timeout-fallback");
    expect((analyze?.durationMs ?? 0)).toBeLessThan(2500);
  });

  it("soft-passes timed-out gate-like implement modules in apply-mode dry-run", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-core-dag-gate-timeout-fallback-"));
    cleanupPaths.push(root);

    writeFileSync(path.join(root, "request.md"), "# Req\n\n## Task\nDo it.\n", "utf8");
    mkdirSync(path.join(root, "generated", "orchestration", "dag"), { recursive: true });
    writeFileSync(path.join(root, "part-01.md"), "# part 01\n", "utf8");

    writeFileSync(
      path.join(root, "generated", "orchestration", "dag", "manifest.json"),
      JSON.stringify({
        schemaVersion: "1.0",
        name: "gate-timeout-fallback-check",
        description: "validate gate timeout fallback in apply-mode dry-run",
        requestPath: "request.md",
        generatedAt: new Date().toISOString(),
        dependencyMode: "staged",
        modules: [
          {
            id: "01-gate-security-signoff",
            title: "Task 01: Gate security signoff",
            description: "Gate check",
            partPath: "part-01.md",
            mode: "implement",
            level: 0,
            dependsOn: [],
            resources: [],
            command: `node -e "setTimeout(() => process.exit(0), 3000)"`,
          },
        ],
      }, null, 2),
      "utf8",
    );

    const summary = await runDag({
      workspaceRoot: root,
      manifestPath: "generated/orchestration/dag/manifest.json",
      applyMode: "dry-run",
      dryRun: false,
      timeoutMs: 1000,
      maxRepairAttempts: 0,
      testImpactMode: "off",
      enableCritic: false,
    });

    expect(summary.results[0].status).toBe("success");
    expect(summary.results[0].stdout).toContain("implement-gate-timeout-fallback");
  });

  it("soft-passes timeout when provider already emitted MODULE_STATUS success", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-core-dag-module-status-timeout-"));
    cleanupPaths.push(root);

    writeFileSync(path.join(root, "request.md"), "# Req\n\n## Task\nDo it.\n", "utf8");
    mkdirSync(path.join(root, "generated", "orchestration", "dag"), { recursive: true });
    writeFileSync(path.join(root, "part-01.md"), "# part 01\n", "utf8");

    writeFileSync(
      path.join(root, "generated", "orchestration", "dag", "manifest.json"),
      JSON.stringify({
        schemaVersion: "1.0",
        name: "module-status-timeout-fallback-check",
        description: "timeout fallback when module status marker is present",
        requestPath: "request.md",
        generatedAt: new Date().toISOString(),
        dependencyMode: "staged",
        modules: [
          {
            id: "01-implement",
            title: "Task 01: Implement",
            description: "Implement change",
            partPath: "part-01.md",
            mode: "implement",
            level: 0,
            dependsOn: [],
            resources: [],
            command: `node -e "console.error('MODULE_STATUS: success'); setTimeout(() => process.exit(0), 3000)"`,
          },
        ],
      }, null, 2),
      "utf8",
    );

    const summary = await runDag({
      workspaceRoot: root,
      manifestPath: "generated/orchestration/dag/manifest.json",
      dryRun: false,
      timeoutMs: 1000,
      maxRepairAttempts: 0,
      enableCritic: false,
      testImpactMode: "off",
    });

    expect(summary.results[0].status).toBe("success");
    expect(summary.results[0].stdout).toContain("module-status-timeout-fallback");
  });

  it("soft-passes timeout when provider emits module_status=success marker", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-core-dag-module-status-kv-timeout-"));
    cleanupPaths.push(root);

    writeFileSync(path.join(root, "request.md"), "# Req\n\n## Task\nDo it.\n", "utf8");
    mkdirSync(path.join(root, "generated", "orchestration", "dag"), { recursive: true });
    writeFileSync(path.join(root, "part-01.md"), "# part 01\n", "utf8");

    writeFileSync(
      path.join(root, "generated", "orchestration", "dag", "manifest.json"),
      JSON.stringify({
        schemaVersion: "1.0",
        name: "module-status-kv-timeout-fallback-check",
        description: "timeout fallback when module_status key-value marker is present",
        requestPath: "request.md",
        generatedAt: new Date().toISOString(),
        dependencyMode: "staged",
        modules: [
          {
            id: "01-implement",
            title: "Task 01: Implement",
            description: "Implement change",
            partPath: "part-01.md",
            mode: "implement",
            level: 0,
            dependsOn: [],
            resources: [],
            command: `node -e "console.error('module_status=success'); setTimeout(() => process.exit(0), 3000)"`,
          },
        ],
      }, null, 2),
      "utf8",
    );

    const summary = await runDag({
      workspaceRoot: root,
      manifestPath: "generated/orchestration/dag/manifest.json",
      dryRun: false,
      timeoutMs: 1000,
      maxRepairAttempts: 0,
      enableCritic: false,
      testImpactMode: "off",
    });

    expect(summary.results[0].status).toBe("success");
    expect(summary.results[0].stdout).toContain("module-status-timeout-fallback");
  });

  it("ignores non-final module status markers buried in provider chatter", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-core-dag-module-status-nonfinal-"));
    cleanupPaths.push(root);

    writeFileSync(path.join(root, "request.md"), "# Req\n\n## Task\nDo it.\n", "utf8");
    mkdirSync(path.join(root, "generated", "orchestration", "dag"), { recursive: true });
    writeFileSync(path.join(root, "part-01.md"), "# part 01\n", "utf8");

    writeFileSync(
      path.join(root, "generated", "orchestration", "dag", "manifest.json"),
      JSON.stringify({
        schemaVersion: "1.0",
        name: "module-status-nonfinal-check",
        description: "ignore non-final module status chatter",
        requestPath: "request.md",
        generatedAt: new Date().toISOString(),
        dependencyMode: "staged",
        modules: [
          {
            id: "01-implement",
            title: "Task 01: Implement",
            description: "Implement change",
            partPath: "part-01.md",
            mode: "implement",
            level: 0,
            dependsOn: [],
            resources: [],
            command: `node -e "console.error('MODULE_STATUS: failed'); console.log('done'); process.exit(0)"`,
          },
        ],
      }, null, 2),
      "utf8",
    );

    const summary = await runDag({
      workspaceRoot: root,
      manifestPath: "generated/orchestration/dag/manifest.json",
      dryRun: false,
      timeoutMs: 1000,
      maxRepairAttempts: 0,
      enableCritic: false,
      testImpactMode: "off",
    });

    expect(summary.results[0].status).toBe("success");
    expect(summary.results[0].stderr).not.toContain("provider reported MODULE_STATUS: failed");
  });

  it("fails implement modules when provider output is non-actionable", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-core-dag-refusal-"));
    cleanupPaths.push(root);

    writeFileSync(path.join(root, "request.md"), "# Req\n\n## Task\nDo it.\n", "utf8");
    mkdirSync(path.join(root, "generated", "orchestration", "dag"), { recursive: true });
    writeFileSync(path.join(root, "part-01.md"), "# part 01\n", "utf8");

    writeFileSync(
      path.join(root, "generated", "orchestration", "dag", "manifest.json"),
      JSON.stringify({
        schemaVersion: "1.0",
        name: "provider-refusal-check",
        description: "detect non-actionable provider output",
        requestPath: "request.md",
        generatedAt: new Date().toISOString(),
        dependencyMode: "staged",
        modules: [
          {
            id: "01-implement",
            title: "Implement module",
            description: "Implement change",
            partPath: "part-01.md",
            mode: "implement",
            level: 0,
            dependsOn: [],
            resources: [],
            command: `node -e "console.log('What would you like to do next?')"`,
          },
        ],
      }, null, 2),
      "utf8",
    );

    const summary = await runDag({
      workspaceRoot: root,
      manifestPath: "generated/orchestration/dag/manifest.json",
      dryRun: false,
      maxRepairAttempts: 0,
    });

    expect(summary.results[0]?.status).toBe("failed");
    expect(summary.results[0]?.stderr).toContain("non-actionable provider response detected");
  });

  it("auto-passes analyze modules in apply-mode dry-run by default", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-core-dag-analyze-autopass-"));
    cleanupPaths.push(root);

    writeFileSync(path.join(root, "request.md"), "# Req\n\n## Task\nDo it.\n", "utf8");
    mkdirSync(path.join(root, "generated", "orchestration", "dag"), { recursive: true });
    writeFileSync(path.join(root, "part-01.md"), "# part 01\n", "utf8");
    writeFileSync(path.join(root, "part-02.md"), "# part 02\n", "utf8");

    writeFileSync(
      path.join(root, "generated", "orchestration", "dag", "manifest.json"),
      JSON.stringify({
        schemaVersion: "1.0",
        name: "analyze-autopass-check",
        description: "validate dry-run analyze autopass",
        requestPath: "request.md",
        generatedAt: new Date().toISOString(),
        dependencyMode: "staged",
        modules: [
          {
            id: "01-analyze",
            title: "Analyze module",
            description: "Analyze and summarize",
            partPath: "part-01.md",
            mode: "analyze",
            level: 0,
            dependsOn: [],
            resources: [],
            command: `node -e "setTimeout(() => process.exit(0), 3000)"`,
          },
          {
            id: "02-implement",
            title: "Implement module",
            description: "Implement change",
            partPath: "part-02.md",
            mode: "implement",
            level: 1,
            dependsOn: ["01-analyze"],
            resources: [],
            command: `node -e "setTimeout(() => process.exit(0), 3000)"`,
          },
        ],
      }, null, 2),
      "utf8",
    );

    const summary = await runDag({
      workspaceRoot: root,
      manifestPath: "generated/orchestration/dag/manifest.json",
      applyMode: "dry-run",
      dryRun: false,
      timeoutMs: 1000,
      maxRepairAttempts: 0,
    });

    const analyze = summary.results.find((result) => result.moduleId === "01-analyze");
    const implement = summary.results.find((result) => result.moduleId === "02-implement");
    expect(analyze?.status).toBe("success");
    expect(analyze?.durationMs).toBe(0);
    expect(analyze?.stdout).toContain("analyze auto-pass in apply-mode dry-run");
    expect(implement?.status).toBe("failed");
    expect(implement?.code).toBe(124);
  });

  it("classifies planning sections as analyze mode", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-core-dag-classify-planning-"));
    cleanupPaths.push(root);

    writeFileSync(
      path.join(root, "request.md"),
      [
        "# Req",
        "",
        "## Objective",
        "Goal",
        "",
        "## Workspace Snapshot",
        "Capture baseline",
        "",
        "## Discovery Evidence",
        "Record evidence",
        "",
        "## RAG Evidence (Repo + Docs)",
        "Collect retrievals",
        "",
        "## Auto-Refine Retrieval",
        "Refine queries",
        "",
        "## Iteration 1",
        "Analyze pass",
        "",
        "## Refined Top Hits",
        "Summaries",
        "",
        "## Implementation Scope",
        "Scope downstream work",
        "",
        "## Task 01: Apply migration",
        "Implement migration",
      ].join("\n"),
      "utf8",
    );

    const manifest = await compileRequestDag({
      workspaceRoot: root,
      requestPath: "request.md",
      outputDir: "generated/orchestration/dag",
      dependencyMode: "staged",
    });

    const byId = new Map(manifest.modules.map((module) => [module.id, module]));
    expect(byId.get("01-objective")?.mode).toBe("analyze");
    expect(byId.get("02-workspace-snapshot")?.mode).toBe("analyze");
    expect(byId.get("03-discovery-evidence")?.mode).toBe("analyze");
    expect(byId.get("04-rag-evidence-repo-docs")?.mode).toBe("analyze");
    expect(byId.get("05-auto-refine-retrieval")?.mode).toBe("analyze");
    expect(byId.get("06-iteration-1")?.mode).toBe("analyze");
    expect(byId.get("07-refined-top-hits")?.mode).toBe("analyze");
    expect(byId.get("08-implementation-scope")?.mode).toBe("analyze");
    expect(byId.get("09-task-01-apply-migration")?.mode).toBe("implement");
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

  it("reuses successful modules from prior artifacts when inputs are unchanged", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-core-dag-resume-success-"));
    cleanupPaths.push(root);

    writeFileSync(path.join(root, "request.md"), "# Req\n\n## Task\nImplement.\n", "utf8");
    await compileRequestDag({
      workspaceRoot: root,
      requestPath: "request.md",
      outputDir: "generated/orchestration/dag",
      dependencyMode: "staged",
    });

    const command = "node -e \"const fs=require('node:fs');const p='run-count.txt';const n=fs.existsSync(p)?Number(fs.readFileSync(p,'utf8')):0;fs.writeFileSync(p,String(n+1));\"";

    const first = await runDag({
      workspaceRoot: root,
      manifestPath: "generated/orchestration/dag/manifest.json",
      executorTemplate: command,
      dryRun: false,
      enableCritic: false,
      resumeSuccessModules: true,
    });
    expect(first.results[0].status).toBe("success");
    expect(readFileSync(path.join(root, "run-count.txt"), "utf8")).toBe("1");

    const second = await runDag({
      workspaceRoot: root,
      manifestPath: "generated/orchestration/dag/manifest.json",
      executorTemplate: command,
      dryRun: false,
      enableCritic: false,
      resumeSuccessModules: true,
    });

    expect(second.status).toBe("success");
    expect(second.resumedModules).toBeGreaterThan(0);
    expect(second.results[0].resumedFromArtifact).toBe(true);
    expect(readFileSync(path.join(root, "run-count.txt"), "utf8")).toBe("1");
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

  it("escalates timeout budget for retries after timeout failures", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-core-dag-timeout-escalation-"));
    cleanupPaths.push(root);

    writeFileSync(path.join(root, "request.md"), "# Req\n\n## Task\nTimeout test.\n", "utf8");
    mkdirSync(path.join(root, "generated", "orchestration", "dag"), { recursive: true });
    writeFileSync(path.join(root, "part-01.md"), "# part 01\n", "utf8");

    writeFileSync(
      path.join(root, "generated", "orchestration", "dag", "manifest.json"),
      JSON.stringify({
        schemaVersion: "1.0",
        name: "timeout-escalation-check",
        description: "validate retry timeout backoff",
        requestPath: "request.md",
        generatedAt: new Date().toISOString(),
        dependencyMode: "staged",
        modules: [
          {
            id: "01-timeout-module",
            title: "Timeout module",
            description: "Should timeout once then pass with expanded retry budget",
            partPath: "part-01.md",
            mode: "implement",
            level: 0,
            dependsOn: [],
            resources: [],
            command: "node -e \"setTimeout(()=>process.exit(0), 1500)\"",
          },
        ],
      }, null, 2),
      "utf8",
    );

    const summary = await runDag({
      workspaceRoot: root,
      manifestPath: "generated/orchestration/dag/manifest.json",
      executorProfile: "none",
      dryRun: false,
      timeoutMs: 1000,
      enableRepairLoop: true,
      maxRepairAttempts: 1,
    });

    expect(summary.results[0]?.status).toBe("success");
    expect(summary.results[0]?.attempt).toBe(2);
  });

  it("adds memory-revisit evidence to repair tasks and final module summary", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-core-dag-memory-revisit-"));
    cleanupPaths.push(root);

    writeFileSync(path.join(root, "request.md"), "# Req\n\n## Task\nRepair target.\n", "utf8");
    await compileRequestDag({
      workspaceRoot: root,
      requestPath: "request.md",
      outputDir: "generated/orchestration/dag",
      dependencyMode: "staged",
    });

    const semanticPath = path.join(root, "generated", "orchestration", "autonomy", "memory", "seed.json");
    mkdirSync(path.dirname(semanticPath), { recursive: true });
    writeFileSync(
      semanticPath,
      JSON.stringify({
        schemaVersion: "1.0",
        fingerprint: "seed",
        repoRoot: root,
        recipeId: "memory-revisit-test",
        updatedAt: new Date().toISOString(),
        decisions: [
          {
            timestamp: new Date().toISOString(),
            runId: "seed-run",
            decision: "repair-focus",
            detail: "Prior repair succeeded after fixing failing gate and rerunning impacted tests.",
            metadata: {},
          },
        ],
        failedAttempts: [
          {
            timestamp: new Date().toISOString(),
            runId: "seed-run",
            moduleId: "01-task",
            reason: "failing gate: missing scaffold contract assertion",
            attempt: 1,
          },
        ],
        mitigations: [
          {
            timestamp: new Date().toISOString(),
            runId: "seed-run",
            moduleId: "01-task",
            mitigation: "Limit scope to failing gate and keep tests targeted.",
            accepted: true,
          },
        ],
      }),
      "utf8",
    );

    const summary = await runDag({
      workspaceRoot: root,
      manifestPath: "generated/orchestration/dag/manifest.json",
      executorTemplate: "if [ -f .repair-ok ]; then node -e \"require('node:fs').writeFileSync('fixed.txt','ok')\"; else touch .repair-ok; echo 'failing gate' 1>&2; exit 1; fi",
      enableRepairLoop: true,
      maxRepairAttempts: 1,
      memoryRevisitEnabled: true,
      memoryRevisitRecipeId: "memory-revisit-test",
      memoryRevisitSemanticMemoryPath: "generated/orchestration/autonomy/memory/seed.json",
      memoryRevisitTopK: 2,
      dryRun: false,
    });

    const first = summary.results[0];
    expect(first.status).toBe("success");
    expect(summary.memoryRevisit?.enabled).toBe(true);
    expect(summary.memoryRevisit?.hitsUsed).toBeGreaterThan(0);
    expect(first.memoryRevisit.length).toBeGreaterThan(0);
    expect(first.repairTaskPath).toBeTruthy();

    const repairAbs = path.resolve(root, first.repairTaskPath as string);
    const repairText = readFileSync(repairAbs, "utf8");
    expect(repairText).toContain("## Recalled Evidence");
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

  it("skips test impact for analyze modules", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-core-dag-impact-analyze-"));
    cleanupPaths.push(root);

    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "impact-root",
        private: true,
        scripts: {
          "test:run": "node -e \"process.exit(1)\"",
        },
      }),
      "utf8",
    );
    mkdirSync(path.join(root, "generated", "orchestration", "dag"), { recursive: true });
    writeFileSync(path.join(root, "request.md"), "# Req", "utf8");
    writeFileSync(path.join(root, "part.md"), "# Analyze\n", "utf8");
    writeFileSync(
      path.join(root, "generated", "orchestration", "dag", "manifest.json"),
      JSON.stringify({
        schemaVersion: "1.0",
        name: "analyze-impact-skip",
        description: "skip test impact for analyze modules",
        requestPath: "request.md",
        generatedAt: new Date().toISOString(),
        dependencyMode: "staged",
        modules: [
          {
            id: "01-analyze",
            title: "Analyze only",
            description: "Analyze only",
            partPath: "part.md",
            mode: "analyze",
            level: 0,
            dependsOn: [],
            resources: [],
            command: "node -e \"require('node:fs').writeFileSync('analysis.txt','ok\\n')\"",
          },
        ],
      }, null, 2),
      "utf8",
    );

    const summary = await runDag({
      workspaceRoot: root,
      manifestPath: "generated/orchestration/dag/manifest.json",
      dryRun: false,
      testImpactMode: "targeted",
      enableCritic: false,
    });

    expect(summary.results[0].status).toBe("success");
    expect(summary.results[0].testImpactCommands).toEqual([]);
  });

  it("runs full-suite gate at checkpoint modules only", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-core-dag-impact-checkpoint-"));
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
    mkdirSync(path.join(root, "generated", "orchestration", "dag"), { recursive: true });
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(path.join(root, "src", "index.ts"), "export const value = 1;\n", "utf8");
    writeFileSync(path.join(root, "request.md"), "# Req", "utf8");
    writeFileSync(path.join(root, "part-1.md"), "# Task\n", "utf8");
    writeFileSync(path.join(root, "part-2.md"), "# Gate\n", "utf8");
    writeFileSync(
      path.join(root, "generated", "orchestration", "dag", "manifest.json"),
      JSON.stringify({
        schemaVersion: "1.0",
        name: "impact-full-suite-checkpoint",
        description: "full suite should run at gate-like checkpoint",
        requestPath: "request.md",
        generatedAt: new Date().toISOString(),
        dependencyMode: "sequential",
        modules: [
          {
            id: "01-task",
            title: "Task update",
            description: "update source",
            partPath: "part-1.md",
            mode: "implement",
            level: 0,
            dependsOn: [],
            resources: [],
            command: "node -e \"require('node:fs').writeFileSync('src/index.ts','export const value = 2;\\n')\"",
          },
          {
            id: "02-gate-validate",
            title: "Gate validate",
            description: "final validation gate",
            partPath: "part-2.md",
            mode: "implement",
            level: 1,
            dependsOn: ["01-task"],
            resources: [],
            command: "echo gate",
          },
        ],
      }, null, 2),
      "utf8",
    );

    const summary = await runDag({
      workspaceRoot: root,
      manifestPath: "generated/orchestration/dag/manifest.json",
      dryRun: false,
      testImpactMode: "targeted_then_full",
      fullTestCommand: "node -e \"process.exit(0)\"",
      fullTestInDryRun: true,
      enableCritic: false,
    });

    expect(summary.results[0].status).toBe("success");
    expect(summary.results[1].status).toBe("success");
    expect(summary.results[0].testImpactCommands).not.toContain("node -e \"process.exit(0)\"");
    expect(summary.results[1].testImpactCommands).toContain("node -e \"process.exit(0)\"");
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

  it("respects gitignored paths when workspace root is below git top-level", async () => {
    const repoRoot = mkdtempSync(path.join(os.tmpdir(), "orchestrator-core-dag-gitignore-"));
    const workspaceRoot = path.join(repoRoot, "packages", "app");
    cleanupPaths.push(repoRoot);

    try {
      execFileSync("git", ["--version"], { stdio: "ignore" });
    } catch {
      return;
    }

    mkdirSync(path.join(workspaceRoot, "generated", "orchestration", "dag"), { recursive: true });
    writeFileSync(path.join(workspaceRoot, "request.md"), "# Req", "utf8");
    writeFileSync(path.join(repoRoot, ".gitignore"), "packages/app/.custom-cache/\n", "utf8");
    execFileSync("git", ["-C", repoRoot, "init", "-q"], { stdio: "ignore" });

    const manifestPath = path.join(workspaceRoot, "generated", "orchestration", "dag", "manifest.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: "1.0",
        name: "gitignore-snapshot-test",
        description: "gitignore snapshot test",
        requestPath: "request.md",
        generatedAt: new Date().toISOString(),
        dependencyMode: "staged",
        modules: [
          {
            id: "01-analyze",
            title: "Analyze cache noise",
            description: "Write ignored file only",
            partPath: "request.md",
            mode: "analyze",
            level: 0,
            dependsOn: [],
            resources: [],
            command: "mkdir -p .custom-cache && echo ignored > .custom-cache/out.txt",
          },
        ],
      }, null, 2),
      "utf8",
    );

    const summary = await runDag({
      workspaceRoot,
      manifestPath: "generated/orchestration/dag/manifest.json",
      applyMode: "dry-run",
      runAnalyzeInDryRun: true,
      dryRun: false,
      timeoutMs: 30_000,
      enableCritic: false,
      testImpactMode: "off",
    });

    expect(summary.results[0]?.status).toBe("success");
    expect(summary.results[0]?.changedFiles.length).toBe(0);
  });
});
