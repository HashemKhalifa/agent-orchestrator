import { URL } from "node:url";
import {
  type DiscoverySource,
  type InternetEvidenceItem,
  InternetEvidenceItemSchema,
  type SourcePolicy,
} from "../spec/schemas.js";

const KEYWORDS = [
  "breaking",
  "deprecat",
  "memory leak",
  "performance",
  "regression",
  "migration",
  "compatibility",
  "removed",
  "security",
];

function stripHtml(value: string): string {
  return value
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return null;
  return match[1].replace(/\s+/g, " ").trim().slice(0, 160) || null;
}

function detectSignals(text: string): string[] {
  const lowered = text.toLowerCase();
  const out: string[] = [];
  for (const keyword of KEYWORDS) {
    if (lowered.includes(keyword)) out.push(keyword);
  }
  return out;
}

function isAllowedByPolicy(args: {
  source: DiscoverySource;
  policy: SourcePolicy;
  curatedDomains: string[];
}): boolean {
  if (args.policy === "open_web") return true;
  if (args.policy === "primary_only") {
    return args.source.type === "primary";
  }

  if (args.source.type === "primary") return true;
  if (args.source.type !== "curated_secondary") return false;

  if (args.curatedDomains.length === 0) return true;

  try {
    const host = new URL(args.source.url).hostname.toLowerCase();
    return args.curatedDomains.some((domain) => {
      const normalized = domain.toLowerCase();
      return host === normalized || host.endsWith(`.${normalized}`);
    });
  } catch {
    return false;
  }
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(timeoutMs, 1));
  try {
    return await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": "orchestrator-standalone/1.0 (+https://local.dev)",
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function collectInternetEvidence(args: {
  sources: DiscoverySource[];
  policy: SourcePolicy;
  curatedDomains: string[];
  timeoutMs?: number;
}): Promise<InternetEvidenceItem[]> {
  const timeoutMs = args.timeoutMs ?? 7000;
  const evidence: InternetEvidenceItem[] = [];

  for (const source of args.sources) {
    if (!isAllowedByPolicy({
      source,
      policy: args.policy,
      curatedDomains: args.curatedDomains,
    })) {
      continue;
    }

    const fetchedAt = new Date().toISOString();

    try {
      const response = await fetchWithTimeout(source.url, timeoutMs);
      const raw = await response.text();
      const text = stripHtml(raw);
      const summary = text ? text.slice(0, 500) : null;
      const signals = detectSignals(text.slice(0, 6000));
      evidence.push(
        InternetEvidenceItemSchema.parse({
          sourceId: source.id,
          url: source.url,
          fetchedAt,
          ok: response.ok,
          statusCode: response.status,
          title: extractTitle(raw),
          summary,
          contentBytes: Buffer.byteLength(raw, "utf8"),
          detectedSignals: signals,
          error: response.ok ? null : `HTTP ${response.status}`,
        }),
      );
    } catch (error) {
      evidence.push(
        InternetEvidenceItemSchema.parse({
          sourceId: source.id,
          url: source.url,
          fetchedAt,
          ok: false,
          statusCode: null,
          title: null,
          summary: null,
          contentBytes: 0,
          detectedSignals: [],
          error: (error as Error).message,
        }),
      );
    }
  }

  return evidence;
}
