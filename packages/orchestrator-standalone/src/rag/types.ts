import { z } from "zod";

export const RagChunkSchema = z.object({
  id: z.string(),
  filePath: z.string(),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  text: z.string(),
  tokenCount: z.number().int().nonnegative(),
  termFreq: z.record(z.string(), z.number().nonnegative()),
});

export const RagIndexSchema = z.object({
  schemaVersion: z.literal("1.0"),
  generatedAt: z.string(),
  workspaceRoot: z.string(),
  fileCount: z.number().int().nonnegative(),
  chunkCount: z.number().int().nonnegative(),
  vocabularyDf: z.record(z.string(), z.number().int().positive()),
  chunks: z.array(RagChunkSchema),
});

export const RagQueryHitSchema = z.object({
  chunkId: z.string(),
  filePath: z.string(),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  score: z.number(),
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
