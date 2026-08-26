// ADR-0017 D8 — eight /api/browser/* BFF route handlers. CSRF guarding is enforced by the
// server.ts state-changing-request gate (POST/DELETE all flow through it). GET status + GET
// events are exempt by the same gate. SSE framing reuses the existing sse.ts helpers.

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  sseBackpressureReporter,
  writeOrDestroy,
  type SseBackpressureSignal,
} from "./sse-write.js";
import {
  BrowserToolError,
  type BrowserEventEnvelope,
  type BrowserSessionManager,
} from "@oscharko-dev/keiko-tools";
import type { UiHandlerDeps } from "./deps.js";
import { redactedEventJson } from "./sse-frame-cache.js";
import { SSE_HEADERS, readyMessage, startSseHeartbeat } from "./sse.js";
import {
  errorBody,
  STREAMING,
  type HandlerOutcome,
  type RouteContext,
  type RouteResult,
} from "./routes.js";

const MAX_BROWSER_BODY_BYTES = 64_000;

class BodyTooLargeError extends Error {
  public constructor() {
    super("browser request body too large");
    this.name = "BodyTooLargeError";
  }
}

function noBrowserDeps(): RouteResult {
  return {
    status: 503,
    body: errorBody("BROWSER_UNAVAILABLE", "Browser tool is not configured for this BFF."),
  };
}

type RouteOrManager = RouteResult | BrowserSessionManager;

function requireBrowser(deps: UiHandlerDeps): RouteOrManager {
  return deps.browser ?? noBrowserDeps();
}

function isRouteResult(value: RouteOrManager): value is RouteResult {
  return typeof (value as { status?: unknown }).status === "number";
}

function toRouteResult(error: BrowserToolError): RouteResult {
  return { status: error.status, body: errorBody(error.code, error.message) };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let capped = false;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BROWSER_BODY_BYTES) {
        if (!capped) {
          capped = true;
          chunks.length = 0;
          reject(new BodyTooLargeError());
          req.resume();
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!capped) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

async function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  if (raw.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BrowserToolError("BAD_REQUEST", "Request body is not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new BrowserToolError("BAD_REQUEST", "Request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new BrowserToolError("BAD_REQUEST", `Field "${key}" must be a non-empty string.`);
  }
  return value;
}

function requireNumber(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new BrowserToolError("BAD_REQUEST", `Field "${key}" must be a finite number.`);
  }
  return value;
}

async function runHandler(work: () => Promise<RouteResult> | RouteResult): Promise<RouteResult> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return {
        status: 413,
        body: errorBody("PAYLOAD_TOO_LARGE", "Request body exceeds the size limit."),
      };
    }
    if (error instanceof BrowserToolError) return toRouteResult(error);
    throw error;
  }
}

const UNREACHABLE_BODY = {
  reachable: false,
  userAgent: null,
  browserVersion: null,
  webSocketDebuggerUrl: null,
} as const;

export async function handleBrowserStatus(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const guard = requireBrowser(deps);
  if (isRouteResult(guard)) return guard;
  return runHandler(async () => {
    const portParam = ctx.url.searchParams.get("port");
    if (portParam === null) {
      throw new BrowserToolError("BAD_REQUEST", "Query parameter 'port' is required.");
    }
    const port = Number.parseInt(portParam, 10);
    if (!Number.isFinite(port)) {
      throw new BrowserToolError("BAD_REQUEST", "Query parameter 'port' must be an integer.");
    }
    try {
      const status = await guard.checkStatus(port);
      return { status: 200, body: status };
    } catch (err) {
      if (err instanceof BrowserToolError && err.code === "CHROME_UNREACHABLE") {
        return { status: 200, body: UNREACHABLE_BODY };
      }
      throw err;
    }
  });
}

export async function handleCreateBrowserSession(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const guard = requireBrowser(deps);
  if (isRouteResult(guard)) return guard;
  return runHandler(async () => {
    const body = await readJsonObject(ctx.req);
    const port = requireNumber(body, "port");
    const meta = await guard.openSession(port);
    return { status: 201, body: meta };
  });
}

export async function handleDeleteBrowserSession(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const guard = requireBrowser(deps);
  if (isRouteResult(guard)) return guard;
  return runHandler(async () => {
    const sessionId = ctx.params.sessionId ?? "";
    await guard.closeSession(sessionId);
    return { status: 200, body: { ok: true } };
  });
}

export async function handleBrowserNavigate(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const guard = requireBrowser(deps);
  if (isRouteResult(guard)) return guard;
  return runHandler(async () => {
    const body = await readJsonObject(ctx.req);
    const url = requireString(body, "url");
    const sessionId = ctx.params.sessionId ?? "";
    const result = await guard.navigate(sessionId, url);
    return { status: 200, body: result };
  });
}

export async function handleBrowserScreenshot(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const guard = requireBrowser(deps);
  if (isRouteResult(guard)) return guard;
  return runHandler(async () => {
    // Drain the body through readJsonObject so the 64 KB cap (MAX_BROWSER_BODY_BYTES) is
    // enforced even though this handler expects no fields. Raw node:http has no global cap.
    await readJsonObject(ctx.req);
    const sessionId = ctx.params.sessionId ?? "";
    const result = await guard.screenshot(sessionId);
    return { status: 200, body: result };
  });
}

export async function handleBrowserApplyScreenshot(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const guard = requireBrowser(deps);
  if (isRouteResult(guard)) return guard;
  return runHandler(async () => {
    const body = await readJsonObject(ctx.req);
    const captureSeq = requireNumber(body, "captureSeq");
    const sessionId = ctx.params.sessionId ?? "";
    const result = await guard.applyScreenshot(sessionId, captureSeq);
    return { status: 200, body: result };
  });
}

export async function handleBrowserContent(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const guard = requireBrowser(deps);
  if (isRouteResult(guard)) return guard;
  return runHandler(async () => {
    // Drain the body through readJsonObject so the 64 KB cap (MAX_BROWSER_BODY_BYTES) is
    // enforced even though this handler expects no fields. Raw node:http has no global cap.
    await readJsonObject(ctx.req);
    const sessionId = ctx.params.sessionId ?? "";
    const result = await guard.content(sessionId);
    return { status: 200, body: result };
  });
}

// SSE — re-uses the existing framer shape. Each browser event becomes one SSE message with
// event: <kind> and data: <JSON>. A 'ready' synthetic is sent first so clients can transition
// from connecting to live.
export function handleBrowserEvents(ctx: RouteContext, deps: UiHandlerDeps): HandlerOutcome {
  const guard = requireBrowser(deps);
  if (isRouteResult(guard)) return guard;
  const sessionId = ctx.params.sessionId ?? "";
  if (sessionId.length === 0) {
    return { status: 400, body: errorBody("BAD_REQUEST", "sessionId is required.") };
  }
  if (!guard.hasSession(sessionId)) {
    return { status: 404, body: errorBody("SESSION_NOT_FOUND", "Browser session not found.") };
  }
  // Threads the request's own correlation id (ADR-0173 D5 / g12) so a later backpressure kill
  // joins back to the request that opened this stream instead of a disconnected mint.
  openBrowserSseStream(
    ctx.res,
    guard,
    sessionId,
    deps.redactor,
    sseBackpressureReporter(deps, "browser", ctx.correlationId),
    ctx.correlationId,
  );
  ctx.req.on("close", () => {
    ctx.res.end();
  });
  return STREAMING;
}

// Exported for unit testing the backpressure path. `onBackpressure` is optional and defaults to
// undefined in production (no behavior change); it is emitted exactly once when a frame is rejected
// because the client is not draining, before the socket is destroyed.
export function openBrowserSseStream(
  res: ServerResponse,
  manager: BrowserSessionManager,
  sessionId: string,
  redactor: UiHandlerDeps["redactor"],
  onBackpressure?: (signal: SseBackpressureSignal) => void,
  correlationId?: string,
): void {
  res.writeHead(200, SSE_HEADERS);
  // Per-connection abort: a slow-client backpressure kill (writeOrDestroy) aborts this controller,
  // which unsubscribes from the manager so no further frames are produced for a dead socket. The
  // res.on("close") listener also unsubscribes; `unsubscribed` guards against the double call.
  // subscribe() returns synchronously and events fire only asynchronously afterward, so no event
  // (hence no abort) can occur before `unsubscribe` is assigned.
  const controller = new AbortController();
  // correlationId (#2902 w5-sse-counters) is threaded to every write path below so whichever one
  // runs first attaches it: sse-write.ts's per-stream state is set-once-wins. The heartbeat's own
  // write is deferred to its interval timer, so the ready frame just below is the actual first
  // write in practice — it also carries correlationId for that reason.
  startSseHeartbeat(res, undefined, undefined, {
    controller,
    ...(onBackpressure === undefined ? {} : { onBackpressure }),
    ...(correlationId === undefined ? {} : { correlationId }),
  });
  let seq = 0;
  const unsubscribe = manager.subscribe(sessionId, (event) => {
    seq += 1;
    writeBrowserEvent(res, event, seq, redactor, controller, onBackpressure);
    if (event.kind === "session-closed") {
      stop();
      res.end();
    }
  });
  let unsubscribed = false;
  const stop = (): void => {
    if (unsubscribed) return;
    unsubscribed = true;
    unsubscribe();
  };
  controller.signal.addEventListener("abort", stop, { once: true });
  // The ready frame goes through the same protective path: a client that is already not draining
  // must abort and unsubscribe here too, rather than leaving the subscription live until some
  // later event happens to trip writeOrDestroy.
  writeOrDestroy(res, readyMessage(), controller, onBackpressure, correlationId);
  res.on("close", () => {
    stop();
  });
}

function writeBrowserEvent(
  res: ServerResponse,
  event: BrowserEventEnvelope,
  seq: number,
  redactor: UiHandlerDeps["redactor"],
  controller: AbortController,
  onBackpressure?: (signal: SseBackpressureSignal) => void,
): void {
  // KEIKO-0674: reuse the WeakMap-keyed redactedEventJson helper (GEN-PERF-FANOUT-001) so a fan-
  // out of the same browser event to K subscribers pays the redact+serialize cost once, not K
  // times. Every other SSE fan-out path (agent-run/container/command-runner/terminal) already
  // routes through this helper; this one was the last inline call to redactor()+JSON.stringify.
  const data = redactedEventJson(redactor, event);
  const frame = `id: ${String(seq)}\nevent: browser:${event.kind}\ndata: ${data}\n\n`;
  writeOrDestroy(res, frame, controller, onBackpressure);
}
