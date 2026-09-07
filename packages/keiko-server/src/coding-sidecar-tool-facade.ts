// #3390 (ADR-0043 D11-D14): the OpenCode sidecar's governed tool facade rides THIS route instead
// of a second loopback listener. The Seatbelt `keiko-gateway` profile
// (packages/keiko-sandbox/src/backends.ts buildGatewaySeatbeltCommand) allows network-outbound to
// exactly one loopback destination -- the authenticated BFF port -- per ADR-0043 and the
// NetworkGatewayPolicy contract (packages/keiko-contracts/src/tools.ts). A prior design opened a
// SECOND ephemeral loopback listener for the tool bridge (opencodeRuntimeComposition.ts's
// `KEIKO_TOOL_FACADE_URL`); the sandboxed sidecar's connections to it were refused
// (`ConnectionRefused` / "Was there a typo in the url or port?"), so EVERY `keiko_*` tool call
// failed while only OpenCode-native tools worked. This route dispatches directly to the active
// run's tool bridge (`OpenCodeRuntimeComposition.toolBridge.handle`, exposed as
// `deps.toolFacadeBridge`), which already authenticates the bearer capability and enforces its own
// admission gate (maxInFlight, requestDeadlineMs, abort-on-close) -- this file builds no second
// authenticator, it only reads the request body under the bridge's existing byte budget and
// forwards it.
import { UNKNOWN_CORRELATION_ID } from "./correlation.js";
import { incomingHeaders } from "./coding-runtime/opencodeRuntimeComposition.js";
import { CODING_TOOL_MAX_BODY_BYTES } from "./coding-runtime/codingToolIpc.js";
import type { UiHandlerDeps } from "./deps.js";
import { readJsonObject } from "./files.js";
import { getServerLogger } from "./observability/index.js";
import { errorBody, type RouteContext, type RouteResult } from "./routes.js";

const CODING_SIDECAR_TOOL_FACADE_REJECTED_OP = "coding-sidecar.tool-facade.rejected";

// Closed vocabulary (AGENTS.md §8): every rejection this route can hand back gets ONE body-free
// warn line naming WHY, never a raw message. A status the bridge can return that is not in this
// table (200 success, 502 a genuine facade-execution failure already diagnosed at its own source,
// 503 no run is currently active) intentionally emits no "rejected" line here.
type CodingSidecarToolFacadeRejectionReason =
  | "origin-not-allowed"
  | "capability-invalid"
  | "body-too-large"
  | "body-invalid"
  | "busy"
  | "deadline";

interface ToolFacadeStatusMapping {
  readonly reason?: CodingSidecarToolFacadeRejectionReason;
  readonly code: string;
  readonly message: string;
}

const TOOL_FACADE_STATUS_MAPPINGS: ReadonlyMap<number, ToolFacadeStatusMapping> = new Map([
  [
    401,
    {
      reason: "capability-invalid",
      code: "UNAUTHORIZED",
      message: "Coding tool facade authentication failed.",
    },
  ],
  [
    403,
    {
      reason: "origin-not-allowed",
      code: "FORBIDDEN",
      message: "Coding tool facade request is denied.",
    },
  ],
  [
    400,
    { reason: "body-invalid", code: "BAD_REQUEST", message: "Request body is not valid JSON." },
  ],
  [
    413,
    {
      reason: "body-too-large",
      code: "PAYLOAD_TOO_LARGE",
      message: "Request body exceeds the size limit.",
    },
  ],
  [
    429,
    {
      reason: "busy",
      code: "CODING_TOOL_FACADE_BUSY",
      message: "Coding tool facade is busy; retry shortly.",
    },
  ],
  [
    408,
    {
      reason: "deadline",
      code: "CODING_TOOL_FACADE_DEADLINE_EXCEEDED",
      message: "Coding tool facade call exceeded its deadline.",
    },
  ],
]);

const TOOL_FACADE_DEFAULT_MAPPING: ToolFacadeStatusMapping = {
  code: "CODING_TOOL_FACADE_UNAVAILABLE",
  message: "Coding tool facade call failed.",
};

// The 408 mapping is shared between the bridge-returned deadline (a call admitted then aborted
// mid-execution) and the route's own body-ingestion deadline below -- one message, not two.
const TOOL_FACADE_DEADLINE_MAPPING =
  TOOL_FACADE_STATUS_MAPPINGS.get(408) ?? TOOL_FACADE_DEFAULT_MAPPING;

/** Body-free: `reason` is closed, `status` is a number -- never the request or facade body. */
function logToolFacadeRejection(
  ctx: RouteContext,
  status: number,
  reason: CodingSidecarToolFacadeRejectionReason,
): void {
  getServerLogger().warn({
    category: "gateway",
    op: CODING_SIDECAR_TOOL_FACADE_REJECTED_OP,
    correlationId: ctx.correlationId ?? UNKNOWN_CORRELATION_ID,
    status,
    extra: { reason },
  });
}

function hasBrowserOrigin(ctx: RouteContext): boolean {
  return ctx.req.headers.origin !== undefined;
}

function isRouteResult(value: unknown): value is RouteResult {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { status?: unknown }).status === "number" &&
    "body" in value
  );
}

function unavailableToolFacadeRequest(ctx: RouteContext): RouteResult {
  return {
    status: 503,
    body: errorBody(
      "CODING_TOOL_FACADE_UNAVAILABLE",
      "No coding run is currently active.",
      ctx.correlationId,
    ),
  };
}

// Mirrors the retired raw-listener bridge's own disconnect handling (opencodeRuntimeComposition.ts
// `bindToolDisconnect`, pre-#3390), now driven from the ROUTE's request/response instead of an
// internal admission object: the bridge's `handle` merges this signal with its own deadline abort
// through the ONE existing cancellation path, so "abort-on-close" stays effective end-to-end.
function bindRouteDisconnect(ctx: RouteContext): {
  readonly signal: AbortSignal;
  readonly detach: () => void;
} {
  const controller = new AbortController();
  const onDisconnect = (): void => {
    controller.abort();
  };
  const onResponseClosed = (): void => {
    if (!ctx.res.writableFinished) onDisconnect();
  };
  ctx.req.once("aborted", onDisconnect);
  ctx.res.once("close", onResponseClosed);
  return {
    signal: controller.signal,
    detach: (): void => {
      ctx.req.removeListener("aborted", onDisconnect);
      ctx.res.removeListener("close", onResponseClosed);
    },
  };
}

function bodyReadRejectionReason(status: number): CodingSidecarToolFacadeRejectionReason {
  if (status === 413) return "body-too-large";
  if (status === 408) return "deadline";
  return "body-invalid";
}

/**
 * Bounds body ingestion by the SAME per-run deadline the admission gate applies to execution
 * (`bridge.requestDeadlineMs`) -- previously a slow/partial POST buffered for as long as Node's
 * generic socket defaults allowed, because the gate's own deadline timer only starts once
 * `bridge.handle` is called, i.e. after the whole body has already arrived (#3390 follow-up).
 * On timeout this settles 408 WITHOUT touching `ctx.req` (unlike the other route handlers'
 * `req.resume()`-to-drain convention, `req.destroy()` here would tear down the socket the 408
 * response itself needs to go out on, since request and response share one connection) -- the
 * abandoned `readJsonObject` read is left to finish or error on its own; whichever settles this
 * promise first (body finishes, or the deadline fires) wins, and the loser is a no-op.
 */
function readToolFacadeBody(
  ctx: RouteContext,
  deadlineMs: number,
): Promise<Record<string, unknown> | RouteResult> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({
        status: 408,
        body: errorBody(
          TOOL_FACADE_DEADLINE_MAPPING.code,
          TOOL_FACADE_DEADLINE_MAPPING.message,
          ctx.correlationId,
        ),
      });
    }, deadlineMs);
    timer.unref();
    void readJsonObject(ctx.req, CODING_TOOL_MAX_BODY_BYTES).then(
      (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          status: 400,
          body: errorBody("BAD_REQUEST", "Request body could not be read.", ctx.correlationId),
        });
      },
    );
  });
}

function toolFacadeRouteResult(
  ctx: RouteContext,
  result: { readonly status: number; readonly body: string },
): RouteResult {
  if (result.status === 200) {
    return { status: 200, body: JSON.parse(result.body) as unknown };
  }
  const mapping = TOOL_FACADE_STATUS_MAPPINGS.get(result.status) ?? TOOL_FACADE_DEFAULT_MAPPING;
  if (mapping.reason !== undefined) logToolFacadeRejection(ctx, result.status, mapping.reason);
  return {
    status: result.status,
    body: errorBody(mapping.code, mapping.message, ctx.correlationId),
  };
}

/**
 * POST /api/coding-sidecar/tool -- the ONE loopback destination the sandboxed OpenCode sidecar's
 * governed tool calls (`keiko_workspace_discover`, `keiko_git_status`, …) reach, riding the SAME
 * attested BFF port as `/api/coding-sidecar/gateway/*` instead of a second listener the Seatbelt
 * profile denies.
 */
export async function handleCodingSidecarToolFacade(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  if (hasBrowserOrigin(ctx)) {
    logToolFacadeRejection(ctx, 403, "origin-not-allowed");
    return {
      status: 403,
      body: errorBody("FORBIDDEN", "Coding tool facade request is denied.", ctx.correlationId),
    };
  }
  const bridge = deps.toolFacadeBridge?.resolve();
  if (bridge === undefined) {
    return unavailableToolFacadeRequest(ctx);
  }
  const parsed = await readToolFacadeBody(ctx, bridge.requestDeadlineMs);
  if (isRouteResult(parsed)) {
    logToolFacadeRejection(ctx, parsed.status, bodyReadRejectionReason(parsed.status));
    return parsed;
  }
  const disconnect = bindRouteDisconnect(ctx);
  try {
    const result = await bridge.handle({
      method: "POST",
      headers: incomingHeaders(ctx.req.headers),
      body: JSON.stringify(parsed),
      signal: disconnect.signal,
    });
    return toolFacadeRouteResult(ctx, result);
  } finally {
    disconnect.detach();
  }
}
