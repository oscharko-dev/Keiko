// Typed error taxonomy for keiko-memory-vault. Stable string codes so callers in audit (#214),
// capture (#207), and the eventual UI (#211) can branch on `error.code` without parsing messages.
// Messages MUST NOT include raw paths, SQL fragments, or system error strings — those surface to
// downstream BFF envelopes that may log to disk. Redaction is now enforced by construction: the
// shared RedactingError base scrubs every message (and any caller-supplied secrets) so a leaked
// path or credential can never reach `.message` even if a call-site forgets to sanitise
// [GEN-MAINT-COUPLING-003/004]. The per-domain code union stays LOCAL to this package.

import { RedactingError } from "@oscharko-dev/keiko-security/errors/base";

export type MemoryStorageErrorCode =
  | "invalid-path"
  | "invalid-input"
  | "not-found"
  | "constraint-violation"
  | "schema-mismatch"
  | "internal";

export class MemoryStorageError extends RedactingError {
  public readonly code: MemoryStorageErrorCode;

  public constructor(
    code: MemoryStorageErrorCode,
    message: string,
    secrets: readonly string[] = [],
  ) {
    super(message, secrets);
    this.code = code;
  }
}

// Carries the structured failure list from a contract validator so the caller can render every
// reason at once instead of one-by-one. The validator's own message is preserved verbatim in
// `.message`; the `.failures` array is the machine-readable surface.
export interface MemoryStorageValidationFailure {
  readonly path: readonly string[];
  readonly message: string;
}

export class MemoryStorageValidationError extends MemoryStorageError {
  public readonly failures: readonly MemoryStorageValidationFailure[];

  public constructor(message: string, failures: readonly MemoryStorageValidationFailure[]) {
    super("invalid-input", message);
    this.failures = failures;
  }
}
