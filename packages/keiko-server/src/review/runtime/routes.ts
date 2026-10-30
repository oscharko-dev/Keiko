// The review instance's sidecar routes (ADR-0182 D1, Issue #4135).
//
// A review instance's sandboxed OpenCode sidecar reaches the server under `/api/review-sidecar/*`,
// on the same attested loopback port as the Coding Workbench's sidecar. Each route serves the SAME
// handler as its `/api/coding-sidecar/*` twin -- the same gateway admission, Model Gateway call,
// budgets, spend ledger, readiness and tool bridge -- with the deps view of the one review instance
// whose runtime capability the request carries. A request whose capability no review instance
// owns is answered by the shared handler with no runtime at all, so it fails closed exactly like a
// sidecar request without a run; it can never reach the Coding Workbench's runtime.

import type { RouteContext, RouteResult, STREAMING } from "../../routes.js";
import { handleCodingSidecarGatewayChatCompletions } from "../../coding-sidecar-gateway.js";
import { handleCodingSidecarToolFacade } from "../../coding-sidecar-tool-facade.js";
import type { UiHandlerDeps } from "../../deps.js";

function bearerCapability(ctx: RouteContext): string | undefined {
  const value = ctx.req.headers.authorization;
  if (typeof value !== "string" || !value.startsWith("Bearer ")) return undefined;
  const capability = value.slice("Bearer ".length);
  return capability.length > 0 ? capability : undefined;
}

/** The deps a review sidecar request is served with: its instance's, or none at all. */
export function reviewSidecarDeps(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  audience: "model-gateway" | "tool-facade",
): UiHandlerDeps {
  const capability = bearerCapability(ctx);
  const composition =
    capability === undefined
      ? undefined
      : deps.reviewRuntime?.instanceForCapability(capability, audience);
  if (composition !== undefined) return composition.sidecarDeps(deps);
  const {
    runtimeCapabilityAuthenticator: _authenticator,
    openCodeGatewayReadinessRegistry: _readiness,
    toolFacadeBridge: _bridge,
    codingRuntimeOrchestrator: _orchestrator,
    codingRuntimeEventHub: _eventHub,
    codingSidecarGatewayCancellationRegistry: _cancellation,
    codingSidecarGatewayEvidenceAggregator: _evidence,
    ...withoutRuntime
  } = deps;
  return withoutRuntime;
}

export function handleReviewSidecarGatewayChatCompletions(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult | typeof STREAMING> {
  return handleCodingSidecarGatewayChatCompletions(
    ctx,
    reviewSidecarDeps(ctx, deps, "model-gateway"),
  );
}

export function handleReviewSidecarToolFacade(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): ReturnType<typeof handleCodingSidecarToolFacade> {
  return handleCodingSidecarToolFacade(ctx, reviewSidecarDeps(ctx, deps, "tool-facade"));
}
