// Public, content-free lifecycle boundary for the singleton Coding Workbench runtime (#2256).
// POST CSRF and JSON content-type enforcement is centralized in server.ts.

import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  CodingWorkbenchRuntimeFailureCode,
  CodingWorkbenchRuntimeSseEvent,
} from "@oscharko-dev/keiko-contracts";
import type { UiHandlerDeps } from "../deps.js";
import {
  errorBody,
  STREAMING,
  type HandlerOutcome,
  type RouteContext,
  type RouteDefinition,
  type RouteResult,
} from "../routes.js";
import { SSE_HEADERS } from "../sse.js";
import type { CodingRuntimeEventHub } from "./codingRuntimeEventHub.js";
import type { CodingRuntimeOrchestrator } from "./codingRuntimeOrchestrator.js";

const MAX_BODY_BYTES = 64 * 1024;

class BodyTooLargeError extends Error {}

interface RuntimeDeps {
  readonly orchestrator: CodingRuntimeOrchestrator;
  readonly eventHub: CodingRuntimeEventHub;
}

function unavailable(): RouteResult {
  return {
    status: 503,
    body: errorBody(
      "CODING_RUNTIME_UNAVAILABLE",
      "Coding runtime is not configured for this server.",
    ),
  };
}

function requireRuntime(deps: UiHandlerDeps): RuntimeDeps | RouteResult {
  if (!deps.codingRuntimeOrchestrator || !deps.codingRuntimeEventHub) return unavailable();
  return { orchestrator: deps.codingRuntimeOrchestrator, eventHub: deps.codingRuntimeEventHub };
}

function isRouteResult(value: RuntimeDeps | RouteResult): value is RouteResult {
  return "status" in value;
}

function failureResult(failureCode: CodingWorkbenchRuntimeFailureCode): RouteResult {
  const status =
    failureCode === "active-run-conflict" || failureCode === "recovery-required"
      ? 409
      : failureCode === "authority-resolution-failed"
        ? 403
        : 400;
  return {
    status,
    body: errorBody(
      `CODING_RUNTIME_${failureCode.replaceAll("-", "_").toUpperCase()}`,
      "Runtime request was rejected.",
    ),
  };
}

function notFound(): RouteResult {
  return {
    status: 404,
    body: errorBody("CODING_RUNTIME_RUN_NOT_FOUND", "Runtime run was not found."),
  };
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let capped = false;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
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
      if (capped) return;
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.length === 0) {
        resolve({});
        return;
      }
      try {
        const parsed: unknown = JSON.parse(raw);
        resolve(
          parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed
            : undefined,
        );
      } catch {
        resolve(undefined);
      }
    });
    req.on("error", reject);
  });
}

async function withBody(work: () => Promise<RouteResult>): Promise<RouteResult> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof BodyTooLargeError)
      return {
        status: 413,
        body: errorBody("PAYLOAD_TOO_LARGE", "Request body exceeds the size limit."),
      };
    return {
      status: 400,
      body: errorBody("CODING_RUNTIME_INVALID_INTENT", "Runtime request was rejected."),
    };
  }
}

async function mutation(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  runId: string | undefined,
  operation: (
    runtime: CodingRuntimeOrchestrator,
    body: unknown,
  ) => ReturnType<CodingRuntimeOrchestrator["start"]>,
): Promise<RouteResult> {
  const required = requireRuntime(deps);
  if (isRouteResult(required)) return required;
  if (runId !== undefined && !required.orchestrator.getSnapshot(runId)) return notFound();
  return withBody(async () => {
    const body = await readBody(ctx.req);
    if (body === undefined) return failureResult("invalid-intent");
    const result = await operation(required.orchestrator, body);
    return result.ok ? { status: 200, body: result.snapshot } : failureResult(result.failureCode);
  });
}

export function handleCreateCodingRuntimeRun(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  return mutation(ctx, deps, undefined, (runtime, body) => runtime.start(body));
}

export function handleCodingRuntimeStatus(_ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  const required = requireRuntime(deps);
  return isRouteResult(required) ? required : { status: 200, body: required.orchestrator.status() };
}

export function handleGetCodingRuntimeRun(ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  const required = requireRuntime(deps);
  if (isRouteResult(required)) return required;
  const snapshot = required.orchestrator.getSnapshot(ctx.params.runId ?? "");
  return snapshot ? { status: 200, body: snapshot } : notFound();
}

export function handleCodingRuntimeApproval(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const runId = ctx.params.runId;
  return runId === undefined
    ? Promise.resolve(notFound())
    : mutation(ctx, deps, runId, (runtime, body) => runtime.decideApproval(runId, body));
}
export function handleCodingRuntimeStop(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const runId = ctx.params.runId;
  return runId === undefined
    ? Promise.resolve(notFound())
    : mutation(ctx, deps, runId, (runtime, body) => runtime.stop(runId, body));
}
export function handleCodingRuntimeTakeover(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const runId = ctx.params.runId;
  return runId === undefined
    ? Promise.resolve(notFound())
    : mutation(ctx, deps, runId, (runtime, body) => runtime.takeover(runId, body));
}
export function handleCodingRuntimeRetry(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const runId = ctx.params.runId;
  return runId === undefined
    ? Promise.resolve(notFound())
    : mutation(ctx, deps, runId, (runtime, body) => runtime.retry(runId, body));
}
export function handleCodingRuntimeRecoveryAcknowledgement(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const runId = ctx.params.runId;
  return runId === undefined
    ? Promise.resolve(notFound())
    : mutation(ctx, deps, runId, (runtime, body) => runtime.acknowledgeRecovery(runId, body));
}

function frame(event: CodingWorkbenchRuntimeSseEvent): string {
  return `id: ${event.cursor}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`;
}

function resetFrame(reason: string): string {
  return `event: reset\ndata: ${JSON.stringify({ reason, snapshotNeeded: true })}\n\n`;
}

export function handleCodingRuntimeEvents(ctx: RouteContext, deps: UiHandlerDeps): HandlerOutcome {
  const required = requireRuntime(deps);
  if (isRouteResult(required)) return required;
  const runId = ctx.params.runId ?? "";
  if (!required.orchestrator.getSnapshot(runId)) return notFound();
  const lastEventId = ctx.req.headers["last-event-id"];
  const cursor = typeof lastEventId === "string" ? lastEventId : undefined;
  openCodingRuntimeSse(ctx.res, ctx.req, required.eventHub, runId, cursor);
  return STREAMING;
}

export function openCodingRuntimeSse(
  res: ServerResponse,
  req: IncomingMessage,
  eventHub: CodingRuntimeEventHub,
  runId: string,
  lastEventId: string | undefined,
): void {
  res.writeHead(200, SSE_HEADERS);
  let detach = (): void => undefined;
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    detach();
    if (!res.writableEnded && !res.destroyed) res.end();
  };
  const subscribed = eventHub.subscribe(runId, lastEventId, {
    write: (event) => {
      const accepted = res.write(frame(event));
      if (!accepted) res.destroy();
      return accepted;
    },
    close,
  });
  if (!subscribed.ok) {
    res.write(resetFrame(subscribed.reason));
    res.end();
    return;
  }
  detach = subscribed.detach;
  res.once("close", close);
  req.once("aborted", close);
}

export const CODING_RUNTIME_ROUTE_GROUP: readonly RouteDefinition[] = [
  {
    method: "POST",
    pattern: "/api/coding-workbench/runtime/runs",
    handler: handleCreateCodingRuntimeRun,
  },
  {
    method: "GET",
    pattern: "/api/coding-workbench/runtime/status",
    handler: handleCodingRuntimeStatus,
  },
  {
    method: "GET",
    pattern: "/api/coding-workbench/runtime/runs/:runId/events",
    handler: handleCodingRuntimeEvents,
  },
  {
    method: "POST",
    pattern: "/api/coding-workbench/runtime/runs/:runId/approvals",
    handler: handleCodingRuntimeApproval,
  },
  {
    method: "POST",
    pattern: "/api/coding-workbench/runtime/runs/:runId/stop",
    handler: handleCodingRuntimeStop,
  },
  {
    method: "POST",
    pattern: "/api/coding-workbench/runtime/runs/:runId/takeover",
    handler: handleCodingRuntimeTakeover,
  },
  {
    method: "POST",
    pattern: "/api/coding-workbench/runtime/runs/:runId/retry",
    handler: handleCodingRuntimeRetry,
  },
  {
    method: "POST",
    pattern: "/api/coding-workbench/runtime/runs/:runId/recovery-ack",
    handler: handleCodingRuntimeRecoveryAcknowledgement,
  },
  {
    method: "GET",
    pattern: "/api/coding-workbench/runtime/runs/:runId",
    handler: handleGetCodingRuntimeRun,
  },
];
