// Typed launch rejections for the coding-runtime start path (KEIKO-0150, issue #2901).
//
// `CodingRuntimeLaunchResolver.resolve` returns launch material and has no failure arm, so a
// backend that refuses a request can only signal it by throwing. Before this module every such
// refusal was a bare `Error` carrying a hand-written message — `"opencode-backend-profile-mismatch"`,
// `"runtime-start-unconfirmed"`, a mint reason string — and the orchestrator caught all of them in
// one `catch {}` and reported the single generic `authority-resolution-failed`. A request rejected
// because its runtime profile does not match the adapter was therefore indistinguishable from one
// rejected because approval was missing, and the failure code the runtime manager already defines
// for that case (`adapter-profile-mismatch`) never reached the caller.
//
// This carries the structured code along with the throw so the classifier below can map it to the
// wire-facing failure code instead of collapsing it. Failures stay observable; nothing is swallowed.

import type { CodingWorkbenchRuntimeFailureCode } from "@oscharko-dev/keiko-contracts";
import type { CodingRuntimeFailureCode } from "./codingRuntimeManager.js";

/** A launch refused by a runtime backend, carrying the manager's structured failure code. */
export class CodingRuntimeLaunchRejectedError extends Error {
  public readonly failureCode: CodingRuntimeFailureCode;
  public readonly retryable: boolean;
  /**
   * #3565: the closed sub-reason behind the code (a sidecar unavailable reason, a preparation
   * state), so the diagnostic names WHICH check refused the start. A machine token only; anything
   * else is dropped rather than carried into an operator-visible string.
   */
  public readonly reason: string | undefined;

  public constructor(failureCode: CodingRuntimeFailureCode, retryable = false, reason?: string) {
    const closedReason =
      reason !== undefined && LAUNCH_REASON_TOKEN.test(reason) ? reason : undefined;
    // The message is the code (and the closed reason) itself: this class is diagnosed by
    // `failureCode`, and a free-text message would be one more place a runtime detail could leak
    // into an operator-visible string.
    super(closedReason === undefined ? failureCode : `${failureCode}:${closedReason}`);
    this.name = "CodingRuntimeLaunchRejectedError";
    this.failureCode = failureCode;
    this.retryable = retryable;
    this.reason = closedReason;
  }
}

const LAUNCH_REASON_TOKEN = /^[a-z0-9][a-z0-9-]{0,63}$/u;

export type CodingRuntimeLaunchResolutionFailureReason =
  | "codex-model-and-reasoning-unsupported"
  | "codex-model-selection-unsupported"
  | "codex-reasoning-effort-unsupported"
  | "managed-model-and-reasoning-unqualified"
  | "managed-model-unqualified"
  | "managed-reasoning-effort-unqualified";

/** A model/runtime selection rejected before runtime launch, carrying only a closed reason. */
export class CodingRuntimeLaunchResolutionError extends Error {
  public readonly reason: CodingRuntimeLaunchResolutionFailureReason;

  public constructor(reason: CodingRuntimeLaunchResolutionFailureReason) {
    super(reason);
    this.name = "CodingRuntimeLaunchResolutionError";
    this.reason = reason;
  }
}

/**
 * The closed diagnostic reason of a launch rejection: the structured code, suffixed with its closed
 * sub-reason when the rejection carries one, or the model-selection reason. Never free text.
 */
export function launchRejectionDiagnosticReason(error: unknown): string | undefined {
  if (error instanceof CodingRuntimeLaunchRejectedError) {
    return error.reason === undefined ? error.failureCode : `${error.failureCode}:${error.reason}`;
  }
  if (error instanceof CodingRuntimeLaunchResolutionError) return error.reason;
  return undefined;
}

// A backend rejects on runtimeSource/modelSource, which is precisely what `source-drift` already
// names everywhere else in this contract (see agentAuthorityRegistry's drift classification) — so
// the mismatch reuses that code rather than widening the wire union.
//
// #3565 Observation 17: the launch path threw bare Errors for a model the gateway does not admit,
// a repository path that is not canonical, a repository whose identity could not be read, and a
// missing runtime host — every one reached the customer as `authority-resolution-failed` (403)
// with no cause in the log. Each now carries its own code and maps to a wire code the Workbench
// can explain.
const LAUNCH_FAILURE_CODES: ReadonlyMap<
  CodingRuntimeFailureCode,
  CodingWorkbenchRuntimeFailureCode
> = new Map([
  ["adapter-profile-mismatch", "source-drift"],
  ["host-unavailable", "runtime-unavailable"],
  ["model-unavailable", "model-unavailable"],
  ["repository-unavailable", "workspace-unqualified"],
  ["workspace-unqualified", "workspace-unqualified"],
]);

/**
 * Maps a thrown launch rejection to the wire-facing failure code. Anything this module does not
 * recognize keeps the historical `authority-resolution-failed`: an unrecognized throw must not be
 * reported as a specific, wrong cause, and must never be reported as success.
 */
export function classifyLaunchRejection(error: unknown): CodingWorkbenchRuntimeFailureCode {
  if (!(error instanceof CodingRuntimeLaunchRejectedError)) return "authority-resolution-failed";
  return LAUNCH_FAILURE_CODES.get(error.failureCode) ?? "authority-resolution-failed";
}
