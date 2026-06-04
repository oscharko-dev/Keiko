// Public types for the parser registry + format adapters (Epic #189, Issue #266).
//
// Adapters are pure: `(input, options) -> ParserResult`. No FS, no clock beyond a single
// injected `now()`, no randomness, no new runtime deps (still `@oscharko-dev/keiko-contracts`
// only). The runtime layer at #194 reads bytes from disk and hands them to a parser; that
// keeps parsers trivially testable with synthetic strings.

import type {
  DocumentId,
  ParsedUnit,
  ParserDiagnostic,
  ParserResult,
} from "@oscharko-dev/keiko-contracts";

// ─── Limits + cancellation ───────────────────────────────────────────────────

export interface ParserOptions {
  // Refuse files larger than this with an `OVERSIZED_FILE` info-severity diagnostic. Default
  // 32 MiB applied by the registry; adapters never assume a default themselves.
  readonly maxBytes: number;
  // Truncate the unit stream with a `UNIT_LIMIT_REACHED` diagnostic. Default 50_000.
  readonly maxUnitsPerDocument: number;
  // Wall-clock deadline checked at unit emission boundaries. Default 30_000 ms.
  readonly timeoutMs: number;
  // Optional caller cancellation. Adapters check `signal.aborted` at the same boundaries as
  // the deadline so cancellation lands within one unit of work.
  readonly signal?: AbortSignal;
  // Injected clock so adapters stay testable. Returns epoch milliseconds. Defaults to
  // `Date.now` at the registry layer.
  readonly now: () => number;
}

export const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
export const DEFAULT_MAX_UNITS = 50_000;
export const DEFAULT_TIMEOUT_MS = 30_000;

// ─── Input + capability ──────────────────────────────────────────────────────

export interface ParserSelectionInput {
  readonly documentId: DocumentId;
  // The raw bytes. Adapters MUST NOT mutate this view.
  readonly bytes: Uint8Array;
  // Lowercase extension WITHOUT the leading dot (e.g. "csv", "md"). Empty string when the
  // caller does not know the extension; the registry then relies on `mediaType` and `bytes`.
  readonly extension: string;
  // RFC 6838 media type (lowercase). Empty when unknown. The registry treats both empty
  // strings as "no hint" without ever sniffing the filesystem.
  readonly mediaType: string;
  // Hint forwarded to a `text-like` parser so a `.py` file lands as `languageHint: "python"`.
  // Optional because callers may not classify; adapters set it when they themselves know.
  readonly languageHint?: string;
}

export interface ParserCapability {
  // Stable id stored on `ParserIdentity.parserId`. Hyphenated lowercase.
  readonly parserId: string;
  // Bumped when the adapter changes its unit-emission rules. Stored on
  // `ParserIdentity.parserVersion`.
  readonly parserVersion: string;
  // Pure predicate over the selection input. MUST NOT read the FS, MUST NOT mutate the
  // bytes. Returns true only when this adapter is willing to handle the document.
  readonly matches: (input: ParserSelectionInput) => boolean;
}

// ─── Adapter contract ────────────────────────────────────────────────────────

export interface ParserAdapter {
  readonly capability: ParserCapability;
  // Pure function. Returns a ParserResult even on internal failure — failure is conveyed via
  // ParserDiagnostic entries with `severity: "error"`, NEVER by throwing. Throwing would
  // break the registry contract (multiple adapters in a pipeline) and would leak crash
  // information to UI surfaces.
  readonly parse: (input: ParserSelectionInput, options: ParserOptions) => ParserResult;
}

// ─── Registry public surface ─────────────────────────────────────────────────

export interface ParserRegistry {
  readonly list: () => readonly ParserAdapter[];
  // Returns the first adapter whose `capability.matches` is true, scanned in registration
  // order. Returns the unsupported sentinel otherwise. Callers may then route to the
  // unsupported adapter to obtain the standard `unsupported-media` ParsedUnit.
  readonly resolve: (input: ParserSelectionInput) => ParserResolution;
}

export type ParserResolution =
  | { readonly kind: "matched"; readonly adapter: ParserAdapter }
  | { readonly kind: "unsupported"; readonly reason: string };

// ─── Error / diagnostic codes ────────────────────────────────────────────────

export type ParserErrorCode =
  | "OVERSIZED_FILE"
  | "UNIT_LIMIT_REACHED"
  | "PARSER_TIMEOUT"
  | "PARSER_CANCELLED"
  | "MALFORMED_INPUT"
  | "UNSUPPORTED_FORMAT";

export const PARSER_ERROR_CODES: readonly ParserErrorCode[] = [
  "OVERSIZED_FILE",
  "UNIT_LIMIT_REACHED",
  "PARSER_TIMEOUT",
  "PARSER_CANCELLED",
  "MALFORMED_INPUT",
  "UNSUPPORTED_FORMAT",
] as const;

// ─── Re-exports ──────────────────────────────────────────────────────────────
// Re-export the contract types adapters return so consumers can stay on a single import.
export type { ParserResult, ParsedUnit, ParserDiagnostic };
