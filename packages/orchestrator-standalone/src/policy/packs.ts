import {
  ExecutionRecipeSchema,
  type ExecutionRecipe,
  type GateDefinition,
} from "../spec/schemas.js";

export interface PolicyPack {
  id: string;
  title: string;
  description: string;
  rules: string[];
  gates: GateDefinition[];
  edgeCases: string[];
}

const POLICY_PACKS: PolicyPack[] = [
  {
    id: "security",
    title: "Security Hardening",
    description: "Require explicit security review evidence before completion.",
    rules: [
      "Do not introduce new critical/high vulnerabilities.",
      "Track dependency and auth-related changes in risk notes.",
    ],
    gates: [
      {
        id: "policy-security-signoff",
        title: "Security signoff artifact present",
        kind: "artifact",
        required: true,
        artifactPath: "generated/orchestration/policy/security-signoff.md",
        note: "Security reviewer signoff for migration/refactor changes.",
      },
    ],
    edgeCases: [
      "Security policy pack: validate auth/session and secret-handling paths were not regressed.",
    ],
  },
  {
    id: "legal",
    title: "Legal and Licensing",
    description: "Require legal approval artifacts for compliance-sensitive changes.",
    rules: [
      "Confirm dependency licensing impact for added/updated packages.",
      "Record export/privacy/legal constraints in evidence.",
    ],
    gates: [
      {
        id: "policy-legal-signoff",
        title: "Legal signoff artifact present",
        kind: "artifact",
        required: true,
        artifactPath: "generated/orchestration/policy/legal-signoff.md",
        note: "Legal/compliance reviewer signoff.",
      },
    ],
    edgeCases: [
      "Legal policy pack: third-party licensing delta must be reviewed and acknowledged.",
    ],
  },
  {
    id: "release",
    title: "Release Safety",
    description: "Add release-readiness checks and rollout notes as required artifacts.",
    rules: [
      "Require rollout plan and rollback notes before apply.",
      "Confirm release checklist for impacted services/packages.",
    ],
    gates: [
      {
        id: "policy-release-rollout-plan",
        title: "Release rollout plan artifact present",
        kind: "artifact",
        required: true,
        artifactPath: "generated/orchestration/policy/release-rollout-plan.md",
        note: "Rollout and rollback plan approved before final apply.",
      },
    ],
    edgeCases: [
      "Release policy pack: verify rollback command path stays executable after migration.",
    ],
  },
  {
    id: "infra",
    title: "Infrastructure Reliability",
    description: "Require infrastructure operational checklist evidence before completion.",
    rules: [
      "Capture infra risk notes for CI, caches, and deployment steps.",
      "Ensure monitoring/alerts impact is documented.",
    ],
    gates: [
      {
        id: "policy-infra-checklist",
        title: "Infra checklist artifact present",
        kind: "artifact",
        required: true,
        artifactPath: "generated/orchestration/policy/infra-checklist.md",
        note: "Operational readiness checklist completed.",
      },
    ],
    edgeCases: [
      "Infra policy pack: ensure CI cache and runner image compatibility after changes.",
    ],
  },
];

export function listPolicyPacks(): PolicyPack[] {
  return POLICY_PACKS.map((pack) => ({
    ...pack,
    rules: pack.rules.slice(),
    gates: pack.gates.slice(),
    edgeCases: pack.edgeCases.slice(),
  }));
}

export function getPolicyPackById(id: string): PolicyPack | null {
  const match = POLICY_PACKS.find((pack) => pack.id === id);
  if (!match) return null;

  return {
    ...match,
    rules: match.rules.slice(),
    gates: match.gates.slice(),
    edgeCases: match.edgeCases.slice(),
  };
}

export function applyPolicyPacksToRecipe(args: {
  recipe: ExecutionRecipe;
  policyPackIds: string[];
}): {
  recipe: ExecutionRecipe;
  appliedPacks: PolicyPack[];
  policyRules: string[];
} {
  const seen = new Set<string>();
  const requested = args.policyPackIds
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
    .filter((id) => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });

  if (requested.length === 0) {
    return {
      recipe: args.recipe,
      appliedPacks: [],
      policyRules: [],
    };
  }

  const appliedPacks = requested
    .map((id) => getPolicyPackById(id))
    .filter((pack): pack is PolicyPack => Boolean(pack));

  if (appliedPacks.length === 0) {
    return {
      recipe: args.recipe,
      appliedPacks: [],
      policyRules: [],
    };
  }

  const gateIds = new Set(args.recipe.gates.map((gate) => gate.id));
  const mergedGates = args.recipe.gates.slice();
  const edgeCases = new Set(args.recipe.edgeCases);
  const policyRules: string[] = [];

  for (const pack of appliedPacks) {
    for (const gate of pack.gates) {
      if (gateIds.has(gate.id)) continue;
      gateIds.add(gate.id);
      mergedGates.push(gate);
    }

    for (const edgeCase of pack.edgeCases) {
      edgeCases.add(edgeCase);
    }

    for (const rule of pack.rules) {
      policyRules.push(`${pack.id}: ${rule}`);
    }
  }

  const merged = ExecutionRecipeSchema.parse({
    ...args.recipe,
    gates: mergedGates,
    edgeCases: Array.from(edgeCases),
  });

  return {
    recipe: merged,
    appliedPacks,
    policyRules,
  };
}
