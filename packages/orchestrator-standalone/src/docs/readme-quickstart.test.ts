import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function sectionBetween(content: string, start: string, end: string): string {
  const startIndex = content.indexOf(start);
  if (startIndex < 0) {
    throw new Error(`Missing section start marker: ${start}`);
  }

  const endIndex = content.indexOf(end, startIndex);
  if (endIndex < 0) {
    throw new Error(`Missing section end marker: ${end}`);
  }

  return content.slice(startIndex, endIndex);
}

describe("README quickstart migration coverage", () => {
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const readmePath = path.resolve(testDir, "../../README.md");
  const readme = readFileSync(readmePath, "utf8");

  it("includes the recipe authoring guide cross-reference in step 2", () => {
    const section = sectionBetween(
      readme,
      "### 2. Create your own recipe",
      "### 3. Promote to apply mode",
    );

    expect(section).toContain("[Recipe Authoring Guide](#recipe-authoring-guide)");
  });

  it("adds a what's-next bridge with links to deeper docs", () => {
    const section = sectionBetween(readme, "### What's next", "## Commands");

    expect(section).toContain("[Recipe Authoring Guide](#recipe-authoring-guide)");
    expect(section).toContain("[Commands](#commands)");
    expect(section).toContain("[Advanced Runtime Controls](#advanced-runtime-controls)");
  });
});
