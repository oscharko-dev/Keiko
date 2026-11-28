"use client";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { CodingTaskSession } from "./useCodingTaskSession";
import { transcriptShows, type ShownRun } from "./codingWorkbenchRestoredRun";
import { useCodingWorkbenchTranslate } from "./coding-workbench-i18n";
import { SafeMarkdownBoundary } from "../../SafeMarkdown";
import { JiraChatTools } from "../../JiraChatTools";
import { CODING_WORKBENCH_RICH_CONTENT } from "./CodingWorkbenchRichContent";
import { Icons } from "../../Icons";
import { useHeldNotice } from "./codingWorkbenchPairingHold";
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

// A completed task on display is complete already: its next message reopens it (#4491).
function finishActions(
  session: CodingTaskSession,
  locked: boolean,
  t: ReturnType<typeof useCodingWorkbenchTranslate>,
): readonly SessionAction[] {
  if (session.detail?.task.status === "completed") return [];
  return [
    {
      label: t("codingWorkbench.history.finish"),
      icon: Icons.check,
      run: (): void => void session.finish(),
      disabled: locked || session.detail === null,
    },
  ];
}

// #4491: Complete task and New task disable or unmount the button that was just activated, which
// dropped the keyboard focus to the page. The composer is where the person types next.
const COMPOSER_ID = "coding-workbench-task-intent";

// Focus moves once the action has settled and the page shows its outcome: to the composer after a
// success, to the Try again control after a failure, where Finish and Try again are still offered.
// A click arms the wait and the action raises `pending` in the same event: a commit that sees it
// rise starts the wait. An action that settles without any such commit was an early return, which
// disarms, so a later unrelated pending change never steals the focus.
function useFocusAfterAction(
  session: CodingTaskSession,
  retryRef: RefObject<HTMLButtonElement | null>,
): (action: () => Promise<void>) => Promise<void> {
  const phase = useRef<"idle" | "armed" | "waiting">("idle");
  const { pending, error } = session;
  useEffect(() => {
    if (phase.current === "armed") {
      phase.current = pending ? "waiting" : "idle";
      return;
    }
    if (phase.current !== "waiting" || pending) return;
    phase.current = "idle";
    if (error) {
      retryRef.current?.focus();
      return;
    }
    const composer = document.getElementById(COMPOSER_ID);
    if (composer instanceof HTMLElement && !composer.hasAttribute("disabled")) composer.focus();
  });
  return (action) => {
    phase.current = "armed";
    return action().finally(() => {
      if (phase.current === "armed") phase.current = "idle";
    });
  };
}

function sessionActions(
  session: CodingTaskSession,
  active: boolean,
  onHistory: () => void,
  t: ReturnType<typeof useCodingWorkbenchTranslate>,
): readonly SessionAction[] {
  const locked = active || session.pending;
  const history = {
    label: t("codingWorkbench.history.title"),
    icon: Icons.codingHistory,
    run: onHistory,
    disabled: false,
  };
  const created = {
    label: t("codingWorkbench.history.new"),
    icon: Icons.plus,
    run: (): void => void session.newTask(),
    disabled: locked,
  };
  // A task that could not be read has nothing to fork, continue or complete: the way out is Coding
  // History or a new task.
  if (session.detail === null) return [history, created];
  return [
    history,
    {
      label: t("codingWorkbench.history.fork"),
      icon: Icons.branch,
      run: (): void => {
        session.beginFork();
      },
      disabled: locked || session.fork !== null,
    },
    ...continueActions(session, locked, t),
    ...finishActions(session, locked, t),
    created,
  ];
}

function TaskSessionActions({ session, active, onHistory }: SessionBarProps): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const actions = sessionActions(session, active, onHistory, t);
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

function RetryButton({
  retry,
  buttonRef,
}: {
  readonly retry: (() => void) | undefined;
  readonly buttonRef: RefObject<HTMLButtonElement | null>;
}): ReactNode {
  const t = useCodingWorkbenchTranslate();
  if (retry === undefined) return null;
  return (
    <button
      ref={buttonRef}
      type="button"
      className={styles.cmpMessageFork}
      onClick={retry}
    >
      {t("codingWorkbench.history.retry")}
    </button>
  );
}

export function CodingTaskSessionBar(props: SessionBarProps): ReactNode {
  const { session } = props;
  const t = useCodingWorkbenchTranslate();
  const retryRef = useRef<HTMLButtonElement | null>(null);
  const awaitFocus = useFocusAfterAction(session, retryRef);
  // #3880: an unpaired window cannot read its task; the run status sentence says why.
  const errorHeld = useHeldNotice("task-session", session.error);
  const error = session.error && !errorHeld;
  if (session.detail === null && !session.pending && !error) return null;
  const marked: CodingTaskSession = {
    ...session,
    finish: () => awaitFocus(session.finish),
    newTask: () => awaitFocus(session.newTask),
  };
  return (
    <div className={styles.cmpSessionBar}>
      {session.detail !== null ? (
        <span className={styles.cmpSessionIdentity} title={session.detail.task.title}>
          {session.detail.task.title}
        </span>
      ) : null}
      {session.detail !== null || error ? <TaskSessionActions {...props} session={marked} /> : null}
      {error ? (
        <>
          <p role="alert">{t("codingWorkbench.history.error")}</p>
          <RetryButton retry={session.retry} buttonRef={retryRef} />
        </>
      ) : null}
      {session.pending ? <output>{t("codingWorkbench.history.loading")}</output> : null}
    </div>
  );
}

// The previous conversation: every message of the task except the part of the shown run's
// conversation the timeline already carries (#3876 review). Stored tool results remain here even
// when that message's text is in the timeline: the safe activity feed carries no durable receipts.
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
    session.detail?.messages.filter(
      (message) =>
        transcriptShows(shownRun, message) || (message.toolTranscript?.exchanges.length ?? 0) > 0,
    ) ?? [];
  if (messages.length === 0) return null;
  // Keyed by task: another task starts again from its newest window.
  return (
    <TranscriptMessages
      key={session.detail?.task.id}
      messages={messages}
      shownRun={shownRun}
      truncated={session.detail?.truncated === true}
      onFork={onFork}
    />
  );
}

type TranscriptMessage = NonNullable<CodingTaskSession["detail"]>["messages"][number];

function TranscriptMessages({
  messages,
  shownRun,
  truncated,
  onFork,
}: {
  readonly messages: readonly TranscriptMessage[];
  readonly shownRun: ShownRun | undefined;
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
        <TranscriptMessageCard
          key={message.id}
          message={message}
          showText={transcriptShows(shownRun, message)}
          onFork={onFork}
        />
      ))}
    </section>
  );
}

// A scheduled wake's intent is the prompt the task's model scheduled (#4271), never the person's.
function transcriptAuthor(
  message: TranscriptMessage,
):
  | "codingWorkbench.history.you"
  | "codingWorkbench.history.agent"
  | "codingWorkbench.history.keiko"
  | "codingWorkbench.history.scheduled" {
  if (message.role !== "user") return "codingWorkbench.history.agent";
  // A turn Keiko dispatched itself (#4491) is never labelled as the person's own message.
  if (message.taskType === "keiko-continuation") return "codingWorkbench.history.keiko";
  return message.taskType === "scheduled-continuation"
    ? "codingWorkbench.history.scheduled"
    : "codingWorkbench.history.you";
}

// #4491: a turn Keiko dispatched itself is a collapsed note labelled as Keiko's, never the person's
// own message, and it offers no fork: the person did not write it.
function KeikoTranscriptNote({
  message,
  showText,
}: {
  readonly message: TranscriptMessage;
  readonly showText: boolean;
}): ReactNode {
  const t = useCodingWorkbenchTranslate();
  return (
    <article className={styles.cmpMessage} data-role="user" data-origin="keiko">
      {showText ? (
        <details>
          <summary>{t("codingWorkbench.history.keiko")}</summary>
          <SafeMarkdownBoundary
            source={message.content}
            diagnosticMessageId={message.id}
            richContent={undefined}
          />
        </details>
      ) : null}
    </article>
  );
}

function TranscriptMessageCard({
  message,
  showText,
  onFork,
}: {
  readonly message: TranscriptMessage;
  readonly showText: boolean;
  readonly onFork?: ((messageId: string) => void) | undefined;
}): ReactNode {
  const t = useCodingWorkbenchTranslate();
  if (message.role === "user" && message.taskType === "keiko-continuation")
    return <KeikoTranscriptNote message={message} showText={showText} />;
  return (
    <article className={styles.cmpMessage} data-role={message.role}>
      {showText ? (
        <>
          <strong>{t(transcriptAuthor(message))}</strong>
          <SafeMarkdownBoundary
            source={message.content}
            diagnosticMessageId={message.id}
            richContent={message.role === "user" ? undefined : CODING_WORKBENCH_RICH_CONTENT}
          />
        </>
      ) : null}
      <JiraChatTools
        transcript={message.toolTranscript}
        chatId={message.chatId}
        messageId={message.id}
        turnState={message.turnState}
      />
      {showText && message.role === "user" && onFork !== undefined ? (
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
