"use client";
import type { ReactNode } from "react";
import type { ChatToolWriteApprovalView } from "@oscharko-dev/keiko-contracts";
import { useOptionalWidgetTranslate as useTranslate } from "@/lib/optional-widget-i18n";
import styles from "./JiraAttachmentReview.module.css";

/**
 * The file a `jira.attach` approval covers, as the server read it when the approval was requested:
 * its name, size and digest — never its content. The server refuses the upload if the file no
 * longer matches, so this is exactly what the human approves.
 */
export function JiraAttachmentReview({
  approval,
}: {
  readonly approval: ChatToolWriteApprovalView;
}): ReactNode {
  const t = useTranslate();
  if (approval.kind !== "jira-chat-write" || approval.attachment === undefined) return null;
  const { name, sizeBytes, sha256 } = approval.attachment;
  return (
    <ul className={styles.facts} aria-label={t("chat.jira.writeApproval.preview")}>
      <li>{name}</li>
      <li>{`${new Intl.NumberFormat().format(sizeBytes)} B`}</li>
      <li className={styles.digest}>{`sha256 ${sha256}`}</li>
    </ul>
  );
}
