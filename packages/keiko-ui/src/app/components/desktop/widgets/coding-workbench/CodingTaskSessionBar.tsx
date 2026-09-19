"use client";
import type { ReactNode } from "react";
import type { CodingTaskSession } from "./useCodingTaskSession";
import { useCodingWorkbenchTranslate } from "./coding-workbench-i18n";
import { SafeMarkdownBoundary } from "../../SafeMarkdown";
import { Icons } from "../../Icons";
import styles from "./CodingHistory.module.css";

interface SessionBarProps {
  readonly session: CodingTaskSession;
  readonly active: boolean;
  readonly onHistory: () => void;
}

function TaskSessionActions({ session, active, onHistory }: SessionBarProps): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const locked = active || session.pending;
  const actions = [
    {
      label: t("codingWorkbench.history.title"),
      icon: Icons.codingHistory,
      run: onHistory,
      disabled: false,
    },
    {
      label: t("codingWorkbench.history.finish"),
      icon: Icons.check,
      run: (): void => void session.finish(),
      disabled: locked || session.detail === null,
    },
    {
      label: t("codingWorkbench.history.new"),
      icon: Icons.plus,
      run: (): void => void session.newTask(),
      disabled: locked,
    },
  ];
  return (
    <div className={styles.cmpSessionActions}>
      {actions.map(({ label, icon: Icon, run, disabled }) => (
        <button
          key={label}
          className={styles.cmpSessionAction}
          type="button"
          onClick={run}
          disabled={disabled}
          aria-label={label}
          title={label}
        >
          <Icon />
        </button>
      ))}
    </div>
  );
}

export function CodingTaskSessionBar(props: SessionBarProps): ReactNode {
  const { session } = props;
  const t = useCodingWorkbenchTranslate();
  if (session.detail === null && !session.pending && !session.error) return null;
  return (
    <div className={styles.cmpSessionBar}>
      {session.detail !== null ? (
        <>
          <span className={styles.cmpSessionIdentity} title={session.detail.task.title}>
            {session.detail.task.title}
          </span>
          <TaskSessionActions {...props} />
        </>
      ) : null}
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
