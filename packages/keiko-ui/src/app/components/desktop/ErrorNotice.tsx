"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import { Icons } from "./Icons";
import { toUserErrorNotice, type UserErrorNotice } from "./format-error";
import { useTranslate } from "@/lib/i18n";

// PascalCase aliases so the JSX tag itself signals "component", not member access (S6770).
const CloseIcon = Icons.close;

interface ErrorNoticeProps {
  readonly error: unknown;
  readonly fallback: string;
  readonly className?: string | undefined;
  readonly id?: string | undefined;
  readonly onDismiss?: (() => void) | undefined;
}

function ErrorNotice({
  notice,
  className = "ui-error-notice",
  id,
  onDismiss,
}: {
  readonly notice: UserErrorNotice;
  readonly className?: string | undefined;
  readonly id?: string | undefined;
  readonly onDismiss?: (() => void) | undefined;
}): ReactNode {
  const t = useTranslate();
  // RB-6 / ADR-0173 D5 — correlationId is a user-visible field (the "Support ID" line), so it must
  // be part of the dismissal identity: without it, a later failure with the same title/message/code
  // but a NEW support id would still match a stale dismissedKey and stay hidden (#3241 review).
  const noticeKey = `${notice.title}\n${notice.message}\n${notice.code ?? ""}\n${notice.remediation ?? ""}\n${notice.correlationId ?? ""}`;
  const [dismissedKey, setDismissedKey] = useState<string | undefined>();
  if (dismissedKey === noticeKey) return null;
  return (
    <div id={id} className={className} role="alert" aria-live="assertive">
      <div className="ui-error-notice-title-row">
        <div className="ui-error-notice-title">{notice.title}</div>
        <button
          type="button"
          className="ui-error-notice-close"
          aria-label={t("common.dismissError")}
          title={t("common.dismissError")}
          onClick={() => {
            setDismissedKey(noticeKey);
            onDismiss?.();
          }}
        >
          <CloseIcon size={14} />
        </button>
      </div>
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

export function ErrorNoticeFromError({
  error,
  fallback,
  className,
  id,
  onDismiss,
}: ErrorNoticeProps): ReactNode {
  return (
    <ErrorNotice
      id={id}
      className={className}
      notice={toUserErrorNotice(error, fallback)}
      onDismiss={onDismiss}
    />
  );
}
