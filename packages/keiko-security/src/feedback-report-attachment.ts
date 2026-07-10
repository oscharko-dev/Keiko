import {
  FEEDBACK_REPORT_LIMITS,
  type FeedbackDispositionRecordV1,
  type FeedbackRedactionRuleCountV1,
  type FeedbackReportPreparationError,
  type FeedbackTextAttachmentCandidateV1,
} from "@oscharko-dev/keiko-contracts/feedback-report";

import { hasKnownFeedbackMagic, hasUtf8Bom, UTF8_BOM } from "./feedback-report-magic.js";
import type { FeedbackReportRedactionPolicyV1 } from "./feedback-report-policy.js";
import { prepareFeedbackText } from "./feedback-report-text.js";

export type FeedbackAttachmentResult =
  | {
      readonly ok: true;
      readonly value: string;
      readonly inputBytes: number;
      readonly outputBytes: number;
      readonly rules: readonly FeedbackRedactionRuleCountV1[];
      readonly dispositions: readonly Omit<FeedbackDispositionRecordV1, "target">[];
    }
  | { readonly ok: false; readonly error: FeedbackReportPreparationError };

export type FeedbackAttachmentsResult =
  | {
      readonly ok: true;
      readonly value?: readonly string[];
      readonly rules: readonly FeedbackRedactionRuleCountV1[];
      readonly dispositions: readonly FeedbackDispositionRecordV1[];
    }
  | { readonly ok: false; readonly error: FeedbackReportPreparationError };

const TEXT_ENCODER = new TextEncoder();
const DENIED_EXTENSIONS: ReadonlySet<string> = new Set([
  ".pdf",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".tif",
  ".tiff",
  ".webp",
  ".svg",
  ".zip",
  ".gz",
  ".gzip",
  ".rar",
  ".7z",
  ".tar",
  ".bz2",
  ".xz",
  ".exe",
  ".dll",
  ".elf",
  ".dmg",
  ".app",
  ".bin",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".log",
]);

function metadataExceedsBytes(value: string | undefined, maxBytes: number): boolean {
  if (value === undefined) return false;
  return value.length > maxBytes || TEXT_ENCODER.encode(value).length > maxBytes;
}

function hasUnsupportedMediaType(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return !normalized.startsWith("text/") && normalized !== "application/json";
}

function hasUnsupportedExtension(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  const finalDot = normalized.lastIndexOf(".");
  const dotted = finalDot >= 0 ? normalized.slice(finalDot) : `.${normalized}`;
  return DENIED_EXTENSIONS.has(dotted);
}

function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function attachmentMetadataError(
  candidate: FeedbackTextAttachmentCandidateV1,
): FeedbackReportPreparationError | undefined {
  const metadataTooLarge =
    metadataExceedsBytes(
      candidate.declaredMediaType,
      FEEDBACK_REPORT_LIMITS.attachmentMediaTypeBytes,
    ) || metadataExceedsBytes(candidate.extension, FEEDBACK_REPORT_LIMITS.attachmentExtensionBytes);
  if (metadataTooLarge) return { code: "field-byte-limit", field: "attachments" };
  if (hasUnsupportedMediaType(candidate.declaredMediaType)) {
    return { code: "unsupported-media-type", field: "attachments" };
  }
  return hasUnsupportedExtension(candidate.extension)
    ? { code: "unsupported-extension", field: "attachments" }
    : undefined;
}

function attachmentPreflightError(
  candidate: FeedbackTextAttachmentCandidateV1,
): FeedbackReportPreparationError | undefined {
  if (candidate.bytes.length > FEEDBACK_REPORT_LIMITS.attachmentBytes) {
    return { code: "field-byte-limit", field: "attachments" };
  }
  const metadata = attachmentMetadataError(candidate);
  if (metadata !== undefined) return metadata;
  return hasKnownFeedbackMagic(candidate.bytes)
    ? { code: "binary-signature", field: "attachments" }
    : undefined;
}

export function prepareFeedbackAttachment(
  candidate: FeedbackTextAttachmentCandidateV1,
  policy: FeedbackReportRedactionPolicyV1,
  ordinal = 0,
): FeedbackAttachmentResult {
  const inputBytes = candidate.bytes.length;
  const preflight = attachmentPreflightError(candidate);
  if (preflight !== undefined) return { ok: false, error: preflight };
  const content = hasUtf8Bom(candidate.bytes)
    ? candidate.bytes.subarray(UTF8_BOM.length)
    : candidate.bytes;
  const decoded = decodeUtf8(content);
  if (decoded === undefined) {
    return { ok: false, error: { code: "invalid-utf8", field: "attachments" } };
  }
  const prepared = prepareFeedbackText(
    decoded,
    "attachments",
    FEEDBACK_REPORT_LIMITS.attachmentBytes,
    false,
    policy,
    { kind: "attachment", ordinal },
    "attachment",
  );
  if (!prepared.ok) return prepared;
  return {
    ok: true,
    value: prepared.value,
    inputBytes,
    outputBytes: TEXT_ENCODER.encode(prepared.value).length,
    rules: prepared.rules,
    dispositions: prepared.dispositions,
  };
}

type PreparedAttachment = Extract<FeedbackAttachmentResult, { readonly ok: true }>;

interface AttachmentAccumulator {
  readonly values: string[];
  readonly rules: FeedbackRedactionRuleCountV1[];
  readonly dispositions: FeedbackDispositionRecordV1[];
  inputBytes: number;
  outputBytes: number;
}

function applyPreparedAttachment(
  result: PreparedAttachment,
  ordinal: number,
  accumulator: AttachmentAccumulator,
): FeedbackReportPreparationError | undefined {
  const inputBytes = accumulator.inputBytes + result.inputBytes;
  const outputBytes = accumulator.outputBytes + result.outputBytes;
  if (
    inputBytes > FEEDBACK_REPORT_LIMITS.attachmentAggregateBytes ||
    outputBytes > FEEDBACK_REPORT_LIMITS.attachmentAggregateBytes
  ) {
    return { code: "attachment-aggregate-byte-limit", field: "attachments" };
  }
  accumulator.inputBytes = inputBytes;
  accumulator.outputBytes = outputBytes;
  accumulator.rules.push(...result.rules);
  const target = { kind: "attachment" as const, ordinal };
  accumulator.dispositions.push(
    ...result.dispositions.map((disposition) => ({ ...disposition, target })),
  );
  if (result.value.trim().length > 0) accumulator.values.push(result.value);
  return undefined;
}

function successfulAttachments(accumulator: AttachmentAccumulator): FeedbackAttachmentsResult {
  return {
    ok: true,
    ...(accumulator.values.length === 0 ? {} : { value: accumulator.values }),
    rules: accumulator.rules,
    dispositions: accumulator.dispositions,
  };
}

export function prepareFeedbackAttachments(
  candidates: readonly FeedbackTextAttachmentCandidateV1[] | undefined,
  policy: FeedbackReportRedactionPolicyV1,
): FeedbackAttachmentsResult {
  if (candidates === undefined || candidates.length === 0) {
    return { ok: true, rules: [], dispositions: [] };
  }
  if (candidates.length > FEEDBACK_REPORT_LIMITS.attachmentCount) {
    return { ok: false, error: { code: "attachment-count-limit", field: "attachments" } };
  }
  const accumulator: AttachmentAccumulator = {
    values: [],
    rules: [],
    dispositions: [],
    inputBytes: 0,
    outputBytes: 0,
  };
  for (const [ordinal, candidate] of candidates.entries()) {
    const result = prepareFeedbackAttachment(candidate, policy, ordinal);
    if (!result.ok) return result;
    const error = applyPreparedAttachment(result, ordinal, accumulator);
    if (error !== undefined) return { ok: false, error };
  }
  return successfulAttachments(accumulator);
}
