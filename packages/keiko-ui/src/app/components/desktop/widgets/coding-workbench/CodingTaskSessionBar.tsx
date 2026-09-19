"use client";
import type { ReactNode } from "react";
import type { CodingTaskSession } from "./useCodingTaskSession";
import { useCodingWorkbenchTranslate } from "./coding-workbench-i18n";
import { SafeMarkdownBoundary } from "../../SafeMarkdown";
import styles from "./CodingHistory.module.css";

export function CodingTaskSessionBar({
  session,
  active,
  onHistory,
  workspacePath,
}: {
  readonly session: CodingTaskSession;
  readonly active: boolean;
  readonly onHistory: () => void;
  readonly workspacePath: string | null;
}): ReactNode {
  const t = useCodingWorkbenchTranslate();
  return (
    <div className={styles.cmpSessionBar}>
      <div className={styles.cmpSessionIdentity}>
        <strong>{session.detail?.task.title ?? t("codingWorkbench.history.new")}</strong>
        {session.detail !== null ? <span>{session.detail.task.branch}</span> : null}
        {workspacePath !== null ? (
          <details>
            <summary>{t("codingWorkbench.history.location")}</summary>
            <code>{workspacePath}</code>
          </details>
        ) : null}
      </div>
      <div className={styles.cmpSessionActions}>
        <button className={styles.cmpSecondary} type="button" onClick={onHistory}>
          {t("codingWorkbench.history.title")}
        </button>
        <button
          className={styles.cmpSecondary}
          type="button"
          disabled={active || session.pending || session.detail === null}
          onClick={() => void session.finish()}
        >
          {t("codingWorkbench.history.finish")}
        </button>
        <button
          className={styles.cmpPrimary}
          type="button"
          disabled={active || session.pending}
          onClick={() => void session.newTask()}
        >
          {t("codingWorkbench.history.new")}
        </button>
      </div>
      {session.error ? <p role="alert">{t("codingWorkbench.history.error")}</p> : null}
      {session.pending ? <output>{t("codingWorkbench.history.loading")}</output> : null}
    </div>
  );
}

export function CodingTaskTranscript({
  session,
  liveRunId,
}: {
  readonly session: CodingTaskSession;
  readonly liveRunId: string | undefined;
}): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const messages = session.detail?.messages.filter((message) => message.runId !== liveRunId) ?? [];
  if (messages.length === 0) return null;
  return (
    <section className={styles.cmpTranscript} aria-label={t("codingWorkbench.history.transcript")}>
      {session.detail?.truncated ? <output>{t("codingWorkbench.history.truncated")}</output> : null}
      {messages.map((message) => (
        <article className={styles.cmpMessage} key={message.id} data-role={message.role}>
          <strong>
            {t(
              message.role === "user"
                ? "codingWorkbench.history.you"
                : "codingWorkbench.history.agent",
            )}
          </strong>
          <SafeMarkdownBoundary
            source={message.content}
            applyScopeId={`coding-history:${message.id}`}
            diagnosticMessageId={message.id}
          />
        </article>
      ))}
    </section>
  );
}
