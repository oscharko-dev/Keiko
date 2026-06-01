// ADR-0017 D3/D6/D9 — session manager tests. A FakeCdpClient replaces the real WebSocket client so
// these tests never open a real socket. Drives the post-navigate frameNavigated re-check, dry-run
// vs apply screenshot, content redaction, idle TTL, session limit, and the in-process counter.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, realpath } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEvidence } from "../../../src/audit/index-api.js";
import { createInMemoryEvidenceStore } from "../../../src/audit/store.js";
import type { EvidenceBrowserCapture, EvidenceManifest } from "../../../src/audit/types.js";
import {
  createBrowserSessionManager,
  type BrowserEventEnvelope,
  type BrowserSessionManager,
  type CdpClientOptions,
  type CdpEventListener,
} from "../../../src/tools/browser/index.js";

interface RecordedCall {
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly sessionId: string | undefined;
}

type Responder = (call: RecordedCall) => unknown;

class FakeCdpClient {
  public readonly calls: RecordedCall[] = [];
  public closed = false;
  private listeners = new Set<CdpEventListener>();
  private closeListeners = new Set<(reason: string) => void>();
  private responder: Responder;
  public readonly url: string;

  public constructor(url: string, responder: Responder) {
    this.url = url;
    this.responder = responder;
  }

  public connect(): Promise<void> {
    return Promise.resolve();
  }

  public async send<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<T> {
    this.calls.push({ method, params, sessionId });
    const result = await this.responder({ method, params, sessionId });
    return result as T;
  }

  public onEvent(listener: CdpEventListener): () => void {
    this.listeners.add(listener);
    return (): void => {
      this.listeners.delete(listener);
    };
  }

  public onClose(listener: (reason: string) => void): () => void {
    this.closeListeners.add(listener);
    return (): void => {
      this.closeListeners.delete(listener);
    };
  }

  public close(): void {
    this.emitClosed("explicit");
  }

  public isClosed(): boolean {
    return this.closed;
  }

  public emitFrameNavigated(url: string, parentId?: string): void {
    for (const listener of [...this.listeners]) {
      listener({
        method: "Page.frameNavigated",
        params: { frame: { url, ...(parentId === undefined ? {} : { parentId }) } },
      });
    }
  }

  public emitClosed(reason = "chrome-disconnected"): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of [...this.closeListeners]) listener(reason);
  }
}

interface ManagerFixture {
  readonly manager: BrowserSessionManager;
  readonly client: FakeCdpClient;
  readonly evidenceDir: string;
  readonly evidenceStore: ReturnType<typeof createInMemoryEvidenceStore>;
  readonly events: BrowserEventEnvelope[];
  readonly subscribe: (sessionId: string) => () => void;
}

const SCREENSHOT_BYTES = Buffer.from("fake-png-bytes");
const SCREENSHOT_BASE64 = SCREENSHOT_BYTES.toString("base64");

const DEFAULT_RESPONSES: Readonly<Record<string, unknown>> = {
  "Browser.getVersion": { product: "Chrome/130.0", userAgent: "Chrome/130.0" },
  "Target.createTarget": { targetId: "TARGET-123" },
  "Target.attachToTarget": { sessionId: "CDP-SESSION-1" },
  "Page.enable": {},
  "Page.navigate": { httpStatus: 200 },
  "Page.captureScreenshot": { data: SCREENSHOT_BASE64 },
  "DOM.getDocument": { root: { nodeId: 1 } },
  "DOM.getOuterHTML": { outerHTML: "<html><body>secret=hunter2</body></html>" },
  "Target.closeTarget": {},
  "Page.stopLoading": {},
};

function defaultResponder(call: RecordedCall): unknown {
  const response = DEFAULT_RESPONSES[call.method];
  if (response === undefined) {
    throw new Error(`unexpected CDP method: ${call.method}`);
  }
  return response;
}

async function makeFixture(overrides?: {
  readonly responder?: Responder;
  readonly redactor?: (v: unknown) => unknown;
  readonly fetchVersion?: (url: string) => Promise<unknown>;
  readonly useRealFetchVersion?: boolean;
}): Promise<ManagerFixture> {
  const evidenceDir = await realpath(await mkdtemp(join(tmpdir(), "keiko-browser-")));
  const evidenceStore = createInMemoryEvidenceStore();
  let captured: FakeCdpClient | undefined;
  const events: BrowserEventEnvelope[] = [];
  const stubFetchVersion = (): Promise<unknown> =>
    Promise.resolve({
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/xyz",
      "User-Agent": "Chrome/130.0",
      Browser: "Chrome/130.0",
    });
  const fetchVersion =
    overrides?.useRealFetchVersion === true
      ? undefined
      : (overrides?.fetchVersion ?? stubFetchVersion);
  const manager = createBrowserSessionManager({
    evidenceDir,
    evidenceStore,
    redactor:
      overrides?.redactor ??
      ((value: unknown): unknown =>
        typeof value === "string" ? value.replace(/secret=[^<]+/g, "secret=***") : value),
    ...(fetchVersion === undefined ? {} : { fetchVersion }),
    cdpClientFactory: (
      url: string,
      _opts: CdpClientOptions,
    ): import("../../../src/tools/browser/cdp-client.js").CdpClient => {
      const responder = overrides?.responder ?? defaultResponder;
      const c = new FakeCdpClient(url, responder);
      captured = c;
      // Cast through unknown: the manager only relies on connect/send/onEvent/close.
      return c as unknown as import("../../../src/tools/browser/cdp-client.js").CdpClient;
    },
    idleTtlMs: 50,
  });
  return {
    manager,
    get client(): FakeCdpClient {
      if (captured === undefined) throw new Error("client not created yet");
      return captured;
    },
    evidenceDir,
    evidenceStore,
    events,
    subscribe: (sessionId: string): (() => void) =>
      manager.subscribe(sessionId, (event) => {
        events.push(event);
      }),
  };
}

let active: ManagerFixture[] = [];

beforeEach(() => {
  active = [];
});

afterEach(async () => {
  for (const fixture of active) {
    await fixture.manager.dispose();
    await rm(fixture.evidenceDir, { recursive: true, force: true });
  }
  active = [];
});

async function withFixture(overrides?: Parameters<typeof makeFixture>[0]): Promise<ManagerFixture> {
  const fixture = await makeFixture(overrides);
  active.push(fixture);
  return fixture;
}

async function listenHttp(server: Server): Promise<number> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  return (server.address() as AddressInfo).port;
}

async function closeHttp(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

function runIdFromSession(sessionId: string): string {
  return sessionId.replace(/-/g, "");
}

function requireBrowserManifest(
  fixture: ManagerFixture,
  sessionId: string,
): { manifest: EvidenceManifest; browser: EvidenceBrowserCapture } {
  const manifest = loadEvidence(fixture.evidenceStore, runIdFromSession(sessionId));
  if (manifest === undefined) throw new Error("expected browser evidence manifest");
  if (manifest.browser === undefined) throw new Error("expected browser manifest section");
  return { manifest, browser: manifest.browser };
}

describe("openSession", () => {
  it("opens, creates a fresh target, attaches, and emits session-opened", async () => {
    const fixture = await withFixture();
    const meta = await fixture.manager.openSession(9222);
    fixture.subscribe(meta.sessionId);
    expect(meta.targetId).toBe("TARGET-123");
    expect(meta.status).toBe("open");
    const methods = fixture.client.calls.map((c) => c.method);
    expect(methods).toContain("Target.createTarget");
    expect(methods).toContain("Target.attachToTarget");
    expect(methods).toContain("Page.enable");
    // about:blank only — never an existing target
    const created = fixture.client.calls.find((c) => c.method === "Target.createTarget");
    expect(created?.params).toMatchObject({ url: "about:blank" });
  });

  it("records a trust warning when Chrome profile metadata is unavailable", async () => {
    const fixture = await withFixture();
    const meta = await fixture.manager.openSession(9222);
    const manifest = loadEvidence(fixture.evidenceStore, runIdFromSession(meta.sessionId));
    expect(
      manifest?.browser?.events.some(
        (event) =>
          event.type === "browser:trust-warning" &&
          event.warning?.includes("--user-data-dir") === true,
      ),
    ).toBe(true);
  });

  it("rejects opening more than 4 concurrent sessions", async () => {
    const fixture = await withFixture();
    await fixture.manager.openSession(9222);
    await fixture.manager.openSession(9222);
    await fixture.manager.openSession(9222);
    await fixture.manager.openSession(9222);
    await expect(fixture.manager.openSession(9222)).rejects.toMatchObject({
      code: "SESSION_LIMIT_EXCEEDED",
    });
  });

  it("rejects an out-of-range port", async () => {
    const fixture = await withFixture();
    await expect(fixture.manager.openSession(80)).rejects.toMatchObject({ code: "BAD_PORT" });
  });
});

describe("navigate origin re-check", () => {
  it("accepts a loopback navigation, increments counter, and emits navigated", async () => {
    const fixture = await withFixture();
    const meta = await fixture.manager.openSession(9222);
    fixture.subscribe(meta.sessionId);
    setTimeout(() => {
      fixture.client.emitFrameNavigated("http://127.0.0.1:5173/app");
    }, 5);
    const result = await fixture.manager.navigate(meta.sessionId, "http://127.0.0.1:5173/app");
    expect(result.originOnly).toBe("http://127.0.0.1:5173");
    expect(fixture.manager.counterAccessor().navigations).toBe(1);
    const kinds = fixture.events.map((e) => e.kind);
    expect(kinds).toContain("navigated");
  });

  it("rejects post-navigate redirect to a non-loopback origin and stops loading", async () => {
    const fixture = await withFixture();
    const meta = await fixture.manager.openSession(9222);
    fixture.subscribe(meta.sessionId);
    setTimeout(() => {
      fixture.client.emitFrameNavigated("http://evil.example/path");
    }, 5);
    await expect(
      fixture.manager.navigate(meta.sessionId, "http://127.0.0.1:5173/"),
    ).rejects.toMatchObject({ code: "ORIGIN_NOT_ALLOWED" });
    // Page.stopLoading must have been issued.
    expect(fixture.client.calls.some((c) => c.method === "Page.stopLoading")).toBe(true);
    // counter must NOT increment on a rejected navigation
    expect(fixture.manager.counterAccessor().navigations).toBe(0);
    // an error event must have been emitted before the rejection
    expect(fixture.events.some((e) => e.kind === "error")).toBe(true);
  });

  it("rejects loopback redirects to a different port than the requested origin", async () => {
    const fixture = await withFixture();
    const meta = await fixture.manager.openSession(9222);
    fixture.subscribe(meta.sessionId);
    setTimeout(() => {
      fixture.client.emitFrameNavigated("http://127.0.0.1:8501/");
    }, 5);
    await expect(
      fixture.manager.navigate(meta.sessionId, "http://127.0.0.1:5173/"),
    ).rejects.toMatchObject({ code: "ORIGIN_NOT_ALLOWED" });
    expect(fixture.client.calls.some((c) => c.method === "Page.stopLoading")).toBe(true);
    expect(fixture.manager.counterAccessor().navigations).toBe(0);
  });

  it("ignores subframe drift and accepts the main frame on the requested origin", async () => {
    const fixture = await withFixture();
    const meta = await fixture.manager.openSession(9222);
    fixture.subscribe(meta.sessionId);
    setTimeout(() => {
      fixture.client.emitFrameNavigated("http://evil.example/frame", "SUBFRAME-1");
      fixture.client.emitFrameNavigated("http://127.0.0.1:5173/");
    }, 5);
    const result = await fixture.manager.navigate(meta.sessionId, "http://127.0.0.1:5173/");
    expect(result.originOnly).toBe("http://127.0.0.1:5173");
    expect(fixture.client.calls.some((c) => c.method === "Page.stopLoading")).toBe(false);
  });

  it("rejects screenshot when no allowed origin is established", async () => {
    const fixture = await withFixture();
    const meta = await fixture.manager.openSession(9222);
    await expect(fixture.manager.screenshot(meta.sessionId)).rejects.toMatchObject({
      code: "ORIGIN_NOT_ALLOWED",
    });
  });

  it("rejects content capture when no allowed origin is established", async () => {
    const fixture = await withFixture();
    const meta = await fixture.manager.openSession(9222);
    await expect(fixture.manager.content(meta.sessionId)).rejects.toMatchObject({
      code: "ORIGIN_NOT_ALLOWED",
    });
  });

  // Regression: a frameNavigated to a non-loopback origin that arrives DURING the
  // Page.captureScreenshot RPC must invalidate the in-flight capture, not leak bytes.
  it("invalidates in-flight screenshot when origin drifts during the RPC", async () => {
    let driftPending: (() => void) | undefined;
    const responder: Responder = (call): unknown => {
      if (call.method === "Page.captureScreenshot") {
        // Defer the response until the test triggers a frame redirect, then resolve.
        return new Promise((resolve) => {
          driftPending = (): void => {
            resolve({ data: "AAAA" });
          };
        });
      }
      const response = DEFAULT_RESPONSES[call.method];
      if (response === undefined) throw new Error(`unexpected: ${call.method}`);
      return response;
    };
    const fixture = await withFixture({ responder });
    const meta = await fixture.manager.openSession(9222);
    fixture.subscribe(meta.sessionId);
    setTimeout(() => {
      fixture.client.emitFrameNavigated("http://127.0.0.1:5173/");
    }, 5);
    await fixture.manager.navigate(meta.sessionId, "http://127.0.0.1:5173/");
    // Begin a screenshot; the responder hangs on the captureScreenshot RPC.
    const shotPromise = fixture.manager.screenshot(meta.sessionId);
    // Wait a tick so the captureScreenshot frame is actually in flight (responder ran).
    await new Promise<void>((r) => {
      setTimeout(r, 10);
    });
    // Now simulate a redirect mid-RPC.
    fixture.client.emitFrameNavigated("http://evil.example/leak");
    // Then let the captureScreenshot RPC resolve with bytes.
    driftPending?.();
    await expect(shotPromise).rejects.toMatchObject({ code: "ORIGIN_NOT_ALLOWED" });
  });

  it("invalidates in-flight content capture when origin drifts during the RPC", async () => {
    let driftPending: (() => void) | undefined;
    const responder: Responder = (call): unknown => {
      if (call.method === "DOM.getOuterHTML") {
        return new Promise((resolve) => {
          driftPending = (): void => {
            resolve({ outerHTML: "<html>x</html>" });
          };
        });
      }
      const response = DEFAULT_RESPONSES[call.method];
      if (response === undefined) throw new Error(`unexpected: ${call.method}`);
      return response;
    };
    const fixture = await withFixture({ responder });
    const meta = await fixture.manager.openSession(9222);
    fixture.subscribe(meta.sessionId);
    setTimeout(() => {
      fixture.client.emitFrameNavigated("http://127.0.0.1:5173/");
    }, 5);
    await fixture.manager.navigate(meta.sessionId, "http://127.0.0.1:5173/");
    const contentPromise = fixture.manager.content(meta.sessionId);
    await new Promise<void>((r) => {
      setTimeout(r, 10);
    });
    fixture.client.emitFrameNavigated("http://evil.example/leak");
    driftPending?.();
    await expect(contentPromise).rejects.toMatchObject({ code: "ORIGIN_NOT_ALLOWED" });
  });
});

describe("screenshot dry-run vs apply", () => {
  async function navigated(): Promise<{ fixture: ManagerFixture; sessionId: string }> {
    const fixture = await withFixture();
    const meta = await fixture.manager.openSession(9222);
    fixture.subscribe(meta.sessionId);
    setTimeout(() => {
      fixture.client.emitFrameNavigated("http://127.0.0.1:5173/");
    }, 5);
    await fixture.manager.navigate(meta.sessionId, "http://127.0.0.1:5173/");
    return { fixture, sessionId: meta.sessionId };
  }

  it("dry-run screenshot does not persist", async () => {
    const { fixture, sessionId } = await navigated();
    const result = await fixture.manager.screenshot(sessionId);
    if (result.persisted) throw new Error("expected dry-run");
    expect(result.dataBase64).toBe(SCREENSHOT_BASE64);
    expect(result.seq).toBe(1);
  });

  it("apply persists the side-file under the per-run subdir with sha256", async () => {
    const { fixture, sessionId } = await navigated();
    const dry = await fixture.manager.screenshot(sessionId);
    const applied = await fixture.manager.applyScreenshot(sessionId, dry.seq);
    if (!applied.persisted) throw new Error("expected persisted");
    expect(applied.path).toBe("browser-1.png");
    expect(applied.sha256).toHaveLength(64);
    // Locate the per-run subdir.
    const ids = fixture.manager.listSessionIds();
    expect(ids).toHaveLength(1);
    const runId = ids[0]?.replace(/-/g, "") ?? "";
    const onDisk = await readFile(join(fixture.evidenceDir, runId, "browser-1.png"));
    expect(onDisk.equals(SCREENSHOT_BYTES)).toBe(true);
  });

  it("apply without a dry-run capture returns NO_PENDING_SCREENSHOT", async () => {
    const { fixture, sessionId } = await navigated();
    await expect(fixture.manager.applyScreenshot(sessionId, 999)).rejects.toMatchObject({
      code: "NO_PENDING_SCREENSHOT",
    });
  });

  it("apply removes the pending entry so a second apply fails", async () => {
    const { fixture, sessionId } = await navigated();
    const dry = await fixture.manager.screenshot(sessionId);
    await fixture.manager.applyScreenshot(sessionId, dry.seq);
    await expect(fixture.manager.applyScreenshot(sessionId, dry.seq)).rejects.toMatchObject({
      code: "NO_PENDING_SCREENSHOT",
    });
  });
});

describe("content redaction", () => {
  it("captured HTML is redacted before being returned", async () => {
    const fixture = await withFixture();
    const meta = await fixture.manager.openSession(9222);
    fixture.subscribe(meta.sessionId);
    setTimeout(() => {
      fixture.client.emitFrameNavigated("http://127.0.0.1:5173/");
    }, 5);
    await fixture.manager.navigate(meta.sessionId, "http://127.0.0.1:5173/");
    const result = await fixture.manager.content(meta.sessionId);
    expect(result.redactedHtml).toContain("secret=***");
    expect(result.redactedHtml).not.toContain("hunter2");
    expect(result.byteLength).toBeGreaterThan(0);
  });

  it("enforces the content size cap after redaction", async () => {
    const fixture = await withFixture({
      responder: (call): unknown => {
        if (call.method === "DOM.getOuterHTML") return { outerHTML: "<html>x</html>" };
        return defaultResponder(call);
      },
      redactor: (value: unknown): unknown =>
        typeof value === "string" ? "x".repeat(2 * 1024 * 1024 + 1) : value,
    });
    const meta = await fixture.manager.openSession(9222);
    fixture.subscribe(meta.sessionId);
    setTimeout(() => {
      fixture.client.emitFrameNavigated("http://127.0.0.1:5173/");
    }, 5);
    await fixture.manager.navigate(meta.sessionId, "http://127.0.0.1:5173/");
    await expect(fixture.manager.content(meta.sessionId)).rejects.toMatchObject({
      code: "CONTENT_TOO_LARGE",
    });
  });
});

describe("browser evidence manifest", () => {
  async function navigated(): Promise<{ fixture: ManagerFixture; sessionId: string }> {
    const fixture = await withFixture();
    const meta = await fixture.manager.openSession(9222);
    fixture.subscribe(meta.sessionId);
    setTimeout(() => {
      fixture.client.emitFrameNavigated("http://127.0.0.1:5173/");
    }, 5);
    await fixture.manager.navigate(meta.sessionId, "http://127.0.0.1:5173/");
    return { fixture, sessionId: meta.sessionId };
  }

  function expectPersistedScreenshotEvidence(
    browser: EvidenceBrowserCapture,
    captureSeq: number,
  ): void {
    const screenshot = browser.screenshots?.[0];
    if (screenshot === undefined) throw new Error("expected screenshot evidence");
    expect(screenshot).toMatchObject({
      seq: captureSeq,
      path: "browser-1.png",
      bytes: SCREENSHOT_BYTES.length,
    });
    const dryRunEvent = browser.events.find(
      (event) =>
        event.type === "browser:screenshot-captured" &&
        event.captureSeq === captureSeq &&
        event.persisted === false,
    );
    expect(screenshot.capturedAt).toBe(dryRunEvent?.ts);
    expect(screenshot.sha256).toHaveLength(64);
  }

  function expectCapturedContentEvidence(browser: EvidenceBrowserCapture): void {
    const content = browser.contentCaptures?.[0];
    if (content === undefined) throw new Error("expected content capture evidence");
    expect(content.redactedHtml).toContain("secret=***");
    expect(content.redactedHtml).not.toContain("hunter2");
  }

  function expectBrowserEventTypes(browser: EvidenceBrowserCapture): void {
    expect(browser.events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "browser:session-opened",
        "browser:navigated",
        "browser:screenshot-captured",
        "browser:page-content-captured",
      ]),
    );
  }

  it("persists screenshots, content captures, and audit-shaped browser events", async () => {
    const { fixture, sessionId } = await navigated();
    const dry = await fixture.manager.screenshot(sessionId);
    await fixture.manager.applyScreenshot(sessionId, dry.seq);
    await fixture.manager.content(sessionId);
    const { manifest, browser } = requireBrowserManifest(fixture, sessionId);
    expect(manifest.run.taskType).toBe("browser-capture");
    expect(browser.sessionId).toBe(sessionId);
    expectPersistedScreenshotEvidence(browser, dry.seq);
    expectCapturedContentEvidence(browser);
    expectBrowserEventTypes(browser);
  });

  it("persists browser:error events for failed session actions", async () => {
    const { fixture, sessionId } = await navigated();
    await expect(fixture.manager.applyScreenshot(sessionId, 999)).rejects.toMatchObject({
      code: "NO_PENDING_SCREENSHOT",
    });
    const manifest = loadEvidence(fixture.evidenceStore, runIdFromSession(sessionId));
    expect(
      manifest?.browser?.events.some(
        (event) => event.type === "browser:error" && event.code === "NO_PENDING_SCREENSHOT",
      ),
    ).toBe(true);
  });
});

describe("closeSession + dispose", () => {
  it("closeSession emits session-closed and removes the record", async () => {
    const fixture = await withFixture();
    const meta = await fixture.manager.openSession(9222);
    fixture.subscribe(meta.sessionId);
    await fixture.manager.closeSession(meta.sessionId);
    expect(fixture.manager.listSessionIds()).toHaveLength(0);
    expect(fixture.events.some((e) => e.kind === "session-closed")).toBe(true);
    // SESSION_NOT_FOUND after close
    await expect(
      fixture.manager.navigate(meta.sessionId, "http://127.0.0.1:5173/"),
    ).rejects.toMatchObject({
      code: "SESSION_NOT_FOUND",
    });
  });

  it("dispose closes every active session", async () => {
    const fixture = await withFixture();
    await fixture.manager.openSession(9222);
    await fixture.manager.openSession(9222);
    await fixture.manager.dispose();
    expect(fixture.manager.listSessionIds()).toHaveLength(0);
  });

  it("cleans up the session and emits session-closed when Chrome disconnects", async () => {
    const fixture = await withFixture();
    const meta = await fixture.manager.openSession(9222);
    fixture.subscribe(meta.sessionId);
    fixture.client.emitClosed("chrome-disconnected");
    expect(fixture.manager.listSessionIds()).toHaveLength(0);
    const closeEvent = fixture.events.find((event) => event.kind === "session-closed");
    expect(closeEvent?.payload.reason).toBe("chrome-disconnected");
  });
});

describe("subscribe", () => {
  it("emits to multiple subscribers and unsubscribe stops further events", async () => {
    const fixture = await withFixture();
    const meta = await fixture.manager.openSession(9222);
    const a: BrowserEventEnvelope[] = [];
    const b: BrowserEventEnvelope[] = [];
    const offA = fixture.manager.subscribe(meta.sessionId, (e) => a.push(e));
    fixture.manager.subscribe(meta.sessionId, (e) => b.push(e));
    setTimeout(() => {
      fixture.client.emitFrameNavigated("http://127.0.0.1:5173/");
    }, 5);
    await fixture.manager.navigate(meta.sessionId, "http://127.0.0.1:5173/");
    expect(a.some((e) => e.kind === "navigated")).toBe(true);
    expect(b.some((e) => e.kind === "navigated")).toBe(true);
    offA();
    await fixture.manager.closeSession(meta.sessionId);
    expect(a.some((e) => e.kind === "session-closed")).toBe(false);
    expect(b.some((e) => e.kind === "session-closed")).toBe(true);
  });
});

describe("webSocketDebuggerUrl host validation (H1)", () => {
  it("rejects a WS URL pointing to a non-loopback host", async () => {
    const fixture = await withFixture({
      fetchVersion: () =>
        Promise.resolve({
          webSocketDebuggerUrl: "ws://evil.example:9222/devtools/browser/x",
          "User-Agent": "Chrome/130",
          Browser: "Chrome/130",
        }),
    });
    await expect(fixture.manager.openSession(9222)).rejects.toMatchObject({
      code: "CDP_TRANSPORT_REFUSED",
    });
  });

  it("rejects a WS URL whose port differs from the user-supplied port", async () => {
    const fixture = await withFixture({
      fetchVersion: () =>
        Promise.resolve({
          webSocketDebuggerUrl: "ws://127.0.0.1:9999/devtools/browser/x",
          "User-Agent": "Chrome/130",
          Browser: "Chrome/130",
        }),
    });
    await expect(fixture.manager.openSession(9222)).rejects.toMatchObject({
      code: "CDP_TRANSPORT_REFUSED",
    });
  });

  it("does not follow redirects from the CDP /json/version endpoint", async () => {
    let targetHits = 0;
    const target = createServer((_req, res) => {
      targetHits += 1;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/redirected",
        }),
      );
    });
    const targetPort = await listenHttp(target);
    const redirect = createServer((_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${String(targetPort)}/json/version` });
      res.end();
    });
    const redirectPort = await listenHttp(redirect);
    try {
      const fixture = await withFixture({ useRealFetchVersion: true });
      await expect(fixture.manager.openSession(redirectPort)).rejects.toMatchObject({
        code: "CDP_TRANSPORT_REFUSED",
      });
      expect(targetHits).toBe(0);
    } finally {
      await closeHttp(redirect);
      await closeHttp(target);
    }
  });
});

describe("pending screenshot cap (M1)", () => {
  async function navigatedForCap(): Promise<{ fixture: ManagerFixture; sessionId: string }> {
    const fixture = await withFixture();
    const meta = await fixture.manager.openSession(9222);
    fixture.subscribe(meta.sessionId);
    setTimeout(() => {
      fixture.client.emitFrameNavigated("http://127.0.0.1:5173/");
    }, 5);
    await fixture.manager.navigate(meta.sessionId, "http://127.0.0.1:5173/");
    return { fixture, sessionId: meta.sessionId };
  }

  it("caps pendingScreenshots at 1 and evicts the oldest entry on the 2nd", async () => {
    const { fixture, sessionId } = await navigatedForCap();
    await fixture.manager.screenshot(sessionId);
    await fixture.manager.screenshot(sessionId);
    // seq=1 must have been evicted.
    await expect(fixture.manager.applyScreenshot(sessionId, 1)).rejects.toMatchObject({
      code: "NO_PENDING_SCREENSHOT",
    });
    // seq=2 (most recent, still in map) must still be present.
    const applied = await fixture.manager.applyScreenshot(sessionId, 2);
    expect(applied.persisted).toBe(true);
  });
});

describe("session-limit TOCTOU reservation (M2)", () => {
  it("allows at most 4 concurrent openSession calls to succeed", async () => {
    const releaseSignals: (() => void)[] = [];
    const fixture = await withFixture({
      fetchVersion: () =>
        new Promise<unknown>((resolve) => {
          // Hold the version fetch until release() is called so all 6 calls are in-flight.
          releaseSignals.push(() => {
            resolve({
              webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/x",
              "User-Agent": "Chrome/130",
              Browser: "Chrome/130",
            });
          });
        }),
    });
    // Fire 6 concurrent openSession calls.
    const openOne = (): Promise<{ ok: true } | { ok: false; err: unknown }> =>
      fixture.manager.openSession(9222).then(
        () => ({ ok: true as const }),
        (err: unknown) => ({ ok: false as const, err }),
      );
    const promises = [openOne(), openOne(), openOne(), openOne(), openOne(), openOne()];
    // Allow all held version fetches to resolve.
    for (const release of releaseSignals) release();
    const results = await Promise.all(promises);
    const successes = results.filter((r) => r.ok);
    const failures = results.filter((r): r is { ok: false; err: unknown } => !r.ok);
    expect(successes).toHaveLength(4);
    expect(failures).toHaveLength(2);
    for (const f of failures) {
      expect((f.err as { code?: string }).code).toBe("SESSION_LIMIT_EXCEEDED");
    }
  });
});
