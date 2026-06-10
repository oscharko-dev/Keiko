// Pure helpers for the Local Knowledge Connector persistent schema (Epic #189, Issue
// #265). Split out from `local-knowledge-schema.ts` to keep both files under the 400-LOC
// budget. No `node:sqlite`, no fs, no clock — these helpers only inspect or rewrite
// strings the runtime (#193) reads from disk or surfaces to diagnostics.

import type { LocalKnowledgeValidation } from "./local-knowledge-validation.js";

// ─── Read-back row shape validator ───────────────────────────────────────────────
// Applied when loading a capsule row from sqlite. The shape mirrors the `capsules` table
// but uses the JS-side field names the runtime exposes (camelCase). Intentionally narrow
// — it pins the fields downstream consumers depend on, not every column.

export interface CapsuleRowShape {
  readonly id: string;
  readonly displayName: string;
  readonly vectorDimensions: number;
  readonly vectorMetric: string;
  readonly embeddingModelProvider: string;
  readonly embeddingModelId: string;
  readonly lifecycleState: string;
  readonly storageReference: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFinitePositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

// Field-check table keeps the per-field cyclomatic complexity inside the loop instead of
// the validator's signature. Adding a column to the row shape adds one row here, not one
// new `if` branch in `validateCapsuleRowShape`.
type RowFieldCheck = readonly [
  field: keyof CapsuleRowShape,
  guard: (value: unknown) => boolean,
  errorSuffix: string,
];

const NON_EMPTY_STRING_FIELDS: readonly RowFieldCheck[] = [
  ["id", isNonEmptyString, "must be a non-empty string"],
  ["displayName", isNonEmptyString, "must be a non-empty string"],
  ["vectorMetric", isNonEmptyString, "must be a non-empty string"],
  ["embeddingModelProvider", isNonEmptyString, "must be a non-empty string"],
  ["embeddingModelId", isNonEmptyString, "must be a non-empty string"],
  ["lifecycleState", isNonEmptyString, "must be a non-empty string"],
  ["storageReference", isNonEmptyString, "must be a non-empty string"],
];

const ROW_FIELD_CHECKS: readonly RowFieldCheck[] = [
  ...NON_EMPTY_STRING_FIELDS,
  ["vectorDimensions", isFinitePositiveInt, "must be a positive integer"],
  ["createdAt", isFiniteNonNegative, "must be a finite non-negative number"],
  ["updatedAt", isFiniteNonNegative, "must be a finite non-negative number"],
];

export function validateCapsuleRowShape(input: unknown): LocalKnowledgeValidation<CapsuleRowShape> {
  if (!isRecord(input)) {
    return { ok: false, errors: ["capsuleRow must be an object"] };
  }
  const errors: string[] = [];
  for (const [field, guard, errorSuffix] of ROW_FIELD_CHECKS) {
    if (!guard(input[field])) {
      errors.push(`capsuleRow.${field} ${errorSuffix}`);
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: input as unknown as CapsuleRowShape };
}

// ─── Diagnostic path redaction ───────────────────────────────────────────────────
// Used by parser-diagnostic and indexing-job error construction so raw filesystem paths
// cannot land in audit logs or UI surfaces. Pure: reads no environment, no fs, no clock.
// The HOME prefix is supplied by the caller (the runtime in #193 resolves it once at
// boot) so this helper stays deterministic and trivially testable.

const REDACTED_MAX_CHARS = 1024;

// Matches the ASCII control range; control chars in filenames are pathological and must
// not flow into UI strings unredacted. Disable the lint rule because the regex IS the
// gate.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

function stripControls(value: string): string {
  return value.replace(CONTROL_RE, "");
}

function normalizeSeparators(value: string): string {
  return value.replace(/\\/g, "/");
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return end === value.length ? value : value.slice(0, end);
}

function truncateAtNul(value: string): string {
  const nulAt = value.indexOf("\0");
  return nulAt === -1 ? value : value.slice(0, nulAt);
}

function replaceHomePrefix(value: string, homePrefix: string): string {
  // Normalize the homePrefix to forward-slash form first so the comparison succeeds whether
  // the caller supplies `/Users/foo`, `C:\\Users\\foo`, or any mix. Strip trailing slashes so
  // callers can pass either form. The empty-prefix gate short-circuits a caller-supplied "/".
  const normalizedPrefix = trimTrailingSlashes(normalizeSeparators(homePrefix));
  if (normalizedPrefix.length === 0) return value;
  if (value === normalizedPrefix) return "~";
  // Match the prefix followed by a separator; prevents `/Users/foobar` being misread as
  // `/Users/foo` + `bar`.
  if (value.startsWith(`${normalizedPrefix}/`)) {
    return `~${value.slice(normalizedPrefix.length)}`;
  }
  return value;
}

const WINDOWS_DRIVE_RE = /^[A-Za-z]:\/(.*)$/;

function replaceDrivePrefix(value: string): string {
  const match = WINDOWS_DRIVE_RE.exec(value);
  if (match === null) return value;
  return `<drive>/${match[1] ?? ""}`;
}

export interface RedactPathOptions {
  readonly homePrefix?: string;
}

// Public boundary helper. Order matters: separator normalisation runs BEFORE home-prefix
// rewriting so a Windows-style homePrefix (e.g. `C:\\Users\\foo`) compares cleanly against a
// Windows-style input. Drive-letter masking runs LAST so it only applies to inputs that did
// NOT match the user's home (otherwise a Windows home like `C:\\Users\\victim\\docs` would
// be rewritten to `<drive>/Users/victim/docs` and the home-prefix could never match — the
// #265 Copilot finding). Each step is idempotent so repeated calls return the same string.
export function redactPathInDiagnostic(rawPath: string, options: RedactPathOptions = {}): string {
  if (typeof rawPath !== "string") return "";
  const homePrefix = options.homePrefix ?? "";
  const afterNul = truncateAtNul(rawPath);
  const noControls = stripControls(afterNul);
  const normalized = normalizeSeparators(noControls);
  const homeRewritten = replaceHomePrefix(normalized, homePrefix);
  const driveRewritten = replaceDrivePrefix(homeRewritten);
  if (driveRewritten.length <= REDACTED_MAX_CHARS) return driveRewritten;
  return `${driveRewritten.slice(0, REDACTED_MAX_CHARS)}…`;
}
