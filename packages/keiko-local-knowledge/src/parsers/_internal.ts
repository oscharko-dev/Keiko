// Shared helpers for the parser adapters (Epic #189, Issue #266). NOT exported from the
// package barrel — kept internal so the adapter surface stays minimal.

import type {
  DocumentId,
  ParsedUnit,
  ParserDiagnostic,
  ParserIdentity,
  ParserResult,
} from "@oscharko-dev/keiko-contracts";

import { decodeXmlEntities } from "@oscharko-dev/keiko-workspace";
export { decodeXmlEntities } from "@oscharko-dev/keiko-workspace";

import {
  LOCAL_KNOWLEDGE_CSV_FILE_EXTENSIONS,
  LOCAL_KNOWLEDGE_JSON_FILE_EXTENSIONS,
  LOCAL_KNOWLEDGE_TEXT_FILE_EXTENSIONS,
  LOCAL_KNOWLEDGE_TSV_FILE_EXTENSIONS,
  LOCAL_KNOWLEDGE_WEB_DOCUMENT_FILE_EXTENSIONS,
} from "@oscharko-dev/keiko-contracts/runtime/local-knowledge-file-selection";

import { isEncryptedOoxmlContainer } from "./ooxml-zip.js";
import type {
  ParserCapability,
  ParserErrorCode,
  ParserOptions,
  ParserSelectionInput,
} from "./types.js";

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

// Reaching the unit cap drops the rest of the document from the index, which a reader must be able
// to see: it is a warning. A deadline or a cancellation is the caller's own decision and stays info.
export function limitSeverity(code: ParserErrorCode): ParserDiagnostic["severity"] {
  return code === "UNIT_LIMIT_REACHED" ? "warning" : "info";
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

/**
 * Refuses a password-protected Office file with the closed `ENCRYPTED_DOCUMENT` code and
 * format-level, content-free guidance; undefined when the bytes are not such a container. No text
 * is extracted from the file, and the message never carries a name, path or byte.
 */
export function encryptedOoxmlRefusal(
  capability: ParserCapability,
  input: ParserSelectionInput,
  options: ParserOptions,
  format: "docx" | "xlsx" | "pptx",
): ParserResult | undefined {
  if (!isEncryptedOoxmlContainer(input.bytes)) return undefined;
  return emptyResult(capability, input.documentId, options, [
    diagnostic(
      "ENCRYPTED_DOCUMENT",
      `${format} is password-protected; remove the password and reindex`,
      input.documentId,
      "error",
    ),
  ]);
}

// V8 cannot build a string longer than 0x1fffffe8 UTF-16 code units, and a decoded document has at
// most one code unit per byte. Above this size a text-like parser cannot hold the document at all
// (the engine throws "Cannot create a string longer than ..."), which no parser may do.
export const MAX_TEXT_DECODE_BYTES = 0x1fffffe8;

/**
 * The largest input a text-like parser decodes: the caller's `maxBytes`, never more than the engine
 * can hold as one string, and never more than the format's own `ceiling` (a parser whose
 * synchronous work on the event loop is not bounded by its unit cap bounds the input here).
 */
export function textByteLimit(
  options: ParserOptions,
  ceiling: number = MAX_TEXT_DECODE_BYTES,
): number {
  return Math.min(options.maxBytes, MAX_TEXT_DECODE_BYTES, ceiling);
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
  // Count of bytes that were not valid UTF-8 inside an otherwise UTF-8 document and were decoded as
  // windows-1252 one by one. Absent when nothing was repaired.
  readonly repairedBytes?: number;
  // The legacy codec the whole document was decoded with because it is not UTF-8 (absent for UTF-8
  // and UTF-16). A codec label, never document content.
  readonly fallbackCodec?: string;
}

type Utf16Codec = "utf-16le" | "utf-16be";

// GRD-012: detect UTF-16 LE/BE by BOM (common Windows .txt/.csv/.json exports) and re-decode
// with the matching codec. Without this they decode as UTF-8 mojibake (every other byte a NUL /
// replacement char) and are silently chunked/embedded as garbage. UTF-32 LE (FF FE 00 00) is
// explicitly excluded so it is not mis-read as UTF-16 LE.
function utf16CodecForBom(bytes: Uint8Array): Utf16Codec | undefined {
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
  const stripped = text.length > 0 && text.codePointAt(0) === 0xfeff ? text.slice(1) : text;
  return { text: stripped, bomBytes: 2 };
}

interface NulParityCounts {
  readonly evenNuls: number;
  readonly oddNuls: number;
  readonly evenTotal: number;
  readonly oddTotal: number;
}

// Counts NUL bytes at even vs. odd offsets over the first `sampleLength` bytes. UTF-16 text in
// the ASCII range has its NULs concentrated on one parity (the all-zero high byte of each code
// unit), which is what the caller uses to tell LE from BE apart without a BOM.
function sampleNulParity(bytes: Uint8Array, sampleLength: number): NulParityCounts {
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
  return { evenNuls, oddNuls, evenTotal, oddTotal };
}

// Turns NUL-byte ratios into a codec verdict: LE has NULs concentrated on odd offsets (the
// zero high byte follows the low byte), BE on even offsets. Below-threshold or ambiguous ratios
// return undefined so the caller falls back to another decode strategy.
function codecForNulRatios(
  evenRatio: number,
  oddRatio: number,
): "utf-16le" | "utf-16be" | undefined {
  if (oddRatio >= 0.3 && evenRatio <= 0.05) return "utf-16le";
  if (evenRatio >= 0.3 && oddRatio <= 0.05) return "utf-16be";
  return undefined;
}

function utf16CodecForNulPattern(bytes: Uint8Array): "utf-16le" | "utf-16be" | undefined {
  if (bytes.byteLength < 8) return undefined;
  const sampleLength = Math.min(bytes.byteLength, 4096);
  const { evenNuls, oddNuls, evenTotal, oddTotal } = sampleNulParity(bytes, sampleLength);
  const evenRatio = evenTotal === 0 ? 0 : evenNuls / evenTotal;
  const oddRatio = oddTotal === 0 ? 0 : oddNuls / oddTotal;
  return codecForNulRatios(evenRatio, oddRatio);
}

function decodeUtf16WithoutBom(bytes: Uint8Array): DecodedText | undefined {
  const codec = utf16CodecForNulPattern(bytes);
  if (codec === undefined) return undefined;
  const text = new TextDecoder(codec, { fatal: false }).decode(bytes);
  const stripped = text.length > 0 && text.codePointAt(0) === 0xfeff ? text.slice(1) : text;
  return { text: stripped, bomBytes: 0 };
}

function hasUtf8Bom(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
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

type ByteRange = readonly [number, number];

const UTF8_CONTINUATION: ByteRange = [0x80, 0xbf];

// Continuation-byte ranges per lead byte (RFC 3629 / Unicode Table 3-7): the restricted second byte
// of E0, ED, F0 and F4 rules out overlong forms, surrogates and code points beyond U+10FFFF.
const UTF8_CONTINUATIONS: ReadonlyMap<number, readonly ByteRange[]> = new Map(
  Array.from({ length: 0xf5 - 0xc2 }, (_, index): [number, readonly ByteRange[]] => {
    const lead = 0xc2 + index;
    const count = 1 + Number(lead > 0xdf) + Number(lead > 0xef);
    const ranges: ByteRange[] = Array.from({ length: count }, () => UTF8_CONTINUATION);
    if (lead === 0xe0) ranges[0] = [0xa0, 0xbf];
    if (lead === 0xed) ranges[0] = [0x80, 0x9f];
    if (lead === 0xf0) ranges[0] = [0x90, 0xbf];
    if (lead === 0xf4) ranges[0] = [0x80, 0x8f];
    return [lead, ranges];
  }),
);

// Length of the well-formed UTF-8 sequence that starts at `at`, or 0 when the bytes there are not
// one (stray continuation byte, truncated or overlong sequence, surrogate, beyond U+10FFFF).
function utf8SequenceLength(bytes: Uint8Array, at: number): number {
  const lead = bytes[at] ?? 0;
  if (lead < 0x80) return 1;
  const ranges = UTF8_CONTINUATIONS.get(lead);
  if (ranges === undefined) return 0;
  const fits = ranges.every(([low, high], index) => {
    const byte = bytes[at + 1 + index];
    return byte !== undefined && byte >= low && byte <= high;
  });
  return fits ? ranges.length + 1 : 0;
}

interface Utf8Survey {
  readonly multiByteSequences: number;
  readonly invalidBytes: number;
}

function surveyUtf8(bytes: Uint8Array): Utf8Survey {
  let multiByteSequences = 0;
  let invalidBytes = 0;
  let at = 0;
  while (at < bytes.length) {
    if ((bytes[at] ?? 0) < 0x80) {
      at += 1;
      continue;
    }
    const length = utf8SequenceLength(bytes, at);
    if (length === 0) {
      invalidBytes += 1;
      at += 1;
    } else {
      multiByteSequences += 1;
      at += length;
    }
  }
  return { multiByteSequences, invalidBytes };
}

// Decodes valid UTF-8 sequences as UTF-8 and every other byte as one windows-1252 character, so a
// single stray byte (a pasted Latin-1 fragment) cannot turn the whole document into mojibake.
function decodeUtf8WithRepair(bytes: Uint8Array): string {
  const utf8 = new TextDecoder("utf-8", { fatal: false });
  const latin = new TextDecoder("windows-1252", { fatal: false });
  const parts: string[] = [];
  let runStart = 0;
  let at = 0;
  while (at < bytes.length) {
    const length = (bytes[at] ?? 0) < 0x80 ? 1 : utf8SequenceLength(bytes, at);
    if (length > 0) {
      at += length;
      continue;
    }
    parts.push(utf8.decode(bytes.subarray(runStart, at)), latin.decode(bytes.subarray(at, at + 1)));
    at += 1;
    runStart = at;
  }
  parts.push(utf8.decode(bytes.subarray(runStart)));
  return parts.join("");
}

function isUtf8Family(label: string): boolean {
  const key = label.toLowerCase().replaceAll(/[^a-z0-9]/gu, "");
  return key === "utf8" || key === "unicode11utf8" || key === "unicodefeff";
}

// Last-resort decode when strict UTF-8 fails. A document that is mostly well-formed UTF-8 with a few
// stray bytes keeps its UTF-8 text and repairs only those bytes. Otherwise the whole file is legacy:
// a supported declared charset that is not itself UTF-8 wins (a UTF-8 label is contradicted by the
// bytes, so it cannot be the codec), else windows-1252.
function decodeFallbackBytes(bytes: Uint8Array, fallbackCharset?: string): DecodedBytes {
  const survey = surveyUtf8(bytes);
  if (survey.multiByteSequences > survey.invalidBytes) {
    return {
      text: decodeUtf8WithRepair(bytes),
      bomBytes: 0,
      codec: "utf-8+windows-1252",
      repairedBytes: survey.invalidBytes,
    };
  }
  if (fallbackCharset !== undefined && !isUtf8Family(fallbackCharset)) {
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
    if (raw.length > 0 && raw.codePointAt(0) === 0xfeff) {
      return { text: raw.slice(1), bomBytes: hasUtf8Bom(bytes) ? 3 : 0, codec: "utf-8" };
    }
    return { text: raw, bomBytes: 0, codec: "utf-8" };
  } catch {
    const fallback = decodeFallbackBytes(bytes, fallbackCharset);
    const text = fallback.text.codePointAt(0) === 0xfeff ? fallback.text.slice(1) : fallback.text;
    return { ...fallback, text };
  }
}

export function decodeUtf8(bytes: Uint8Array): DecodedText {
  const { text, bomBytes, repairedBytes, codec } = decodeBytes(bytes);
  const legacy =
    codec.startsWith("windows-") || codec.includes("+") ? { fallbackCodec: codec } : {};
  return { text, bomBytes, ...(repairedBytes === undefined ? {} : { repairedBytes }), ...legacy };
}

/**
 * The body-free fact that a document was not (entirely) UTF-8: a count of repaired stray bytes, or
 * the legacy codec label the whole file was decoded with. Undefined for UTF-8 and UTF-16.
 */
export function encodingDiagnostic(
  decoded: DecodedText,
  documentId: DocumentId,
): ParserDiagnostic | undefined {
  if (decoded.repairedBytes !== undefined) {
    return diagnostic(
      "ENCODING_REPAIRED",
      `${String(decoded.repairedBytes)} byte(s) were not valid UTF-8 and were decoded as windows-1252`,
      documentId,
      "warning",
    );
  }
  if (decoded.fallbackCodec === undefined) return undefined;
  return diagnostic(
    "ENCODING_REPAIRED",
    `bytes are not valid UTF-8; decoded as ${decoded.fallbackCodec}`,
    documentId,
    "info",
  );
}

// ─── Binary evidence ─────────────────────────────────────────────────────────

const KNOWN_TEXT_EXTENSIONS: ReadonlySet<string> = new Set<string>([
  ...LOCAL_KNOWLEDGE_TEXT_FILE_EXTENSIONS,
  ...LOCAL_KNOWLEDGE_JSON_FILE_EXTENSIONS,
  ...LOCAL_KNOWLEDGE_WEB_DOCUMENT_FILE_EXTENSIONS,
  ...LOCAL_KNOWLEDGE_CSV_FILE_EXTENSIONS,
  ...LOCAL_KNOWLEDGE_TSV_FILE_EXTENSIONS,
]);

/** Whether the extension (no leading dot) names a text, markup, data or configuration format. */
export function isKnownTextExtension(extension: string): boolean {
  return KNOWN_TEXT_EXTENSIONS.has(extension.toLowerCase());
}

function startsWithBytes(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return bytes.length >= prefix.length && prefix.every((value, index) => bytes[index] === value);
}

// DIB header sizes of the bitmap generations in use (BITMAPCOREHEADER … BITMAPV5HEADER).
const BMP_DIB_HEADER_SIZES: ReadonlySet<number> = new Set([12, 40, 52, 56, 64, 108, 124]);

// A bitmap is `BM`, a 4-byte file size, two reserved 16-bit fields that are zero, a 4-byte pixel
// offset and a DIB header whose first field is its own size. Two ASCII letters alone ("BMW …") are
// ordinary text.
function isBitmapHeader(bytes: Uint8Array): boolean {
  if (bytes.length < 18 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) return false;
  if (!bytes.subarray(6, 10).every((byte) => byte === 0)) return false;
  const dibSize = new DataView(bytes.buffer, bytes.byteOffset + 14, 4).getUint32(0, true);
  return BMP_DIB_HEADER_SIZES.has(dibSize);
}

function isGif(bytes: Uint8Array): boolean {
  // "GIF87a" / "GIF89a"
  return (
    startsWithBytes(bytes, [0x47, 0x49, 0x46, 0x38]) &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  );
}

function isWebp(bytes: Uint8Array): boolean {
  return (
    startsWithBytes(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    bytes.length >= 12 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  );
}

/**
 * Whether the leading bytes carry a complete raster-image signature (PNG, JPEG, GIF, bitmap, TIFF,
 * WebP). A signature is evidence only when it is long or structured enough that ordinary text cannot
 * produce it by chance.
 */
export function hasImageSignature(bytes: Uint8Array): boolean {
  return (
    startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) ||
    startsWithBytes(bytes, [0xff, 0xd8, 0xff]) ||
    isGif(bytes) ||
    isBitmapHeader(bytes) ||
    startsWithBytes(bytes, [0x49, 0x49, 0x2a, 0x00]) ||
    startsWithBytes(bytes, [0x4d, 0x4d, 0x00, 0x2a]) ||
    isWebp(bytes)
  );
}

export function hasPdfSignature(bytes: Uint8Array): boolean {
  return startsWithBytes(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]);
}

export function hasArchiveSignature(bytes: Uint8Array): boolean {
  return startsWithBytes(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWithBytes(bytes, [0x1f, 0x8b]);
}

/** The closed reason of the first container signature the bytes carry, if any. */
export function signatureReason(bytes: Uint8Array): string | undefined {
  if (hasPdfSignature(bytes)) return "pdf-not-implemented";
  if (hasArchiveSignature(bytes)) return "archive-not-decompressed";
  if (hasImageSignature(bytes)) return "image-not-supported";
  return undefined;
}

// Bytes inspected for NUL and control characters: enough to see a binary header, bounded so the
// check stays constant-time on a very large file.
const BINARY_SAMPLE_BYTES = 8192;
const BINARY_CONTROL_RATIO = 0.3;

function isBinaryControlByte(byte: number): boolean {
  // Tab, line feed, form feed, carriage return and escape occur in ordinary text and log files.
  if (byte === 0x09 || byte === 0x0a || byte === 0x0c || byte === 0x0d || byte === 0x1b)
    return false;
  return byte < 0x20;
}

/**
 * The closed reason a document is proven binary by its bytes, or undefined when it may be text:
 * a container or image signature, or a NUL byte (or mostly control bytes) at the start of content
 * that is not UTF-16 text. Never reads past the first {@link BINARY_SAMPLE_BYTES} bytes.
 */
export function binaryContentReason(bytes: Uint8Array): string | undefined {
  const signature = signatureReason(bytes);
  if (signature !== undefined) return signature;
  if (utf16CodecForBom(bytes) !== undefined || utf16CodecForNulPattern(bytes) !== undefined)
    return undefined;
  const sample = bytes.subarray(0, BINARY_SAMPLE_BYTES);
  if (sample.includes(0)) return "binary-not-supported";
  let controls = 0;
  for (const byte of sample) if (isBinaryControlByte(byte)) controls += 1;
  return sample.length > 0 && controls / sample.length > BINARY_CONTROL_RATIO
    ? "binary-not-supported"
    : undefined;
}

/**
 * The `unsupported-media` result a text-like parser returns for content its bytes prove is binary,
 * so a PNG or archive named `.txt` is never indexed as text. Same unit and closed code as the
 * unsupported sentinel; undefined when the bytes may be text.
 */
export function binaryContentRefusal(
  capability: ParserCapability,
  input: ParserSelectionInput,
  options: ParserOptions,
): ParserResult | undefined {
  const reason = binaryContentReason(input.bytes);
  if (reason === undefined) return undefined;
  return emptyResult(
    capability,
    input.documentId,
    options,
    [
      diagnostic(
        "UNSUPPORTED_FORMAT",
        `format not parseable in this build (${reason})`,
        input.documentId,
        "info",
      ),
    ],
    [{ kind: "unsupported-media", documentId: input.documentId, reason }],
  );
}

// Read a double- or single-quoted attribute value from ONE tag literal (bounded input), decoding
// entities. Operates on a single `<tag …>` string, never the whole document, so it does not
// participate in tag filtering and preserves the parser's CodeQL `js/bad-tag-filter` posture. The
// `name` argument is always a hard-coded literal at call sites, so the interpolation is safe.
export function readAttribute(tagRaw: string, name: string): string | undefined {
  const pattern = new RegExp(String.raw`(?:^|\s)${name}\s*=\s*(?:"([^"]*)"|'([^']*)')`, "iu");
  const match = pattern.exec(tagRaw);
  if (match === null) return undefined;
  const value = match[1] ?? match[2];
  return value === undefined ? undefined : decodeXmlEntities(value);
}
