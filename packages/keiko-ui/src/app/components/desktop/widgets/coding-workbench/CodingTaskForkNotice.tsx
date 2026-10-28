"use client";
import type { ReactNode } from "react";
import { useCodingWorkbenchTranslate } from "./coding-workbench-i18n";
import type { CodingTaskForkSource } from "./useCodingTaskSession";
import { Icons } from "../../Icons";
import styles from "./CodingHistory.module.css";

const BranchIcon = Icons.branch;

// What the next message does: fork the task as it ended, before a message, or in another workspace.
function forkNoticeText(
  fork: CodingTaskForkSource,
  t: ReturnType<typeof useCodingWorkbenchTranslate>,
): string {
  if (fork.implicit === true)
    return t("codingWorkbench.history.importedNotice", { title: fork.title });
  if (fork.targetWorkspace !== undefined)
    return t("codingWorkbench.history.forkNoticeWorkspace", {
      title: fork.title,
      workspace: fork.targetWorkspace.name,
    });
  const key =
    fork.beforeMessageId === undefined
      ? "codingWorkbench.history.forkNotice"
      : "codingWorkbench.history.forkNoticeBefore";
  return t(key, { title: fork.title });
}

/**
 * Tells the person that the next message starts a new task forked from the one on display, and lets
 * them take it back. The fork is the person's own request (S03): nothing starts it, and the task it
 * forks is never changed. An imported task can only continue as a fork, so that one has no cancel.
 */
export function CodingTaskForkNotice({
  fork,
  onCancel,
}: {
  readonly fork: CodingTaskForkSource | null;
  readonly onCancel: () => void;
}): ReactNode {
  const t = useCodingWorkbenchTranslate();
  if (fork === null) return null;
  return (
    <output className={styles.cmpForkNotice}>
      <BranchIcon />
      <span className={styles.cmpForkNoticeText}>{forkNoticeText(fork, t)}</span>
      {fork.implicit === true ? null : (
        <button type="button" className={styles.cmpForkNoticeCancel} onClick={onCancel}>
          {t("codingWorkbench.history.forkCancel")}
        </button>
      )}
    </output>
  );
}
