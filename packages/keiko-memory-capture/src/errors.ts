// Typed rejection taxonomy for keiko-memory-capture (Epic #204 child #207).
//
// Capture is the PRIMARY secret-rejection boundary; the rejection envelope NEVER carries the
// matched substring or pattern name, only a typed reason class. Callers can render a user-facing
// "this looked like a credential" without learning which pattern fired, which keeps the rejection
// path itself from leaking the candidate's content. The reason taxonomy is a closed string union
// so a UI surface can branch deterministically on `reason`.

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
  // Server persistence cannot durably write non-public candidates until an explicit approval
  // surface exists. The capture layer can still classify them; the BFF/storage boundary blocks
  // the write with this typed reason.
  | "sensitive-memory-requires-approval"
  // Inferred scope is null because the required coordinate is missing from the CaptureContext.
  // Returned in the rejection path rather than thrown so the caller can render a "please switch
  // to a project/workspace first" prompt.
  | "scope-not-resolvable";

// A capture-level error thrown only for programmer mistakes (e.g. handing an invalid scope hint
// to an internal helper). Rejection of user input is data-flow via CaptureOutcome `kind:"rejected"`,
// NOT exceptions — exceptions reserved for "this code path is unreachable in normal operation".
export class CaptureRejection extends Error {
  public readonly reason: RejectionReason;

  public constructor(reason: RejectionReason, message: string) {
    super(message);
    this.name = "CaptureRejection";
    this.reason = reason;
  }
}
