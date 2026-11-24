"use client";

import type { ReactNode } from "react";
import type {
  ChatClaimNotice,
  ChatToolContextElision,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import { useOptionalWidgetTranslate } from "@/lib/optional-widget-i18n";
import styles from "./ClaimNoticeLine.module.css";

/** One catalog sentence per closed marker value the server states (#4355). */
const SENTENCE_KEYS = {
  "no-jira-create": "chat.claimNotice.noJiraCreate",
  "no-jira-approval": "chat.claimNotice.noJiraApproval",
  "jira-report-not-generated": "chat.claimNotice.jiraReportNotGenerated",
  "tool-call-not-executed": "chat.claimNotice.toolCallNotExecuted",
} as const satisfies Record<ChatClaimNotice, string>;

/** The note as one plain string: what the line shows, and what a copy of the answer carries. */
export function useClaimNoticeText(notice: ChatClaimNotice | undefined): string | undefined {
  const translate = useOptionalWidgetTranslate();
  return notice === undefined
    ? undefined
    : `${translate("chat.claimNotice.label")}: ${translate(SENTENCE_KEYS[notice])}`;
}

/**
 * Keiko's note that older tool results reached the model only as a summary, so the conversation fit
 * its context window (owner decision 2026-11-24: shown, never silent). The full results stay listed.
 */
export function useContextElisionText(
  elision: ChatToolContextElision | undefined,
): string | undefined {
  const translate = useOptionalWidgetTranslate();
  if (elision === undefined) return undefined;
  const count = elision.elidedResultCount;
  const key = count === 1 ? "chat.contextElision.note.one" : "chat.contextElision.note.other";
  return `${translate("chat.claimNotice.label")}: ${translate(key, { count })}`;
}

/**
 * Keiko's own, visibly separate note under an answer that claims an effect its turn does not bear
 * out. The model's words above it stay exactly as written.
 */
export function ClaimNoticeLine({ text }: { readonly text: string | undefined }): ReactNode {
  if (text === undefined) return null;
  return (
    <p className={styles.cmpClaimNotice} data-claim-notice>
      {text}
    </p>
  );
}

/** The same quiet line for the context note; it states a fact about the turn, not the answer. */
export function ContextElisionLine({ text }: { readonly text: string | undefined }): ReactNode {
  if (text === undefined) return null;
  return (
    <p className={styles.cmpClaimNotice} data-context-elision>
      {text}
    </p>
  );
}
