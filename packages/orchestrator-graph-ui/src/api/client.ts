import type { RunStateResponse } from "../types";

export async function fetchRunState(args: {
  workspaceRoot: string;
  autonomyDir: string;
  mode: "v1" | "v2" | "auto";
  runId?: string;
}): Promise<RunStateResponse> {
  const params = new URLSearchParams({
    workspaceRoot: args.workspaceRoot,
    autonomyDir: args.autonomyDir,
    mode: args.mode,
  });
  if (args.runId && args.runId.trim().length > 0) {
    params.set("runId", args.runId.trim());
  }

  const response = await fetch(`/api/run-state?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`run-state request failed: ${response.status}`);
  }

  const payload = (await response.json()) as RunStateResponse;
  return payload;
}

export function subscribeRunState(
  args: {
    workspaceRoot: string;
    autonomyDir: string;
    mode: "v1" | "v2" | "auto";
    runId?: string;
    intervalMs: number;
  },
  handlers: {
    onState: (state: RunStateResponse) => void;
    onError: (message: string) => void;
  },
): () => void {
  const params = new URLSearchParams({
    workspaceRoot: args.workspaceRoot,
    autonomyDir: args.autonomyDir,
    mode: args.mode,
    intervalMs: String(Math.max(500, Math.round(args.intervalMs))),
  });
  if (args.runId && args.runId.trim().length > 0) {
    params.set("runId", args.runId.trim());
  }

  const source = new EventSource(`/api/stream?${params.toString()}`);

  const onState = (event: MessageEvent<string>) => {
    try {
      const payload = JSON.parse(event.data) as RunStateResponse;
      handlers.onState(payload);
    } catch (error) {
      handlers.onError(error instanceof Error ? error.message : String(error));
    }
  };

  source.addEventListener("run-state", onState as EventListener);
  source.addEventListener("run-error", onState as EventListener);
  source.onerror = () => {
    handlers.onError("stream disconnected");
  };

  return () => {
    source.removeEventListener("run-state", onState as EventListener);
    source.removeEventListener("run-error", onState as EventListener);
    source.close();
  };
}
