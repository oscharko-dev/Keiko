"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";

import {
  FeedbackPreviewPreparationError,
  FeedbackSecurityRoutingError,
  previewFeedbackReportV1,
  revalidateFeedbackReportV1,
  submitFeedbackReportV1,
  type FeedbackBrowserDraftV1,
  type PreparedFeedbackSnapshotV1,
} from "@/lib/feedback-api";
import { useFeedbackTranslate } from "./feedback-i18n";

import { FeedbackDraftForm } from "./FeedbackDraftForm";
import { FeedbackPreview } from "./FeedbackPreview";
import {
  feedbackPreparationRecovery,
  type FeedbackRecoveryTarget,
} from "./feedback-preparation-recovery";
import {
  openFeedbackPublicUrl,
  writeFeedbackClipboard,
  type FeedbackClipboardWriter,
  type FeedbackPublicOpener,
  type FeedbackRevalidator,
} from "./FeedbackPublicHandoff";
import { isRetryableSubmissionStep, type FeedbackSubmissionStep } from "./FeedbackSubmissionReview";
import {
  stageFeedbackAttachmentFiles,
  type FeedbackAttachmentStagingError,
  type StagedFeedbackAttachment,
} from "./feedback-attachment-staging";
import { FEEDBACK_SECURITY_ADVISORY_URL, FeedbackSecurityGate } from "./FeedbackSecurityGate";
import {
  initialFeedbackDraft,
  isFeedbackOptionalTextField,
  type FeedbackOptionalTextField,
  type FeedbackSelectField,
  type FeedbackTextControlElement,
  type FeedbackTextField,
} from "./feedback-options";

function withoutOptionalField(
  draft: FeedbackBrowserDraftV1,
  field: FeedbackOptionalTextField,
): FeedbackBrowserDraftV1 {
  if (field === "browserDescription") {
    const { browserDescription, ...remaining } = draft;
    void browserDescription;
    return remaining;
  }
  const { handwrittenEvidence, ...remaining } = draft;
  void handwrittenEvidence;
  return remaining;
}

export function FeedbackWindow({
  previewReport = previewFeedbackReportV1,
  submitReport = submitFeedbackReportV1,
  revalidateReport = revalidateFeedbackReportV1,
  writeClipboard = writeFeedbackClipboard,
  openPublic = openFeedbackPublicUrl,
}: {
  readonly previewReport?: typeof previewFeedbackReportV1 | undefined;
  readonly submitReport?: typeof submitFeedbackReportV1 | undefined;
  readonly revalidateReport?: FeedbackRevalidator | undefined;
  readonly writeClipboard?: FeedbackClipboardWriter | undefined;
  readonly openPublic?: FeedbackPublicOpener | undefined;
}): ReactNode {
  const t = useFeedbackTranslate();
  const [ordinary, setOrdinary] = useState(false);
  const [securityRouted, setSecurityRouted] = useState(false);
  const [draft, setDraft] = useState<FeedbackBrowserDraftV1>(initialFeedbackDraft);
  const [prepared, setPrepared] = useState<PreparedFeedbackSnapshotV1 | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [errorTarget, setErrorTarget] = useState<FeedbackRecoveryTarget | undefined>();
  const [attachments, setAttachments] = useState<readonly StagedFeedbackAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<
    FeedbackAttachmentStagingError | undefined
  >();
  const [removedAttachmentOrdinal, setRemovedAttachmentOrdinal] = useState<number | undefined>();
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [submissionStep, setSubmissionStep] = useState<FeedbackSubmissionStep>("review");
  const [submissionBusy, setSubmissionBusy] = useState(false);
  const [optionalRemovalStatus, setOptionalRemovalStatus] = useState<
    FeedbackOptionalTextField | undefined
  >();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const previewHeadingRef = useRef<HTMLHeadingElement>(null);
  const confirmationHeadingRef = useRef<HTMLHeadingElement>(null);
  const acceptedStatusRef = useRef<HTMLParagraphElement>(null);
  const securityAlertRef = useRef<HTMLElement>(null);
  const submissionResultRef = useRef<HTMLElement>(null);
  const submissionInFlightRef = useRef(false);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const attachmentControlRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const draftRevisionRef = useRef(0);
  const controlRefs = useRef<Partial<Record<FeedbackTextField, FeedbackTextControlElement | null>>>(
    {},
  );
  const registerControl = useCallback(
    (field: FeedbackTextField, node: FeedbackTextControlElement | null): void => {
      controlRefs.current[field] = node;
    },
    [],
  );
  const registerAttachmentControl = useCallback(
    (index: number, node: HTMLButtonElement | null): void => {
      attachmentControlRefs.current[index] = node;
    },
    [],
  );
  const focusField = useCallback((field: FeedbackTextField): void => {
    controlRefs.current[field]?.focus();
  }, []);
  useEffect(() => {
    if (!attachmentBusy && attachmentError !== undefined) attachmentInputRef.current?.focus();
  }, [attachmentBusy, attachmentError]);
  useEffect(() => {
    if (prepared !== undefined) previewHeadingRef.current?.focus();
  }, [prepared]);
  useEffect(() => {
    if (ordinary) headingRef.current?.focus();
  }, [ordinary]);
  useEffect(() => {
    if (busy || error === undefined) return;
    const target =
      errorTarget === "attachments"
        ? attachmentInputRef.current
        : errorTarget === undefined
          ? headingRef.current
          : controlRefs.current[errorTarget];
    target?.focus();
  }, [busy, error, errorTarget]);
  useEffect(() => {
    if (submissionStep === "confirm") confirmationHeadingRef.current?.focus();
    if (submissionStep === "accepted") acceptedStatusRef.current?.focus();
    if (isRetryableSubmissionStep(submissionStep) || submissionStep === "rejected") {
      submissionResultRef.current?.focus();
    }
  }, [submissionStep]);
  useEffect(() => {
    if (securityRouted) securityAlertRef.current?.focus();
  }, [securityRouted]);
  if (!ordinary) return <FeedbackSecurityGate onContinue={() => setOrdinary(true)} />;

  const clearPreviewState = (): void => {
    setPrepared(undefined);
    setError(undefined);
    setErrorTarget(undefined);
    setReviewed(false);
    setSubmissionStep("review");
  };
  const invalidatePreparedState = (): void => {
    draftRevisionRef.current += 1;
    clearPreviewState();
  };
  const routePrivately = (): void => {
    invalidatePreparedState();
    setSecurityRouted(true);
    setError(undefined);
  };
  const changeText = (field: FeedbackTextField, value: string): void => {
    if (submissionInFlightRef.current) return;
    setDraft((current) =>
      value.length === 0 && isFeedbackOptionalTextField(field)
        ? withoutOptionalField(current, field)
        : { ...current, [field]: value },
    );
    setOptionalRemovalStatus(undefined);
    setSecurityRouted(false);
    invalidatePreparedState();
  };
  const changeSelect = (field: FeedbackSelectField, value: string): void => {
    if (submissionInFlightRef.current) return;
    setDraft((current) => ({ ...current, [field]: value }) as FeedbackBrowserDraftV1);
    setOptionalRemovalStatus(undefined);
    setSecurityRouted(false);
    invalidatePreparedState();
  };
  const addAttachmentFiles = (files: readonly File[]): void => {
    if (busy || attachmentBusy || submissionInFlightRef.current) return;
    setAttachmentBusy(true);
    setAttachmentError(undefined);
    setRemovedAttachmentOrdinal(undefined);
    setOptionalRemovalStatus(undefined);
    invalidatePreparedState();
    void stageFeedbackAttachmentFiles(files, attachments)
      .then((result) => {
        if (!result.ok) {
          setAttachmentError(result.reason);
          return;
        }
        setAttachments((current) => Object.freeze([...current, ...result.value]));
      })
      .finally(() => setAttachmentBusy(false));
  };
  const removeAttachment = (index: number): void => {
    if (busy || attachmentBusy || submissionInFlightRef.current) return;
    const ordinal = index + 1;
    setAttachments((current) => Object.freeze(current.filter((_value, item) => item !== index)));
    setAttachmentError(undefined);
    setRemovedAttachmentOrdinal(ordinal);
    setOptionalRemovalStatus(undefined);
    invalidatePreparedState();
    attachmentInputRef.current?.focus();
  };
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (busy || attachmentBusy || submissionInFlightRef.current) return;
    setBusy(true);
    setSecurityRouted(false);
    clearPreviewState();
    const previewDraft: FeedbackBrowserDraftV1 = {
      ...draft,
      ...(attachments.length === 0
        ? {}
        : { attachments: attachments.map(({ envelope }) => envelope) }),
    };
    const requestDraftRevision = draftRevisionRef.current;
    void previewReport(previewDraft)
      .then((snapshot) => {
        if (draftRevisionRef.current !== requestDraftRevision) return;
        setPrepared(snapshot);
        setRemovedAttachmentOrdinal(undefined);
        setOptionalRemovalStatus(undefined);
      })
      .catch((cause: unknown) => {
        if (draftRevisionRef.current !== requestDraftRevision) return;
        setPrepared(undefined);
        if (cause instanceof FeedbackSecurityRoutingError) {
          routePrivately();
          return;
        }
        if (cause instanceof FeedbackPreviewPreparationError) {
          const recovery = feedbackPreparationRecovery(cause);
          setErrorTarget(recovery.target);
          setError(t(recovery.messageKey));
          return;
        }
        setError(t("feedback.form.scanError"));
      })
      .finally(() => setBusy(false));
  };
  const removeOptionalField = (field: FeedbackOptionalTextField): void => {
    if (submissionInFlightRef.current) return;
    setDraft((current) => withoutOptionalField(current, field));
    invalidatePreparedState();
    setOptionalRemovalStatus(field);
    focusField(field);
  };
  const continueToSubmission = (): void => {
    if (prepared === undefined || !reviewed || submissionBusy) return;
    setSubmissionStep("confirm");
  };
  const submitPrepared = (): void => {
    if (
      prepared === undefined ||
      !reviewed ||
      (submissionStep !== "confirm" && !isRetryableSubmissionStep(submissionStep)) ||
      submissionInFlightRef.current
    ) {
      return;
    }
    submissionInFlightRef.current = true;
    setSubmissionStep("confirm");
    setSubmissionBusy(true);
    void submitReport({
      canonicalJson: prepared.canonicalJson,
      exactBodySha256: prepared.exactBodySha256,
    })
      .then((outcome) => {
        setSubmissionStep(outcome.outcome);
      })
      .catch(() => setSubmissionStep("error"))
      .finally(() => {
        submissionInFlightRef.current = false;
        setSubmissionBusy(false);
      });
  };
  return (
    <div className="feedback-root">
      <aside className="feedback-security-route">
        <span>{t("feedback.security.eyebrow")}</span>
        <a
          className="feedback-secondary-action"
          href={FEEDBACK_SECURITY_ADVISORY_URL}
          target="_blank"
          rel="noreferrer"
        >
          {t("feedback.security.privateLink")}
        </a>
      </aside>
      {securityRouted ? (
        <section
          ref={securityAlertRef}
          className="feedback-security-route"
          role="alert"
          tabIndex={-1}
        >
          <span>{t("feedback.security.detected")}</span>
          <a
            className="feedback-secondary-action"
            href={FEEDBACK_SECURITY_ADVISORY_URL}
            target="_blank"
            rel="noreferrer"
          >
            {t("feedback.security.privateLink")}
          </a>
        </section>
      ) : null}
      <FeedbackDraftForm
        draft={draft}
        busy={busy}
        locked={submissionBusy}
        error={error}
        errorTarget={errorTarget}
        attachments={attachments}
        attachmentError={attachmentError}
        removedAttachmentOrdinal={removedAttachmentOrdinal}
        optionalRemovalStatus={optionalRemovalStatus}
        attachmentInputRef={attachmentInputRef}
        attachmentBusy={attachmentBusy}
        headingRef={headingRef}
        onControlRef={registerControl}
        onTextChange={changeText}
        onSelectChange={changeSelect}
        onAttachmentControlRef={registerAttachmentControl}
        onAttachmentFiles={addAttachmentFiles}
        onRemoveAttachment={removeAttachment}
        onSubmit={submit}
      />
      {prepared === undefined ? null : (
        <FeedbackPreview
          prepared={prepared}
          attachmentCount={attachments.length}
          headingRef={previewHeadingRef}
          submission={{
            reviewed,
            step: submissionStep,
            busy: submissionBusy,
            confirmationHeadingRef,
            acceptedStatusRef,
            resultRef: submissionResultRef,
            onReviewedChange: setReviewed,
            onContinue: continueToSubmission,
            onSubmit: submitPrepared,
            onEditAndRescan: () => focusField("title"),
          }}
          onEditField={focusField}
          onEditAndRescan={() => headingRef.current?.focus()}
          onRemoveOptionalField={removeOptionalField}
          onReviewAttachment={(ordinal) =>
            (attachmentControlRefs.current[ordinal] ?? attachmentInputRef.current)?.focus()
          }
          writeClipboard={writeClipboard}
          revalidateReport={revalidateReport}
          openPublic={openPublic}
          onPreparedInvalidated={(outcome) => {
            if (outcome === "security") routePrivately();
            else {
              invalidatePreparedState();
              setError(t("feedback.public.revalidationRejected"));
            }
          }}
        />
      )}
    </div>
  );
}
