// The local UI BFF binds 127.0.0.1 only, applies security headers and CSP to every response,
// rejects non-loopback Host/Origin headers, dispatches API routes through injected handlers,
// and serves the static export from a contained root.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join } from "node:path";
import { Readable } from "node:stream";
import { createGzip } from "node:zlib";
import { applySecurityHeaders } from "./headers.js";
import { isAllowedHost } from "./host-check.js";
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
import { CORRELATION_RESPONSE_HEADER, resolveCorrelationId } from "./correlation.js";
import { emitServerDiagnostic, serverDiagnosticFromError } from "./diagnostics-log.js";
import { isVoiceDictationCapable, isVoiceRealtimeCapable } from "./read-handlers.js";
import { createVoiceControlPlane } from "./voice-realtime.js";
import { createRunRegistry } from "./runs.js";
import { createInMemoryUiStore } from "./store/index.js";

export const DEFAULT_UI_PORT = 1983;
export const UI_HOST = "127.0.0.1";
const CSP_CACHE_TTL_MS = 1000;
const JSON_GZIP_MIN_BYTES = 1024;
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
  headers: Readonly<Record<string, string>> = {},
): void {
  res.statusCode = status;
  for (const [key, value] of Object.entries(headers)) {
    res.setHeader(key, value);
  }
  if (status === 304) {
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

// Returns true when the request was rejected (caller should return immediately).
function rejectIfInvalidStateChange(req: IncomingMessage, res: ServerResponse): boolean {
  if (!isJsonRequest(req)) {
    rejectUnsupportedMediaType(req, res);
    return true;
  }
  if (!hasCsrfHeader(req)) {
    rejectCsrf(req, res);
    return true;
  }
  return false;
}

async function dispatchApi(
  handlerDeps: UiHandlerDeps,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  url: URL,
  correlationId: string,
): Promise<void> {
  const match = matchRoute(method, url.pathname);
  if (match === undefined) {
    writeJson(req, res, 404, notFoundBody());
    return;
  }
  if (match === "method-not-allowed") {
    writeJson(req, res, 405, methodNotAllowedBody());
    return;
  }
  if (isStateChangingMethod(method) && rejectIfInvalidStateChange(req, res)) {
    return;
  }
  const ctx: RouteContext = { req, res, params: match.params, url, correlationId };
  const outcome = await match.definition.handler(ctx, handlerDeps);
  if (outcome === STREAMING) {
    return;
  }
  writeJson(req, res, outcome.status, outcome.body, outcome.headers);
}

async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  staticRoot: string,
  pathname: string,
): Promise<void> {
  const targets =
    pathname === "/"
      ? ["/index.html"]
      : extname(pathname) === ""
        ? [pathname, `${pathname}.html`, `${pathname}/index.html`]
        : [pathname];
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

async function handle(
  deps: UiServerDeps,
  handlerDeps: UiHandlerDeps,
  req: IncomingMessage,
  res: ServerResponse,
  correlationId: string,
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
  const method = (req.method ?? "GET").toUpperCase();
  if (apiPath) {
    await dispatchApi(handlerDeps, req, res, method, url, correlationId);
    return;
  }
  await serveStatic(req, res, deps.staticRoot, url.pathname);
}

// Creates the BFF server. The caller binds it with `server.listen(deps.port, UI_HOST)` so it never
// listens on a non-loopback interface. The previous PTY WebSocket upgrade handler is removed — the
// terminal tool is now bounded-exec over plain HTTP (ADR-0018 D1/D8). Issue #497 (ADR-0100 D3,
// ADR-0101) re-opens the upgrade for the single loopback voice control path `/api/voice/control`, and
// ONLY when the deployment is full-realtime voice capable; every other upgrade keeps the hard reject.
export function createUiServer(deps: UiServerDeps): Server {
  const handlerDeps = deps.handlerDeps ?? fallbackDeps();
  const voiceControl = createVoiceControlPlane({
    port: deps.port,
    handlerDeps: () => handlerDeps,
  });
  const server = createServer((req, res) => {
    // RB-6: mint (or reuse a well-formed UI-supplied) correlation id at request entry and echo it on
    // every response BEFORE handling, so even a streamed/committed response and a top-level failure
    // carry the same traceable id. `setHeader` survives the later SSE `writeHead(200, SSE_HEADERS)`
    // (Node merges previously-set headers), so streamed chat responses are covered too.
    const correlationId = resolveCorrelationId(req);
    res.setHeader(CORRELATION_RESPONSE_HEADER, correlationId);
    void handle(deps, handlerDeps, req, res, correlationId).catch((error: unknown) => {
      // The cause is no longer discarded: it is routed — REDACTED — to the operator diagnostic sink,
      // keyed by the correlation id, and the id is folded into the opaque 500 body so a user-reported
      // failure can be tied back to exactly one server-side record (GEN-OBS-DIAGNOSTICS-901).
      emitServerDiagnostic(
        handlerDeps.diagnostics,
        serverDiagnosticFromError({
          correlationId,
          operation: `${req.method ?? "GET"} ${req.url ?? "/"}`,
          source: "server.top-level-catch",
          error,
          redact: (message) => String(handlerDeps.redactor(message)),
        }),
      );
      if (!res.headersSent) {
        writeJson(
          req,
          res,
          500,
          errorBody("INTERNAL", "An unexpected error occurred.", correlationId),
        );
      } else {
        res.end();
      }
    });
  });
  server.on("upgrade", (req, socket, head) => {
    if (voiceControl.handleUpgrade(req, socket, head)) {
      return;
    }
    // Default: every non-voice-control or ungated upgrade is hard-rejected, as before.
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
  });
  server.on("close", () => {
    voiceControl.closeAll();
  });
  return server;
}
