// Issue #2211 — four /api/editor/verification/* BFF route handlers for the editor verification runner.
// CSRF is enforced by the server's state-changing-request gate (POST/DELETE flow through it); GET
// routes are read-only and exempt. SSE framing mirrors /api/commands/*/events exactly, reusing the
// SAME shared primitives (SSE_HEADERS, readyMessage, startSseHeartbeat, writeOrDestroy,
// redactedEventJson) — no new SSE framing is introduced.
//
//   GET    /api/editor/verification/catalog?projectId=…   detected kind catalog + trust state
//   POST   /api/editor/verification/runs                  start a run → EditorVerificationRun (tracked)
//   DELETE /api/editor/verification/runs/:runId           cancel an in-flight run
//   GET    /api/editor/verification/events                SSE stream of content-free lifecycle events

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  parseEditorVerificationRunRequest,
  type EditorVerificationEvent,
} from "@oscharko-dev/keiko-contracts";
import { redactedEventJson } from "../sse-frame-cache.js";
import { SSE_HEADERS, readyMessage, startSseHeartbeat } from "../sse.js";
import { writeOrDestroy, type SseBackpressureSignal } from "../sse-write.js";
import { VerificationRunnerError } from "./verificationRunnerErrors.js";
import type { VerificationRunInput, VerificationRunnerManager } from "./verificationRunner.js";
import {
  errorBody,
  STREAMING,
  type HandlerOutcome,
  type RouteContext,
  type RouteResult,
} from "../routes.js";
import type { UiHandlerDeps } from "../deps.js";

const MAX_VERIFICATION_BODY_BYTES = 16_000;

class BodyTooLargeError extends Error {
  public constructor() {
    super("verification runner request body too large");
    this.name = "BodyTooLargeError";
  }
}

function noRunnerDeps(): RouteResult {
  return {
    status: 503,
    body: errorBody(
      "VERIFICATION_RUNNER_UNAVAILABLE",
      "Editor verification runner is not configured for this BFF.",
    ),
  };
}

type RouteOrManager = RouteResult | VerificationRunnerManager;

function requireRunner(deps: UiHandlerDeps): RouteOrManager {
  return deps.verificationRunner ?? noRunnerDeps();
}

function isRouteResult(value: RouteOrManager): value is RouteResult {
  return typeof (value as { status?: unknown }).status === "number";
}

function toRouteResult(error: VerificationRunnerError): RouteResult {
  return { status: error.status, body: errorBody(error.code, error.message) };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let capped = false;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_VERIFICATION_BODY_BYTES) {
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
    throw new VerificationRunnerError("BAD_REQUEST", "Request body is not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new VerificationRunnerError("BAD_REQUEST", "Request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
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
    if (error instanceof VerificationRunnerError) return toRouteResult(error);
    throw error;
  }
}

// GET /api/editor/verification/catalog — the detected kind catalog + server-owned trust state for a
// project, re-detected fresh on every call (never trusts a client-cached catalog).
export async function handleVerificationCatalog(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const guard = requireRunner(deps);
  if (isRouteResult(guard)) return guard;
  return runHandler(() => {
    const projectId = ctx.url.searchParams.get("projectId");
    if (projectId === null || projectId.length === 0) {
      throw new VerificationRunnerError("BAD_REQUEST", "Query parameter 'projectId' is required.");
    }
    return { status: 200, body: guard.discover(projectId) };
  });
}

// POST /api/editor/verification/runs — start a registry-tracked run. Returns the EditorVerificationRun
// immediately (runId + state); results stream over the events route. This is a start-and-track call.
export async function handleCreateVerificationRun(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const guard = requireRunner(deps);
  if (isRouteResult(guard)) return guard;
  return runHandler(async () => {
    const body = await readJsonObject(ctx.req);
    const projectId = body.projectId;
    if (typeof projectId !== "string" || projectId.length === 0) {
      throw new VerificationRunnerError("BAD_REQUEST", "Field 'projectId' is required.");
    }
    const parsed = parseEditorVerificationRunRequest(body);
    if (!parsed.ok) {
      throw new VerificationRunnerError("BAD_REQUEST", parsed.errors.join("; "));
    }
    const input: VerificationRunInput = {
      projectId,
      kinds: parsed.value.kinds,
      ...(parsed.value.targetPath === undefined ? {} : { targetPath: parsed.value.targetPath }),
      ...(parsed.value.requestId === undefined ? {} : { requestId: parsed.value.requestId }),
    };
    return { status: 200, body: guard.execute(input).run };
  });
}

export function handleDeleteVerificationRun(ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  const guard = requireRunner(deps);
  if (isRouteResult(guard)) return guard;
  const runId = ctx.params.runId ?? "";
  if (!guard.abort(runId)) {
    return { status: 404, body: errorBody("RUN_NOT_FOUND", "Verification run not found.") };
  }
  return { status: 200, body: { ok: true } };
}

// SSE — one runner event becomes one message with `event: verification:<kind>` and a JSON payload. A
// synthetic `ready` is emitted first so the client can transition from connecting to live.
export function handleVerificationEvents(ctx: RouteContext, deps: UiHandlerDeps): HandlerOutcome {
  const guard = requireRunner(deps);
  if (isRouteResult(guard)) return guard;
  openVerificationSseStream(ctx.res, guard, deps.redactor);
  ctx.req.on("close", () => {
    ctx.res.end();
  });
  return STREAMING;
}

// Exported for unit-testing the backpressure path (mirrors openCommandSseStream). `onBackpressure` is
// optional and defaults to undefined in production; it fires exactly once when a frame is rejected
// because the client is not draining, before the socket is destroyed.
export function openVerificationSseStream(
  res: ServerResponse,
  manager: VerificationRunnerManager,
  redactor: UiHandlerDeps["redactor"],
  onBackpressure?: (signal: SseBackpressureSignal) => void,
): void {
  res.writeHead(200, SSE_HEADERS);
  startSseHeartbeat(res);
  const controller = new AbortController();
  let seq = 0;
  const unsubscribe = manager.subscribe((event) => {
    seq += 1;
    writeVerificationEvent(res, event, seq, redactor, controller, onBackpressure);
  });
  let unsubscribed = false;
  const stop = (): void => {
    if (unsubscribed) return;
    unsubscribed = true;
    unsubscribe();
  };
  controller.signal.addEventListener("abort", stop, { once: true });
  res.write(readyMessage());
  res.on("close", () => {
    stop();
  });
}

function writeVerificationEvent(
  res: ServerResponse,
  event: EditorVerificationEvent,
  seq: number,
  redactor: UiHandlerDeps["redactor"],
  controller: AbortController,
  onBackpressure?: (signal: SseBackpressureSignal) => void,
): void {
  // GEN-PERF-FANOUT-001 — redact+serialize once per event across all subscribers; only the
  // per-connection `id:` cursor differs between them.
  const data = redactedEventJson(redactor, event);
  const frame = `id: ${String(seq)}\nevent: verification:${event.kind}\ndata: ${data}\n\n`;
  writeOrDestroy(res, frame, controller, onBackpressure);
}
