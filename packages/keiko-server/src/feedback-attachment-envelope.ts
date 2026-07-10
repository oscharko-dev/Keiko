import { Buffer } from "node:buffer";

import {
  FEEDBACK_REPORT_LIMITS,
  type FeedbackTextAttachmentCandidateV1,
} from "@oscharko-dev/keiko-contracts/feedback-report";

const ATTACHMENT_ENVELOPE_KEYS = new Set(["bytesBase64", "declaredMediaType", "extension"]);
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const MAX_ATTACHMENT_BASE64_CHARACTERS = Math.ceil(FEEDBACK_REPORT_LIMITS.attachmentBytes / 3) * 4;

interface AttachmentEnvelopeHeader {
  readonly bytesBase64: string;
  readonly byteLength: number;
  readonly declaredMediaType?: string | undefined;
  readonly extension?: string | undefined;
}

export type FeedbackAttachmentEnvelopeDecode =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly reason: "invalid" | "limit" };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyEnvelopeKeys(value: Record<string, unknown>): boolean {
  return Reflect.ownKeys(value).every(
    (key) => typeof key === "string" && ATTACHMENT_ENVELOPE_KEYS.has(key),
  );
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function hasCanonicalTrailingBits(value: string): boolean {
  if (value.endsWith("==")) {
    const sextet = BASE64_ALPHABET.indexOf(value.at(-3) ?? "");
    return sextet >= 0 && (sextet & 15) === 0;
  }
  if (value.endsWith("=")) {
    const sextet = BASE64_ALPHABET.indexOf(value.at(-2) ?? "");
    return sextet >= 0 && (sextet & 3) === 0;
  }
  return true;
}

function decodedByteLength(value: string): number | undefined {
  if (!BASE64_PATTERN.test(value) || !hasCanonicalTrailingBits(value)) {
    return undefined;
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function metadataWithinLimits(
  declaredMediaType: string | undefined,
  extension: string | undefined,
): boolean {
  return (
    (declaredMediaType === undefined ||
      Buffer.byteLength(declaredMediaType, "utf8") <=
        FEEDBACK_REPORT_LIMITS.attachmentMediaTypeBytes) &&
    (extension === undefined ||
      Buffer.byteLength(extension, "utf8") <= FEEDBACK_REPORT_LIMITS.attachmentExtensionBytes)
  );
}

function preflightEnvelope(value: unknown): AttachmentEnvelopeHeader | "invalid" | "limit" {
  if (!isPlainRecord(value) || !hasOnlyEnvelopeKeys(value)) return "invalid";
  const bytesBase64 = value.bytesBase64;
  const declaredMediaType = value.declaredMediaType;
  const extension = value.extension;
  if (
    typeof bytesBase64 !== "string" ||
    !optionalString(declaredMediaType) ||
    !optionalString(extension)
  ) {
    return "invalid";
  }
  if (bytesBase64.length > MAX_ATTACHMENT_BASE64_CHARACTERS) return "limit";
  if (!metadataWithinLimits(declaredMediaType, extension)) return "limit";
  const byteLength = decodedByteLength(bytesBase64);
  if (byteLength === undefined) return "invalid";
  if (byteLength > FEEDBACK_REPORT_LIMITS.attachmentBytes) return "limit";
  return { bytesBase64, byteLength, declaredMediaType, extension };
}

function decodeEnvelope(header: AttachmentEnvelopeHeader): FeedbackTextAttachmentCandidateV1 {
  const bytes = Uint8Array.from(Buffer.from(header.bytesBase64, "base64"));
  return {
    bytes,
    ...(header.declaredMediaType === undefined
      ? {}
      : { declaredMediaType: header.declaredMediaType }),
    ...(header.extension === undefined ? {} : { extension: header.extension }),
  };
}

export function decodeFeedbackDraftAttachmentEnvelopes(
  draft: Record<string, unknown>,
): FeedbackAttachmentEnvelopeDecode {
  const attachments = draft.attachments;
  if (attachments === undefined) return { ok: true, value: draft };
  if (!Array.isArray(attachments)) return { ok: false, reason: "invalid" };
  if (attachments.length > FEEDBACK_REPORT_LIMITS.attachmentCount) {
    return { ok: false, reason: "limit" };
  }

  const headers: AttachmentEnvelopeHeader[] = [];
  let aggregateBytes = 0;
  for (const attachment of attachments) {
    const header = preflightEnvelope(attachment);
    if (typeof header === "string") return { ok: false, reason: header };
    aggregateBytes += header.byteLength;
    if (aggregateBytes > FEEDBACK_REPORT_LIMITS.attachmentAggregateBytes) {
      return { ok: false, reason: "limit" };
    }
    headers.push(header);
  }

  return { ok: true, value: { ...draft, attachments: headers.map(decodeEnvelope) } };
}
