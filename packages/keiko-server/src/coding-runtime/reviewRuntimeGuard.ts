// Layer 4 of the Keiko for Quality read-only guarantee (ADR-0182 D2, Issue #4135).
//
// A run that carries review authority may only read and report. The tool facade and the catalog
// bridge each consult this one predicate before anything else happens to a request, independently
// of the generated configuration (layer 1), the registered tool set (layer 2) and the authority
// port's action-class check (layer 3): no autonomy mode denies an effect today, it asks, so the
// review authority must refuse instead of asking. A refused request is denied without reaching
// the authority port, the catalog binder or a handler, and leaves one body-free line.
//
// The purpose these checks enforce is the composition's own: a runtime composed with the `review`
// tool profile hands every run's facade, catalog bridge and tool bridge the review purpose itself,
// independently of the minted context, so layer 4 still refuses when the authority (layer 3) is
// absent or wrong. The tool bridge additionally refuses its own native transports, which it
// dispatches before the facade sees a request: a review run needs none of them.

import type { CodingRuntimePurpose } from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";

import type { ServerLogSink } from "../observability/index.js";
import {
  logReviewActionRefused,
  type ReviewBridgeTransport,
  type ReviewRuntimeRefusalLayer,
} from "../review/runtime/activity-log.js";
import type { CodingToolAction, CodingToolActionRequest } from "./codingToolIpc.js";
import type { OpenCodeToolProfile } from "./opencodeToolSchemas.js";

/** The wire actions a review run may perform: the three reads and the report. */
export const REVIEW_RUN_ALLOWED_ACTIONS: ReadonlySet<CodingToolAction> = new Set<CodingToolAction>([
  "read",
  "discover",
  "search",
  "review-report",
]);

/** Whether a run of this purpose must refuse this request outright. */
export function reviewRunRefusesAction(
  purpose: CodingRuntimePurpose | undefined,
  request: Pick<CodingToolActionRequest, "action">,
): boolean {
  return purpose === "review" && !REVIEW_RUN_ALLOWED_ACTIONS.has(request.action);
}

/**
 * The guard as one call: `true` when the request is refused (and the refusal recorded), `false`
 * when the run may continue to its ordinary admission.
 */
export function refuseReviewRunAction(
  purpose: CodingRuntimePurpose | undefined,
  request: Pick<CodingToolActionRequest, "action">,
  layer: ReviewRuntimeRefusalLayer,
  log: { readonly sink: ServerLogSink; readonly correlationId: () => string | undefined },
): boolean {
  if (!reviewRunRefusesAction(purpose, request)) return false;
  logReviewActionRefused(log.sink, log.correlationId(), layer, request.action);
  return true;
}

/**
 * The purpose a composition hands its runs' facade and bridges: `review` whenever the composition
 * itself was built with the review tool profile, whatever the minted context says; otherwise the
 * minted context's own purpose, which leaves the Coding Workbench unchanged.
 */
export function composedRuntimePurpose(
  toolProfile: OpenCodeToolProfile,
  minted: CodingRuntimePurpose | undefined,
): CodingRuntimePurpose | undefined {
  return toolProfile === "review" ? "review" : minted;
}

/** The wire `action` of each native tool-bridge transport. */
const BRIDGE_TRANSPORT_ACTIONS: ReadonlyMap<string, ReviewBridgeTransport> = new Map([
  ["native-read-invocation", "native-read"],
  ["permission-request", "permission-request"],
  ["native-policy", "native-policy"],
  ["web-search", "native-web-search"],
]);

/** The native transport a tool-bridge body's `action` names, or `undefined` for any other. */
function reviewBridgeTransportOf(action: unknown): ReviewBridgeTransport | undefined {
  return typeof action === "string" ? BRIDGE_TRANSPORT_ACTIONS.get(action) : undefined;
}

/**
 * The tool bridge's guard: `true` when a review run's request `action` names a native transport (refused
 * and recorded), `false` when the request continues to the coding dispatch unchanged.
 */
export function refuseReviewBridgeTransport(
  purpose: CodingRuntimePurpose | undefined,
  action: unknown,
  log: { readonly sink: ServerLogSink; readonly correlationId: () => string | undefined },
): boolean {
  if (purpose !== "review") return false;
  const transport = reviewBridgeTransportOf(action);
  if (transport === undefined) return false;
  logReviewActionRefused(log.sink, log.correlationId(), "tool-bridge", transport);
  return true;
}
