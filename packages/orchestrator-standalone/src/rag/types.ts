import { z } from "zod";

export const RagChunkSchema = z.object({
  id: z.string(),
  filePath: z.string(),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  text: z.string(),
  tokenCount: z.number().int().nonnegative(),
  termFreq: z.record(z.string(), z.number().nonnegative()).default({}),
  termCounts: z.record(z.string(), z.number().int().positive()).default({}),
  embedding: z.array(z.number()).default([]),
});

export const RagIndexSchema = z.object({
  schemaVersion: z.literal("1.0"),
  generatedAt: z.string(),
  workspaceRoot: z.string(),
  fileCount: z.number().int().nonnegative(),
  chunkCount: z.number().int().nonnegative(),
  vocabularyDf: z.record(z.string(), z.number().int().positive()),
  avgDocLength: z.number().positive().default(1),
  embeddingDims: z.number().int().positive().default(96),
  retrievalMode: z.enum(["tfidf", "hybrid_bm25_embedding"]).default("hybrid_bm25_embedding"),
  chunks: z.array(RagChunkSchema),
});

export const RagQueryHitSchema = z.object({
  chunkId: z.string(),
  filePath: z.string(),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  score: z.number(),
  bm25Score: z.number(),
  embeddingScore: z.number(),
  matchedTerms: z.array(z.string()),
  excerpt: z.string(),
});

export const RagQueryResultSchema = z.object({
  query: z.string(),
  topK: z.number().int().positive(),
  totalChunks: z.number().int().nonnegative(),
  hits: z.array(RagQueryHitSchema),
});

export type RagChunk = z.infer<typeof RagChunkSchema>;
export type RagIndex = z.infer<typeof RagIndexSchema>;
export type RagQueryHit = z.infer<typeof RagQueryHitSchema>;
export type RagQueryResult = z.infer<typeof RagQueryResultSchema>;
