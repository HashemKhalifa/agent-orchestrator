import { readFileSync } from "node:fs";
import path from "node:path";

export type ExecutorProfile = "none" | "codex-safe" | "claude-safe";
export type ExecutorProvider = "codex" | "claude" | "custom";
export type ApplyMode = "dry-run" | "apply";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function renderTemplate(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce(
    (acc, [key, value]) => acc.replaceAll(`{${key}}`, value),
    template,
  );
}

function modeLine(applyMode: ApplyMode): string {
  return applyMode === "apply"
    ? "APPLY MODE: implement changes safely, add tests, and validate gates."
    : "DRY-RUN MODE: do not edit files; return an implementation plan and validation checklist.";
}

export function buildSafePrompt(args: {
  moduleId: string;
  title: string;
  partFile: string;
  requestPath: string;
  applyMode: ApplyMode;
}): string {
  return [
    `DAG module: ${args.moduleId}`,
    `Title: ${args.title}`,
    `Request path: ${args.requestPath}`,
    `Part file: ${args.partFile}`,
    modeLine(args.applyMode),
    "Package manager rule: prefer pnpm for install/run/test commands when available in this workspace.",
    "Always report exact commands run and outcomes.",
  ].join("\n");
}

function buildCodexProviderCommand(prompt: string): string {
  const base = process.env.ORCHESTRATOR_CODEX_EXECUTABLE?.trim() || "codex exec --full-auto";
  return `${base} ${shellQuote(prompt)}`;
}

function buildClaudeProviderCommand(prompt: string): string {
  const base = process.env.ORCHESTRATOR_CLAUDE_EXECUTABLE?.trim() || "claude -p";
  return `${base} ${shellQuote(prompt)}`;
}

function buildCustomProviderCommand(args: {
  template: string;
  prompt: string;
  moduleId: string;
  title: string;
  partFile: string;
  requestPath: string;
  applyMode: ApplyMode;
}): string {
  const rendered = renderTemplate(args.template, {
    prompt: args.prompt,
    moduleId: args.moduleId,
    title: args.title,
    partFile: args.partFile,
    requestPath: args.requestPath,
    applyMode: args.applyMode,
  });
  return rendered.includes("{prompt}") ? rendered.replaceAll("{prompt}", args.prompt) : rendered;
}

export function applyExecutorTemplate(template: string, args: {
  id: string;
  title: string;
  partFile: string;
  requestPath: string;
}): string {
  return renderTemplate(template, {
    id: args.id,
    title: args.title,
    partFile: args.partFile,
    requestPath: args.requestPath,
  });
}

export function buildProfileCommand(args: {
  profile: ExecutorProfile;
  applyMode: ApplyMode;
  moduleId: string;
  title: string;
  partFile: string;
  requestPath: string;
}): string | null {
  if (args.profile === "none") return null;

  const prompt = buildSafePrompt({
    moduleId: args.moduleId,
    title: args.title,
    partFile: args.partFile,
    requestPath: args.requestPath,
    applyMode: args.applyMode,
  });

  if (args.profile === "codex-safe") return buildCodexProviderCommand(prompt);
  if (args.profile === "claude-safe") return buildClaudeProviderCommand(prompt);
  return null;
}

export function buildProviderCommand(args: {
  provider: ExecutorProvider;
  applyMode: ApplyMode;
  moduleId: string;
  title: string;
  partFile: string;
  requestPath: string;
  providerTemplate?: string;
}): string {
  const prompt = buildSafePrompt({
    moduleId: args.moduleId,
    title: args.title,
    partFile: args.partFile,
    requestPath: args.requestPath,
    applyMode: args.applyMode,
  });

  if (args.provider === "codex") return buildCodexProviderCommand(prompt);
  if (args.provider === "claude") return buildClaudeProviderCommand(prompt);

  const template = args.providerTemplate?.trim() || process.env.ORCHESTRATOR_CUSTOM_EXECUTOR_TEMPLATE?.trim();
  if (!template) {
    throw new Error("Custom executor provider requires --provider-template or ORCHESTRATOR_CUSTOM_EXECUTOR_TEMPLATE.");
  }

  return buildCustomProviderCommand({
    template,
    prompt,
    moduleId: args.moduleId,
    title: args.title,
    partFile: path.resolve(args.partFile),
    requestPath: args.requestPath,
    applyMode: args.applyMode,
  });
}

export function isWaveApproved(approvalPath: string): boolean {
  try {
    const content = readFileSync(approvalPath, "utf8").trim();
    if (!content) return false;
    if (content.toLowerCase() === "approved") return true;
    const parsed = JSON.parse(content);
    return parsed?.approved === true;
  } catch {
    return false;
  }
}
