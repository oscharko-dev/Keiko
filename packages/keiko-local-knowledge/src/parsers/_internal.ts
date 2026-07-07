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

// eslint-disable-next-line complexity
function utf16CodecForNulPattern(bytes: Uint8Array): "utf-16le" | "utf-16be" | undefined {
  if (bytes.byteLength < 8) return undefined;
  const sampleLength = Math.min(bytes.byteLength, 4096);
  let evenNuls = 0;
  let oddNuls = 0;
  let evenTotal = 0;
  let oddTotal = 0;
  for (let i = 0; i < sampleLength; i += 1) {
    if (i % 2 === 0) {
      evenTotal += 1;
      if (bytes[i] === 0x00) evenNuls += 1;
    } else {
      oddTotal += 1;
      if (bytes[i] === 0x00) oddNuls += 1;
    }
  }
  const evenRatio = evenTotal === 0 ? 0 : evenNuls / evenTotal;
  const oddRatio = oddTotal === 0 ? 0 : oddNuls / oddTotal;
  if (oddRatio >= 0.3 && evenRatio <= 0.05) return "utf-16le";
  if (evenRatio >= 0.3 && oddRatio <= 0.05) return "utf-16be";
  return undefined;
}

function decodeUtf16WithoutBom(bytes: Uint8Array): DecodedText | undefined {
  const codec = utf16CodecForNulPattern(bytes);
  if (codec === undefined) return undefined;
  const text = new TextDecoder(codec, { fatal: false }).decode(bytes);
  const stripped = text.length > 0 && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return { text: stripped, bomBytes: 0 };
}

function hasUtf8Bom(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
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

// Full decode result that also reports which codec was used. An HTML adapter cross-checks the
// declared `<meta charset>` against `codec` to emit a predictable mismatch diagnostic instead of
// silently corrupting the manual (#1855). `codec` is a byte-shape decision, not document content.
export interface DecodedBytes extends DecodedText {
  readonly codec: string;
}

// A TextDecoder for `label`, or undefined when the runtime does not support the label (the
// constructor throws on unknown encodings). Used so a declared charset can only ever replace the
// last-resort fallback with an encoding that actually exists.
function decoderFor(label: string): TextDecoder | undefined {
  try {
    return new TextDecoder(label, { fatal: false });
  } catch {
    return undefined;
  }
}

function decodeUtf16Bytes(bytes: Uint8Array): DecodedBytes | undefined {
  const bomCodec = utf16CodecForBom(bytes);
  if (bomCodec !== undefined) {
    const utf16 = decodeUtf16(bytes);
    if (utf16 !== undefined) return { ...utf16, codec: bomCodec };
  }
  const nulCodec = utf16CodecForNulPattern(bytes);
  if (nulCodec !== undefined) {
    const utf16 = decodeUtf16WithoutBom(bytes);
    if (utf16 !== undefined) return { ...utf16, codec: nulCodec };
  }
  return undefined;
}

// Last-resort decode when strict UTF-8 fails: honor a supported declared charset, else windows-1252.
function decodeFallbackBytes(bytes: Uint8Array, fallbackCharset?: string): DecodedBytes {
  if (fallbackCharset !== undefined) {
    const fallback = decoderFor(fallbackCharset);
    if (fallback !== undefined) {
      return { text: fallback.decode(bytes), bomBytes: 0, codec: fallbackCharset };
    }
  }
  return {
    text: new TextDecoder("windows-1252", { fatal: false }).decode(bytes),
    bomBytes: 0,
    codec: "windows-1252",
  };
}

// Byte-shape-authoritative decode. BOM and strict UTF-8 always win (a valid-UTF-8 body is UTF-8
// regardless of a mis-declared charset). `fallbackCharset` replaces the windows-1252 last resort
// ONLY when strict UTF-8 fails and the label is one the runtime supports — so a genuine
// windows-1252/shift_jis manual decodes with the declared codec instead of mojibake.
export function decodeBytes(bytes: Uint8Array, fallbackCharset?: string): DecodedBytes {
  const utf16 = decodeUtf16Bytes(bytes);
  if (utf16 !== undefined) return utf16;
  try {
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (raw.length > 0 && raw.charCodeAt(0) === 0xfeff) {
      return { text: raw.slice(1), bomBytes: hasUtf8Bom(bytes) ? 3 : 0, codec: "utf-8" };
    }
    return { text: raw, bomBytes: 0, codec: "utf-8" };
  } catch {
    return decodeFallbackBytes(bytes, fallbackCharset);
  }
}

export function decodeUtf8(bytes: Uint8Array): DecodedText {
  const { text, bomBytes } = decodeBytes(bytes);
  return { text, bomBytes };
}

// Read a double- or single-quoted attribute value from ONE tag literal (bounded input), decoding
// entities. Operates on a single `<tag …>` string, never the whole document, so it does not
// participate in tag filtering and preserves the parser's CodeQL `js/bad-tag-filter` posture. The
// `name` argument is always a hard-coded literal at call sites, so the interpolation is safe.
export function readAttribute(tagRaw: string, name: string): string | undefined {
  const pattern = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "iu");
  const match = pattern.exec(tagRaw);
  if (match === null) return undefined;
  const value = match[1] ?? match[2];
  return value === undefined ? undefined : decodeXmlEntities(value);
}
