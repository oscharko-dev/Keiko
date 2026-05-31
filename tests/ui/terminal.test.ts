import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import WebSocket, { type RawData } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCspHeader } from "../../src/ui/csp.js";
import { buildRedactor, createInMemoryUiStore, createPtyTerminalSessionManager } from "../../src/ui/index.js";
import type { TerminalConfig, UiHandlerDeps } from "../../src/ui/index.js";
import { createRunRegistry } from "../../src/ui/runs.js";
import { createUiServer, UI_HOST } from "../../src/ui/server.js";

let server: Server;
let staticRoot: string;
let workspaceRoot: string;
let port: number;
let deps: UiHandlerDeps;

async function listen(): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, UI_HOST, resolve));
  return (server.address() as AddressInfo).port;
}

async function closeServer(): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

function baseUrl(): string {
  return `http://${UI_HOST}:${String(port)}`;
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl()}${path}`, init);
  if (!response.ok) {
    throw new Error(`HTTP ${String(response.status)}: ${await response.text()}`);
  }
  return response.json() as Promise<T>;
}

function socketDataToText(data: RawData): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

beforeEach(async () => {
  staticRoot = await mkdtemp(join(tmpdir(), "keiko-terminal-static-"));
  workspaceRoot = await mkdtemp(join(tmpdir(), "keiko-terminal-workspace-"));
  await writeFile(join(staticRoot, "index.html"), "<html><body>terminal</body></html>", "utf8");
  await mkdir(join(workspaceRoot, "src"), { recursive: true });
  const terminal = createPtyTerminalSessionManager({
    defaultCwd: workspaceRoot,
    env: process.env,
    redactor: buildRedactor({}),
  });
  deps = {
    config: undefined,
    configPresent: false,
    evidenceStore: {
      put: (): string => "",
      list: (): [] => [],
      get: (): undefined => undefined,
      delete: (): undefined => undefined,
    },
    env: process.env,
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: (): undefined => undefined,
    store: createInMemoryUiStore(),
    terminal,
  };
  server = createUiServer({
    staticRoot,
    csp: buildCspHeader([]),
    port: 0,
    handlerDeps: deps,
  });
  port = await listen();
  await closeServer();
  server = createUiServer({
    staticRoot,
    csp: buildCspHeader([]),
    port,
    handlerDeps: deps,
  });
  await new Promise<void>((resolve) => server.listen(port, UI_HOST, resolve));
});

afterEach(async () => {
  await closeServer();
  deps.store.close();
  deps.terminal?.dispose();
  await rm(staticRoot, { recursive: true, force: true });
  await rm(workspaceRoot, { recursive: true, force: true });
});

describe("desktop terminal API", () => {
  it("detects installed shells and exposes a default cwd", async () => {
    const config = await fetchJson<TerminalConfig>("/api/terminal/shells");
    expect(config.defaultCwd).toBe(workspaceRoot);
    expect(config.shells.length).toBeGreaterThan(0);
    expect(config.defaultShell).toBe(config.shells[0]?.id);
  });

  it("lists child directories for the BFF-backed directory picker", async () => {
    const listing = await fetchJson<{ entries: { name: string; path: string }[] }>(
      `/api/terminal/directories?path=${encodeURIComponent(workspaceRoot)}`,
    );
    const realWorkspaceRoot = await realpath(workspaceRoot);
    expect(listing.entries).toContainEqual({
      name: "src",
      path: join(realWorkspaceRoot, "src"),
    });
  });

  it("streams a real PTY session over the WebSocket upgrade path", async () => {
    const config = await fetchJson<TerminalConfig>("/api/terminal/shells");
    expect(config.defaultShell).not.toBeNull();
    const created = await fetchJson<{
      session: { id: string };
      webSocketPath: string;
    }>("/api/terminal/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Keiko-CSRF": "1" },
      body: JSON.stringify({
        cwd: workspaceRoot,
        shellId: config.defaultShell,
        cols: 80,
        rows: 24,
      }),
    });

    const socket = new WebSocket(`ws://${UI_HOST}:${String(port)}${created.webSocketPath}`);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("PTY output timed out"));
      }, 8_000);
      socket.on("message", (data) => {
        const message = JSON.parse(socketDataToText(data)) as { type: string; data?: string };
        if (message.type === "ready") {
          socket.send(JSON.stringify({ type: "input", data: "echo keiko-terminal-ok\r" }));
        }
        if (message.type === "output" && message.data?.includes("keiko-terminal-ok")) {
          clearTimeout(timeout);
          resolve();
        }
      });
      socket.on("error", (error) => {
        reject(error);
      });
    });

    socket.close();
    await fetchJson(`/api/terminal/sessions/${encodeURIComponent(created.session.id)}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", "X-Keiko-CSRF": "1" },
      body: JSON.stringify({}),
    });
  });
});
