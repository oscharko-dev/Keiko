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

import { redact } from "./redaction.js";

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

// Optional hook that recognises a domain error wrapping the underlying cause, so classification
// inspects that cause instead — e.g. keiko-local-knowledge recognises KnowledgeStoreError so the
// sealed SQLite error underneath is classified rather than the wrapper. Every recognised wrapper
// layer that carries a cause is peeled, down to the innermost cause. `undefined`/absent means
// "inspect the error as-is".
export type SqliteErrorWrapperGuard = (error: unknown) => error is Error;

function hasWrappedCause(
  error: unknown,
  isWrapper: SqliteErrorWrapperGuard | undefined,
): error is Error {
  return isWrapper !== undefined && isWrapper(error) && error.cause !== undefined;
}

export function sqliteErrorLike(
  error: unknown,
  isWrapper?: SqliteErrorWrapperGuard,
): SqliteErrorLike {
  if (hasWrappedCause(error, isWrapper)) return sqliteErrorLike(error.cause, isWrapper);
  return typeof error === "object" && error !== null ? error : {};
}

export function sqliteErrorText(error: unknown, isWrapper?: SqliteErrorWrapperGuard): string {
  const e = sqliteErrorLike(error, isWrapper);
  return [e.code, e.errstr, e.message].filter((value) => typeof value === "string").join(" ");
}

export function isSqliteCorruptionError(
  error: unknown,
  isWrapper?: SqliteErrorWrapperGuard,
): boolean {
  if (error instanceof SqliteQuickCheckError) return true;
  const e = sqliteErrorLike(error, isWrapper);
  if (e.errcode === 11 || e.errcode === 26) return true;
  return /\b(SQLITE_CORRUPT|SQLITE_NOTADB)\b|database disk image is malformed|file is not a database|not a database/i.test(
    sqliteErrorText(error, isWrapper),
  );
}

// ─── Persisted quarantine diagnostic ──────────────────────────────────────────
//
// `errorRecord` output is written VERBATIM to an on-disk `<db>.corrupt.<ts>.diagnostic.json` by all
// three stores (keiko-server/store/db, keiko-memory-vault/db, keiko-local-knowledge/store), so it is a
// persistence boundary, not a log line. It used to emit the raw `cause.message`, a wholesale
// `String(cause)` for non-Errors, and an unhardened `cause.name`:
//
//   * a SQLite/domain message legitimately embeds filesystem paths, SQL fragments and DSNs (a
//     connection string carries credentials), none of which belonged in a persisted artifact;
//   * `String(cause)` invokes a hostile value's own `toString`, which can return anything at all — or
//     throw, taking the quarantine write down with it;
//   * `Error.name` is a plain mutable own property, so request-derived text (or an oversized string)
//     could ride into the record as the "class".
//
// Every text field now passes through this package's `redact()` and a hard length cap, `.name` is
// admitted only in an identifier shape, and no foreign `toString` is ever called.
const MAX_ERROR_RECORD_TEXT_CHARS = 512;
const MAX_ERROR_CLASS_CHARS = 64;
const ERROR_CLASS_SHAPE = /^[A-Za-z][A-Za-z0-9_$]*$/;

// Truncation happens AFTER redaction: cutting first could split a secret so that no pattern matches
// the remaining prefix, and the point of the cap is size, not concealment.
//
// Exported so `log-port.ts`'s callers (`macos-keychain.ts`, `secret-vault.ts`) can bound an
// activity-log field with the exact same redaction and cap this module already applies to the
// persisted quarantine diagnostic, rather than growing a second copy [w4a-security-log-port].
export function boundedRedactedText(value: string): string {
  const redacted = redact(value);
  return redacted.length <= MAX_ERROR_RECORD_TEXT_CHARS
    ? redacted
    : `${redacted.slice(0, MAX_ERROR_RECORD_TEXT_CHARS)}…`;
}

// The one field `safeName` reads; it is untrusted until the shape check below passes.
interface ErrorNameField {
  readonly name?: unknown;
}

// Reflective reads over a thrown value are hostile-input reads: a getter or proxy trap may throw.
// Exported for the same reuse reason as `boundedRedactedText` above [w4a-security-log-port].
export function safeName(value: ErrorNameField): string | undefined {
  try {
    const name: unknown = "name" in value ? value.name : undefined;
    return typeof name === "string" ? name : undefined;
  } catch {
    return undefined;
  }
}

// The class label comes from code (a class declaration), never from request data — but only once it is
// shape- and length-checked, because `name` is writable. Anything else degrades to "Error".
//
// Exported so `secret-vault.ts`'s `readShardEnvelope` can classify an fs failure (EACCES, EISDIR,
// EIO) for `security.vault.shard-unreadable` with the same hardened classifier this module already
// uses for the persisted quarantine diagnostic [w4a-security-log-port].
export function hardenedErrorClass(cause: unknown): string {
  if (!(cause instanceof Error)) return typeof cause;
  const name = safeName(cause);
  if (name === undefined || name.length > MAX_ERROR_CLASS_CHARS || !ERROR_CLASS_SHAPE.test(name)) {
    return "Error";
  }
  return name;
}

// Text for the persisted `message` field. An Error's own message is redacted and capped; a primitive
// is rendered without consulting any foreign method; an object/function is NOT stringified at all
// (`String(value)` would run its `toString`), so it degrades to its `typeof`.
function hardenedMessage(cause: unknown): string {
  if (cause instanceof Error) return boundedRedactedText(cause.message);
  switch (typeof cause) {
    case "string":
      return boundedRedactedText(cause);
    case "number":
    case "boolean":
    case "bigint":
      return String(cause);
    case "undefined":
      return "undefined";
    default:
      return cause === null ? "null" : `[${typeof cause}]`;
  }
}

function boundedField(value: unknown): string | undefined {
  return typeof value === "string" ? boundedRedactedText(value) : undefined;
}

export function errorRecord(
  error: unknown,
  isWrapper?: SqliteErrorWrapperGuard,
): Record<string, unknown> {
  if (hasWrappedCause(error, isWrapper)) return errorRecord(error.cause, isWrapper);
  const e = sqliteErrorLike(error);
  return {
    errorClass: hardenedErrorClass(error),
    code: boundedField(e.code),
    errcode: typeof e.errcode === "number" ? e.errcode : undefined,
    errstr: boundedField(e.errstr),
    message: hardenedMessage(error),
  };
}
