"use client";
import { useState, type ReactNode } from "react";
import type { CodingTaskSession } from "./useCodingTaskSession";
import { transcriptShows, type ShownRun } from "./codingWorkbenchRestoredRun";
import { useCodingWorkbenchTranslate } from "./coding-workbench-i18n";
import { SafeMarkdownBoundary } from "../../SafeMarkdown";
import { CODING_WORKBENCH_RICH_CONTENT } from "./CodingWorkbenchRichContent";
import { Icons } from "../../Icons";
import styles from "./CodingHistory.module.css";

const BranchIcon = Icons.branch;

// A task can hold up to 200 messages of 64 KiB each (Coding History's bound). Mounting every one of
// them at once costs a long markdown parse for text nobody scrolled to, so only the newest are
// mounted; the earlier ones open on request, a window at a time.
export const TRANSCRIPT_WINDOW_MESSAGES = 40;

interface SessionBarProps {
  readonly session: CodingTaskSession;
  readonly active: boolean;
  readonly onHistory: () => void;
}

// A fork the person asked for holds the other fork actions; an imported task's implicit one does not.
function requestedFork(session: CodingTaskSession): boolean {
  return session.fork !== null && session.fork.implicit !== true;
}

// #3903 AC4: continue the task as a fork in a workspace provisioned from its own.
function continueActions(
  session: CodingTaskSession,
  locked: boolean,
  t: ReturnType<typeof useCodingWorkbenchTranslate>,
): readonly SessionAction[] {
  return session.forkTargets.map((target) => ({
    label: t("codingWorkbench.history.continueIn", { workspace: target.name }),
    icon: Icons.branch,
    run: (): void => void session.continueIn(target),
    disabled: locked || session.detail === null || requestedFork(session),
  }));
}

interface SessionAction {
  readonly label: string;
  readonly icon: (typeof Icons)[keyof typeof Icons];
  readonly run: () => void;
  readonly disabled: boolean;
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
      label: t("codingWorkbench.history.fork"),
      icon: Icons.branch,
      run: (): void => {
        session.beginFork();
      },
      disabled: locked || session.detail === null || session.fork !== null,
    },
    ...continueActions(session, locked, t),
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

// The previous conversation: every message of the task except the part of the shown run's
// conversation the timeline already carries (#3876 review). The messages of the shown run the
// timeline's feed could not hold stay here, so none is shown in neither place.
export function CodingTaskTranscript({
  session,
  shownRun,
  onFork,
}: {
  readonly session: CodingTaskSession;
  readonly shownRun: ShownRun | undefined;
  /** Forks the task just before a user message; absent while a run is active. */
  readonly onFork?: ((messageId: string) => void) | undefined;
}): ReactNode {
  const messages =
    session.detail?.messages.filter((message) => transcriptShows(shownRun, message)) ?? [];
  if (messages.length === 0) return null;
  // Keyed by task: another task starts again from its newest window.
  return (
    <TranscriptMessages
      key={session.detail?.task.id}
      messages={messages}
      truncated={session.detail?.truncated === true}
      onFork={onFork}
    />
  );
}

type TranscriptMessage = NonNullable<CodingTaskSession["detail"]>["messages"][number];

function TranscriptMessages({
  messages,
  truncated,
  onFork,
}: {
  readonly messages: readonly TranscriptMessage[];
  readonly truncated: boolean;
  readonly onFork?: ((messageId: string) => void) | undefined;
}): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const [windowSize, setWindowSize] = useState(TRANSCRIPT_WINDOW_MESSAGES);
  const hidden = Math.max(0, messages.length - windowSize);
  const shown = hidden === 0 ? messages : messages.slice(hidden);
  return (
    <section className={styles.cmpTranscript} aria-label={t("codingWorkbench.history.transcript")}>
      {truncated ? <output>{t("codingWorkbench.history.truncated")}</output> : null}
      {hidden > 0 ? (
        <button
          type="button"
          className={styles.cmpMessageFork}
          onClick={(): void => {
            setWindowSize((size) => size + TRANSCRIPT_WINDOW_MESSAGES);
          }}
        >
          {t("codingWorkbench.history.showEarlier", { count: hidden })}
        </button>
      ) : null}
      {shown.map((message) => (
        <TranscriptMessageCard key={message.id} message={message} onFork={onFork} />
      ))}
    </section>
  );
}

function TranscriptMessageCard({
  message,
  onFork,
}: {
  readonly message: TranscriptMessage;
  readonly onFork?: ((messageId: string) => void) | undefined;
}): ReactNode {
  const t = useCodingWorkbenchTranslate();
  return (
    <article className={styles.cmpMessage} data-role={message.role}>
      <strong>
        {t(
          message.role === "user" ? "codingWorkbench.history.you" : "codingWorkbench.history.agent",
        )}
      </strong>
      <SafeMarkdownBoundary
        source={message.content}
        diagnosticMessageId={message.id}
        richContent={message.role === "user" ? undefined : CODING_WORKBENCH_RICH_CONTENT}
      />
      {message.role === "user" && onFork !== undefined ? (
        <button
          type="button"
          className={styles.cmpMessageFork}
          onClick={(): void => {
            onFork(message.id);
          }}
        >
          <BranchIcon />
          {t("codingWorkbench.history.forkFrom")}
        </button>
      ) : null}
    </article>
  );
}
