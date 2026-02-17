import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
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

const STOP_WORDS = new Set([
  "the", "and", "for", "that", "with", "this", "from", "are", "was", "were", "will",
  "have", "has", "had", "into", "onto", "your", "you", "our", "their", "they", "them",
  "then", "than", "when", "where", "what", "which", "while", "does", "did", "done",
  "just", "also", "very", "much", "many", "more", "less", "some", "any", "not", "can",
  "could", "should", "would", "about", "after", "before", "during", "over", "under",
  "true", "false", "null", "undefined", "const", "let", "var", "function", "return",
  "import", "export", "class", "type", "interface", "public", "private", "static",
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

function tokenize(text: string): string[] {
  const matches = text.toLowerCase().match(/[a-z][a-z0-9_\-]{1,}/g) ?? [];
  const out: string[] = [];
  for (const token of matches) {
    if (STOP_WORDS.has(token)) continue;
    out.push(token);
  }
  return out;
}

function termFrequency(tokens: string[], topTerms = 120): Record<string, number> {
  if (tokens.length === 0) return {};

  const freq = new Map<string, number>();
  for (const token of tokens) {
    freq.set(token, (freq.get(token) ?? 0) + 1);
  }

  const sorted = Array.from(freq.entries()).sort((a, b) => b[1] - a[1]).slice(0, topTerms);
  const total = tokens.length;
  const out: Record<string, number> = {};
  for (const [term, count] of sorted) {
    out[term] = count / total;
  }
  return out;
}

function splitIntoChunks(args: {
  filePath: string;
  workspaceRoot: string;
  linesPerChunk: number;
  maxCharsPerChunk: number;
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
    const relPath = path.relative(args.workspaceRoot, args.filePath).replace(/\\/g, "/");

    chunks.push({
      id: `${relPath}#${chunkId}`,
      filePath: relPath,
      startLine: start + 1,
      endLine: end,
      text,
      tokenCount: tokens.length,
      termFreq: termFrequency(tokens),
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
}): RagIndex {
  const workspaceRoot = path.resolve(args.workspaceRoot);
  const files = collectFiles({
    workspaceRoot,
    maxFiles: args.maxFiles ?? 3000,
  });

  const chunks: RagChunk[] = [];
  for (const filePath of files) {
    const fileChunks = splitIntoChunks({
      filePath,
      workspaceRoot,
      linesPerChunk: args.linesPerChunk ?? 120,
      maxCharsPerChunk: args.maxCharsPerChunk ?? 5000,
    });
    for (const chunk of fileChunks) {
      if (chunk.tokenCount > 0) chunks.push(chunk);
    }
  }

  const df = new Map<string, number>();
  for (const chunk of chunks) {
    const seen = new Set(Object.keys(chunk.termFreq));
    for (const term of seen) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }

  const vocabularyDf: Record<string, number> = {};
  for (const [term, count] of df.entries()) {
    vocabularyDf[term] = count;
  }

  return RagIndexSchema.parse({
    schemaVersion: "1.0",
    generatedAt: new Date().toISOString(),
    workspaceRoot,
    fileCount: files.length,
    chunkCount: chunks.length,
    vocabularyDf,
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
