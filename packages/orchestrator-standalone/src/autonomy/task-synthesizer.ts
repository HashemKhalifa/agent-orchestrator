import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getRecipeById } from "../recipes/catalog.js";
import { discoverWorkspaceFacts } from "../adapters/workspace-discovery.js";
import { loadRagIndex, queryRagIndex } from "../rag/retriever.js";
import { ExecutionRecipeSchema, type ExecutionRecipe } from "../spec/schemas.js";

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
}): string {
  if (!args.ragIndexPath) return "- RAG index not provided.\n";

  let index;
  try {
    index = loadRagIndex(args.ragIndexPath);
  } catch {
    return "- Failed to load RAG index.\n";
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

export function synthesizeTaskRequest(args: {
  workspaceRoot: string;
  goalType: string;
  recipeId: string;
  recipe?: ExecutionRecipe;
  discoveryPath?: string;
  ragIndexPath?: string;
  outputPath: string;
  maxTasks?: number;
}): { requestPath: string; taskCount: number } {
  const workspaceRoot = path.resolve(args.workspaceRoot);
  const recipe = args.recipe ? ExecutionRecipeSchema.parse(args.recipe) : getRecipeById(args.recipeId);
  const discovery = readDiscoveryFile(args.discoveryPath);
  const workspaceFacts = discovery.workspaceFacts ?? discoverWorkspaceFacts(workspaceRoot);

  const queries = Array.from(
    new Set([
      ...recipe.edgeCases,
      ...recipe.riskProbes.map((probe) => probe.title),
      ...recipe.steps.map((step) => step.title),
      ...recipe.gates.map((gate) => gate.title),
    ]),
  );

  const tasks: Array<{ title: string; bullets: string[] }> = [];

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
${renderRagEvidence({ ragIndexPath: args.ragIndexPath, queries })}

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
