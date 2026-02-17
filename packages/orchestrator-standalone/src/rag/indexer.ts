import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { buildEmbedding, toTermCounts, toTermFrequency, tokenize } from "./hybrid.js";
import { RagIndexSchema, type RagChunk, type RagIndex } from "./types.js";

const IGNORE_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
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

function collectFiles(args: {
  workspaceRoot: string;
  maxFiles: number;
  extensions?: Set<string>;
}): string[] {
  const root = path.resolve(args.workspaceRoot);
  const out: string[] = [];
  const queue: string[] = [root];
  const exts = args.extensions ?? DEFAULT_EXTENSIONS;

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

      if (stats.isDirectory()) {
        if (!IGNORE_DIRS.has(entry)) queue.push(fullPath);
        continue;
      }

      const ext = path.extname(entry).toLowerCase();
      if (!exts.has(ext)) continue;

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
}): RagIndex {
  const workspaceRoot = path.resolve(args.workspaceRoot);
  const files = collectFiles({
    workspaceRoot,
    maxFiles: args.maxFiles ?? 3000,
  });

  const embeddingDims = Math.max(8, args.embeddingDims ?? 96);
  const chunks: RagChunk[] = [];
  for (const filePath of files) {
    const fileChunks = splitIntoChunks({
      filePath,
      workspaceRoot,
      linesPerChunk: args.linesPerChunk ?? 120,
      maxCharsPerChunk: args.maxCharsPerChunk ?? 5000,
      embeddingDims,
      maxTermsPerChunk: args.maxTermsPerChunk ?? 180,
    });
    for (const chunk of fileChunks) {
      if (chunk.tokenCount > 0) chunks.push(chunk);
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
