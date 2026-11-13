import {
  isBrowserApprovalId,
  isBrowserApprovalOrigin,
  type BrowserApprovalManagementSnapshot,
} from "@oscharko-dev/keiko-contracts/runtime/coding-app-session";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type { UiHandlerDeps } from "../deps.js";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import { processServerLogSink } from "../process-log-sink.js";
import type { RouteContext, RouteDefinition, RouteResult } from "../routes.js";
import { readPairingBody } from "./codingAppSessionRoutes.js";
import { classifyReconnect, type SessionReconnectKind } from "./sessionChannel.js";
import type { BrowserApprovalService } from "./browserApproval.js";
import { readSessionCookie, requestIsSecure, serializeSessionCookies } from "./sessionCookie.js";

const APPROVAL_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-app-session.browser-approval.state",
  category: "http",
  owner: "keiko-server",
  emitter: "coding-app-session.browserApprovalRoutes.recordApproval",
  fields: {
    sessionCount: { type: "integer", dataClass: "count", required: true },
    pendingRequestCount: { type: "integer", dataClass: "count", required: false },
    sessionApprovalCount: { type: "integer", dataClass: "count", required: false },
    rememberedApprovalCount: { type: "integer", dataClass: "count", required: false },
    action: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["request", "approve", "challenge", "prove", "revoke", "inspect"],
    },
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["pending", "challenge", "active", "accepted", "unavailable"],
    },
    // Only on `prove`: how the issued session relates to the credential the browser presented, so a
    // remembered browser renewing after a server restart reads `after-restart` (#4370).
    reconnect: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["first-pairing", "live-credential", "after-restart", "replaced-credential"],
    },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["coding-app-session-pairing"],
  proofIds: ["coding-app-session.browser-approval.state.line"],
  releaseImpact: "patch",
});

type ApprovalAction = "request" | "approve" | "challenge" | "prove" | "revoke" | "inspect";
type ApprovalOutcome = "pending" | "challenge" | "active" | "accepted" | "unavailable";
const UNAVAILABLE = { state: "unavailable" } as const;
const PRIVATE_HEADERS = { "Cache-Control": "no-store" } as const;

/** Bind to the actual transport and Host, never the routing URL's placeholder authority. */
function requestOrigin(ctx: RouteContext): string | undefined {
  const origin = ctx.req.headers.origin;
  const scheme = requestIsSecure(ctx.req) ? "https" : "http";
  return isBrowserApprovalOrigin(origin) && origin === `${scheme}://${ctx.req.headers.host ?? ""}`
    ? origin
    : undefined;
}

function recordApproval(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  action: ApprovalAction,
  outcome: ApprovalOutcome,
  snapshot?: BrowserApprovalManagementSnapshot,
  reconnect?: SessionReconnectKind,
): void {
  (deps.activityLog ?? processServerLogSink()).write(
    activityLogEvent(
      APPROVAL_OPERATION,
      { level: "info", correlationId: ctx.correlationId ?? UNKNOWN_CORRELATION_ID },
      {
        action,
        outcome,
        sessionCount: deps.codingAppSessionChannel?.sessionCount() ?? 0,
        ...(reconnect === undefined ? {} : { reconnect }),
        ...(snapshot === undefined
          ? {}
          : {
              pendingRequestCount: snapshot.requests.length,
              sessionApprovalCount: snapshot.approvals.filter((approval) => !approval.remembered)
                .length,
              rememberedApprovalCount: snapshot.approvals.filter((approval) => approval.remembered)
                .length,
            }),
      },
    ),
  );
}

async function handleRequest(ctx: RouteContext, deps: UiHandlerDeps): Promise<RouteResult> {
  const origin = requestOrigin(ctx);
  const body = await readPairingBody(ctx.req);
  const result =
    origin === undefined
      ? UNAVAILABLE
      : (deps.codingAppSessionChannel?.browserApproval?.request(body, origin) ?? UNAVAILABLE);
  recordApproval(ctx, deps, "request", result.state);
  return { status: 200, body: result, headers: PRIVATE_HEADERS };
}

function handleInspect(ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  const snapshot = deps.codingAppSessionChannel?.browserApproval?.snapshot(
    readSessionCookie(ctx.req),
    { correlationId: ctx.correlationId ?? UNKNOWN_CORRELATION_ID, purpose: "inspection" },
  );
  recordApproval(
    ctx,
    deps,
    "inspect",
    snapshot === undefined ? "unavailable" : "accepted",
    snapshot,
  );
  return {
    status: 200,
    body: snapshot === undefined ? UNAVAILABLE : { state: "active", ...snapshot },
    headers: PRIVATE_HEADERS,
  };
}

async function handleApprove(ctx: RouteContext, deps: UiHandlerDeps): Promise<RouteResult> {
  const body = await readPairingBody(ctx.req);
  const accepted =
    requestOrigin(ctx) !== undefined &&
    deps.codingAppSessionChannel?.browserApproval?.approve(readSessionCookie(ctx.req), body, {
      correlationId: ctx.correlationId ?? UNKNOWN_CORRELATION_ID,
    }) === true;
  recordApproval(ctx, deps, "approve", accepted ? "accepted" : "unavailable");
  return {
    status: 200,
    body: accepted ? { state: "accepted" } : UNAVAILABLE,
    headers: PRIVATE_HEADERS,
  };
}

async function handleChallenge(ctx: RouteContext, deps: UiHandlerDeps): Promise<RouteResult> {
  const origin = requestOrigin(ctx);
  const body = await readPairingBody(ctx.req);
  const result =
    origin === undefined
      ? UNAVAILABLE
      : (deps.codingAppSessionChannel?.browserApproval?.challenge(body, origin) ?? UNAVAILABLE);
  recordApproval(ctx, deps, "challenge", result.state);
  return { status: 200, body: result, headers: PRIVATE_HEADERS };
}

function proofOutcome(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  origin: string | undefined,
  body: unknown,
): {
  readonly result: ReturnType<BrowserApprovalService["prove"]> | typeof UNAVAILABLE;
  readonly reconnect: SessionReconnectKind | undefined;
} {
  const channel = deps.codingAppSessionChannel;
  // Classified before the proof mints a session: the mint itself counts as the process's first issuance.
  const standing = channel?.proofStanding?.(readSessionCookie(ctx.req));
  const result =
    origin === undefined
      ? UNAVAILABLE
      : (channel?.browserApproval?.prove(
          body,
          origin,
          ctx.correlationId ?? UNKNOWN_CORRELATION_ID,
        ) ?? UNAVAILABLE);
  return {
    result,
    reconnect: standing === undefined ? undefined : classifyReconnect(standing),
  };
}

async function handleProof(ctx: RouteContext, deps: UiHandlerDeps): Promise<RouteResult> {
  const body = await readPairingBody(ctx.req);
  const { result, reconnect } = proofOutcome(ctx, deps, requestOrigin(ctx), body);
  recordApproval(
    ctx,
    deps,
    "prove",
    result.state,
    undefined,
    result.state === "active" ? reconnect : undefined,
  );
  if (result.state !== "active")
    return { status: 200, body: UNAVAILABLE, headers: PRIVATE_HEADERS };
  return {
    status: 200,
    body: {
      state: "active",
      ...(result.approval === undefined ? {} : { approval: result.approval }),
    },
    headers: {
      ...PRIVATE_HEADERS,
      "Set-Cookie": serializeSessionCookies(result.mint.cookieToken, {
        secure: requestIsSecure(ctx.req),
        maxAgeSeconds: result.maxAgeSeconds,
      }),
    },
  };
}

async function handleRevoke(ctx: RouteContext, deps: UiHandlerDeps): Promise<RouteResult> {
  const body = await readPairingBody(ctx.req);
  const accepted =
    requestOrigin(ctx) !== undefined &&
    isBrowserApprovalId(body) &&
    deps.codingAppSessionChannel?.browserApproval?.revoke(readSessionCookie(ctx.req), body, {
      correlationId: ctx.correlationId ?? UNKNOWN_CORRELATION_ID,
    }) === true;
  recordApproval(ctx, deps, "revoke", accepted ? "accepted" : "unavailable");
  return {
    status: 200,
    body: accepted ? { state: "accepted" } : UNAVAILABLE,
    headers: PRIVATE_HEADERS,
  };
}

export const BROWSER_APPROVAL_ROUTES: readonly RouteDefinition[] = [
  {
    method: "POST",
    pattern: "/api/coding-workbench/app-session/browser/request",
    handler: handleRequest,
  },
  { method: "GET", pattern: "/api/coding-workbench/app-session/browser", handler: handleInspect },
  {
    method: "POST",
    pattern: "/api/coding-workbench/app-session/browser/approve",
    handler: handleApprove,
  },
  {
    method: "POST",
    pattern: "/api/coding-workbench/app-session/browser/challenge",
    handler: handleChallenge,
  },
  {
    method: "POST",
    pattern: "/api/coding-workbench/app-session/browser/prove",
    handler: handleProof,
  },
  {
    method: "POST",
    pattern: "/api/coding-workbench/app-session/browser/revoke",
    handler: handleRevoke,
  },
];
