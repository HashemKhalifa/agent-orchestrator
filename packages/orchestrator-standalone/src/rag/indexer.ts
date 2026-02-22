import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { buildEmbedding, toTermCounts, toTermFrequency, tokenize } from "./hybrid.js";
import { RagIndexSchema, type RagChunk, type RagIndex } from "./types.js";

const IGNORE_DIRS = new Set([
  ".git",
  "node_modules",
  "generated",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nx",
  ".turbo",
  ".cache",
  ".omc",
  ".jest-cache",
  ".venv",
  "venv",
  "target",
]);

const DEFAULT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".kt",
  ".cs",
  ".rb",
  ".php",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".md",
  ".sql",
  ".sh",
]);

const DEFAULT_MAX_FILE_BYTES = 1_500_000;
const DEFAULT_MAX_CHUNKS = 10_000;
const DEFAULT_MAX_TOTAL_CHARS = 20_000_000;

function normalizePathForOutput(input: string): string {
  return input.split(path.sep).join("/");
}

function loadGitIgnoredPrefixes(workspaceRoot: string): string[] {
  try {
    const repoRoot = execFileSync(
      "git",
      ["-C", workspaceRoot, "rev-parse", "--show-toplevel"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    if (!repoRoot) return [];

    const output = execFileSync(
      "git",
      ["-C", workspaceRoot, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );

    const repoRootAbs = path.resolve(repoRoot);
    const workspaceRootAbs = path.resolve(workspaceRoot);
    const prefixes = new Set<string>();
    for (const rawLine of output.split(/\r?\n/)) {
      const line = normalizePathForOutput(rawLine.trim()).replace(/\/$/, "");
      if (!line) continue;
      const candidateAbsPaths = [path.resolve(workspaceRootAbs, line), path.resolve(repoRootAbs, line)];
      for (const candidateAbs of candidateAbsPaths) {
        const rel = normalizePathForOutput(path.relative(workspaceRootAbs, candidateAbs)).replace(/\/$/, "");
        if (!rel || rel === "." || rel.startsWith("..")) continue;
        prefixes.add(rel);
      }
    }

    return Array.from(prefixes).sort();
  } catch {
    return [];
  }
}

function isGitIgnoredPath(relativePath: string, prefixes: string[]): boolean {
  if (prefixes.length === 0) return false;
  return prefixes.some((prefix) => relativePath === prefix || relativePath.startsWith(`${prefix}/`));
}

function collectFiles(args: {
  workspaceRoot: string;
  maxFiles: number;
  extensions?: Set<string>;
  includeGenerated?: boolean;
  maxFileBytes: number;
}): string[] {
  const root = path.resolve(args.workspaceRoot);
  const out: string[] = [];
  const queue: string[] = [root];
  const exts = args.extensions ?? DEFAULT_EXTENSIONS;
  const gitIgnoredPrefixes = loadGitIgnoredPrefixes(root);

  while (queue.length > 0) {
    const current = queue.shift() as string;
    let entries: string[];

    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry);
      let stats;

      try {
        stats = statSync(fullPath);
      } catch {
        continue;
      }

      const relativePath = normalizePathForOutput(path.relative(root, fullPath));
      if (isGitIgnoredPath(relativePath, gitIgnoredPrefixes)) {
        continue;
      }

      if (stats.isDirectory()) {
        if (entry === "generated" && args.includeGenerated) {
          queue.push(fullPath);
          continue;
        }

        if (!IGNORE_DIRS.has(entry)) queue.push(fullPath);
        continue;
      }

      const ext = path.extname(entry).toLowerCase();
      if (!exts.has(ext)) continue;
      if (stats.size > args.maxFileBytes) continue;

      out.push(fullPath);
      if (out.length >= args.maxFiles) return out;
    }
  }

  return out;
}

function pruneTermCounts(termCounts: Record<string, number>, maxTerms: number): Record<string, number> {
  const entries = Object.entries(termCounts);
  if (entries.length <= maxTerms) return termCounts;

  const trimmed = entries.sort((a, b) => b[1] - a[1]).slice(0, maxTerms);
  const out: Record<string, number> = {};
  for (const [term, count] of trimmed) {
    out[term] = count;
  }
  return out;
}

function splitIntoChunks(args: {
  filePath: string;
  workspaceRoot: string;
  linesPerChunk: number;
  maxCharsPerChunk: number;
  embeddingDims: number;
  maxTermsPerChunk: number;
}): RagChunk[] {
  let content = "";
  try {
    content = readFileSync(args.filePath, "utf8");
  } catch {
    return [];
  }

  if (!content.trim()) return [];

  const lines = content.split(/\r?\n/g);
  const chunks: RagChunk[] = [];

  let start = 0;
  let chunkId = 0;
  while (start < lines.length) {
    let end = Math.min(lines.length, start + args.linesPerChunk);
    let text = lines.slice(start, end).join("\n");

    if (text.length > args.maxCharsPerChunk) {
      const ratio = Math.max(1, Math.floor((args.maxCharsPerChunk / Math.max(1, text.length)) * (end - start)));
      end = Math.min(lines.length, start + ratio);
      text = lines.slice(start, end).join("\n");
    }

    const tokens = tokenize(text);
    const tokenCount = tokens.length;
    const relPath = path.relative(args.workspaceRoot, args.filePath).replace(/\\/g, "/");
    const termCounts = pruneTermCounts(toTermCounts(tokens), args.maxTermsPerChunk);

    chunks.push({
      id: `${relPath}#${chunkId}`,
      filePath: relPath,
      startLine: start + 1,
      endLine: end,
      text,
      tokenCount,
      termCounts,
      termFreq: toTermFrequency(termCounts, tokenCount),
      embedding: buildEmbedding(termCounts, args.embeddingDims),
    });

    chunkId += 1;
    start = end;
  }

  return chunks;
}

export function buildRagIndex(args: {
  workspaceRoot: string;
  maxFiles?: number;
  linesPerChunk?: number;
  maxCharsPerChunk?: number;
  embeddingDims?: number;
  maxTermsPerChunk?: number;
  includeGenerated?: boolean;
  maxFileBytes?: number;
  maxChunks?: number;
  maxTotalChars?: number;
}): RagIndex {
  const workspaceRoot = path.resolve(args.workspaceRoot);
  const maxFileBytes = Math.max(1, Math.trunc(args.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES));
  const maxChunks = Math.max(1, Math.trunc(args.maxChunks ?? DEFAULT_MAX_CHUNKS));
  const maxTotalChars = Math.max(1_000, Math.trunc(args.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS));
  const files = collectFiles({
    workspaceRoot,
    maxFiles: args.maxFiles ?? 3000,
    includeGenerated: args.includeGenerated ?? false,
    maxFileBytes,
  });

  const embeddingDims = Math.max(8, args.embeddingDims ?? 96);
  const chunks: RagChunk[] = [];
  let totalChars = 0;
  let chunkBudgetReached = false;
  outer: for (const filePath of files) {
    if (chunkBudgetReached) break;
    const fileChunks = splitIntoChunks({
      filePath,
      workspaceRoot,
      linesPerChunk: args.linesPerChunk ?? 120,
      maxCharsPerChunk: args.maxCharsPerChunk ?? 5000,
      embeddingDims,
      maxTermsPerChunk: args.maxTermsPerChunk ?? 180,
    });
    for (const chunk of fileChunks) {
      if (chunk.tokenCount <= 0) continue;
      if (chunks.length >= maxChunks) {
        chunkBudgetReached = true;
        break outer;
      }
      if (totalChars + chunk.text.length > maxTotalChars) {
        chunkBudgetReached = true;
        break outer;
      }
      chunks.push(chunk);
      totalChars += chunk.text.length;
    }
  }

  const df = new Map<string, number>();
  for (const chunk of chunks) {
    const seen = new Set(Object.keys(chunk.termCounts));
    for (const term of seen) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }

  const vocabularyDf: Record<string, number> = {};
  for (const [term, count] of df.entries()) {
    vocabularyDf[term] = count;
  }

  const avgDocLength = chunks.length > 0
    ? chunks.reduce((sum, chunk) => sum + chunk.tokenCount, 0) / chunks.length
    : 1;

  return RagIndexSchema.parse({
    schemaVersion: "1.0",
    generatedAt: new Date().toISOString(),
    workspaceRoot,
    fileCount: files.length,
    chunkCount: chunks.length,
    vocabularyDf,
    avgDocLength,
    embeddingDims,
    retrievalMode: "hybrid_bm25_embedding",
    chunks,
  });
}

export function saveRagIndex(args: {
  index: RagIndex;
  outputPath: string;
}): string {
  const outputAbs = path.resolve(args.outputPath);
  mkdirSync(path.dirname(outputAbs), { recursive: true });
  writeFileSync(outputAbs, `${JSON.stringify(args.index, null, 2)}\n`, "utf8");
  return outputAbs;
}
