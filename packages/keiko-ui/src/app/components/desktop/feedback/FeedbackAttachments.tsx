"use client";

import { useId, type ChangeEvent, type ReactNode, type RefObject } from "react";

import { useFeedbackTranslate } from "./feedback-i18n";

import type {
  FeedbackAttachmentStagingError,
  StagedFeedbackAttachment,
} from "./feedback-attachment-staging";

function errorKey(reason: FeedbackAttachmentStagingError) {
  switch (reason) {
    case "count":
      return "feedback.attachment.error.count" as const;
    case "item":
      return "feedback.attachment.error.item" as const;
    case "aggregate":
      return "feedback.attachment.error.aggregate" as const;
    case "read":
      return "feedback.attachment.error.read" as const;
  }
}

export function FeedbackAttachments({
  attachments,
  error,
  removedOrdinal,
  inputRef,
  disabled,
  preparationErrorId,
  onControlRef,
  onAddFiles,
  onRemove,
}: {
  readonly attachments: readonly StagedFeedbackAttachment[];
  readonly error: FeedbackAttachmentStagingError | undefined;
  readonly removedOrdinal: number | undefined;
  readonly inputRef: RefObject<HTMLInputElement>;
  readonly disabled: boolean;
  readonly preparationErrorId: string | undefined;
  readonly onControlRef: (index: number, node: HTMLButtonElement | null) => void;
  readonly onAddFiles: (files: readonly File[]) => void;
  readonly onRemove: (index: number) => void;
}): ReactNode {
  const t = useFeedbackTranslate();
  const inputId = useId();
  const helpId = useId();
  const changeFiles = (event: ChangeEvent<HTMLInputElement>): void => {
    const input = event.currentTarget;
    const files = Array.from(input.files ?? []);
    input.value = "";
    if (files.length > 0) onAddFiles(files);
  };
  return (
    <section className="feedback-attachments" aria-labelledby={`${inputId}-heading`}>
      <h3 id={`${inputId}-heading`} className="feedback-attachments-heading">
        {t("feedback.attachment.title")}
      </h3>
      <p id={helpId} className="feedback-attachments-help">
        {t("feedback.attachment.help")}
      </p>
      <label className="feedback-attachments-heading" htmlFor={inputId}>
        {t("feedback.attachment.add")}
      </label>
      <input
        ref={inputRef}
        id={inputId}
        className="feedback-attachments-file-input"
        type="file"
        accept="text/*,application/json,.txt,.md,.json,.csv,.tsv,.yaml,.yml"
        aria-describedby={
          preparationErrorId === undefined ? helpId : `${helpId} ${preparationErrorId}`
        }
        aria-invalid={preparationErrorId === undefined ? undefined : true}
        disabled={disabled}
        multiple
        onChange={changeFiles}
      />
      {attachments.length === 0 ? null : (
        <ul className="feedback-attachments-list" aria-label={t("feedback.attachment.selected")}>
          {attachments.map((_attachment, index) => {
            const ordinal = index + 1;
            return (
              <li key={index} className="feedback-attachments-item">
                <span>{t("feedback.attachment.item", { ordinal })}</span>
                <button
                  ref={(node) => onControlRef(index, node)}
                  className="feedback-attachments-remove"
                  type="button"
                  disabled={disabled}
                  onClick={() => onRemove(index)}
                >
                  {t("feedback.attachment.remove", { ordinal })}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {error === undefined ? null : (
        <p className="feedback-attachments-message feedback-attachments-error" role="alert">
          {t(errorKey(error))}
        </p>
      )}
      {removedOrdinal === undefined ? null : (
        <p className="feedback-attachments-message feedback-attachments-status" role="status">
          {t("feedback.attachment.removed", { ordinal: removedOrdinal })}
        </p>
      )}
    </section>
  );
}
