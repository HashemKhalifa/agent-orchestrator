import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { discoverWorkspaceFacts, summarizeWorkspaceFacts } from "../adapters/workspace-discovery.js";
import { collectInternetEvidence } from "../adapters/internet-evidence.js";
import { getRecipeById, getRecipeCatalog } from "./catalog.js";
import { deriveRecipeMemory, applyRecipeMemory, type RecipeMemory } from "./memory.js";
import {
  DiscoverySourceSchema,
  ExecutionRecipeSchema,
  type ExecutionRecipe,
  type GateDefinition,
  type GoalType,
  type OrchestrationGoal,
  type RecipeStep,
  type RiskProbe,
  type SourcePolicy,
  type WorkspaceFacts,
} from "../spec/schemas.js";

interface DiscoveryPayload {
  localSummary?: string;
  workspaceFacts?: WorkspaceFacts;
  internetEvidence?: Array<{
    sourceId?: string;
    title?: string | null;
    url?: string;
    ok?: boolean;
  }>;
}

function readDiscoveryPayload(discoveryPath: string | undefined): DiscoveryPayload {
  if (!discoveryPath) return {};
  try {
    const parsed = JSON.parse(readFileSync(path.resolve(discoveryPath), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return {};
    return parsed as DiscoveryPayload;
  } catch {
    return {};
  }
}

function normalizeId(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
}

function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

function dedupeStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function heuristicsRiskProbes(args: {
  goalType: GoalType;
  workspaceFacts: WorkspaceFacts;
}): RiskProbe[] {
  const probes: RiskProbe[] = [];
  const tools = new Set(args.workspaceFacts.detectedBuildTools.map((tool) => tool.toLowerCase()));
  const testTools = new Set(args.workspaceFacts.detectedTestTools.map((tool) => tool.toLowerCase()));

  if (tools.has("webpack")) {
    probes.push({
      id: "auto-webpack-custom-loader",
      title: "Auto-detected webpack custom loader risk",
      category: "compatibility",
      severity: "high",
      regex: "loader\\s*:\\s*['\\\"][./]",
      fileGlobsHint: ["**/webpack*.{js,ts,mjs,cjs}"],
      advice: "Audit custom loaders and plugin compatibility before migration cutover.",
    });
  }

  if (testTools.has("jest")) {
    probes.push({
      id: "auto-jest-api-surface",
      title: "Auto-detected jest API migration risk",
      category: "compatibility",
      severity: "high",
      regex: "\\bjest\\.",
      fileGlobsHint: ["**/*.test.*", "**/*.spec.*"],
      advice: "Replace Jest-only APIs with target runner equivalents.",
    });
  }

  if (args.goalType === "dependency_upgrade") {
    probes.push({
      id: "auto-deprecation-scan",
      title: "Deprecation scan for dependency upgrades",
      category: "breaking_change",
      severity: "high",
      regex: "(deprecated|removed|legacy)",
      fileGlobsHint: ["src/**/*", "**/*.md"],
      advice: "Map deprecations to explicit migration tasks and tests.",
    });
  }

  return probes;
}

function sourceFromDiscovery(discovery: DiscoveryPayload): Array<ReturnType<typeof DiscoverySourceSchema.parse>> {
  const evidence = discovery.internetEvidence ?? [];
  const mapped: Array<ReturnType<typeof DiscoverySourceSchema.parse>> = [];
  for (const [index, item] of evidence.entries()) {
    if (!item.ok || !item.url) continue;
    try {
      mapped.push(
        DiscoverySourceSchema.parse({
          id: normalizeId(item.sourceId || item.title || `source-${index + 1}`),
          title: (item.title || item.sourceId || `Source ${index + 1}`).slice(0, 120),
          url: item.url,
          type: "primary",
          tags: ["auto-generated"],
        }),
      );
    } catch {
      continue;
    }
    if (mapped.length >= 8) break;
  }

  return mapped;
}

function goalTypeDefaultSteps(goalType: GoalType): RecipeStep[] {
  const base: RecipeStep[] = [
    {
      id: "inventory",
      title: "Inventory current state",
      kind: "analyze",
      description: "Discover current implementation, configs, and ownership boundaries.",
      mutating: false,
    },
    {
      id: "implement-migration",
      title: "Implement migration changes",
      kind: "transform",
      description: "Apply staged code/config changes for the target migration.",
      mutating: true,
    },
    {
      id: "validate-parity",
      title: "Validate parity and stability",
      kind: "verify",
      description: "Run tests, typechecks, and smoke checks to validate behavior.",
      mutating: false,
    },
  ];

  if (goalType === "ci_refactor") {
    return [
      base[0],
      {
        id: "refactor-ci",
        title: "Refactor CI workflow",
        kind: "transform",
        description: "Modernize CI install/build/test pipeline and cache strategy.",
        mutating: true,
      },
      base[2],
    ];
  }

  return base;
}

const DEFAULT_GATES: GateDefinition[] = [
  {
    id: "gate-typecheck",
    title: "Typecheck passes",
    kind: "command",
    required: true,
    command: "npm run typecheck",
  },
  {
    id: "gate-tests",
    title: "Tests pass",
    kind: "command",
    required: true,
    command: "npm run test:run",
  },
  {
    id: "gate-risk-high",
    title: "No unresolved high/critical risks",
    kind: "risk",
    required: true,
    note: "Block apply when high/critical risks remain open.",
  },
];

function fallbackBaseRecipe(goalType: GoalType): ExecutionRecipe {
  const match = getRecipeCatalog().find((recipe) => recipe.goalType === goalType);
  if (match) return match;

  return ExecutionRecipeSchema.parse({
    id: `${goalType}-auto-base`,
    version: "0.1.0",
    title: `Auto ${goalType} Base Recipe`,
    description: `Generated fallback recipe for ${goalType}.`,
    goalType,
    defaultWaveStrategy: "pilot_wave",
    preconditions: {
      packageManagers: ["npm", "pnpm", "yarn", "unknown"],
      requiresFiles: ["package.json"],
      requiresBuildTools: [],
    },
    discoverySources: [
      {
        id: "default-source",
        title: "Project source of truth",
        url: "https://example.com/docs",
        type: "primary",
        tags: ["placeholder"],
      },
    ],
    riskProbes: [],
    steps: goalTypeDefaultSteps(goalType),
    gates: DEFAULT_GATES,
    rollbackHints: ["Keep rollback snapshots for each wave."],
    edgeCases: [],
  });
}

export async function generateRecipeFromContext(args: {
  workspaceRoot: string;
  goalType: GoalType;
  recipeId: string;
  title?: string;
  description?: string;
  baseRecipeId?: string;
  discoveryPath?: string;
  runsDir?: string;
  sourcePolicy?: SourcePolicy;
  curatedDomains?: string[];
  includeInternet?: boolean;
  outputPath?: string;
}): Promise<{
  recipe: ExecutionRecipe;
  outputPath: string | null;
  baseRecipeId: string;
  memory: RecipeMemory | null;
  summary: string;
}> {
  const workspaceRoot = path.resolve(args.workspaceRoot);
  const discovery = readDiscoveryPayload(args.discoveryPath);
  const baseRecipe = args.baseRecipeId ? getRecipeById(args.baseRecipeId) : fallbackBaseRecipe(args.goalType);
  const workspaceFacts = discovery.workspaceFacts ?? discoverWorkspaceFacts(workspaceRoot);

  let discoverySources = sourceFromDiscovery(discovery);
  if (discoverySources.length === 0) {
    discoverySources = baseRecipe.discoverySources;
  }

  if ((args.includeInternet ?? true) && discoverySources.length > 0 && (!discovery.internetEvidence || discovery.internetEvidence.length === 0)) {
    const evidence = await collectInternetEvidence({
      sources: discoverySources,
      policy: args.sourcePolicy ?? "primary_plus_curated_secondary",
      curatedDomains: args.curatedDomains ?? [],
    });
    discoverySources = evidence
      .filter((item) => item.ok)
      .slice(0, 8)
      .map((item) =>
        DiscoverySourceSchema.parse({
          id: normalizeId(item.sourceId),
          title: (item.title || item.sourceId).slice(0, 120),
          url: item.url,
          type: "primary",
          tags: ["auto-discovered"],
        }));
    if (discoverySources.length === 0) {
      discoverySources = baseRecipe.discoverySources;
    }
  }

  const memory = args.runsDir
    ? deriveRecipeMemory({
      runsDir: path.resolve(args.runsDir),
      recipeId: baseRecipe.id,
    })
    : null;

  const synthesized = ExecutionRecipeSchema.parse({
    ...baseRecipe,
    id: normalizeId(args.recipeId),
    version: "1.0.0-autogen",
    title: args.title ?? `Autogenerated ${args.goalType} Recipe`,
    description: args.description ?? `Autogenerated recipe for ${args.goalType}. ${summarizeWorkspaceFacts(workspaceFacts)}`,
    goalType: args.goalType,
    discoverySources,
    riskProbes: dedupeById([
      ...baseRecipe.riskProbes,
      ...heuristicsRiskProbes({ goalType: args.goalType, workspaceFacts }),
    ]),
    steps: baseRecipe.steps.length > 0 ? baseRecipe.steps : goalTypeDefaultSteps(args.goalType),
    gates: dedupeById([
      ...baseRecipe.gates,
      ...DEFAULT_GATES,
    ]),
    edgeCases: dedupeStrings(baseRecipe.edgeCases),
  });

  const recipe = memory ? applyRecipeMemory({ recipe: synthesized, memory }) : synthesized;

  let outputPath: string | null = null;
  if (args.outputPath) {
    const outputAbs = path.resolve(workspaceRoot, args.outputPath);
    mkdirSync(path.dirname(outputAbs), { recursive: true });
    writeFileSync(outputAbs, `${JSON.stringify(recipe, null, 2)}\n`, "utf8");
    outputPath = outputAbs;
  }

  const summary = `Generated recipe '${recipe.id}' from base '${baseRecipe.id}' with ${
    recipe.riskProbes.length
  } risk probes and ${recipe.gates.length} gates.`;

  return {
    recipe,
    outputPath,
    baseRecipeId: baseRecipe.id,
    memory,
    summary,
  };
}
