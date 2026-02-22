import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  DagManifestSchema,
  DagDependencyModeSchema,
  type DagDependencyMode,
  type DagManifest,
  type DagModule,
  type SplitPart,
} from "./types.js";

function ensureDir(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true });
}

function slug(input: string): string {
  const normalized = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return normalized || "request";
}

function partTitle(part: SplitPart, index: number): string {
  const title = (part.title ?? "").trim();
  return title || `part-${String(index + 1).padStart(2, "0")}`;
}

function fallbackSplit(input: string): SplitPart[] {
  const normalized = input.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const headingIdx: number[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line.startsWith("## ") || line.startsWith("### ")) headingIdx.push(i);
  }

  if (headingIdx.length === 0) {
    return [{ content: normalized, title: "request", startLine: 1, endLine: lines.length }];
  }

  const parts: SplitPart[] = [];
  const boundaries = [...headingIdx, lines.length];
  for (let i = 0; i < boundaries.length - 1; i += 1) {
    const start = boundaries[i];
    const end = boundaries[i + 1];
    const title = lines[start].trim().replace(/^##+\s*/, "") || `part-${i + 1}`;
    parts.push({
      content: lines.slice(start, end).join("\n"),
      title,
      startLine: start + 1,
      endLine: end,
    });
  }

  return parts;
}

async function loadSplitInputFn(workspaceRoot: string): Promise<((input: string) => SplitPart[] | null) | null> {
  const unpackPath = path.join(workspaceRoot, "unpack.config.ts");
  if (!existsSync(unpackPath)) return null;

  try {
    const mod = await import(pathToFileURL(unpackPath).href);
    const fn = mod?.default?.generate?.splitInput;
    if (typeof fn === "function") return fn as (input: string) => SplitPart[] | null;
  } catch {
    return null;
  }

  return null;
}

type PartKind = "preamble" | "stream" | "postamble";

function normalizeHeadingTitle(title: string): string {
  return title
    .replace(/^\d+[.)]\s*/, "")
    .replace(/^phase\s*\d+[:\s-]*/i, "")
    .trim();
}

function classifyPart(title: string): PartKind {
  const t = normalizeHeadingTitle(title).toLowerCase();

  if (/^iteration\s+\d+$/.test(t)) return "preamble";
  if (
    t.startsWith("query:") ||
    t.startsWith("workspace snapshot") ||
    t.startsWith("discovery evidence") ||
    t.startsWith("rag evidence") ||
    t.startsWith("auto-refine retrieval") ||
    t.startsWith("refined top hits") ||
    t.startsWith("implementation scope")
  ) {
    return "preamble";
  }

  const preambleTitles = new Set([
    "objective",
    "non-negotiables",
    "scope",
    "discovery",
    "discovery sources",
    "requirements",
    "context",
  ]);

  const postambleTitles = new Set([
    "delivery requirements",
    "verification",
    "go/no-go gates",
    "go-no-go gates",
    "rollout",
    "deployment",
    "summary",
  ]);

  if (preambleTitles.has(t)) return "preamble";
  if (postambleTitles.has(t)) return "postamble";
  return "stream";
}

function inferMode(kind: PartKind): "analyze" | "implement" {
  return kind === "stream" ? "implement" : "analyze";
}

function assignDependencies(args: {
  modules: Array<DagModule & { kind: PartKind }>;
  mode: DagDependencyMode;
}): Array<DagModule & { kind: PartKind }> {
  if (args.mode === "parallel") {
    return args.modules.map((module) => ({ ...module, dependsOn: [], level: 0 }));
  }

  if (args.mode === "sequential") {
    return args.modules.map((module, index) => ({
      ...module,
      dependsOn: index === 0 ? [] : [args.modules[index - 1].id],
      level: index,
    }));
  }

  const preambleIds = args.modules.filter((module) => module.kind === "preamble").map((module) => module.id);
  const streamIds = args.modules.filter((module) => module.kind === "stream").map((module) => module.id);

  return args.modules.map((module) => {
    if (module.kind === "preamble") {
      return { ...module, dependsOn: [], level: 0 };
    }

    if (module.kind === "stream") {
      return {
        ...module,
        dependsOn: [...preambleIds],
        level: preambleIds.length > 0 ? 1 : 0,
      };
    }

    return {
      ...module,
      dependsOn: Array.from(new Set([...preambleIds, ...streamIds])),
      level: (preambleIds.length > 0 ? 1 : 0) + (streamIds.length > 0 ? 1 : 0),
    };
  });
}

function writeParts(args: {
  parts: SplitPart[];
  partsDir: string;
  requestPath: string;
}): Array<{ title: string; partPath: string; index: number }> {
  ensureDir(args.partsDir);

  const indexRows: string[] = [];
  const out: Array<{ title: string; partPath: string; index: number }> = [];

  for (let i = 0; i < args.parts.length; i += 1) {
    const part = args.parts[i];
    const partIdx = String(i + 1).padStart(2, "0");
    const title = partTitle(part, i);
    const fileName = `request.part${partIdx}.md`;
    const filePath = path.join(args.partsDir, fileName);

    writeFileSync(
      filePath,
      `# Request Part ${partIdx}: ${title}\n\nSource: ${args.requestPath}\nLines: ${part.startLine ?? "n/a"}-${part.endLine ?? "n/a"}\n\n---\n\n${part.content}\n`,
      "utf8",
    );

    indexRows.push(`- part ${partIdx}: ${fileName} — ${title} (lines ${part.startLine ?? "n/a"}-${part.endLine ?? "n/a"})`);
    out.push({ title, partPath: filePath, index: i + 1 });
  }

  writeFileSync(
    path.join(args.partsDir, "request.parts.index.md"),
    `# Request Parts Index\n\nSource: ${args.requestPath}\nTotal parts: ${args.parts.length}\n\n${indexRows.join("\n")}\n`,
    "utf8",
  );

  return out;
}

export async function compileRequestDag(args: {
  workspaceRoot: string;
  requestPath: string;
  outputDir: string;
  dependencyMode: DagDependencyMode;
  name?: string;
  description?: string;
}): Promise<DagManifest> {
  const dependencyMode = DagDependencyModeSchema.parse(args.dependencyMode);
  const requestPathAbs = path.resolve(args.workspaceRoot, args.requestPath);
  const outputDirAbs = path.resolve(args.workspaceRoot, args.outputDir);
  const partsDirAbs = path.join(outputDirAbs, "parts");

  const requestText = readFileSync(requestPathAbs, "utf8");
  if (!requestText.trim()) {
    throw new Error(`Request file is empty: ${requestPathAbs}`);
  }

  let parts: SplitPart[] = [];
  const splitFn = await loadSplitInputFn(args.workspaceRoot);
  if (splitFn) {
    const maybeParts = splitFn(requestText);
    if (Array.isArray(maybeParts) && maybeParts.length > 0) {
      parts = maybeParts;
    }
  }

  if (parts.length === 0) {
    parts = fallbackSplit(requestText);
  }

  if (parts.length === 0) {
    throw new Error("No split parts generated.");
  }

  const writtenParts = writeParts({
    parts,
    partsDir: partsDirAbs,
    requestPath: path.relative(args.workspaceRoot, requestPathAbs),
  });

  const draftModules = writtenParts.map((part) => {
    const kind = classifyPart(part.title);
    const titleSlug = slug(part.title);
    return {
      id: `${String(part.index).padStart(2, "0")}-${titleSlug}`,
      title: part.title,
      description: `Request chunk ${String(part.index).padStart(2, "0")}: ${part.title}`,
      partPath: path.relative(args.workspaceRoot, part.partPath).replace(/\\/g, "/"),
      mode: inferMode(kind),
      level: 0,
      dependsOn: [],
      resources: [],
      kind,
    };
  });

  const modules = assignDependencies({
    modules: draftModules,
    mode: dependencyMode,
  }).map(({ kind: _kind, ...module }) => module);

  ensureDir(outputDirAbs);
  const manifest = DagManifestSchema.parse({
    schemaVersion: "1.0",
    name: args.name ?? "request-orchestration-dag",
    description:
      args.description ??
      `Compiled DAG from ${path.relative(args.workspaceRoot, requestPathAbs)} using dependency mode '${dependencyMode}'.`,
    requestPath: path.relative(args.workspaceRoot, requestPathAbs).replace(/\\/g, "/"),
    generatedAt: new Date().toISOString(),
    dependencyMode,
    modules,
  });

  const manifestPath = path.join(outputDirAbs, "manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}
