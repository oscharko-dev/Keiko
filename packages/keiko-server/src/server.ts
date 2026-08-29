// The local UI BFF binds 127.0.0.1 only, applies security headers and CSP to every response,
// rejects non-loopback Host/Origin headers, dispatches API routes through injected handlers,
// and serves the static export from a contained root.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join } from "node:path";
import { Readable } from "node:stream";
import { createGzip } from "node:zlib";
import { applySecurityHeaders } from "./headers.js";
import { isAllowedHost } from "./host-check.js";
import { requestAlreadyClosed } from "./request-cancellation.js";
import { resolveContainedPath, serveFile } from "./static.js";
import {
  errorBody,
  isApiPath,
  matchRoute,
  methodNotAllowedBody,
  notFoundBody,
  STREAMING,
  type ApiError,
  type RouteContext,
} from "./routes.js";
import { buildRedactor, type UiHandlerDeps } from "./deps.js";
import {
  MAX_LOG_STRING_LENGTH,
  nullServerLogSink,
  redactRoutePath,
  type ServerLogSink,
} from "./observability/server-log.js";
import { CORRELATION_RESPONSE_HEADER, resolveCorrelationId } from "./correlation.js";
import { emitServerDiagnostic, serverDiagnosticFromError } from "./diagnostics-log.js";
import { isVoiceDictationCapable, isVoiceRealtimeCapable } from "./read-handlers.js";
import { createVoiceControlPlane } from "./voice-realtime.js";
import { createVoiceLiveDictationPlane } from "./voice-live-dictation.js";
import { createRunRegistry } from "./runs.js";
import { createInMemoryUiStore } from "./store/index.js";

// Canonical values live in the contracts leaf (GEN-PERF-CLI-001) so the CLI can
// read them without loading this module graph; imported and re-exported here so
// the keiko-server public surface is unchanged.
import { UI_HOST } from "@oscharko-dev/keiko-contracts/runtime/bff-wire";
export { UI_HOST };
export { DEFAULT_UI_PORT } from "@oscharko-dev/keiko-contracts/runtime/bff-wire";
const CSP_CACHE_TTL_MS = 1000;
const JSON_GZIP_MIN_BYTES = 1024;
// The http-request line's query-param-NAME field admits only a bounded identifier shape — the
// same bar `log-redaction.ts`'s own field-name guard holds a field NAME to, applied here to a
// query PARAM name before it ever reaches `extra`. Restated rather than imported: importing
// `log-redaction.ts`'s private constant here would reach across the redaction choke point for a
// shape both files already independently agree is "a bounded identifier",
// `^[A-Za-z_][A-Za-z0-9_.-]{0,63}$`.
const QUERY_PARAM_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
// Mirrors the bounded-array discipline every other array field in this schema already has
// (`MAX_LOG_ARRAY_LENGTH`, `keikoStackFrames`' own frame cap): a request with more distinct query
// parameter names than this is truncated, not silently grown without limit. Exported for
// `server.test.ts` only, so a cap-boundary test reads the real production limit instead of
// restating it as a second, independently-drifting literal.
export const MAX_QUERY_PARAM_NAMES = 16;
const cspCache = new WeakMap<
  UiServerDeps,
  { readonly value: string; readonly expiresAt: number }
>();

export interface UiServerDeps {
  // Absolute path to the directory holding the exported static assets (`dist/ui/static`).
  readonly staticRoot: string;
  // Fallback CSP header value (with the static export's inline-script hashes folded in).
  readonly csp: string;
  // Optional live CSP source. The CLI uses this to refresh hashes from the current build artifacts
  // across rebuild/restart races; tests and compatibility callers can keep using the fixed `csp`.
  readonly cspProvider?: (() => string | Promise<string>) | undefined;
  readonly cspCacheTtlMs?: number | undefined;
  // The port the server will bind; used to validate the request `Host`/`Origin` authority.
  readonly port: number;
  // The JSON/SSE handler dependencies. Optional: when absent the server still serves static assets
  // and the health route, and the API handlers degrade gracefully (null config, empty evidence).
  readonly handlerDeps?: UiHandlerDeps | undefined;
  /** Test-only override for the bounded live-dictation initial-frame deadline. */
  readonly liveDictationInitialFrameTimeoutMs?: number | undefined;
  // Structured activity log sink. When present, every incoming HTTP request writes one line
  // (method, path, status, duration, correlation id) into a plain-text JSON log the operator
  // can read. Absent by default so unit tests stay hermetic; the CLI wires the file-backed sink.
  readonly activityLog?: ServerLogSink | undefined;
}

// Per-request scratch space the http-request line reads at response `close`, populated as the
// request is actually resolved: `handle` fills in the query-parameter fields as soon as the URL is
// parsed and `dispatchApi`/`serveStatic` fill in `routeTemplate` once the route (or its absence)
// is known. A fresh object is created once per incoming request and threaded explicitly through
// the same call chain `correlationId` already travels — plain per-request state, not a keyed
// side-table. The response size is NOT tracked here: `logRequestOnClose` measures it on the socket
// (see `responseBytes` there), so every writer — JSON, gzip, static file, SSE stream — is counted
// the same way without each one reporting. Exported for `server.test.ts` only (not part of the
// package's public entry point, mirroring how `request-cancellation.ts` exports its own
// req/res-close shapes for the same reason).
export interface RequestLogContext {
  routeTemplate?: string;
  queryParamNames?: readonly string[];
  queryParamDroppedCount?: number;
}

function acceptsGzip(acceptEncoding: string | readonly string[] | undefined): boolean {
  const value =
    typeof acceptEncoding === "string" ? acceptEncoding : (acceptEncoding ?? []).join(",");
  return value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .some((item) => item === "gzip" || item.startsWith("gzip;"));
}

function writeJson(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string | readonly string[]>> = {},
): void {
  res.statusCode = status;
  for (const [key, value] of Object.entries(headers)) {
    res.setHeader(key, typeof value === "string" ? value : [...value]);
  }
  if (status === 204 || status === 304) {
    res.end();
    return;
  }
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (payload.byteLength >= JSON_GZIP_MIN_BYTES && acceptsGzip(req.headers["accept-encoding"])) {
    res.setHeader("Content-Encoding", "gzip");
    res.setHeader("Vary", "Accept-Encoding");
    Readable.from(payload).pipe(createGzip()).pipe(res);
    return;
  }
  res.setHeader("Content-Length", payload.byteLength);
  res.end(payload);
}

function isJsonRequest(req: IncomingMessage): boolean {
  const header = req.headers["content-type"];
  const value = typeof header === "string" ? header : header?.[0];
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function hasCsrfHeader(req: IncomingMessage): boolean {
  const header = req.headers["x-keiko-csrf"];
  const value = Array.isArray(header) ? header[0] : header;
  return value === "1";
}

function rejectUnsupportedMediaType(req: IncomingMessage, res: ServerResponse): void {
  writeJson(
    req,
    res,
    415,
    errorBody("UNSUPPORTED_MEDIA_TYPE", "State-changing API requests must use JSON."),
  );
}

function rejectCsrf(req: IncomingMessage, res: ServerResponse): void {
  writeJson(req, res, 403, errorBody("FORBIDDEN_CSRF", "Missing state-changing request guard."));
}

// A minimal default deps object so a 3-arg server can still serve the deps-bound read routes (e.g.
// `/api/models` and `/api/workspace`, which need no config) without a config or evidence dir. The
// fallback UI store is in-memory: a 3-arg server is used by the Wave 1 host smoke and by tests that
// never exercise the store routes, so an ephemeral in-memory store is the safe degraded shape.
function fallbackDeps(): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store: createInMemoryUiStore(),
  };
}

function isStateChangingMethod(method: string): boolean {
  return method === "POST" || method === "PATCH" || method === "PUT" || method === "DELETE";
}

// KEIKO-0885: this exemption skips the X-Keiko-CSRF header requirement for the coding-sidecar
// gateway's OpenAI-compatible chat/completions POST -- an SDK client that speaks the OpenAI
// wire format cannot send a Keiko-defined header. The compensating control is
// authenticateGatewayRequest in packages/keiko-server/src/coding-sidecar-gateway.ts (session-
// pairing + attestation) which authenticates every request to this route before any state
// change happens; the loopback Host/Origin check (host-check.ts:isAllowedHost) runs
// unconditionally upstream of both. DO NOT add a second route to this exemption without
// verifying it carries an equivalent per-request authenticator, and update the pin test in
// server.test.ts that captures the exempt-route allowlist at exactly one entry.
function isCsrfExemptStateChange(method: string, pathname: string): boolean {
  return method === "POST" && pathname === "/api/coding-sidecar/gateway/chat/completions";
}

// Returns true when the request was rejected (caller should return immediately).
function rejectIfInvalidStateChange(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  pathname: string,
): boolean {
  if (!isJsonRequest(req)) {
    rejectUnsupportedMediaType(req, res);
    return true;
  }
  if (isCsrfExemptStateChange(method, pathname)) {
    return false;
  }
  if (!hasCsrfHeader(req)) {
    rejectCsrf(req, res);
    return true;
  }
  return false;
}

// The route-template reduction of the raw path, for a request `dispatchApi` never resolved to a
// declared route (404/405) or that never entered API dispatch at all (a static asset). A matched
// API request gets the exact `RouteDefinition.pattern` instead (`dispatchApi` sets it directly) —
// the two no longer come from the same lossy, independently-re-derived heuristic.
function setFallbackRouteTemplate(context: RequestLogContext, pathname: string): void {
  const template = redactRoutePath(pathname, MAX_LOG_STRING_LENGTH);
  if (template !== undefined) context.routeTemplate = template;
}

async function dispatchApi(
  handlerDeps: UiHandlerDeps,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  url: URL,
  correlationId: string,
  context: RequestLogContext,
): Promise<void> {
  const match = matchRoute(method, url.pathname);
  if (match === undefined) {
    setFallbackRouteTemplate(context, url.pathname);
    writeJson(req, res, 404, notFoundBody());
    return;
  }
  if (match === "method-not-allowed") {
    setFallbackRouteTemplate(context, url.pathname);
    writeJson(req, res, 405, methodNotAllowedBody());
    return;
  }
  context.routeTemplate = match.definition.pattern;
  const invalidStateChange =
    isStateChangingMethod(method) && rejectIfInvalidStateChange(req, res, method, url.pathname);
  if (invalidStateChange) {
    return;
  }
  const ctx: RouteContext = { req, res, params: match.params, url, correlationId };
  const outcome = await match.definition.handler(ctx, handlerDeps);
  if (outcome === STREAMING) {
    return;
  }
  writeJson(req, res, outcome.status, outcome.body, outcome.headers);
}

function resolveStaticTargets(pathname: string): readonly string[] {
  if (pathname === "/") {
    return ["/index.html"];
  }
  if (extname(pathname) === "") {
    return [pathname, `${pathname}.html`, `${pathname}/index.html`];
  }
  return [pathname];
}

async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  staticRoot: string,
  pathname: string,
  context: RequestLogContext,
): Promise<void> {
  setFallbackRouteTemplate(context, pathname);
  const targets = resolveStaticTargets(pathname);
  for (const target of targets) {
    const resolved = resolveContainedPath(staticRoot, target);
    if (
      resolved !== undefined &&
      (await serveFile(res, resolved, req.headers["accept-encoding"]))
    ) {
      return;
    }
  }
  const indexPath = join(staticRoot, "index.html");
  if (await serveFile(res, indexPath, req.headers["accept-encoding"])) {
    return;
  }
  writeJson(req, res, 404, errorBody("NOT_FOUND", "The requested resource was not found."));
}

function rejectForbiddenHost(req: IncomingMessage, res: ServerResponse): void {
  const body: ApiError = errorBody("FORBIDDEN_HOST", "Request host is not the local interface.");
  writeJson(req, res, 403, body);
}

async function resolveCsp(deps: UiServerDeps): Promise<string> {
  const cached = cspCache.get(deps);
  const now = Date.now();
  if (cached !== undefined && cached.expiresAt > now) {
    return cached.value;
  }
  const ttlMs = deps.cspCacheTtlMs ?? CSP_CACHE_TTL_MS;
  try {
    const value = (await deps.cspProvider?.()) ?? deps.csp;
    cspCache.set(deps, { value, expiresAt: now + ttlMs });
    return value;
  } catch {
    cspCache.set(deps, { value: deps.csp, expiresAt: now + ttlMs });
    return deps.csp;
  }
}

// Names only — values never leave this function. Deduplicated (a repeated key collapses to one
// name), sorted for a stable line, and capped the same way every other bounded array field in this
// schema is: a name beyond the cap, and any name that is not a bounded identifier (the same shape
// a log field name itself must have), is dropped and COUNTED rather than silently grown or
// silently truncated with no trace.
//
// #2902 audit finding 1: the collection loop is bounded at MAX_QUERY_PARAM_NAMES BEFORE the sort
// runs, rather than sorting the full kept set and slicing afterward — a client fully controls the
// query string, and an unbounded sort (locale-aware, O(n log n)) over an attacker-supplied name
// count is a synchronous, amplifiable CPU cost on the request hot path. The remaining per-name work
// (Set membership + regex test) stays a cheap O(n) pass, the same order as the WHATWG URL parsing
// that already runs unconditionally for routing on every request.
//
// Exported for `server.test.ts` only, so the bound-before-sort ordering can be pinned by calling
// this function directly on a constructed `URL` — no real HTTP request, no spy on the shared
// `Array.prototype.sort`, and no risk of a second call site (in the test) drifting from this one's
// actual cap.
// Plain code-point order (see the comment at the call site): deterministic across hosts.
function codePointOrder(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

export function computeQueryParamFields(url: URL, context: RequestLogContext): void {
  const seen = new Set<string>();
  const kept: string[] = [];
  let dropped = 0;
  for (const name of url.searchParams.keys()) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (!QUERY_PARAM_NAME_PATTERN.test(name)) {
      dropped += 1;
    } else if (kept.length < MAX_QUERY_PARAM_NAMES) {
      kept.push(name);
    } else {
      dropped += 1;
    }
  }
  // A code-point sort, not `localeCompare`: the list is capped at MAX_QUERY_PARAM_NAMES (16), so
  // the cost difference is immaterial, but `localeCompare` depends on the host ICU data and the
  // default locale — two servers could then emit the same request with a different
  // `queryParamNames` order, and this field is compared/deduplicated across hosts.
  kept.sort(codePointOrder);
  context.queryParamNames = kept;
  if (dropped > 0) context.queryParamDroppedCount = dropped;
}

async function handle(
  deps: UiServerDeps,
  handlerDeps: UiHandlerDeps,
  req: IncomingMessage,
  res: ServerResponse,
  correlationId: string,
  context: RequestLogContext,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${UI_HOST}`);
  const apiPath = isApiPath(url.pathname);
  // Issue #495/#497 — scope the Permissions-Policy microphone directive to deployments that advertise
  // speech-to-text dictation OR full-realtime voice (whose WebRTC capture track also needs the mic);
  // a no-voice deployment keeps the strict `microphone=()` default, never widened beyond `(self)`.
  applySecurityHeaders(res, await resolveCsp(deps), apiPath, {
    allowMicrophone: isVoiceDictationCapable(handlerDeps) || isVoiceRealtimeCapable(handlerDeps),
  });
  if (!isAllowedHost(req, deps.port)) {
    rejectForbiddenHost(req, res);
    return;
  }
  // #2902 audit finding 1: computed only once the trust-boundary host check has passed (AGENTS.md
  // "validate before you process") — a FORBIDDEN_HOST request never pays the query-string scan.
  computeQueryParamFields(url, context);
  const method = (req.method ?? "GET").toUpperCase();
  if (apiPath) {
    await dispatchApi(handlerDeps, req, res, method, url, correlationId, context);
    return;
  }
  await serveStatic(req, res, deps.staticRoot, url.pathname, context);
}

function createVoicePlanes(
  port: number,
  handlerDeps: UiHandlerDeps,
  liveDictationInitialFrameTimeoutMs: number | undefined,
): {
  readonly voiceControl: ReturnType<typeof createVoiceControlPlane>;
  readonly liveDictation: ReturnType<typeof createVoiceLiveDictationPlane>;
} {
  return {
    voiceControl: createVoiceControlPlane({
      port,
      handlerDeps: () => handlerDeps,
    }),
    liveDictation: createVoiceLiveDictationPlane({
      port,
      handlerDeps: () => handlerDeps,
      ...(liveDictationInitialFrameTimeoutMs === undefined
        ? {}
        : { initialFrameTimeoutMs: liveDictationInitialFrameTimeoutMs }),
    }),
  };
}

// Creates the BFF server. The caller binds it with `server.listen(deps.port, UI_HOST)` so it never
// listens on a non-loopback interface. The previous PTY WebSocket upgrade handler is removed — the
// terminal tool is now bounded-exec over plain HTTP (ADR-0018 D1/D8). Issue #497 (ADR-0100 D3,
// ADR-0101) re-opens the upgrade for the single loopback voice control path `/api/voice/control`, and
// ONLY when the deployment is full-realtime voice capable; every other upgrade keeps the hard reject.

// Content-free by construction: every value here is a count, a bounded label, or a route
// TEMPLATE — never a raw query value, a header or a body. `path` keeps its pre-existing behaviour
// (reduced generically by `log-redaction.ts`'s own path guard); `routeTemplate` is the field this
// wave adds so a reader learns WHICH declared route actually matched, sourced from the real match
// `dispatchApi` resolved rather than re-derived independently from the same raw path.
interface HttpRequestOutcome {
  readonly method: string;
  readonly path: string;
  readonly aborted: boolean;
  readonly responseBytes: number;
}

function buildHttpRequestExtra(
  outcome: HttpRequestOutcome,
  context: RequestLogContext,
): Record<string, unknown> {
  return {
    method: outcome.method,
    path: outcome.path,
    routeTemplate: context.routeTemplate,
    queryParamNames: context.queryParamNames ?? [],
    queryParamDroppedCount: context.queryParamDroppedCount,
    responseBytes: outcome.responseBytes,
    aborted: outcome.aborted,
  };
}

// Every incoming HTTP request emits ONE structured line in the activity log on close, with the
// correlation id echoed in the response header. Extracted from the createServer callback so the
// top-level handler stays under the 50-line ceiling. `context` is the SAME object `handle`'s call
// chain mutates as the request is actually resolved (query-parameter fields at URL-parse time, the
// matched route pattern once `dispatchApi`/`serveStatic` know it, the response byte count the one
// time `writeJson` actually serialises a body) — read here only once the response has finished or
// the connection has gone away, so every mutation above is guaranteed to have already happened.
//
// `aborted` reuses the SAME `requestAlreadyClosed` predicate `request-cancellation.ts` already uses
// to decide whether an in-flight handler's `AbortSignal` should fire — not a second, independent
// read of `req`/`res` state invented for this line. When the connection is gone AND no response was
// ever actually sent (`!res.headersSent`), `status` is logged as 0 instead of Node's own default
// `res.statusCode` of 200: that default holds from construction regardless of whether anything was
// ever written, so echoing it here for an aborted, header-less response would misreport a dropped
// connection as a successful one.
//
// Exported for `server.test.ts` only, so the close-time behaviour (aborted mid-response before any
// write, a normally completed request) can be driven with the same fake req/res EventEmitter
// doubles `request-cancellation.test.ts` already uses for `requestAlreadyClosed` itself, instead of
// depending on real socket teardown timing.
export function logRequestOnClose(
  req: IncomingMessage,
  res: ServerResponse,
  correlationId: string,
  activityLog: ServerLogSink,
  context: RequestLogContext,
): void {
  const startedAt = Date.now();
  const requestUrl = req.url ?? "";
  const method = req.method ?? "GET";
  // `responseBytes` is what this response actually put on the wire — headers and body, compressed
  // as sent — measured as the socket's `bytesWritten` delta between request arrival and response
  // close. A kept-alive socket serves responses one after another, so the delta belongs to this
  // response alone; every writer (JSON, gzip, static file, SSE stream) is counted the same way,
  // which a per-writer tally could not guarantee (#3247 review: `writeJson` alone reported the
  // uncompressed JSON length and every static asset read as 0).
  const socketBytesAtStart = req.socket.bytesWritten;
  res.on("close", () => {
    const aborted = requestAlreadyClosed({ req, res });
    const status = aborted && !res.headersSent ? 0 : res.statusCode;
    const responseBytes = Math.max(0, req.socket.bytesWritten - socketBytesAtStart);
    activityLog.write({
      category: "http",
      op: "request",
      correlationId,
      status,
      durationMs: Date.now() - startedAt,
      extra: buildHttpRequestExtra(
        { method, path: requestUrl.split("?")[0] ?? "", aborted, responseBytes },
        context,
      ),
    });
  });
}

// The cause is no longer discarded: it is routed — REDACTED — to the operator diagnostic sink,
// keyed by the correlation id, and the id is folded into the opaque 500 body so a user-reported
// failure can be tied back to exactly one server-side record (GEN-OBS-DIAGNOSTICS-901). Split out
// of `createUiServer`'s callback so that closure stays under the line-count ceiling.
function reportTopLevelFailure(
  req: IncomingMessage,
  res: ServerResponse,
  correlationId: string,
  handlerDeps: UiHandlerDeps,
  context: RequestLogContext,
  error: unknown,
): void {
  emitServerDiagnostic(
    handlerDeps.diagnostics,
    serverDiagnosticFromError({
      correlationId,
      operation: "server.request",
      source: "server.top-level-catch",
      error,
      redact: (message) => String(handlerDeps.redactor(message)),
    }),
  );
  if (!res.headersSent) {
    writeJson(req, res, 500, errorBody("INTERNAL", "An unexpected error occurred.", correlationId));
  } else {
    res.end();
  }
}

export function createUiServer(deps: UiServerDeps): Server {
  const handlerDeps = deps.handlerDeps ?? fallbackDeps();
  const { voiceControl, liveDictation } = createVoicePlanes(
    deps.port,
    handlerDeps,
    deps.liveDictationInitialFrameTimeoutMs,
  );
  const activityLog: ServerLogSink = deps.activityLog ?? nullServerLogSink();
  const server = createServer((req, res) => {
    const correlationId = resolveCorrelationId(req);
    res.setHeader(CORRELATION_RESPONSE_HEADER, correlationId);
    const requestLogContext: RequestLogContext = {};
    logRequestOnClose(req, res, correlationId, activityLog, requestLogContext);
    void handle(deps, handlerDeps, req, res, correlationId, requestLogContext).catch(
      (error: unknown) => {
        reportTopLevelFailure(req, res, correlationId, handlerDeps, requestLogContext, error);
      },
    );
  });
  server.on("upgrade", (req, socket, head) => {
    if (voiceControl.handleUpgrade(req, socket, head)) {
      return;
    }
    if (liveDictation.handleUpgrade(req, socket, head)) {
      return;
    }
    // Default: every non-voice-control or ungated upgrade is hard-rejected, as before.
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
  });
  server.on("close", () => {
    voiceControl.closeAll();
    liveDictation.closeAll();
  });
  return server;
}
