import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";

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
  schemaVersion: z.literal("1.0"),
  fingerprint: z.string(),
  repoRoot: z.string(),
  recipeId: z.string(),
  updatedAt: z.string(),
  decisions: z.array(SemanticDecisionSchema).default([]),
  failedAttempts: z.array(SemanticFailureSchema).default([]),
  mitigations: z.array(SemanticMitigationSchema).default([]),
});

export type SemanticDecision = z.infer<typeof SemanticDecisionSchema>;
export type SemanticFailure = z.infer<typeof SemanticFailureSchema>;
export type SemanticMitigation = z.infer<typeof SemanticMitigationSchema>;
export type SemanticState = z.infer<typeof SemanticStateSchema>;

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

function loadExisting(filePath: string): SemanticState | null {
  if (!existsSync(filePath)) return null;
  try {
    return SemanticStateSchema.parse(JSON.parse(readFileSync(filePath, "utf8")));
  } catch {
    return null;
  }
}

export function readSemanticState(args: {
  workspaceRoot: string;
  recipeId: string;
  policyPacks?: string[];
  autonomyDir?: string;
  memoryPath?: string;
}): {
  fingerprint: string;
  memoryPath: string;
  state: SemanticState | null;
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

  const state = loadExisting(memoryPath);
  return { fingerprint, memoryPath, state };
}

function trimEntries<T>(input: T[], maxEntries = 500): T[] {
  if (input.length <= maxEntries) return input;
  return input.slice(input.length - maxEntries);
}

export function recordSemanticState(args: {
  workspaceRoot: string;
  recipeId: string;
  runId: string;
  policyPacks?: string[];
  autonomyDir?: string;
  memoryPath?: string;
  decisions?: Array<Omit<SemanticDecision, "timestamp" | "runId">>;
  failedAttempts?: Array<Omit<SemanticFailure, "timestamp" | "runId">>;
  mitigations?: Array<Omit<SemanticMitigation, "timestamp" | "runId">>;
}): {
  fingerprint: string;
  memoryPath: string;
  state: SemanticState;
} {
  const loaded = readSemanticState({
    workspaceRoot: args.workspaceRoot,
    recipeId: args.recipeId,
    policyPacks: args.policyPacks,
    autonomyDir: args.autonomyDir,
    memoryPath: args.memoryPath,
  });

  const now = new Date().toISOString();

  const state = SemanticStateSchema.parse({
    schemaVersion: "1.0",
    fingerprint: loaded.fingerprint,
    repoRoot: path.resolve(args.workspaceRoot),
    recipeId: args.recipeId,
    updatedAt: now,
    decisions: [
      ...(loaded.state?.decisions ?? []),
      ...(args.decisions ?? []).map((decision) => ({
        timestamp: now,
        runId: args.runId,
        decision: decision.decision,
        detail: decision.detail,
        metadata: decision.metadata ?? {},
      })),
    ],
    failedAttempts: [
      ...(loaded.state?.failedAttempts ?? []),
      ...(args.failedAttempts ?? []).map((failure) => ({
        timestamp: now,
        runId: args.runId,
        moduleId: failure.moduleId,
        reason: failure.reason,
        attempt: failure.attempt,
      })),
    ],
    mitigations: [
      ...(loaded.state?.mitigations ?? []),
      ...(args.mitigations ?? []).map((mitigation) => ({
        timestamp: now,
        runId: args.runId,
        moduleId: mitigation.moduleId,
        mitigation: mitigation.mitigation,
        accepted: mitigation.accepted,
      })),
    ],
  });

  const trimmedState = SemanticStateSchema.parse({
    ...state,
    decisions: trimEntries(state.decisions),
    failedAttempts: trimEntries(state.failedAttempts),
    mitigations: trimEntries(state.mitigations),
  });

  mkdirSync(path.dirname(loaded.memoryPath), { recursive: true });
  writeFileSync(loaded.memoryPath, `${JSON.stringify(trimmedState, null, 2)}\n`, "utf8");

  return {
    fingerprint: loaded.fingerprint,
    memoryPath: loaded.memoryPath,
    state: trimmedState,
  };
}
