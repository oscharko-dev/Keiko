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
): void {
  (deps.activityLog ?? processServerLogSink()).write(
    activityLogEvent(
      APPROVAL_OPERATION,
      { level: "info", correlationId: ctx.correlationId ?? UNKNOWN_CORRELATION_ID },
      {
        action,
        outcome,
        sessionCount: deps.codingAppSessionChannel?.sessionCount() ?? 0,
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
    deps.codingAppSessionChannel?.browserApproval?.approve(readSessionCookie(ctx.req), body) ===
      true;
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

async function handleProof(ctx: RouteContext, deps: UiHandlerDeps): Promise<RouteResult> {
  const origin = requestOrigin(ctx);
  const body = await readPairingBody(ctx.req);
  const result =
    origin === undefined
      ? UNAVAILABLE
      : (deps.codingAppSessionChannel?.browserApproval?.prove(body, origin) ?? UNAVAILABLE);
  recordApproval(ctx, deps, "prove", result.state);
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
    deps.codingAppSessionChannel?.browserApproval?.revoke(readSessionCookie(ctx.req), body) ===
      true;
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
