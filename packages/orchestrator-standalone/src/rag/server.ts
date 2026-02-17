import http from "node:http";
import { URL } from "node:url";
import { loadRagIndex, queryRagIndex } from "./retriever.js";

function sendJson(res: http.ServerResponse, code: number, payload: unknown): void {
  res.statusCode = code;
  res.setHeader("content-type", "application/json");
  res.end(`${JSON.stringify(payload, null, 2)}\n`);
}

export function startRagServer(args: {
  indexPath: string;
  host?: string;
  port?: number;
}): http.Server {
  const host = args.host ?? "127.0.0.1";
  const port = args.port ?? 8787;
  const index = loadRagIndex(args.indexPath);

  const server = http.createServer((req, res) => {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", `http://${host}:${port}`);

    if (method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, {
        ok: true,
        schemaVersion: index.schemaVersion,
        generatedAt: index.generatedAt,
      });
    }

    if (method === "GET" && url.pathname === "/index-info") {
      return sendJson(res, 200, {
        fileCount: index.fileCount,
        chunkCount: index.chunkCount,
        retrievalMode: index.retrievalMode,
        embeddingDims: index.embeddingDims,
        generatedAt: index.generatedAt,
      });
    }

    if (method === "GET" && url.pathname === "/query") {
      const query = url.searchParams.get("q") ?? "";
      if (!query.trim()) {
        return sendJson(res, 400, { error: "missing query parameter 'q'" });
      }

      const topKRaw = Number(url.searchParams.get("k") ?? 8);
      const topK = Number.isFinite(topKRaw) && topKRaw > 0 ? Math.floor(topKRaw) : 8;
      const filePathIncludes = url.searchParams.get("path") ?? undefined;
      const bm25WeightRaw = Number(url.searchParams.get("bm25Weight") ?? 0.75);
      const embeddingWeightRaw = Number(url.searchParams.get("embeddingWeight") ?? 0.25);

      const result = queryRagIndex({
        index,
        query,
        topK,
        filePathIncludes,
        bm25Weight: Number.isFinite(bm25WeightRaw) ? bm25WeightRaw : 0.75,
        embeddingWeight: Number.isFinite(embeddingWeightRaw) ? embeddingWeightRaw : 0.25,
      });

      return sendJson(res, 200, result);
    }

    return sendJson(res, 404, { error: "not found" });
  });

  server.listen(port, host);
  return server;
}
