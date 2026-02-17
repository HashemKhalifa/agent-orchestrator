import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildProfileCommand, buildProviderCommand, isWaveApproved } from "./executors.js";

describe("dag executors", () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const target of cleanup.splice(0, cleanup.length)) {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("builds codex and claude profile commands", () => {
    const codex = buildProfileCommand({
      profile: "codex-safe",
      applyMode: "dry-run",
      moduleId: "m1",
      title: "Module 1",
      partFile: "part.md",
      requestPath: "request.md",
    });
    const claude = buildProfileCommand({
      profile: "claude-safe",
      applyMode: "apply",
      moduleId: "m2",
      title: "Module 2",
      partFile: "part2.md",
      requestPath: "request.md",
    });

    expect(codex).toContain("codex");
    expect(claude).toContain("claude");
  });

  it("builds custom provider command from template", () => {
    const command = buildProviderCommand({
      provider: "custom",
      providerTemplate: "runner --prompt {prompt} --module {moduleId}",
      applyMode: "dry-run",
      moduleId: "m3",
      title: "Module 3",
      partFile: "part.md",
      requestPath: "request.md",
    });

    expect(command).toContain("runner");
    expect(command).toContain("--module m3");
  });

  it("checks wave approval files", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-approval-test-"));
    cleanup.push(root);

    const approvedPath = path.join(root, "approved.json");
    const pendingPath = path.join(root, "pending.json");

    writeFileSync(approvedPath, JSON.stringify({ approved: true }), "utf8");
    writeFileSync(pendingPath, JSON.stringify({ approved: false }), "utf8");

    expect(isWaveApproved(approvedPath)).toBe(true);
    expect(isWaveApproved(pendingPath)).toBe(false);
  });
});
