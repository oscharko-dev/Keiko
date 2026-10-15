"use client";

import type { ReactNode } from "react";
import { useOptionalWidgetTranslate } from "@/lib/optional-widget-i18n";
import styles from "./ChatWindow.module.css";
import type { ChatDraftPersistence } from "./hooks/useChatDraft";

function hasVisibleDraftStatus(
  draft: string,
  persistence: ChatDraftPersistence | undefined,
): persistence is ChatDraftPersistence {
  return persistence !== undefined && (persistence.phase !== "saved" || draft.length > 0);
}

export function ChatDraftStatus({
  draft,
  persistence,
}: {
  readonly draft: string;
  readonly persistence: ChatDraftPersistence | undefined;
}): ReactNode {
  const t = useOptionalWidgetTranslate();
  if (!hasVisibleDraftStatus(draft, persistence)) return null;
  const { phase, pending, retry, keepLocal, restoreSaved } = persistence;
  const failed = phase === "failed" || phase === "unavailable";
  return (
    <div
      className={failed || phase === "conflict" ? styles.cmpDraftNotice : styles.cmpBatchModeLabel}
      role={failed || phase === "conflict" ? "alert" : "status"}
    >
      <span>{t(`chat.draft.${phase}`)}</span>
      {failed ? (
        <button
          type="button"
          className="cmp-voice-btn"
          disabled={pending}
          onClick={() => void retry()}
        >
          {t("chat.draft.retry")}
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
