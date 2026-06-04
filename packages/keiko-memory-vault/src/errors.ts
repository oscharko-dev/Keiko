// Typed error taxonomy for keiko-memory-vault. Stable string codes so callers in audit (#214),
// capture (#207), and the eventual UI (#211) can branch on `error.code` without parsing messages.
// Messages MUST NOT include raw paths, SQL fragments, or system error strings — those surface to
// downstream BFF envelopes that may log to disk.

export type MemoryStorageErrorCode =
  | "invalid-path"
  | "invalid-input"
  | "not-found"
  | "constraint-violation"
  | "schema-mismatch"
  | "internal";

export class MemoryStorageError extends Error {
  public readonly code: MemoryStorageErrorCode;

  public constructor(code: MemoryStorageErrorCode, message: string) {
    super(message);
    this.name = "MemoryStorageError";
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
    this.name = "MemoryStorageValidationError";
    this.failures = failures;
  }
}
