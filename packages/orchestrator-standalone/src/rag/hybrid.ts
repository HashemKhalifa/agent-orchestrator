const STOP_WORDS = new Set([
  "the", "and", "for", "that", "with", "this", "from", "are", "was", "were", "will",
  "have", "has", "had", "into", "onto", "your", "you", "our", "their", "they", "them",
  "then", "than", "when", "where", "what", "which", "while", "does", "did", "done",
  "just", "also", "very", "much", "many", "more", "less", "some", "any", "not", "can",
  "could", "should", "would", "about", "after", "before", "during", "over", "under",
  "true", "false", "null", "undefined", "const", "let", "var", "function", "return",
  "import", "export", "class", "type", "interface", "public", "private", "static",
]);

function hashToken(input: string, seed = 2166136261): number {
  let hash = seed >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function tokenize(text: string): string[] {
  const matches = text.toLowerCase().match(/[a-z][a-z0-9_\-]{1,}/g) ?? [];
  const out: string[] = [];
  for (const token of matches) {
    if (STOP_WORDS.has(token)) continue;
    out.push(token);
  }
  return out;
}

export function toTermCounts(tokens: string[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }

  const out: Record<string, number> = {};
  for (const [term, count] of counts.entries()) {
    out[term] = count;
  }
  return out;
}

export function toTermFrequency(termCounts: Record<string, number>, tokenCount: number): Record<string, number> {
  if (tokenCount <= 0) return {};
  const out: Record<string, number> = {};
  for (const [term, count] of Object.entries(termCounts)) {
    out[term] = count / tokenCount;
  }
  return out;
}

export function buildEmbedding(termCounts: Record<string, number>, dims: number): number[] {
  const vector = new Array<number>(dims).fill(0);
  if (dims <= 0) return vector;

  for (const [term, count] of Object.entries(termCounts)) {
    const weight = 1 + Math.log(1 + count);
    const idx = hashToken(term) % dims;
    const sign = (hashToken(term, 1315423911) & 1) === 0 ? 1 : -1;
    vector[idx] += sign * weight;
  }

  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm <= 1e-12) return vector;
  return vector.map((value) => value / norm);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const size = Math.min(a.length, b.length);
  if (size === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < size; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA <= 1e-12 || normB <= 1e-12) return 0;
  return dot / Math.sqrt(normA * normB);
}

export function expandQueryTerms(tokens: string[]): string[] {
  const expansionMap: Record<string, string[]> = {
    migrate: ["migration", "upgrade", "convert"],
    migration: ["migrate", "upgrade", "cutover"],
    react: ["jsx", "hooks", "hydration"],
    webpack: ["bundler", "loader", "plugin"],
    rsbuild: ["rspack", "bundler"],
    jest: ["vitest", "test", "mock"],
    vitest: ["jest", "test", "runner"],
    memory: ["leak", "cleanup", "teardown"],
    performance: ["regression", "latency", "slow"],
  };

  const out = new Set<string>(tokens);
  for (const token of tokens) {
    for (const extra of expansionMap[token] ?? []) {
      out.add(extra);
    }
  }
  return Array.from(out);
}
