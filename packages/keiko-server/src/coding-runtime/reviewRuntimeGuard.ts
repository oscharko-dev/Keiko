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

/** The wire actions that read the reviewed head commit; a review run's read allowance counts them. */
export const REVIEW_RUN_READ_ACTIONS: ReadonlySet<CodingToolAction> = new Set<CodingToolAction>([
  "read",
  "discover",
  "search",
]);

/**
 * One Reviewer session's read allowance (ADR-0182 D1, Issue #4130). The session's task already
 * carries every changed hunk; the read tools only fetch surrounding code. A session that keeps
 * reading resends its whole conversation with every call and ends on its prompt allowance before
 * it reports, so the tool facade answers at most `maxCalls` read, discover and search calls and
 * refuses the rest with one fixed instruction to report and end.
 */
export interface ReviewReadAllowance {
  /** Counts one read call; `false` once the allowance is used up, and the call must not run. */
  readonly admit: () => boolean;
  readonly counts: () => ReviewReadCallCounts;
}

export interface ReviewReadCallCounts {
  /** Read calls the facade let through to its ordinary admission. */
  readonly admitted: number;
  /** Read calls refused because the allowance was used up. */
  readonly refused: number;
}

export function createReviewReadAllowance(maxCalls: number): ReviewReadAllowance {
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 0) {
    throw new TypeError("invalid review read allowance");
  }
  let admitted = 0;
  let refused = 0;
  return {
    admit: (): boolean => {
      if (admitted < maxCalls) {
        admitted += 1;
        return true;
      }
      refused = Math.min(Number.MAX_SAFE_INTEGER, refused + 1);
      return false;
    },
    counts: (): ReviewReadCallCounts => ({ admitted, refused }),
  };
}

/** What the Reviewer is told by a read tool once the allowance is used up. */
export const REVIEW_READ_ALLOWANCE_GUIDANCE =
  "This review's read allowance is used up, so no read, search or discover call is answered any more. Do not call these tools again. Report every finding you have confirmed with keiko_review_report, then end your turn with one short sentence.";

/**
 * Whether a review run's read allowance refuses this request. Only a review run with an allowance
 * is counted, and only its three read actions; `keiko_review_report` is never refused here.
 */
export function reviewReadAllowanceRefuses(
  purpose: CodingRuntimePurpose | undefined,
  request: Pick<CodingToolActionRequest, "action">,
  allowance: ReviewReadAllowance | undefined,
): boolean {
  if (purpose !== "review" || allowance === undefined) return false;
  if (!REVIEW_RUN_READ_ACTIONS.has(request.action)) return false;
  return !allowance.admit();
}
