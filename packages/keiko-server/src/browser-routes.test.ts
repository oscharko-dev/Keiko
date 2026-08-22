// ADR-0017 D8 — /api/browser/* route integration tests. A FakeBrowserSessionManager replaces
// the real CDP-backed manager so these tests never open a real WebSocket. The createUiServer
// fixture mirrors terminal.test.ts so the CSRF guard, host-check, and SSE framer run live.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCspHeader } from "./csp.js";
import { buildRedactor, createInMemoryUiStore, type UiHandlerDeps } from "./index.js";
import { createRunRegistry } from "./runs.js";
import { createUiServer, UI_HOST } from "./server.js";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { handleBrowserEvents, openBrowserSseStream } from "./browser.js";
import type { SseBackpressureSignal } from "./sse-write.js";
import type { RouteContext } from "./routes.js";
import type { ServerDiagnosticRecord, ServerDiagnosticSink } from "./diagnostics-log.js";
import {
  createBufferedServerLogSink,
  createServerLogger,
  resetServerLogger,
  setServerLogger,
} from "./observability/index.js";
import {
  BrowserToolError,
  type BrowserEventEmitter,
  type BrowserEventEnvelope,
  type BrowserSessionManager,
} from "@oscharko-dev/keiko-tools";

interface FakeManagerOptions {
  readonly reachable?: boolean;
  readonly openShouldThrow?: BrowserToolError;
  readonly checkShouldThrow?: BrowserToolError;
}

class FakeBrowserSessionManager implements BrowserSessionManager {
  public readonly opened: string[] = [];
  public readonly closed: string[] = [];
  public readonly navigated: { sessionId: string; url: string }[] = [];
  public readonly screenshots: number[] = [];
  public readonly contentCalls: string[] = [];
  public readonly applied: { sessionId: string; seq: number }[] = [];
  private readonly subscribers = new Map<string, Set<BrowserEventEmitter>>();
  private readonly opts: FakeManagerOptions;
  private nextScreenshotSeq = 0;

  public constructor(opts: FakeManagerOptions = {}) {
    this.opts = opts;
  }

  public readonly checkStatus = async (
    port: number,
  ): Promise<{
    reachable: boolean;
    userAgent: string | null;
    browserVersion: string | null;
    webSocketDebuggerUrl: string | null;
  }> => {
    if (this.opts.checkShouldThrow !== undefined) throw this.opts.checkShouldThrow;
    if (port < 1024 || port > 65535) {
      throw new BrowserToolError("BAD_PORT", "Port out of range.");
    }
    if (this.opts.reachable === false) {
      return {
        reachable: false,
        userAgent: null,
        browserVersion: null,
        webSocketDebuggerUrl: null,
      };
    }
    return Promise.resolve({
      reachable: true,
      userAgent: "Chrome/130.0",
      browserVersion: "Chrome/130.0",
      webSocketDebuggerUrl: `ws://127.0.0.1:${String(port)}/devtools/browser/xyz`,
    });
  };

  public readonly openSession = async (
    cdpPort: number,
  ): Promise<{
    sessionId: string;
    cdpPort: number;
    targetId: string;
    status: "open";
    createdAt: number;
  }> => {
    if (this.opts.openShouldThrow !== undefined) throw this.opts.openShouldThrow;
    const sessionId = `session-${String(this.opened.length + 1)}`;
    this.opened.push(sessionId);
    return Promise.resolve({
      sessionId,
      cdpPort,
      targetId: `TARGET-${String(this.opened.length)}`,
      status: "open" as const,
      createdAt: Date.now(),
    });
  };

  public readonly closeSession = (sessionId: string): Promise<void> => {
    this.closed.push(sessionId);
    return Promise.resolve();
  };

  public readonly navigate = (
    sessionId: string,
    url: string,
  ): Promise<{ originOnly: string; httpStatus: number | null }> => {
    this.navigated.push({ sessionId, url });
    if (url.includes("evil.example")) {
      return Promise.reject(
        new BrowserToolError("ORIGIN_NOT_ALLOWED", "Post-navigate origin is not loopback."),
      );
    }
    return Promise.resolve({ originOnly: "http://127.0.0.1:5173", httpStatus: 200 });
  };

  public readonly screenshot = (
    _sessionId: string,
  ): Promise<{
    seq: number;
    viewportPx: { width: number; height: number };
    dataBase64: string;
    persisted: false;
  }> => {
    this.nextScreenshotSeq += 1;
    this.screenshots.push(this.nextScreenshotSeq);
    return Promise.resolve({
      seq: this.nextScreenshotSeq,
      viewportPx: { width: 1280, height: 800 },
      dataBase64: Buffer.from("png-bytes").toString("base64"),
      persisted: false as const,
    });
  };

  public readonly applyScreenshot = (
    sessionId: string,
    captureSeq: number,
  ): Promise<{
    seq: number;
    viewportPx: { width: number; height: number };
    persisted: true;
    path: string;
    sha256: string;
    bytes: number;
  }> => {
    if (captureSeq > this.nextScreenshotSeq) {
      return Promise.reject(new BrowserToolError("NO_PENDING_SCREENSHOT", "Unknown capture seq."));
    }
    this.applied.push({ sessionId, seq: captureSeq });
    return Promise.resolve({
      seq: captureSeq,
      viewportPx: { width: 1280, height: 800 },
      persisted: true as const,
      path: `browser-${String(captureSeq)}.png`,
      sha256: "a".repeat(64),
      bytes: 9,
    });
  };

  public readonly content = (
    sessionId: string,
  ): Promise<{ seq: number; byteLength: number; redactedHtml: string }> => {
    this.contentCalls.push(sessionId);
    return Promise.resolve({
      seq: 1,
      byteLength: 9,
      redactedHtml: "<html>secret=***</html>",
    });
  };

  public readonly listSessionIds = (): readonly string[] =>
    this.opened.filter((sessionId) => !this.closed.includes(sessionId));
  public readonly hasSession = (sessionId: string): boolean =>
    this.opened.includes(sessionId) && !this.closed.includes(sessionId);
  public readonly dispose = (): Promise<void> => Promise.resolve();
  public readonly subscribe = (sessionId: string, listener: BrowserEventEmitter): (() => void) => {
    let set = this.subscribers.get(sessionId);
    if (set === undefined) {
      set = new Set<BrowserEventEmitter>();
      this.subscribers.set(sessionId, set);
    }
    const target = set;
    target.add(listener);
    return (): void => {
      target.delete(listener);
    };
  };
  public readonly counterAccessor = (): { readonly navigations: number } => ({ navigations: 0 });

  public emit(sessionId: string, event: BrowserEventEnvelope): void {
    const set = this.subscribers.get(sessionId);
    if (set === undefined) return;
    for (const listener of [...set]) listener(event);
  }
}

interface Fixture {
  readonly server: Server;
  readonly port: number;
  readonly deps: UiHandlerDeps;
  readonly fakeBrowser: FakeBrowserSessionManager;
  readonly close: () => Promise<void>;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, UI_HOST, resolve));
  return (server.address() as AddressInfo).port;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

async function makeFixture(overrides?: {
  readonly omitBrowser?: boolean;
  readonly fakeOpts?: FakeManagerOptions;
}): Promise<Fixture> {
  const staticRoot = await mkdtemp(join(tmpdir(), "keiko-browser-static-"));
  await writeFile(join(staticRoot, "index.html"), "<html><body>browser</body></html>", "utf8");
  const fakeBrowser = new FakeBrowserSessionManager(overrides?.fakeOpts);
  const baseDeps: UiHandlerDeps = {
    config: undefined,
    configPresent: false,
    evidenceStore: {
      put: (): string => "",
      list: (): readonly string[] => [],
      get: (): undefined => undefined,
      delete: (): undefined => undefined,
    },
    env: process.env,
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: (): undefined => undefined,
    store: createInMemoryUiStore(),
  };
  const deps: UiHandlerDeps =
    overrides?.omitBrowser === true ? baseDeps : { ...baseDeps, browser: fakeBrowser };
  let server = createUiServer({
    staticRoot,
    csp: buildCspHeader([]),
    port: 0,
    handlerDeps: deps,
  });
  const port = await listen(server);
  await closeServer(server);
  server = createUiServer({ staticRoot, csp: buildCspHeader([]), port, handlerDeps: deps });
  await new Promise<void>((resolve) => server.listen(port, UI_HOST, resolve));
  return {
    server,
    port,
    deps,
    fakeBrowser,
    close: async (): Promise<void> => {
      await closeServer(server);
      deps.store.close();
      await rm(staticRoot, { recursive: true, force: true });
    },
  };
}

let active: Fixture[] = [];

beforeEach(() => {
  active = [];
});

afterEach(async () => {
  for (const fx of active) await fx.close();
  active = [];
});

async function fixture(...args: Parameters<typeof makeFixture>): Promise<Fixture> {
  const fx = await makeFixture(...args);
  active.push(fx);
  return fx;
}

function url(fx: Fixture, path: string): string {
  return `http://${UI_HOST}:${String(fx.port)}${path}`;
}

const CSRF_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "application/json",
  "X-Keiko-CSRF": "1",
};

describe("GET /api/browser/status", () => {
  it("returns reachable=true with userAgent when the fake reports up", async () => {
    const fx = await fixture();
    const res = await fetch(url(fx, "/api/browser/status?port=9222"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reachable: boolean; userAgent: string | null };
    expect(body.reachable).toBe(true);
    expect(body.userAgent).toBe("Chrome/130.0");
  });

  it("returns reachable=false when the fake reports down", async () => {
    const fx = await fixture({ fakeOpts: { reachable: false } });
    const res = await fetch(url(fx, "/api/browser/status?port=9222"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reachable: boolean };
    expect(body.reachable).toBe(false);
  });

  it("returns 200 reachable=false with null fields when CDP throws CHROME_UNREACHABLE", async () => {
    const fx = await fixture({
      fakeOpts: {
        checkShouldThrow: new BrowserToolError("CHROME_UNREACHABLE", "connection refused"),
      },
    });
    const res = await fetch(url(fx, "/api/browser/status?port=9222"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      reachable: boolean;
      userAgent: unknown;
      browserVersion: unknown;
      webSocketDebuggerUrl: unknown;
    };
    expect(body.reachable).toBe(false);
    expect(body.userAgent).toBeNull();
    expect(body.browserVersion).toBeNull();
    expect(body.webSocketDebuggerUrl).toBeNull();
  });

  it("still returns reachable=true with userAgent when CDP responds normally", async () => {
    const fx = await fixture();
    const res = await fetch(url(fx, "/api/browser/status?port=9222"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reachable: boolean; userAgent: string | null };
    expect(body.reachable).toBe(true);
    expect(typeof body.userAgent).toBe("string");
  });

  it("rejects missing port query with 400 BAD_REQUEST envelope", async () => {
    const fx = await fixture();
    const res = await fetch(url(fx, "/api/browser/status"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("rejects non-integer port", async () => {
    const fx = await fixture();
    const res = await fetch(url(fx, "/api/browser/status?port=notanumber"));
    expect(res.status).toBe(400);
  });

  it("returns 503 BROWSER_UNAVAILABLE when no browser dep is wired", async () => {
    const fx = await fixture({ omitBrowser: true });
    const res = await fetch(url(fx, "/api/browser/status?port=9222"));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("BROWSER_UNAVAILABLE");
  });
});

describe("POST /api/browser/sessions", () => {
  it("creates a session and returns 201 with the meta", async () => {
    const fx = await fixture();
    const res = await fetch(url(fx, "/api/browser/sessions"), {
      method: "POST",
      headers: CSRF_HEADERS,
      body: JSON.stringify({ port: 9222 }),
    });
    expect(res.status).toBe(201);
    const meta = (await res.json()) as { sessionId: string; cdpPort: number };
    expect(meta.sessionId).toBe("session-1");
    expect(meta.cdpPort).toBe(9222);
  });

  it("rejects missing CSRF header with 403 FORBIDDEN_CSRF", async () => {
    const fx = await fixture();
    const res = await fetch(url(fx, "/api/browser/sessions"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ port: 9222 }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN_CSRF");
  });

  it("rejects non-JSON content-type with 415", async () => {
    const fx = await fixture();
    const res = await fetch(url(fx, "/api/browser/sessions"), {
      method: "POST",
      headers: { "Content-Type": "text/plain", "X-Keiko-CSRF": "1" },
      body: "port=9222",
    });
    expect(res.status).toBe(415);
  });

  it("rejects body without port number", async () => {
    const fx = await fixture();
    const res = await fetch(url(fx, "/api/browser/sessions"), {
      method: "POST",
      headers: CSRF_HEADERS,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/browser/sessions/:id", () => {
  it("returns 200 ok on close", async () => {
    const fx = await fixture();
    const create = await fetch(url(fx, "/api/browser/sessions"), {
      method: "POST",
      headers: CSRF_HEADERS,
      body: JSON.stringify({ port: 9222 }),
    });
    const { sessionId } = (await create.json()) as { sessionId: string };
    const res = await fetch(url(fx, `/api/browser/sessions/${sessionId}`), {
      method: "DELETE",
      headers: CSRF_HEADERS,
    });
    expect(res.status).toBe(200);
    expect(fx.fakeBrowser.closed).toContain(sessionId);
  });

  it("rejects missing CSRF", async () => {
    const fx = await fixture();
    const res = await fetch(url(fx, "/api/browser/sessions/sess-x"), {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(403);
  });
});

describe("POST /api/browser/sessions/:id/navigate", () => {
  it("returns 200 + originOnly on success", async () => {
    const fx = await fixture();
    const res = await fetch(url(fx, "/api/browser/sessions/session-1/navigate"), {
      method: "POST",
      headers: CSRF_HEADERS,
      body: JSON.stringify({ url: "http://127.0.0.1:5173/app" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { originOnly: string };
    expect(body.originOnly).toBe("http://127.0.0.1:5173");
  });

  it("returns 403 ORIGIN_NOT_ALLOWED envelope on post-navigate redirect", async () => {
    const fx = await fixture();
    const res = await fetch(url(fx, "/api/browser/sessions/session-1/navigate"), {
      method: "POST",
      headers: CSRF_HEADERS,
      body: JSON.stringify({ url: "http://evil.example:8080/" }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ORIGIN_NOT_ALLOWED");
  });

  it("rejects body without url string", async () => {
    const fx = await fixture();
    const res = await fetch(url(fx, "/api/browser/sessions/session-1/navigate"), {
      method: "POST",
      headers: CSRF_HEADERS,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("returns 413 PAYLOAD_TOO_LARGE when body exceeds 64KB", async () => {
    const fx = await fixture();
    const giantUrl = "http://127.0.0.1:5173/" + "a".repeat(70_000);
    const res = await fetch(url(fx, "/api/browser/sessions/session-1/navigate"), {
      method: "POST",
      headers: CSRF_HEADERS,
      body: JSON.stringify({ url: giantUrl }),
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PAYLOAD_TOO_LARGE");
  });
});

describe("POST /api/browser/sessions/:id/screenshot + apply", () => {
  it("dry-run screenshot returns 200 with persisted=false", async () => {
    const fx = await fixture();
    const res = await fetch(url(fx, "/api/browser/sessions/s-1/screenshot"), {
      method: "POST",
      headers: CSRF_HEADERS,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { persisted: boolean; seq: number };
    expect(body.persisted).toBe(false);
    expect(body.seq).toBe(1);
  });

  it("apply persists and returns the relative path", async () => {
    const fx = await fixture();
    await fetch(url(fx, "/api/browser/sessions/s-1/screenshot"), {
      method: "POST",
      headers: CSRF_HEADERS,
      body: JSON.stringify({}),
    });
    const res = await fetch(url(fx, "/api/browser/sessions/s-1/apply"), {
      method: "POST",
      headers: CSRF_HEADERS,
      body: JSON.stringify({ captureSeq: 1 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { persisted: boolean; path: string };
    expect(body.persisted).toBe(true);
    expect(body.path).toBe("browser-1.png");
  });

  it("apply with unknown seq returns NO_PENDING_SCREENSHOT envelope", async () => {
    const fx = await fixture();
    const res = await fetch(url(fx, "/api/browser/sessions/s-1/apply"), {
      method: "POST",
      headers: CSRF_HEADERS,
      body: JSON.stringify({ captureSeq: 999 }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NO_PENDING_SCREENSHOT");
  });

  it("returns 413 PAYLOAD_TOO_LARGE when screenshot body exceeds 64KB", async () => {
    const fx = await fixture();
    const res = await fetch(url(fx, "/api/browser/sessions/s-1/screenshot"), {
      method: "POST",
      headers: CSRF_HEADERS,
      body: JSON.stringify({ unused: "x".repeat(70_000) }),
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PAYLOAD_TOO_LARGE");
  });
});

describe("POST /api/browser/sessions/:id/content", () => {
  it("returns 200 with the redacted HTML", async () => {
    const fx = await fixture();
    const res = await fetch(url(fx, "/api/browser/sessions/s-1/content"), {
      method: "POST",
      headers: CSRF_HEADERS,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { redactedHtml: string };
    expect(body.redactedHtml).toContain("secret=***");
  });

  it("returns 413 PAYLOAD_TOO_LARGE when content body exceeds 64KB", async () => {
    const fx = await fixture();
    const res = await fetch(url(fx, "/api/browser/sessions/s-1/content"), {
      method: "POST",
      headers: CSRF_HEADERS,
      body: JSON.stringify({ unused: "x".repeat(70_000) }),
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PAYLOAD_TOO_LARGE");
  });
});

describe("GET /api/browser/sessions/:id/events (SSE)", () => {
  it("returns text/event-stream with the ready frame, then a browser:navigated frame", async () => {
    const fx = await fixture();
    const create = await fetch(url(fx, "/api/browser/sessions"), {
      method: "POST",
      headers: CSRF_HEADERS,
      body: JSON.stringify({ port: 9222 }),
    });
    const { sessionId } = (await create.json()) as { sessionId: string };
    const controller = new AbortController();
    const responsePromise = fetch(url(fx, `/api/browser/sessions/${sessionId}/events`), {
      signal: controller.signal,
    });
    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    // Fire one event on the fake then close the stream.
    setTimeout(() => {
      fx.fakeBrowser.emit(sessionId, {
        schemaVersion: "1",
        type: "browser:navigated",
        runId: "run-1",
        fingerprint: "fp-1",
        seq: 1,
        ts: Date.now(),
        kind: "navigated",
        sessionId,
        payload: { originOnly: "http://127.0.0.1:5173", httpStatus: 200 },
      });
      setTimeout(() => {
        controller.abort();
      }, 25);
    }, 25);
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("no body reader");
    let received = "";
    try {
      while (received.length < 4096) {
        const chunk = await reader.read();
        if (chunk.done) break;
        received += new TextDecoder().decode(chunk.value);
        if (received.includes("event: browser:navigated")) break;
      }
    } catch {
      // abort fires here — expected
    }
    expect(received).toContain("event: ready");
    expect(received).toContain("event: browser:navigated");
  });

  it("returns 404 SESSION_NOT_FOUND for unknown session event streams", async () => {
    const fx = await fixture();
    const res = await fetch(url(fx, "/api/browser/sessions/missing/events"));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("SESSION_NOT_FOUND");
  });

  it("ends the event stream after browser:session-closed", async () => {
    const fx = await fixture();
    const create = await fetch(url(fx, "/api/browser/sessions"), {
      method: "POST",
      headers: CSRF_HEADERS,
      body: JSON.stringify({ port: 9222 }),
    });
    const { sessionId } = (await create.json()) as { sessionId: string };
    const controller = new AbortController();
    const response = await fetch(url(fx, `/api/browser/sessions/${sessionId}/events`), {
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    setTimeout(() => {
      fx.fakeBrowser.emit(sessionId, {
        schemaVersion: "1",
        type: "browser:session-closed",
        runId: "run-1",
        fingerprint: "fp-1",
        seq: 1,
        ts: Date.now(),
        kind: "session-closed",
        sessionId,
        payload: { reason: "chrome-disconnected" },
      });
    }, 25);
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("no body reader");
    let received = "";
    const timeout = setTimeout(() => {
      controller.abort();
    }, 1000);
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        received += new TextDecoder().decode(chunk.value);
      }
    } finally {
      clearTimeout(timeout);
    }
    expect(received).toContain("event: browser:session-closed");
  });
});

// KEIKO-0142: browser.ts hand-rolled the write+destroy backpressure check instead of the shared
// writeOrDestroy helper, so it had no per-connection AbortController, no unsubscribe on a
// backpressure kill, and no observable signal. Mirrors command-runner-routes.test.ts's block.
interface FakeSseRes {
  res: ServerResponse;
  readonly writes: string[];
  destroyCount: number;
  ended: boolean;
  writeReturns: boolean;
  readonly emitClose: () => void;
}

function makeFakeSseRes(): FakeSseRes {
  const writes: string[] = [];
  const emitter = new EventEmitter();
  const state: FakeSseRes = {
    res: undefined as unknown as ServerResponse,
    writes,
    destroyCount: 0,
    ended: false,
    writeReturns: true,
    emitClose: (): void => {
      emitter.emit("close");
    },
  };
  const res = {
    writeHead(): ServerResponse {
      return res as unknown as ServerResponse;
    },
    write(chunk: string): boolean {
      writes.push(chunk);
      return state.writeReturns;
    },
    end(): ServerResponse {
      state.ended = true;
      return res as unknown as ServerResponse;
    },
    destroy(): void {
      state.destroyCount += 1;
    },
    on(event: string, listener: (...args: unknown[]) => void): ServerResponse {
      emitter.on(event, listener);
      return res as unknown as ServerResponse;
    },
  };
  state.res = res as unknown as ServerResponse;
  return state;
}

function browserEvent(sessionId: string, kind: string, seq: number): BrowserEventEnvelope {
  return {
    schemaVersion: "1",
    type: `browser:${kind}`,
    runId: "run-bp",
    fingerprint: "fp-bp",
    seq,
    ts: 1_700_000_000_000,
    kind,
    sessionId,
    payload: { reason: "chrome-disconnected" },
  } as unknown as BrowserEventEnvelope;
}

describe("openBrowserSseStream backpressure (KEIKO-0142)", () => {
  it("aborts, unsubscribes, destroys once, and signals when res.write returns false", () => {
    const fake = makeFakeSseRes();
    const manager = new FakeBrowserSessionManager();
    const signals: SseBackpressureSignal[] = [];
    fake.writeReturns = false;
    openBrowserSseStream(
      fake.res,
      manager,
      "session-bp",
      (value) => value,
      (signal) => {
        signals.push(signal);
      },
    );

    manager.emit("session-bp", browserEvent("session-bp", "navigated", 1));

    expect(fake.destroyCount).toBe(1);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.accepted).toBe(false);
    expect(signals[0]?.frameBytes).toBeGreaterThan(0);

    const writesAfterKill = fake.writes.length;
    manager.emit("session-bp", browserEvent("session-bp", "navigated", 2));
    expect(fake.writes).toHaveLength(writesAfterKill);
    expect(fake.destroyCount).toBe(1);
    expect(signals).toHaveLength(1);

    expect(() => {
      fake.emitClose();
    }).not.toThrow();
  });

  it("protects the ready frame itself, not just later events (KEIKO-0142)", () => {
    const fake = makeFakeSseRes();
    const manager = new FakeBrowserSessionManager();
    const signals: SseBackpressureSignal[] = [];
    fake.writeReturns = false;
    openBrowserSseStream(
      fake.res,
      manager,
      "session-ready",
      (value) => value,
      (signal) => {
        signals.push(signal);
      },
    );

    expect(fake.destroyCount).toBe(1);
    expect(signals).toHaveLength(1);
  });

  it("kills on an event frame when the ready frame was accepted (KEIKO-0142)", () => {
    const fake = makeFakeSseRes();
    const manager = new FakeBrowserSessionManager();
    const signals: SseBackpressureSignal[] = [];
    openBrowserSseStream(
      fake.res,
      manager,
      "session-late",
      (value) => value,
      (signal) => {
        signals.push(signal);
      },
    );
    expect(fake.destroyCount).toBe(0);

    fake.writeReturns = false;
    manager.emit("session-late", browserEvent("session-late", "navigated", 1));

    expect(fake.destroyCount).toBe(1);
    expect(signals).toHaveLength(1);
  });

  it("keeps the session-closed early-return intact while wired to the controller", () => {
    // The session-closed branch must still unsubscribe and end the response — migrating to
    // writeOrDestroy must not drop or reorder it.
    const fake = makeFakeSseRes();
    const manager = new FakeBrowserSessionManager();
    openBrowserSseStream(fake.res, manager, "session-close", (value) => value);

    manager.emit("session-close", browserEvent("session-close", "session-closed", 1));

    expect(fake.ended).toBe(true);
    expect(fake.destroyCount).toBe(0);
    // Unsubscribed: a further event for the same session produces no additional write.
    const writesAfterClose = fake.writes.length;
    manager.emit("session-close", browserEvent("session-close", "navigated", 2));
    expect(fake.writes).toHaveLength(writesAfterClose);
  });
});

// Finding 0 (#2902 audit): the request-scoped correlationId never reached the terminal
// `sse.stream.closed` line — openBrowserSseStream had no parameter to receive it. The ready frame
// (not the heartbeat, whose own write is deferred to its interval timer) is the actual first write
// on the stream, so that is where correlationId must be threaded.
describe("openBrowserSseStream correlationId threading (#2902 audit finding 0)", () => {
  afterEach(() => {
    resetServerLogger();
  });

  it("attaches the supplied correlationId to the sse.stream.closed terminal line", () => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));
    const fake = makeFakeSseRes();
    const manager = new FakeBrowserSessionManager();

    openBrowserSseStream(
      fake.res,
      manager,
      "session-corr",
      (value) => value,
      undefined,
      "corr-browser-1",
    );
    fake.emitClose();

    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({
      op: "sse.stream.closed",
      correlationId: "corr-browser-1",
    });
  });

  it("omits correlationId from the terminal line when none is supplied (unchanged behavior)", () => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));
    const fake = makeFakeSseRes();
    const manager = new FakeBrowserSessionManager();

    openBrowserSseStream(fake.res, manager, "session-no-corr", (value) => value);
    fake.emitClose();

    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]?.correlationId).toBeUndefined();
  });
});

describe("handleBrowserEvents backpressure correlation (ADR-0173 D5 / g12)", () => {
  it("threads the request's own correlation id into the backpressure diagnostic instead of minting one", () => {
    const fake = makeFakeSseRes();
    fake.writeReturns = false; // rejects the ready frame -> immediate backpressure kill.
    const manager = new FakeBrowserSessionManager();
    manager.opened.push("session-thread");
    const records: ServerDiagnosticRecord[] = [];
    const diagnostics: ServerDiagnosticSink = {
      record: (entry) => {
        records.push(entry);
      },
    };
    const baseDeps: UiHandlerDeps = {
      config: undefined,
      configPresent: false,
      evidenceStore: {
        put: (): string => "",
        list: (): readonly string[] => [],
        get: (): undefined => undefined,
        delete: (): undefined => undefined,
      },
      env: process.env,
      redactor: buildRedactor({}),
      registry: createRunRegistry(),
      modelPortFactory: (): undefined => undefined,
      store: createInMemoryUiStore(),
      browser: manager,
      diagnostics,
    };
    const ctx: RouteContext = {
      req: { on: (): void => undefined } as unknown as RouteContext["req"],
      res: fake.res,
      params: { sessionId: "session-thread" },
      url: new URL("http://127.0.0.1/api/browser/sessions/session-thread/events"),
      correlationId: "req-browser-thread-01",
    };

    handleBrowserEvents(ctx, baseDeps);

    expect(records).toHaveLength(1);
    expect(records[0]?.source).toBe("sse.browser.backpressure");
    expect(records[0]?.correlationId).toBe("req-browser-thread-01");
  });
});
