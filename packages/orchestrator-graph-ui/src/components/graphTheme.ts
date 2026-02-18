import type { ModuleStatus } from "../types";

export function statusColor(status: ModuleStatus): string {
  switch (status) {
    case "success":
      return "#2ed08f";
    case "failed":
      return "#ff5f57";
    case "blocked":
      return "#ffbb55";
    case "skipped":
      return "#8fa0be";
    case "pending":
    default:
      return "#55b5ff";
  }
}

export function formatDuration(durationMs: number | undefined): string {
  if (durationMs == null) return "-";
  if (durationMs < 1_000) return `${Math.max(0, Math.round(durationMs))}ms`;
  return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)}s`;
}
