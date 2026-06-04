// ADR-0017 D3/D6/D9 — browser session manager. In-memory Map of sessionId→record, 4-session cap,
// 30-min idle TTL, fresh Target.createTarget only (never attaches to user tabs), post-navigate
// frameNavigated origin re-check, dry-run-by-default screenshots, redactor over captured HTML.
//
// Security invariants:
//   • webSocketDebuggerUrl from /json/version is validated for loopback host + matching port (H1).
//   • pendingScreenshots per session is capped at MAX_PENDING_SCREENSHOTS (1) with insertion-order
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
import {
  EVIDENCE_SCHEMA_VERSION,
  HARNESS_VERSION,
  type CostClass,
  type EvidenceBrowserContentCapture,
  type EvidenceBrowserEvent,
  type EvidenceBrowserScreenshot,
  type EvidenceManifest,
  type EvidenceStore,
  type SideFileWriteResult,
} from "@oscharko-dev/keiko-contracts";

const MAX_SESSIONS = 4;
const SESSION_IDLE_TTL_MS = 30 * 60 * 1000;
const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;
const MAX_CONTENT_BYTES = 2 * 1024 * 1024;
const MAX_VERSION_BODY_BYTES = 64_000;
const VERSION_FETCH_TIMEOUT_MS = 5000;
// M1: cap per-session pending screenshots; oldest (insertion-order) is evicted on overflow.
const MAX_PENDING_SCREENSHOTS = 1;
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
  readonly schemaVersion: "1";
  readonly type: `browser:${BrowserEventKind}`;
  readonly runId: string;
  readonly fingerprint: string;
  readonly seq: number;
  readonly ts: number;
  readonly kind: BrowserEventKind;
  readonly sessionId: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export type BrowserEventEmitter = (event: BrowserEventEnvelope) => void;

// Port-injected side-file writer: the BFF closes over baseDir and the WorkspaceFs adapter and
// passes (basename, bytes, runId) through. The tools package never touches `src/audit/**`
// directly (ADR-0019 trust rule 6 + direction rule 3c). Required iff `evidenceStore` is set —
// session.applyScreenshot fails closed otherwise.
export type BrowserSideFileWriter = (
  basename: string,
  bytes: Buffer,
  runId: string,
) => SideFileWriteResult;

export interface BrowserSessionManagerOptions {
  readonly evidenceDir: string;
  readonly evidenceStore?: EvidenceStore | undefined;
  readonly redactor?: (value: unknown) => unknown;
  readonly cdpClientFactory?: (url: string, opts: CdpClientOptions) => CdpClient;
  readonly fetchVersion?: (url: string) => Promise<unknown>;
  // ADR-0019 trust-6 + direction-3c: tools cannot import src/audit. The BFF injects these.
  readonly costClassResolver?: (modelId: string) => CostClass | "unknown";
  readonly sideFileWriter?: BrowserSideFileWriter;
  readonly idleTtlMs?: number;
  readonly nowMs?: () => number;
}

interface PendingScreenshot {
  readonly seq: number;
  readonly viewportPx: BrowserViewportPx;
  readonly bytes: Buffer;
  readonly capturedAt: number;
}

interface SessionRecord {
  readonly id: string;
  readonly cdpPort: number;
  readonly targetId: string;
  readonly client: CdpClient;
  readonly cdpSessionId: string;
  readonly runId: string;
  readonly fingerprint: string;
  readonly startedAt: number;
  closedAt: number | undefined;
  closeReason: string | undefined;
  lastUrl: string | null;
  lastOriginOnly: string | null;
  expectedOriginOnly: string | null;
  originAllowed: boolean;
  captureSeq: number;
  auditSeq: number;
  auditEvents: EvidenceBrowserEvent[];
  screenshots: EvidenceBrowserScreenshot[];
  contentCaptures: EvidenceBrowserContentCapture[];
  pendingScreenshots: Map<number, PendingScreenshot>;
  idleTimer: NodeJS.Timeout | undefined;
  lastTouchedMs: number;
  closed: boolean;
  removeCdpListener: () => void;
  removeCdpCloseListener: () => void;
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
  readonly frame?: { readonly url?: string; readonly parentId?: string };
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
  readonly hasSession: (sessionId: string) => boolean;
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
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, VERSION_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { redirect: "manual", signal: controller.signal });
    if (res.url !== url || (res.status >= 300 && res.status < 400)) {
      throw new BrowserToolError("CDP_TRANSPORT_REFUSED", "CDP version endpoint redirected.");
    }
    if (!res.ok) {
      throw new BrowserToolError("CHROME_UNREACHABLE", "CDP version endpoint returned a non-200.");
    }
    const text = await readCappedText(res);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new BrowserToolError(
        "CHROME_UNREACHABLE",
        "CDP version endpoint returned invalid JSON.",
      );
    }
  } catch (error) {
    if (error instanceof BrowserToolError) throw error;
    throw new BrowserToolError("CHROME_UNREACHABLE", "CDP version endpoint is unreachable.");
  } finally {
    clearTimeout(timer);
  }
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

type EvidenceBrowserEventPatch = Partial<
  Omit<EvidenceBrowserEvent, "schemaVersion" | "type" | "sessionId" | "seq" | "ts">
>;

function evidenceStringField(
  key: keyof EvidenceBrowserEventPatch,
  value: unknown,
): EvidenceBrowserEventPatch {
  return typeof value === "string" ? { [key]: value } : {};
}

function evidenceNumberField(
  key: keyof EvidenceBrowserEventPatch,
  value: unknown,
): EvidenceBrowserEventPatch {
  return typeof value === "number" ? { [key]: value } : {};
}

function evidenceBooleanField(
  key: keyof EvidenceBrowserEventPatch,
  value: unknown,
): EvidenceBrowserEventPatch {
  return typeof value === "boolean" ? { [key]: value } : {};
}

function evidenceNullableNumberField(
  key: keyof EvidenceBrowserEventPatch,
  value: unknown,
): EvidenceBrowserEventPatch {
  return typeof value === "number" || value === null ? { [key]: value } : {};
}

function browserViewportPayload(value: unknown): BrowserViewportPx | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const rec = value as Record<string, unknown>;
  return typeof rec.width === "number" && typeof rec.height === "number"
    ? { width: rec.width, height: rec.height }
    : undefined;
}

function evidenceViewportField(value: unknown): EvidenceBrowserEventPatch {
  const viewportPx = browserViewportPayload(value);
  return viewportPx === undefined ? {} : { viewportPx };
}

function isSubframeNavigation(params: FrameNavigatedParams): boolean {
  return typeof params.frame?.parentId === "string" && params.frame.parentId.length > 0;
}

function mainFrameUrl(params: FrameNavigatedParams): string | null {
  const url = params.frame?.url;
  if (typeof url !== "string" || url.length === 0 || url === "about:blank") return null;
  return url;
}

async function readCappedText(res: Response): Promise<string> {
  if (res.body === null) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_VERSION_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new BrowserToolError(
        "PAYLOAD_TOO_LARGE",
        "CDP version response exceeds the size limit.",
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

// The class form keeps each method small (max-lines-per-function gate) while sharing one private
// state region. Method names match the BrowserSessionManager port shape.
class BrowserSessionManagerImpl implements BrowserSessionManager {
  private readonly opts: BrowserSessionManagerOptions;
  private readonly redactor: (value: unknown) => unknown;
  private readonly clientFactory: (url: string, opts: CdpClientOptions) => CdpClient;
  private readonly fetchVersion: (url: string) => Promise<unknown>;
  // Falls back to "unknown" when the BFF didn't inject a resolver (e.g. evidence-store-less
  // dev runs). Manifests still build; just no per-model cost tier annotation.
  private readonly costClassResolver: (modelId: string) => CostClass | "unknown";
  // Optional — applyScreenshot fails closed (BrowserToolError code SIDE_FILE_WRITER_MISSING)
  // when evidenceStore is set but no writer was injected; preserves the audit invariant.
  private readonly sideFileWriter: BrowserSideFileWriter | undefined;
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
    this.costClassResolver = opts.costClassResolver ?? ((): CostClass | "unknown" => "unknown");
    this.sideFileWriter = opts.sideFileWriter;
    this.idleTtlMs = opts.idleTtlMs ?? SESSION_IDLE_TTL_MS;
    this.nowMs = opts.nowMs ?? ((): number => Date.now());
  }

  private toEvidenceEvent(event: BrowserEventEnvelope): EvidenceBrowserEvent {
    const p = event.payload;
    return {
      schemaVersion: "1",
      type: event.type,
      sessionId: event.sessionId,
      seq: event.seq,
      ts: event.ts,
      ...evidenceStringField("originOnly", p.originOnly),
      ...evidenceNullableNumberField("httpStatus", p.httpStatus),
      ...evidenceNumberField("captureSeq", p.captureSeq),
      ...evidenceBooleanField("persisted", p.persisted),
      ...evidenceViewportField(p.viewportPx),
      ...evidenceStringField("path", p.path),
      ...evidenceStringField("sha256", p.sha256),
      ...evidenceNumberField("bytes", p.bytes),
      ...evidenceNumberField("byteLength", p.byteLength),
      ...evidenceStringField("reason", p.reason),
      ...evidenceStringField("warning", p.warning),
      ...evidenceStringField("code", p.code),
      ...evidenceStringField("message", p.message),
    };
  }

  private buildManifest(record: SessionRecord): EvidenceManifest {
    const finishedAt = record.closedAt ?? this.nowMs();
    const manifest: EvidenceManifest = {
      evidenceSchemaVersion: EVIDENCE_SCHEMA_VERSION,
      run: {
        runId: record.runId,
        fingerprint: record.fingerprint,
        harnessVersion: HARNESS_VERSION,
        taskType: "browser-capture",
        outcome: "completed",
        startedAt: record.startedAt,
        finishedAt,
        durationMs: Math.max(0, finishedAt - record.startedAt),
      },
      model: { modelId: "browser-tool", costClass: this.costClassResolver("browser-tool") },
      usageTotals: { promptTokens: 0, completionTokens: 0, requestCount: 0, totalLatencyMs: 0 },
      stateTransitions: [],
      toolCalls: [],
      commandExecutions: [],
      browser: {
        sessionId: record.id,
        cdpPort: record.cdpPort,
        targetId: record.targetId,
        status: record.closed ? "closed" : "open",
        startedAt: record.startedAt,
        ...(record.closedAt === undefined ? {} : { closedAt: record.closedAt }),
        ...(record.closeReason === undefined ? {} : { closeReason: record.closeReason }),
        ...(record.lastOriginOnly === null ? {} : { lastOriginOnly: record.lastOriginOnly }),
        events: record.auditEvents,
        ...(record.screenshots.length === 0 ? {} : { screenshots: record.screenshots }),
        ...(record.contentCaptures.length === 0 ? {} : { contentCaptures: record.contentCaptures }),
      },
    };
    const redacted = this.redactor(manifest);
    return typeof redacted === "object" && redacted !== null
      ? (redacted as EvidenceManifest)
      : manifest;
  }

  private persistRecord(record: SessionRecord): void {
    const store = this.opts.evidenceStore;
    if (store === undefined) return;
    const manifest = this.buildManifest(record);
    store.put(record.runId, JSON.stringify(manifest, null, 2));
  }

  private emitRecord(
    record: SessionRecord,
    kind: BrowserEventKind,
    payload: Readonly<Record<string, unknown>>,
    ts: number = this.nowMs(),
  ): BrowserEventEnvelope {
    record.auditSeq += 1;
    const event: BrowserEventEnvelope = {
      schemaVersion: "1",
      type: `browser:${kind}`,
      runId: record.runId,
      fingerprint: record.fingerprint,
      seq: record.auditSeq,
      ts,
      kind,
      sessionId: record.id,
      payload,
    };
    record.auditEvents.push(this.toEvidenceEvent(event));
    this.persistRecord(record);
    this.fanout(event);
    return event;
  }

  private emitErrorRecord(record: SessionRecord, code: string, message: string): void {
    this.emitRecord(record, "error", { code, message });
  }

  private async runSessionAction<T>(
    sessionId: string,
    action: (record: SessionRecord) => Promise<T> | T,
  ): Promise<T> {
    const record = this.requireRecord(sessionId);
    try {
      return await action(record);
    } catch (error) {
      if (error instanceof BrowserToolError) {
        this.emitErrorRecord(record, error.code, error.message);
      }
      throw error;
    }
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
      onClose: (): (() => void) => noop,
      close: noop,
      isClosed: (): boolean => true,
      closeCause: (): undefined => undefined,
    } as unknown as CdpClient;
    const now = this.nowMs();
    return {
      id,
      cdpPort,
      targetId: "",
      client: fakeClient,
      cdpSessionId: "",
      runId: id.replace(/-/g, ""),
      fingerprint: `browser-${id.replace(/-/g, "")}`,
      startedAt: now,
      closedAt: undefined,
      closeReason: undefined,
      lastUrl: null,
      lastOriginOnly: null,
      expectedOriginOnly: null,
      originAllowed: false,
      captureSeq: 0,
      auditSeq: 0,
      auditEvents: [],
      screenshots: [],
      contentCaptures: [],
      pendingScreenshots: new Map(),
      idleTimer: undefined,
      lastTouchedMs: now,
      closed: true,
      removeCdpListener: noop,
      removeCdpCloseListener: noop,
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
    record.removeCdpCloseListener = client.onClose((reason) => {
      if (reason === "explicit") return;
      void this.closeRecord(record, "chrome-disconnected", false).catch(() => undefined);
    });
    await client.send("Page.enable", {}, attach.sessionId);
    this.sessions.set(record.id, record);
    this.touch(record);
    await this.emitTrustWarningForProfileMetadata(client, record);
    this.emitRecord(record, "session-opened", { cdpPort, targetId: target.targetId });
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
    const runId = id.replace(/-/g, "");
    const now = this.nowMs();
    return {
      id,
      cdpPort,
      targetId,
      client,
      cdpSessionId,
      runId,
      fingerprint: `browser-${runId}`,
      startedAt: now,
      closedAt: undefined,
      closeReason: undefined,
      lastUrl: null,
      lastOriginOnly: null,
      expectedOriginOnly: null,
      originAllowed: false,
      captureSeq: 0,
      auditSeq: 0,
      auditEvents: [],
      screenshots: [],
      contentCaptures: [],
      pendingScreenshots: new Map(),
      idleTimer: undefined,
      lastTouchedMs: now,
      closed: false,
      removeCdpListener: (): void => undefined,
      removeCdpCloseListener: (): void => undefined,
    };
  }

  private async emitTrustWarningForProfileMetadata(
    client: CdpClient,
    record: SessionRecord,
  ): Promise<void> {
    const browser = await client
      .send<Record<string, unknown>>("Browser.getVersion")
      .catch(() => null);
    const commandLine = browser?.commandLine;
    if (typeof commandLine === "string" && commandLine.includes("--user-data-dir=")) {
      return;
    }
    const warning =
      browser !== null &&
      typeof browser.userAgent === "string" &&
      browser.userAgent.includes("Headless")
        ? "Headless Chromium detected; verify ephemeral --user-data-dir."
        : "Chrome command-line metadata unavailable; verify ephemeral --user-data-dir.";
    if (warning.length > 0) {
      this.emitRecord(record, "trust-warning", {
        warning,
      });
    }
  }

  public readonly closeSession = async (sessionId: string): Promise<void> => {
    const record = this.sessions.get(sessionId);
    if (record === undefined || record.closed) return;
    await this.closeRecord(record, "explicit", true);
  };

  private async closeRecord(
    record: SessionRecord,
    reason: string,
    closeTarget: boolean,
  ): Promise<void> {
    if (record.closed) return;
    record.closed = true;
    record.closedAt = this.nowMs();
    record.closeReason = reason;
    if (record.idleTimer !== undefined) clearTimeout(record.idleTimer);
    record.removeCdpListener();
    record.removeCdpCloseListener();
    if (closeTarget) {
      try {
        await record.client.send("Target.closeTarget", { targetId: record.targetId });
      } catch {
        // Best-effort cleanup; the BFF is shutting the session down regardless.
      }
      record.client.close();
    }
    this.sessions.delete(record.id);
    try {
      this.emitRecord(record, "session-closed", { reason });
    } finally {
      this.subscribers.delete(record.id);
    }
  }

  public readonly navigate = async (
    sessionId: string,
    url: string,
  ): Promise<BrowserNavigateResult> => {
    return this.runSessionAction(sessionId, async (record) => {
      const normalized = normalizeNavigateUrl(url);
      this.touch(record);
      record.originAllowed = false;
      record.lastUrl = null;
      record.lastOriginOnly = null;
      record.expectedOriginOnly = normalized.originOnly;
      const cdpStatus = await this.invokeNavigate(record, normalized.url);
      await this.waitForOriginRecheck(record, normalized.originOnly);
      // record.originAllowed is mutated by the async frameNavigated listener; the TS narrower can't
      // see across the awaited recheck so a runtime guard remains required here.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (!record.originAllowed) {
        throw new BrowserToolError(
          "ORIGIN_NOT_ALLOWED",
          "Post-navigate origin is not on the requested loopback origin.",
        );
      }
      this.counters.navigations += 1;
      this.emitRecord(record, "navigated", {
        originOnly: record.lastOriginOnly,
        httpStatus: cdpStatus,
      });
      return { originOnly: normalized.originOnly, httpStatus: cdpStatus };
    });
  };

  private async invokeNavigate(record: SessionRecord, url: string): Promise<number | null> {
    const result = await record.client.send<{ httpStatus?: number }>(
      "Page.navigate",
      { url },
      record.cdpSessionId,
    );
    return typeof result.httpStatus === "number" ? result.httpStatus : null;
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
    return this.runSessionAction(sessionId, async (record) => {
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
      const capturedAt = this.nowMs();
      // M1: evict the oldest entry if the cap is reached (Map is insertion-ordered).
      if (record.pendingScreenshots.size >= MAX_PENDING_SCREENSHOTS) {
        const oldest = record.pendingScreenshots.keys().next().value;
        if (oldest !== undefined) record.pendingScreenshots.delete(oldest);
      }
      record.pendingScreenshots.set(seq, { seq, viewportPx: DEFAULT_VIEWPORT, bytes, capturedAt });
      this.emitRecord(
        record,
        "screenshot-captured",
        {
          captureSeq: seq,
          persisted: false,
          viewportPx: DEFAULT_VIEWPORT,
        },
        capturedAt,
      );
      return { seq, viewportPx: DEFAULT_VIEWPORT, dataBase64: result.data, persisted: false };
    });
  };

  public readonly applyScreenshot = async (
    sessionId: string,
    captureSeq: number,
  ): Promise<BrowserScreenshotResult> =>
    this.runSessionAction(sessionId, (record) => {
      const pending = record.pendingScreenshots.get(captureSeq);
      if (pending === undefined) {
        throw new BrowserToolError(
          "NO_PENDING_SCREENSHOT",
          "No pending screenshot for this sequence.",
        );
      }
      this.touch(record);
      const name = `browser-${String(pending.seq)}.png`;
      // Fail-closed: a configured evidenceStore implies the BFF promised side-file persistence.
      // Without an injected writer we cannot honour that promise — refuse rather than silently
      // drop binary evidence (ADR-0017 D5; preserves the audit invariant after the R3 split).
      if (this.sideFileWriter === undefined) {
        throw new BrowserToolError(
          "SIDE_FILE_WRITER_MISSING",
          "No side-file writer was injected; cannot persist screenshot binary evidence.",
        );
      }
      const written = this.sideFileWriter(name, pending.bytes, record.runId);
      const screenshot: EvidenceBrowserScreenshot = {
        seq: pending.seq,
        viewportPx: pending.viewportPx,
        path: written.relativePath,
        sha256: written.sha256,
        bytes: written.bytes,
        capturedAt: pending.capturedAt,
      };
      record.screenshots.push(screenshot);
      record.pendingScreenshots.delete(captureSeq);
      this.emitRecord(record, "screenshot-captured", {
        captureSeq,
        persisted: true,
        viewportPx: pending.viewportPx,
        path: written.relativePath,
        sha256: written.sha256,
        bytes: written.bytes,
      });
      return {
        seq: pending.seq,
        viewportPx: pending.viewportPx,
        persisted: true,
        path: written.relativePath,
        sha256: written.sha256,
        bytes: written.bytes,
      };
    });

  public readonly content = async (sessionId: string): Promise<BrowserContentResult> => {
    return this.runSessionAction(sessionId, async (record) => {
      this.requireOriginAllowed(record, "Content capture");
      this.touch(record);
      const doc = await record.client.send<DocumentRoot>(
        "DOM.getDocument",
        {},
        record.cdpSessionId,
      );
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
      const byteLength = Buffer.byteLength(redactedHtml, "utf8");
      if (byteLength > MAX_CONTENT_BYTES) {
        throw new BrowserToolError("CONTENT_TOO_LARGE", "Page content exceeds the size limit.");
      }
      record.captureSeq += 1;
      const seq = record.captureSeq;
      record.contentCaptures.push({ seq, byteLength, capturedAt: this.nowMs(), redactedHtml });
      this.emitRecord(record, "page-content-captured", { captureSeq: seq, byteLength });
      return { seq, byteLength, redactedHtml };
    });
  };

  public readonly listSessionIds = (): readonly string[] => [...this.sessions.keys()];

  public readonly hasSession = (sessionId: string): boolean => {
    const record = this.sessions.get(sessionId);
    return record !== undefined && !record.closed;
  };

  public readonly dispose = async (): Promise<void> => {
    for (const id of [...this.sessions.keys()]) {
      const record = this.sessions.get(id);
      if (record !== undefined) {
        await this.closeRecord(record, "process-exit", true);
      }
    }
  };

  public readonly subscribe = (sessionId: string, listener: BrowserEventEmitter): (() => void) => {
    if (!this.hasSession(sessionId)) {
      return (): void => undefined;
    }
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
      void this.closeRecord(record, "idle-timeout", true).catch(() => undefined);
    }, this.idleTtlMs).unref();
  }

  private fanout(event: BrowserEventEnvelope): void {
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

  private frameNavigatedListener(record: SessionRecord): CdpEventListener {
    return (event): void => {
      if (event.method !== "Page.frameNavigated") return;
      this.handleFrameNavigated(record, event.params as FrameNavigatedParams);
    };
  }

  private handleFrameNavigated(record: SessionRecord, params: FrameNavigatedParams): void {
    if (isSubframeNavigation(params)) return;
    const url = mainFrameUrl(params);
    if (url === null) return;
    record.lastUrl = url;
    const originOnly = safeOrigin(url);
    if (this.isExpectedOrigin(record, url, originOnly)) {
      record.originAllowed = true;
      record.lastOriginOnly = originOnly;
      return;
    }
    this.rejectFrameNavigation(record, originOnly);
  }

  private isExpectedOrigin(
    record: SessionRecord,
    url: string,
    originOnly: string | null,
  ): originOnly is string {
    return isLoopbackUrl(url) && originOnly !== null && originOnly === record.expectedOriginOnly;
  }

  private rejectFrameNavigation(record: SessionRecord, originOnly: string | null): void {
    record.originAllowed = false;
    record.lastOriginOnly = originOnly;
    // Best-effort stop loading; ignore the rejection — the next caller will see
    // ORIGIN_NOT_ALLOWED on screenshot/content anyway.
    void record.client.send("Page.stopLoading", {}, record.cdpSessionId).catch(() => undefined);
    this.emitErrorRecord(
      record,
      "ORIGIN_NOT_ALLOWED",
      "Navigation drifted away from the requested loopback origin.",
    );
  }
}

export function createBrowserSessionManager(
  options: BrowserSessionManagerOptions,
): BrowserSessionManager {
  return new BrowserSessionManagerImpl(options);
}
