import { Buffer, isUtf8 } from "node:buffer";
import { extname } from "node:path";
import { inflateSync } from "node:zlib";
import {
  extractBoundedDocumentText,
  readBoundedOoxmlPackage,
} from "@oscharko-dev/keiko-local-knowledge";
import { containsCredentialShape, redactCredentialShapes } from "@oscharko-dev/keiko-security";
import { decodeXmlEntities } from "@oscharko-dev/keiko-workspace";
import { markupText } from "./jiraAttachmentMarkupText.js";
import { readPdfSyntax, type PdfSyntax } from "./jiraAttachmentPdfSyntax.js";

/**
 * What may leave the machine as a Jira attachment (#4176). Secret exfiltration is a hard denial in
 * every mode, and an attachment skips the redaction every other egress path applies, so the bytes
 * themselves are classified and scanned with the same credential floor the redaction layer uses:
 *
 * - text (valid UTF-8, no NUL): the whole text is scanned;
 * - Word and Excel documents: their text is extracted with the Local Knowledge extractors and
 *   scanned, then the ZIP container's own bytes (archive comment, names, extra fields) are scanned,
 *   and every part of the package (comments, headers, footers, properties, embedded media, any other
 *   entry) is inflated and scanned as text, as the markup reader recovers it (entities decoded, tags
 *   removed) or checked as an image; a part that is neither, a part declaring an entity, or a
 *   package that cannot be read whole, is not scannable;
 * - PDF documents: the page text is extracted and scanned, the file's own bytes are scanned, the
 *   object syntax is read in one bounded pass (names and strings decoded, filters read from the
 *   stream's own dictionary), every decoded string is scanned, and every Flate stream (object
 *   streams, annotations, form values, metadata) is inflated and scanned; a JPEG stream gets the
 *   whole image admission; a stream under any other filter, a filter or structure the reader cannot
 *   interpret, an encrypted PDF and a PDF carrying an embedded file are not scannable;
 * - PNG and JPEG images, recognized by their signature: their raw bytes are scanned like text,
 *   their structure is walked to its end, and every compressed text carrier (zTXt, compressed
 *   iTXt, iCCP) is inflated and scanned; a chunk or segment outside the known set, a malformed
 *   structure or bytes after the image are not scannable;
 * - everything else (GIF, WebP, archives, databases, key stores, executables, unknown binary):
 *   refused.
 *
 * Configured secret literals are also searched in the raw bytes of every kind of file. The scan
 * finds credentials where a file naturally carries text; it does not claim to find a secret that
 * was deliberately encoded into pixel data or any other opaque representation.
 */
export type AttachmentContentVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly refusal: "unscannable" | "contains-credential" };

const ALLOWED: AttachmentContentVerdict = { ok: true };
const UNSCANNABLE: AttachmentContentVerdict = { ok: false, refusal: "unscannable" };
const CREDENTIAL: AttachmentContentVerdict = { ok: false, refusal: "contains-credential" };

// A literal shorter than this is an ordinary word, not a secret the redaction layer would mask.
const MIN_SECRET_LITERAL_BYTES = 8;
// Documents are parsed in process: bound the input, the extracted text and the time.
const DOCUMENT_MAX_INPUT_BYTES = 8 * 1024 * 1024;
const DOCUMENT_MAX_TEXT_BYTES = 4 * 1024 * 1024;
const DOCUMENT_MAX_UNITS = 100_000;
const DOCUMENT_TIMEOUT_MS = 15_000;
const PACKAGE_MAX_ENTRIES = 4096;

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  return signature.every((byte, index) => bytes[offset + index] === byte);
}
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
const GIF = [0x47, 0x49, 0x46, 0x38];
const RIFF = [0x52, 0x49, 0x46, 0x46];
const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d];
const ZIP = [0x50, 0x4b, 0x03, 0x04];

// Compressed parts are inflated within one budget per attachment, so a crafted file cannot make the
// scan unbounded.
const INFLATE_MAX_BYTES = 64 * 1024 * 1024;
interface InflateBudget {
  remaining: number;
}

interface InflateInfo {
  readonly buffer: Buffer;
  readonly engine: { readonly bytesWritten: number };
}
// With `info`, zlib also reports how much input it consumed; its declared return type omits that.
function isInflateInfo(value: unknown): value is InflateInfo {
  if (typeof value !== "object" || value === null) return false;
  const { buffer, engine } = value as Partial<Record<"buffer" | "engine", unknown>>;
  return (
    Buffer.isBuffer(buffer) &&
    typeof engine === "object" &&
    engine !== null &&
    typeof (engine as Partial<Record<"bytesWritten", unknown>>).bytesWritten === "number"
  );
}

/**
 * One zlib stream inflated within the remaining budget. Undefined when the data is not exactly one
 * zlib stream (a second stream or other bytes after its end would go unscanned) or is too large.
 */
function inflateBounded(data: Uint8Array, budget: InflateBudget): Buffer | undefined {
  if (budget.remaining <= 0) return undefined;
  let result: unknown;
  try {
    result = inflateSync(data, { maxOutputLength: budget.remaining, info: true });
  } catch {
    // Not a zlib stream, or larger than the budget: the caller refuses the file as unscannable.
    return undefined;
  }
  if (!isInflateInfo(result) || result.engine.bytesWritten !== data.length) return undefined;
  budget.remaining -= result.buffer.length;
  return result.buffer;
}

const PNG_CHUNKS_START = 8;
const PNG_CHUNK_OVERHEAD = 12; // length, type and checksum around the data
// Chunks whose data is image structure or uncompressed text the raw scan already reads.
const PNG_PLAIN_CHUNKS: ReadonlySet<string> = new Set([
  "IHDR",
  "PLTE",
  "IDAT",
  "tRNS",
  "cHRM",
  "gAMA",
  "sBIT",
  "sRGB",
  "cICP",
  "mDCV",
  "cLLI",
  "tEXt",
  "bKGD",
  "hIST",
  "pHYs",
  "sPLT",
  "eXIf",
  "tIME",
]);
// Apple's screenshot chunk: a fixed 28-byte layout.
const PNG_APPLE_IDOT_BYTES = 28;

/** The compressed payload after `keyword NUL method`, or undefined when the layout is wrong. */
function afterKeywordAndMethod(data: Uint8Array): Uint8Array | undefined {
  const keywordEnd = data.indexOf(0);
  if (keywordEnd < 1 || data[keywordEnd + 1] !== 0) return undefined;
  return data.subarray(keywordEnd + 2);
}

/** The compressed text of an iTXt chunk, an empty array for an uncompressed one, or undefined. */
function internationalText(data: Uint8Array): Uint8Array | undefined {
  const keywordEnd = data.indexOf(0);
  const flag = data[keywordEnd + 1];
  if (keywordEnd < 1 || (flag !== 0 && flag !== 1)) return undefined;
  if (flag === 0) return new Uint8Array(0);
  const language = data.indexOf(0, keywordEnd + 3);
  const translated = language < 0 ? -1 : data.indexOf(0, language + 1);
  return data[keywordEnd + 2] !== 0 || translated < 0 ? undefined : data.subarray(translated + 1);
}

/** What a PNG chunk contributes: nothing, a compressed text carrier, or undefined when refused. */
function pngChunkCarrier(type: string, data: Uint8Array): Uint8Array | undefined {
  if (PNG_PLAIN_CHUNKS.has(type)) return new Uint8Array(0);
  if (type === "iDOT") return data.length === PNG_APPLE_IDOT_BYTES ? new Uint8Array(0) : undefined;
  if (type === "zTXt" || type === "iCCP") return afterKeywordAndMethod(data);
  return type === "iTXt" ? internationalText(data) : undefined;
}

/** The compressed text carriers of a well-formed PNG, or undefined when it is not one. */
function pngCarriers(bytes: Uint8Array): readonly Uint8Array[] | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const carriers: Uint8Array[] = [];
  let position = PNG_CHUNKS_START;
  while (position + PNG_CHUNK_OVERHEAD <= bytes.length) {
    const length = view.getUint32(position);
    const end = position + PNG_CHUNK_OVERHEAD + length;
    if (end > bytes.length) return undefined;
    const type = Buffer.from(bytes.subarray(position + 4, position + 8)).toString("latin1");
    if (type === "IEND") return end === bytes.length ? carriers : undefined;
    const carrier = pngChunkCarrier(type, bytes.subarray(position + 8, position + 8 + length));
    if (carrier === undefined) return undefined;
    if (carrier.length > 0) carriers.push(carrier);
    position = end;
  }
  // No IEND reached: a truncated or malformed PNG cannot be vouched for.
  return undefined;
}

const JPEG_MARKER = 0xff;
const JPEG_EOI = 0xd9;
const JPEG_SOS = 0xda;
function isStandaloneJpegMarker(marker: number): boolean {
  return (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01;
}

/** The offset of the next marker after entropy-coded data, skipping stuffed bytes and restarts. */
function afterEntropyData(bytes: Uint8Array, start: number): number {
  for (let position = start; position + 1 < bytes.length; position += 1) {
    const next = bytes[position + 1] ?? 0;
    if (bytes[position] === JPEG_MARKER && next !== 0 && !isStandaloneJpegMarker(next)) {
      return position;
    }
  }
  return bytes.length;
}

/** The offset after one marker segment, or undefined when the segment is malformed. */
function afterJpegSegment(bytes: Uint8Array, position: number, marker: number): number | undefined {
  if (marker === JPEG_MARKER) return position + 1; // a fill byte before the marker
  if (isStandaloneJpegMarker(marker)) return position + 2;
  const length = ((bytes[position + 2] ?? 0) << 8) | (bytes[position + 3] ?? 0);
  if (length < 2 || position + 2 + length > bytes.length) return undefined;
  const end = position + 2 + length;
  return marker === JPEG_SOS ? afterEntropyData(bytes, end) : end;
}

/** A JPEG whose segments run from SOI to a final EOI with nothing between or after them. */
function isWellFormedJpeg(bytes: Uint8Array): boolean {
  let position = JPEG.length - 1; // the first marker after SOI
  while (position + 2 <= bytes.length) {
    if (bytes[position] !== JPEG_MARKER) return false;
    const marker = bytes[position + 1] ?? 0;
    if (marker === JPEG_EOI) return position + 2 === bytes.length;
    const next = afterJpegSegment(bytes, position, marker);
    if (next === undefined) return false;
    position = next;
  }
  return false;
}

function containsLiteral(bytes: Uint8Array, secrets: readonly string[]): boolean {
  const body = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
  return secrets.some(
    (secret) => Buffer.byteLength(secret) >= MIN_SECRET_LITERAL_BYTES && body.includes(secret),
  );
}

function holdsCredential(text: string, secrets: readonly string[]): boolean {
  return containsCredentialShape(text) || redactCredentialShapes(text, secrets) !== text;
}

/**
 * The shared credential floor: the same detectors the redaction layer applies to authorized content,
 * over the text as written and over what a reader of the markup recovers. An XML-escaped value
 * (`&amp;`, `&#x67;`) or a text run that tags split is not contiguous in the source, but it is the
 * credential once the document is opened.
 */
function textHoldsCredential(text: string, secrets: readonly string[]): boolean {
  if (holdsCredential(text, secrets)) return true;
  if (text.includes("&") && holdsCredential(decodeXmlEntities(text), secrets)) return true;
  return text.includes("<") && holdsCredential(markupText(text), secrets);
}

function latin1Of(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length).toString("latin1");
}

// Control characters other than tab, line breaks, form feed and escape (ANSI logs) mark binary data
// that happens to be valid UTF-8; such a file is not text Keiko can vouch for.
// eslint-disable-next-line no-control-regex -- the point is to find control characters.
const BINARY_CONTROL = /[\u0000-\u0008\u000e-\u001a\u001c-\u001f\u007f]/u;
function decodeText(bytes: Uint8Array): string | undefined {
  // Bytes that are not UTF-8 are not text Keiko can scan; the closed `unscannable` verdict follows.
  if (!isUtf8(bytes)) return undefined;
  const text = new TextDecoder("utf-8").decode(bytes);
  return BINARY_CONTROL.test(text) ? undefined : text;
}

function documentExtension(bytes: Uint8Array, name: string): "pdf" | "docx" | "xlsx" | undefined {
  if (startsWith(bytes, PDF)) return "pdf";
  if (!startsWith(bytes, ZIP)) return undefined;
  const extension = extname(name).slice(1).toLowerCase();
  return extension === "docx" || extension === "xlsx" ? extension : undefined;
}

async function extractedTextVerdict(
  bytes: Uint8Array,
  extension: "pdf" | "docx" | "xlsx",
  secrets: readonly string[],
  signal: AbortSignal | undefined,
): Promise<AttachmentContentVerdict> {
  const result = await extractBoundedDocumentText(
    // The parsers read the underlying buffer whole, so a view into a larger one is copied out.
    { bytes: Uint8Array.from(bytes), extension },
    {
      maxInputBytes: DOCUMENT_MAX_INPUT_BYTES,
      maxOutputBytes: DOCUMENT_MAX_TEXT_BYTES,
      maxUnits: DOCUMENT_MAX_UNITS,
      timeoutMs: DOCUMENT_TIMEOUT_MS,
      now: Date.now,
      ...(signal === undefined ? {} : { signal }),
    },
  );
  // Text that was clipped, absent or unreadable leaves part of the document unexamined.
  if (result.outcome !== "extracted" || result.truncated) return UNSCANNABLE;
  return textHoldsCredential(result.text, secrets) ? CREDENTIAL : ALLOWED;
}

/** One package part: text is scanned, a PNG or JPEG is checked as an image, anything else refused. */
function packagePartVerdict(
  part: Uint8Array,
  secrets: readonly string[],
  budget: InflateBudget,
): AttachmentContentVerdict {
  const text = decodeText(part);
  // A declared entity expands to text the scan cannot see in the source; OOXML has no use for one.
  if (text?.includes("<!ENTITY") === true) return UNSCANNABLE;
  if (text !== undefined) return textHoldsCredential(text, secrets) ? CREDENTIAL : ALLOWED;
  return imageVerdict(part, secrets, budget) ?? UNSCANNABLE;
}

/** Every part of an OOXML package, not only the parts the text extractor reads. */
async function packageVerdict(
  bytes: Uint8Array,
  secrets: readonly string[],
  budget: InflateBudget,
  signal: AbortSignal | undefined,
): Promise<AttachmentContentVerdict> {
  const read = await readBoundedOoxmlPackage(bytes, {
    maxInputBytes: DOCUMENT_MAX_INPUT_BYTES,
    maxEntries: PACKAGE_MAX_ENTRIES,
    maxInflatedBytes: INFLATE_MAX_BYTES,
    timeoutMs: DOCUMENT_TIMEOUT_MS,
    now: Date.now,
    ...(signal === undefined ? {} : { signal }),
  });
  if (!read.ok) return UNSCANNABLE;
  // The container carries text of its own (an archive comment, entry comments and names, extra
  // fields, bytes between entries) that is not any part's content.
  if (textHoldsCredential(latin1Of(bytes), secrets)) return CREDENTIAL;
  for (const part of read.parts.values()) {
    const verdict = packagePartVerdict(part, secrets, budget);
    if (!verdict.ok) return verdict;
  }
  return ALLOWED;
}

// A `stream` keyword the reader did not take for the start of a stream is a disagreement between
// this scan and a viewer that the scan cannot resolve.
const PDF_STREAM_KEYWORD = /(?<!end)stream\r?\n/gu;

function stringsHoldCredential(syntax: PdfSyntax, secrets: readonly string[]): boolean {
  const { stringText } = syntax;
  // Strings that a content stream splits (a TJ array) read as one run.
  return (
    textHoldsCredential(stringText, secrets) ||
    (stringText.includes("\n") && textHoldsCredential(stringText.replaceAll("\n", ""), secrets))
  );
}

/** A decoded stream: its text and the strings inside it, read as object syntax, are scanned. */
function decodedStreamVerdict(
  decoded: Uint8Array,
  secrets: readonly string[],
): AttachmentContentVerdict {
  const text = latin1Of(decoded);
  if (textHoldsCredential(text, secrets)) return CREDENTIAL;
  const syntax = readPdfSyntax(text, "inflated");
  if (syntax === undefined) return UNSCANNABLE;
  return stringsHoldCredential(syntax, secrets) ? CREDENTIAL : ALLOWED;
}

/** A JPEG carrier gets the whole image admission, whether it was inflated first or not. */
function jpegCarrierVerdict(
  data: Uint8Array,
  secrets: readonly string[],
  budget: InflateBudget,
): AttachmentContentVerdict {
  return startsWith(data, JPEG)
    ? (imageVerdict(data, secrets, budget) ?? UNSCANNABLE)
    : UNSCANNABLE;
}

/** A Flate stream, optionally holding a JPEG: inflated and scanned, or admitted as a whole image. */
function flateStreamVerdict(
  data: Uint8Array,
  inner: string | undefined,
  secrets: readonly string[],
  budget: InflateBudget,
): AttachmentContentVerdict {
  if (inner !== undefined && inner !== "DCTDecode") return UNSCANNABLE;
  const inflated = inflateBounded(data, budget);
  if (inflated === undefined) return UNSCANNABLE;
  if (inner === "DCTDecode") return jpegCarrierVerdict(inflated, secrets, budget);
  return decodedStreamVerdict(inflated, secrets);
}

/** One stream, by what its dictionary says: unfiltered and Flate are scanned, a JPEG admitted whole. */
function pdfStreamVerdict(
  data: Uint8Array,
  filters: readonly string[] | undefined,
  secrets: readonly string[],
  budget: InflateBudget,
): AttachmentContentVerdict {
  // A dictionary that does not state its filters readably (an indirect value) cannot be trusted.
  if (filters === undefined) return UNSCANNABLE;
  const [first, second, ...rest] = filters;
  if (first === undefined) return decodedStreamVerdict(data, secrets);
  if (rest.length > 0) return UNSCANNABLE;
  if (first === "FlateDecode") return flateStreamVerdict(data, second, secrets, budget);
  return first === "DCTDecode" && second === undefined
    ? jpegCarrierVerdict(data, secrets, budget)
    : UNSCANNABLE;
}

/** Whether every `stream` keyword in the file was read as the start of a stream. */
function streamsAccountedFor(raw: string, syntax: PdfSyntax): boolean {
  const spans = syntax.streams.map((stream) => [stream.keywordStart, stream.end] as const);
  return [...raw.matchAll(PDF_STREAM_KEYWORD)].every((match) =>
    spans.some(([from, to]) => match.index >= from && match.index <= to),
  );
}

/** Names that make a PDF unscannable: encryption, and attached files with a payload of their own. */
function hasUnscannableName(names: ReadonlySet<string>): boolean {
  return [...names].some((name) => name === "Encrypt" || name.startsWith("EmbeddedFile"));
}

/** The file's own bytes, its decoded strings and every stream; an unreadable structure is refused. */
function pdfBytesVerdict(
  bytes: Uint8Array,
  secrets: readonly string[],
  budget: InflateBudget,
): AttachmentContentVerdict {
  const raw = latin1Of(bytes);
  if (textHoldsCredential(raw, secrets)) return CREDENTIAL;
  const syntax = readPdfSyntax(raw, "file");
  if (raw.includes("/Encrypt") || raw.includes("/EmbeddedFile")) return UNSCANNABLE;
  // Names are compared decoded as well: `/Encr#79pt` is `/Encrypt`.
  if (syntax === undefined || hasUnscannableName(syntax.names)) return UNSCANNABLE;
  if (!streamsAccountedFor(raw, syntax)) return UNSCANNABLE;
  if (stringsHoldCredential(syntax, secrets)) return CREDENTIAL;
  for (const stream of syntax.streams) {
    const data = bytes.subarray(stream.start, stream.end);
    const verdict = pdfStreamVerdict(data, stream.filters, secrets, budget);
    if (!verdict.ok) return verdict;
  }
  return ALLOWED;
}

async function documentVerdict(
  bytes: Uint8Array,
  extension: "pdf" | "docx" | "xlsx",
  secrets: readonly string[],
  signal: AbortSignal | undefined,
): Promise<AttachmentContentVerdict> {
  const text = await extractedTextVerdict(bytes, extension, secrets, signal);
  if (!text.ok) return text;
  const budget: InflateBudget = { remaining: INFLATE_MAX_BYTES };
  return extension === "pdf"
    ? pdfBytesVerdict(bytes, secrets, budget)
    : packageVerdict(bytes, secrets, budget, signal);
}

/** Text carriers inflated and scanned; a carrier that does not inflate is not scannable. */
function inflatedCarriersVerdict(
  carriers: readonly Uint8Array[],
  secrets: readonly string[],
  budget: InflateBudget,
): AttachmentContentVerdict {
  for (const carrier of carriers) {
    const inflated = inflateBounded(carrier, budget);
    if (inflated === undefined) return UNSCANNABLE;
    if (textHoldsCredential(inflated.toString("latin1"), secrets)) return CREDENTIAL;
  }
  return ALLOWED;
}

/**
 * A PNG or JPEG: its raw bytes are scanned like text, its structure must end where the image does,
 * and a PNG's compressed text carriers are inflated and scanned. Other images are not scannable.
 */
function imageVerdict(
  bytes: Uint8Array,
  secrets: readonly string[],
  budget: InflateBudget,
): AttachmentContentVerdict | undefined {
  const png = startsWith(bytes, PNG);
  if (!png && !startsWith(bytes, JPEG)) return undefined;
  if (textHoldsCredential(latin1Of(bytes), secrets)) return CREDENTIAL;
  if (!png) return isWellFormedJpeg(bytes) ? ALLOWED : UNSCANNABLE;
  const carriers = pngCarriers(bytes);
  return carriers === undefined ? UNSCANNABLE : inflatedCarriersVerdict(carriers, secrets, budget);
}

/** Classify the bytes and refuse a credential or anything that cannot be scanned. */
export async function admitAttachmentContent(input: {
  readonly bytes: Uint8Array;
  /** The attachment name; only its extension disambiguates an OOXML package from another archive. */
  readonly name: string;
  readonly secrets: readonly string[];
  readonly signal?: AbortSignal;
}): Promise<AttachmentContentVerdict> {
  const { bytes, name, secrets, signal } = input;
  if (containsLiteral(bytes, secrets)) return CREDENTIAL;
  const image = imageVerdict(bytes, secrets, { remaining: INFLATE_MAX_BYTES });
  if (image !== undefined) return image;
  // GIF and WebP (RIFF) images carry compressed data whose structure Keiko does not walk.
  if (startsWith(bytes, GIF) || startsWith(bytes, RIFF)) return UNSCANNABLE;
  const extension = documentExtension(bytes, name);
  if (extension !== undefined) return documentVerdict(bytes, extension, secrets, signal);
  const text = decodeText(bytes);
  if (text === undefined || startsWith(bytes, ZIP)) return UNSCANNABLE;
  return textHoldsCredential(text, secrets) ? CREDENTIAL : ALLOWED;
}
