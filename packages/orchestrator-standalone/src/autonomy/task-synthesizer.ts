import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getRecipeById } from "../recipes/catalog.js";
import { discoverWorkspaceFacts } from "../adapters/workspace-discovery.js";
import { loadRagIndex, queryRagIndex } from "../rag/retriever.js";
import { runAutoRefineQuery } from "../rag/refine.js";
import { recordReplayOutcome, suggestReplayQueries } from "../rag/replay-memory.js";
import { ExecutionRecipeSchema, type ExecutionRecipe, type GateDefinition } from "../spec/schemas.js";
import type { WorkspaceFacts } from "../spec/schemas.js";

interface DiscoveryPayload {
  recipeId?: string;
  workspaceFacts?: {
    packageCount?: number;
    detectedBuildTools?: string[];
    detectedTestTools?: string[];
    detectedCiProviders?: string[];
    packages?: Array<{ name?: string; path?: string }>;
  };
  localSummary?: string;
  internetEvidence?: Array<{
    sourceId?: string;
    title?: string | null;
    url?: string;
    ok?: boolean;
    statusCode?: number | null;
    detectedSignals?: string[];
    summary?: string | null;
    error?: string | null;
  }>;
}

function normalizeDiscovery(input: unknown): DiscoveryPayload {
  if (typeof input !== "object" || input === null) return {};
  return input as DiscoveryPayload;
}

function readDiscoveryFile(discoveryPath: string | undefined): DiscoveryPayload {
  if (!discoveryPath) return {};
  try {
    const parsed = JSON.parse(readFileSync(path.resolve(discoveryPath), "utf8"));
    return normalizeDiscovery(parsed);
  } catch {
    return {};
  }
}

function renderDiscoveryEvidence(discovery: DiscoveryPayload): string {
  const evidence = discovery.internetEvidence ?? [];
  if (evidence.length === 0) return "- No internet evidence attached.\n";

  return evidence
    .slice(0, 10)
    .map((item, idx) => {
      const title = item.title || item.sourceId || `source-${idx + 1}`;
      const status = item.ok ? "ok" : `error${item.statusCode ? ` (${item.statusCode})` : ""}`;
      const signals = (item.detectedSignals ?? []).slice(0, 6).join(", ");
      return `- ${title}: ${status}${signals ? `; signals: ${signals}` : ""}${item.url ? `; ${item.url}` : ""}`;
    })
    .join("\n");
}

function renderRagEvidence(args: {
  ragIndexPath?: string;
  queries: string[];
  workspaceRoot?: string;
  recipeId?: string;
  autoRefine?: boolean;
  refineMaxIterations?: number;
  refineMaxQueriesPerIteration?: number;
  refineMaxQueries?: number;
  refineMaxRuntimeMs?: number;
  refineMaxTokenBudget?: number;
  refineMaxStallIterations?: number;
  refineConvergenceEpsilon?: number;
  replayMemoryEnabled?: boolean;
  replayMemoryPath?: string;
  replayMaxEntries?: number;
  replayMaxAgeDays?: number;
  replayMinScore?: number;
  replayMinSuccessCount?: number;
  autonomyDir?: string;
}): string {
  if (!args.ragIndexPath) return "- RAG index not provided.\n";

  let index;
  try {
    index = loadRagIndex(args.ragIndexPath);
  } catch {
    return "- Failed to load RAG index.\n";
  }

  if (args.autoRefine) {
    const seedQueries = args.queries.slice(0, 8);
    if (seedQueries.length === 0) return "- No seed queries available for auto-refine.\n";

    try {
      const replayEnabled = (args.replayMemoryEnabled ?? true) && Boolean(args.workspaceRoot && args.recipeId);
      const replay = replayEnabled && args.workspaceRoot && args.recipeId
        ? suggestReplayQueries({
          workspaceRoot: args.workspaceRoot,
          recipeId: args.recipeId,
          seedQueries,
          maxQueries: 4,
          autonomyDir: args.autonomyDir,
          memoryPath: args.replayMemoryPath,
          retentionMaxEntries: args.replayMaxEntries,
          retentionMaxAgeDays: args.replayMaxAgeDays,
          retentionMinScore: args.replayMinScore,
          retentionMinSuccessCount: args.replayMinSuccessCount,
        })
        : null;

      const replaySuggestions = replay?.querySuggestions ?? [];
      const replaySeedQueries = Array.from(new Set([...seedQueries, ...replaySuggestions])).slice(0, 12);

      const refined = runAutoRefineQuery({
        index,
        seedQueries: replaySeedQueries,
        topK: 8,
        maxIterations: args.refineMaxIterations,
        maxQueriesPerIteration: args.refineMaxQueriesPerIteration,
        maxQueries: args.refineMaxQueries,
        maxRuntimeMs: args.refineMaxRuntimeMs,
        maxTokenBudget: args.refineMaxTokenBudget,
        maxStallIterations: args.refineMaxStallIterations,
        convergenceEpsilon: args.refineConvergenceEpsilon,
      });

      if (refined.hits.length === 0) return "- Auto-refine ran, but no relevant RAG hits were found.\n";

      const lines: string[] = [];
      lines.push("### Auto-Refine Retrieval");
      lines.push(`- Seed queries: ${refined.seedQueries.length}`);
      lines.push(`- Replay memory suggestions: ${replaySuggestions.length}`);
      if (replay?.memoryPath && args.workspaceRoot) {
        const replayPath = path.relative(args.workspaceRoot, replay.memoryPath).replace(/\\/g, "/");
        lines.push(`- Replay memory path: ${replayPath}`);
      }
      lines.push(`- Iterations used: ${refined.budget.usedIterations}/${refined.budget.maxIterations}`);
      lines.push(`- Queries used: ${refined.budget.usedQueries}/${refined.budget.maxQueries}`);
      lines.push(`- Token estimate: ${refined.budget.usedTokensEstimate}/${refined.budget.maxTokenBudget}`);
      lines.push(`- Stall critic: ${refined.budget.stalledIterations}/${refined.budget.maxStallIterations}`);
      lines.push(`- Stop reason: ${refined.budget.stopReason}`);

      for (const iteration of refined.iterations) {
        lines.push(`### Iteration ${iteration.iteration}`);
        lines.push(`- queries: ${iteration.queriesUsed.join(" | ") || "none"}`);
        lines.push(`- follow-ups: ${iteration.newQueries.join(" | ") || "none"}`);
        lines.push(`- new unique hits: ${iteration.newUniqueHits}`);
        lines.push(`- avg top score: ${iteration.avgTopScore.toFixed(4)}`);
        lines.push(`- score delta: ${iteration.scoreDelta.toFixed(4)} (${iteration.critique})`);
      }

      lines.push("### Refined Top Hits");
      for (const hit of refined.hits.slice(0, 10)) {
        lines.push(
          `- ${hit.filePath}:${hit.startLine} score=${hit.score.toFixed(4)} terms=[${hit.matchedTerms.join(", ")}]`,
        );
        lines.push(`  - ${hit.excerpt.replace(/\s+/g, " ").slice(0, 320)}`);
      }

      if (replayEnabled && args.workspaceRoot && args.recipeId && refined.hits.length > 0) {
        try {
          recordReplayOutcome({
            workspaceRoot: args.workspaceRoot,
            recipeId: args.recipeId,
            seedQueries,
            refined,
            autonomyDir: args.autonomyDir,
            memoryPath: args.replayMemoryPath,
            retentionMaxEntries: args.replayMaxEntries,
            retentionMaxAgeDays: args.replayMaxAgeDays,
            retentionMinScore: args.replayMinScore,
            retentionMinSuccessCount: args.replayMinSuccessCount,
          });
        } catch {
          lines.push("- Replay memory update failed.");
        }
      }

      return `${lines.join("\n")}\n`;
    } catch {
      return "- Auto-refine retrieval failed; falling back to basic retrieval.\n";
    }
  }

  const lines: string[] = [];
  const seenChunkIds = new Set<string>();

  for (const query of args.queries.slice(0, 8)) {
    const result = queryRagIndex({ index, query, topK: 3 });
    if (result.hits.length === 0) continue;

    lines.push(`### Query: ${query}`);
    for (const hit of result.hits) {
      if (seenChunkIds.has(hit.chunkId)) continue;
      seenChunkIds.add(hit.chunkId);
      lines.push(
        `- ${hit.filePath}:${hit.startLine} score=${hit.score.toFixed(4)} terms=[${hit.matchedTerms.join(", ")}]`,
      );
      lines.push(`  - ${hit.excerpt.replace(/\s+/g, " ").slice(0, 320)}`);
    }
  }

  if (lines.length === 0) return "- No relevant RAG hits found for recipe queries.\n";
  return `${lines.join("\n")}\n`;
}

function maybeWorkspaceReadinessTask(args: {
  workspaceRoot: string;
  workspaceFacts: WorkspaceFacts;
  recipe: ExecutionRecipe;
}): { title: string; bullets: string[] } | null {
  const rootPkg = (args.workspaceFacts.packages ?? []).find((pkg) => pkg.path === ".");
  const rootScripts = new Set(rootPkg?.scripts ?? []);
  const detectedBuildTools = new Set(args.workspaceFacts.detectedBuildTools ?? []);
  const issues: string[] = [];
  const nodeModulesBin = path.join(args.workspaceRoot, "node_modules", ".bin");
  const missingFiles: string[] = [];
  const missingBuildTools: string[] = [];
  const packageManager = args.workspaceFacts.packageManager;

  if (!existsSync(nodeModulesBin)) {
    issues.push("Workspace dependencies are missing (`node_modules/.bin` not found).");
  }

  for (const requiredFile of args.recipe.preconditions.requiresFiles) {
    if (!existsSync(path.join(args.workspaceRoot, requiredFile))) {
      missingFiles.push(requiredFile);
    }
  }

  for (const requiredBuildTool of args.recipe.preconditions.requiresBuildTools) {
    if (!detectedBuildTools.has(requiredBuildTool)) {
      missingBuildTools.push(requiredBuildTool);
    }
  }

  if (missingFiles.length > 0) {
    issues.push(`Recipe preconditions missing files: ${missingFiles.join(", ")}.`);
  }
  if (missingBuildTools.length > 0) {
    issues.push(`Recipe preconditions missing build-tool signals: ${missingBuildTools.join(", ")}.`);
  }

  if (!args.recipe.preconditions.packageManagers.includes(packageManager)) {
    issues.push(
      `Detected package manager \`${packageManager}\` is outside recipe preconditions (${args.recipe.preconditions.packageManagers.join(", ")}).`,
    );
  }

  const gateScriptRequirements = collectGateScriptRequirements(args.recipe.gates);
  const missingGateScripts = gateScriptRequirements
    .filter((requirement) => requirement.scripts.length > 0 && !requirement.scripts.some((script) => rootScripts.has(script)));

  if (missingGateScripts.length > 0) {
    for (const requirement of missingGateScripts.slice(0, 5)) {
      issues.push(
        `Gate "${requirement.title}" expects root script(s): ${requirement.scripts.join(" | ")}; none found in root package.json.`,
      );
    }
    if (missingGateScripts.length > 5) {
      issues.push(`Additional gate script mismatches: ${missingGateScripts.length - 5}.`);
    }
  }

  if (issues.length === 0) return null;

  const resolvedPackageManager = packageManager === "unknown" ? "pnpm" : packageManager;
  const installCommand = resolvedPackageManager === "pnpm"
    ? "pnpm install"
    : resolvedPackageManager === "yarn"
      ? "yarn install"
      : "npm install";

  return {
    title: "Workspace readiness bootstrap",
    bullets: [
      ...issues,
      `Run dependency bootstrap first: ${installCommand}`,
      "Re-run required gate commands in isolation and verify toolchain binaries resolve before scheduling parallel DAG modules.",
      "Patch either root scripts or gate command mapping when script aliases differ.",
      "Record readiness evidence before continuing transform/verify tasks.",
    ],
  };
}

function extractGateCommandScripts(command: string): string[] {
  const scripts = new Set<string>();

  const addMatches = (pattern: RegExp): void => {
    for (const match of command.matchAll(pattern)) {
      const script = match[1]?.trim();
      if (script) scripts.add(script);
    }
  };

  addMatches(/\b(?:pnpm|npm)(?:\s+--?[a-zA-Z0-9-]+)*\s+run\s+([a-zA-Z0-9:_-]+)/g);
  addMatches(/\byarn\s+run\s+([a-zA-Z0-9:_-]+)/g);
  addMatches(/\byarn\s+([a-zA-Z0-9:_-]+)/g);
  addMatches(/\b(?:pnpm|npm)(?:\s+--?[a-zA-Z0-9-]+)*\s+(test|start|build|lint)\b/g);

  const nonScriptYarnCommands = new Set([
    "add",
    "install",
    "remove",
    "up",
    "upgrade",
    "cache",
    "set",
    "dlx",
    "exec",
    "workspaces",
  ]);

  for (const commandName of nonScriptYarnCommands) {
    scripts.delete(commandName);
  }

  return Array.from(scripts);
}

function collectGateScriptRequirements(gates: GateDefinition[]): Array<{ title: string; scripts: string[] }> {
  return gates
    .filter((gate) => gate.kind === "command" && gate.required && gate.command)
    .map((gate) => ({
      title: gate.title,
      scripts: extractGateCommandScripts(gate.command ?? ""),
    }));
}

export function synthesizeTaskRequest(args: {
  workspaceRoot: string;
  goalType: string;
  recipeId: string;
  recipe?: ExecutionRecipe;
  discoveryPath?: string;
  ragIndexPath?: string;
  ragAutoRefine?: boolean;
  ragRefineMaxIterations?: number;
  ragRefineMaxQueriesPerIteration?: number;
  ragRefineMaxQueries?: number;
  ragRefineMaxRuntimeMs?: number;
  ragRefineMaxTokenBudget?: number;
  ragRefineMaxStallIterations?: number;
  ragRefineConvergenceEpsilon?: number;
  ragReplayMemoryEnabled?: boolean;
  ragReplayMemoryPath?: string;
  ragReplayMaxEntries?: number;
  ragReplayMaxAgeDays?: number;
  ragReplayMinScore?: number;
  ragReplayMinSuccessCount?: number;
  autonomyDir?: string;
  outputPath: string;
  maxTasks?: number;
}): { requestPath: string; taskCount: number } {
  const workspaceRoot = path.resolve(args.workspaceRoot);
  const recipe = args.recipe ? ExecutionRecipeSchema.parse(args.recipe) : getRecipeById(args.recipeId);
  const discovery = readDiscoveryFile(args.discoveryPath);
  const workspaceFacts: WorkspaceFacts = discoverWorkspaceFacts(workspaceRoot);

  const queries = Array.from(
    new Set([
      ...recipe.edgeCases,
      ...recipe.riskProbes.map((probe) => probe.title),
      ...recipe.steps.map((step) => step.title),
      ...recipe.gates.map((gate) => gate.title),
    ]),
  );

  const tasks: Array<{ title: string; bullets: string[] }> = [];
  const readinessTask = maybeWorkspaceReadinessTask({ workspaceRoot, workspaceFacts, recipe });
  if (readinessTask) tasks.push(readinessTask);

  for (const step of recipe.steps) {
    tasks.push({
      title: step.title,
      bullets: [
        `Implement: ${step.description}`,
        "Add/adjust tests for this change path before apply mode.",
        "Validate outputs against recipe gates and record evidence.",
      ],
    });
  }

  for (const probe of recipe.riskProbes) {
    if (probe.severity === "high" || probe.severity === "critical") {
      tasks.push({
        title: `Mitigate risk: ${probe.title}`,
        bullets: [
          probe.advice,
          `Search pattern: ${probe.regex}`,
          "Add guard tests for this risk before rollout.",
        ],
      });
    }
  }

  for (const gate of recipe.gates) {
    tasks.push({
      title: `Gate: ${gate.title}`,
      bullets: [
        gate.command ? `Run command: ${gate.command}` : gate.note ?? "Satisfy gate requirements.",
        "Persist command outputs/logs in artifacts.",
      ],
    });
  }

  const trimmedTasks = tasks.slice(0, Math.max(4, args.maxTasks ?? 24));

  const packageList = (workspaceFacts.packages ?? [])
    .slice(0, 25)
    .map((pkg) => `${pkg.name ?? pkg.path ?? "unknown"}${pkg.path ? ` (${pkg.path})` : ""}`)
    .join("\n- ");

  const markdown = `# Auto-Generated Orchestration Request: ${recipe.title}

## Objective
- Goal type: ${args.goalType}
- Recipe: ${recipe.id}
- Deliver migration/refactor safely with strict validation gates.

## Non-Negotiables
- Preserve behavior parity unless explicitly changed.
- Add test coverage before apply operations.
- Run a critic pass per completed module before marking it done.
- When a gate fails, run focused repair follow-up tasks instead of replaying full waves.
- Emit a structured artifact contract per module (changes, tests, risk notes).
- Block apply on unresolved high-risk findings.
- Keep deterministic artifacts for each step.

## Workspace Snapshot
- Package count: ${workspaceFacts.packageCount ?? "unknown"}
- Build tools: ${(workspaceFacts.detectedBuildTools ?? []).join(", ") || "none"}
- Test tools: ${(workspaceFacts.detectedTestTools ?? []).join(", ") || "none"}
- CI providers: ${(workspaceFacts.detectedCiProviders ?? []).join(", ") || "none"}
- Packages (sample):
- ${packageList || "none"}

## Discovery Evidence
${renderDiscoveryEvidence(discovery)}

## RAG Evidence (Repo + Docs)
${renderRagEvidence({
  ragIndexPath: args.ragIndexPath,
  queries,
  workspaceRoot,
  recipeId: recipe.id,
  autoRefine: args.ragAutoRefine,
  refineMaxIterations: args.ragRefineMaxIterations,
  refineMaxQueriesPerIteration: args.ragRefineMaxQueriesPerIteration,
  refineMaxQueries: args.ragRefineMaxQueries,
  refineMaxRuntimeMs: args.ragRefineMaxRuntimeMs,
  refineMaxTokenBudget: args.ragRefineMaxTokenBudget,
  refineMaxStallIterations: args.ragRefineMaxStallIterations,
  refineConvergenceEpsilon: args.ragRefineConvergenceEpsilon,
  replayMemoryEnabled: args.ragReplayMemoryEnabled,
  replayMemoryPath: args.ragReplayMemoryPath,
  replayMaxEntries: args.ragReplayMaxEntries,
  replayMaxAgeDays: args.ragReplayMaxAgeDays,
  replayMinScore: args.ragReplayMinScore,
  replayMinSuccessCount: args.ragReplayMinSuccessCount,
  autonomyDir: args.autonomyDir,
})}

## Implementation Scope
${trimmedTasks
  .map((task, index) => {
    const idx = String(index + 1).padStart(2, "0");
    return `### Task ${idx}: ${task.title}\n${task.bullets.map((line) => `- [ ] ${line}`).join("\n")}`;
  })
  .join("\n\n")}

## Delivery Requirements
- [ ] All required gates pass.
- [ ] No unresolved high/critical risk findings.
- [ ] DAG run summary stored and reviewed.
- [ ] Rollback guidance included for changed areas.
`;

  const outputAbs = path.resolve(workspaceRoot, args.outputPath);
  mkdirSync(path.dirname(outputAbs), { recursive: true });
  writeFileSync(outputAbs, markdown, "utf8");

  return {
    requestPath: outputAbs,
    taskCount: trimmedTasks.length,
  };
}
