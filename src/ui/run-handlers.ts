// The five run-engine BFF endpoints (ADR-0011 D5 routes 5–9). POST /api/runs starts a dry-run-first
// run in the background and returns 202 {runId, fingerprint}; the SSE route replays the bounded ring
// buffer (respecting Last-Event-ID) then streams live redacted events, closing after the terminal
// event; cancel propagates to the underlying harness/workflow AbortController; GET returns the
// redacted final report projection (or status:"running"); apply is the ONLY write path, re-invoking
// the same workflow with apply:true through the existing gated path. No model is ever called
// directly; no guard is reimplemented; no secret reaches any response (live payloads are redacted).

import type { IncomingMessage, ServerResponse } from "node:http";
import { parseRunRequest } from "./run-request.js";
import { startRun, applyRun, type EngineContext } from "./run-engine.js";
import { ActiveRunLimitError, type RunRecord } from "./runs.js";
import { SSE_HEADERS, writeEvent, readyMessage } from "./sse.js";
import type { SseWriter, StreamEvent } from "./sink.js";
import type { RouteContext, RouteResult, HandlerOutcome } from "./routes.js";
import { errorBody, STREAMING } from "./routes.js";
import type { UiHandlerDeps } from "./deps.js";

const MAX_BODY_BYTES = 1_000_000;

// Reads the request body up to a byte cap (a bounded read protects the loopback BFF from an
// oversized body). Resolves the decoded UTF-8 text, or rejects past the cap.
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

// Route 5 — POST /api/runs. Validates the body, resolves the ModelPort, starts the run, returns 202.
export async function handleCreateRun(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const raw = await readBody(ctx.req);
  const parsed = parseRunRequest(raw);
  if ("code" in parsed) {
    return { status: 400, body: errorBody(parsed.code, parsed.message) };
  }
  const model = deps.modelPortFactory(parsed.modelId);
  if (model === undefined) {
    return { status: 400, body: errorBody("NO_MODEL", "No model provider is configured.") };
  }
  const engineCtx: EngineContext = { request: parsed, model, registry: deps.registry };
  try {
    const started = startRun(engineCtx, deps.redactor);
    return { status: 202, body: { runId: started.runId, fingerprint: started.fingerprint } };
  } catch (error) {
    if (error instanceof ActiveRunLimitError) {
      return { status: 429, body: errorBody("TOO_MANY_RUNS", "The active run limit is reached.") };
    }
    throw error;
  }
}

function lastEventId(req: IncomingMessage): number {
  const header = req.headers["last-event-id"];
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined) {
    return -1;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : -1;
}

// Route 6 — GET /api/runs/:runId/events (SSE). Replays the ring buffer (after Last-Event-ID), sends
// `ready`, then streams live events, closing after the run terminates. The writer is detached on
// client disconnect to avoid leaks and unbounded fan-out.
export function handleRunEvents(ctx: RouteContext, deps: UiHandlerDeps): HandlerOutcome {
  const record = deps.registry.get(ctx.params.runId ?? "");
  if (record === undefined) {
    return { status: 404, body: errorBody("NOT_FOUND", "Unknown run.") };
  }
  openSseStream(ctx.res, record, lastEventId(ctx.req), deps.redactor);
  ctx.req.on("close", () => {
    ctx.res.end();
  });
  return STREAMING;
}

function openSseStream(
  res: ServerResponse,
  record: RunRecord,
  afterSeq: number,
  redactor: UiHandlerDeps["redactor"],
): void {
  res.writeHead(200, SSE_HEADERS);
  const writer: SseWriter = {
    write: (event: StreamEvent): void => {
      writeEvent(res, event, redactor);
    },
    close: (): void => {
      res.end();
    },
  };
  const detach = record.sink.attach(writer, afterSeq);
  res.write(readyMessage());
  res.on("close", detach);
  if (record.sink.isTerminated()) {
    detach();
    res.end();
  }
}

// Route 7 — POST /api/runs/:runId/cancel. Idempotent; 404 unknown.
export function handleCancelRun(ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  const record = deps.registry.get(ctx.params.runId ?? "");
  if (record === undefined) {
    return { status: 404, body: errorBody("NOT_FOUND", "Unknown run.") };
  }
  record.cancel("cancelled via UI");
  return { status: 200, body: { ok: true } };
}

// Route 8 — GET /api/runs/:runId. Final redacted report projection, or status:"running".
export function handleGetRun(ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  const record = deps.registry.get(ctx.params.runId ?? "");
  if (record === undefined) {
    return { status: 404, body: errorBody("NOT_FOUND", "Unknown run.") };
  }
  if (record.status === "running") {
    return { status: 200, body: { report: { status: "running" } } };
  }
  return { status: 200, body: { report: record.report } };
}

// Route 9 — POST /api/runs/:runId/apply. The ONLY write path. 404 unknown; 409 when not in an
// appliable (dry-run-success) state; otherwise re-invokes the gated workflow with apply:true.
export async function handleApplyRun(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const record = deps.registry.get(ctx.params.runId ?? "");
  if (record === undefined) {
    return { status: 404, body: errorBody("NOT_FOUND", "Unknown run.") };
  }
  if (record.appliable === undefined) {
    return {
      status: 409,
      body: errorBody("NOT_APPLIABLE", "The run is not in an appliable state."),
    };
  }
  const model = deps.modelPortFactory(record.fingerprint);
  if (model === undefined) {
    return { status: 400, body: errorBody("NO_MODEL", "No model provider is configured.") };
  }
  const report = await applyRun(record.appliable, model, modelIdFor(deps), deps.redactor);
  return { status: 200, body: { report } };
}

// The modelId used for an apply re-invocation: the first configured provider, mirroring the CLI
// default. Falls back to a placeholder when no config (the injected factory in tests ignores it).
function modelIdFor(deps: UiHandlerDeps): string {
  return deps.config?.providers[0]?.modelId ?? "default";
}
