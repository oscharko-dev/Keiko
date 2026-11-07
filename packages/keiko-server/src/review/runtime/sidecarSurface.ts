// Which sidecar surface a shared sidecar request arrived on (ADR-0182 D1, Issue #4135).
//
// The review instance's sidecar reaches the server under `/api/review-sidecar/*`, served by the
// SAME gateway and tool-facade handlers as the Coding Workbench's `/api/coding-sidecar/*`. Those
// handlers read the surface from the request's own route so their rejection lines and diagnostics
// name the review route and carry `runtimePurpose: "review"`, even when no review instance owns the
// request's capability and the handler is served with no runtime at all.

import type { RouteContext } from "../../routes.js";

const REVIEW_SIDECAR_PREFIX = "/api/review-sidecar/";

/**
 * The shared sidecar rejection lines' optional `runtimePurpose` field: `review` for a request on the
 * review sidecar's route; absent (read as `coding`) on the Coding Workbench's own.
 */
export const SIDECAR_RUNTIME_PURPOSE_FIELDS = {
  runtimePurpose: { type: "string", dataClass: "closed-enum", required: false, values: ["review"] },
} as const;

/** `review` for a request received on a `/api/review-sidecar/*` route; otherwise absent. */
function sidecarRuntimePurpose(ctx: Pick<RouteContext, "url">): "review" | undefined {
  return ctx.url.pathname.startsWith(REVIEW_SIDECAR_PREFIX) ? "review" : undefined;
}

/** The route template a sidecar gateway diagnostic names, by the surface the request came in on. */
export function sidecarGatewayRouteTemplate(ctx: Pick<RouteContext, "url">): string {
  return sidecarRuntimePurpose(ctx) === "review"
    ? "POST /api/review-sidecar/gateway/chat/completions"
    : "POST /api/coding-sidecar/gateway/chat/completions";
}

/**
 * Whether the request's upstream model call is buffered whatever the capability streams. A review is
 * not interactive, so the review sidecar buffers: the gateway validates the whole answer before any
 * byte reaches the runtime, and a schema-invalid tool call after some text can still be corrected
 * once (Issue #4138). A streamed call that already delivered that text cannot be retried.
 */
export function sidecarBuffersUpstream(ctx: Pick<RouteContext, "url">): boolean {
  return sidecarRuntimePurpose(ctx) === "review";
}

/** The optional `runtimePurpose` field of a shared sidecar rejection line. */
export function sidecarPurposeField(ctx: Pick<RouteContext, "url">): {
  readonly runtimePurpose?: "review";
} {
  return sidecarRuntimePurpose(ctx) === undefined ? {} : { runtimePurpose: "review" };
}
