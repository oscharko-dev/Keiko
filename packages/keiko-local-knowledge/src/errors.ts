// Typed errors for the local-knowledge runtime. All store APIs raise these so callers can
// distinguish path violations (caller bug) from missing rows (expected miss) from internal
// SQLite failures (corrupted state) without string-sniffing the message.

export class KnowledgeStoreError extends Error {
  public override readonly name: string = "KnowledgeStoreError";
  public constructor(message: string, options?: { readonly cause?: unknown }) {
    // Forward `cause` only when present so we preserve the original stack from a wrapped
    // SQLite/IO error without polluting the message of the higher-level error.
    super(message, options);
  }
}

// Raised by store-paths.ts for any input that would let the resolved on-disk path escape the
// caller-provided runtime-state directory. Distinct from KnowledgeStoreError so a test for
// "path containment fail-closed" cannot accidentally accept any other error class.
export class KnowledgePathError extends KnowledgeStoreError {
  public override readonly name: string = "KnowledgePathError";
}

// Raised when a CRUD API targets a row that does not exist. Distinct so that retry/idempotency
// logic can branch on missing-row without catching unrelated failures.
export class KnowledgeNotFoundError extends KnowledgeStoreError {
  public override readonly name: string = "KnowledgeNotFoundError";
}
