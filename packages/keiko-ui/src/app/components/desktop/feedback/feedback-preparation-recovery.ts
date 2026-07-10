import type {
  FeedbackReportField,
  FeedbackReportPreparationError,
} from "@oscharko-dev/keiko-contracts/feedback-report";

import type { FeedbackPreviewPreparationError } from "@/lib/feedback-api";
import type { FeedbackMessageKey } from "./feedback-i18n-messages.en";

import { isFeedbackTextField, type FeedbackTextField } from "./feedback-options";

export type FeedbackRecoveryTarget = FeedbackTextField | "attachments";

const REPORT_FIELD_TO_DRAFT_FIELD: Partial<
  Readonly<Record<FeedbackReportField, FeedbackTextField>>
> = {
  productVersion: "productVersion",
  browserDescription: "browserDescription",
  "summary.title": "title",
  "summary.description": "description",
  steps: "reproductionSteps",
  expectedResult: "expectedBehavior",
  actualResult: "actualBehavior",
  handwrittenEvidence: "handwrittenEvidence",
};

const ATTACHMENT_REJECTION_CODES = new Set([
  "binary-signature",
  "unsupported-media-type",
  "unsupported-extension",
  "invalid-utf8",
]);
const SIZE_REJECTION_CODES = new Set([
  "field-byte-limit",
  "attachment-count-limit",
  "attachment-aggregate-byte-limit",
  "canonical-body-byte-limit",
]);
const UNSAFE_TEXT_REJECTION_CODES = new Set([
  "invalid-unicode-scalar",
  "invalid-utf8",
  "unsafe-control",
  "unsafe-format-character",
]);

function recoveryTarget(
  error: FeedbackPreviewPreparationError,
): FeedbackRecoveryTarget | undefined {
  for (const preparationError of error.errors) {
    if (
      preparationError.code === "rewrite-required" &&
      preparationError.target.kind === "draft-field" &&
      isFeedbackTextField(preparationError.target.field)
    ) {
      return preparationError.target.field;
    }
    if (preparationError.code === "raw-log-content") {
      return REPORT_FIELD_TO_DRAFT_FIELD[preparationError.field];
    }
    if (preparationError.code !== "rewrite-required") {
      if (preparationError.field === "attachments") return "attachments";
      const field = REPORT_FIELD_TO_DRAFT_FIELD[preparationError.field];
      if (field !== undefined) return field;
    }
  }
  return undefined;
}

function hasCode(
  errors: readonly FeedbackReportPreparationError[],
  code: FeedbackReportPreparationError["code"],
): boolean {
  return errors.some((preparationError) => preparationError.code === code);
}

function hasAnyCode(
  errors: readonly FeedbackReportPreparationError[],
  codes: ReadonlySet<string>,
): boolean {
  return errors.some((preparationError) => codes.has(preparationError.code));
}

export interface FeedbackPreparationRecovery {
  readonly target: FeedbackRecoveryTarget | undefined;
  readonly messageKey: FeedbackMessageKey;
}

/**
 * Converts only validated preparation-error codes into content-free, targetable recovery.
 * The original typed errors never enter rendered state, so server diagnostics cannot leak.
 */
export function feedbackPreparationRecovery(
  error: FeedbackPreviewPreparationError,
): FeedbackPreparationRecovery {
  const target = recoveryTarget(error);
  if (hasCode(error.errors, "rewrite-required")) {
    return { target, messageKey: "feedback.form.rewriteRequired" };
  }
  if (hasCode(error.errors, "raw-log-content")) {
    return { target, messageKey: "feedback.form.rawLogRejected" };
  }
  if (target === "attachments" && hasAnyCode(error.errors, ATTACHMENT_REJECTION_CODES)) {
    return { target, messageKey: "feedback.form.attachmentRejected" };
  }
  if (hasAnyCode(error.errors, SIZE_REJECTION_CODES)) {
    return { target, messageKey: "feedback.form.sizeRejected" };
  }
  if (hasAnyCode(error.errors, UNSAFE_TEXT_REJECTION_CODES)) {
    return { target, messageKey: "feedback.form.unsafeTextRejected" };
  }
  return { target, messageKey: "feedback.form.scanError" };
}
