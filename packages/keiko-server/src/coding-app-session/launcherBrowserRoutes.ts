import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type { UiHandlerDeps } from "../deps.js";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import { processServerLogSink } from "../process-log-sink.js";
import type { RouteContext, RouteResult } from "../routes.js";
import { readPairingBody } from "./codingAppSessionRoutes.js";
import type { LauncherBrowserTarget, LauncherBrowserOutcome } from "./launcherBrowser.js";

const OPEN_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-app-session.browser-open",
  category: "http",
  owner: "keiko-server",
  emitter: "coding-app-session.launcherBrowserRoutes.recordBrowserOpenOutcome",
  fields: {
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["opened", "busy", "unavailable", "failed"],
    },
  },
  causal: "correlation",
  lifecycle: "end",
  analyzerProjection: "timeline",
  failureClasses: ["coding-app-session-pairing"],
  diagnosticWhen: [{ field: "outcome", values: ["failed", "unavailable"] }],
  proofIds: ["coding-app-session.browser-open.outcome"],
  releaseImpact: "patch",
});

function browserTarget(agent: string | undefined): LauncherBrowserTarget {
  if (agent?.includes("Firefox/") === true) return "firefox";
  if (agent?.includes("Edg/") === true) return "edge";
  if (agent?.includes("Chrome/") === true) return "chrome";
  if (agent?.includes("Safari/") === true) return "safari";
  return "default";
}

function validRequest(body: unknown, ctx: RouteContext): body is { readonly origin: string } {
  return (
    body !== null &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    Object.keys(body).length === 1 &&
    "origin" in body &&
    typeof body.origin === "string" &&
    typeof ctx.req.headers.origin === "string" &&
    ctx.req.headers.origin === `http://${ctx.req.headers.host ?? ""}`
  );
}

/** Opens through the trusted OS launcher; this HTTP caller receives no read authority. */
export async function handleLauncherBrowserOpen(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const body = await readPairingBody(ctx.req);
  let outcome: LauncherBrowserOutcome;
  try {
    outcome = validRequest(body, ctx)
      ? ((await deps.launcherBrowser?.open(
          browserTarget(ctx.req.headers["user-agent"]),
          body.origin,
        )) ?? "unavailable")
      : "unavailable";
  } catch {
    recordBrowserOpenOutcome(ctx, deps, "failed");
    return { status: 200, body: { state: "failed" }, headers: { "Cache-Control": "no-store" } };
  }
  recordBrowserOpenOutcome(ctx, deps, outcome);
  return { status: 200, body: { state: outcome }, headers: { "Cache-Control": "no-store" } };
}

function recordBrowserOpenOutcome(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  outcome: LauncherBrowserOutcome,
): void {
  (deps.activityLog ?? processServerLogSink()).write(
    activityLogEvent(
      OPEN_OPERATION,
      {
        level: outcome === "failed" ? "warn" : "info",
        correlationId: ctx.correlationId ?? UNKNOWN_CORRELATION_ID,
      },
      { outcome },
    ),
  );
}
