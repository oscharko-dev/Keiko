import { MAX_ATTACHMENT_BYTES } from "@oscharko-dev/keiko-contracts/runtime/bff-wire";
import type { ChatMessageFileContentPart } from "@oscharko-dev/keiko-contracts";

import { parseInlineDataUrl } from "./coding-sidecar-data-url.js";

/**
 * PDF input for a native OpenCode coding run (#3906). OpenCode's OpenAI-chat serializer sends a PDF
 * (one the native `read` admitted, or a prompt attachment) as `{type: "file", file: {filename,
 * file_data}}` with an inline `data:application/pdf;base64,` URL: the shape the `document_input`
 * readiness probe verifies for `supportsDocumentInput`. This module is the one place that admits
 * such a part: strict shape, the PDF media type and signature alone, a canonical non-empty payload
 * within the Chat attachment bound, a plain bounded file name, and a re-built part, never the part as
 * received. A remote or file URL is refused, so nothing outside the request is ever fetched.
 */

/** The most PDF parts one gateway request may carry. */
export const CODING_SIDECAR_MAX_DOCUMENT_PARTS = 8;

/** Closed refusal vocabulary; the route maps each to one fixed, body-free 400 message. */
export const CODING_SIDECAR_DOCUMENT_REJECTIONS = [
  "document-part-invalid",
  "document-mime-unsupported",
  "document-part-too-large",
  "document-count-exceeded",
  "document-input-unsupported",
] as const;

export type CodingSidecarDocumentRejection = (typeof CODING_SIDECAR_DOCUMENT_REJECTIONS)[number];

export const CODING_SIDECAR_DOCUMENT_REJECTION_MESSAGES: Readonly<
  Record<CodingSidecarDocumentRejection, string>
> = {
  "document-part-invalid": "Request body message content included an invalid document part.",
  "document-mime-unsupported":
    "Request body message content included a document part that is not a PDF.",
  "document-part-too-large":
    "Request body message content included a document part that exceeds the document size limit.",
  "document-count-exceeded": "Request body messages exceed the document part limit.",
  "document-input-unsupported":
    "Request body message content included document input that the selected model does not declare.",
};

export type CodingSidecarDocumentPartResult =
  | { readonly kind: "ok"; readonly part: ChatMessageFileContentPart }
  /** Not an inline document at all: a malformed part, or a URL reference Keiko never dereferences. */
  | { readonly kind: "unsupported" }
  | { readonly kind: "rejected"; readonly reason: CodingSidecarDocumentRejection };

const PDF_MEDIA_TYPE = "application/pdf";
const PDF_SIGNATURE = "%PDF-";
const FILENAME_MAX_CHARACTERS = 255;
/** The file name OpenCode itself gives a PDF that has none. */
const DEFAULT_FILENAME = "document.pdf";
// A plain name: no path, no control or format character, nothing a provider could read as markup.
const PLAIN_FILENAME = /^[\p{L}\p{N} ._()-]+$/u;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

/** True for a content part that declares itself a file, whether or not it is well formed. */
export function isFileContentPartCandidate(part: unknown): boolean {
  return isRecord(part) && part.type === "file";
}

function fileFieldsOf(
  part: unknown,
): { readonly filename: unknown; readonly fileData: string } | undefined {
  if (!isRecord(part) || !hasOnlyKeys(part, ["type", "file"])) return undefined;
  const file = part.file;
  if (!isRecord(file) || !hasOnlyKeys(file, ["filename", "file_data"])) return undefined;
  return typeof file.file_data === "string"
    ? { filename: file.filename, fileData: file.file_data }
    : undefined;
}

/** The name a provider sees: the producer's plain name, or its own default for anything else. */
function plainFilename(value: unknown): string {
  return typeof value === "string" &&
    value.length <= FILENAME_MAX_CHARACTERS &&
    PLAIN_FILENAME.test(value)
    ? value
    : DEFAULT_FILENAME;
}

function hasPdfSignature(payload: string): boolean {
  return Buffer.from(payload.slice(0, 8), "base64").toString("latin1").startsWith(PDF_SIGNATURE);
}

function rejected(reason: CodingSidecarDocumentRejection): CodingSidecarDocumentPartResult {
  return { kind: "rejected", reason };
}

/**
 * Validates one `file` content part: strict shape, an inline base64 data URL of the PDF media type
 * whose bytes start with the PDF signature, and a canonical, non-empty payload within the
 * per-document size limit. A part that is not an inline data URL is `unsupported`, the closed
 * refusal every unknown part already had.
 */
export function parseFileContentPart(part: unknown): CodingSidecarDocumentPartResult {
  const fields = fileFieldsOf(part);
  if (fields === undefined) return { kind: "unsupported" };
  const inline = parseInlineDataUrl(fields.fileData, MAX_ATTACHMENT_BYTES);
  if (inline.kind === "not-inline") return { kind: "unsupported" };
  if (inline.kind === "too-large") return rejected("document-part-too-large");
  if (inline.kind === "invalid") return rejected("document-part-invalid");
  const { mediaType, payload } = inline.value;
  if (mediaType.toLowerCase() !== PDF_MEDIA_TYPE) return rejected("document-mime-unsupported");
  if (!hasPdfSignature(payload)) return rejected("document-part-invalid");
  return {
    kind: "ok",
    part: {
      type: "file",
      file: {
        filename: plainFilename(fields.filename),
        file_data: `data:${PDF_MEDIA_TYPE};base64,${payload}`,
      },
    },
  };
}

/** PDF document parts across the messages of one request. */
export function countDocumentContentParts(
  messages: readonly {
    readonly contentParts?: readonly { readonly type: string }[] | undefined;
  }[],
): number {
  return messages.reduce(
    (count, message) =>
      count + (message.contentParts?.filter((part) => part.type === "file").length ?? 0),
    0,
  );
}
