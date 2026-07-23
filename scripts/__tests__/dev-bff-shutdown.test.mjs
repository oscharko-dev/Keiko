import { createServer, request } from "node:http";

import { describe, expect, it, vi } from "vitest";

import { shutdownDevBff } from "../lib/dev-bff-shutdown.mjs";

describe("dev BFF shutdown", () => {
  it("closes a live SSE response before awaiting runtime disposal", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("event: ready\ndata: {}\n\n");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected TCP address.");
    let markResponseReady;
    const responseReady = new Promise((resolve) => {
      markResponseReady = resolve;
    });
    const responseClosed = new Promise((resolve, reject) => {
      const client = request(
        { hostname: "127.0.0.1", port: address.port, path: "/events" },
        (response) => {
          response.once("data", () => {
            response.once("close", resolve);
            markResponseReady();
          });
        },
      );
      client.once("error", reject);
      client.end();
    });
    await responseReady;
    const dispose = vi.fn(() => Promise.resolve());

    await expect(shutdownDevBff({ server, dispose, timeoutMs: 500 })).resolves.toEqual({
      ok: true,
      serverClosed: true,
      runtimeDisposed: true,
    });
    await expect(responseClosed).resolves.toBeUndefined();
    expect(dispose).toHaveBeenCalledOnce();
    expect(server.listening).toBe(false);
  });

  it("reports a bounded disposal timeout", async () => {
    const server = createServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

    await expect(
      shutdownDevBff({
        server,
        dispose: () => new Promise(() => undefined),
        timeoutMs: 10,
      }),
    ).resolves.toEqual({
      ok: false,
      serverClosed: true,
      runtimeDisposed: false,
    });
  });
});
