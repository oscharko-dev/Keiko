import { Buffer, isUtf8 } from "node:buffer";
import { extname } from "node:path";
import { extractBoundedDocumentText } from "@oscharko-dev/keiko-local-knowledge";
import { containsCredentialShape, redactCredentialShapes } from "@oscharko-dev/keiko-security";

/**
 * What may leave the machine as a Jira attachment (#4176). Secret exfiltration is a hard denial in
 * every mode, and an attachment skips the redaction every other egress path applies, so the bytes
 * themselves are classified and scanned with the same credential floor the redaction layer uses:
 *
 * - text (valid UTF-8, no NUL): the whole text is scanned;
 * - PDF, Word and Excel documents: their text is extracted with the Local Knowledge extractors and
 *   scanned; a document whose text cannot be extracted completely is not scannable;
 * - PNG, JPEG, GIF and WebP images, recognized by their signature: allowed only when nothing hides
 *   in them — their raw bytes are scanned like text (a metadata chunk, a comment or EXIF segment, or
 *   data appended after the image is where a polyglot carries a secret), and a PNG with bytes after
 *   IEND or a JPEG with bytes after its final EOI is refused, since trailing data has no lawful
 *   use in an attachment;
 * - everything else (archives, databases, key stores, executables, unknown binary): refused.
 *
 * Configured secret literals are also searched in the raw bytes of every kind of file.
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

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  return signature.every((byte, index) => bytes[offset + index] === byte);
}
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
const GIF_87 = [0x47, 0x49, 0x46, 0x38, 0x37, 0x61];
const GIF_89 = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];
const RIFF = [0x52, 0x49, 0x46, 0x46];
const WEBP = [0x57, 0x45, 0x42, 0x50];
const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d];
const ZIP = [0x50, 0x4b, 0x03, 0x04];

function isImage(bytes: Uint8Array): boolean {
  return (
    startsWith(bytes, PNG) ||
    startsWith(bytes, JPEG) ||
    startsWith(bytes, GIF_87) ||
    startsWith(bytes, GIF_89) ||
    (startsWith(bytes, RIFF) && startsWith(bytes, WEBP, 8))
  );
}

const PNG_CHUNKS_START = 8;
const PNG_CHUNK_OVERHEAD = 12; // length, type and checksum around the data
function pngHasTrailingData(bytes: Uint8Array): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  let position = PNG_CHUNKS_START;
  while (position + PNG_CHUNK_OVERHEAD <= bytes.length) {
    const end = position + PNG_CHUNK_OVERHEAD + view.getUint32(position);
    const type = Buffer.from(bytes.subarray(position + 4, position + 8)).toString("latin1");
    if (type === "IEND") return end !== bytes.length;
    position = end;
  }
  // No IEND reached: a truncated or malformed PNG cannot be vouched for.
  return true;
}
function jpegHasTrailingData(bytes: Uint8Array): boolean {
  const end = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length).lastIndexOf(
    Uint8Array.of(0xff, 0xd9),
  );
  return end < 0 || end + 2 !== bytes.length;
}
function hasTrailingData(bytes: Uint8Array): boolean {
  if (startsWith(bytes, PNG)) return pngHasTrailingData(bytes);
  return startsWith(bytes, JPEG) ? jpegHasTrailingData(bytes) : false;
}

function containsLiteral(bytes: Uint8Array, secrets: readonly string[]): boolean {
  const body = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
  return secrets.some(
    (secret) => Buffer.byteLength(secret) >= MIN_SECRET_LITERAL_BYTES && body.includes(secret),
  );
}

/** The shared credential floor: the same detectors the redaction layer applies to authorized content. */
function textHoldsCredential(text: string, secrets: readonly string[]): boolean {
  return containsCredentialShape(text) || redactCredentialShapes(text, secrets) !== text;
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

async function documentVerdict(
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
  if (textHoldsCredential(result.text, secrets)) return CREDENTIAL;
  // An extractor surfaces what a page shows; text a PDF carries outside the page or in an
  // uncompressed stream is also read from the file's own bytes.
  return extension === "pdf" && textHoldsCredential(Buffer.from(bytes).toString("latin1"), secrets)
    ? CREDENTIAL
    : ALLOWED;
}

/** An image's raw bytes are scanned like text, then its structure must end where the image does. */
function imageVerdict(bytes: Uint8Array, secrets: readonly string[]): AttachmentContentVerdict {
  const raw = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length).toString("latin1");
  if (textHoldsCredential(raw, secrets)) return CREDENTIAL;
  return hasTrailingData(bytes) ? UNSCANNABLE : ALLOWED;
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
  if (isImage(bytes)) return imageVerdict(bytes, secrets);
  const extension = documentExtension(bytes, name);
  if (extension !== undefined) return documentVerdict(bytes, extension, secrets, signal);
  const text = decodeText(bytes);
  if (text === undefined || startsWith(bytes, ZIP)) return UNSCANNABLE;
  return textHoldsCredential(text, secrets) ? CREDENTIAL : ALLOWED;
}
