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
function boundedRedactedText(value: string): string {
  const redacted = redact(value);
  return redacted.length <= MAX_ERROR_RECORD_TEXT_CHARS
    ? redacted
    : `${redacted.slice(0, MAX_ERROR_RECORD_TEXT_CHARS)}…`;
}

// Reflective reads over a thrown value are hostile-input reads: a getter or proxy trap may throw.
function safeName(value: object): string | undefined {
  try {
    const name: unknown = Reflect.get(value, "name");
    return typeof name === "string" ? name : undefined;
  } catch {
    return undefined;
  }
}

// The class label comes from code (a class declaration), never from request data — but only once it is
// shape- and length-checked, because `name` is writable. Anything else degrades to "Error".
function hardenedErrorClass(cause: unknown): string {
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
  unwrap: SqliteErrorUnwrap = IDENTITY_UNWRAP,
): Record<string, unknown> {
  const cause = unwrap(error);
  const e = sqliteErrorLike(cause);
  return {
    errorClass: hardenedErrorClass(cause),
    code: boundedField(e.code),
    errcode: typeof e.errcode === "number" ? e.errcode : undefined,
    errstr: boundedField(e.errstr),
    message: hardenedMessage(cause),
  };
}
