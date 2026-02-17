import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DagManifestSchema, DagRunSummarySchema, type DagManifest, type DagRunSummary } from "../dag/types.js";

interface SkillCandidate {
  name: string;
  title: string;
  trigger: string;
  moduleCount: number;
  moduleTitles: string[];
}

const DOMAIN_RULES: Array<{
  key: string;
  title: string;
  trigger: string;
  patterns: RegExp[];
}> = [
  {
    key: "build-migration",
    title: "Build Migration",
    trigger: "webpack, rsbuild, vite, bundler, loader, plugin",
    patterns: [/webpack/i, /rsbuild/i, /vite/i, /bundl/i, /loader/i, /plugin/i],
  },
  {
    key: "react-upgrade",
    title: "React Upgrade",
    trigger: "react, hooks, jsx, hydration",
    patterns: [/react/i, /hook/i, /jsx/i, /hydration/i],
  },
  {
    key: "test-runner-migration",
    title: "Test Runner Migration",
    trigger: "jest, vitest, test parity",
    patterns: [/jest/i, /vitest/i, /test/i, /mock/i, /snapshot/i],
  },
  {
    key: "ci-modernization",
    title: "CI Modernization",
    trigger: "ci, workflow, pipeline, cache",
    patterns: [/\bci\b/i, /workflow/i, /pipeline/i, /cache/i, /artifact/i],
  },
  {
    key: "dependency-upgrade",
    title: "Dependency Upgrade",
    trigger: "dependency, upgrade, peer, lockfile",
    patterns: [/dependency/i, /upgrade/i, /peer/i, /lockfile/i],
  },
];

function loadManifest(manifestPath: string): DagManifest {
  const raw = JSON.parse(readFileSync(path.resolve(manifestPath), "utf8"));
  return DagManifestSchema.parse(raw);
}

function loadSummary(summaryPath: string | undefined): DagRunSummary | null {
  if (!summaryPath) return null;
  try {
    const raw = JSON.parse(readFileSync(path.resolve(summaryPath), "utf8"));
    return DagRunSummarySchema.parse(raw);
  } catch {
    return null;
  }
}

function detectCandidates(args: {
  manifest: DagManifest;
  summary: DagRunSummary | null;
  minOccurrences: number;
}): SkillCandidate[] {
  const moduleTexts = args.manifest.modules.map((module) => `${module.title}\n${module.description}`);
  const failedModuleIds = new Set(
    (args.summary?.results ?? [])
      .filter((result) => result.status === "failed" || result.status === "blocked")
      .map((result) => result.moduleId),
  );

  const candidates: SkillCandidate[] = [];

  for (const rule of DOMAIN_RULES) {
    const matchingTitles: string[] = [];

    for (const module of args.manifest.modules) {
      const text = `${module.title}\n${module.description}`;
      const hasPattern = rule.patterns.some((pattern) => pattern.test(text));
      if (!hasPattern) continue;

      const failureBoost = failedModuleIds.has(module.id) ? " [failed-or-blocked]" : "";
      matchingTitles.push(`${module.title}${failureBoost}`);
    }

    if (matchingTitles.length >= args.minOccurrences) {
      candidates.push({
        name: `autogen-${rule.key}`,
        title: `${rule.title} Automation`,
        trigger: rule.trigger,
        moduleCount: matchingTitles.length,
        moduleTitles: matchingTitles,
      });
    }
  }

  return candidates;
}

function skillContent(candidate: SkillCandidate, manifestPath: string): string {
  return `---
name: ${candidate.name}
description: Auto-generated skill for ${candidate.title.toLowerCase()} tasks triggered by repeated DAG modules (${candidate.moduleCount} matches).
---

# ${candidate.title}

Use this skill when tasks repeatedly involve: ${candidate.trigger}.

## Trigger Context
- Source manifest: ${manifestPath}
- Matched modules:
${candidate.moduleTitles.map((title) => `- ${title}`).join("\n")}

## Workflow
1. Run discovery and gather risk evidence.
2. Generate/refresh request DAG chunks.
3. Execute DAG with strict gates and collect summaries.
4. Validate failed/blocked modules first, then continue rollout.

## Commands
\`\`\`bash
npm --prefix packages/orchestrator-standalone run cli -- dag-compile --request request.md
npm --prefix packages/orchestrator-standalone run cli -- dag-run --manifest generated/orchestration/dag/manifest.json --executor "codex exec --full-auto \"Process {partFile}\""
\`\`\`
`;
}

export function autoGenerateSkills(args: {
  workspaceRoot: string;
  manifestPath: string;
  runSummaryPath?: string;
  outputDir?: string;
  minOccurrences?: number;
  apply?: boolean;
}): {
  candidates: SkillCandidate[];
  created: string[];
} {
  const workspaceRoot = path.resolve(args.workspaceRoot);
  const manifestPath = path.resolve(workspaceRoot, args.manifestPath);
  const summary = loadSummary(args.runSummaryPath ? path.resolve(workspaceRoot, args.runSummaryPath) : undefined);
  const manifest = loadManifest(manifestPath);

  const candidates = detectCandidates({
    manifest,
    summary,
    minOccurrences: Math.max(1, args.minOccurrences ?? 2),
  });

  if (!args.apply) {
    return { candidates, created: [] };
  }

  const outputDir = path.resolve(workspaceRoot, args.outputDir ?? ".codex/skills/generated");
  mkdirSync(outputDir, { recursive: true });
  const created: string[] = [];

  for (const candidate of candidates) {
    const skillDir = path.join(outputDir, candidate.name);
    const skillPath = path.join(skillDir, "SKILL.md");

    if (existsSync(skillPath)) continue;

    mkdirSync(skillDir, { recursive: true });
    writeFileSync(skillPath, skillContent(candidate, path.relative(workspaceRoot, manifestPath)), "utf8");
    created.push(path.relative(workspaceRoot, skillPath).replace(/\\/g, "/"));
  }

  return { candidates, created };
}
