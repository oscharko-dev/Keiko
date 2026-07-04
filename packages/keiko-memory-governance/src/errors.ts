// GovernanceError — the single error class every public builder throws. The discriminator
// is the `code` property; downstream callers branch on the code rather than reading the
// message string. Redaction is enforced by construction via the shared RedactingError base:
// the composed `GovernanceError(code): message` prefix and any embedded detail (memory UUIDs,
// selector input) are scrubbed of secret shapes before they can reach `.message`
// [GEN-MAINT-COUPLING-003/004]. The per-domain code union stays LOCAL to this package.

import { RedactingError } from "@oscharko-dev/keiko-security/errors/base";

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

export class GovernanceError extends RedactingError {
  public readonly code: GovernanceErrorCode;
  public readonly details?: readonly string[];

  public constructor(code: GovernanceErrorCode, message: string, details?: readonly string[]) {
    super(`GovernanceError(${code}): ${message}`);
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }
}
