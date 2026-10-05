"use client";

import { useId, useState } from "react";
import type { ReactNode } from "react";
import { Icons } from "./Icons";
import { toUserErrorNotice, type UserErrorNotice } from "./format-error";
import { SupportReportButton } from "./SupportReportButton";
import { useTranslate } from "@/lib/i18n";
import { clientErrorEvidence } from "@/lib/client-error-evidence";
import { bffRequestErrorKind } from "@/lib/http";
import type { ClientOnlySupportReportInput } from "@oscharko-dev/keiko-contracts/runtime/observability";

// PascalCase aliases so the JSX tag itself signals "component", not member access (S6770).
const CloseIcon = Icons.close;

interface ErrorNoticeProps {
  readonly error: unknown;
  readonly fallback: string;
  readonly className?: string | undefined;
  readonly id?: string | undefined;
  readonly onDismiss?: (() => void) | undefined;
  readonly dismissible?: boolean | undefined;
}

function ErrorNoticeDismiss({
  dismissible,
  label,
  onClick,
}: {
  readonly dismissible: boolean;
  readonly label: string;
  readonly onClick: () => void;
}): ReactNode {
  if (!dismissible) return null;
  return (
    <button
      type="button"
      className="ui-error-notice-close"
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <CloseIcon size={14} />
    </button>
  );
}

function ErrorNoticeReportAction({
  notice,
  noticeKey,
  failure,
}: {
  readonly notice: UserErrorNotice;
  readonly noticeKey: string;
  readonly failure: ClientOnlySupportReportInput["failure"];
}): ReactNode {
  return (
    <SupportReportButton
      key={noticeKey}
      correlationId={notice.correlationId}
      errorKey={noticeKey}
      failure={failure}
      clientOnly={notice.correlationId === undefined}
      disposeOnUnmount={notice.correlationId === undefined}
    />
  );
}

function noticeFailure(
  error: unknown,
  notice: UserErrorNotice,
): ClientOnlySupportReportInput["failure"] {
  const kind = bffRequestErrorKind(error);
  return {
    errorEvidence: clientErrorEvidence(error),
    errorKind: kind === "unknown" && notice.code === "BAD_REQUEST" ? "invalid-request" : kind,
    context: [],
  };
}

function NoticeText({ notice }: { readonly notice: UserErrorNotice }): ReactNode {
  const t = useTranslate();
  return (
    <div className="ui-error-notice-text" role="alert" aria-live="assertive">
      <div className="ui-error-notice-title">{notice.title}</div>
      <div className="ui-error-notice-message">{notice.message}</div>
      {notice.remediation !== undefined ? (
        <div className="ui-error-notice-remediation">{notice.remediation}</div>
      ) : null}
      {notice.code !== undefined ? (
        <div className="ui-error-notice-code mono">{notice.code}</div>
      ) : null}
      {notice.correlationId !== undefined ? (
        <div className="ui-error-notice-code mono">
          {t("chat.error.supportId", { correlationId: notice.correlationId })}
        </div>
      ) : null}
    </div>
  );
}

function ErrorNotice({
  notice,
  noticeKey,
  failure,
  className = "ui-error-notice",
  id,
  onDismiss,
  dismissible = true,
}: {
  readonly notice: UserErrorNotice;
  readonly noticeKey: string;
  readonly failure: ClientOnlySupportReportInput["failure"];
  readonly className?: string | undefined;
  readonly id?: string | undefined;
  readonly onDismiss?: (() => void) | undefined;
  readonly dismissible?: boolean | undefined;
}): ReactNode {
  const t = useTranslate();
  const [dismissedKey, setDismissedKey] = useState<string | undefined>();
  if (dismissedKey === noticeKey) return null;
  return (
    <div id={id} className={className}>
      <div className="ui-error-notice-title-row">
        <NoticeText notice={notice} />
        <ErrorNoticeDismiss
          dismissible={dismissible}
          label={t("common.dismissError")}
          onClick={() => {
            setDismissedKey(noticeKey);
            onDismiss?.();
          }}
        />
      </div>
      <ErrorNoticeReportAction notice={notice} noticeKey={noticeKey} failure={failure} />
    </div>
  );
}

function useNoticeOccurrence(error: unknown): string {
  const instance = useId();
  const [previous, setPrevious] = useState({ error, occurrence: 0 });
  if (!Object.is(previous.error, error)) {
    const occurrence = previous.occurrence + 1;
    setPrevious({ error, occurrence });
    return `${instance}:${occurrence}`;
  }
  return `${instance}:${previous.occurrence}`;
}

export function ErrorNoticeFromError({
  error,
  fallback,
  className,
  id,
  onDismiss,
  dismissible,
}: ErrorNoticeProps): ReactNode {
  const occurrence = useNoticeOccurrence(error);
  const notice = toUserErrorNotice(error, fallback);
  return (
    <ErrorNotice
      id={id}
      className={className}
      notice={notice}
      noticeKey={`${occurrence}:${notice.correlationId ?? ""}`}
      failure={noticeFailure(error, notice)}
      onDismiss={onDismiss}
      dismissible={dismissible}
    />
  );
}
