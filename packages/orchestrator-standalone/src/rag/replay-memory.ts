import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { RagRefineResult } from "./types.js";

const RagReplayEntrySchema = z.object({
  seedKey: z.string(),
  seedQueries: z.array(z.string()).min(1),
  recommendedQueries: z.array(z.string()).default([]),
  topHitPaths: z.array(z.string()).default([]),
  score: z.number().nonnegative().default(0),
  successCount: z.number().int().positive().default(1),
  usageCount: z.number().int().positive().default(1),
  updatedAt: z.string(),
  stopReason: z.string().default("unknown"),
});

const RagReplayRetentionSchema = z.object({
  maxEntries: z.number().int().positive().default(240),
  maxAgeDays: z.number().int().positive().default(90),
  minScore: z.number().nonnegative().default(0),
  minSuccessCount: z.number().int().positive().default(1),
});

const RagReplayStateSchema = z.object({
  schemaVersion: z.literal("1.0"),
  fingerprint: z.string(),
  repoRoot: z.string(),
  recipeId: z.string(),
  updatedAt: z.string(),
  retention: RagReplayRetentionSchema.default({
    maxEntries: 240,
    maxAgeDays: 90,
    minScore: 0,
    minSuccessCount: 1,
  }),
  entries: z.array(RagReplayEntrySchema).default([]),
});

export type RagReplayEntry = z.infer<typeof RagReplayEntrySchema>;
export type RagReplayRetention = z.infer<typeof RagReplayRetentionSchema>;
export type RagReplayState = z.infer<typeof RagReplayStateSchema>;

function normalizeQuery(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function uniqueQueries(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = normalizeQuery(value);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function seedKey(seedQueries: string[]): string {
  return uniqueQueries(seedQueries).map((query) => query.toLowerCase()).sort().join("|");
}

function tokenize(value: string): Set<string> {
  const matches = value.toLowerCase().match(/[a-z0-9][a-z0-9_-]{1,}/g) ?? [];
  return new Set(matches);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let overlap = 0;
  for (const token of a) {
    if (b.has(token)) overlap += 1;
  }
  const union = a.size + b.size - overlap;
  return union === 0 ? 0 : overlap / union;
}

function deriveReplayQueries(refined: RagRefineResult): string[] {
  const out: string[] = [];
  for (const iteration of refined.iterations) {
    if (iteration.critique === "degrading") continue;
    out.push(...iteration.newQueries);
  }
  if (out.length === 0) {
    for (const iteration of refined.iterations) {
      out.push(...iteration.newQueries);
    }
  }
  return uniqueQueries(out).slice(0, 24);
}

function normalizePositiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const rounded = Math.trunc(value);
  return rounded > 0 ? rounded : fallback;
}

function normalizeNonNegative(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, value);
}

function resolveRetentionPolicy(args: {
  retentionMaxEntries?: number;
  retentionMaxAgeDays?: number;
  retentionMinScore?: number;
  retentionMinSuccessCount?: number;
}): RagReplayRetention {
  return RagReplayRetentionSchema.parse({
    maxEntries: normalizePositiveInt(args.retentionMaxEntries, 240),
    maxAgeDays: normalizePositiveInt(args.retentionMaxAgeDays, 90),
    minScore: normalizeNonNegative(args.retentionMinScore, 0),
    minSuccessCount: normalizePositiveInt(args.retentionMinSuccessCount, 1),
  });
}

function parseTimeMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function pruneEntries(args: {
  entries: RagReplayEntry[];
  retention: RagReplayRetention;
  nowMs: number;
}): RagReplayEntry[] {
  const maxAgeMs = args.retention.maxAgeDays * 24 * 60 * 60 * 1000;
  const minTimestamp = args.nowMs - maxAgeMs;

  return args.entries
    .filter((entry) => parseTimeMs(entry.updatedAt) >= minTimestamp)
    .filter((entry) => entry.score >= args.retention.minScore)
    .filter((entry) => entry.successCount >= args.retention.minSuccessCount)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.successCount !== a.successCount) return b.successCount - a.successCount;
      if (b.usageCount !== a.usageCount) return b.usageCount - a.usageCount;
      return parseTimeMs(b.updatedAt) - parseTimeMs(a.updatedAt);
    })
    .slice(0, args.retention.maxEntries);
}

export function ragReplayFingerprint(args: { repoRoot: string; recipeId: string }): string {
  const digest = createHash("sha1");
  digest.update(path.resolve(args.repoRoot));
  digest.update("|");
  digest.update(args.recipeId);
  return digest.digest("hex").slice(0, 20);
}

function defaultReplayPath(args: {
  workspaceRoot: string;
  recipeId: string;
  autonomyDir?: string;
}): string {
  const fingerprint = ragReplayFingerprint({ repoRoot: args.workspaceRoot, recipeId: args.recipeId });
  const autonomyDir = args.autonomyDir ?? "generated/orchestration/autonomy";
  return path.resolve(args.workspaceRoot, autonomyDir, "rag", "replay", `${fingerprint}.json`);
}

function loadReplay(pathAbs: string): RagReplayState | null {
  if (!existsSync(pathAbs)) return null;
  try {
    return RagReplayStateSchema.parse(JSON.parse(readFileSync(pathAbs, "utf8")));
  } catch {
    return null;
  }
}

export function suggestReplayQueries(args: {
  workspaceRoot: string;
  recipeId: string;
  seedQueries: string[];
  maxQueries?: number;
  autonomyDir?: string;
  memoryPath?: string;
  retentionMaxEntries?: number;
  retentionMaxAgeDays?: number;
  retentionMinScore?: number;
  retentionMinSuccessCount?: number;
}): {
  memoryPath: string;
  fingerprint: string;
  querySuggestions: string[];
  matchedEntries: number;
} {
  const fingerprint = ragReplayFingerprint({ repoRoot: args.workspaceRoot, recipeId: args.recipeId });
  const memoryPath = args.memoryPath
    ? path.resolve(args.workspaceRoot, args.memoryPath)
    : defaultReplayPath({
      workspaceRoot: args.workspaceRoot,
      recipeId: args.recipeId,
      autonomyDir: args.autonomyDir,
    });

  const state = loadReplay(memoryPath);
  if (!state) {
    return {
      memoryPath,
      fingerprint,
      querySuggestions: [],
      matchedEntries: 0,
    };
  }

  const retention = resolveRetentionPolicy({
    retentionMaxEntries: args.retentionMaxEntries,
    retentionMaxAgeDays: args.retentionMaxAgeDays,
    retentionMinScore: args.retentionMinScore,
    retentionMinSuccessCount: args.retentionMinSuccessCount,
  });
  const entries = pruneEntries({
    entries: state.entries,
    retention,
    nowMs: Date.now(),
  });

  const seedTokens = tokenize(uniqueQueries(args.seedQueries).join(" "));
  const ranked = new Map<string, number>();
  let matchedEntries = 0;

  for (const entry of entries) {
    const score = jaccard(seedTokens, tokenize(entry.seedQueries.join(" ")));
    if (score <= 0) continue;
    matchedEntries += 1;

    const entryWeight = Math.max(0.05, score) * Math.max(0.1, entry.score + 0.1) * Math.max(1, entry.successCount);
    for (const query of entry.recommendedQueries) {
      const key = normalizeQuery(query).toLowerCase();
      if (!key) continue;
      ranked.set(key, Math.max(ranked.get(key) ?? 0, entryWeight));
    }
  }

  const suggestions = Array.from(ranked.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(0, args.maxQueries ?? 6))
    .map(([query]) => query);

  return {
    memoryPath,
    fingerprint,
    querySuggestions: suggestions,
    matchedEntries,
  };
}

export function recordReplayOutcome(args: {
  workspaceRoot: string;
  recipeId: string;
  seedQueries: string[];
  refined: RagRefineResult;
  autonomyDir?: string;
  memoryPath?: string;
  retentionMaxEntries?: number;
  retentionMaxAgeDays?: number;
  retentionMinScore?: number;
  retentionMinSuccessCount?: number;
}): {
  memoryPath: string;
  fingerprint: string;
  entryCount: number;
} {
  const fingerprint = ragReplayFingerprint({ repoRoot: args.workspaceRoot, recipeId: args.recipeId });
  const memoryPath = args.memoryPath
    ? path.resolve(args.workspaceRoot, args.memoryPath)
    : defaultReplayPath({
      workspaceRoot: args.workspaceRoot,
      recipeId: args.recipeId,
      autonomyDir: args.autonomyDir,
    });

  const now = new Date().toISOString();
  const nowMs = Date.parse(now);
  const retention = resolveRetentionPolicy({
    retentionMaxEntries: args.retentionMaxEntries,
    retentionMaxAgeDays: args.retentionMaxAgeDays,
    retentionMinScore: args.retentionMinScore,
    retentionMinSuccessCount: args.retentionMinSuccessCount,
  });
  const existing = loadReplay(memoryPath);
  const entries = pruneEntries({
    entries: existing?.entries.slice() ?? [],
    retention,
    nowMs: Number.isFinite(nowMs) ? nowMs : Date.now(),
  });
  const key = seedKey(args.seedQueries);
  const recommendedQueries = deriveReplayQueries(args.refined);
  const topHitPaths = uniqueQueries(args.refined.hits.slice(0, 10).map((hit) => hit.filePath));
  const score = args.refined.iterations.length === 0
    ? 0
    : args.refined.iterations[args.refined.iterations.length - 1].avgTopScore;

  const idx = entries.findIndex((entry) => entry.seedKey === key);
  if (idx >= 0) {
    const current = entries[idx];
    entries[idx] = RagReplayEntrySchema.parse({
      ...current,
      seedQueries: uniqueQueries([...current.seedQueries, ...args.seedQueries]),
      recommendedQueries: uniqueQueries([...current.recommendedQueries, ...recommendedQueries]).slice(0, 36),
      topHitPaths: uniqueQueries([...current.topHitPaths, ...topHitPaths]).slice(0, 20),
      score: Math.max(current.score, score),
      successCount: current.successCount + 1,
      usageCount: current.usageCount + 1,
      updatedAt: now,
      stopReason: args.refined.budget.stopReason,
    });
  } else {
    entries.push(
      RagReplayEntrySchema.parse({
        seedKey: key,
        seedQueries: uniqueQueries(args.seedQueries),
        recommendedQueries,
        topHitPaths,
        score,
        successCount: 1,
        usageCount: 1,
        updatedAt: now,
        stopReason: args.refined.budget.stopReason,
      }),
    );
  }

  const state = RagReplayStateSchema.parse({
    schemaVersion: "1.0",
    fingerprint,
    repoRoot: path.resolve(args.workspaceRoot),
    recipeId: args.recipeId,
    updatedAt: now,
    retention,
    entries: pruneEntries({
      entries,
      retention,
      nowMs: Number.isFinite(nowMs) ? nowMs : Date.now(),
    }),
  });

  mkdirSync(path.dirname(memoryPath), { recursive: true });
  writeFileSync(memoryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

  return {
    memoryPath,
    fingerprint,
    entryCount: state.entries.length,
  };
}
