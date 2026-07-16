// Public, content-free lifecycle boundary for the singleton Coding Workbench runtime (#2256).
// POST CSRF and JSON content-type enforcement is centralized in server.ts.

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION,
  parseCodingWorkbenchRuntimeReadinessRequest,
  resolveEffectiveCodingWorkbenchMode,
  type CodingWorkbenchRuntimeFailureCode,
  type CodingWorkbenchRuntimeSseEvent,
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

function failureStatus(failureCode: CodingWorkbenchRuntimeFailureCode): number {
  if (failureCode === "active-run-conflict" || failureCode === "recovery-required") return 409;
  if (failureCode === "authority-resolution-failed") return 403;
  return 400;
}

function failureResult(failureCode: CodingWorkbenchRuntimeFailureCode): RouteResult {
  const status = failureStatus(failureCode);
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

export function handleCodingRuntimeReadiness(ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  const values = ctx.url.searchParams.getAll("requestedMode");
  const parsed = parseCodingWorkbenchRuntimeReadinessRequest({ requestedMode: values[0] });
  if (
    values.length !== 1 ||
    [...ctx.url.searchParams.keys()].some((key) => key !== "requestedMode")
  ) {
    return failureResult("invalid-intent");
  }
  if (!parsed.ok) return failureResult("invalid-intent");
  const deploymentCeiling = deps.autonomousDeliveryDeploymentCeiling ?? "governed-assist";
  return {
    status: 200,
    body: {
      schemaVersion: CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION,
      requestedMode: parsed.value.requestedMode,
      deploymentCeiling,
      effectiveMode: resolveEffectiveCodingWorkbenchMode(
        parsed.value.requestedMode,
        deploymentCeiling,
      ),
      runtimeAvailable: deps.codingRuntimeHostQualified === true,
    },
  };
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

export function handleCodingRuntimePause(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const runId = ctx.params.runId;
  return runId === undefined
    ? Promise.resolve(notFound())
    : mutation(ctx, deps, runId, (runtime, body) => runtime.pause(runId, body));
}

export function handleCodingRuntimeResume(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const runId = ctx.params.runId;
  return runId === undefined
    ? Promise.resolve(notFound())
    : mutation(ctx, deps, runId, (runtime, body) => runtime.resume(runId, body));
}

// Inline follow-up: a drafted message may only be admitted while the run is paused (or already
// halted for a question); the orchestrator's operation coordinator enforces the revision and
// serial admission, so no hidden prompt queue is possible.
export function handleCodingRuntimeFollowUp(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const runId = ctx.params.runId;
  return runId === undefined
    ? Promise.resolve(notFound())
    : mutation(ctx, deps, runId, (runtime, body) => runtime.submitFollowUp(runId, body));
}

// Required-question surface. Question text is browser-rendered untrusted content: it never enters
// snapshots, diagnostics, evidence, or persistence. The answer/reject operations bind to the
// server-owned revision through the same serialized coordinator as every other mutation.
export function handleCodingRuntimeQuestionAnswer(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const runId = ctx.params.runId;
  return runId === undefined
    ? Promise.resolve(notFound())
    : mutation(ctx, deps, runId, (runtime, body) => runtime.answerQuestion(runId, body));
}

export function handleCodingRuntimeQuestionReject(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const runId = ctx.params.runId;
  return runId === undefined
    ? Promise.resolve(notFound())
    : mutation(ctx, deps, runId, (runtime, body) => runtime.rejectQuestion(runId, body));
}

export function handleCodingRuntimeQuestionList(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const runId = ctx.params.runId;
  if (runId === undefined) return Promise.resolve(notFound());
  const required = requireRuntime(deps);
  if (isRouteResult(required)) return Promise.resolve(required);
  if (!required.orchestrator.getSnapshot(runId)) return Promise.resolve(notFound());
  return withBody(async () => {
    const body = await readBody(ctx.req);
    if (body === undefined) return failureResult("invalid-intent");
    const result = await required.orchestrator.listQuestions(runId, body);
    return result.ok ? { status: 200, body: result.questions } : failureResult(result.failureCode);
  });
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
    pattern: "/api/coding-workbench/runtime/readiness",
    handler: handleCodingRuntimeReadiness,
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
    method: "POST",
    pattern: "/api/coding-workbench/runtime/runs/:runId/pause",
    handler: handleCodingRuntimePause,
  },
  {
    method: "POST",
    pattern: "/api/coding-workbench/runtime/runs/:runId/resume",
    handler: handleCodingRuntimeResume,
  },
  {
    method: "POST",
    pattern: "/api/coding-workbench/runtime/runs/:runId/follow-up",
    handler: handleCodingRuntimeFollowUp,
  },
  {
    method: "POST",
    pattern: "/api/coding-workbench/runtime/runs/:runId/questions",
    handler: handleCodingRuntimeQuestionList,
  },
  {
    method: "POST",
    pattern: "/api/coding-workbench/runtime/runs/:runId/questions/answer",
    handler: handleCodingRuntimeQuestionAnswer,
  },
  {
    method: "POST",
    pattern: "/api/coding-workbench/runtime/runs/:runId/questions/reject",
    handler: handleCodingRuntimeQuestionReject,
  },
  {
    method: "GET",
    pattern: "/api/coding-workbench/runtime/runs/:runId",
    handler: handleGetCodingRuntimeRun,
  },
];
