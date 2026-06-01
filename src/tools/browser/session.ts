// ADR-0017 D3/D6/D9 — browser session manager. In-memory Map of sessionId→record, 4-session cap,
// 30-min idle TTL, fresh Target.createTarget only (never attaches to user tabs), post-navigate
// frameNavigated origin re-check, dry-run-by-default screenshots, redactor over captured HTML.
//
// Security invariants:
//   • webSocketDebuggerUrl from /json/version is validated for loopback host + matching port (H1).
//   • pendingScreenshots per session is capped at MAX_PENDING_SCREENSHOTS (4) with insertion-order
//     eviction to bound memory use (M1).
//   • Session slot is reserved synchronously before any await to prevent TOCTOU on the limit (M2).
//
// Composition: validators (M1) + CDP client (M2) + side-file writer (M3) + the existing audit
// redactor. No new safety primitives — every guard is reused.

import { randomUUID } from "node:crypto";
import { CdpClient, type CdpClientOptions, type CdpEventListener } from "./cdp-client.js";
import { BrowserToolError } from "./errors.js";
import {
  isLoopbackHost,
  isLoopbackUrl,
  normalizeCdpPort,
  normalizeNavigateUrl,
} from "./validators.js";
import type {
  BrowserContentResult,
  BrowserNavigateResult,
  BrowserScreenshotResult,
  BrowserSessionMeta,
  BrowserViewportPx,
  CdpReachability,
} from "./types.js";
import { writeSideFile, type SideFileWriterOptions } from "../../audit/side-file.js";

const MAX_SESSIONS = 4;
const SESSION_IDLE_TTL_MS = 30 * 60 * 1000;
const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;
const MAX_CONTENT_BYTES = 2 * 1024 * 1024;
// M1: cap per-session pending screenshots; oldest (insertion-order) is evicted on overflow.
const MAX_PENDING_SCREENSHOTS = 4;
const DEFAULT_VIEWPORT: BrowserViewportPx = { width: 1280, height: 800 };
const FRAGMENT_RECHECK_TIMEOUT_MS = 5000;
const VERSION_PATH = "/json/version";

export type BrowserEventKind =
  | "session-opened"
  | "navigated"
  | "screenshot-captured"
  | "page-content-captured"
  | "session-closed"
  | "trust-warning"
  | "error";

export interface BrowserEventEnvelope {
  readonly kind: BrowserEventKind;
  readonly sessionId: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export type BrowserEventEmitter = (event: BrowserEventEnvelope) => void;

export interface BrowserSessionManagerOptions {
  readonly evidenceDir: string;
  readonly redactor?: (value: unknown) => unknown;
  readonly cdpClientFactory?: (url: string, opts: CdpClientOptions) => CdpClient;
  readonly fetchVersion?: (url: string) => Promise<unknown>;
  readonly sideFileOptions?: SideFileWriterOptions;
  readonly idleTtlMs?: number;
  readonly nowMs?: () => number;
}

interface PendingScreenshot {
  readonly seq: number;
  readonly viewportPx: BrowserViewportPx;
  readonly bytes: Buffer;
}

interface SessionRecord {
  readonly id: string;
  readonly cdpPort: number;
  readonly targetId: string;
  readonly client: CdpClient;
  readonly cdpSessionId: string;
  readonly runId: string;
  lastUrl: string | null;
  lastOriginOnly: string | null;
  originAllowed: boolean;
  captureSeq: number;
  pendingScreenshots: Map<number, PendingScreenshot>;
  idleTimer: NodeJS.Timeout | undefined;
  lastTouchedMs: number;
  closed: boolean;
  removeCdpListener: () => void;
}

interface AttachResult {
  readonly sessionId: string;
}
interface CreateTargetResult {
  readonly targetId: string;
}
interface ScreenshotCdpResult {
  readonly data: string;
}
interface DocumentRoot {
  readonly root: { readonly nodeId: number };
}
interface OuterHtmlResult {
  readonly outerHTML: string;
}
interface FrameNavigatedParams {
  readonly frame?: { readonly url?: string };
}

export interface BrowserSessionManager {
  readonly checkStatus: (cdpPort: number) => Promise<CdpReachability>;
  readonly openSession: (cdpPort: number) => Promise<BrowserSessionMeta>;
  readonly closeSession: (sessionId: string) => Promise<void>;
  readonly navigate: (sessionId: string, url: string) => Promise<BrowserNavigateResult>;
  readonly screenshot: (sessionId: string) => Promise<BrowserScreenshotResult>;
  readonly applyScreenshot: (
    sessionId: string,
    captureSeq: number,
  ) => Promise<BrowserScreenshotResult>;
  readonly content: (sessionId: string) => Promise<BrowserContentResult>;
  readonly listSessionIds: () => readonly string[];
  readonly dispose: () => Promise<void>;
  readonly subscribe: (sessionId: string, listener: BrowserEventEmitter) => () => void;
  readonly counterAccessor: () => { readonly navigations: number };
}

function defaultRedactor(value: unknown): unknown {
  return value;
}

interface VersionInfo {
  readonly url: string;
  readonly userAgent: string | null;
  readonly browserVersion: string | null;
}

// H1: validate webSocketDebuggerUrl host+port so a malicious /json/version responder
// cannot redirect the WebSocket to a non-loopback host (ADR-0017 D2 layer-1).
function assertWsUrlTrusted(ws: string, expectedPort: number): void {
  let parsed: URL;
  try {
    parsed = new URL(ws);
  } catch {
    throw new BrowserToolError(
      "CDP_TRANSPORT_REFUSED",
      "CDP endpoint returned an invalid WebSocket URL.",
    );
  }
  const host =
    parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]")
      ? parsed.hostname.slice(1, -1)
      : parsed.hostname;
  const port =
    parsed.port === "" ? (parsed.protocol === "wss:" ? 443 : 80) : Number.parseInt(parsed.port, 10);
  if (!isLoopbackHost(host) || port !== expectedPort) {
    throw new BrowserToolError(
      "CDP_TRANSPORT_REFUSED",
      "CDP endpoint returned a WebSocket URL that is not on the expected loopback address.",
    );
  }
}

function browserWsUrlFromVersion(version: unknown, fallbackPort: number): VersionInfo {
  if (typeof version !== "object" || version === null) {
    return defaultVersionInfo(fallbackPort);
  }
  const rec = version as Record<string, unknown>;
  const ws = rec.webSocketDebuggerUrl;
  if (typeof ws !== "string" || !ws.startsWith("ws://")) {
    return defaultVersionInfo(fallbackPort);
  }
  assertWsUrlTrusted(ws, fallbackPort);
  const ua = rec["User-Agent"] ?? rec.userAgent;
  const product = rec.Browser ?? rec.product;
  return {
    url: ws,
    userAgent: typeof ua === "string" ? ua : null,
    browserVersion: typeof product === "string" ? product : null,
  };
}

function defaultVersionInfo(port: number): VersionInfo {
  return {
    url: `ws://127.0.0.1:${String(port)}/devtools/browser`,
    userAgent: null,
    browserVersion: null,
  };
}

async function fetchVersionJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new BrowserToolError("CHROME_UNREACHABLE", "CDP version endpoint returned a non-200.");
  }
  return res.json() as Promise<unknown>;
}

function isChromiumUserAgent(userAgent: string | null): boolean {
  if (userAgent === null) return true;
  // Single-pass linear scan — substring matches only, no regex (ADR-0002 ReDoS gate).
  return (
    userAgent.includes("Chrome") ||
    userAgent.includes("Chromium") ||
    userAgent.includes("HeadlessChrome")
  );
}

function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

// The class form keeps each method small (max-lines-per-function gate) while sharing one private
// state region. Method names match the BrowserSessionManager port shape.
class BrowserSessionManagerImpl implements BrowserSessionManager {
  private readonly opts: BrowserSessionManagerOptions;
  private readonly redactor: (value: unknown) => unknown;
  private readonly clientFactory: (url: string, opts: CdpClientOptions) => CdpClient;
  private readonly fetchVersion: (url: string) => Promise<unknown>;
  private readonly idleTtlMs: number;
  private readonly nowMs: () => number;
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly subscribers = new Map<string, Set<BrowserEventEmitter>>();
  private readonly counters = { navigations: 0 };

  public constructor(opts: BrowserSessionManagerOptions) {
    this.opts = opts;
    this.redactor = opts.redactor ?? defaultRedactor;
    this.clientFactory =
      opts.cdpClientFactory ?? ((url, options): CdpClient => new CdpClient(url, options));
    this.fetchVersion = opts.fetchVersion ?? fetchVersionJson;
    this.idleTtlMs = opts.idleTtlMs ?? SESSION_IDLE_TTL_MS;
    this.nowMs = opts.nowMs ?? ((): number => Date.now());
  }

  public readonly checkStatus = async (cdpPort: number): Promise<CdpReachability> => {
    normalizeCdpPort(cdpPort);
    try {
      const url = `http://127.0.0.1:${String(cdpPort)}${VERSION_PATH}`;
      const version = await this.fetchVersion(url);
      const meta = browserWsUrlFromVersion(version, cdpPort);
      if (!isChromiumUserAgent(meta.userAgent)) {
        throw new BrowserToolError(
          "CHROME_VERSION_MISMATCH",
          "CDP endpoint is not a Chromium-based browser.",
        );
      }
      return {
        reachable: true,
        userAgent: meta.userAgent,
        browserVersion: meta.browserVersion,
        webSocketDebuggerUrl: meta.url,
      };
    } catch (error) {
      if (error instanceof BrowserToolError) throw error;
      return {
        reachable: false,
        userAgent: null,
        browserVersion: null,
        webSocketDebuggerUrl: null,
      };
    }
  };

  private buildPlaceholder(id: string, cdpPort: number): SessionRecord {
    // A closed sentinel record that reserves the sessions slot without an active CdpClient.
    // It is replaced by the live record inside attachAndRegister once the CDP handshake
    // completes. Because closed=true, requireRecord and closeSession treat it as unavailable.
    const noop = (): void => undefined;
    const fakeClient = {
      connect: (): Promise<void> => Promise.resolve(),
      send: (): Promise<Record<string, unknown>> => Promise.resolve({}),
      onEvent: (): (() => void) => noop,
      close: noop,
      isClosed: (): boolean => true,
      closeCause: (): undefined => undefined,
    } as unknown as CdpClient;
    return {
      id,
      cdpPort,
      targetId: "",
      client: fakeClient,
      cdpSessionId: "",
      runId: id.replace(/-/g, ""),
      lastUrl: null,
      lastOriginOnly: null,
      originAllowed: false,
      captureSeq: 0,
      pendingScreenshots: new Map(),
      idleTimer: undefined,
      lastTouchedMs: this.nowMs(),
      closed: true,
      removeCdpListener: noop,
    };
  }

  public readonly openSession = async (cdpPort: number): Promise<BrowserSessionMeta> => {
    normalizeCdpPort(cdpPort);
    // M2: reserve the slot synchronously before any await, closing the TOCTOU window where
    // concurrent calls could each pass the size check and then all succeed.
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new BrowserToolError("SESSION_LIMIT_EXCEEDED", "Too many active browser sessions.");
    }
    const reservedId = randomUUID();
    const placeholder = this.buildPlaceholder(reservedId, cdpPort);
    this.sessions.set(reservedId, placeholder);
    try {
      const versionInfo = await this.checkStatus(cdpPort);
      if (!versionInfo.reachable || versionInfo.webSocketDebuggerUrl === null) {
        throw new BrowserToolError("CHROME_UNREACHABLE", "CDP endpoint is not reachable.");
      }
      const client = this.clientFactory(versionInfo.webSocketDebuggerUrl, {});
      try {
        return await this.attachAndRegister(client, cdpPort, reservedId);
      } catch (error) {
        client.close();
        if (error instanceof BrowserToolError) throw error;
        throw new BrowserToolError("CHROME_UNREACHABLE", "Failed to open browser session.");
      }
    } catch (error) {
      this.sessions.delete(reservedId);
      throw error;
    }
  };

  private async attachAndRegister(
    client: CdpClient,
    cdpPort: number,
    reservedId: string,
  ): Promise<BrowserSessionMeta> {
    await client.connect();
    const target = await client.send<CreateTargetResult>("Target.createTarget", {
      url: "about:blank",
    });
    const attach = await client.send<AttachResult>("Target.attachToTarget", {
      targetId: target.targetId,
      flatten: true,
    });
    const record = this.buildRecord(client, cdpPort, target.targetId, attach.sessionId, reservedId);
    record.removeCdpListener = client.onEvent(this.frameNavigatedListener(record));
    await client.send("Page.enable", {}, attach.sessionId);
    this.sessions.set(record.id, record);
    this.touch(record);
    await this.emitTrustWarningIfHeadless(client, record.id);
    this.emit({
      kind: "session-opened",
      sessionId: record.id,
      payload: { cdpPort, targetId: target.targetId },
    });
    return {
      sessionId: record.id,
      cdpPort,
      targetId: target.targetId,
      status: "open",
      createdAt: this.nowMs(),
    };
  }

  private buildRecord(
    client: CdpClient,
    cdpPort: number,
    targetId: string,
    cdpSessionId: string,
    id: string = randomUUID(),
  ): SessionRecord {
    return {
      id,
      cdpPort,
      targetId,
      client,
      cdpSessionId,
      runId: id.replace(/-/g, ""),
      lastUrl: null,
      lastOriginOnly: null,
      originAllowed: false,
      captureSeq: 0,
      pendingScreenshots: new Map(),
      idleTimer: undefined,
      lastTouchedMs: this.nowMs(),
      closed: false,
      removeCdpListener: (): void => undefined,
    };
  }

  private async emitTrustWarningIfHeadless(client: CdpClient, sessionId: string): Promise<void> {
    const browser = await client
      .send<Record<string, unknown>>("Browser.getVersion")
      .catch(() => null);
    if (
      browser !== null &&
      typeof browser.userAgent === "string" &&
      browser.userAgent.includes("Headless")
    ) {
      this.emit({
        kind: "trust-warning",
        sessionId,
        payload: { warning: "Headless Chromium detected; verify ephemeral --user-data-dir." },
      });
    }
  }

  public readonly closeSession = async (sessionId: string): Promise<void> => {
    const record = this.sessions.get(sessionId);
    if (record === undefined || record.closed) return;
    record.closed = true;
    if (record.idleTimer !== undefined) clearTimeout(record.idleTimer);
    record.removeCdpListener();
    try {
      await record.client.send("Target.closeTarget", { targetId: record.targetId });
    } catch {
      // Best-effort cleanup; the BFF is shutting the session down regardless.
    }
    record.client.close();
    this.sessions.delete(sessionId);
    this.emit({ kind: "session-closed", sessionId, payload: { reason: "explicit" } });
  };

  public readonly navigate = async (
    sessionId: string,
    url: string,
  ): Promise<BrowserNavigateResult> => {
    const record = this.requireRecord(sessionId);
    const normalized = normalizeNavigateUrl(url);
    this.touch(record);
    record.originAllowed = false;
    record.lastUrl = null;
    record.lastOriginOnly = null;
    const cdpStatus = await this.invokeNavigate(record, normalized.url);
    await this.waitForOriginRecheck(record, normalized.originOnly);
    // record.originAllowed is mutated by the async frameNavigated listener; the TS narrower can't
    // see across the awaited recheck so a runtime guard remains required here.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!record.originAllowed) {
      throw new BrowserToolError(
        "ORIGIN_NOT_ALLOWED",
        "Post-navigate origin is not on the loopback interface.",
      );
    }
    this.counters.navigations += 1;
    this.emit({
      kind: "navigated",
      sessionId,
      payload: { originOnly: record.lastOriginOnly, httpStatus: cdpStatus },
    });
    return { originOnly: normalized.originOnly, httpStatus: cdpStatus };
  };

  private async invokeNavigate(record: SessionRecord, url: string): Promise<number | null> {
    try {
      const result = await record.client.send<{ httpStatus?: number }>(
        "Page.navigate",
        { url },
        record.cdpSessionId,
      );
      return typeof result.httpStatus === "number" ? result.httpStatus : null;
    } catch (error) {
      const code = error instanceof BrowserToolError ? error.code : "CHROME_UNREACHABLE";
      this.emitError(record.id, code, "Navigation failed.");
      throw error;
    }
  }

  private async waitForOriginRecheck(record: SessionRecord, expectedOrigin: string): Promise<void> {
    const deadline = this.nowMs() + FRAGMENT_RECHECK_TIMEOUT_MS;
    while (record.lastUrl === null && this.nowMs() < deadline) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20);
      });
    }
    if (record.lastUrl === null) {
      // No frameNavigated arrived (e.g. a fast 204 or already-stopped load). Trust the pre-navigate
      // validator: the requested URL was loopback, so allow capture against that origin.
      record.originAllowed = true;
      record.lastOriginOnly = expectedOrigin;
    }
  }

  public readonly screenshot = async (sessionId: string): Promise<BrowserScreenshotResult> => {
    const record = this.requireRecord(sessionId);
    this.requireOriginAllowed(record, "Screenshot");
    this.touch(record);
    const result = await record.client.send<ScreenshotCdpResult>(
      "Page.captureScreenshot",
      { format: "png" },
      record.cdpSessionId,
    );
    // Defence in depth against the frameNavigated race: if a redirect arrived while
    // captureScreenshot was in flight, the listener has now run and flipped originAllowed.
    // Discard the bytes rather than hand evidence from a non-loopback origin to the caller.
    if (!record.originAllowed) {
      throw new BrowserToolError(
        "ORIGIN_NOT_ALLOWED",
        "Screenshot blocked: origin drifted off-loopback during capture.",
      );
    }
    const bytes = Buffer.from(result.data, "base64");
    if (bytes.length > MAX_SCREENSHOT_BYTES) {
      throw new BrowserToolError("SCREENSHOT_TOO_LARGE", "Screenshot exceeds the size limit.");
    }
    record.captureSeq += 1;
    const seq = record.captureSeq;
    // M1: evict the oldest entry if the cap is reached (Map is insertion-ordered).
    if (record.pendingScreenshots.size >= MAX_PENDING_SCREENSHOTS) {
      const oldest = record.pendingScreenshots.keys().next().value;
      if (oldest !== undefined) record.pendingScreenshots.delete(oldest);
    }
    record.pendingScreenshots.set(seq, { seq, viewportPx: DEFAULT_VIEWPORT, bytes });
    this.emit({
      kind: "screenshot-captured",
      sessionId,
      payload: { captureSeq: seq, persisted: false, viewportPx: DEFAULT_VIEWPORT },
    });
    return { seq, viewportPx: DEFAULT_VIEWPORT, dataBase64: result.data, persisted: false };
  };

  public readonly applyScreenshot = (
    sessionId: string,
    captureSeq: number,
  ): Promise<BrowserScreenshotResult> => {
    const record = this.requireRecord(sessionId);
    const pending = record.pendingScreenshots.get(captureSeq);
    if (pending === undefined) {
      return Promise.reject(
        new BrowserToolError("NO_PENDING_SCREENSHOT", "No pending screenshot for this sequence."),
      );
    }
    this.touch(record);
    const name = `browser-${String(pending.seq)}.png`;
    const written = writeSideFile(
      this.opts.evidenceDir,
      record.runId,
      name,
      pending.bytes,
      this.opts.sideFileOptions,
    );
    record.pendingScreenshots.delete(captureSeq);
    this.emit({
      kind: "screenshot-captured",
      sessionId,
      payload: {
        captureSeq,
        persisted: true,
        viewportPx: pending.viewportPx,
        path: written.relativePath,
        sha256: written.sha256,
      },
    });
    return Promise.resolve({
      seq: pending.seq,
      viewportPx: pending.viewportPx,
      persisted: true,
      path: written.relativePath,
      sha256: written.sha256,
      bytes: written.bytes,
    });
  };

  public readonly content = async (sessionId: string): Promise<BrowserContentResult> => {
    const record = this.requireRecord(sessionId);
    this.requireOriginAllowed(record, "Content capture");
    this.touch(record);
    const doc = await record.client.send<DocumentRoot>("DOM.getDocument", {}, record.cdpSessionId);
    const html = await record.client.send<OuterHtmlResult>(
      "DOM.getOuterHTML",
      { nodeId: doc.root.nodeId },
      record.cdpSessionId,
    );
    // Defence in depth against the frameNavigated race during the DOM.getOuterHTML RPC.
    if (!record.originAllowed) {
      throw new BrowserToolError(
        "ORIGIN_NOT_ALLOWED",
        "Content capture blocked: origin drifted off-loopback during capture.",
      );
    }
    const raw = html.outerHTML;
    if (Buffer.byteLength(raw, "utf8") > MAX_CONTENT_BYTES) {
      throw new BrowserToolError("CONTENT_TOO_LARGE", "Page content exceeds the size limit.");
    }
    const redacted = this.redactor(raw);
    const redactedHtml = typeof redacted === "string" ? redacted : raw;
    record.captureSeq += 1;
    const seq = record.captureSeq;
    const byteLength = Buffer.byteLength(redactedHtml, "utf8");
    this.emit({
      kind: "page-content-captured",
      sessionId,
      payload: { captureSeq: seq, byteLength },
    });
    return { seq, byteLength, redactedHtml };
  };

  public readonly listSessionIds = (): readonly string[] => [...this.sessions.keys()];

  public readonly dispose = async (): Promise<void> => {
    for (const id of [...this.sessions.keys()]) {
      await this.closeSession(id);
    }
  };

  public readonly subscribe = (sessionId: string, listener: BrowserEventEmitter): (() => void) => {
    let set = this.subscribers.get(sessionId);
    if (set === undefined) {
      set = new Set<BrowserEventEmitter>();
      this.subscribers.set(sessionId, set);
    }
    const targetSet = set;
    targetSet.add(listener);
    return (): void => {
      targetSet.delete(listener);
      if (targetSet.size === 0) this.subscribers.delete(sessionId);
    };
  };

  public readonly counterAccessor = (): { readonly navigations: number } => this.counters;

  private requireRecord(sessionId: string): SessionRecord {
    const record = this.sessions.get(sessionId);
    if (record === undefined || record.closed) {
      throw new BrowserToolError("SESSION_NOT_FOUND", "Browser session not found.");
    }
    return record;
  }

  private requireOriginAllowed(record: SessionRecord, subject: string): void {
    if (record.originAllowed) return;
    throw new BrowserToolError(
      "ORIGIN_NOT_ALLOWED",
      `${subject} blocked: current origin is not on the loopback interface.`,
    );
  }

  private touch(record: SessionRecord): void {
    record.lastTouchedMs = this.nowMs();
    if (record.idleTimer !== undefined) clearTimeout(record.idleTimer);
    record.idleTimer = setTimeout(() => {
      void this.closeSession(record.id).catch(() => undefined);
    }, this.idleTtlMs).unref();
  }

  private emit(event: BrowserEventEnvelope): void {
    const set = this.subscribers.get(event.sessionId);
    if (set === undefined) return;
    for (const listener of [...set]) {
      try {
        listener(event);
      } catch {
        // A subscriber throwing must not stop fan-out.
      }
    }
  }

  private emitError(sessionId: string, code: string, message: string): void {
    this.emit({ kind: "error", sessionId, payload: { code, message } });
  }

  private frameNavigatedListener(record: SessionRecord): CdpEventListener {
    return (event): void => {
      if (event.method !== "Page.frameNavigated") return;
      const params = event.params as FrameNavigatedParams;
      const url = params.frame?.url;
      if (typeof url !== "string" || url.length === 0) return;
      // Ignore navigations triggered by Target.createTarget("about:blank") and similar.
      if (url === "about:blank") return;
      record.lastUrl = url;
      if (isLoopbackUrl(url)) {
        record.originAllowed = true;
        record.lastOriginOnly = safeOrigin(url);
        return;
      }
      record.originAllowed = false;
      // Best-effort stop loading; ignore the rejection — the next caller will see
      // ORIGIN_NOT_ALLOWED on screenshot/content anyway.
      void record.client.send("Page.stopLoading", {}, record.cdpSessionId).catch(() => undefined);
      this.emitError(
        record.id,
        "ORIGIN_NOT_ALLOWED",
        "Navigation drifted to a non-loopback origin.",
      );
    };
  }
}

export function createBrowserSessionManager(
  options: BrowserSessionManagerOptions,
): BrowserSessionManager {
  return new BrowserSessionManagerImpl(options);
}
