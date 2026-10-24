"use client";
import type { ReactNode } from "react";
import { useCodingWorkbenchTranslate } from "./coding-workbench-i18n";
import type { CodingTaskForkSource } from "./useCodingTaskSession";
import { Icons } from "../../Icons";
import styles from "./CodingHistory.module.css";

const BranchIcon = Icons.branch;

/**
 * Tells the person that the next message starts a new task forked from the one on display, and lets
 * them take it back. The fork is the person's own request (S03): nothing starts it, and the task it
 * forks is never changed.
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
      <span className={styles.cmpForkNoticeText}>
        {t(
          fork.beforeMessageId === undefined
            ? "codingWorkbench.history.forkNotice"
            : "codingWorkbench.history.forkNoticeBefore",
          { title: fork.title },
        )}
      </span>
      <button type="button" className={styles.cmpForkNoticeCancel} onClick={onCancel}>
        {t("codingWorkbench.history.forkCancel")}
      </button>
    </output>
  );
}
