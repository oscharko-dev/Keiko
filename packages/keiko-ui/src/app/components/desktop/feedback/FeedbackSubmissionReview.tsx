"use client";

import { useId, type ReactNode, type RefObject } from "react";

import type { FeedbackReceiptV1, PreparedFeedbackSnapshotV1 } from "@/lib/feedback-api";
import { Icons } from "../Icons";
import { useFeedbackTranslate } from "./feedback-i18n";

export type FeedbackRetryableSubmissionStep = "unavailable" | "error";
export type FeedbackSubmissionStep =
  "review" | "confirm" | "accepted" | "rejected" | "rate-limited" | FeedbackRetryableSubmissionStep;

export type FeedbackReceiptCopyState = "idle" | "copying" | "copied" | "error";

export function isRetryableSubmissionStep(
  step: FeedbackSubmissionStep,
): step is FeedbackRetryableSubmissionStep {
  return step === "unavailable" || step === "error";
}

export interface FeedbackSubmissionReviewControls {
  readonly reviewed: boolean;
  readonly step: FeedbackSubmissionStep;
  readonly busy: boolean;
  readonly confirmationHeadingRef: RefObject<HTMLHeadingElement>;
  readonly acceptedStatusRef: RefObject<HTMLParagraphElement>;
  readonly copiedStatusRef: RefObject<HTMLParagraphElement>;
  readonly resultRef: RefObject<HTMLElement>;
  readonly receipt: FeedbackReceiptV1;
  readonly receiptCopyState: FeedbackReceiptCopyState;
  readonly onReviewedChange: (reviewed: boolean) => void;
  readonly onContinue: () => void;
  readonly onSubmit: () => void;
  readonly onEditAndRescan: () => void;
  readonly onCopyReceipt: () => void;
}

function FeedbackSubmissionResult({
  step,
  busy,
  resultRef,
  onRetry,
  onEditAndRescan,
}: {
  readonly step: Extract<
    FeedbackSubmissionStep,
    "unavailable" | "rejected" | "rate-limited" | "error"
  >;
  readonly busy: boolean;
  readonly resultRef: RefObject<HTMLElement>;
  readonly onRetry: () => void;
  readonly onEditAndRescan: () => void;
}): ReactNode {
  const t = useFeedbackTranslate();
  const headingId = useId();
  const rateLimited = step === "rate-limited";
  const content =
    step === "unavailable"
      ? {
          title: "feedback.submission.unavailable.title" as const,
          message: "feedback.submission.unavailable.message" as const,
          role: "status" as const,
        }
      : step === "rejected"
        ? {
            title: "feedback.submission.rejected.title" as const,
            message: "feedback.submission.rejected.message" as const,
            role: "alert" as const,
          }
        : step === "rate-limited"
          ? {
              title: "feedback.submission.rateLimited.title" as const,
              message: "feedback.submission.rateLimited.message" as const,
              role: "status" as const,
            }
          : {
              title: "feedback.submission.error.title" as const,
              message: "feedback.submission.error.message" as const,
              role: "alert" as const,
            };
  return (
    <section
      ref={resultRef}
      className="feedback-submission-result"
      data-outcome={step}
      aria-labelledby={headingId}
      tabIndex={-1}
    >
      {rateLimited ? (
        <p className="feedback-submission-outcome">
          <Icons.info size={16} />
          <span>{t("feedback.submission.rateLimited.label")}</span>
        </p>
      ) : null}
      <h3 id={headingId}>{t(content.title)}</h3>
      <p className="feedback-result-message" role={content.role}>
        {t(content.message)}
      </p>
      <button
        className="feedback-primary-action feedback-submission-action"
        type="button"
        disabled={busy}
        onClick={step === "rejected" || step === "rate-limited" ? onEditAndRescan : onRetry}
      >
        {busy
          ? t("feedback.submission.submitting")
          : step === "rejected"
            ? t("feedback.submission.rejected.editAndRescan")
            : step === "rate-limited"
              ? t("feedback.submission.rateLimited.editAndRescan")
              : t("feedback.submission.retry")}
      </button>
    </section>
  );
}

export function FeedbackSubmissionReview({
  prepared,
  reviewed,
  step,
  busy,
  confirmationHeadingRef,
  acceptedStatusRef,
  copiedStatusRef,
  resultRef,
  receipt,
  receiptCopyState,
  onReviewedChange,
  onContinue,
  onSubmit,
  onEditAndRescan,
  onCopyReceipt,
}: FeedbackSubmissionReviewControls & {
  readonly prepared: PreparedFeedbackSnapshotV1;
}): ReactNode {
  const t = useFeedbackTranslate();
  const exactHeadingId = useId();
  const digestLabelId = useId();
  const reviewId = useId();
  const confirmationHeadingId = useId();
  return (
    <>
      <section className="feedback-exact-payload" aria-labelledby={exactHeadingId}>
        <h3 id={exactHeadingId}>{t("feedback.submission.exact.title")}</h3>
        <p className="feedback-body">{t("feedback.submission.exact.description")}</p>
        <pre
          aria-labelledby={exactHeadingId}
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- named scroll region must be keyboard-focusable (axe scrollable-region-focusable)
          tabIndex={0}
        >
          {prepared.canonicalJson}
        </pre>
        <div className="feedback-exact-digest">
          <span id={digestLabelId}>{t("feedback.submission.exact.digest")}</span>
          <code aria-labelledby={digestLabelId}>{prepared.exactBodySha256}</code>
        </div>
      </section>
      {step === "review" ? (
        <section
          className="feedback-submission-step"
          aria-label={t("feedback.submission.review.title")}
        >
          <label className="feedback-review-label" htmlFor={reviewId}>
            <input
              id={reviewId}
              type="checkbox"
              checked={reviewed}
              disabled={busy}
              onChange={(event) => onReviewedChange(event.currentTarget.checked)}
            />
            <span>{t("feedback.submission.review.label")}</span>
          </label>
          <button
            className="feedback-primary-action feedback-submission-action"
            type="button"
            disabled={!reviewed || busy}
            onClick={onContinue}
          >
            {t("feedback.submission.continue")}
          </button>
        </section>
      ) : null}
      {step === "confirm" ? (
        <section className="feedback-submission-step" aria-labelledby={confirmationHeadingId}>
          <h3 ref={confirmationHeadingRef} id={confirmationHeadingId} tabIndex={-1}>
            {t("feedback.submission.confirm.title")}
          </h3>
          <p className="feedback-body">{t("feedback.submission.confirm.description")}</p>
          <button
            className="feedback-primary-action feedback-submission-action"
            type="button"
            disabled={busy}
            onClick={onSubmit}
          >
            {busy ? t("feedback.submission.submitting") : t("feedback.submission.submit")}
          </button>
        </section>
      ) : null}
      {step === "accepted" ? (
        <section
          className="feedback-submission-result"
          aria-label={t("feedback.submission.accepted")}
        >
          <p
            ref={acceptedStatusRef}
            className="feedback-submission-status"
            role="status"
            tabIndex={-1}
          >
            {t("feedback.submission.accepted")}
          </p>
          {receiptCopyState !== "copied" ? (
            <>
              <p className="feedback-result-message">
                {t("feedback.submission.receipt.instructions")}
              </p>
              <dl>
                <dt>{t("feedback.submission.receipt.id")}</dt>
                <dd>
                  <code>{receipt.receiptId}</code>
                </dd>
                <dt>{t("feedback.submission.receipt.expires")}</dt>
                <dd>
                  <time dateTime={receipt.expiresAt}>{receipt.expiresAt}</time>
                </dd>
              </dl>
              {receiptCopyState === "error" ? (
                <p role="alert">{t("feedback.submission.receipt.copyError")}</p>
              ) : null}
              <button
                className="feedback-primary-action feedback-submission-action"
                type="button"
                disabled={receiptCopyState === "copying"}
                onClick={onCopyReceipt}
              >
                {receiptCopyState === "copying"
                  ? t("feedback.submission.receipt.copying")
                  : t("feedback.submission.receipt.copy")}
              </button>
            </>
          ) : null}
          {receiptCopyState === "copied" ? (
            <p
              ref={copiedStatusRef}
              className="feedback-result-message"
              role="status"
              tabIndex={-1}
            >
              {t("feedback.submission.receipt.copied")}
            </p>
          ) : null}
        </section>
      ) : null}
      {isRetryableSubmissionStep(step) || step === "rejected" || step === "rate-limited" ? (
        <FeedbackSubmissionResult
          step={step}
          busy={busy}
          resultRef={resultRef}
          onRetry={onSubmit}
          onEditAndRescan={onEditAndRescan}
        />
      ) : null}
    </>
  );
}
