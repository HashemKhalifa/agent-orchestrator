#!/usr/bin/env bash
set -euo pipefail

PROVIDER="${1:-}"
STDOUT_FILE="${2:-}"
STDERR_FILE="${3:-}"

if [[ -z "$PROVIDER" || -z "$STDOUT_FILE" || -z "$STDERR_FILE" ]]; then
  echo "usage: emit-token-receipt.sh <provider> <stdout-file> <stderr-file>" >&2
  exit 2
fi

node - "$PROVIDER" "$STDOUT_FILE" "$STDERR_FILE" <<'NODE'
const fs = require("node:fs");

const provider = process.argv[2];
const stdoutFile = process.argv[3];
const stderrFile = process.argv[4];

function readSafe(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function parseLastInt(input, regex) {
  const re = new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : `${regex.flags}g`);
  let match;
  let value = null;
  while ((match = re.exec(input)) !== null) {
    const next = Number(match[1]);
    if (Number.isFinite(next) && next >= 0) value = Math.trunc(next);
  }
  return value;
}

const blob = `${readSafe(stdoutFile)}\n${readSafe(stderrFile)}`;
if (!blob.trim()) process.exit(0);

const total =
  parseLastInt(blob, /"total_tokens"\s*:\s*(\d+)/i) ??
  parseLastInt(blob, /"totalTokens"\s*:\s*(\d+)/i) ??
  parseLastInt(blob, /\btotal[_\s-]?tokens?\s*[:=]\s*(\d+)/i);

const prompt =
  parseLastInt(blob, /"prompt_tokens"\s*:\s*(\d+)/i) ??
  parseLastInt(blob, /"input_tokens"\s*:\s*(\d+)/i) ??
  parseLastInt(blob, /"promptTokens"\s*:\s*(\d+)/i) ??
  parseLastInt(blob, /"inputTokens"\s*:\s*(\d+)/i) ??
  parseLastInt(blob, /\b(?:prompt|input)[_\s-]?tokens?\s*[:=]\s*(\d+)/i);

const completion =
  parseLastInt(blob, /"completion_tokens"\s*:\s*(\d+)/i) ??
  parseLastInt(blob, /"output_tokens"\s*:\s*(\d+)/i) ??
  parseLastInt(blob, /"completionTokens"\s*:\s*(\d+)/i) ??
  parseLastInt(blob, /"outputTokens"\s*:\s*(\d+)/i) ??
  parseLastInt(blob, /\b(?:completion|output)[_\s-]?tokens?\s*[:=]\s*(\d+)/i);

if (typeof total !== "number" && typeof prompt !== "number" && typeof completion !== "number") {
  process.exit(0);
}

const payload = {
  orchestrator_token_receipt: {
    provider,
    prompt_tokens: typeof prompt === "number" ? prompt : null,
    completion_tokens: typeof completion === "number" ? completion : null,
    total_tokens: typeof total === "number" ? total : Math.max(0, (prompt ?? 0) + (completion ?? 0)),
    observed_at: new Date().toISOString(),
  },
};

process.stdout.write(`${JSON.stringify(payload)}\n`);
NODE
