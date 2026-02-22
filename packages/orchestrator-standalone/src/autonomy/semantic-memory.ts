import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";

const SEMANTIC_SCHEMA_VERSION = "1.0";
const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_COMPACT_EVERY_EVENTS = 180;
const DEFAULT_COMPACT_MAX_PENDING_BYTES = 256 * 1024;
const DEFAULT_EVENT_READ_MAX_LINES = 6_000;

const MAX_DECISION_TEXT = 240;
const MAX_DETAIL_TEXT = 1_200;
const MAX_FAILURE_REASON_TEXT = 2_000;
const MAX_MITIGATION_TEXT = 1_200;

const SemanticDecisionSchema = z.object({
  timestamp: z.string(),
  runId: z.string(),
  decision: z.string(),
  detail: z.string(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

const SemanticFailureSchema = z.object({
  timestamp: z.string(),
  runId: z.string(),
  moduleId: z.string(),
  reason: z.string(),
  attempt: z.number().int().positive(),
});

const SemanticMitigationSchema = z.object({
  timestamp: z.string(),
  runId: z.string(),
  moduleId: z.string(),
  mitigation: z.string(),
  accepted: z.boolean(),
});

const SemanticStateSchema = z.object({
  schemaVersion: z.literal(SEMANTIC_SCHEMA_VERSION),
  fingerprint: z.string(),
  repoRoot: z.string(),
  recipeId: z.string(),
  updatedAt: z.string(),
  decisions: z.array(SemanticDecisionSchema).default([]),
  failedAttempts: z.array(SemanticFailureSchema).default([]),
  mitigations: z.array(SemanticMitigationSchema).default([]),
});

const SemanticEventBaseSchema = z.object({
  schemaVersion: z.literal(SEMANTIC_SCHEMA_VERSION),
  fingerprint: z.string(),
  repoRoot: z.string(),
  recipeId: z.string(),
  timestamp: z.string(),
  runId: z.string(),
});

const SemanticDecisionEventSchema = SemanticEventBaseSchema.extend({
  type: z.literal("decision"),
  decision: z.string(),
  detail: z.string(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

const SemanticFailureEventSchema = SemanticEventBaseSchema.extend({
  type: z.literal("failure"),
  moduleId: z.string(),
  reason: z.string(),
  attempt: z.number().int().positive(),
});

const SemanticMitigationEventSchema = SemanticEventBaseSchema.extend({
  type: z.literal("mitigation"),
  moduleId: z.string(),
  mitigation: z.string(),
  accepted: z.boolean(),
});

const SemanticEventSchema = z.discriminatedUnion("type", [
  SemanticDecisionEventSchema,
  SemanticFailureEventSchema,
  SemanticMitigationEventSchema,
]);

export type SemanticDecision = z.infer<typeof SemanticDecisionSchema>;
export type SemanticFailure = z.infer<typeof SemanticFailureSchema>;
export type SemanticMitigation = z.infer<typeof SemanticMitigationSchema>;
export type SemanticState = z.infer<typeof SemanticStateSchema>;
type SemanticEvent = z.infer<typeof SemanticEventSchema>;

function compactText(value: string, maxLen: number): string {
  return value
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, Math.max(1, maxLen));
}

function clampAtLeastInt(value: number | undefined, fallback: number, min: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.trunc(value));
}

export function semanticFingerprint(args: {
  repoRoot: string;
  recipeId: string;
  policyPacks?: string[];
}): string {
  const digest = createHash("sha1");
  digest.update(path.resolve(args.repoRoot));
  digest.update("|");
  digest.update(args.recipeId);
  digest.update("|");
  digest.update((args.policyPacks ?? []).sort().join(","));
  return digest.digest("hex").slice(0, 20);
}

function defaultMemoryPath(args: {
  workspaceRoot: string;
  autonomyDir?: string;
  fingerprint: string;
}): string {
  const autonomyDir = args.autonomyDir ?? "generated/orchestration/autonomy";
  return path.resolve(args.workspaceRoot, autonomyDir, "memory", `${args.fingerprint}.json`);
}

function eventsPathFromMemoryPath(memoryPath: string): string {
  return memoryPath.endsWith(".json")
    ? `${memoryPath.slice(0, Math.max(0, memoryPath.length - 5))}.events.ndjson`
    : `${memoryPath}.events.ndjson`;
}

function loadExisting(filePath: string): SemanticState | null {
  if (!existsSync(filePath)) return null;
  try {
    return SemanticStateSchema.parse(JSON.parse(readFileSync(filePath, "utf8")));
  } catch {
    return null;
  }
}

function readEventsLog(args: {
  eventsPath: string;
  fingerprint: string;
  maxLines?: number;
}): SemanticEvent[] {
  if (!existsSync(args.eventsPath)) return [];
  let raw = "";
  try {
    raw = readFileSync(args.eventsPath, "utf8");
  } catch {
    return [];
  }
  if (!raw.trim()) return [];

  const maxLines = clampAtLeastInt(args.maxLines, DEFAULT_EVENT_READ_MAX_LINES, 1);
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const sliced = lines.length > maxLines ? lines.slice(lines.length - maxLines) : lines;

  const events: SemanticEvent[] = [];
  for (const line of sliced) {
    try {
      const parsed = SemanticEventSchema.parse(JSON.parse(line));
      if (parsed.fingerprint !== args.fingerprint) continue;
      events.push(parsed);
    } catch {
      continue;
    }
  }
  return events;
}

function trimEntries<T>(input: T[], maxEntries: number): T[] {
  if (input.length <= maxEntries) return input;
  return input.slice(input.length - maxEntries);
}

function applySemanticEvents(args: {
  baseState: SemanticState;
  events: SemanticEvent[];
  maxEntries: number;
}): SemanticState {
  const decisions = args.baseState.decisions.slice();
  const failedAttempts = args.baseState.failedAttempts.slice();
  const mitigations = args.baseState.mitigations.slice();
  let updatedAt = args.baseState.updatedAt;

  for (const event of args.events) {
    updatedAt = event.timestamp;
    if (event.type === "decision") {
      decisions.push({
        timestamp: event.timestamp,
        runId: event.runId,
        decision: event.decision,
        detail: event.detail,
        metadata: event.metadata ?? {},
      });
      continue;
    }
    if (event.type === "failure") {
      failedAttempts.push({
        timestamp: event.timestamp,
        runId: event.runId,
        moduleId: event.moduleId,
        reason: event.reason,
        attempt: event.attempt,
      });
      continue;
    }
    mitigations.push({
      timestamp: event.timestamp,
      runId: event.runId,
      moduleId: event.moduleId,
      mitigation: event.mitigation,
      accepted: event.accepted,
    });
  }

  return SemanticStateSchema.parse({
    ...args.baseState,
    updatedAt,
    decisions: trimEntries(decisions, args.maxEntries),
    failedAttempts: trimEntries(failedAttempts, args.maxEntries),
    mitigations: trimEntries(mitigations, args.maxEntries),
  });
}

function eventSignature(event: SemanticEvent): string {
  if (event.type === "decision") {
    return `decision|${event.decision.toLowerCase()}|${event.detail.toLowerCase()}`;
  }
  if (event.type === "failure") {
    return `failure|${event.moduleId.toLowerCase()}|${event.attempt}|${event.reason.toLowerCase()}`;
  }
  return `mitigation|${event.moduleId.toLowerCase()}|${event.accepted ? "1" : "0"}|${event.mitigation.toLowerCase()}`;
}

function existingSignatures(state: SemanticState): Set<string> {
  const signatures = new Set<string>();
  for (const decision of state.decisions) {
    signatures.add(`decision|${decision.decision.toLowerCase()}|${decision.detail.toLowerCase()}`);
  }
  for (const failure of state.failedAttempts) {
    signatures.add(`failure|${failure.moduleId.toLowerCase()}|${failure.attempt}|${failure.reason.toLowerCase()}`);
  }
  for (const mitigation of state.mitigations) {
    signatures.add(
      `mitigation|${mitigation.moduleId.toLowerCase()}|${mitigation.accepted ? "1" : "0"}|${mitigation.mitigation.toLowerCase()}`,
    );
  }
  return signatures;
}

function emptyState(args: {
  workspaceRoot: string;
  recipeId: string;
  fingerprint: string;
}): SemanticState {
  return SemanticStateSchema.parse({
    schemaVersion: SEMANTIC_SCHEMA_VERSION,
    fingerprint: args.fingerprint,
    repoRoot: path.resolve(args.workspaceRoot),
    recipeId: args.recipeId,
    updatedAt: new Date(0).toISOString(),
    decisions: [],
    failedAttempts: [],
    mitigations: [],
  });
}

function fileSizeSafe(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}

export function readSemanticState(args: {
  workspaceRoot: string;
  recipeId: string;
  policyPacks?: string[];
  autonomyDir?: string;
  memoryPath?: string;
  maxEntries?: number;
  maxEventLines?: number;
}): {
  fingerprint: string;
  memoryPath: string;
  eventsPath: string;
  state: SemanticState | null;
  pendingEventCount: number;
  pendingEventBytes: number;
} {
  const fingerprint = semanticFingerprint({
    repoRoot: args.workspaceRoot,
    recipeId: args.recipeId,
    policyPacks: args.policyPacks,
  });
  const memoryPath = args.memoryPath
    ? path.resolve(args.workspaceRoot, args.memoryPath)
    : defaultMemoryPath({
      workspaceRoot: args.workspaceRoot,
      autonomyDir: args.autonomyDir,
      fingerprint,
    });
  const eventsPath = eventsPathFromMemoryPath(memoryPath);
  const maxEntries = clampAtLeastInt(args.maxEntries, DEFAULT_MAX_ENTRIES, 1);

  const snapshot = loadExisting(memoryPath);
  const effectiveFingerprint = snapshot?.fingerprint ?? fingerprint;
  const events = readEventsLog({
    eventsPath,
    fingerprint: effectiveFingerprint,
    maxLines: args.maxEventLines,
  });
  const pendingEventBytes = fileSizeSafe(eventsPath);

  if (!snapshot && events.length === 0) {
    return {
      fingerprint: effectiveFingerprint,
      memoryPath,
      eventsPath,
      state: null,
      pendingEventCount: 0,
      pendingEventBytes,
    };
  }

  const baseState = snapshot ?? emptyState({
    workspaceRoot: args.workspaceRoot,
    recipeId: args.recipeId,
    fingerprint: effectiveFingerprint,
  });
  const state = applySemanticEvents({
    baseState,
    events,
    maxEntries,
  });

  return {
    fingerprint: effectiveFingerprint,
    memoryPath,
    eventsPath,
    state,
    pendingEventCount: events.length,
    pendingEventBytes,
  };
}

export function recordSemanticState(args: {
  workspaceRoot: string;
  recipeId: string;
  runId: string;
  policyPacks?: string[];
  autonomyDir?: string;
  memoryPath?: string;
  maxEntries?: number;
  compactEveryEvents?: number;
  compactMaxPendingBytes?: number;
  decisions?: Array<Omit<SemanticDecision, "timestamp" | "runId">>;
  failedAttempts?: Array<Omit<SemanticFailure, "timestamp" | "runId">>;
  mitigations?: Array<Omit<SemanticMitigation, "timestamp" | "runId">>;
}): {
  fingerprint: string;
  memoryPath: string;
  eventsPath: string;
  state: SemanticState;
  pendingEventCount: number;
  compacted: boolean;
} {
  const loaded = readSemanticState({
    workspaceRoot: args.workspaceRoot,
    recipeId: args.recipeId,
    policyPacks: args.policyPacks,
    autonomyDir: args.autonomyDir,
    memoryPath: args.memoryPath,
    maxEntries: args.maxEntries,
  });
  const maxEntries = clampAtLeastInt(args.maxEntries, DEFAULT_MAX_ENTRIES, 1);
  const compactEveryEvents = clampAtLeastInt(args.compactEveryEvents, DEFAULT_COMPACT_EVERY_EVENTS, 1);
  const compactMaxPendingBytes = clampAtLeastInt(
    args.compactMaxPendingBytes,
    DEFAULT_COMPACT_MAX_PENDING_BYTES,
    1,
  );
  const now = new Date().toISOString();
  const baseState = loaded.state ?? emptyState({
    workspaceRoot: args.workspaceRoot,
    recipeId: args.recipeId,
    fingerprint: loaded.fingerprint,
  });
  const seenSignatures = existingSignatures(baseState);
  const newEvents: SemanticEvent[] = [];

  for (const decision of args.decisions ?? []) {
    const normalizedDecision = compactText(String(decision.decision ?? ""), MAX_DECISION_TEXT);
    const normalizedDetail = compactText(String(decision.detail ?? ""), MAX_DETAIL_TEXT);
    if (!normalizedDecision || !normalizedDetail) continue;
    const event = SemanticDecisionEventSchema.parse({
      schemaVersion: SEMANTIC_SCHEMA_VERSION,
      type: "decision",
      fingerprint: loaded.fingerprint,
      repoRoot: path.resolve(args.workspaceRoot),
      recipeId: args.recipeId,
      timestamp: now,
      runId: args.runId,
      decision: normalizedDecision,
      detail: normalizedDetail,
      metadata: decision.metadata ?? {},
    });
    const signature = eventSignature(event);
    if (seenSignatures.has(signature)) continue;
    seenSignatures.add(signature);
    newEvents.push(event);
  }

  for (const failure of args.failedAttempts ?? []) {
    const moduleId = compactText(String(failure.moduleId ?? ""), MAX_DECISION_TEXT);
    const reason = compactText(String(failure.reason ?? ""), MAX_FAILURE_REASON_TEXT);
    const attempt = clampAtLeastInt(failure.attempt, 1, 1);
    if (!moduleId || !reason) continue;
    const event = SemanticFailureEventSchema.parse({
      schemaVersion: SEMANTIC_SCHEMA_VERSION,
      type: "failure",
      fingerprint: loaded.fingerprint,
      repoRoot: path.resolve(args.workspaceRoot),
      recipeId: args.recipeId,
      timestamp: now,
      runId: args.runId,
      moduleId,
      reason,
      attempt,
    });
    const signature = eventSignature(event);
    if (seenSignatures.has(signature)) continue;
    seenSignatures.add(signature);
    newEvents.push(event);
  }

  for (const mitigation of args.mitigations ?? []) {
    const moduleId = compactText(String(mitigation.moduleId ?? ""), MAX_DECISION_TEXT);
    const mitigationText = compactText(String(mitigation.mitigation ?? ""), MAX_MITIGATION_TEXT);
    if (!moduleId || !mitigationText) continue;
    const event = SemanticMitigationEventSchema.parse({
      schemaVersion: SEMANTIC_SCHEMA_VERSION,
      type: "mitigation",
      fingerprint: loaded.fingerprint,
      repoRoot: path.resolve(args.workspaceRoot),
      recipeId: args.recipeId,
      timestamp: now,
      runId: args.runId,
      moduleId,
      mitigation: mitigationText,
      accepted: Boolean(mitigation.accepted),
    });
    const signature = eventSignature(event);
    if (seenSignatures.has(signature)) continue;
    seenSignatures.add(signature);
    newEvents.push(event);
  }

  mkdirSync(path.dirname(loaded.memoryPath), { recursive: true });
  mkdirSync(path.dirname(loaded.eventsPath), { recursive: true });
  if (newEvents.length > 0) {
    appendFileSync(loaded.eventsPath, `${newEvents.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
  }

  const nextState = applySemanticEvents({
    baseState,
    events: newEvents,
    maxEntries,
  });

  const pendingEventCount = loaded.pendingEventCount + newEvents.length;
  const pendingEventBytes = fileSizeSafe(loaded.eventsPath);
  const shouldCompact =
    args.memoryPath !== undefined ||
    !existsSync(loaded.memoryPath) ||
    pendingEventCount >= compactEveryEvents ||
    pendingEventBytes >= compactMaxPendingBytes;

  if (shouldCompact) {
    writeFileSync(loaded.memoryPath, `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
    writeFileSync(loaded.eventsPath, "", "utf8");
  }

  return {
    fingerprint: loaded.fingerprint,
    memoryPath: loaded.memoryPath,
    eventsPath: loaded.eventsPath,
    state: nextState,
    pendingEventCount: shouldCompact ? 0 : pendingEventCount,
    compacted: shouldCompact,
  };
}

function pruneByAge<T extends { timestamp: string }>(rows: T[], maxAgeDays: number | undefined): T[] {
  if (typeof maxAgeDays !== "number" || !Number.isFinite(maxAgeDays) || maxAgeDays <= 0) return rows;
  const cutoff = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);
  return rows.filter((row) => {
    const ts = Date.parse(row.timestamp);
    return Number.isFinite(ts) ? ts >= cutoff : true;
  });
}

export function compactSemanticMemory(args: {
  workspaceRoot: string;
  recipeId: string;
  policyPacks?: string[];
  autonomyDir?: string;
  memoryPath?: string;
  maxEntries?: number;
  maxAgeDays?: number;
}): {
  fingerprint: string;
  memoryPath: string;
  eventsPath: string;
  before: { decisions: number; failedAttempts: number; mitigations: number; pendingEventCount: number };
  after: { decisions: number; failedAttempts: number; mitigations: number; pendingEventCount: number };
} {
  const loaded = readSemanticState({
    workspaceRoot: args.workspaceRoot,
    recipeId: args.recipeId,
    policyPacks: args.policyPacks,
    autonomyDir: args.autonomyDir,
    memoryPath: args.memoryPath,
    maxEntries: args.maxEntries,
  });
  const baseState = loaded.state ?? emptyState({
    workspaceRoot: args.workspaceRoot,
    recipeId: args.recipeId,
    fingerprint: loaded.fingerprint,
  });
  const maxEntries = clampAtLeastInt(args.maxEntries, DEFAULT_MAX_ENTRIES, 1);

  const compacted = SemanticStateSchema.parse({
    ...baseState,
    updatedAt: new Date().toISOString(),
    decisions: trimEntries(pruneByAge(baseState.decisions, args.maxAgeDays), maxEntries),
    failedAttempts: trimEntries(pruneByAge(baseState.failedAttempts, args.maxAgeDays), maxEntries),
    mitigations: trimEntries(pruneByAge(baseState.mitigations, args.maxAgeDays), maxEntries),
  });

  mkdirSync(path.dirname(loaded.memoryPath), { recursive: true });
  mkdirSync(path.dirname(loaded.eventsPath), { recursive: true });
  writeFileSync(loaded.memoryPath, `${JSON.stringify(compacted, null, 2)}\n`, "utf8");
  writeFileSync(loaded.eventsPath, "", "utf8");

  return {
    fingerprint: loaded.fingerprint,
    memoryPath: loaded.memoryPath,
    eventsPath: loaded.eventsPath,
    before: {
      decisions: baseState.decisions.length,
      failedAttempts: baseState.failedAttempts.length,
      mitigations: baseState.mitigations.length,
      pendingEventCount: loaded.pendingEventCount,
    },
    after: {
      decisions: compacted.decisions.length,
      failedAttempts: compacted.failedAttempts.length,
      mitigations: compacted.mitigations.length,
      pendingEventCount: 0,
    },
  };
}
