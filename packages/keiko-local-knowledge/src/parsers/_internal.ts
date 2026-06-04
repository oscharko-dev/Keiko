// Shared helpers for the parser adapters (Epic #189, Issue #266). NOT exported from the
// package barrel — kept internal so the adapter surface stays minimal.

import type {
  DocumentId,
  ParsedUnit,
  ParserDiagnostic,
  ParserResult,
} from "@oscharko-dev/keiko-contracts";

import type { ParserCapability, ParserErrorCode, ParserOptions } from "./types.js";

export function emptyResult(
  capability: ParserCapability,
  documentId: DocumentId,
  options: ParserOptions,
  diagnostics: readonly ParserDiagnostic[] = [],
  units: readonly ParsedUnit[] = [],
): ParserResult {
  return {
    documentId,
    parser: { parserId: capability.parserId, parserVersion: capability.parserVersion },
    pages: [],
    sections: [],
    units,
    diagnostics,
    extractedAt: options.now(),
  };
}

export function diagnostic(
  code: ParserErrorCode,
  message: string,
  documentId: DocumentId,
  severity: ParserDiagnostic["severity"] = "info",
): ParserDiagnostic {
  return { severity, code, message, documentId };
}

// Returns true when the adapter must stop emitting units. Centralised so every adapter
// follows the same deadline + cancellation contract.
export interface LimitCheck {
  readonly stop: boolean;
  readonly code?: ParserErrorCode;
  readonly message?: string;
}

export function shouldStop(
  startedAt: number,
  options: ParserOptions,
  emittedUnits: number,
): LimitCheck {
  if (options.signal?.aborted === true) {
    return { stop: true, code: "PARSER_CANCELLED", message: "caller aborted parser" };
  }
  if (options.now() - startedAt > options.timeoutMs) {
    return {
      stop: true,
      code: "PARSER_TIMEOUT",
      message: `exceeded ${String(options.timeoutMs)}ms deadline`,
    };
  }
  if (emittedUnits >= options.maxUnitsPerDocument) {
    return {
      stop: true,
      code: "UNIT_LIMIT_REACHED",
      message: `reached maxUnitsPerDocument=${String(options.maxUnitsPerDocument)}`,
    };
  }
  return { stop: false };
}

export function oversizeDiagnostic(
  documentId: DocumentId,
  byteLength: number,
  maxBytes: number,
): ParserDiagnostic {
  return diagnostic(
    "OVERSIZED_FILE",
    `input size ${String(byteLength)} exceeds maxBytes=${String(maxBytes)}`,
    documentId,
    "info",
  );
}

// Decode bytes to a UTF-8 string. Centralised so every adapter handles BOM identically. A
// leading BOM is dropped from the returned string so subsequent character offsets line up
// with the visible text. The returned `bomBytes` lets adapters that need byte offsets keep
// their math correct.
export interface DecodedText {
  readonly text: string;
  readonly bomBytes: number;
}

export function decodeUtf8(bytes: Uint8Array): DecodedText {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const raw = decoder.decode(bytes);
  if (raw.length > 0 && raw.charCodeAt(0) === 0xfeff) {
    return { text: raw.slice(1), bomBytes: 3 };
  }
  return { text: raw, bomBytes: 0 };
}
