// GovernanceError — the single error class every public builder throws. The discriminator
// is the `code` property; downstream callers branch on the code rather than reading the
// message string.

export type GovernanceErrorCode =
  | "envelope-validation-failed"
  | "illegal-status-transition"
  | "invalid-resolution"
  | "invalid-threshold"
  | "invalid-validity-window"
  | "idempotent-noop"
  | "unsupported-selector"
  | "invalid-selector-input"
  | "memory-not-eligible";

export class GovernanceError extends Error {
  public readonly code: GovernanceErrorCode;
  public readonly details?: readonly string[];

  public constructor(code: GovernanceErrorCode, message: string, details?: readonly string[]) {
    super(`GovernanceError(${code}): ${message}`);
    this.name = "GovernanceError";
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }
}
