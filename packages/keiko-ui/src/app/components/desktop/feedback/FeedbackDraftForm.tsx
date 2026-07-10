"use client";

import { useId, type FormEvent, type ReactNode, type RefObject } from "react";

import type { FeedbackBrowserDraftV1 } from "@/lib/feedback-api";
import { useFeedbackTranslate, type FeedbackTranslate } from "./feedback-i18n";

import { FeedbackAttachments } from "./FeedbackAttachments";
import type {
  FeedbackAttachmentStagingError,
  StagedFeedbackAttachment,
} from "./feedback-attachment-staging";
import {
  CATEGORY_OPTIONS,
  FEATURE_OPTIONS,
  FEEDBACK_TEXT_FIELDS,
  IMPACT_OPTIONS,
  PLATFORM_OPTIONS,
  type FeedbackSelectField,
  type FeedbackSelectOption,
  type FeedbackOptionalTextField,
  type FeedbackTextControlElement,
  type FeedbackTextField,
} from "./feedback-options";

function TextControl({
  field,
  label,
  multiline,
  value,
  required,
  disabled,
  invalid,
  errorId,
  onControlRef,
  onChange,
}: {
  readonly field: FeedbackTextField;
  readonly label: string;
  readonly multiline: boolean;
  readonly value: string;
  readonly required: boolean;
  readonly disabled: boolean;
  readonly invalid: boolean;
  readonly errorId: string;
  readonly onControlRef: (
    field: FeedbackTextField,
    node: FeedbackTextControlElement | null,
  ) => void;
  readonly onChange: (field: FeedbackTextField, value: string) => void;
}): ReactNode {
  const id = useId();
  const common = {
    id,
    className: "feedback-control",
    required,
    disabled,
    value,
    "aria-invalid": invalid || undefined,
    "aria-describedby": invalid ? errorId : undefined,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      onChange(field, event.currentTarget.value),
  };
  return (
    <div className="feedback-field">
      <label htmlFor={id}>{label}</label>
      {multiline ? (
        <textarea {...common} ref={(node) => onControlRef(field, node)} rows={3} />
      ) : (
        <input {...common} ref={(node) => onControlRef(field, node)} type="text" />
      )}
    </div>
  );
}

function SelectControl({
  label,
  value,
  options,
  disabled,
  t,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly options: readonly FeedbackSelectOption[];
  readonly disabled: boolean;
  readonly t: FeedbackTranslate;
  readonly onChange: (value: string) => void;
}): ReactNode {
  const id = useId();
  return (
    <div className="feedback-field">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        className="feedback-control"
        disabled={disabled}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {t(option.label)}
          </option>
        ))}
      </select>
    </div>
  );
}

function ClassificationFields({
  draft,
  disabled,
  onChange,
}: {
  readonly draft: FeedbackBrowserDraftV1;
  readonly disabled: boolean;
  readonly onChange: (field: FeedbackSelectField, value: string) => void;
}): ReactNode {
  const t = useFeedbackTranslate();
  return (
    <div className="feedback-grid">
      <SelectControl
        label={t("feedback.form.category")}
        value={draft.category}
        options={CATEGORY_OPTIONS}
        disabled={disabled}
        t={t}
        onChange={(value) => onChange("category", value)}
      />
      <SelectControl
        label={t("feedback.form.platform")}
        value={draft.platform}
        options={PLATFORM_OPTIONS}
        disabled={disabled}
        t={t}
        onChange={(value) => onChange("platform", value)}
      />
      <SelectControl
        label={t("feedback.form.featureArea")}
        value={draft.featureArea}
        options={FEATURE_OPTIONS}
        disabled={disabled}
        t={t}
        onChange={(value) => onChange("featureArea", value)}
      />
      <SelectControl
        label={t("feedback.form.impact")}
        value={draft.impact}
        options={IMPACT_OPTIONS}
        disabled={disabled}
        t={t}
        onChange={(value) => onChange("impact", value)}
      />
    </div>
  );
}

export function FeedbackDraftForm({
  draft,
  busy,
  locked,
  error,
  errorTarget,
  attachments,
  attachmentError,
  removedAttachmentOrdinal,
  optionalRemovalStatus,
  attachmentInputRef,
  attachmentBusy,
  headingRef,
  onControlRef,
  onTextChange,
  onSelectChange,
  onAttachmentControlRef,
  onAttachmentFiles,
  onRemoveAttachment,
  onSubmit,
}: {
  readonly draft: FeedbackBrowserDraftV1;
  readonly busy: boolean;
  readonly locked: boolean;
  readonly error: string | undefined;
  readonly errorTarget: FeedbackTextField | "attachments" | undefined;
  readonly attachments: readonly StagedFeedbackAttachment[];
  readonly attachmentError: FeedbackAttachmentStagingError | undefined;
  readonly removedAttachmentOrdinal: number | undefined;
  readonly optionalRemovalStatus: FeedbackOptionalTextField | undefined;
  readonly attachmentInputRef: RefObject<HTMLInputElement>;
  readonly attachmentBusy: boolean;
  readonly headingRef: RefObject<HTMLHeadingElement>;
  readonly onControlRef: (
    field: FeedbackTextField,
    node: FeedbackTextControlElement | null,
  ) => void;
  readonly onTextChange: (field: FeedbackTextField, value: string) => void;
  readonly onSelectChange: (field: FeedbackSelectField, value: string) => void;
  readonly onAttachmentControlRef: (index: number, node: HTMLButtonElement | null) => void;
  readonly onAttachmentFiles: (files: readonly File[]) => void;
  readonly onRemoveAttachment: (index: number) => void;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}): ReactNode {
  const t = useFeedbackTranslate();
  const errorId = useId();
  const disabled = busy || attachmentBusy || locked;
  return (
    <form className="feedback-form" aria-busy={busy || undefined} onSubmit={onSubmit}>
      <header>
        <h2 ref={headingRef} className="feedback-heading" tabIndex={-1}>
          {t("feedback.form.title")}
        </h2>
        <p className="feedback-body">{t("feedback.form.description")}</p>
      </header>
      <ClassificationFields draft={draft} disabled={disabled} onChange={onSelectChange} />
      {FEEDBACK_TEXT_FIELDS.map(([field, label, multiline, required]) => (
        <TextControl
          key={field}
          field={field}
          label={t(label)}
          multiline={multiline}
          value={draft[field] ?? ""}
          required={required}
          disabled={disabled}
          invalid={errorTarget === field}
          errorId={errorId}
          onControlRef={onControlRef}
          onChange={onTextChange}
        />
      ))}
      <FeedbackAttachments
        attachments={attachments}
        error={attachmentError}
        removedOrdinal={removedAttachmentOrdinal}
        inputRef={attachmentInputRef}
        disabled={disabled}
        preparationErrorId={errorTarget === "attachments" ? errorId : undefined}
        onControlRef={onAttachmentControlRef}
        onAddFiles={onAttachmentFiles}
        onRemove={onRemoveAttachment}
      />
      {optionalRemovalStatus === undefined ? null : (
        <p className="feedback-status" role="status">
          {t(
            optionalRemovalStatus === "browserDescription"
              ? "feedback.form.removed.browserDescription"
              : "feedback.form.removed.handwrittenEvidence",
          )}
        </p>
      )}
      {error === undefined ? null : (
        <p id={errorId} className="feedback-error" role="alert">
          {error}
        </p>
      )}
      <p
        className="feedback-scan-status"
        aria-live="polite"
        aria-atomic="true"
        data-feedback-scanning-status
        data-testid="feedback-scanning-status"
      >
        {busy ? t("feedback.form.scanning") : ""}
      </p>
      <button className="feedback-primary-action" type="submit" disabled={disabled}>
        {busy ? t("feedback.form.scanning") : t("feedback.form.scan")}
      </button>
    </form>
  );
}
