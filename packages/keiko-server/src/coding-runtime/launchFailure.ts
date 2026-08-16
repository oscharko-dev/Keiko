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

  public constructor(failureCode: CodingRuntimeFailureCode, retryable = false) {
    // The message is the code itself: this class is diagnosed by `failureCode`, and a free-text
    // message would be one more place a runtime detail could leak into an operator-visible string.
    super(failureCode);
    this.name = "CodingRuntimeLaunchRejectedError";
    this.failureCode = failureCode;
    this.retryable = retryable;
  }
}

// A backend rejects on runtimeSource/modelSource, which is precisely what `source-drift` already
// names everywhere else in this contract (see agentAuthorityRegistry's drift classification) — so
// the mismatch reuses that code rather than widening the wire union.
const LAUNCH_FAILURE_CODES: ReadonlyMap<
  CodingRuntimeFailureCode,
  CodingWorkbenchRuntimeFailureCode
> = new Map([["adapter-profile-mismatch", "source-drift"]]);

/**
 * Maps a thrown launch rejection to the wire-facing failure code. Anything this module does not
 * recognize keeps the historical `authority-resolution-failed`: an unrecognized throw must not be
 * reported as a specific, wrong cause, and must never be reported as success.
 */
export function classifyLaunchRejection(error: unknown): CodingWorkbenchRuntimeFailureCode {
  if (!(error instanceof CodingRuntimeLaunchRejectedError)) return "authority-resolution-failed";
  return LAUNCH_FAILURE_CODES.get(error.failureCode) ?? "authority-resolution-failed";
}
