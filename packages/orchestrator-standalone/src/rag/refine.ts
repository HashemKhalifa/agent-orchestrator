import { queryRagIndex } from "./retriever.js";
import { tokenize } from "./hybrid.js";
import {
  RagRefineResultSchema,
  type RagIndex,
  type RagQueryHit,
  type RagRefineResult,
} from "./types.js";

interface QueryScore {
  query: string;
  score: number;
}

function estimateTokens(value: string): number {
  if (!value) return 0;
  return Math.max(1, Math.ceil(value.length / 4));
}

function normalizePositive(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const rounded = Math.trunc(value);
  return rounded > 0 ? rounded : fallback;
}

function normalizeBudget(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const rounded = Math.trunc(value);
  return rounded >= 0 ? rounded : fallback;
}

function normalizeNonNegative(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, value);
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = value.trim().replace(/\s+/g, " ");
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function topTermsFromHits(hits: RagQueryHit[], limit: number): string[] {
  const scores = new Map<string, number>();

  for (const hit of hits) {
    for (const term of hit.matchedTerms) {
      const value = (scores.get(term) ?? 0) + Math.max(0, hit.score);
      scores.set(term, value);
    }

    const excerptTokens = tokenize(hit.excerpt).slice(0, 16);
    for (const term of excerptTokens) {
      const value = (scores.get(term) ?? 0) + Math.max(0, hit.score * 0.15);
      scores.set(term, value);
    }
  }

  return Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(1, limit))
    .map(([term]) => term);
}

function buildFollowUpQueries(args: {
  baseQueries: string[];
  topTerms: string[];
  maxNewQueries: number;
  seenQueries: Set<string>;
}): string[] {
  const rankedBase = args.baseQueries
    .map((query) => {
      const baseTokens = tokenize(query);
      return {
        query,
        tokenSet: new Set(baseTokens),
      };
    });

  const candidates: QueryScore[] = [];

  for (const base of rankedBase) {
    const baseTokens = tokenize(base.query).slice(0, 5);
    for (const term of args.topTerms) {
      if (base.tokenSet.has(term)) continue;

      const merged = uniqueStrings([...baseTokens, term]).slice(0, 6);
      if (merged.length === 0) continue;
      const candidate = merged.join(" ");
      const key = candidate.toLowerCase();
      if (args.seenQueries.has(key)) continue;

      const score = base.query.length + term.length;
      candidates.push({ query: candidate, score });
    }
  }

  return candidates
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, args.maxNewQueries))
    .map((item) => item.query);
}

function mergeHitsByChunkId(input: RagQueryHit[]): RagQueryHit[] {
  const byChunk = new Map<string, RagQueryHit>();

  for (const hit of input) {
    const existing = byChunk.get(hit.chunkId);
    if (!existing || hit.score > existing.score) {
      byChunk.set(hit.chunkId, hit);
      continue;
    }

    if (existing.score === hit.score) {
      const mergedTerms = Array.from(new Set([...existing.matchedTerms, ...hit.matchedTerms]));
      byChunk.set(hit.chunkId, {
        ...existing,
        matchedTerms: mergedTerms,
      });
    }
  }

  return Array.from(byChunk.values()).sort((a, b) => b.score - a.score);
}

function stopReasonFromBudget(args: {
  elapsedMs: number;
  maxRuntimeMs: number;
  usedTokens: number;
  maxTokenBudget: number;
  usedQueries: number;
  maxQueries: number;
  usedIterations: number;
  maxIterations: number;
  nextQueueSize: number;
}): string {
  if (args.elapsedMs >= args.maxRuntimeMs) return "runtime_budget_reached";
  if (args.usedTokens >= args.maxTokenBudget) return "token_budget_reached";
  if (args.usedQueries >= args.maxQueries) return "query_budget_reached";
  if (args.usedIterations >= args.maxIterations) return "iteration_limit_reached";
  if (args.nextQueueSize === 0) return "no_follow_up_queries";
  return "budget_remaining";
}

export function runAutoRefineQuery(args: {
  index: RagIndex;
  seedQueries: string[];
  topK?: number;
  filePathIncludes?: string;
  bm25Weight?: number;
  embeddingWeight?: number;
  maxIterations?: number;
  maxQueriesPerIteration?: number;
  maxQueries?: number;
  maxRuntimeMs?: number;
  maxTokenBudget?: number;
  maxTermsForExpansion?: number;
  maxFollowUpQueriesPerIteration?: number;
  convergenceEpsilon?: number;
  maxStallIterations?: number;
}): RagRefineResult {
  const topK = normalizePositive(args.topK, 8);
  const maxIterations = normalizePositive(args.maxIterations, 3);
  const maxQueriesPerIteration = normalizePositive(args.maxQueriesPerIteration, 4);
  const maxQueries = normalizePositive(args.maxQueries, 20);
  const maxRuntimeMs = normalizePositive(args.maxRuntimeMs, 5000);
  const configuredTokenBudget = normalizeBudget(args.maxTokenBudget, 12000);
  const maxTokenBudget = configuredTokenBudget === 0 ? Number.MAX_SAFE_INTEGER : configuredTokenBudget;
  const maxTermsForExpansion = normalizePositive(args.maxTermsForExpansion, 10);
  const maxFollowUp = normalizePositive(args.maxFollowUpQueriesPerIteration, 4);
  const convergenceEpsilon = normalizeNonNegative(args.convergenceEpsilon, 0.005);
  const maxStallIterations = normalizePositive(args.maxStallIterations, 2);

  const seedQueries = uniqueStrings(args.seedQueries);
  if (seedQueries.length === 0) {
    throw new Error("runAutoRefineQuery requires at least one seed query");
  }

  const startedAt = Date.now();
  const allHits: RagQueryHit[] = [];
  const iterations: RagRefineResult["iterations"] = [];
  const seenQueries = new Set<string>(seedQueries.map((query) => query.toLowerCase()));
  const seenChunkIds = new Set<string>();

  let queue = seedQueries.slice();
  let usedQueries = 0;
  let usedTokens = 0;
  let stalledIterations = 0;
  let previousAvgTopScore = 0;
  let stopReason = "budget_remaining";

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    if (queue.length === 0) {
      stopReason = "no_follow_up_queries";
      break;
    }
    if (usedQueries >= maxQueries) {
      stopReason = "query_budget_reached";
      break;
    }
    if (usedTokens >= maxTokenBudget) {
      stopReason = "token_budget_reached";
      break;
    }
    if (Date.now() - startedAt >= maxRuntimeMs) {
      stopReason = "runtime_budget_reached";
      break;
    }

    const cycleQueries = queue.slice(0, Math.min(maxQueriesPerIteration, maxQueries - usedQueries));
    queue = queue.slice(cycleQueries.length);

    const cycleHits: RagQueryHit[] = [];
    for (const query of cycleQueries) {
      if (Date.now() - startedAt >= maxRuntimeMs) break;
      if (usedQueries >= maxQueries) break;
      if (usedTokens >= maxTokenBudget) break;

      usedQueries += 1;
      usedTokens += estimateTokens(query);

      const result = queryRagIndex({
        index: args.index,
        query,
        topK,
        filePathIncludes: args.filePathIncludes,
        bm25Weight: args.bm25Weight,
        embeddingWeight: args.embeddingWeight,
      });

      cycleHits.push(...result.hits);
      usedTokens += result.hits.reduce((sum, hit) => sum + estimateTokens(hit.excerpt), 0);
    }

    allHits.push(...cycleHits);

    const mergedCycleHits = mergeHitsByChunkId(cycleHits);
    const topTerms = topTermsFromHits(mergedCycleHits.slice(0, topK), maxTermsForExpansion);

    const newQueries = buildFollowUpQueries({
      baseQueries: cycleQueries,
      topTerms,
      maxNewQueries: maxFollowUp,
      seenQueries,
    });

    for (const query of newQueries) {
      seenQueries.add(query.toLowerCase());
    }

    queue = uniqueStrings([...queue, ...newQueries]);

    const avgTopScore = mergedCycleHits.length === 0
      ? 0
      : mergedCycleHits.slice(0, topK).reduce((sum, hit) => sum + hit.score, 0) /
        Math.min(topK, mergedCycleHits.length);
    const newUniqueHits = mergedCycleHits.reduce((sum, hit) => {
      if (seenChunkIds.has(hit.chunkId)) return sum;
      seenChunkIds.add(hit.chunkId);
      return sum + 1;
    }, 0);
    const scoreDelta = avgTopScore - previousAvgTopScore;
    const critique = iteration === 1
      ? "cold_start"
      : scoreDelta > convergenceEpsilon
        ? "improving"
        : scoreDelta < -convergenceEpsilon
          ? "degrading"
          : "stalled";

    if (iteration > 1 && newUniqueHits === 0 && Math.abs(scoreDelta) <= convergenceEpsilon) {
      stalledIterations += 1;
    } else {
      stalledIterations = 0;
    }
    previousAvgTopScore = avgTopScore;

    iterations.push({
      iteration,
      queriesUsed: cycleQueries,
      newQueries,
      uniqueHitCount: mergedCycleHits.length,
      newUniqueHits,
      avgTopScore,
      scoreDelta,
      critique,
    });

    if (stalledIterations >= maxStallIterations) {
      stopReason = "converged";
      break;
    }
  }

  const mergedHits = mergeHitsByChunkId(allHits).slice(0, topK);
  const elapsedMs = Math.max(0, Date.now() - startedAt);
  if (stopReason === "budget_remaining") {
    stopReason = stopReasonFromBudget({
      elapsedMs,
      maxRuntimeMs,
      usedTokens,
      maxTokenBudget,
      usedQueries,
      maxQueries,
      usedIterations: iterations.length,
      maxIterations,
      nextQueueSize: queue.length,
    });
  }

  return RagRefineResultSchema.parse({
    seedQueries,
    aggregatedQuery: seedQueries.join(" | "),
    hits: mergedHits,
    iterations,
    budget: {
      maxIterations,
      maxQueries,
      maxRuntimeMs,
      maxTokenBudget: configuredTokenBudget,
      maxStallIterations,
      convergenceEpsilon,
      usedIterations: iterations.length,
      usedQueries,
      usedTokensEstimate: usedTokens,
      elapsedMs,
      stalledIterations,
      stopReason,
    },
  });
}
