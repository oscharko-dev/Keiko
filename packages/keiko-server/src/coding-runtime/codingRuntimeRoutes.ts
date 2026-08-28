// Public, content-free lifecycle boundary for the singleton Coding Workbench runtime (#2256).
// POST CSRF and JSON content-type enforcement is centralized in server.ts.

import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  CodingWorkbenchMode,
  CodingWorkbenchRuntimeApprovalReviewChannelPayload,
  CodingWorkbenchRuntimeFailureCode,
  CodingWorkbenchRuntimeQuestionsChannelPayload,
  CodingWorkbenchRuntimeResearchChannelPayload,
  CodingWorkbenchRuntimeSseEvent,
  CodingWorkbenchRuntimeStateName,
} from "@oscharko-dev/keiko-contracts";
import { CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime";
import { parseCodingWorkbenchRuntimeReadinessRequest } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-api";
import { resolveEffectiveCodingWorkbenchMode } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";
import { unpairedCodingWorkbenchRuntimeApprovalReviewChannelPayload } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-approval-review";
import { unpairedCodingWorkbenchRuntimeQuestionsChannelPayload } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-questions";
import { unpairedCodingWorkbenchRuntimeResearchChannelPayload } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-research";
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
import { SSE_HEADERS, startSseHeartbeat } from "../sse.js";
import type { CodingRuntimeEventHub } from "./codingRuntimeEventHub.js";
import type { CodingRuntimeOrchestrator } from "./codingRuntimeOrchestrator.js";

const MAX_BODY_BYTES = 64 * 1024;

class BodyTooLargeError extends Error {}

interface RuntimeDeps {
  readonly orchestrator: CodingRuntimeOrchestrator;
  readonly eventHub: CodingRuntimeEventHub;
}

// KEIKO-0534: helper wrappers now accept the request's correlation id so 4xx/404/503 error
// bodies match manual-pod-routes.ts's convention (errorBody(code, message, ctx.correlationId)).
function unavailable(correlationId?: string): RouteResult {
  return {
    status: 503,
    body: errorBody(
      "CODING_RUNTIME_UNAVAILABLE",
      "Coding runtime is not configured for this server.",
      correlationId,
    ),
  };
}

function requireRuntime(deps: UiHandlerDeps, correlationId?: string): RuntimeDeps | RouteResult {
  if (!deps.codingRuntimeOrchestrator || !deps.codingRuntimeEventHub)
    return unavailable(correlationId);
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

function failureResult(
  failureCode: CodingWorkbenchRuntimeFailureCode,
  correlationId?: string,
): RouteResult {
  const status = failureStatus(failureCode);
  return {
    status,
    body: errorBody(
      `CODING_RUNTIME_${failureCode.replaceAll("-", "_").toUpperCase()}`,
      "Runtime request was rejected.",
      correlationId,
    ),
  };
}

function notFound(correlationId?: string): RouteResult {
  return {
    status: 404,
    body: errorBody("CODING_RUNTIME_RUN_NOT_FOUND", "Runtime run was not found.", correlationId),
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

async function withBody(
  work: () => Promise<RouteResult>,
  correlationId?: string,
): Promise<RouteResult> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof BodyTooLargeError)
      return {
        status: 413,
        body: errorBody("PAYLOAD_TOO_LARGE", "Request body exceeds the size limit.", correlationId),
      };
    throw error;
  }
}

/**
 * The single authority choke point for every state-changing coding-runtime route.
 *
 * ADR-0141 D1 fixes loopback, same-origin `Origin`, the constant CSRF header, and `runId` knowledge
 * as routing facts that never grant a route; D2 makes the launcher-attested app session the
 * authority. Enforcement was scoped to the content-bearing question and research reads (W1.5,
 * #2478), which left the authority-GRANTING lifecycle mutations — start, approve, stop, takeover,
 * retry, recovery-ack, pause, resume, follow-up, research revoke — reachable by any same-user local
 * process that replayed those routing facts. Every one of them funnels through this helper, so the
 * boundary lives here once: a route that cannot mutate without `mutation()` cannot forget the
 * guard, and a future lifecycle route inherits it by construction.
 *
 * The check runs BEFORE run resolution and before the body is read (ADR-0141 F1 ordering), and it
 * fails closed: an absent channel, an absent cookie, a forged, revoked, rotated-away, or expired
 * session all resolve to no authority and are denied. The denial shape is deliberately split:
 *   - a per-run mutation answers with the existence-concealing not-found result, byte-identical to
 *     the response an unknown `runId` yields, so the denial is not a run-existence oracle
 *     (ADR-0141 D6, the same posture the question mutations already take);
 *   - the run-creating `POST /runs` names no run and conceals no existence, so it answers with the
 *     honest `authority-resolution-failed` the Workbench already renders as an actionable start
 *     failure — never a dead button, and never a silent success.
 */
function requireMutationAuthority(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  runId: string | undefined,
): RouteResult | undefined {
  if (resolveAppSessionReadAuthority(deps, ctx.req) !== undefined) return undefined;
  return runId === undefined
    ? failureResult("authority-resolution-failed", ctx.correlationId)
    : notFound(ctx.correlationId);
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
  const denied = requireMutationAuthority(ctx, deps, runId);
  if (denied !== undefined) return denied;
  const required = requireRuntime(deps, ctx.correlationId);
  if (isRouteResult(required)) return required;
  if (runId !== undefined && !required.orchestrator.getSnapshot(runId))
    return notFound(ctx.correlationId);
  return withBody(async () => {
    const body = await readBody(ctx.req);
    if (body === undefined) return failureResult("invalid-intent", ctx.correlationId);
    const result = await operation(required.orchestrator, body);
    return result.ok
      ? { status: 200, body: result.snapshot }
      : failureResult(result.failureCode, ctx.correlationId);
  }, ctx.correlationId);
}

export function handleCreateCodingRuntimeRun(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  return mutation(ctx, deps, undefined, (runtime, body) => runtime.start(body));
}

export function handleCodingRuntimeStatus(ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  // The status request has no input surface. Rejecting every query parameter both makes the
  // transport contract exact and ensures this handler cannot silently grow a caller-controlled
  // selector that turns the otherwise content-free projection into an existence oracle (#2644).
  if (ctx.url.searchParams.size !== 0) return failureResult("invalid-intent", ctx.correlationId);
  const required = requireRuntime(deps, ctx.correlationId);
  return isRouteResult(required) ? required : { status: 200, body: required.orchestrator.status() };
}

export function handleCodingRuntimeReadiness(ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  const values = ctx.url.searchParams.getAll("requestedMode");
  const parsed = parseCodingWorkbenchRuntimeReadinessRequest({ requestedMode: values[0] });
  if (
    values.length !== 1 ||
    [...ctx.url.searchParams.keys()].some((key) => key !== "requestedMode")
  ) {
    return failureResult("invalid-intent", ctx.correlationId);
  }
  if (!parsed.ok) return failureResult("invalid-intent", ctx.correlationId);
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
      // Both branches name themselves. The available branch's `??` is the fail-closed default: an
      // unthreaded dep yields `undefined`, and `undefined` must never serialize into a verified
      // claim (audit F-01).
      ...(runtimeAvailable
        ? {
            runtimeEvidenceClass:
              deps.codingRuntimeEvidenceClass ?? "functional-not-platform-qualified",
          }
        : {
            runtimeUnavailableReason: deps.codingRuntimeUnavailableReason ?? "runtime-unqualified",
          }),
    },
  };
}

/**
 * States in which a run still holds the Authority Envelope minted for it. `effectiveMode` is fixed
 * at mint (`CodingRuntimeAuthorityService.mintConfirmedStartForRun`) and nothing re-mints it —
 * `resume` only clears the manager's paused flag — so for these states the run's own posture is
 * the only truthful answer to "what authority does this run actually hold".
 */
const RUN_STATES_HOLDING_MINTED_AUTHORITY: ReadonlySet<CodingWorkbenchRuntimeStateName> = new Set([
  "starting",
  "ready",
  "running",
  "awaiting-approval",
  "paused",
  "stopping",
]);

/**
 * The server-confirmed effective mode is anchored to the live run (#2386), so the browser can
 * never display an authority the server did not grant — in EITHER direction. While a run holds a
 * minted envelope the answer is that run's ceiling-clamped posture: a widening request is not
 * granted, and a narrowing one is not applied either (0.3.0 release audit — the mode-change gate
 * admits a narrowing selection from `paused`, but no code path re-mints the live envelope, so
 * confirming it understated the authority the tool facade actually enforces). Once no envelope is
 * held, the next start or retry mints from the request, so the clamped request is the truth.
 */
function confirmedEffectiveMode(
  deps: UiHandlerDeps,
  requestedMode: CodingWorkbenchMode,
  deploymentCeiling: CodingWorkbenchMode,
): CodingWorkbenchMode {
  const current = deps.codingRuntimeOrchestrator?.status();
  if (
    current?.requestedMode === undefined ||
    !RUN_STATES_HOLDING_MINTED_AUTHORITY.has(current.state)
  ) {
    return resolveEffectiveCodingWorkbenchMode(requestedMode, deploymentCeiling);
  }
  return resolveEffectiveCodingWorkbenchMode(current.requestedMode, deploymentCeiling);
}

export function handleGetCodingRuntimeRun(ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  const required = requireRuntime(deps, ctx.correlationId);
  if (isRouteResult(required)) return required;
  const snapshot = required.orchestrator.getSnapshot(ctx.params.runId ?? "");
  return snapshot ? { status: 200, body: snapshot } : notFound(ctx.correlationId);
}

export function handleCodingRuntimeApproval(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const runId = ctx.params.runId;
  return runId === undefined
    ? Promise.resolve(notFound(ctx.correlationId))
    : mutation(ctx, deps, runId, (runtime, body) => runtime.decideApproval(runId, body));
}
export function handleCodingRuntimeStop(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const runId = ctx.params.runId;
  return runId === undefined
    ? Promise.resolve(notFound(ctx.correlationId))
    : mutation(ctx, deps, runId, (runtime, body) => runtime.stop(runId, body));
}
export function handleCodingRuntimeTakeover(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const runId = ctx.params.runId;
  return runId === undefined
    ? Promise.resolve(notFound(ctx.correlationId))
    : mutation(ctx, deps, runId, (runtime, body) => runtime.takeover(runId, body));
}
export function handleCodingRuntimeRetry(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const runId = ctx.params.runId;
  return runId === undefined
    ? Promise.resolve(notFound(ctx.correlationId))
    : mutation(ctx, deps, runId, (runtime, body) => runtime.retry(runId, body));
}
export function handleCodingRuntimeRecoveryAcknowledgement(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const runId = ctx.params.runId;
  return runId === undefined
    ? Promise.resolve(notFound(ctx.correlationId))
    : mutation(ctx, deps, runId, (runtime, body) => runtime.acknowledgeRecovery(runId, body));
}

export function handleCodingRuntimePause(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const runId = ctx.params.runId;
  return runId === undefined
    ? Promise.resolve(notFound(ctx.correlationId))
    : mutation(ctx, deps, runId, (runtime, body) => runtime.pause(runId, body));
}

export function handleCodingRuntimeResume(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const runId = ctx.params.runId;
  return runId === undefined
    ? Promise.resolve(notFound(ctx.correlationId))
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
    ? Promise.resolve(notFound(ctx.correlationId))
    : mutation(ctx, deps, runId, (runtime, body) => runtime.revokeResearch(runId, body));
}

// Inline follow-up: a drafted message is admitted only while the run is running; the
// orchestrator's operation coordinator enforces the revision and one-use request-id serial
// admission, so exactly one turn is admitted per revision and no hidden prompt queue is possible.
export function handleCodingRuntimeFollowUp(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const runId = ctx.params.runId;
  return runId === undefined
    ? Promise.resolve(notFound(ctx.correlationId))
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
    return Promise.resolve(notFound(ctx.correlationId));
  }
  const runId = ctx.params.runId;
  return runId === undefined
    ? Promise.resolve(notFound(ctx.correlationId))
    : mutation(ctx, deps, runId, (runtime, body) => runtime.answerQuestion(runId, body));
}

export function handleCodingRuntimeQuestionReject(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  if (resolveAppSessionReadAuthority(deps, ctx.req) === undefined) {
    return Promise.resolve(notFound(ctx.correlationId));
  }
  const runId = ctx.params.runId;
  return runId === undefined
    ? Promise.resolve(notFound(ctx.correlationId))
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
  if (runId === undefined) return Promise.resolve(notFound(ctx.correlationId));
  const required = requireRuntime(deps, ctx.correlationId);
  if (isRouteResult(required)) return Promise.resolve(required);
  if (!required.orchestrator.getSnapshot(runId))
    return Promise.resolve(notFound(ctx.correlationId));
  return withBody(async () => {
    const body = await readBody(ctx.req);
    if (body === undefined) return failureResult("invalid-intent", ctx.correlationId);
    const result = await required.orchestrator.listQuestions(runId, body);
    if (!result.ok) return failureResult(result.failureCode, ctx.correlationId);
    const payload: CodingWorkbenchRuntimeQuestionsChannelPayload = {
      session: "active",
      questions: result.questions.questions,
    };
    return { status: 200, body: payload };
  }, ctx.correlationId);
}

/**
 * The authenticated research projection: the pending ask an operator reviews and the active grant
 * it creates. Both contain model-selected hosts, so neither may ride a general runtime snapshot
 * (#2644). An unpaired caller receives the one constant content-free payload before run resolution
 * — never a distinct auth error or an existence oracle (ADR-0141 D6).
 */
export function handleCodingRuntimeResearch(ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  if (resolveAppSessionReadAuthority(deps, ctx.req) === undefined) {
    return { status: 200, body: unpairedCodingWorkbenchRuntimeResearchChannelPayload() };
  }
  const runId = ctx.params.runId;
  if (runId === undefined) return notFound(ctx.correlationId);
  const required = requireRuntime(deps, ctx.correlationId);
  if (isRouteResult(required)) return required;
  if (!required.orchestrator.getSnapshot(runId)) return notFound(ctx.correlationId);
  const pending = required.orchestrator.pendingResearchAsk(runId);
  const grant = required.orchestrator.researchGrant(runId);
  const payload: CodingWorkbenchRuntimeResearchChannelPayload = {
    session: "active",
    ...(pending === undefined ? {} : { pending }),
    ...(grant === undefined ? {} : { grant }),
  };
  return { status: 200, body: payload };
}

/**
 * The authenticated approval-review projection (#2802): which workspace files the pending edit
 * approval would write and how large the change is. A human cannot exercise control over a change
 * they are not shown (ADR-0129 D1) — and the paths are model-selected, so like the research ask
 * they may not ride the general runtime snapshot or the SSE projection (#2644). An unpaired caller
 * receives the one constant content-free payload BEFORE any run resolution, so this route is never
 * an existence oracle (ADR-0141 D6). Patch bytes, file bodies and model prose are not carried.
 */
export function handleCodingRuntimeApprovalReview(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): RouteResult {
  if (resolveAppSessionReadAuthority(deps, ctx.req) === undefined) {
    return { status: 200, body: unpairedCodingWorkbenchRuntimeApprovalReviewChannelPayload() };
  }
  const runId = ctx.params.runId;
  if (runId === undefined) return notFound(ctx.correlationId);
  const required = requireRuntime(deps, ctx.correlationId);
  if (isRouteResult(required)) return required;
  if (!required.orchestrator.getSnapshot(runId)) return notFound(ctx.correlationId);
  const pending = required.orchestrator.pendingApprovalReview(runId);
  const payload: CodingWorkbenchRuntimeApprovalReviewChannelPayload = {
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

function resolveEventCursor(
  lastEventId: string | string[] | undefined,
  queryCursor: string | null,
): string | undefined {
  if (Array.isArray(lastEventId)) return undefined;
  if (typeof lastEventId === "string" && lastEventId.length > 0) return lastEventId;
  return queryCursor === null || queryCursor.length === 0 ? undefined : queryCursor;
}

export function handleCodingRuntimeEvents(ctx: RouteContext, deps: UiHandlerDeps): HandlerOutcome {
  const required = requireRuntime(deps, ctx.correlationId);
  if (isRouteResult(required)) return required;
  const runId = ctx.params.runId ?? "";
  if (!required.orchestrator.getSnapshot(runId)) return notFound(ctx.correlationId);
  const lastEventId = ctx.req.headers["last-event-id"];
  const queryCursor = ctx.url.searchParams.get("cursor");
  const cursor = resolveEventCursor(lastEventId, queryCursor);
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
  const stopHeartbeat = startSseHeartbeat(res, undefined, "heartbeat");
  let detach = (): void => undefined;
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    stopHeartbeat();
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
    close();
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
    handler: handleCodingRuntimeResearch,
  },
  {
    method: "GET",
    pattern: "/api/coding-workbench/runtime/runs/:runId/approval-review",
    handler: handleCodingRuntimeApprovalReview,
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
