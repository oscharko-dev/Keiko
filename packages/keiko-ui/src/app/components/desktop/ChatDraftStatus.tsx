"use client";

import type { ReactNode } from "react";
import { useOptionalWidgetTranslate, type WidgetMessageKey } from "@/lib/optional-widget-i18n";
import styles from "./ChatWindow.module.css";
import type { ChatDraftPersistence } from "./hooks/useChatDraft";

function draftNoticeKey(
  persistence: ChatDraftPersistence | undefined,
): WidgetMessageKey | undefined {
  if (persistence === undefined) return undefined;
  const { phase, hasUnsavedChanges } = persistence;
  if (phase === "conflict") return "chat.draft.conflict";
  if (phase === "load-failed") {
    return hasUnsavedChanges ? "chat.draft.loadFailedUnsaved" : "chat.draft.loadFailed";
  }
  // A failed save stays visible until a successful read/save resolves it, even if later edits
  // happen to match the last acknowledged text. Hydration failures have their own phase.
  if (phase === "failed") return "chat.draft.failed";
  if (hasUnsavedChanges && phase === "unavailable") return "chat.draft.unavailable";
  return undefined;
}

export function ChatDraftStatus({
  persistence,
}: {
  readonly persistence: ChatDraftPersistence | undefined;
}): ReactNode {
  const t = useOptionalWidgetTranslate();
  const notice = draftNoticeKey(persistence);
  if (notice === undefined || persistence === undefined) return null;
  const { phase, pending, retry, keepLocal, restoreSaved } = persistence;
  const failed = phase === "failed" || phase === "unavailable" || phase === "load-failed";
  return (
    <div className={styles.cmpDraftNotice} role="alert">
      <span>{t(notice)}</span>
      {failed ? (
        <button
          type="button"
          className="cmp-voice-btn"
          disabled={pending}
          onClick={() => void retry()}
        >
          {t(phase === "load-failed" ? "chat.draft.retryLoad" : "chat.draft.retry")}
        </button>
      ) : null}
      {phase === "conflict" ? (
        <>
          <button
            type="button"
            className="cmp-voice-btn"
            disabled={pending}
            onClick={() => void keepLocal()}
          >
            {t("chat.draft.keepLocal")}
          </button>
          <button
            type="button"
            className="cmp-voice-btn"
            disabled={pending}
            onClick={() => void restoreSaved()}
          >
            {t("chat.draft.useSaved")}
          </button>
        </>
      ) : null}
    </div>
  );
}
