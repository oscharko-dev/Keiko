import { FEEDBACK_REPORT_LIMITS } from "@oscharko-dev/keiko-contracts/feedback-report";

import type { FeedbackBrowserAttachmentV1 } from "@/lib/feedback-api";

export type FeedbackAttachmentStagingError = "count" | "item" | "aggregate" | "read";

export interface StagedFeedbackAttachment {
  readonly envelope: FeedbackBrowserAttachmentV1;
  readonly byteLength: number;
}

export type StageFeedbackAttachmentsResult =
  | { readonly ok: true; readonly value: readonly StagedFeedbackAttachment[] }
  | { readonly ok: false; readonly reason: FeedbackAttachmentStagingError };

const TEXT_ENCODER = new TextEncoder();
const SAFE_EXTENSION = /^\.[a-z0-9][a-z0-9+_-]{0,15}$/u;

function safeMediaType(file: File): string | undefined {
  const normalized = file.type.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (normalized.length === 0) return undefined;
  if (TEXT_ENCODER.encode(normalized).length > FEEDBACK_REPORT_LIMITS.attachmentMediaTypeBytes)
    return undefined;
  return normalized;
}

function safeExtension(file: File): string | undefined {
  const basename = file.name.split(/[\\/]/u).at(-1) ?? "";
  const dot = basename.lastIndexOf(".");
  if (dot < 0) return undefined;
  const extension = basename.slice(dot).toLowerCase();
  if (
    !SAFE_EXTENSION.test(extension) ||
    TEXT_ENCODER.encode(extension).length > FEEDBACK_REPORT_LIMITS.attachmentExtensionBytes
  ) {
    return undefined;
  }
  return extension;
}

function metadataPreflight(
  files: readonly File[],
  existing: readonly StagedFeedbackAttachment[],
): FeedbackAttachmentStagingError | undefined {
  if (existing.length + files.length > FEEDBACK_REPORT_LIMITS.attachmentCount) return "count";
  if (files.some((file) => file.size > FEEDBACK_REPORT_LIMITS.attachmentBytes)) return "item";
  const aggregate =
    existing.reduce((sum, attachment) => sum + attachment.byteLength, 0) +
    files.reduce((sum, file) => sum + file.size, 0);
  if (aggregate > FEEDBACK_REPORT_LIMITS.attachmentAggregateBytes) return "aggregate";
  return undefined;
}

async function readBytes(file: File): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === "function") {
    return new Uint8Array(await file.arrayBuffer());
  }
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("feedback attachment read failed"));
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) resolve(new Uint8Array(reader.result));
      else reject(new Error("feedback attachment read returned an invalid value"));
    };
    reader.readAsArrayBuffer(file);
  });
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 16 * 1024;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export async function stageFeedbackAttachmentFiles(
  files: readonly File[],
  existing: readonly StagedFeedbackAttachment[],
): Promise<StageFeedbackAttachmentsResult> {
  const preflight = metadataPreflight(files, existing);
  if (preflight !== undefined) return { ok: false, reason: preflight };

  const staged: StagedFeedbackAttachment[] = [];
  try {
    for (const file of files) {
      const bytes = await readBytes(file);
      if (bytes.length > FEEDBACK_REPORT_LIMITS.attachmentBytes) {
        return { ok: false, reason: "item" };
      }
      const mediaType = safeMediaType(file);
      const extension = safeExtension(file);
      const envelope = Object.freeze({
        bytesBase64: base64(bytes),
        ...(mediaType === undefined ? {} : { declaredMediaType: mediaType }),
        ...(extension === undefined ? {} : { extension }),
      });
      staged.push(Object.freeze({ envelope, byteLength: bytes.length }));
    }
  } catch {
    return { ok: false, reason: "read" };
  }
  const aggregate =
    existing.reduce((sum, attachment) => sum + attachment.byteLength, 0) +
    staged.reduce((sum, attachment) => sum + attachment.byteLength, 0);
  if (aggregate > FEEDBACK_REPORT_LIMITS.attachmentAggregateBytes) {
    return { ok: false, reason: "aggregate" };
  }
  return { ok: true, value: Object.freeze(staged) };
}
