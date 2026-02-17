import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverWorkspaceFacts } from "../adapters/workspace-discovery.js";
import { synthesizeTaskRequest } from "../autonomy/task-synthesizer.js";
import { compileRequestDag } from "../dag/compiler.js";
import { runDag } from "../dag/runner.js";
import { buildRagIndex } from "../rag/indexer.js";
import { queryRagIndex } from "../rag/retriever.js";
import { GoalTypeSchema } from "../spec/schemas.js";

interface GoldenScenario {
  id: string;
  goalType: string;
  recipeId: string;
  query: string;
  expected?: {
    buildTools?: string[];
    testTools?: string[];
    topHitPathIncludes?: string;
  };
}

interface GoldenScenarioResult {
  id: string;
  passed: boolean;
  checks: Array<{ name: string; passed: boolean; detail: string }>;
}

function loadScenarios(fixturesDir: string): GoldenScenario[] {
  const scenariosPath = path.join(fixturesDir, "scenarios.json");
  const parsed = JSON.parse(readFileSync(scenariosPath, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error(`Invalid scenarios file: ${scenariosPath}`);
  }
  return parsed as GoldenScenario[];
}

function checkIncludes(all: string[], expected: string[]): { passed: boolean; missing: string[] } {
  const lower = new Set(all.map((item) => item.toLowerCase()));
  const missing = expected.filter((item) => !lower.has(item.toLowerCase()));
  return { passed: missing.length === 0, missing };
}

export async function runGoldenEvaluation(args?: {
  fixturesDir?: string;
  topK?: number;
}): Promise<{
  fixturesDir: string;
  total: number;
  passed: number;
  failed: number;
  results: GoldenScenarioResult[];
}> {
  const fixturesDir = path.resolve(
    args?.fixturesDir ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../testdata/golden"),
  );
  const scenarios = loadScenarios(fixturesDir);
  const results: GoldenScenarioResult[] = [];

  for (const scenario of scenarios) {
    GoalTypeSchema.parse(scenario.goalType);
    const repoRoot = path.join(fixturesDir, scenario.id);
    const checks: GoldenScenarioResult["checks"] = [];

    if (!existsSync(repoRoot)) {
      results.push({
        id: scenario.id,
        passed: false,
        checks: [{ name: "fixture-exists", passed: false, detail: `missing fixture ${repoRoot}` }],
      });
      continue;
    }

    const facts = discoverWorkspaceFacts(repoRoot);
    const expectedBuildTools = scenario.expected?.buildTools ?? [];
    if (expectedBuildTools.length > 0) {
      const includes = checkIncludes(facts.detectedBuildTools, expectedBuildTools);
      checks.push({
        name: "build-tools-detected",
        passed: includes.passed,
        detail: includes.passed
          ? `detected: ${facts.detectedBuildTools.join(", ")}`
          : `missing: ${includes.missing.join(", ")}`,
      });
    }

    const expectedTestTools = scenario.expected?.testTools ?? [];
    if (expectedTestTools.length > 0) {
      const includes = checkIncludes(facts.detectedTestTools, expectedTestTools);
      checks.push({
        name: "test-tools-detected",
        passed: includes.passed,
        detail: includes.passed
          ? `detected: ${facts.detectedTestTools.join(", ")}`
          : `missing: ${includes.missing.join(", ")}`,
      });
    }

    const index = buildRagIndex({
      workspaceRoot: repoRoot,
      maxFiles: 200,
      linesPerChunk: 80,
      maxCharsPerChunk: 2500,
    });
    const query = queryRagIndex({
      index,
      query: scenario.query,
      topK: args?.topK ?? 5,
    });

    const topHitPath = query.hits[0]?.filePath ?? "";
    if (scenario.expected?.topHitPathIncludes) {
      const passed = topHitPath.includes(scenario.expected.topHitPathIncludes);
      checks.push({
        name: "rag-top-hit",
        passed,
        detail: passed
          ? `top hit: ${topHitPath}`
          : `expected top hit to include '${scenario.expected.topHitPathIncludes}', got '${topHitPath || "none"}'`,
      });
    }

    const generatedDir = path.join(repoRoot, "generated", "golden");
    mkdirSync(generatedDir, { recursive: true });

    const synthesized = synthesizeTaskRequest({
      workspaceRoot: repoRoot,
      goalType: scenario.goalType,
      recipeId: scenario.recipeId,
      outputPath: "generated/golden/request.generated.md",
      maxTasks: 18,
    });

    const manifest = await compileRequestDag({
      workspaceRoot: repoRoot,
      requestPath: path.relative(repoRoot, synthesized.requestPath).replace(/\\/g, "/"),
      outputDir: "generated/golden/dag",
      dependencyMode: "staged",
    });

    const dagRun = runDag({
      workspaceRoot: repoRoot,
      manifestPath: "generated/golden/dag/manifest.json",
      executorTemplate: "echo module {id}",
      dryRun: true,
    });

    checks.push({
      name: "dag-compile",
      passed: manifest.modules.length > 0,
      detail: `modules=${manifest.modules.length}`,
    });
    checks.push({
      name: "dag-dry-run",
      passed: dagRun.status === "success",
      detail: `status=${dagRun.status}`,
    });

    const passed = checks.every((check) => check.passed);
    results.push({ id: scenario.id, passed, checks });
  }

  const passed = results.filter((result) => result.passed).length;
  const failed = results.length - passed;

  return {
    fixturesDir,
    total: results.length,
    passed,
    failed,
    results,
  };
}
