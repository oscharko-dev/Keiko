// Shared helpers for the parser adapters (Epic #189, Issue #266). NOT exported from the
// package barrel — kept internal so the adapter surface stays minimal.

import type {
  DocumentId,
  ParsedUnit,
  ParserDiagnostic,
  ParserIdentity,
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
    parser: parserIdentity(capability),
    pages: [],
    sections: [],
    units,
    diagnostics,
    extractedAt: options.now(),
  };
}

export function parserIdentity(capability: ParserCapability): ParserIdentity {
  return capability.dependencyVersions === undefined
    ? { parserId: capability.parserId, parserVersion: capability.parserVersion }
    : {
        parserId: capability.parserId,
        parserVersion: capability.parserVersion,
        dependencyVersions: capability.dependencyVersions,
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

export function objectLimitDiagnostic(
  documentId: DocumentId,
  maxObjectsPerDocument: number,
): ParserDiagnostic {
  return diagnostic(
    "OBJECT_LIMIT_REACHED",
    `reached maxObjectsPerDocument=${String(maxObjectsPerDocument)}`,
    documentId,
    "error",
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

// GRD-012: detect UTF-16 LE/BE by BOM (common Windows .txt/.csv/.json exports) and re-decode
// with the matching codec. Without this they decode as UTF-8 mojibake (every other byte a NUL /
// replacement char) and are silently chunked/embedded as garbage. UTF-32 LE (FF FE 00 00) is
// explicitly excluded so it is not mis-read as UTF-16 LE.
function utf16CodecForBom(bytes: Uint8Array): "utf-16le" | "utf-16be" | undefined {
  if (bytes.byteLength < 2) return undefined;
  const b0 = bytes[0];
  const b1 = bytes[1];
  if (b0 === 0xfe && b1 === 0xff) return "utf-16be";
  if (b0 !== 0xff || b1 !== 0xfe) return undefined;
  // FF FE is UTF-16 LE — unless it is the UTF-32 LE BOM (FF FE 00 00), which is not handled here.
  const isUtf32Le = bytes.byteLength >= 4 && bytes[2] === 0x00 && bytes[3] === 0x00;
  return isUtf32Le ? undefined : "utf-16le";
}

function decodeUtf16(bytes: Uint8Array): DecodedText | undefined {
  const codec = utf16CodecForBom(bytes);
  if (codec === undefined) return undefined;
  const text = new TextDecoder(codec, { fatal: false }).decode(bytes);
  // The 2-byte UTF-16 BOM is normally consumed by TextDecoder; strip defensively so a leading
  // U+FEFF never survives into offsets. bomBytes is the consumed BOM byte length (2).
  const stripped = text.length > 0 && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return { text: stripped, bomBytes: 2 };
}

// GRD-027: decode an XML numeric character reference body (the part between `&#` and `;`),
// e.g. "8217" (decimal) or "xE9" / "x2019" (hex). Returns undefined for malformed or
// out-of-range references (incl. surrogates) so the caller leaves the literal text intact —
// String.fromCodePoint throws on those, which must never crash the parser.
// Valid Unicode scalar value: in range and not a lone surrogate (String.fromCodePoint throws
// on surrogates / out-of-range).
function isValidScalarCodePoint(cp: number): boolean {
  if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff) return false;
  return cp < 0xd800 || cp > 0xdfff;
}

function decodeNumericCharacterReference(body: string): string | undefined {
  const isHex = body.startsWith("x") || body.startsWith("X");
  const digits = isHex ? body.slice(1) : body;
  if (digits.length === 0) return undefined;
  if (!(isHex ? /^[0-9a-fA-F]+$/ : /^[0-9]+$/).test(digits)) return undefined;
  const codePoint = Number.parseInt(digits, isHex ? 16 : 10);
  return isValidScalarCodePoint(codePoint) ? String.fromCodePoint(codePoint) : undefined;
}

// Shared OOXML/HTML entity decoder for docx/xlsx text runs. Decodes numeric references first
// (decimal `&#8217;` and hex `&#xE9;` — smart quotes, accents), then the five named refs, with
// `&amp;` LAST so an escaped ampersand (`&amp;#65;`) is not re-interpreted as a numeric ref.
export function decodeXmlEntities(value: string): string {
  const withNumeric = value.replace(
    /&#(x?[0-9a-fA-F]+);/g,
    (match: string, body: string): string => decodeNumericCharacterReference(body) ?? match,
  );
  return withNumeric
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

export function decodeUtf8(bytes: Uint8Array): DecodedText {
  const utf16 = decodeUtf16(bytes);
  if (utf16 !== undefined) return utf16;
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const raw = decoder.decode(bytes);
  if (raw.length > 0 && raw.charCodeAt(0) === 0xfeff) {
    return { text: raw.slice(1), bomBytes: 3 };
  }
  return { text: raw, bomBytes: 0 };
}
