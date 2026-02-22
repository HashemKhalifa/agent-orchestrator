import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { RagRefineResult } from "./types.js";

const REPLAY_SCHEMA_VERSION = "1.0";
const DEFAULT_COMPACT_EVERY_EVENTS = 200;
const DEFAULT_COMPACT_MAX_PENDING_BYTES = 512 * 1024;
const DEFAULT_EVENT_READ_MAX_LINES = 5_000;
const MAX_QUERY_CHARS = 180;
const MAX_PATH_CHARS = 260;

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
  schemaVersion: z.literal(REPLAY_SCHEMA_VERSION),
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

const ReplayOutcomeEventSchema = z.object({
  schemaVersion: z.literal(REPLAY_SCHEMA_VERSION),
  type: z.literal("replay_outcome"),
  fingerprint: z.string(),
  repoRoot: z.string(),
  recipeId: z.string(),
  timestamp: z.string(),
  seedQueries: z.array(z.string()).min(1),
  recommendedQueries: z.array(z.string()).default([]),
  topHitPaths: z.array(z.string()).default([]),
  score: z.number().nonnegative().default(0),
  stopReason: z.string().default("unknown"),
});

export type RagReplayEntry = z.infer<typeof RagReplayEntrySchema>;
export type RagReplayRetention = z.infer<typeof RagReplayRetentionSchema>;
export type RagReplayState = z.infer<typeof RagReplayStateSchema>;
type ReplayOutcomeEvent = z.infer<typeof ReplayOutcomeEventSchema>;

function normalizeQuery(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, MAX_QUERY_CHARS);
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

function uniquePaths(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = normalizeQuery(value).slice(0, MAX_PATH_CHARS);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
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

function eventsPathFromMemoryPath(memoryPath: string): string {
  return memoryPath.endsWith(".json")
    ? `${memoryPath.slice(0, Math.max(0, memoryPath.length - 5))}.events.ndjson`
    : `${memoryPath}.events.ndjson`;
}

function fileSizeSafe(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}

function loadReplay(pathAbs: string): RagReplayState | null {
  if (!existsSync(pathAbs)) return null;
  try {
    return RagReplayStateSchema.parse(JSON.parse(readFileSync(pathAbs, "utf8")));
  } catch {
    return null;
  }
}

function readReplayEvents(args: {
  eventsPath: string;
  fingerprint: string;
  maxLines?: number;
}): ReplayOutcomeEvent[] {
  if (!existsSync(args.eventsPath)) return [];
  let raw = "";
  try {
    raw = readFileSync(args.eventsPath, "utf8");
  } catch {
    return [];
  }
  if (!raw.trim()) return [];

  const maxLines = normalizePositiveInt(args.maxLines, DEFAULT_EVENT_READ_MAX_LINES);
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const sliced = lines.length > maxLines ? lines.slice(lines.length - maxLines) : lines;

  const events: ReplayOutcomeEvent[] = [];
  for (const line of sliced) {
    try {
      const parsed = ReplayOutcomeEventSchema.parse(JSON.parse(line));
      if (parsed.fingerprint !== args.fingerprint) continue;
      events.push(parsed);
    } catch {
      continue;
    }
  }
  return events;
}

function emptyReplayState(args: {
  workspaceRoot: string;
  recipeId: string;
  fingerprint: string;
  retention: RagReplayRetention;
}): RagReplayState {
  return RagReplayStateSchema.parse({
    schemaVersion: REPLAY_SCHEMA_VERSION,
    fingerprint: args.fingerprint,
    repoRoot: path.resolve(args.workspaceRoot),
    recipeId: args.recipeId,
    updatedAt: new Date(0).toISOString(),
    retention: args.retention,
    entries: [],
  });
}

function applyReplayEvents(args: {
  baseState: RagReplayState;
  events: ReplayOutcomeEvent[];
}): RagReplayState {
  const byKey = new Map<string, RagReplayEntry>();
  for (const existing of args.baseState.entries) {
    byKey.set(existing.seedKey, existing);
  }

  let updatedAt = args.baseState.updatedAt;
  for (const event of args.events) {
    updatedAt = event.timestamp;
    const key = seedKey(event.seedQueries);
    const current = byKey.get(key);
    if (current) {
      byKey.set(
        key,
        RagReplayEntrySchema.parse({
          ...current,
          seedQueries: uniqueQueries([...current.seedQueries, ...event.seedQueries]).slice(0, 18),
          recommendedQueries: uniqueQueries([...current.recommendedQueries, ...event.recommendedQueries]).slice(0, 36),
          topHitPaths: uniquePaths([...current.topHitPaths, ...event.topHitPaths]).slice(0, 20),
          score: Math.max(current.score, event.score),
          successCount: current.successCount + 1,
          usageCount: current.usageCount + 1,
          updatedAt: event.timestamp,
          stopReason: event.stopReason,
        }),
      );
      continue;
    }

    byKey.set(
      key,
      RagReplayEntrySchema.parse({
        seedKey: key,
        seedQueries: uniqueQueries(event.seedQueries).slice(0, 18),
        recommendedQueries: uniqueQueries(event.recommendedQueries).slice(0, 36),
        topHitPaths: uniquePaths(event.topHitPaths).slice(0, 20),
        score: event.score,
        successCount: 1,
        usageCount: 1,
        updatedAt: event.timestamp,
        stopReason: event.stopReason,
      }),
    );
  }

  return RagReplayStateSchema.parse({
    ...args.baseState,
    updatedAt,
    entries: Array.from(byKey.values()),
  });
}

function readReplayState(args: {
  workspaceRoot: string;
  recipeId: string;
  autonomyDir?: string;
  memoryPath?: string;
  retentionMaxEntries?: number;
  retentionMaxAgeDays?: number;
  retentionMinScore?: number;
  retentionMinSuccessCount?: number;
  maxEventLines?: number;
}): {
  memoryPath: string;
  eventsPath: string;
  fingerprint: string;
  state: RagReplayState | null;
  pendingEventCount: number;
  pendingEventBytes: number;
} {
  const fingerprint = ragReplayFingerprint({ repoRoot: args.workspaceRoot, recipeId: args.recipeId });
  const memoryPath = args.memoryPath
    ? path.resolve(args.workspaceRoot, args.memoryPath)
    : defaultReplayPath({
      workspaceRoot: args.workspaceRoot,
      recipeId: args.recipeId,
      autonomyDir: args.autonomyDir,
    });
  const eventsPath = eventsPathFromMemoryPath(memoryPath);
  const snapshot = loadReplay(memoryPath);
  const effectiveFingerprint = snapshot?.fingerprint ?? fingerprint;
  const retention = resolveRetentionPolicy({
    retentionMaxEntries: args.retentionMaxEntries ?? snapshot?.retention.maxEntries,
    retentionMaxAgeDays: args.retentionMaxAgeDays ?? snapshot?.retention.maxAgeDays,
    retentionMinScore: args.retentionMinScore ?? snapshot?.retention.minScore,
    retentionMinSuccessCount: args.retentionMinSuccessCount ?? snapshot?.retention.minSuccessCount,
  });
  const events = readReplayEvents({
    eventsPath,
    fingerprint: effectiveFingerprint,
    maxLines: args.maxEventLines,
  });
  const pendingEventBytes = fileSizeSafe(eventsPath);

  if (!snapshot && events.length === 0) {
    return {
      memoryPath,
      eventsPath,
      fingerprint: effectiveFingerprint,
      state: null,
      pendingEventCount: 0,
      pendingEventBytes,
    };
  }

  const base = snapshot ?? emptyReplayState({
    workspaceRoot: args.workspaceRoot,
    recipeId: args.recipeId,
    fingerprint: effectiveFingerprint,
    retention,
  });
  const state = applyReplayEvents({
    baseState: RagReplayStateSchema.parse({
      ...base,
      retention,
    }),
    events,
  });

  return {
    memoryPath,
    eventsPath,
    fingerprint: effectiveFingerprint,
    state,
    pendingEventCount: events.length,
    pendingEventBytes,
  };
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
  const loaded = readReplayState({
    workspaceRoot: args.workspaceRoot,
    recipeId: args.recipeId,
    autonomyDir: args.autonomyDir,
    memoryPath: args.memoryPath,
    retentionMaxEntries: args.retentionMaxEntries,
    retentionMaxAgeDays: args.retentionMaxAgeDays,
    retentionMinScore: args.retentionMinScore,
    retentionMinSuccessCount: args.retentionMinSuccessCount,
  });
  if (!loaded.state) {
    return {
      memoryPath: loaded.memoryPath,
      fingerprint: loaded.fingerprint,
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
    entries: loaded.state.entries,
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
    memoryPath: loaded.memoryPath,
    fingerprint: loaded.fingerprint,
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
  const loaded = readReplayState({
    workspaceRoot: args.workspaceRoot,
    recipeId: args.recipeId,
    autonomyDir: args.autonomyDir,
    memoryPath: args.memoryPath,
    retentionMaxEntries: args.retentionMaxEntries,
    retentionMaxAgeDays: args.retentionMaxAgeDays,
    retentionMinScore: args.retentionMinScore,
    retentionMinSuccessCount: args.retentionMinSuccessCount,
  });

  const now = new Date().toISOString();
  const retention = resolveRetentionPolicy({
    retentionMaxEntries: args.retentionMaxEntries,
    retentionMaxAgeDays: args.retentionMaxAgeDays,
    retentionMinScore: args.retentionMinScore,
    retentionMinSuccessCount: args.retentionMinSuccessCount,
  });

  const baseState = loaded.state ?? emptyReplayState({
    workspaceRoot: args.workspaceRoot,
    recipeId: args.recipeId,
    fingerprint: loaded.fingerprint,
    retention,
  });
  const score = args.refined.iterations.length === 0
    ? 0
    : args.refined.iterations[args.refined.iterations.length - 1].avgTopScore;
  const event = ReplayOutcomeEventSchema.parse({
    schemaVersion: REPLAY_SCHEMA_VERSION,
    type: "replay_outcome",
    fingerprint: loaded.fingerprint,
    repoRoot: path.resolve(args.workspaceRoot),
    recipeId: args.recipeId,
    timestamp: now,
    seedQueries: uniqueQueries(args.seedQueries).slice(0, 18),
    recommendedQueries: deriveReplayQueries(args.refined),
    topHitPaths: uniquePaths(args.refined.hits.slice(0, 10).map((hit) => hit.filePath)),
    score,
    stopReason: args.refined.budget.stopReason,
  });

  mkdirSync(path.dirname(loaded.eventsPath), { recursive: true });
  appendFileSync(loaded.eventsPath, `${JSON.stringify(event)}\n`, "utf8");

  const stateWithEvent = applyReplayEvents({
    baseState,
    events: [event],
  });
  const nowMs = Date.now();
  const state = RagReplayStateSchema.parse({
    ...stateWithEvent,
    retention,
    entries: pruneEntries({
      entries: stateWithEvent.entries,
      retention,
      nowMs,
    }),
  });

  const pendingEventCount = loaded.pendingEventCount + 1;
  const pendingEventBytes = fileSizeSafe(loaded.eventsPath);
  const compactEveryEvents = DEFAULT_COMPACT_EVERY_EVENTS;
  const compactMaxPendingBytes = DEFAULT_COMPACT_MAX_PENDING_BYTES;
  const shouldCompact =
    args.memoryPath !== undefined ||
    !existsSync(loaded.memoryPath) ||
    pendingEventCount >= compactEveryEvents ||
    pendingEventBytes >= compactMaxPendingBytes;

  if (shouldCompact) {
    mkdirSync(path.dirname(loaded.memoryPath), { recursive: true });
    writeFileSync(loaded.memoryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    writeFileSync(loaded.eventsPath, "", "utf8");
  }

  return {
    memoryPath: loaded.memoryPath,
    fingerprint: loaded.fingerprint,
    entryCount: state.entries.length,
  };
}

export function compactReplayMemory(args: {
  workspaceRoot: string;
  recipeId: string;
  autonomyDir?: string;
  memoryPath?: string;
  retentionMaxEntries?: number;
  retentionMaxAgeDays?: number;
  retentionMinScore?: number;
  retentionMinSuccessCount?: number;
}): {
  memoryPath: string;
  eventsPath: string;
  fingerprint: string;
  before: { entryCount: number; pendingEventCount: number };
  after: { entryCount: number; pendingEventCount: number };
} {
  const loaded = readReplayState({
    workspaceRoot: args.workspaceRoot,
    recipeId: args.recipeId,
    autonomyDir: args.autonomyDir,
    memoryPath: args.memoryPath,
    retentionMaxEntries: args.retentionMaxEntries,
    retentionMaxAgeDays: args.retentionMaxAgeDays,
    retentionMinScore: args.retentionMinScore,
    retentionMinSuccessCount: args.retentionMinSuccessCount,
  });
  const retention = resolveRetentionPolicy({
    retentionMaxEntries: args.retentionMaxEntries ?? loaded.state?.retention.maxEntries,
    retentionMaxAgeDays: args.retentionMaxAgeDays ?? loaded.state?.retention.maxAgeDays,
    retentionMinScore: args.retentionMinScore ?? loaded.state?.retention.minScore,
    retentionMinSuccessCount: args.retentionMinSuccessCount ?? loaded.state?.retention.minSuccessCount,
  });
  const base = loaded.state ?? emptyReplayState({
    workspaceRoot: args.workspaceRoot,
    recipeId: args.recipeId,
    fingerprint: loaded.fingerprint,
    retention,
  });

  const compacted = RagReplayStateSchema.parse({
    ...base,
    updatedAt: new Date().toISOString(),
    retention,
    entries: pruneEntries({
      entries: base.entries,
      retention,
      nowMs: Date.now(),
    }),
  });

  mkdirSync(path.dirname(loaded.memoryPath), { recursive: true });
  mkdirSync(path.dirname(loaded.eventsPath), { recursive: true });
  writeFileSync(loaded.memoryPath, `${JSON.stringify(compacted, null, 2)}\n`, "utf8");
  writeFileSync(loaded.eventsPath, "", "utf8");

  return {
    memoryPath: loaded.memoryPath,
    eventsPath: loaded.eventsPath,
    fingerprint: loaded.fingerprint,
    before: {
      entryCount: base.entries.length,
      pendingEventCount: loaded.pendingEventCount,
    },
    after: {
      entryCount: compacted.entries.length,
      pendingEventCount: 0,
    },
  };
}
