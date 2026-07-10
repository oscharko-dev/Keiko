"use client";

import { Fragment, useId, type ReactNode } from "react";

import type {
  FeedbackDispositionRecordV1,
  FeedbackDraftFieldIdV1,
} from "@oscharko-dev/keiko-contracts/feedback-report";

import { useFeedbackTranslate, type FeedbackTranslate } from "./feedback-i18n";
import type { FeedbackMessageKey } from "./feedback-i18n-messages.en";

import {
  isFeedbackOptionalTextField,
  isFeedbackTextField,
  type FeedbackOptionalTextField,
  type FeedbackTextField,
} from "./feedback-options";

const FIELD_LABEL_KEYS: Readonly<Record<FeedbackDraftFieldIdV1, FeedbackMessageKey>> = {
  title: "feedback.form.summaryTitle",
  description: "feedback.form.summaryDescription",
  reproductionSteps: "feedback.form.steps",
  expectedBehavior: "feedback.form.expected",
  actualBehavior: "feedback.form.actual",
  productVersion: "feedback.form.productVersion",
  browserDescription: "feedback.disposition.field.browserDescription",
  handwrittenEvidence: "feedback.disposition.field.handwrittenEvidence",
};

const ACTION_LABEL_KEYS = {
  redacted: "feedback.disposition.action.redacted",
  quarantined: "feedback.disposition.action.quarantined",
  omitted: "feedback.disposition.action.omitted",
} as const satisfies Readonly<Record<FeedbackDispositionRecordV1["action"], FeedbackMessageKey>>;

const UNIT_LABEL_KEYS = {
  "quoted-segment": "feedback.disposition.unit.quotedSegment",
  "structured-value": "feedback.disposition.unit.structuredValue",
  "line-remainder": "feedback.disposition.unit.lineRemainder",
  "optional-field": "feedback.disposition.unit.optionalField",
  attachment: "feedback.disposition.unit.attachment",
} as const satisfies Readonly<Record<FeedbackDispositionRecordV1["unitKind"], FeedbackMessageKey>>;

function messageKey(record: FeedbackDispositionRecordV1): FeedbackMessageKey {
  if (record.action === "redacted" && record.reason === "complete-sensitive-span") {
    return "feedback.disposition.message.redacted";
  }
  if (record.action === "quarantined" && record.reason === "ambiguous-credential-structure") {
    return "feedback.disposition.message.quarantined";
  }
  if (record.action === "omitted" && record.reason === "no-safe-optional-content") {
    return "feedback.disposition.message.omitted";
  }
  return `feedback.disposition.message.${record.action}`;
}

function editableFields(
  records: readonly FeedbackDispositionRecordV1[],
): readonly FeedbackTextField[] {
  const fields: FeedbackTextField[] = [];
  for (const { target } of records) {
    if (
      target.kind === "draft-field" &&
      isFeedbackTextField(target.field) &&
      !fields.includes(target.field)
    ) {
      fields.push(target.field);
    }
  }
  return fields;
}

function affectedAttachmentOrdinals(
  records: readonly FeedbackDispositionRecordV1[],
): readonly number[] {
  const ordinals: number[] = [];
  for (const { target } of records) {
    if (target.kind === "attachment" && !ordinals.includes(target.ordinal)) {
      ordinals.push(target.ordinal);
    }
  }
  return ordinals;
}

function targetLabel(record: FeedbackDispositionRecordV1, t: FeedbackTranslate): string {
  return record.target.kind === "draft-field"
    ? t(FIELD_LABEL_KEYS[record.target.field])
    : t("feedback.disposition.field.attachment", { ordinal: record.target.ordinal + 1 });
}

function targetKey(record: FeedbackDispositionRecordV1): string {
  return record.target.kind === "draft-field"
    ? `field:${record.target.field}`
    : `attachment:${String(record.target.ordinal)}`;
}

function editLabel(field: FeedbackTextField, t: FeedbackTranslate): string {
  if (field === "browserDescription") return t("feedback.disposition.edit.browserDescription");
  if (field === "handwrittenEvidence") {
    return t("feedback.disposition.edit.handwrittenEvidence");
  }
  return t("feedback.disposition.edit", { field: t(FIELD_LABEL_KEYS[field]) });
}

function removeLabel(field: FeedbackOptionalTextField, t: FeedbackTranslate): string {
  return field === "browserDescription"
    ? t("feedback.disposition.remove.browserDescription")
    : t("feedback.disposition.remove.handwrittenEvidence");
}

export function FeedbackDispositionNotices({
  records,
  disabled,
  onEditField,
  onRemoveOptionalField,
  onReviewAttachment,
}: {
  readonly records: readonly FeedbackDispositionRecordV1[];
  readonly disabled: boolean;
  readonly onEditField: (field: FeedbackTextField) => void;
  readonly onRemoveOptionalField: (field: FeedbackOptionalTextField) => void;
  readonly onReviewAttachment: (ordinal: number) => void;
}): ReactNode {
  const t = useFeedbackTranslate();
  const headingId = useId();
  if (records.length === 0) return null;
  const fields = editableFields(records);
  const attachmentOrdinals = affectedAttachmentOrdinals(records);

  return (
    <section className="feedback-disposition-region" aria-labelledby={headingId}>
      <h3 id={headingId}>{t("feedback.disposition.region")}</h3>
      <p className="feedback-body">{t("feedback.disposition.description")}</p>
      <ul className="feedback-disposition-list">
        {records.map((record, index) => (
          <li
            key={`${record.action}:${record.reason}:${record.unitKind}:${targetKey(record)}:${String(index)}`}
            className="feedback-disposition-item"
          >
            <p className="feedback-disposition-message">
              {t(messageKey(record), { field: targetLabel(record, t) })}
            </p>
            <div className="feedback-disposition-meta">
              <span className="feedback-disposition-badge" data-action={record.action}>
                {t(ACTION_LABEL_KEYS[record.action])}
              </span>
              <span className="feedback-disposition-unit">
                {t(UNIT_LABEL_KEYS[record.unitKind])}
              </span>
            </div>
          </li>
        ))}
      </ul>
      <div className="feedback-actions">
        {fields.map((field) => (
          <Fragment key={field}>
            <button
              className="feedback-secondary-action"
              type="button"
              disabled={disabled}
              onClick={() => onEditField(field)}
            >
              {editLabel(field, t)}
            </button>
            {isFeedbackOptionalTextField(field) ? (
              <button
                className="feedback-secondary-action"
                type="button"
                disabled={disabled}
                onClick={() => onRemoveOptionalField(field)}
              >
                {removeLabel(field, t)}
              </button>
            ) : null}
          </Fragment>
        ))}
        {attachmentOrdinals.map((ordinal) => (
          <button
            key={ordinal}
            className="feedback-secondary-action"
            type="button"
            disabled={disabled}
            onClick={() => onReviewAttachment(ordinal)}
          >
            {t("feedback.disposition.reviewAttachment", { ordinal: ordinal + 1 })}
          </button>
        ))}
      </div>
    </section>
  );
}
