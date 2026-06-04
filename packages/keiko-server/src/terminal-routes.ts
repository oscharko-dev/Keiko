// ADR-0018 D8 — five /api/terminal/* BFF route handlers. CSRF is enforced by the server's
// state-changing-request gate (POST/DELETE flow through it); GET routes are read-only and exempt.
// SSE framing mirrors /api/browser/*/events.

import type { ServerResponse } from "node:http";
import type { IncomingMessage } from "node:http";
import { TerminalToolError, type TerminalErrorCode } from "./terminal-errors.js";
import {
  buildTerminalPolicySummary,
  listDirectories,
  type TerminalEventEnvelope,
  type TerminalExecutionInput,
  type TerminalExecutionManager,
} from "./terminal.js";
import type { UiHandlerDeps } from "./deps.js";
import { SSE_HEADERS, readyMessage } from "./sse.js";
import {
  errorBody,
  STREAMING,
  type HandlerOutcome,
  type RouteContext,
  type RouteResult,
} from "./routes.js";

const MAX_TERMINAL_BODY_BYTES = 64_000;

class BodyTooLargeError extends Error {
  public constructor() {
    super("terminal request body too large");
    this.name = "BodyTooLargeError";
  }
}

function noTerminalDeps(): RouteResult {
  return {
    status: 503,
    body: errorBody("TERMINAL_UNAVAILABLE", "Terminal tool is not configured for this BFF."),
  };
}

type RouteOrManager = RouteResult | TerminalExecutionManager;

function requireTerminal(deps: UiHandlerDeps): RouteOrManager {
  return deps.terminal ?? noTerminalDeps();
}

function isRouteResult(value: RouteOrManager): value is RouteResult {
  return typeof (value as { status?: unknown }).status === "number";
}

function toRouteResult(error: TerminalToolError): RouteResult {
  return { status: error.status, body: errorBody(error.code, error.message) };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let capped = false;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_TERMINAL_BODY_BYTES) {
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
    throw new TerminalToolError("BAD_REQUEST", "Request body is not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TerminalToolError("BAD_REQUEST", "Request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new TerminalToolError("BAD_REQUEST", `Field "${key}" must be a non-empty string.`);
  }
  return value;
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new TerminalToolError("BAD_REQUEST", `Field "${key}" must be a string.`);
  }
  return value;
}

function optionalNumber(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TerminalToolError("BAD_REQUEST", `Field "${key}" must be a finite number.`);
  }
  return value;
}

function requireStringArray(body: Record<string, unknown>, key: string): readonly string[] {
  const value = body[key];
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new TerminalToolError("BAD_REQUEST", `Field "${key}" must be an array of strings.`);
  }
  for (const item of value) {
    if (typeof item !== "string") {
      throw new TerminalToolError("BAD_REQUEST", `Field "${key}" must be an array of strings.`);
    }
  }
  return value as readonly string[];
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
    if (error instanceof TerminalToolError) return toRouteResult(error);
    throw error;
  }
}

// GET /api/terminal/policy — static allowlist + limits. No deps required; safe even if the
// execution manager has not been wired (a deployment-misconfiguration case).
export function handleTerminalPolicy(_ctx: RouteContext, _deps: UiHandlerDeps): RouteResult {
  return { status: 200, body: buildTerminalPolicySummary() };
}

export async function handleTerminalDirectories(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  return runHandler(async () => {
    const projectId = ctx.url.searchParams.get("projectId");
    if (projectId === null || projectId.length === 0) {
      throw new TerminalToolError("BAD_REQUEST", "Query parameter 'projectId' is required.");
    }
    const requestedPath = ctx.url.searchParams.get("path") ?? undefined;
    const listing = await listDirectories(deps.store, projectId, requestedPath);
    return { status: 200, body: listing };
  });
}

export async function handleCreateTerminalExecution(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const guard = requireTerminal(deps);
  if (isRouteResult(guard)) return guard;
  return runHandler(async () => {
    const body = await readJsonObject(ctx.req);
    const projectId = requireString(body, "projectId");
    const command = requireString(body, "command");
    const args = requireStringArray(body, "args");
    const cwd = optionalString(body, "cwd");
    const timeoutMs = optionalNumber(body, "timeoutMs");
    const requestId = optionalString(body, "requestId");
    const input: TerminalExecutionInput = {
      projectId,
      command,
      args,
      ...(cwd === undefined ? {} : { cwd }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(requestId === undefined ? {} : { requestId }),
    };
    const raw = await guard.execute(input);
    // A4 (M3) — Layer-2 redaction on the synchronous POST response body. runCommand already
    // applied Layer-1 env-value redaction; this pass catches structural patterns (Bearer tokens,
    // sk-* keys, PEM markers) via the audit redactor before the output reaches the browser.
    const redactStr = (s: string): string => {
      const v = deps.redactor(s);
      return typeof v === "string" ? v : s;
    };
    const result = { ...raw, stdout: redactStr(raw.stdout), stderr: redactStr(raw.stderr) };
    return { status: 200, body: result };
  });
}

export function handleDeleteTerminalExecution(ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  const guard = requireTerminal(deps);
  if (isRouteResult(guard)) return guard;
  const executionId = ctx.params.executionId ?? "";
  const cancelled = guard.abort(executionId);
  if (!cancelled) {
    return {
      status: 404,
      body: errorBody("EXECUTION_NOT_FOUND", "Terminal execution not found."),
    };
  }
  return { status: 200, body: { ok: true } };
}

// SSE — one terminal event becomes one message with `event: terminal:<kind>` and a JSON payload.
// A synthetic `ready` is emitted first so the client can transition from connecting to live.
export function handleTerminalEvents(ctx: RouteContext, deps: UiHandlerDeps): HandlerOutcome {
  const guard = requireTerminal(deps);
  if (isRouteResult(guard)) return guard;
  openTerminalSseStream(ctx.res, guard, deps.redactor);
  ctx.req.on("close", () => {
    ctx.res.end();
  });
  return STREAMING;
}

function openTerminalSseStream(
  res: ServerResponse,
  manager: TerminalExecutionManager,
  redactor: UiHandlerDeps["redactor"],
): void {
  res.writeHead(200, SSE_HEADERS);
  let seq = 0;
  const unsubscribe = manager.subscribe((event) => {
    seq += 1;
    writeTerminalEvent(res, event, seq, redactor);
  });
  res.write(readyMessage());
  res.on("close", () => {
    unsubscribe();
  });
}

function writeTerminalEvent(
  res: ServerResponse,
  event: TerminalEventEnvelope,
  seq: number,
  redactor: UiHandlerDeps["redactor"],
): void {
  const redacted = redactor(event);
  const data = JSON.stringify(redacted);
  const frame = `id: ${String(seq)}\nevent: terminal:${event.kind}\ndata: ${data}\n\n`;
  if (!res.write(frame)) {
    res.destroy();
  }
}

// Re-export for the unused-import lint: callers can map a terminal error code → HTTP status if
// they need to without importing TerminalToolError.
export type { TerminalErrorCode };
