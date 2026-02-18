import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateRecipeFromContext, scaffoldRecipeTemplate } from "./generator.js";
import {
  ExecutionRecipeSchema,
  ScaffoldRecipeInputSchema,
  ScaffoldRecipeOutputSchema,
  SCAFFOLD_OUTPUT_DIR,
  SCAFFOLD_OUTPUT_EXT,
  scaffoldOutputPath,
} from "../spec/schemas.js";

describe("generateRecipeFromContext", () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const target of cleanup.splice(0, cleanup.length)) {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("generates recipe JSON from workspace + discovery context", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-recipe-gen-"));
    cleanup.push(root);

    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "autogen-target",
        private: true,
        scripts: {
          build: "webpack",
          "test:run": "vitest run",
          typecheck: "tsc --noEmit",
        },
      }),
      "utf8",
    );
    writeFileSync(path.join(root, "webpack.config.js"), "module.exports = {};\n", "utf8");
    mkdirSync(path.join(root, "generated"), { recursive: true });

    const discoveryPath = path.join(root, "generated", "discovery.json");
    writeFileSync(
      discoveryPath,
      JSON.stringify(
        {
          localSummary: "webpack monorepo",
          internetEvidence: [
            {
              sourceId: "rsbuild-migrate",
              title: "Rsbuild migration guide",
              url: "https://rsbuild.dev/guide/migration/webpack",
              ok: true,
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await generateRecipeFromContext({
      workspaceRoot: root,
      goalType: "build_migration",
      recipeId: "autogen-webpack-rsbuild",
      discoveryPath,
      includeInternet: false,
      outputPath: "generated/recipes/autogen-webpack-rsbuild.json",
    });

    expect(result.recipe.id).toBe("autogen-webpack-rsbuild");
    expect(result.recipe.goalType).toBe("build_migration");
    expect(result.recipe.riskProbes.some((probe) => probe.id === "auto-webpack-custom-loader")).toBe(true);
    expect(result.outputPath).not.toBeNull();
    expect(existsSync(result.outputPath as string)).toBe(true);

    const raw = JSON.parse(readFileSync(result.outputPath as string, "utf8"));
    expect(raw.id).toBe("autogen-webpack-rsbuild");
  });
});

describe("scaffoldRecipeTemplate", () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const target of cleanup.splice(0, cleanup.length)) {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("creates a schema-valid scaffold and writes it to disk", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-recipe-scaffold-"));
    cleanup.push(root);

    writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "demo", private: true }, null, 2), "utf8");
    writeFileSync(path.join(root, "package-lock.json"), JSON.stringify({ lockfileVersion: 3 }, null, 2), "utf8");
    writeFileSync(path.join(root, "webpack.config.js"), "module.exports = {};\n", "utf8");

    const result = scaffoldRecipeTemplate({
      workspaceRoot: root,
      recipeId: "My New Recipe",
      goalType: "custom",
      outputPath: "generated/recipes/my-new-recipe.json",
    });

    expect(result.recipe.id).toBe("my-new-recipe");
    expect(result.recipe.preconditions.packageManagers).toEqual(["npm"]);
    expect(result.recipe.preconditions.requiresFiles).toContain("package.json");
    expect(result.recipe.preconditions.requiresBuildTools).toContain("webpack");
    expect(result.outputPath).not.toBeNull();
    expect(existsSync(result.outputPath as string)).toBe(true);

    const raw = JSON.parse(readFileSync(result.outputPath as string, "utf8"));
    expect(raw.id).toBe("my-new-recipe");
    expect(raw.steps.length).toBeGreaterThan(0);
  });

  it("falls back safely when package.json is missing", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-recipe-scaffold-nopkg-"));
    cleanup.push(root);

    const result = scaffoldRecipeTemplate({
      workspaceRoot: root,
      recipeId: "fallback-safe",
      outputPath: "generated/recipes/fallback-safe.json",
    });

    expect(result.recipe.preconditions.packageManagers).toEqual(["npm", "pnpm", "yarn", "unknown"]);
    expect(result.recipe.preconditions.requiresFiles).toEqual([]);
  });

  it("scaffold output conforms to ScaffoldRecipeOutputSchema", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-recipe-scaffold-contract-"));
    cleanup.push(root);

    const input = ScaffoldRecipeInputSchema.parse({
      workspaceRoot: root,
      recipeId: "contract-check",
    });

    const result = scaffoldRecipeTemplate(input);
    const parsed = ScaffoldRecipeOutputSchema.safeParse(result);
    expect(parsed.success).toBe(true);
  });

  it("blocks reserved ids that already exist in the recipe catalog", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-recipe-scaffold-reserved-"));
    cleanup.push(root);

    expect(() =>
      scaffoldRecipeTemplate({
        workspaceRoot: root,
        recipeId: "webpack-to-rsbuild-incremental",
        outputPath: "generated/recipes/conflict.json",
      })).toThrow(/already exists in catalog/);
  });
});

describe("scaffold CLI UX", () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const target of cleanup.splice(0, cleanup.length)) {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("normalizes mixed-case and special-char recipe ids for CLI consumers", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-scaffold-cli-normalize-"));
    cleanup.push(root);

    const result = scaffoldRecipeTemplate({
      workspaceRoot: root,
      recipeId: "My--Fancy  Recipe!!!",
      outputPath: scaffoldOutputPath("My--Fancy  Recipe!!!"),
    });

    expect(result.recipe.id).toBe("my-fancy-recipe");
    expect(result.outputPath).toMatch(/my-fancy-recipe\.json$/);
  });

  it("summary string is human-readable and includes step/gate counts", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-scaffold-cli-summary-"));
    cleanup.push(root);

    const result = scaffoldRecipeTemplate({
      workspaceRoot: root,
      recipeId: "summary-check",
    });

    expect(result.summary).toContain("summary-check");
    expect(result.summary).toMatch(/\d+ steps/);
    expect(result.summary).toMatch(/\d+ gates/);
  });

  it("refuses to overwrite existing output without --overwrite", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-scaffold-cli-overwrite-"));
    cleanup.push(root);

    const outputPath = scaffoldOutputPath("overwrite-guard");
    // First scaffold succeeds
    scaffoldRecipeTemplate({ workspaceRoot: root, recipeId: "overwrite-guard", outputPath });

    // Second scaffold without overwrite throws
    expect(() =>
      scaffoldRecipeTemplate({ workspaceRoot: root, recipeId: "overwrite-guard", outputPath }),
    ).toThrow(/overwrite/i);
  });

  it("allows overwrite when overwrite flag is set", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-scaffold-cli-overwrite-ok-"));
    cleanup.push(root);

    const outputPath = scaffoldOutputPath("overwrite-ok");
    scaffoldRecipeTemplate({ workspaceRoot: root, recipeId: "overwrite-ok", outputPath });

    const result = scaffoldRecipeTemplate({
      workspaceRoot: root,
      recipeId: "overwrite-ok",
      outputPath,
      overwrite: true,
    });
    expect(result.recipe.id).toBe("overwrite-ok");
    expect(existsSync(result.outputPath as string)).toBe(true);
  });

  it("written JSON file round-trips through ExecutionRecipeSchema", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-scaffold-cli-roundtrip-"));
    cleanup.push(root);

    const outputPath = scaffoldOutputPath("roundtrip-test");
    const result = scaffoldRecipeTemplate({ workspaceRoot: root, recipeId: "roundtrip-test", outputPath });

    const raw = JSON.parse(readFileSync(result.outputPath as string, "utf8"));
    const parsed = ExecutionRecipeSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
  });

  it("rejects recipe-id with no alphanumeric characters", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-scaffold-cli-badid-"));
    cleanup.push(root);

    expect(() =>
      scaffoldRecipeTemplate({ workspaceRoot: root, recipeId: "---!!!" }),
    ).toThrow(/alphanumeric/);
  });

  it("optional title and description override defaults", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-scaffold-cli-title-"));
    cleanup.push(root);

    const result = scaffoldRecipeTemplate({
      workspaceRoot: root,
      recipeId: "titled-recipe",
      title: "Custom Title Here",
      description: "Custom description for the recipe.",
    });

    expect(result.recipe.title).toBe("Custom Title Here");
    expect(result.recipe.description).toBe("Custom description for the recipe.");
  });

  it("goalType flows through to the scaffolded recipe", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-scaffold-cli-goal-"));
    cleanup.push(root);

    const result = scaffoldRecipeTemplate({
      workspaceRoot: root,
      recipeId: "goal-flow",
      goalType: "ci_refactor",
    });

    expect(result.recipe.goalType).toBe("ci_refactor");
    expect(result.recipe.steps.some((s) => s.id === "refactor-ci")).toBe(true);
  });
});

describe("scaffold contract", () => {
  it("minimal required inputs: only workspaceRoot and recipeId", () => {
    const parsed = ScaffoldRecipeInputSchema.safeParse({
      workspaceRoot: "/tmp/test",
      recipeId: "my-recipe",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects missing workspaceRoot", () => {
    const parsed = ScaffoldRecipeInputSchema.safeParse({ recipeId: "x" });
    expect(parsed.success).toBe(false);
  });

  it("rejects missing recipeId", () => {
    const parsed = ScaffoldRecipeInputSchema.safeParse({ workspaceRoot: "/tmp" });
    expect(parsed.success).toBe(false);
  });

  it("accepts conventional output path under generated/recipes/", () => {
    const parsed = ScaffoldRecipeInputSchema.safeParse({
      workspaceRoot: "/tmp",
      recipeId: "test",
      outputPath: "generated/recipes/test.json",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects output path not under generated/recipes/", () => {
    const parsed = ScaffoldRecipeInputSchema.safeParse({
      workspaceRoot: "/tmp",
      recipeId: "test",
      outputPath: "other/dir/test.json",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects output path not ending in .json", () => {
    const parsed = ScaffoldRecipeInputSchema.safeParse({
      workspaceRoot: "/tmp",
      recipeId: "test",
      outputPath: "generated/recipes/test.yaml",
    });
    expect(parsed.success).toBe(false);
  });

  it("scaffoldOutputPath produces conventional path", () => {
    expect(scaffoldOutputPath("My New Recipe")).toBe(
      `${SCAFFOLD_OUTPUT_DIR}/my-new-recipe${SCAFFOLD_OUTPUT_EXT}`,
    );
  });

  it("scaffoldOutputPath handles edge-case ids", () => {
    expect(scaffoldOutputPath("---")).toBe(`${SCAFFOLD_OUTPUT_DIR}/recipe${SCAFFOLD_OUTPUT_EXT}`);
    expect(scaffoldOutputPath("UPPERCASE")).toBe(`${SCAFFOLD_OUTPUT_DIR}/uppercase${SCAFFOLD_OUTPUT_EXT}`);
  });

  it("end-to-end: scaffold with conventional output passes all gates", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-scaffold-contract-e2e-"));
    const input = ScaffoldRecipeInputSchema.parse({
      workspaceRoot: root,
      recipeId: "e2e-contract",
      outputPath: scaffoldOutputPath("e2e-contract"),
    });
    const result = scaffoldRecipeTemplate(input);
    const outputValid = ScaffoldRecipeOutputSchema.safeParse(result);
    expect(outputValid.success).toBe(true);
    expect(result.outputPath).not.toBeNull();
    expect(existsSync(result.outputPath as string)).toBe(true);

    // Verify file is valid JSON conforming to ExecutionRecipeSchema
    const raw = JSON.parse(readFileSync(result.outputPath as string, "utf8"));
    expect(raw.id).toBe("e2e-contract");
    expect(raw.steps.length).toBeGreaterThan(0);
    expect(raw.gates.length).toBeGreaterThan(0);

    rmSync(root, { recursive: true, force: true });
  });
});
