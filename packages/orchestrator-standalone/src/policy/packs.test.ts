import { describe, expect, it } from "vitest";
import { getRecipeById } from "../recipes/catalog.js";
import { applyPolicyPacksToRecipe, listPolicyPacks } from "./packs.js";

describe("policy packs", () => {
  it("lists built-in policy packs", () => {
    const packs = listPolicyPacks();
    expect(packs.length).toBeGreaterThanOrEqual(4);
    expect(packs.some((pack) => pack.id === "security")).toBe(true);
  });

  it("injects policy gates into recipe", () => {
    const recipe = getRecipeById("ci-node-build-test-modernization");
    const applied = applyPolicyPacksToRecipe({
      recipe,
      policyPackIds: ["security", "release"],
    });

    expect(applied.appliedPacks.map((pack) => pack.id)).toEqual(["security", "release"]);
    expect(applied.recipe.gates.some((gate) => gate.id === "policy-security-signoff")).toBe(true);
    expect(applied.recipe.gates.some((gate) => gate.id === "policy-release-rollout-plan")).toBe(true);
    expect(applied.policyRules.length).toBeGreaterThan(0);
  });
});
