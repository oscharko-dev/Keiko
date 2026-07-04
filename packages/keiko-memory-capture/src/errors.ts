// Typed rejection taxonomy for keiko-memory-capture (Epic #204 child #207).
//
// Capture is the PRIMARY secret-rejection boundary; the rejection envelope NEVER carries the
// matched substring or pattern name, only a typed reason class. Callers can render a user-facing
// "this looked like a credential" without learning which pattern fired, which keeps the rejection
// path itself from leaking the candidate's content. The reason taxonomy is a closed string union
// so a UI surface can branch deterministically on `reason`.
//
// CaptureRejection is a THROWN error (reserved for programmer mistakes — user-input rejection is
// data-flow via CaptureOutcome, not exceptions), so it now extends the shared RedactingError base:
// its `.message` is scrubbed of secret shapes by construction, closing the fragmented-taxonomy and
// redaction-asymmetry gaps [GEN-MAINT-COUPLING-003/004]. The `reason` field is PRESERVED as the
// domain discriminator; `.code` mirrors it to satisfy the base's stable-code contract. The reason
// union stays LOCAL to this package.

import { RedactingError } from "@oscharko-dev/keiko-security/errors/base";

export type RejectionReason =
  | "credential-shape"
  | "private-credential-path"
  | "provider-base-url"
  | "raw-log-content"
  | "customer-identifier"
  | "empty-content"
  | "exceeds-length-limit"
  | "ambiguous-forget"
  | "ambiguous-update"
  // The restricted sensitivity class is rejected by default at this layer. A future per-policy
  // option could lift this; for #207 the contract is "restricted is unrepresentable from text".
  | "restricted-sensitivity"
  // Legacy/server-side hard rejection reason for surfaces that cannot offer a review queue.
  | "sensitive-memory-requires-approval"
  // The same canonical body was already forgotten in this scope. Suppress re-capture without
  // echoing the body back to the caller.
  | "suppressed-by-forget"
  // Inferred scope is null because the required coordinate is missing from the CaptureContext.
  // Returned in the rejection path rather than thrown so the caller can render a "please switch
  // to a project/workspace first" prompt.
  | "scope-not-resolvable";

// A capture-level error thrown only for programmer mistakes (e.g. handing an invalid scope hint
// to an internal helper). Rejection of user input is data-flow via CaptureOutcome `kind:"rejected"`,
// NOT exceptions — exceptions reserved for "this code path is unreachable in normal operation".
export class CaptureRejection extends RedactingError {
  public readonly reason: RejectionReason;

  public constructor(reason: RejectionReason, message: string) {
    super(message);
    this.reason = reason;
  }

  // Mirror `reason` under the base's stable-code contract so the whole memory taxonomy exposes a
  // uniform `.code` discriminator. `reason` stays the canonical name for existing callers.
  public override get code(): RejectionReason {
    return this.reason;
  }
}
