"use client";

import { type ReactNode, type RefObject } from "react";

import type { FeedbackRevalidationOutcomeV1, PreparedFeedbackSnapshotV1 } from "@/lib/feedback-api";
import { useFeedbackTranslate } from "./feedback-i18n";

import { FeedbackDispositionNotices } from "./FeedbackDispositionNotices";
import {
  FeedbackPublicHandoff,
  type FeedbackClipboardWriter,
  type FeedbackPublicOpener,
  type FeedbackRevalidator,
} from "./FeedbackPublicHandoff";
import {
  FeedbackSubmissionReview,
  type FeedbackSubmissionReviewControls,
} from "./FeedbackSubmissionReview";
import type { FeedbackOptionalTextField, FeedbackTextField } from "./feedback-options";

function PreviewText({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): ReactNode {
  return (
    <div className="feedback-preview-section">
      <span className="feedback-preview-label">{label}</span>
      <p>{value}</p>
    </div>
  );
}

function retainedAttachmentOrdinals(
  prepared: PreparedFeedbackSnapshotV1,
  sourceCount: number,
): readonly number[] {
  const omitted = new Set(
    prepared.dispositionSidecar.records.flatMap((record) =>
      record.action === "omitted" && record.target.kind === "attachment"
        ? [record.target.ordinal]
        : [],
    ),
  );
  return Array.from({ length: sourceCount }, (_value, ordinal) => ordinal).filter(
    (ordinal) => !omitted.has(ordinal),
  );
}

export function FeedbackPreview({
  prepared,
  attachmentCount,
  headingRef,
  submission,
  onEditField,
  onEditAndRescan,
  onRemoveOptionalField,
  onReviewAttachment,
  writeClipboard,
  revalidateReport,
  openPublic,
  onPreparedInvalidated,
}: {
  readonly prepared: PreparedFeedbackSnapshotV1;
  readonly attachmentCount: number;
  readonly headingRef: RefObject<HTMLHeadingElement>;
  readonly submission: FeedbackSubmissionReviewControls;
  readonly onEditField: (field: FeedbackTextField) => void;
  readonly onEditAndRescan: () => void;
  readonly onRemoveOptionalField: (field: FeedbackOptionalTextField) => void;
  readonly onReviewAttachment: (ordinal: number) => void;
  readonly writeClipboard: FeedbackClipboardWriter;
  readonly revalidateReport: FeedbackRevalidator;
  readonly openPublic: FeedbackPublicOpener;
  readonly onPreparedInvalidated: (outcome: FeedbackRevalidationOutcomeV1["outcome"]) => void;
}): ReactNode {
  const t = useFeedbackTranslate();
  const { report } = prepared;
  const sourceOrdinals = retainedAttachmentOrdinals(prepared, attachmentCount);
  return (
    <section className="feedback-preview" aria-label={t("feedback.preview.region")}>
      <div className="feedback-preview-header">
        <h2 ref={headingRef} className="feedback-heading" tabIndex={-1}>
          {t("feedback.preview.title")}
        </h2>
        <button
          className="feedback-secondary-action"
          type="button"
          disabled={submission.busy}
          onClick={onEditAndRescan}
        >
          {t("feedback.preview.editAndRescan")}
        </button>
      </div>
      <p className="feedback-residual-risk">{t("feedback.preview.residualRisk")}</p>
      <FeedbackDispositionNotices
        records={prepared.dispositionSidecar.records}
        disabled={submission.busy}
        onEditField={onEditField}
        onRemoveOptionalField={onRemoveOptionalField}
        onReviewAttachment={onReviewAttachment}
      />
      <div className="feedback-preview-section">
        <span className="feedback-preview-label">{t("feedback.preview.summary")}</span>
        <h3>{report.summary.title}</h3>
        <p>{report.summary.description}</p>
      </div>
      {report.browserDescription === undefined ? null : (
        <PreviewText
          label={t("feedback.preview.browserDescription")}
          value={report.browserDescription}
        />
      )}
      {report.handwrittenEvidence === undefined ? null : (
        <PreviewText
          label={t("feedback.preview.handwrittenEvidence")}
          value={report.handwrittenEvidence}
        />
      )}
      <PreviewText label={t("feedback.preview.steps")} value={report.steps} />
      <PreviewText label={t("feedback.preview.expected")} value={report.expectedResult} />
      <PreviewText label={t("feedback.preview.actual")} value={report.actualResult} />
      {report.attachments?.map((attachment, index) => (
        <PreviewText
          key={index}
          label={t("feedback.preview.attachment", {
            ordinal: (sourceOrdinals[index] ?? index) + 1,
          })}
          value={attachment}
        />
      ))}
      <FeedbackSubmissionReview prepared={prepared} {...submission} />
      <FeedbackPublicHandoff
        prepared={prepared}
        writeClipboard={writeClipboard}
        revalidateReport={revalidateReport}
        openPublic={openPublic}
        onInvalidated={onPreparedInvalidated}
      />
    </section>
  );
}
