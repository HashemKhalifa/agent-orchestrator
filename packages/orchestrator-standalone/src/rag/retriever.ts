import { readFileSync } from "node:fs";
import path from "node:path";
import { buildEmbedding, cosineSimilarity, expandQueryTerms, toTermCounts, tokenize } from "./hybrid.js";
import {
  RagIndexSchema,
  RagQueryResultSchema,
  type RagChunk,
  type RagIndex,
  type RagQueryHit,
  type RagQueryResult,
} from "./types.js";

function idf(term: string, index: RagIndex): number {
  const df = index.vocabularyDf[term] ?? 0;
  const n = Math.max(1, index.chunkCount);
  return Math.log(1 + (n - df + 0.5) / (df + 0.5));
}

function chunkTermCounts(chunk: RagChunk): Record<string, number> {
  if (Object.keys(chunk.termCounts).length > 0) {
    return chunk.termCounts;
  }

  const reconstructed: Record<string, number> = {};
  const tokenCount = Math.max(1, chunk.tokenCount);
  for (const [term, freq] of Object.entries(chunk.termFreq)) {
    const count = Math.max(1, Math.round(freq * tokenCount));
    reconstructed[term] = count;
  }
  return reconstructed;
}

function bm25Score(args: {
  index: RagIndex;
  queryCounts: Record<string, number>;
  chunk: RagChunk;
  k1?: number;
  b?: number;
}): { score: number; matchedTerms: string[] } {
  const k1 = args.k1 ?? 1.2;
  const b = args.b ?? 0.75;
  const avgDl = Math.max(1, args.index.avgDocLength || 1);
  const dl = Math.max(1, args.chunk.tokenCount || 1);
  const counts = chunkTermCounts(args.chunk);

  let score = 0;
  const matchedTerms: string[] = [];

  for (const [term, qf] of Object.entries(args.queryCounts)) {
    const f = counts[term] ?? 0;
    if (f <= 0) continue;

    const tfPart = (f * (k1 + 1)) / (f + k1 * (1 - b + b * (dl / avgDl)));
    const qWeight = 1 + Math.log(1 + qf);
    score += idf(term, args.index) * tfPart * qWeight;
    matchedTerms.push(term);
  }

  return { score, matchedTerms };
}

function embeddingScore(args: {
  index: RagIndex;
  queryCounts: Record<string, number>;
  chunk: RagChunk;
}): number {
  const dims = Math.max(8, args.index.embeddingDims || 96);
  const queryVector = buildEmbedding(args.queryCounts, dims);
  const chunkVector = args.chunk.embedding.length > 0
    ? args.chunk.embedding
    : buildEmbedding(chunkTermCounts(args.chunk), dims);
  return cosineSimilarity(queryVector, chunkVector);
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
  bm25Weight?: number;
  embeddingWeight?: number;
}): RagQueryResult {
  const baseTokens = tokenize(args.query);
  const tokens = expandQueryTerms(baseTokens);
  const queryCounts = toTermCounts(tokens);
  const hits: RagQueryHit[] = [];

  const bm25Weight = Math.max(0, Math.min(1, args.bm25Weight ?? 0.75));
  const embeddingWeight = Math.max(0, Math.min(1, args.embeddingWeight ?? 0.25));

  for (const chunk of args.index.chunks) {
    if (args.filePathIncludes && !chunk.filePath.includes(args.filePathIncludes)) {
      continue;
    }

    const lexical = bm25Score({
      index: args.index,
      queryCounts,
      chunk,
    });

    if (lexical.matchedTerms.length === 0) continue;

    const semantic = embeddingScore({
      index: args.index,
      queryCounts,
      chunk,
    });

    const normalizedBm25 = lexical.score / (lexical.score + 1);
    const normalizedSemantic = Math.max(0, semantic);
    const score = normalizedBm25 * bm25Weight + normalizedSemantic * embeddingWeight;

    hits.push({
      chunkId: chunk.id,
      filePath: chunk.filePath,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      score,
      bm25Score: lexical.score,
      embeddingScore: semantic,
      matchedTerms: lexical.matchedTerms,
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
