import { readFileSync } from "node:fs";
import path from "node:path";
import {
  RagIndexSchema,
  RagQueryResultSchema,
  type RagIndex,
  type RagQueryHit,
  type RagQueryResult,
} from "./types.js";

const STOP_WORDS = new Set([
  "the", "and", "for", "that", "with", "this", "from", "are", "was", "were", "will",
  "have", "has", "had", "into", "onto", "your", "you", "our", "their", "they", "them",
  "then", "than", "when", "where", "what", "which", "while", "does", "did", "done",
  "just", "also", "very", "much", "many", "more", "less", "some", "any", "not", "can",
  "could", "should", "would", "about", "after", "before", "during", "over", "under",
]);

function tokenize(text: string): string[] {
  const raw = text.toLowerCase().match(/[a-z][a-z0-9_\-]{1,}/g) ?? [];
  return raw.filter((term) => !STOP_WORDS.has(term));
}

function queryTf(tokens: string[]): Record<string, number> {
  if (tokens.length === 0) return {};

  const counts = new Map<string, number>();
  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }

  const out: Record<string, number> = {};
  const total = tokens.length;
  for (const [term, count] of counts.entries()) {
    out[term] = count / total;
  }
  return out;
}

function idf(term: string, index: RagIndex): number {
  const df = index.vocabularyDf[term] ?? 0;
  return Math.log((index.chunkCount + 1) / (df + 1)) + 1;
}

function scoreChunk(args: {
  index: RagIndex;
  queryTf: Record<string, number>;
  chunkTf: Record<string, number>;
}): { score: number; matchedTerms: string[] } {
  let score = 0;
  const matchedTerms: string[] = [];

  for (const [term, qWeight] of Object.entries(args.queryTf)) {
    const cWeight = args.chunkTf[term];
    if (!cWeight) continue;

    const termIdf = idf(term, args.index);
    score += qWeight * cWeight * termIdf * termIdf;
    matchedTerms.push(term);
  }

  return { score, matchedTerms };
}

export function loadRagIndex(indexPath: string): RagIndex {
  const parsed = JSON.parse(readFileSync(path.resolve(indexPath), "utf8"));
  return RagIndexSchema.parse(parsed);
}

export function queryRagIndex(args: {
  index: RagIndex;
  query: string;
  topK?: number;
  filePathIncludes?: string;
}): RagQueryResult {
  const tokens = tokenize(args.query);
  const tf = queryTf(tokens);
  const hits: RagQueryHit[] = [];

  for (const chunk of args.index.chunks) {
    if (args.filePathIncludes && !chunk.filePath.includes(args.filePathIncludes)) {
      continue;
    }

    const scored = scoreChunk({
      index: args.index,
      queryTf: tf,
      chunkTf: chunk.termFreq,
    });

    if (scored.score <= 0) continue;

    hits.push({
      chunkId: chunk.id,
      filePath: chunk.filePath,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      score: scored.score,
      matchedTerms: scored.matchedTerms,
      excerpt: chunk.text.slice(0, 700),
    });
  }

  hits.sort((a, b) => b.score - a.score);

  return RagQueryResultSchema.parse({
    query: args.query,
    topK: Math.max(1, args.topK ?? 8),
    totalChunks: args.index.chunkCount,
    hits: hits.slice(0, Math.max(1, args.topK ?? 8)),
  });
}
