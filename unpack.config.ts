import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export type SplitPart = {
  content: string;
  title?: string;
  startLine?: number;
  endLine?: number;
};

const DEFAULT_MAX_SECTION_TOKENS = 40_000;
const DEFAULT_MIN_SPLIT_TOKENS = 80_000;

function countTokens(text: string): number {
  try {
    const mod = require("@dqbd/tiktoken") as {
      encoding_for_model?: (name: string) => { encode: (value: string) => number[]; free?: () => void };
      get_encoding?: (name: string) => { encode: (value: string) => number[]; free?: () => void };
    };

    let enc:
      | { encode: (value: string) => number[]; free?: () => void }
      | undefined;

    try {
      enc = mod.encoding_for_model?.("gpt-4o");
    } catch {
      enc = undefined;
    }

    if (!enc) {
      enc = mod.get_encoding?.("cl100k_base");
    }

    if (!enc) return Math.ceil(text.length / 4);
    const total = enc.encode(text).length;
    if (typeof enc.free === "function") enc.free();
    return total;
  } catch {
    return Math.ceil(text.length / 4);
  }
}

function trimHeading(line: string, prefix: string): string {
  const raw = line.slice(prefix.length).trim();
  return raw.replace(/^`/, "").replace(/`$/, "");
}

function headingTitle(line: string): string {
  const trimmed = line.trim();
  if (trimmed.startsWith("### ")) return trimHeading(trimmed, "### ");
  if (trimmed.startsWith("## ")) return trimHeading(trimmed, "## ");
  if (trimmed.startsWith("# ")) return trimHeading(trimmed, "# ");
  return "request";
}

function findLineIndex(lines: string[], needle: string): number {
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() === needle) return i;
  }
  return -1;
}

function splitByChecklistPattern(lines: string[]): SplitPart[] | null {
  const lineLevelIdx = findLineIndex(lines, "## Line-Level Inventory (All Python Files)");
  const checklistIdx = findLineIndex(lines, "## Per-File Parity Checklists (All Python Files)");

  if (lineLevelIdx === -1 || checklistIdx === -1 || checklistIdx <= lineLevelIdx) {
    return null;
  }

  const parts: SplitPart[] = [];

  if (lineLevelIdx > 0) {
    parts.push({
      content: lines.slice(0, lineLevelIdx).join("\n"),
      title: "overview",
      startLine: 1,
      endLine: lineLevelIdx,
    });
  }

  parts.push({
    content: lines.slice(lineLevelIdx, checklistIdx).join("\n"),
    title: "line-level-inventory",
    startLine: lineLevelIdx + 1,
    endLine: checklistIdx,
  });

  const boundaries: number[] = [checklistIdx];
  for (let i = checklistIdx + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith("### ")) boundaries.push(i);
  }
  boundaries.push(lines.length);

  let chunkStart = boundaries[0];
  let chunkEnd = boundaries[0];
  let chunkTokens = 0;

  for (let i = 0; i < boundaries.length - 1; i += 1) {
    const sectionStart = boundaries[i];
    const sectionEnd = boundaries[i + 1];
    const sectionText = lines.slice(sectionStart, sectionEnd).join("\n");
    const sectionTokens = countTokens(sectionText);
    const wouldExceed = chunkTokens > 0 && chunkTokens + sectionTokens > DEFAULT_MAX_SECTION_TOKENS;

    if (wouldExceed && chunkEnd > chunkStart) {
      parts.push({
        content: lines.slice(chunkStart, chunkEnd).join("\n"),
        title: headingTitle(lines[chunkStart] ?? "request"),
        startLine: chunkStart + 1,
        endLine: chunkEnd,
      });
      chunkStart = sectionStart;
      chunkEnd = sectionStart;
      chunkTokens = 0;
    }

    chunkEnd = sectionEnd;
    chunkTokens += sectionTokens;
  }

  if (chunkEnd > chunkStart) {
    parts.push({
      content: lines.slice(chunkStart, chunkEnd).join("\n"),
      title: headingTitle(lines[chunkStart] ?? "request"),
      startLine: chunkStart + 1,
      endLine: chunkEnd,
    });
  }

  return parts;
}

function splitByHeadings(lines: string[]): SplitPart[] {
  const headingIndexes: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line.startsWith("## ") || line.startsWith("### ")) headingIndexes.push(i);
  }

  if (headingIndexes.length === 0) {
    return [
      {
        content: lines.join("\n"),
        title: "request",
        startLine: 1,
        endLine: lines.length,
      },
    ];
  }

  const boundaries = [...headingIndexes, lines.length];
  const parts: SplitPart[] = [];

  for (let i = 0; i < boundaries.length - 1; i += 1) {
    const start = boundaries[i];
    const end = boundaries[i + 1];
    parts.push({
      content: lines.slice(start, end).join("\n"),
      title: headingTitle(lines[start] ?? "request"),
      startLine: start + 1,
      endLine: end,
    });
  }

  return parts;
}

export default {
  generate: {
    splitInput: (input: string): SplitPart[] | null => {
      if (!input) return null;

      const normalized = input.replace(/\r\n/g, "\n");
      if (countTokens(normalized) < DEFAULT_MIN_SPLIT_TOKENS) return null;

      const lines = normalized.split("\n");
      const checklistParts = splitByChecklistPattern(lines);
      if (checklistParts && checklistParts.length > 0) {
        return checklistParts;
      }

      return splitByHeadings(lines);
    },
  },
};
