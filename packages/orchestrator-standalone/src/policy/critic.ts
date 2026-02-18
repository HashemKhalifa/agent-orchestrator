import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

export const PolicyCriticSeveritySchema = z.enum(["info", "warning", "blocker"]);

export const PolicyCriticParserSchema = z.object({
  severity: PolicyCriticSeveritySchema.default("warning"),
  regex: z.string().trim().min(1),
  flags: z.string().trim().default("gi"),
  messageTemplate: z.string().trim().optional(),
});

export const PolicyCriticPackOverrideSchema = z.object({
  template: z.string().trim().optional(),
  templateMode: z.enum(["replace", "append"]).default("append"),
  parsers: z.array(PolicyCriticParserSchema).default([]),
});

export const PolicyCriticConfigSchema = z.object({
  schemaVersion: z.literal("1.0").default("1.0"),
  packs: z.record(z.string(), PolicyCriticPackOverrideSchema).default({}),
});

export type PolicyCriticSeverity = z.infer<typeof PolicyCriticSeveritySchema>;
export type PolicyCriticParser = z.infer<typeof PolicyCriticParserSchema>;
export type PolicyCriticPackOverride = z.infer<typeof PolicyCriticPackOverrideSchema>;
export type PolicyCriticConfig = z.infer<typeof PolicyCriticConfigSchema>;

export interface ResolvedPolicyCriticRule {
  packId: string;
  template: string;
  parsers: PolicyCriticParser[];
}

const DEFAULT_POLICY_CRITIC_CONFIG_PATH = ".orchestrator/policy-critic.json";

const BUILTIN_RULES: Record<string, { template: string; parsers: PolicyCriticParser[] }> = {
  security: {
    template: [
      "Security review focus:",
      "- Validate auth/session and secret-management paths.",
      "- Confirm no new vulnerable dependency patterns were introduced.",
      "- If secrets/tokens/credentials are exposed, mark as blocker.",
    ].join("\n"),
    parsers: [
      {
        severity: "blocker",
        regex: "(hardcoded\\s+(secret|token|credential)|secret\\s+(leak|expos|commit)|auth\\s+bypass)",
        flags: "gi",
        messageTemplate: "Security blocker detected: {match}",
      },
      {
        severity: "warning",
        regex: "(xss|csrf|insecure\\s+cookie|dependency\\s+vulnerab|cve-\\d{4}-\\d+)",
        flags: "gi",
        messageTemplate: "Security warning detected: {match}",
      },
    ],
  },
  legal: {
    template: [
      "Legal/compliance review focus:",
      "- Check license and third-party attribution changes.",
      "- Check privacy/compliance wording updates.",
      "- Flag unresolved licensing conflicts as blocker.",
    ].join("\n"),
    parsers: [
      {
        severity: "blocker",
        regex: "(license\\s+conflict|copyleft\\s+incompatib|unapproved\\s+license)",
        flags: "gi",
        messageTemplate: "Legal blocker detected: {match}",
      },
      {
        severity: "warning",
        regex: "(license\\s+change|copyright|privacy\\s+policy|export\\s+control)",
        flags: "gi",
        messageTemplate: "Legal warning detected: {match}",
      },
    ],
  },
  release: {
    template: [
      "Release review focus:",
      "- Ensure rollout + rollback notes are coherent.",
      "- Confirm release metadata and changelog/versioning are correct.",
      "- Flag missing rollback readiness as blocker.",
    ].join("\n"),
    parsers: [
      {
        severity: "blocker",
        regex: "(rollback\\s+(missing|unverified|failed)|release\\s+blocker)",
        flags: "gi",
        messageTemplate: "Release blocker detected: {match}",
      },
      {
        severity: "warning",
        regex: "(version\\s+(mismatch|drift)|changelog\\s+missing|rollout\\s+risk)",
        flags: "gi",
        messageTemplate: "Release warning detected: {match}",
      },
    ],
  },
  infra: {
    template: [
      "Infrastructure review focus:",
      "- Validate workflow/runner/caching/deployment compatibility.",
      "- Confirm no outage-prone infra changes were introduced.",
      "- Flag downtime-causing rollout risks as blocker.",
    ].join("\n"),
    parsers: [
      {
        severity: "blocker",
        regex: "(service\\s+downtime|deployment\\s+outage|critical\\s+pipeline\\s+failure)",
        flags: "gi",
        messageTemplate: "Infrastructure blocker detected: {match}",
      },
      {
        severity: "warning",
        regex: "(ci\\s+instability|cache\\s+invalidat|infra\\s+drift|runner\\s+incompatib)",
        flags: "gi",
        messageTemplate: "Infrastructure warning detected: {match}",
      },
    ],
  },
};

function emptyConfig(): PolicyCriticConfig {
  return PolicyCriticConfigSchema.parse({
    schemaVersion: "1.0",
    packs: {},
  });
}

function normalizePackIds(packIds: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const packId of packIds) {
    const normalized = packId.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export function loadPolicyCriticConfig(args: {
  workspaceRoot: string;
  configPath?: string;
}): {
  config: PolicyCriticConfig;
  path: string | null;
} {
  const workspaceRoot = path.resolve(args.workspaceRoot);
  const requestedPath = args.configPath?.trim();
  const resolvedPath = requestedPath
    ? path.resolve(workspaceRoot, requestedPath)
    : path.resolve(workspaceRoot, DEFAULT_POLICY_CRITIC_CONFIG_PATH);

  if (!existsSync(resolvedPath)) {
    if (requestedPath) {
      throw new Error(`Policy critic config file not found: ${path.relative(workspaceRoot, resolvedPath)}`);
    }
    return {
      config: emptyConfig(),
      path: requestedPath ? resolvedPath : null,
    };
  }

  const parsed = JSON.parse(readFileSync(resolvedPath, "utf8"));
  return {
    config: PolicyCriticConfigSchema.parse(parsed),
    path: resolvedPath,
  };
}

export function resolvePolicyCriticRules(args: {
  policyPackIds: string[];
  config: PolicyCriticConfig;
}): ResolvedPolicyCriticRule[] {
  const rules: ResolvedPolicyCriticRule[] = [];

  for (const packId of normalizePackIds(args.policyPackIds)) {
    const builtin = BUILTIN_RULES[packId];
    const override = args.config.packs[packId];

    const builtinTemplate = builtin?.template ?? "";
    const overrideTemplate = override?.template?.trim() ?? "";
    const template = overrideTemplate
      ? override?.templateMode === "replace"
        ? overrideTemplate
        : [builtinTemplate, overrideTemplate].filter((line) => line.trim().length > 0).join("\n")
      : builtinTemplate;

    const parsers = [
      ...(builtin?.parsers ?? []),
      ...(override?.parsers ?? []),
    ];

    if (!template && parsers.length === 0) continue;

    rules.push({
      packId,
      template,
      parsers,
    });
  }

  return rules;
}
