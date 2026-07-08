// Epic #1941 — native OS file/folder dialog contracts (ADR-0118).
//
// Browser-safe, additive wire contracts for the local BFF native-dialog route
// (`POST /api/native-file-dialog/open`). The browser may REQUEST a native picker and render the
// typed result; it never executes OS commands and never decides filesystem authority. Selected
// paths cross this wire only AFTER the BFF has validated them (absolute shape, NUL rejection,
// existence, kind, realpath, deny-list) — the contract carries no raw adapter output, no stderr,
// and no error text derived from filesystem content.
//
// Design (see ADR-0118):
//   * The mode set is closed: `open-file`, `open-files`, `open-directory`. There is no save mode,
//     no executable field, no argv, no script text — the contract cannot express command execution.
//   * Every user-controlled request field is bounded and validated fail-closed BEFORE it reaches a
//     platform adapter. Values are passed to adapters as stdin JSON only, never as command text.
//   * Validation errors name the offending FIELD, never echo the offending VALUE, so a hostile
//     title or path can not tunnel into logs, diagnostics, or evidence through an error message.
//   * Cancellation is a normal user outcome (`cancelled: true`), not an error.

import { stripUnsafeFormatChars } from "./text-safety.js";

export const NATIVE_FILE_DIALOG_SCHEMA_VERSION = "1" as const;

// ─── Modes and selections ─────────────────────────────────────────────────────────

export const NATIVE_FILE_DIALOG_MODES = ["open-file", "open-files", "open-directory"] as const;

export type NativeFileDialogMode = (typeof NATIVE_FILE_DIALOG_MODES)[number];

export type NativeFileDialogSelectionKind = "file" | "directory";

// One extension-group filter shown by the native dialog (e.g. name "Images", extensions
// ["png", "jpg"]). Extensions are normalized lowercase without a leading dot. Filters only make
// sense for file modes; the server ignores them for `open-directory`.
export interface NativeFileDialogFilter {
  readonly name: string;
  readonly extensions: readonly string[];
}

export interface NativeFileDialogRequest {
  readonly mode: NativeFileDialogMode;
  // Optional dialog prompt. Stripped of bidi/zero-width/control characters so a request cannot
  // spoof the native dialog chrome, then length-bounded.
  readonly title?: string;
  // Optional starting location HINT. The server only forwards it to the adapter when it exists and
  // is a directory; it is never trusted as a selection and never echoed into errors.
  readonly defaultPath?: string;
  readonly filters?: readonly NativeFileDialogFilter[];
}

export interface NativeFileDialogSelection {
  // Absolute local path, validated by the BFF (absolute shape, NUL-free, existing, realpath).
  readonly path: string;
  readonly kind: NativeFileDialogSelectionKind;
}

export interface NativeFileDialogResponse {
  // True when the user dismissed the native dialog. A cancelled response never carries selections
  // and must not be rendered as a failure.
  readonly cancelled: boolean;
  readonly selections: readonly NativeFileDialogSelection[];
}

// `GET /api/native-file-dialog/capability` — whether the BFF host platform has a native adapter.
// The SERVER platform decides (it opens the dialog); the UI must not infer support from
// user-agent sniffing. Unsupported platforms keep manual path entry as the fallback.
export interface NativeFileDialogCapability {
  readonly supported: boolean;
}

// ─── Stable error codes ───────────────────────────────────────────────────────────

// Closed set of browser-visible error codes for the native-dialog route. The UI owns the human
// copy; it never renders raw adapter/stderr text.
export const NATIVE_FILE_DIALOG_ERROR_CODES = [
  // Platform has no native adapter (e.g. Linux) or the adapter binary is unavailable. The UI keeps
  // manual path entry available as the fallback.
  "NATIVE_DIALOG_UNSUPPORTED",
  // A native dialog is already open for this BFF process (route-level single flight).
  "NATIVE_DIALOG_ALREADY_OPEN",
  // The dialog process exceeded the server-side interaction budget and was terminated.
  "NATIVE_DIALOG_TIMEOUT",
  // The adapter process failed (non-zero exit, malformed/oversized output, spawn failure).
  "NATIVE_DIALOG_FAILED",
  // The adapter returned paths the BFF refused (wrong count, wrong kind, missing, denied, relative,
  // or NUL-containing).
  "NATIVE_DIALOG_INVALID_SELECTION",
] as const;

export type NativeFileDialogErrorCode = (typeof NATIVE_FILE_DIALOG_ERROR_CODES)[number];

// ─── Request bounds ───────────────────────────────────────────────────────────────

export const NATIVE_FILE_DIALOG_TITLE_MAX_LENGTH = 120 as const;
export const NATIVE_FILE_DIALOG_DEFAULT_PATH_MAX_LENGTH = 4096 as const;
export const NATIVE_FILE_DIALOG_MAX_FILTERS = 8 as const;
export const NATIVE_FILE_DIALOG_FILTER_NAME_MAX_LENGTH = 64 as const;
export const NATIVE_FILE_DIALOG_MAX_EXTENSIONS_PER_FILTER = 24 as const;
// Upper bound on selections a single `open-files` response may carry; the server enforces the same
// cap against adapter output before validation work begins.
export const NATIVE_FILE_DIALOG_MAX_SELECTIONS = 200 as const;

// Lowercase extension without a leading dot: `png`, `tar.gz`, `d.ts`. Single character class with
// no nested quantifiers — linear-time, no backtracking.
const EXTENSION_PATTERN = /^[a-z0-9][a-z0-9.+_-]{0,15}$/u;

// ─── Request validation ───────────────────────────────────────────────────────────

export type NativeFileDialogRequestValidation =
  | { readonly ok: true; readonly value: NativeFileDialogRequest }
  | { readonly ok: false; readonly error: string };

type FieldResult<T> =
  { readonly ok: true; readonly value?: T } | { readonly ok: false; readonly error: string };

const MODE_SET: ReadonlySet<string> = new Set(NATIVE_FILE_DIALOG_MODES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTitle(value: unknown): FieldResult<string> {
  if (value === undefined) return { ok: true };
  if (typeof value !== "string") return { ok: false, error: "title must be a string" };
  const cleaned = stripUnsafeFormatChars(value).trim();
  if (cleaned.length === 0) return { ok: true };
  if (cleaned.length > NATIVE_FILE_DIALOG_TITLE_MAX_LENGTH) {
    return { ok: false, error: "title is too long" };
  }
  return { ok: true, value: cleaned };
}

function parseDefaultPath(value: unknown): FieldResult<string> {
  if (value === undefined) return { ok: true };
  if (typeof value !== "string") return { ok: false, error: "defaultPath must be a string" };
  const trimmed = value.trim();
  if (trimmed.length === 0) return { ok: true };
  if (trimmed.length > NATIVE_FILE_DIALOG_DEFAULT_PATH_MAX_LENGTH) {
    return { ok: false, error: "defaultPath is too long" };
  }
  // NUL is rejected (not stripped): a NUL-bearing path is hostile input, and the hint would
  // otherwise silently change meaning at the OS boundary.
  if (trimmed.includes("\0")) return { ok: false, error: "defaultPath must not contain NUL" };
  return { ok: true, value: trimmed };
}

function parseFilterName(value: unknown, index: number): FieldResult<string> {
  if (typeof value !== "string") {
    return { ok: false, error: `filters[${String(index)}].name must be a string` };
  }
  const cleaned = stripUnsafeFormatChars(value).trim();
  if (cleaned.length === 0) {
    return { ok: false, error: `filters[${String(index)}].name is required` };
  }
  if (cleaned.length > NATIVE_FILE_DIALOG_FILTER_NAME_MAX_LENGTH) {
    return { ok: false, error: `filters[${String(index)}].name is too long` };
  }
  return { ok: true, value: cleaned };
}

function parseExtensions(value: unknown, index: number): FieldResult<readonly string[]> {
  if (!Array.isArray(value)) {
    return { ok: false, error: `filters[${String(index)}].extensions must be an array` };
  }
  if (value.length === 0 || value.length > NATIVE_FILE_DIALOG_MAX_EXTENSIONS_PER_FILTER) {
    return { ok: false, error: `filters[${String(index)}].extensions has invalid size` };
  }
  const extensions: string[] = [];
  for (const [extensionIndex, raw] of value.entries()) {
    const field = `filters[${String(index)}].extensions[${String(extensionIndex)}]`;
    if (typeof raw !== "string") return { ok: false, error: `${field} must be a string` };
    const normalized = raw.trim().replace(/^\./u, "").toLowerCase();
    if (!EXTENSION_PATTERN.test(normalized)) return { ok: false, error: `${field} is invalid` };
    extensions.push(normalized);
  }
  return { ok: true, value: extensions };
}

function parseFilter(item: unknown, index: number): FieldResult<NativeFileDialogFilter> {
  if (!isRecord(item)) return { ok: false, error: `filters[${String(index)}] must be an object` };
  const name = parseFilterName(item.name, index);
  if (!name.ok) return name;
  const extensions = parseExtensions(item.extensions, index);
  if (!extensions.ok) return extensions;
  // name.value / extensions.value are always present here: parseFilterName and parseExtensions
  // never return ok without a value for a provided field.
  if (name.value === undefined || extensions.value === undefined) {
    return { ok: false, error: `filters[${String(index)}] is invalid` };
  }
  return { ok: true, value: { name: name.value, extensions: extensions.value } };
}

function parseFilters(value: unknown): FieldResult<readonly NativeFileDialogFilter[]> {
  if (value === undefined) return { ok: true };
  if (!Array.isArray(value)) return { ok: false, error: "filters must be an array" };
  if (value.length === 0) return { ok: true };
  if (value.length > NATIVE_FILE_DIALOG_MAX_FILTERS) {
    return { ok: false, error: "filters contains too many entries" };
  }
  const filters: NativeFileDialogFilter[] = [];
  for (const [index, item] of value.entries()) {
    const filter = parseFilter(item, index);
    if (!filter.ok) return filter;
    if (filter.value !== undefined) filters.push(filter.value);
  }
  return { ok: true, value: filters };
}

function parseMode(
  value: unknown,
):
  | { readonly ok: true; readonly value: NativeFileDialogMode }
  | { readonly ok: false; readonly error: string } {
  if (typeof value !== "string" || !MODE_SET.has(value)) {
    return { ok: false, error: "mode is invalid" };
  }
  return { ok: true, value: value as NativeFileDialogMode };
}

// Fail-closed request validation for the BFF route. Unknown modes, oversized fields, malformed
// filters, and NUL-bearing paths are rejected with a field-naming (never value-echoing) error.
export function validateNativeFileDialogRequest(input: unknown): NativeFileDialogRequestValidation {
  if (!isRecord(input)) return { ok: false, error: "request must be an object" };
  const mode = parseMode(input.mode);
  if (!mode.ok) return mode;
  const title = parseTitle(input.title);
  if (!title.ok) return title;
  const defaultPath = parseDefaultPath(input.defaultPath);
  if (!defaultPath.ok) return defaultPath;
  const filters = parseFilters(input.filters);
  if (!filters.ok) return filters;
  return {
    ok: true,
    value: {
      mode: mode.value,
      ...(title.value !== undefined ? { title: title.value } : {}),
      ...(defaultPath.value !== undefined ? { defaultPath: defaultPath.value } : {}),
      ...(filters.value !== undefined && filters.value.length > 0
        ? { filters: filters.value }
        : {}),
    },
  };
}

// Expected selection count for a mode, enforced by the server against adapter output:
// exactly one for single-selection modes, 1..NATIVE_FILE_DIALOG_MAX_SELECTIONS for `open-files`.
export function nativeFileDialogSelectionBounds(mode: NativeFileDialogMode): {
  readonly min: number;
  readonly max: number;
} {
  if (mode === "open-files") return { min: 1, max: NATIVE_FILE_DIALOG_MAX_SELECTIONS };
  return { min: 1, max: 1 };
}

// Expected selection kind for a mode ("file" for both file modes, "directory" for the folder
// mode) — shared by server-side kind validation and UI result handling.
export function nativeFileDialogExpectedKind(
  mode: NativeFileDialogMode,
): NativeFileDialogSelectionKind {
  return mode === "open-directory" ? "directory" : "file";
}
