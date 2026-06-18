// Governed editor-session contracts (Issue #1197, Epic #1189). These shapes generalize the
// existing file read/write surface into editor-session metadata so the editor, deterministic
// diagnostics (#1198), and model-backed completion (#1199) can correlate "the content the user
// is editing" with "the content the server reasoned over" — without ever echoing file content.
//
// This module owns the editor-session / file-state contract namespace for the epic. It is kept
// disjoint from the language-service namespace (#1198): no name overlaps, no shared types.
//
// Leaf-package rules (ADR-0019): pure types and frozen const tables only. No filesystem, no
// clock, no crypto, no randomness, and no imports of other `@oscharko-dev/keiko-*` packages.
// The content-free `contentHash` is computed by producers (the BFF) with `node:crypto` and only
// inspected here as an opaque hex string.

// Schema version for the editor-session metadata envelope. Bump as a new string member when the
// shape changes incompatibly; consumers pin against the literal to detect skew.
export const EDITOR_SESSION_SCHEMA_VERSION = "1" as const;

// A content-free version of an editable document. `contentHash` is a one-way SHA-256 digest of
// the document's UTF-8 bytes — never the bytes themselves — so it is safe to cross the browser
// wire and to write to logs. Together the three fields identify an exact document revision.
export interface EditorDocumentVersion {
  readonly sizeBytes: number;
  readonly modifiedAt: number; // filesystem mtime, epoch milliseconds
  readonly contentHash: string; // lowercase hex SHA-256 of the UTF-8 content
}

// Content-free AI-provenance correlation. Populated by the diagnostics (#1198) and completion
// (#1199) surfaces, defined here so the editor-session metadata shape is stable now. Carries only
// correlation identifiers — never prompt text and never file content — to keep generated artifacts
// auditable end-to-end (EU AI Act, Regulation (EU) 2024/1689, Art. 12 record-keeping).
export interface EditorSessionAiProvenance {
  readonly modelId: string;
  readonly gatewayPolicyVersion: string;
  readonly promptHash: string; // content-free fingerprint of the prompt, not the prompt itself
  readonly requestId: string; // Model Gateway / BFF correlation id
}

// Editor-session metadata returned alongside editable file content. Lets a later completion or
// diagnostics request reference an exact, content-free document version.
export interface EditorDocumentSession {
  readonly schemaVersion: typeof EDITOR_SESSION_SCHEMA_VERSION;
  readonly version: EditorDocumentVersion;
  readonly aiProvenance?: EditorSessionAiProvenance;
}

// Stable error codes for the editor-session surface. These are the codes the editor relies on to
// drive recovery UX; the BFF emits them as static, content-free messages. The first four already
// exist on the file routes; `STALE_SESSION` is the version-aware conflict surfaced when a save is
// attempted against a document revision that no longer matches disk.
export type EditorSessionErrorCode =
  | "UNSUPPORTED_FILE"
  | "FILE_TOO_LARGE"
  | "WRITE_CONFLICT"
  | "DENIED"
  | "STALE_SESSION";

export const EDITOR_SESSION_ERROR_CODES: readonly EditorSessionErrorCode[] = [
  "UNSUPPORTED_FILE",
  "FILE_TOO_LARGE",
  "WRITE_CONFLICT",
  "DENIED",
  "STALE_SESSION",
] as const;

// ─── Pure validation (trust-boundary edge: the BFF validates a client-supplied baseVersion) ─────
// Result envelope follows the package convention: a discriminated `{ ok: true; value } | { ok:
// false; errors }` so branches stay throw-free and the error strings are deterministic.

export interface EditorSessionValidationOk<T> {
  readonly ok: true;
  readonly value: T;
}
export interface EditorSessionValidationFail {
  readonly ok: false;
  readonly errors: readonly string[];
}
export type EditorSessionValidation<T> = EditorSessionValidationOk<T> | EditorSessionValidationFail;

const SHA256_HEX = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// A byte count: a non-negative integer. Fractional byte counts can never match the filesystem
// `stats.size`, so they are rejected up front rather than silently yielding a stale-session 409.
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

// `modifiedAt` mirrors `stats.mtimeMs`, which carries sub-millisecond fractional precision, so it
// is validated as a finite non-negative number rather than an integer.
function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX.test(value);
}

// Strict structural guard. Unknown extra keys are tolerated (forward-compatible wire); the three
// required fields must be present with valid values.
export function isEditorDocumentVersion(value: unknown): value is EditorDocumentVersion {
  return (
    isRecord(value) &&
    isNonNegativeInteger(value.sizeBytes) &&
    isFiniteNonNegativeNumber(value.modifiedAt) &&
    isSha256Hex(value.contentHash)
  );
}

// Validates an `unknown` payload into an EditorDocumentVersion, reporting one error per failed
// invariant. The BFF uses this to reject a malformed client-supplied baseVersion with 400.
export function parseEditorDocumentVersion(
  value: unknown,
): EditorSessionValidation<EditorDocumentVersion> {
  if (!isRecord(value)) {
    return { ok: false, errors: ["baseVersion must be an object"] };
  }
  const errors: string[] = [];
  if (!isNonNegativeInteger(value.sizeBytes)) {
    errors.push("baseVersion.sizeBytes must be a non-negative integer");
  }
  if (!isFiniteNonNegativeNumber(value.modifiedAt)) {
    errors.push("baseVersion.modifiedAt must be a finite non-negative number");
  }
  if (!isSha256Hex(value.contentHash)) {
    errors.push("baseVersion.contentHash must be a lowercase hex SHA-256 string");
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      sizeBytes: value.sizeBytes as number,
      modifiedAt: value.modifiedAt as number,
      contentHash: value.contentHash as string,
    },
  };
}
