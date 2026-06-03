// ADR-0017 D4 — CDP client tests. A fixture WebSocketServer simulates Chrome, and the client is
// driven through send/onEvent/close. Targets the permit-list gate, request-response correlation,
// event routing, timeout, id-collision spoofing, and disconnect handling.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import { BrowserToolError } from "./errors.js";
import { CdpClient, PERMITTED_CDP_METHODS } from "./cdp-client.js";

interface ServerHandle {
  readonly url: string;
  readonly close: () => Promise<void>;
  readonly onConnection: (handler: (socket: ServerSocket) => void) => void;
}

async function startServer(): Promise<ServerHandle> {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => {
    wss.once("listening", resolve);
  });
  const address = wss.address() as AddressInfo;
  const handlers: ((socket: ServerSocket) => void)[] = [];
  wss.on("connection", (socket) => {
    for (const handler of handlers) handler(socket);
  });
  return {
    url: `ws://127.0.0.1:${String(address.port)}`,
    close: async (): Promise<void> => {
      await new Promise<void>((resolve) => {
        wss.close(() => {
          resolve();
        });
      });
    },
    onConnection: (handler): void => {
      handlers.push(handler);
    },
  };
}

let server: ServerHandle;
let clients: CdpClient[] = [];

beforeEach(async () => {
  server = await startServer();
});

afterEach(async () => {
  for (const client of clients) client.close();
  clients = [];
  await server.close();
});

function makeClient(timeoutMs = 200): CdpClient {
  const client = new CdpClient(server.url, { timeoutMs });
  clients.push(client);
  return client;
}

describe("CdpClient permit list", () => {
  it("rejects every method outside the permit list before any frame is sent", async () => {
    const client = makeClient();
    for (const method of [
      "Runtime.evaluate",
      "Runtime.callFunctionOn",
      "Network.getAllCookies",
      "Network.getCookies",
      "Page.handleJavaScriptDialog",
      "Page.addScriptToEvaluateOnNewDocument",
      "Security.setIgnoreCertificateErrors",
      "Input.dispatchMouseEvent",
      "Fetch.enable",
      "Emulation.setDeviceMetricsOverride",
    ]) {
      await expect(client.send(method)).rejects.toMatchObject({
        name: "BrowserToolError",
        code: "CDP_METHOD_FORBIDDEN",
      });
    }
  });

  it("exposes the permit list as the exact ADR-0017 D4 set", () => {
    expect([...PERMITTED_CDP_METHODS].sort()).toEqual(
      [
        "Browser.getVersion",
        "DOM.getDocument",
        "DOM.getOuterHTML",
        "Page.captureScreenshot",
        "Page.enable",
        "Page.navigate",
        "Page.stopLoading",
        "Target.attachToTarget",
        "Target.closeTarget",
        "Target.createTarget",
      ].sort(),
    );
  });
});

describe("CdpClient request/response", () => {
  it("correlates a permitted send with the server response by id", async () => {
    server.onConnection((socket) => {
      socket.on("message", (raw) => {
        const text =
          typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString("utf8") : "";
        const frame = JSON.parse(text) as { id: number; method: string };
        if (frame.method === "Browser.getVersion") {
          socket.send(
            JSON.stringify({ id: frame.id, result: { product: "Chrome/130", userAgent: "ua" } }),
          );
        }
      });
    });
    const client = makeClient();
    const result = await client.send<{ product: string }>("Browser.getVersion");
    expect(result.product).toBe("Chrome/130");
  });

  it("maps a CDP error response onto a CDP_METHOD_FORBIDDEN typed error", async () => {
    server.onConnection((socket) => {
      socket.on("message", (raw) => {
        const text =
          typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString("utf8") : "";
        const frame = JSON.parse(text) as { id: number };
        socket.send(
          JSON.stringify({ id: frame.id, error: { code: -32601, message: "Method not found" } }),
        );
      });
    });
    const client = makeClient();
    await expect(client.send("Browser.getVersion")).rejects.toMatchObject({
      code: "CDP_METHOD_FORBIDDEN",
    });
  });

  it("times out a send when no response arrives", async () => {
    server.onConnection(() => {
      // never respond
    });
    const client = makeClient(50);
    await expect(client.send("Browser.getVersion")).rejects.toMatchObject({
      code: "CDP_TIMEOUT",
    });
  });

  it("ignores a server response whose id does not match any pending request", async () => {
    server.onConnection((socket) => {
      socket.on("message", (raw) => {
        const text =
          typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString("utf8") : "";
        const frame = JSON.parse(text) as { id: number };
        // First send a spoofed response with a wrong id, then the real one.
        socket.send(JSON.stringify({ id: 9999, result: { spoofed: true } }));
        socket.send(JSON.stringify({ id: frame.id, result: { product: "Chrome/130" } }));
      });
    });
    const client = makeClient();
    const result = await client.send<{ product?: string; spoofed?: boolean }>("Browser.getVersion");
    expect(result.spoofed).toBeUndefined();
    expect(result.product).toBe("Chrome/130");
  });

  it("dispatches an event-method frame (no id) to subscribers", async () => {
    let serverSocket: ServerSocket | undefined;
    server.onConnection((socket) => {
      serverSocket = socket;
    });
    const client = makeClient();
    await client.connect();
    const received = new Promise<{ method: string; params: unknown }>((resolve) => {
      client.onEvent((event) => {
        resolve(event);
      });
    });
    serverSocket?.send(
      JSON.stringify({
        method: "Page.frameNavigated",
        params: { frame: { url: "http://127.0.0.1:5173/" } },
      }),
    );
    const event = await received;
    expect(event.method).toBe("Page.frameNavigated");
  });
});

describe("CdpClient disconnect", () => {
  it("rejects all pending requests when the socket closes mid-flight", async () => {
    let closeImmediately: ServerSocket | undefined;
    server.onConnection((socket) => {
      closeImmediately = socket;
    });
    const client = makeClient(2000);
    await client.connect();
    const pending = client.send("Browser.getVersion");
    closeImmediately?.close();
    await expect(pending).rejects.toMatchObject({ code: "TARGET_CLOSED" });
    expect(client.isClosed()).toBe(true);
  });

  it("notifies close listeners when Chrome disconnects", async () => {
    let serverSocket: ServerSocket | undefined;
    server.onConnection((socket) => {
      serverSocket = socket;
    });
    const client = makeClient(2000);
    await client.connect();
    const reason = new Promise<string>((resolve) => {
      client.onClose(resolve);
    });
    serverSocket?.close();
    await expect(reason).resolves.toBe("chrome-disconnected");
  });

  it("send after close throws TARGET_CLOSED without opening a new request", async () => {
    const client = makeClient();
    client.close();
    await expect(client.send("Browser.getVersion")).rejects.toMatchObject({
      code: "TARGET_CLOSED",
    });
  });

  it("connect rejects with CHROME_UNREACHABLE if the server is gone before open", async () => {
    await server.close();
    const client = new CdpClient(server.url, { timeoutMs: 200 });
    await expect(client.connect()).rejects.toBeInstanceOf(BrowserToolError);
    client.close();
  });
});
