// Layer 4 of the Keiko for Quality read-only guarantee (ADR-0182 D2, Issue #4135).
//
// A run that carries review authority may only read and report. The tool facade and the catalog
// bridge each consult this one predicate before anything else happens to a request, independently
// of the generated configuration (layer 1), the registered tool set (layer 2) and the authority
// port's action-class check (layer 3): no autonomy mode denies an effect today, it asks, so the
// review authority must refuse instead of asking. A refused request is denied without reaching
// the authority port, the catalog binder or a handler, and leaves one body-free line.

import type { CodingRuntimePurpose } from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";

import type { ServerLogSink } from "../observability/index.js";
import {
  logReviewActionRefused,
  type ReviewRuntimeRefusalLayer,
} from "../review/runtime/activity-log.js";
import type { CodingToolAction, CodingToolActionRequest } from "./codingToolIpc.js";

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
