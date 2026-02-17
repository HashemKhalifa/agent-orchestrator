import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateRecipeFromContext } from "./generator.js";

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
