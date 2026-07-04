// Shared SQLite corruption classifier [GEN-DUP-SEMANTIC-019 / GEN-DUP-NEAR-002 — PURE SUBSET ONLY].
// Three SQLite surfaces (keiko-memory-vault/store db, keiko-server/store db, keiko-local-knowledge
// store) each reimplemented the SAME pure, DatabaseSync-agnostic corruption-shape classification:
// the SqliteErrorLike shape, the SqliteQuickCheckError sentinel, and the four inspection helpers.
// Only that pure, no-fs / no-node:sqlite subset is hoisted here so the corruption vocabulary can
// never drift. The fs-bound recovery machinery (quarantine, assertQuickCheckOk, preparedDatabase,
// openXxx) stays per-package: those carry store-specific divergence (WAL sidecar snapshotting,
// diagnostic `store` tags, KnowledgeStoreError wrapping) and are intentionally NOT shared.
//
// This module MUST NOT import node:fs or node:sqlite — it operates purely over unknown/Error inputs.

// The subset of fields SQLite-family errors expose that we classify on. Copied verbatim from the
// per-store private copies.
export interface SqliteErrorLike {
  readonly code?: unknown;
  readonly errcode?: unknown;
  readonly errstr?: unknown;
  readonly message?: unknown;
}

// Raised when `PRAGMA quick_check` returns anything other than a single "ok" row. Recognised as a
// corruption signal by isSqliteCorruptionError. The per-store db-lifecycle modules construct and
// throw this from their own assertQuickCheckOk; it lives here so classification is self-contained.
export class SqliteQuickCheckError extends Error {
  public override readonly name = "SqliteQuickCheckError";
  public constructor(public readonly details: readonly string[]) {
    super(`SQLite quick_check failed: ${details.join("; ")}`);
  }
}

// Optional hook that lets a caller unwrap a domain error into the underlying cause BEFORE shape
// inspection — e.g. keiko-local-knowledge passes an unwrapper that resolves KnowledgeStoreError.cause
// so the sealed SQLite error underneath is classified rather than the wrapper. `undefined`/absent
// means "inspect the error as-is". The default is identity.
export type SqliteErrorUnwrap = (error: unknown) => unknown;

const IDENTITY_UNWRAP: SqliteErrorUnwrap = (error: unknown): unknown => error;

export function sqliteErrorLike(
  error: unknown,
  unwrap: SqliteErrorUnwrap = IDENTITY_UNWRAP,
): SqliteErrorLike {
  const unwrapped = unwrap(error);
  return typeof unwrapped === "object" && unwrapped !== null ? unwrapped : {};
}

export function sqliteErrorText(
  error: unknown,
  unwrap: SqliteErrorUnwrap = IDENTITY_UNWRAP,
): string {
  const e = sqliteErrorLike(error, unwrap);
  return [e.code, e.errstr, e.message].filter((value) => typeof value === "string").join(" ");
}

export function isSqliteCorruptionError(
  error: unknown,
  unwrap: SqliteErrorUnwrap = IDENTITY_UNWRAP,
): boolean {
  if (error instanceof SqliteQuickCheckError) return true;
  const e = sqliteErrorLike(error, unwrap);
  if (e.errcode === 11 || e.errcode === 26) return true;
  return /\b(SQLITE_CORRUPT|SQLITE_NOTADB)\b|database disk image is malformed|file is not a database|not a database/i.test(
    sqliteErrorText(error, unwrap),
  );
}

export function errorRecord(
  error: unknown,
  unwrap: SqliteErrorUnwrap = IDENTITY_UNWRAP,
): Record<string, unknown> {
  const cause = unwrap(error);
  const e = sqliteErrorLike(cause);
  return {
    errorClass: cause instanceof Error ? cause.name : typeof cause,
    code: typeof e.code === "string" ? e.code : undefined,
    errcode: typeof e.errcode === "number" ? e.errcode : undefined,
    errstr: typeof e.errstr === "string" ? e.errstr : undefined,
    message: cause instanceof Error ? cause.message : String(cause),
  };
}
