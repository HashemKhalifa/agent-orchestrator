import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { autoGenerateSkills } from "./autogen.js";

describe("autoGenerateSkills", () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const target of cleanup.splice(0, cleanup.length)) {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("suggests and writes skills from repeated DAG patterns", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-skill-autogen-"));
    cleanup.push(root);

    const manifestPath = path.join(root, "generated", "dag", "manifest.json");
    mkdirSync(path.dirname(manifestPath), { recursive: true });

    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          schemaVersion: "1.0",
          name: "sample",
          description: "sample",
          requestPath: "request.md",
          generatedAt: new Date().toISOString(),
          dependencyMode: "staged",
          modules: [
            {
              id: "01-webpack",
              title: "Migrate webpack configs",
              description: "Webpack plugin compatibility",
              partPath: "parts/request.part01.md",
              mode: "implement",
              level: 0,
              dependsOn: [],
            },
            {
              id: "02-rsbuild",
              title: "Add rsbuild setup",
              description: "Rsbuild bundler migration",
              partPath: "parts/request.part02.md",
              mode: "implement",
              level: 1,
              dependsOn: ["01-webpack"],
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const preview = autoGenerateSkills({
      workspaceRoot: root,
      manifestPath: path.relative(root, manifestPath),
      minOccurrences: 2,
      apply: false,
    });

    expect(preview.candidates.some((candidate) => candidate.name === "autogen-build-migration")).toBe(true);

    const applied = autoGenerateSkills({
      workspaceRoot: root,
      manifestPath: path.relative(root, manifestPath),
      minOccurrences: 2,
      apply: true,
      outputDir: ".codex/skills/generated",
    });

    expect(applied.created.length).toBeGreaterThan(0);
    expect(existsSync(path.join(root, applied.created[0]))).toBe(true);
  });
});
