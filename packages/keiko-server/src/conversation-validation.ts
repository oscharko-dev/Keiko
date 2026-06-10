// Issue #149 (Epic #142) — server-side modality guardrails enforced BEFORE any provider adapter
// is called from the Conversation Center send path. The validator is a pure function: it takes
// a snapshot of the model capability registry plus the parsed wire payload, and either returns
// `{ ok: true }` (the handler proceeds) or `{ ok: false }` with a typed BffErrorCode and a
// STATIC English message that contains no caller-supplied value (model id, file name, byte
// count). The static-message rule keeps the response safe to render verbatim in the browser
// after passing through the BFF redactor.
//
// Rule order mirrors the threat model in epic #142:
//   1. Model existence + chat-kind   — embedding/OCR/unknown models never get a send through.
//   2. Modality flags                — text-only models reject image AND document attachments.
//   3. Mime type allowlist           — images must be image/*; documents must be text/* or a
//                                       small literal set; nothing else reaches the model.
//   4. Per-attachment size cap       — 8 MiB single-file ceiling.
//   5. Aggregate document context    — 256 KiB across all extracted-text blocks.
//
// All caps are duplicated client-side in keiko-ui; the server is the trust boundary. UI changes
// are out of scope for #149 — the existing gw-error surface from #146 renders these codes.

import type {
  BffErrorCode,
  ConversationDocumentContextWire,
  ModelCapability,
} from "@oscharko-dev/keiko-contracts";

export interface ConversationAttachment {
  readonly kind: "image" | "document";
  readonly mimeType: string;
  readonly sizeBytes: number;
}

export interface ConversationValidationInput {
  readonly modelId: string;
  readonly modelCapabilities: ReadonlyMap<string, ModelCapability>;
  readonly attachments?: readonly ConversationAttachment[] | undefined;
  readonly documentContext?: readonly ConversationDocumentContextWire[] | undefined;
}

export type ConversationValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: BffErrorCode; readonly message: string };

// Mirrors keiko-workspace MAX_TOTAL_EXTRACTED_BYTES (256 KiB) so the server cap is identical
// to the on-disk extraction cap and the client preflight.
export const MAX_AGGREGATE_DOCUMENT_BYTES = 262_144;

// Per-attachment ceiling (8 MiB). Anything larger is rejected without ever touching disk or
// the provider adapter.
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

export const ALLOWED_IMAGE_MIME_PREFIXES: readonly string[] = ["image/"];

export const ALLOWED_DOCUMENT_MIME_PREFIXES: readonly string[] = ["text/"];

// Application/* document mimes admitted by the document path. `application/pdf` is included
// because document-capable models accept structured PDFs; image-capable-only models with a
// PDF attachment still fail rule 3 because their attachment kind would be "image".
export const ALLOWED_DOCUMENT_MIME_LITERALS: ReadonlySet<string> = new Set([
  "application/json",
  "application/x-yaml",
  "application/yaml",
  "application/xml",
  "application/javascript",
  "application/typescript",
  "application/pdf",
]);

// Static error messages — NO interpolation. Every value the caller supplied stays out of the
// response so the browser-rendered error cannot echo a model id, filename, or byte count.
const MSG_UNAVAILABLE_MODEL =
  "Selected model is not available for conversation. Pick a chat-capable model.";
const MSG_UNSUPPORTED_MODALITY =
  "Selected model does not accept this attachment kind. Pick a model that supports this input or remove the attachment.";
const MSG_UNSUPPORTED_FILE_TYPE =
  "Attachment file type is not allowed for the Conversation Center.";
const MSG_OVERSIZED_CONTEXT =
  "Attached content exceeds the conversation context budget. Remove or shorten attachments.";

function fail(code: BffErrorCode, message: string): ConversationValidationResult {
  return { ok: false, code, message };
}

function mimeStartsWithAny(mimeType: string, prefixes: readonly string[]): boolean {
  for (const prefix of prefixes) {
    if (mimeType.startsWith(prefix)) return true;
  }
  return false;
}

function isAllowedImageMime(mimeType: string): boolean {
  // SVG can carry inline script — deny both registered variants before the prefix check.
  if (mimeType === "image/svg+xml" || mimeType === "image/svg") return false;
  return mimeStartsWithAny(mimeType, ALLOWED_IMAGE_MIME_PREFIXES);
}

function isAllowedDocumentMime(mimeType: string): boolean {
  if (mimeStartsWithAny(mimeType, ALLOWED_DOCUMENT_MIME_PREFIXES)) return true;
  return ALLOWED_DOCUMENT_MIME_LITERALS.has(mimeType);
}

function checkAttachment(
  attachment: ConversationAttachment,
  capability: ModelCapability,
): ConversationValidationResult | undefined {
  if (attachment.kind === "image" && !capability.supportsImageInput) {
    return fail("CONVERSATION_UNSUPPORTED_MODALITY", MSG_UNSUPPORTED_MODALITY);
  }
  if (attachment.kind === "document" && !capability.supportsDocumentInput) {
    return fail("CONVERSATION_UNSUPPORTED_MODALITY", MSG_UNSUPPORTED_MODALITY);
  }
  const mimeOk =
    attachment.kind === "image"
      ? isAllowedImageMime(attachment.mimeType)
      : isAllowedDocumentMime(attachment.mimeType);
  if (!mimeOk) {
    return fail("CONVERSATION_UNSUPPORTED_FILE_TYPE", MSG_UNSUPPORTED_FILE_TYPE);
  }
  if (attachment.sizeBytes > MAX_ATTACHMENT_BYTES) {
    return fail("CONVERSATION_OVERSIZED_CONTEXT", MSG_OVERSIZED_CONTEXT);
  }
  return undefined;
}

function checkAttachments(
  attachments: readonly ConversationAttachment[] | undefined,
  capability: ModelCapability,
): ConversationValidationResult | undefined {
  if (attachments === undefined) return undefined;
  for (const attachment of attachments) {
    const failure = checkAttachment(attachment, capability);
    if (failure !== undefined) return failure;
  }
  return undefined;
}

function checkDocumentContextBudget(
  documentContext: readonly ConversationDocumentContextWire[] | undefined,
): ConversationValidationResult | undefined {
  if (documentContext === undefined || documentContext.length === 0) return undefined;
  let total = 0;
  for (const entry of documentContext) {
    // The wire's declared `extractedBytes` is caller-supplied and therefore untrusted: a
    // client can claim 100 bytes while shipping a 10 MiB `text` blob and slip past the cap.
    // Measure the real UTF-8 byte size of the strings we will actually use, and take the
    // MAX of declared vs measured so under-reporting cannot shrink the contribution.
    const measuredBytes =
      Buffer.byteLength(entry.text, "utf8") +
      Buffer.byteLength(entry.truncationMarker ?? "", "utf8");
    const declaredBytes = Number.isFinite(entry.extractedBytes) ? entry.extractedBytes : 0;
    total += Math.max(declaredBytes, measuredBytes);
    if (total > MAX_AGGREGATE_DOCUMENT_BYTES) {
      return fail("CONVERSATION_OVERSIZED_CONTEXT", MSG_OVERSIZED_CONTEXT);
    }
  }
  return undefined;
}

export function validateConversationPayload(
  input: ConversationValidationInput,
): ConversationValidationResult {
  const capability = input.modelCapabilities.get(input.modelId);
  if (capability?.kind !== "chat") {
    return fail("CONVERSATION_UNAVAILABLE_MODEL", MSG_UNAVAILABLE_MODEL);
  }
  const attachmentFailure = checkAttachments(input.attachments, capability);
  if (attachmentFailure !== undefined) return attachmentFailure;
  const documentFailure = checkDocumentContextBudget(input.documentContext);
  if (documentFailure !== undefined) return documentFailure;
  return { ok: true };
}
