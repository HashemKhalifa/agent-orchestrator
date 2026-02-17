import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  ExecutionPlanSchema,
  ExecutionRecipeSchema,
  type ExecutionRecipe,
  type GateDefinition,
  type RiskProbe,
} from "../spec/schemas.js";

export interface RecipeMemory {
  recipeId: string;
  analyzedRuns: number;
  failedGateCounts: Record<string, number>;
  blockerKeywordCounts: Record<string, number>;
  learnedRiskProbes: RiskProbe[];
  learnedGates: GateDefinition[];
}

function safeReadJson(filePath: string): unknown | null {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function latestFileWithPrefix(dirPath: string, prefix: string): string | null {
  try {
    const entries = readdirSync(dirPath)
      .filter((entry) => entry.startsWith(prefix) && entry.endsWith(".json"))
      .sort()
      .reverse();
    if (entries.length === 0) return null;
    return path.join(dirPath, entries[0]);
  } catch {
    return null;
  }
}

function collectKeywords(input: string): string[] {
  const text = input.toLowerCase();
  const out: string[] = [];

  if (/(memory|leak|teardown|cleanup|unclosed)/.test(text)) out.push("memory");
  if (/(performance|slow|latency|timeout|regression|cache)/.test(text)) out.push("performance");
  if (/(breaking|deprecated|removed|deprecat)/.test(text)) out.push("breaking_change");
  if (/(compatibility|peer|loader|plugin|mismatch|version)/.test(text)) out.push("compatibility");

  return out;
}

function buildLearnedRiskProbes(keywordCounts: Record<string, number>): RiskProbe[] {
  const probes: RiskProbe[] = [];

  const addProbe = (
    key: "memory" | "performance" | "breaking_change" | "compatibility",
    threshold: number,
    probe: RiskProbe,
  ): void => {
    if ((keywordCounts[key] ?? 0) >= threshold) {
      probes.push(probe);
    }
  };

  addProbe("memory", 2, {
    id: "memory-loop-risk-memory",
    title: "Recurring memory/leak blockers",
    category: "memory",
    severity: "high",
    regex: "(useEffect|setInterval|addEventListener|watch\\()",
    fileGlobsHint: ["src/**/*", "**/*.test.*"],
    advice: "Recurring memory blocker detected across prior runs; enforce cleanup/teardown checks.",
  });

  addProbe("performance", 2, {
    id: "memory-loop-risk-performance",
    title: "Recurring performance/regression blockers",
    category: "performance",
    severity: "high",
    regex: "(cache|bundle|timeout|regression|slow)",
    fileGlobsHint: ["**/*"],
    advice: "Recurring performance blocker detected; add perf parity checks before apply.",
  });

  addProbe("breaking_change", 2, {
    id: "memory-loop-risk-breaking",
    title: "Recurring breaking/deprecation blockers",
    category: "breaking_change",
    severity: "high",
    regex: "(deprecated|removed|breaking)",
    fileGlobsHint: ["src/**/*", "**/*.md"],
    advice: "Recurring breaking-change blocker detected; map all deprecated APIs before rollout.",
  });

  addProbe("compatibility", 2, {
    id: "memory-loop-risk-compatibility",
    title: "Recurring compatibility blockers",
    category: "compatibility",
    severity: "high",
    regex: "(peerDependencies|loader|plugin|compatibility|version mismatch)",
    fileGlobsHint: ["package.json", "**/*config*.*"],
    advice: "Recurring compatibility blocker detected; validate adapters/peers prior to apply.",
  });

  return probes;
}

function buildLearnedGates(args: {
  failedGateCounts: Record<string, number>;
  threshold: number;
}): GateDefinition[] {
  const learned: GateDefinition[] = [];
  for (const [gateId, count] of Object.entries(args.failedGateCounts)) {
    if (count < args.threshold) continue;

    learned.push({
      id: `memory-gate-${gateId}`,
      title: `Recurring blocker evidence for ${gateId}`,
      kind: "artifact",
      required: true,
      artifactPath: `generated/orchestration/evidence/recurring/${gateId}.md`,
      note: `Auto-generated from run memory after ${count} failed attempts.`,
    });
  }
  return learned;
}

export function deriveRecipeMemory(args: {
  runsDir: string;
  recipeId: string;
  maxRuns?: number;
  learnedGateFailureThreshold?: number;
}): RecipeMemory {
  const failedGateCounts: Record<string, number> = {};
  const blockerKeywordCounts: Record<string, number> = {};
  let analyzedRuns = 0;

  if (!existsSync(args.runsDir)) {
    return {
      recipeId: args.recipeId,
      analyzedRuns,
      failedGateCounts,
      blockerKeywordCounts,
      learnedRiskProbes: [],
      learnedGates: [],
    };
  }

  const runDirs = readdirSync(args.runsDir)
    .map((entry) => path.join(args.runsDir, entry))
    .filter((entry) => {
      try {
        return existsSync(entry) && readdirSync(entry).length > 0;
      } catch {
        return false;
      }
    })
    .sort()
    .reverse()
    .slice(0, Math.max(1, args.maxRuns ?? 60));

  for (const runDir of runDirs) {
    const planPath = latestFileWithPrefix(runDir, "plan-");
    const executionPath = latestFileWithPrefix(runDir, "execution-");
    if (!planPath || !executionPath) continue;

    const rawPlan = safeReadJson(planPath);
    if (!rawPlan) continue;

    let plan;
    try {
      plan = ExecutionPlanSchema.parse(rawPlan);
    } catch {
      continue;
    }

    if (plan.recipe.id !== args.recipeId) continue;
    analyzedRuns += 1;

    const rawExecution = safeReadJson(executionPath);
    if (!rawExecution || typeof rawExecution !== "object" || rawExecution === null) continue;

    const gateResults = Array.isArray((rawExecution as { gateResults?: unknown[] }).gateResults)
      ? ((rawExecution as { gateResults?: Array<{ gateId?: string; required?: boolean; passed?: boolean }> }).gateResults ?? [])
      : [];

    for (const gate of gateResults) {
      if (!gate?.gateId) continue;
      if (gate.required !== true || gate.passed !== false) continue;
      failedGateCounts[gate.gateId] = (failedGateCounts[gate.gateId] ?? 0) + 1;
    }

    const blockerSummary = Array.isArray((rawExecution as { blockerSummary?: unknown[] }).blockerSummary)
      ? ((rawExecution as { blockerSummary?: string[] }).blockerSummary ?? [])
      : [];

    for (const blocker of blockerSummary) {
      for (const keyword of collectKeywords(blocker)) {
        blockerKeywordCounts[keyword] = (blockerKeywordCounts[keyword] ?? 0) + 1;
      }
    }
  }

  return {
    recipeId: args.recipeId,
    analyzedRuns,
    failedGateCounts,
    blockerKeywordCounts,
    learnedRiskProbes: buildLearnedRiskProbes(blockerKeywordCounts),
    learnedGates: buildLearnedGates({
      failedGateCounts,
      threshold: Math.max(1, args.learnedGateFailureThreshold ?? 2),
    }),
  };
}

export function applyRecipeMemory(args: {
  recipe: ExecutionRecipe;
  memory: RecipeMemory;
}): ExecutionRecipe {
  if (args.memory.learnedRiskProbes.length === 0 && args.memory.learnedGates.length === 0) {
    return args.recipe;
  }

  const existingProbeIds = new Set(args.recipe.riskProbes.map((probe) => probe.id));
  const existingGateIds = new Set(args.recipe.gates.map((gate) => gate.id));

  const merged = {
    ...args.recipe,
    riskProbes: [
      ...args.recipe.riskProbes,
      ...args.memory.learnedRiskProbes.filter((probe) => !existingProbeIds.has(probe.id)),
    ],
    gates: [
      ...args.recipe.gates,
      ...args.memory.learnedGates.filter((gate) => !existingGateIds.has(gate.id)),
    ],
    edgeCases: [
      ...args.recipe.edgeCases,
      `Recipe memory activated from ${args.memory.analyzedRuns} historical runs.`,
    ],
  };

  return ExecutionRecipeSchema.parse(merged);
}
