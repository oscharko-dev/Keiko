"use client";
import type { ReactNode } from "react";
import { useCodingWorkbenchTranslate } from "./coding-workbench-i18n";
import type { CodingTaskForkSource, CodingTaskSession } from "./useCodingTaskSession";
import { Icons } from "../../Icons";
import styles from "./CodingHistory.module.css";

const BranchIcon = Icons.branch;
const CheckIcon = Icons.check;

/** The title of the completed task on display while no run is active: the next message reopens it. */
export function completedTaskTitle(
  session: CodingTaskSession,
  active: boolean,
): string | undefined {
  const task = session.detail?.task;
  return !active && session.fork === null && task?.status === "completed" ? task.title : undefined;
}

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
 * Without a fork, a completed task on display is named as such: the next message reopens it.
 */
export function CodingTaskForkNotice({
  fork,
  completed,
  onCancel,
}: {
  readonly fork: CodingTaskForkSource | null;
  readonly completed?: string | undefined;
  readonly onCancel: () => void;
}): ReactNode {
  const t = useCodingWorkbenchTranslate();
  if (fork === null && completed !== undefined)
    return (
      <output className={styles.cmpForkNotice}>
        <CheckIcon />
        <span className={styles.cmpForkNoticeText}>
          {t("codingWorkbench.history.completedNotice")}
        </span>
      </output>
    );
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
