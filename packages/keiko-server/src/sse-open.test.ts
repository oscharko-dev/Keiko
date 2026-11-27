// U-23: a stream with nothing to replay delivered its headers only at the first 15 s heartbeat,
// because Node does not put response headers on the wire until the first body write. Every SSE
// endpoint now opens through `openSseResponse` (headers flushed, open comment frame written through
// the shared flow control), so a client's `onopen` fires at once. These tests use real loopback
// listeners: the proof is the first chunk a socket receives, not a timing measurement.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, get, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// The route module graph is cyclic; entering through the route table is the order production uses.
import "./routes.js";
import { openCodingRuntimeSse } from "./coding-runtime/codingRuntimeRoutes.js";
import { CodingRuntimeEventHub } from "./coding-runtime/codingRuntimeEventHub.js";
import { openSseResponse, SSE_OPEN_FRAME } from "./sse.js";

interface FirstChunk {
  readonly status: number | undefined;
  readonly contentType: string | undefined;
  readonly chunk: string;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

function firstChunkOf(port: number): Promise<FirstChunk> {
  return new Promise((resolve, reject) => {
    const request = get(
      { host: "127.0.0.1", port, path: "/events" },
      (response: IncomingMessage) => {
        response.setEncoding("utf8");
        response.once("data", (chunk: string) => {
          resolve({
            status: response.statusCode,
            contentType: response.headers["content-type"],
            chunk,
          });
          request.destroy();
        });
      },
    );
    request.on("error", reject);
  });
}

async function withServer(
  handler: Parameters<typeof createServer>[1],
  run: (port: number) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  try {
    await run(await listen(server));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
  }
}

describe("SSE stream open (U-23)", () => {
  it("delivers headers and the open frame for a run with nothing to replay, before any heartbeat", async () => {
    const hub = new CodingRuntimeEventHub();
    await withServer(
      (req, res) => {
        openCodingRuntimeSse(res, req, hub, "run-without-events", undefined);
      },
      async (port) => {
        const first = await firstChunkOf(port);
        expect(first.status).toBe(200);
        expect(first.contentType).toContain("text/event-stream");
        // The heartbeat is a 15 s interval: the first chunk can only be the open frame.
        expect(first.chunk).toBe(SSE_OPEN_FRAME);
      },
    );
  });

  it("flushes headers without an open frame when the caller writes its own first frame", async () => {
    await withServer(
      (_req, res) => {
        expect(openSseResponse(res, { openFrame: false })).toBe(true);
        res.write("event: ready\ndata: {}\n\n");
      },
      async (port) => {
        const first = await firstChunkOf(port);
        expect(first.chunk).toBe("event: ready\ndata: {}\n\n");
      },
    );
  });

  it("reports a stream that is already gone", async () => {
    await withServer(
      (_req, res) => {
        res.destroy();
        expect(openSseResponse(res)).toBe(false);
      },
      async (port) => {
        await expect(firstChunkOf(port)).rejects.toThrow();
      },
    );
  });

  it("is the only way server code writes SSE headers", () => {
    const root = fileURLToPath(new URL(".", import.meta.url));
    const offenders: string[] = [];
    const visit = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) visit(path);
        else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !path.endsWith("sse.ts")) {
          if (
            /writeHead\(\s*200,\s*(?:\{\s*\.\.\.)?SSE_HEADERS/u.test(readFileSync(path, "utf8"))
          ) {
            offenders.push(path.slice(root.length));
          }
        }
      }
    };
    visit(root);
    expect(offenders).toEqual([]);
  });
});
