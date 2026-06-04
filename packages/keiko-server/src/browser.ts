// ADR-0017 D8 — eight /api/browser/* BFF route handlers. CSRF guarding is enforced by the
// server.ts state-changing-request gate (POST/DELETE all flow through it). GET status + GET
// events are exempt by the same gate. SSE framing reuses the existing sse.ts helpers.

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  BrowserToolError,
  type BrowserEventEnvelope,
  type BrowserSessionManager,
} from "@oscharko-dev/keiko-tools";
import type { UiHandlerDeps } from "./deps.js";
import { SSE_HEADERS, readyMessage } from "./sse.js";
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
    const status = await guard.checkStatus(port);
    return { status: 200, body: status };
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
  openBrowserSseStream(ctx.res, guard, sessionId, deps.redactor);
  ctx.req.on("close", () => {
    ctx.res.end();
  });
  return STREAMING;
}

function openBrowserSseStream(
  res: ServerResponse,
  manager: BrowserSessionManager,
  sessionId: string,
  redactor: UiHandlerDeps["redactor"],
): void {
  res.writeHead(200, SSE_HEADERS);
  let seq = 0;
  const unsubscribe = manager.subscribe(sessionId, (event) => {
    seq += 1;
    writeBrowserEvent(res, event, seq, redactor);
    if (event.kind === "session-closed") {
      unsubscribe();
      res.end();
    }
  });
  res.write(readyMessage());
  res.on("close", () => {
    unsubscribe();
  });
}

function writeBrowserEvent(
  res: ServerResponse,
  event: BrowserEventEnvelope,
  seq: number,
  redactor: UiHandlerDeps["redactor"],
): void {
  const redacted = redactor(event);
  const data = JSON.stringify(redacted);
  const frame = `id: ${String(seq)}\nevent: browser:${event.kind}\ndata: ${data}\n\n`;
  if (!res.write(frame)) {
    res.destroy();
  }
}
