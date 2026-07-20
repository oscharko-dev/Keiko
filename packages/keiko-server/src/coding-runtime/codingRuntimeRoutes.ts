// Public, content-free lifecycle boundary for the singleton Coding Workbench runtime (#2256).
// POST CSRF and JSON content-type enforcement is centralized in server.ts.

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION,
  parseCodingWorkbenchRuntimeReadinessRequest,
  resolveEffectiveCodingWorkbenchMode,
  unpairedCodingWorkbenchRuntimeQuestionsChannelPayload,
  unpairedCodingWorkbenchRuntimeResearchChannelPayload,
  type CodingWorkbenchMode,
  type CodingWorkbenchRuntimeFailureCode,
  type CodingWorkbenchRuntimeQuestionsChannelPayload,
  type CodingWorkbenchRuntimeResearchChannelPayload,
  type CodingWorkbenchRuntimeSseEvent,
} from "@oscharko-dev/keiko-contracts";
import { resolveAppSessionReadAuthority } from "../coding-app-session/appSessionReadAuthority.js";
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
import { decideCodingRuntimeModeChange } from "./codingRuntimeModeChangeGate.js";
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
  // The readiness projection must report the same ceiling the coding-runtime mint clamp
  // enforces; the autonomous-delivery ceiling is a separate authority knob (#2475).
  const deploymentCeiling = deps.codingRuntimeDeploymentCeiling ?? "governed-assist";
  const runtimeAvailable = deps.codingRuntimeHostQualified === true;
  return {
    status: 200,
    body: {
      schemaVersion: CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION,
      requestedMode: parsed.value.requestedMode,
      deploymentCeiling,
      effectiveMode: confirmedEffectiveMode(deps, parsed.value.requestedMode, deploymentCeiling),
      runtimeAvailable,
      ...(runtimeAvailable
        ? {}
        : {
            runtimeUnavailableReason: deps.codingRuntimeUnavailableReason ?? "runtime-unqualified",
          }),
    },
  };
}

/**
 * The server-confirmed effective mode is anchored to the live run (#2386): a requested change is
 * confirmed only when the mode-change gate admits it — while the run is idle or paused, and
 * widening only from idle. A rejected request keeps confirming the run's own effective posture,
 * so the browser can never display a widened authority the server did not grant.
 */
function confirmedEffectiveMode(
  deps: UiHandlerDeps,
  requestedMode: CodingWorkbenchMode,
  deploymentCeiling: CodingWorkbenchMode,
): CodingWorkbenchMode {
  const current = deps.codingRuntimeOrchestrator?.status();
  if (current?.runId === undefined || current.requestedMode === undefined) {
    return resolveEffectiveCodingWorkbenchMode(requestedMode, deploymentCeiling);
  }
  const decision = decideCodingRuntimeModeChange({
    currentState: current.state,
    currentRequestedMode: current.requestedMode,
    requestedMode,
    deploymentCeiling,
  });
  return decision.ok
    ? decision.effectiveMode
    : resolveEffectiveCodingWorkbenchMode(current.requestedMode, deploymentCeiling);
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

// Revoking the #2387 internet research grant drops it for the parent run and every child in one
// revision bump; the response is the revision-bumped, grant-absent snapshot. A stale revision or a
// grant id the server does not hold fails closed as invalid intent.
export function handleCodingRuntimeResearchRevoke(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const runId = ctx.params.runId;
  return runId === undefined
    ? Promise.resolve(notFound())
    : mutation(ctx, deps, runId, (runtime, body) => runtime.revokeResearch(runId, body));
}

// Inline follow-up: a drafted message is admitted while the run is running or paused; the
// orchestrator's operation coordinator enforces the revision and one-use request-id serial
// admission, so exactly one turn is admitted per revision and no hidden prompt queue is possible.
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
//
// All three question routes are content-bearing and therefore enforce the app-session read
// authority (ADR-0141 D2, #2478) BEFORE any runId or runtime resolution: an unpaired list read
// receives the one constant content-free projection, and an unpaired answer/reject receives the
// same existence-concealing not-found result an unknown run yields — never a distinct auth error,
// so no probe can tell "not paired" from "does not exist" (ADR-0141 D6). Loopback, Origin, CSRF,
// and runId knowledge remain routing facts and never grant these routes (ADR-0141 D1).
export function handleCodingRuntimeQuestionAnswer(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  if (resolveAppSessionReadAuthority(deps, ctx.req) === undefined) {
    return Promise.resolve(notFound());
  }
  const runId = ctx.params.runId;
  return runId === undefined
    ? Promise.resolve(notFound())
    : mutation(ctx, deps, runId, (runtime, body) => runtime.answerQuestion(runId, body));
}

export function handleCodingRuntimeQuestionReject(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  if (resolveAppSessionReadAuthority(deps, ctx.req) === undefined) {
    return Promise.resolve(notFound());
  }
  const runId = ctx.params.runId;
  return runId === undefined
    ? Promise.resolve(notFound())
    : mutation(ctx, deps, runId, (runtime, body) => runtime.rejectQuestion(runId, body));
}

export function handleCodingRuntimeQuestionList(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  if (resolveAppSessionReadAuthority(deps, ctx.req) === undefined) {
    return Promise.resolve({
      status: 200,
      body: unpairedCodingWorkbenchRuntimeQuestionsChannelPayload(),
    });
  }
  const runId = ctx.params.runId;
  if (runId === undefined) return Promise.resolve(notFound());
  const required = requireRuntime(deps);
  if (isRouteResult(required)) return Promise.resolve(required);
  if (!required.orchestrator.getSnapshot(runId)) return Promise.resolve(notFound());
  return withBody(async () => {
    const body = await readBody(ctx.req);
    if (body === undefined) return failureResult("invalid-intent");
    const result = await required.orchestrator.listQuestions(runId, body);
    if (!result.ok) return failureResult(result.failureCode);
    const payload: CodingWorkbenchRuntimeQuestionsChannelPayload = {
      session: "active",
      questions: result.questions.questions,
    };
    return { status: 200, body: payload };
  });
}

/**
 * The #2387 operator-review projection of a pending research ask: the public host and the sanitized
 * request line the grant would bind. Content-bearing, so it enforces the same app-session read
 * authority as the question routes (ADR-0141 D2, #2478) and answers an unpaired caller with the one
 * constant content-free payload — never a distinct auth error and never a different answer for an
 * unknown run, so it is not an existence oracle (ADR-0141 D6).
 */
export function handleCodingRuntimeResearchAsk(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): RouteResult {
  if (resolveAppSessionReadAuthority(deps, ctx.req) === undefined) {
    return { status: 200, body: unpairedCodingWorkbenchRuntimeResearchChannelPayload() };
  }
  const runId = ctx.params.runId;
  if (runId === undefined) return notFound();
  const required = requireRuntime(deps);
  if (isRouteResult(required)) return required;
  if (!required.orchestrator.getSnapshot(runId)) return notFound();
  const pending = required.orchestrator.pendingResearchAsk(runId);
  const payload: CodingWorkbenchRuntimeResearchChannelPayload = {
    session: "active",
    ...(pending === undefined ? {} : { pending }),
  };
  return { status: 200, body: payload };
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
    method: "GET",
    pattern: "/api/coding-workbench/runtime/runs/:runId/research",
    handler: handleCodingRuntimeResearchAsk,
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
    pattern: "/api/coding-workbench/runtime/runs/:runId/research/revoke",
    handler: handleCodingRuntimeResearchRevoke,
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
