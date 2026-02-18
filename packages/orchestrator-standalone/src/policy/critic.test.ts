import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPolicyCriticConfig, resolvePolicyCriticRules } from "./critic.js";

describe("policy critic config", () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const target of cleanup.splice(0, cleanup.length)) {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("loads default empty config when no file exists", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-policy-critic-"));
    cleanup.push(root);

    const loaded = loadPolicyCriticConfig({ workspaceRoot: root });
    expect(loaded.path).toBeNull();

    const rules = resolvePolicyCriticRules({
      policyPackIds: ["security"],
      config: loaded.config,
    });
    expect(rules.some((rule) => rule.packId === "security")).toBe(true);
  });

  it("merges org overrides with built-in pack rules", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-policy-critic-override-"));
    cleanup.push(root);

    mkdirSync(path.join(root, ".orchestrator"), { recursive: true });
    writeFileSync(
      path.join(root, ".orchestrator", "policy-critic.json"),
      JSON.stringify({
        schemaVersion: "1.0",
        packs: {
          release: {
            template: "org release critic template",
            templateMode: "append",
            parsers: [
              {
                severity: "warning",
                regex: "release override marker",
                flags: "gi",
                messageTemplate: "override parser: {match}",
              },
            ],
          },
        },
      }),
      "utf8",
    );

    const loaded = loadPolicyCriticConfig({
      workspaceRoot: root,
      configPath: ".orchestrator/policy-critic.json",
    });
    const rules = resolvePolicyCriticRules({
      policyPackIds: ["release"],
      config: loaded.config,
    });

    expect(rules.length).toBe(1);
    expect(rules[0].template).toContain("org release critic template");
    expect(rules[0].parsers.some((parser) => parser.regex === "release override marker")).toBe(true);
  });

  it("throws when explicit config path is missing", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-policy-critic-missing-"));
    cleanup.push(root);

    expect(() =>
      loadPolicyCriticConfig({
        workspaceRoot: root,
        configPath: ".orchestrator/missing.json",
      }),
    ).toThrow(/Policy critic config file not found/i);
  });
});
