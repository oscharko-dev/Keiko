/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- The virtualized overflow list and restored timeline heading need programmatic keyboard focus. */
"use client";

import {
  createContext,
  memo,
  useCallback,
  useContext,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type SyntheticEvent,
  type RefCallback,
  type RefObject,
  type UIEvent,
} from "react";
import type {
  AvailableCodingSafeActivityFeed,
  CodingSafeActivityMessage,
  CodingSafeActivityTextPart,
  CodingSafeActivityPlan,
  CodingSafeActivityProgramKind,
  CodingSafeActivityTool,
  CodingSafeActivityToolFailureOrigin,
  CodingWorkbenchRuntimeSseEvent,
} from "@oscharko-dev/keiko-contracts";
import type {
  CodingSafeActivityGitOutcome,
  CodingSafeActivityVerificationOutcome,
} from "@oscharko-dev/keiko-contracts/runtime/coding-safe-activity";

import type { UseCodingWorkbenchQuestionsResult } from "@/lib/useCodingWorkbenchQuestions";
import type { UseCodingWorkbenchSafeActivityResult } from "@/lib/useCodingWorkbenchSafeActivity";
import type {
  CodingWorkbenchAnswerText,
  CodingWorkbenchAnswers,
} from "@/lib/useCodingWorkbenchAnswers";
import { clientErrorEvidence } from "@/lib/client-error-evidence";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import {
  reportCodingWorkbenchSummaryActivated,
  reportCodingWorkbenchInteraction,
} from "@/lib/coding-workbench-interaction";
import { useLocale, type Locale } from "@/lib/i18n";
import { useFollowNewest } from "@/lib/useFollowNewest";
import { isActivityLogCorrelationId } from "@oscharko-dev/keiko-contracts/runtime/observability";
import { AnswerCopyButton, type AnswerCopyButtonLabels } from "../../AnswerCopyButton";
import { ListFollowContext } from "./CodingWorkbenchJumpToLatest";
import { SupportReportButton } from "../../SupportReportButton";
import { SafeMarkdownBoundary } from "../../SafeMarkdown";
import {
  useCodingWorkbenchTranslate,
  type CodingWorkbenchTranslate,
} from "./coding-workbench-i18n";
import type { CodingWorkbenchMessageKey } from "./coding-workbench-i18n.en";
import {
  eventDetail,
  eventOffersErrorReport,
  eventOffersRunCheck,
  eventTitle,
} from "./codingWorkbenchLabels";
import {
  formatRunDuration,
  modelGatewayRetrying,
  settledRunState,
} from "./codingWorkbenchRunFacts";
import { CodingWorkbenchQuestionsSurface } from "./CodingWorkbenchQuestions";
import { CODING_WORKBENCH_RICH_CONTENT } from "./CodingWorkbenchRichContent";
import { useHeldNotice } from "./codingWorkbenchPairingHold";
import styles from "./CodingWorkbenchWindow.module.css";
import { useSecondClock } from "./useSecondClock";
import {
  moveRowFocus,
  opensWithFailure,
  ToolCommandPreview,
  ToolDuration,
  ToolFailureExplanation,
  ToolFailureLabel,
  ToolOutputShortenedLabel,
  ToolTextDetail,
  toolFailureOrigin,
  toolGroupSummary,
} from "./CodingWorkbenchToolDetail";

// A long run's timeline windows its rows from about one screen and a half of them on.
const VIRTUAL_THRESHOLD = 60;
const VISIBLE_ROWS = 96;
const OVERSCAN_ROWS = 8;
// Known tool identifiers map to Coding Workbench catalog message keys, not to English strings —
// otherwise a German session would render English labels in the localized timeline. The keys are
// resolved through `t(...)` inside `ToolRow`. The native OpenCode tools (#3897) keep their own ids.
const KNOWN_TOOL_LABEL_KEYS: Readonly<Record<string, CodingWorkbenchMessageKey>> = {
  keiko_git_status: "codingWorkbench.timeline.tool.git_status",
  keiko_repository_search: "codingWorkbench.timeline.tool.repository_search",
  keiko_workspace_discover: "codingWorkbench.timeline.tool.workspace_discover",
  keiko_workspace_read: "codingWorkbench.timeline.tool.workspace_read",
  keiko_changeset_edit: "codingWorkbench.timeline.tool.changeset_edit",
  keiko_verification: "codingWorkbench.timeline.tool.verification",
  keiko_research_fetch: "codingWorkbench.timeline.tool.research_fetch",
  keiko_skill_discover: "codingWorkbench.timeline.tool.skill_discover",
  keiko_skill: "codingWorkbench.timeline.tool.keiko_skill",
  keiko_child_agent: "codingWorkbench.timeline.tool.child_agent",
  keiko_git_diff: "codingWorkbench.timeline.tool.git_diff",
  keiko_git_stage: "codingWorkbench.timeline.tool.git_stage",
  keiko_git_commit: "codingWorkbench.timeline.tool.git_commit",
  keiko_git_push: "codingWorkbench.timeline.tool.git_push",
  keiko_pull_request: "codingWorkbench.timeline.tool.pull_request",
  keiko_git_execute: "codingWorkbench.timeline.tool.git_execute",
  keiko_git_sync: "codingWorkbench.timeline.tool.git_sync",
  keiko_git_branch: "codingWorkbench.timeline.tool.git_branch",
  keiko_ci_status: "codingWorkbench.timeline.tool.ci_status",
  read: "codingWorkbench.timeline.tool.read",
  glob: "codingWorkbench.timeline.tool.glob",
  grep: "codingWorkbench.timeline.tool.grep",
  list: "codingWorkbench.timeline.tool.list",
  edit: "codingWorkbench.timeline.tool.edit",
  write: "codingWorkbench.timeline.tool.write",
  patch: "codingWorkbench.timeline.tool.patch",
  shell: "codingWorkbench.timeline.tool.shell",
  webfetch: "codingWorkbench.timeline.tool.webfetch",
  websearch: "codingWorkbench.timeline.tool.websearch",
  skill: "codingWorkbench.timeline.tool.skill",
  subagent: "codingWorkbench.timeline.tool.subagent",
  todo: "codingWorkbench.timeline.tool.todo",
  todowrite: "codingWorkbench.timeline.tool.todo",
  question: "codingWorkbench.timeline.tool.question",
  execute: "codingWorkbench.timeline.tool.execute",
  automation_create: "codingWorkbench.timeline.tool.execute_schedule",
  automation_pause: "codingWorkbench.timeline.tool.execute_schedule",
  automation_resume: "codingWorkbench.timeline.tool.execute_schedule",
  automation_delete: "codingWorkbench.timeline.tool.execute_schedule",
};
// Per-kind default heights used until a row has been rendered and measured. A single 64 px
// estimate (the pre-fix value) is 4–20x too small for plan cards and multi-segment messages,
// which is what makes scroll offsets drift on long feeds.
const ROW_HEIGHT_BY_KIND: Record<TimelineItemKind, number> = {
  message: 96,
  tool: 72,
  plan: 320,
  group: 40,
  event: 88,
};
const QUESTION_SUMMARY_STATES = new Set(["offline", "error", "stale", "unpaired"]);

type TimelineItemKind = "message" | "tool" | "plan" | "event" | "group";
type TurnFailureProgress = "active" | "gateway-retrying" | "finished" | "terminal";

type TimelineItem =
  | {
      readonly kind: "group";
      readonly id: string;
      readonly occurredAt: string;
      readonly order: number;
      readonly tools: readonly Extract<TimelineItem, { kind: "tool" }>[];
    }
  | {
      readonly kind: "message";
      readonly id: string;
      readonly occurredAt: string;
      readonly order: number;
      readonly message: CodingSafeActivityMessage;
      readonly runId: string;
      /**
       * The open message of a run that is generating (starting, running or paused): its answer may
       * still be streaming. An answer is not live once the run waits for a decision, however long
       * that takes, or once a tool call began after it.
       */
      readonly live: boolean;
    }
  | {
      readonly kind: "tool";
      readonly id: string;
      readonly occurredAt: string;
      readonly order: number;
      readonly tool: CodingSafeActivityTool;
      /** The run whose feed carried the call; a proposal reference is unique within one run only. */
      readonly runId?: string;
      readonly count: number;
      /**
       * A Git step the server answered as prepared and waiting for approval, after which the run
       * went on: a later step took it up, so it no longer waits for anyone (#4491).
       */
      readonly superseded?: boolean;
      /**
       * The single Git proposal this `keiko_git_execute` redeemed, as that proposal's own label: a
       * commit, stage or unstage reads as such instead of as a generic operation (U-49).
       */
      readonly redeemedLabel?: CodingWorkbenchMessageKey;
    }
  | {
      readonly kind: "plan";
      readonly id: string;
      readonly occurredAt: string;
      readonly order: number;
      readonly plan: CodingSafeActivityPlan;
      /** The run is active: its plan card stays open so the reader follows the steps live. */
      readonly open: boolean;
    }
  | {
      readonly kind: "event";
      readonly id: string;
      readonly occurredAt: string;
      readonly order: number;
      readonly event: CodingWorkbenchRuntimeSseEvent;
      readonly turnFailureProgress: TurnFailureProgress;
      /** A later check of the same verifier in the same run replaced this check's verdict. */
      readonly superseded: boolean;
    };

export interface CodingWorkbenchTimelineProps {
  readonly active?: boolean;
  /**
   * True while the run's model may still be producing text: the run is starting, running or
   * paused, not waiting for a decision or stopping. A paused run stays generating because pausing
   * aborts no call the run had already admitted, so its message may still grow (review thread
   * 6pyds7). Defaults to `active`; the Workbench passes the narrower fact, so an answer that is
   * finished keeps its code highlighting and Copy button while the run waits for the operator
   * (#3873 review).
   */
  readonly generating?: boolean;
  readonly events: readonly CodingWorkbenchRuntimeSseEvent[];
  readonly activity: UseCodingWorkbenchSafeActivityResult;
  readonly questions: UseCodingWorkbenchQuestionsResult;
  readonly focusRef?: RefObject<HTMLHeadingElement | null>;
  /**
   * Asks the task's model to run the project's check, as the person's own request. Present only
   * while a new request can be sent; the card of a run whose changes were not checked offers it
   * as "Run the check now" (#4491).
   */
  readonly onRunCheck?: (() => void) | undefined;
  /**
   * The id of the tool call the run's pending approval holds back (the ask's `callId`). While the
   * run waits for the person, exactly that call's row reads "Waiting for approval" instead of
   * "Running". Absent when no approval is pending or the ask names no call: no row is marked then,
   * so an ambiguous guess never mislabels a tool that is really running. Only the call that opened
   * the prompt is named: identical asks from other calls join it or queue behind it, and their
   * rows keep their feed state until their own ask is the one shown.
   */
  readonly awaitingApprovalCallId?: string | undefined;
  /** The run is paused for the repository's build-file trust decision (`workspace-script-trust`). */
  readonly pausedForTrust?: boolean | undefined;
}

// The action reaches the failure card through a context: the card sits several rows below the
// timeline, and none of those rows otherwise carries an action.
const RunCheckContext = createContext<(() => void) | undefined>(undefined);
// The call a pending approval holds back reaches the tool rows through a context for the same reason.
const AwaitingApprovalCallIdContext = createContext<string | undefined>(undefined);
// Whether the run is over, so no row can still be waiting for a decision.
const RunEndedContext = createContext(false);
// Whether the run is paused for the package-script trust decision: nothing executes then, so a call
// the feed still reports open reads as waiting for that decision, never as running.
const HeldForTrustContext = createContext(false);

// The complete answers read beside the bounded feed reach each message row the same way.
// The complete model texts read beside the bounded feed reach each message row the same way, with
// the reasoning blocks the person opened, so a row the virtual list remounts keeps its state.
interface ModelTextsView {
  readonly answers: CodingWorkbenchAnswers;
  readonly reasoning: CodingWorkbenchAnswers;
  readonly readReasoning: (messageId: string) => void;
  readonly retryText: (part: CodingSafeActivityTextPart, messageId: string) => void;
  readonly openReasoning: Set<string>;
}

const NO_ANSWERS: CodingWorkbenchAnswers = new Map();
const NO_MODEL_TEXTS: ModelTextsView = {
  answers: NO_ANSWERS,
  reasoning: NO_ANSWERS,
  readReasoning: () => undefined,
  retryText: () => undefined,
  openReasoning: new Set(),
};
const ModelTextsContext = createContext<ModelTextsView>(NO_MODEL_TEXTS);

function useModelTextsView(activity: UseCodingWorkbenchSafeActivityResult): ModelTextsView {
  const openReasoning = useRef(new Set<string>()).current;
  const { answers, reasoning, readReasoning, retryText } = activity;
  return useMemo(
    () => ({
      answers: answers ?? NO_ANSWERS,
      reasoning: reasoning ?? NO_ANSWERS,
      readReasoning: readReasoning ?? NO_MODEL_TEXTS.readReasoning,
      retryText: retryText ?? NO_MODEL_TEXTS.retryText,
      openReasoning,
    }),
    [answers, reasoning, readReasoning, retryText, openReasoning],
  );
}

// The heading the run's focus returns to: the window's own when it passes one, else this timeline's.
function useTitleRef(
  focusRef: RefObject<HTMLHeadingElement | null> | undefined,
): RefObject<HTMLHeadingElement | null> {
  const internalTitleRef = useRef<HTMLHeadingElement>(null);
  return focusRef ?? internalTitleRef;
}

export function Timeline({
  active = false,
  generating = active,
  events,
  activity,
  questions,
  focusRef,
  onRunCheck,
  awaitingApprovalCallId,
  pausedForTrust = false,
}: CodingWorkbenchTimelineProps): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const titleRef = useTitleRef(focusRef);
  const [showEvents, setShowEvents] = useState(false);
  const allItems = useTimelineItems(events, activity, generating, active);
  const items = useShownItems(allItems, showEvents);
  const timeline = useTimelineWindow(items, questions.questions);
  const attention = useShownActivityAttention(activity);
  const modelTexts = useModelTextsView(activity);
  if (!active && allItems.length + questions.questions.length === 0 && !attention) return null;
  return (
    <TimelineContexts
      onRunCheck={onRunCheck}
      awaitingApprovalCallId={awaitingApprovalCallId}
      runEnded={!active}
      heldForTrust={pausedForTrust}
      modelTexts={modelTexts}
    >
      <section className={styles.cmpConversation} aria-labelledby="timeline-title">
        <TimelineHeading titleRef={titleRef} t={t} />
        <ActivityStatus activity={activity} attention={attention} t={t} />
        <RunDetailsToggle
          visible={events.length > 0}
          expanded={showEvents}
          onToggle={() => setShowEvents(!showEvents)}
          t={t}
        />
        <QuestionSummary questions={questions} />
        <FirstStepWait waitKey={awaitedFirstStep(activity.feed, generating)} t={t} />
        <TimelineContent
          items={items}
          timeline={timeline}
          questions={questions}
          restoreFocusRef={titleRef}
          t={t}
        />
      </section>
    </TimelineContexts>
  );
}

// What the rows below read from the run instead of from their own props: the person's action on a
// failure card, the call a pending approval holds back, whether the run is over, and the model texts.
function TimelineContexts({
  onRunCheck,
  awaitingApprovalCallId,
  runEnded,
  heldForTrust,
  modelTexts,
  children,
}: {
  readonly onRunCheck: (() => void) | undefined;
  readonly awaitingApprovalCallId: string | undefined;
  readonly runEnded: boolean;
  readonly heldForTrust: boolean;
  readonly modelTexts: ModelTextsView;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <RunCheckContext.Provider value={onRunCheck}>
      <AwaitingApprovalCallIdContext.Provider value={awaitingApprovalCallId}>
        <RunEndedContext.Provider value={runEnded}>
          <HeldForTrustContext.Provider value={heldForTrust}>
            <ModelTextsContext.Provider value={modelTexts}>{children}</ModelTextsContext.Provider>
          </HeldForTrustContext.Provider>
        </RunEndedContext.Provider>
      </AwaitingApprovalCallIdContext.Provider>
    </RunCheckContext.Provider>
  );
}

/** After this long without the model's first step, the wait says the model is slow. */
const SLOW_FIRST_STEP_MS = 10_000;

// The turn whose first step the run still waits for: a generating run whose newest turn holds no
// answer and no tool call yet. Undefined once the model did something, or when nothing generates.
function awaitedFirstStep(
  feed: UseCodingWorkbenchSafeActivityResult["feed"],
  generating: boolean,
): string | undefined {
  if (!generating) return undefined;
  const turn = feed?.turns.at(-1);
  if (turn === undefined) return "run-start";
  const answered =
    turn.tools.length > 0 || turn.messages.some((message) => message.role === "assistant");
  return answered ? undefined : turn.turnId;
}

// A run between the person's request and the model's first step says it waits, and after ten
// seconds that the model is slow, so a quiet stream never reads as a stuck Workbench.
function FirstStepWait({
  waitKey,
  t,
}: {
  readonly waitKey: string | undefined;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  const [slowKey, setSlowKey] = useState<string | null>(null);
  useEffect(() => {
    if (waitKey === undefined) return undefined;
    const timer = setTimeout(() => {
      setSlowKey(waitKey);
    }, SLOW_FIRST_STEP_MS);
    return (): void => {
      clearTimeout(timer);
    };
  }, [waitKey]);
  if (waitKey === undefined) return null;
  return (
    <output className={styles.cmpFirstStepWait}>
      <span className={styles.cmpFirstStepPulse} aria-hidden="true" />
      {slowKey === waitKey
        ? t("codingWorkbench.activity.firstStep.slow")
        : t("codingWorkbench.activity.firstStep.waiting")}
    </output>
  );
}

// The rows shown: routine events stay behind the run details toggle, attention events never do.
function useShownItems(
  allItems: readonly TimelineItem[],
  showEvents: boolean,
): readonly TimelineItem[] {
  return useMemo(
    () =>
      groupCompletedTools(
        allItems.filter(
          (item) => showEvents || item.kind !== "event" || itemTone(item) === "attention",
        ),
      ),
    [allItems, showEvents],
  );
}

function TimelineHeading({
  titleRef,
  t,
}: {
  readonly titleRef: RefObject<HTMLHeadingElement | null>;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  return (
    <>
      <h3 className="sr-only" id="timeline-title" ref={titleRef} tabIndex={-1}>
        {t("codingWorkbench.timeline.title")}
      </h3>
      <p className="sr-only">{t("codingWorkbench.activity.reasoningBoundary")}</p>
    </>
  );
}

function RunDetailsToggle({
  visible,
  expanded,
  onToggle,
  t,
}: {
  readonly visible: boolean;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  if (!visible) return null;
  return (
    <button
      type="button"
      className={styles.cmpRunDetails}
      aria-expanded={expanded}
      onClick={() => {
        onToggle();
        reportCodingWorkbenchInteraction({
          interaction: "details-toggled",
          section: "run",
          expanded: !expanded,
        });
      }}
    >
      {t("codingWorkbench.timeline.details")}
    </button>
  );
}

// Only the open message of a generating run is live: its answer may still be streaming.
function useTimelineItems(
  events: readonly CodingWorkbenchRuntimeSseEvent[],
  activity: UseCodingWorkbenchSafeActivityResult,
  generating: boolean,
  active: boolean,
): readonly TimelineItem[] {
  const { feed, earlierFeeds } = activity;
  return useMemo(
    () =>
      timelineItems(
        events,
        feed,
        earlierFeeds ?? [],
        openMessageId(feed, generating),
        active ? (feed?.runId ?? events.at(-1)?.runId) : undefined,
      ),
    [events, feed, earlierFeeds, generating, active],
  );
}

// A turn failure describes that step. Only the latest failure of a settled failed run offers
// repair advice; an active run may recover natively. Automatic retry is claimed only from its fact.
function timelineEventItems(
  events: readonly CodingWorkbenchRuntimeSseEvent[],
  activeRunId: string | undefined,
): Extract<TimelineItem, { kind: "event" }>[] {
  const newestByRun = new Map<string, CodingWorkbenchRuntimeSseEvent>();
  const lastFailureByRun = new Map<string, string>();
  const lastCheckByVerifier = new Map<string, string>();
  for (const event of events) {
    newestByRun.set(event.runId, event);
    if (event.kind === "runtime-event" && event.eventKind === "failure-redacted") {
      lastFailureByRun.set(event.runId, event.cursor);
    }
    const verifier = verifierKey(event);
    if (verifier !== undefined) lastCheckByVerifier.set(verifier, event.cursor);
  }
  return events.map((event, index) => {
    const verifier = verifierKey(event);
    return {
      kind: "event",
      id: `event:${event.runId}:${event.cursor}`,
      occurredAt: event.occurredAt,
      order: index,
      event,
      turnFailureProgress: turnFailureProgress(
        event,
        newestByRun.get(event.runId),
        lastFailureByRun.get(event.runId),
        activeRunId,
      ),
      superseded: verifier !== undefined && lastCheckByVerifier.get(verifier) !== event.cursor,
    };
  });
}

// A check is replaced by the next check of the same verifier in the same run: a failed test run
// the model then repaired is history, not a verdict that still needs attention.
function verifierKey(event: CodingWorkbenchRuntimeSseEvent): string | undefined {
  if (event.kind !== "runtime-event" || event.verificationSummary === undefined) return undefined;
  return `${event.runId}\u0000${event.verificationSummary.verifierId}`;
}

function turnFailureProgress(
  event: CodingWorkbenchRuntimeSseEvent,
  newest: CodingWorkbenchRuntimeSseEvent | undefined,
  lastFailureCursor: string | undefined,
  activeRunId: string | undefined,
): TurnFailureProgress {
  if (newest === undefined) return "finished";
  if (settledRunState(newest.state)) {
    return newest.state === "failed" && event.cursor === lastFailureCursor
      ? "terminal"
      : "finished";
  }
  if (event.runId !== activeRunId) return "finished";
  return modelGatewayRetrying([newest], event.runId) ? "gateway-retrying" : "active";
}

// The message that may still receive content: the newest message of the newest turn while the run
// is generating, and only until the model moves on to a tool call. Text followed by a tool call is
// finished — the model waits for the tool, or for the operator's approval of it — so a finished
// answer keeps its code highlighting and Copy button however long that decision takes (#3873
// review). A tool is "after" the message when it began at or after the message's own timestamp.
function openMessageId(
  feed: UseCodingWorkbenchSafeActivityResult["feed"],
  generating: boolean,
): string | undefined {
  const turn = generating ? feed?.turns.at(-1) : undefined;
  const message = turn?.messages.at(-1);
  if (turn === undefined || message === undefined) return undefined;
  return turn.tools.some((tool) => tool.occurredAt >= message.occurredAt)
    ? undefined
    : message.messageId;
}

// The rows of one feed, numbered on from `order`; the numbering keeps rows of one instant in feed
// order; `idPrefix` keys the rows of an earlier run.
function feedItems(
  feed: AvailableCodingSafeActivityFeed,
  liveMessageId: string | undefined,
  first: number,
  idPrefix: string,
  activeRunId: string | undefined,
): readonly TimelineItem[] {
  const items: TimelineItem[] = [];
  for (const turn of feed.turns) {
    for (const message of turn.messages) {
      if (!hasVisibleMessageContent(message)) continue;
      items.push({
        kind: "message",
        id: `${idPrefix}message:${message.messageId}`,
        occurredAt: message.occurredAt,
        order: first + items.length,
        message,
        runId: feed.runId,
        live: message.messageId === liveMessageId,
      });
    }
    for (const tool of turn.tools) {
      items.push({
        kind: "tool",
        id: `${idPrefix}tool:${tool.callId}`,
        occurredAt: tool.occurredAt,
        order: first + items.length,
        tool: shownTool(tool, feed.runId === activeRunId ? activeRunId : undefined),
        runId: feed.runId,
        count: 1,
      });
    }
  }
  return items;
}

// The earlier runs of the task come first and the shown run's feed last: their rows sort into
// place by time, so a continuation's prompt follows the rows of the turn before it (U-11).
function timelineItems(
  events: readonly CodingWorkbenchRuntimeSseEvent[],
  feed: UseCodingWorkbenchSafeActivityResult["feed"],
  earlierFeeds: readonly AvailableCodingSafeActivityFeed[],
  liveMessageId: string | undefined,
  activeRunId: string | undefined,
): readonly TimelineItem[] {
  const items: TimelineItem[] = timelineEventItems(events, activeRunId);
  let order = events.length;
  for (const earlier of earlierFeeds) {
    // The ids of one run's calls and messages are not promised unique across runs, so an earlier
    // run's rows are keyed by the run as well; none of them is dropped for sharing an id.
    const rows = feedItems(earlier, undefined, order, `run:${earlier.runId}:`, activeRunId);
    items.push(...rows);
    order += rows.length;
  }
  if (feed !== null) {
    const rows = feedItems(feed, liveMessageId, order, "", activeRunId);
    items.push(...rows);
    order += rows.length;
  }
  const orderedItems = [...items];
  orderedItems.sort(compareTimelineItems);
  const compacted = compactToolItems(
    markRedeemedGitProposals(markSupersededGitProposals(markPairedGitProposals(orderedItems))),
  );
  return feed?.plan === undefined
    ? compacted
    : insertPlan(compacted, feed.plan, order, activeRunId !== undefined);
}

// #4491: a call still open on a run that is no longer active never reported its end. The server
// settles it as cancelled; a feed read before that settlement (or restored from an older run) is
// shown the same way, so no row keeps "Running" and a ticking clock for a run that is over.
function shownTool(
  tool: CodingSafeActivityTool,
  activeRunId: string | undefined,
): CodingSafeActivityTool {
  if (activeRunId !== undefined || (tool.state !== "pending" && tool.state !== "running"))
    return tool;
  return { ...tool, state: "cancelled" };
}

function hasVisibleMessageContent(message: CodingSafeActivityMessage): boolean {
  return (
    message.truncated ||
    message.fullAnswer !== undefined ||
    message.fullReasoning !== undefined ||
    message.reasoning !== undefined ||
    message.segments.some((segment) => segment.truncated || segment.text.trim().length > 0)
  );
}

// At one instant the rows keep `order`, which numbers the earlier runs' rows before the shown
// run's, so an earlier run's last rows precede the continuation's prompt (U-11).
function compareTimelineItems(left: TimelineItem, right: TimelineItem): number {
  // ISO-8601 instants of one fixed format order lexicographically; a locale-aware collation per
  // comparison is needless work on a sort that runs on every feed update.
  if (left.occurredAt === right.occurredAt) return left.order - right.order;
  return left.occurredAt < right.occurredAt ? -1 : 1;
}

function insertPlan(
  items: readonly TimelineItem[],
  plan: CodingSafeActivityPlan,
  order: number,
  open: boolean,
): readonly TimelineItem[] {
  // The row identity is the message that anchors the plan, not its revision: every task-list update
  // bumps the revision, and a row keyed by it would remount the card (and close what the reader
  // had open) on each update.
  const planItem: TimelineItem = {
    kind: "plan",
    id: `plan:${plan.anchorMessageId}`,
    occurredAt: plan.updatedAt,
    order,
    plan,
    open,
  };
  const anchor = items.findIndex(
    (item) => item.kind === "message" && item.message.messageId === plan.anchorMessageId,
  );
  if (anchor < 0) return [...items, planItem].sort(compareTimelineItems);
  return [...items.slice(0, anchor + 1), planItem, ...items.slice(anchor + 1)];
}

// The run and opaque proposal reference a Git call carries, when the server projected one.
function gitProposalKey(item: Extract<TimelineItem, { kind: "tool" }>): string | undefined {
  const ref = item.tool.presentation?.gitProposalRef;
  return ref === undefined || item.runId === undefined ? undefined : `${item.runId}\u0000${ref}`;
}

/**
 * Rows that carry the server's opaque proposal reference are paired exactly: an execute names the
 * proposal with the same reference in the same run, however many other proposals are open or
 * visible, and a completed one ends that proposal's wait. An execute whose proposal is not shown
 * stays generic. Rows without a reference fall back to the order-based rules below.
 */
function markPairedGitProposals(items: readonly TimelineItem[]): readonly TimelineItem[] {
  const marked = [...items];
  const open = new Map<string, number>();
  marked.forEach((item, index) => {
    if (item.kind !== "tool") return;
    const key = gitProposalKey(item);
    if (key === undefined) return;
    if (item.tool.tool !== "keiko_git_execute") {
      if (isOpenGitProposal(item.tool)) open.set(key, index);
      return;
    }
    redeemPairedProposal(marked, open, key, index);
  });
  return marked;
}

function redeemPairedProposal(
  marked: TimelineItem[],
  open: Map<string, number>,
  key: string,
  executeIndex: number,
): void {
  const execute = marked[executeIndex];
  const at = open.get(key);
  const proposal = at === undefined ? undefined : marked[at];
  if (execute?.kind !== "tool" || at === undefined || proposal?.kind !== "tool") return;
  const label = proposalLabelKey(proposal.tool);
  if (label !== undefined) marked[executeIndex] = { ...execute, redeemedLabel: label };
  if (!executeCompleted(execute.tool)) return;
  markSuperseded(marked, [at]);
  open.delete(key);
}

/**
 * A governed commit (or stage, unstage, branch) first answers "approval required" with a proposal;
 * the run then carries it out with `keiko_git_execute`, asking the person first where the mode says
 * so. Once the next execute after a proposal completed, the proposal is no decision anyone waits on:
 * in Full access it read "Waiting for approval" for good, beside the commit that happened (#4491).
 * Any other later step, or an execute that was refused or failed, leaves the proposal as it was.
 * With several proposals open at once the row cannot tell which one an execute redeemed, so they
 * stay waiting until as many completed executes as proposals followed.
 */
function markSupersededGitProposals(items: readonly TimelineItem[]): readonly TimelineItem[] {
  const marked = [...items];
  let open: number[] = [];
  let redeemed = 0;
  marked.forEach((item, index) => {
    if (item.kind !== "tool" || gitProposalKey(item) !== undefined) return;
    if (item.tool.tool === "keiko_git_execute") {
      if (open.length > 0 && executeCompleted(item.tool)) redeemed += 1;
    } else if (isOpenGitProposal(item.tool)) {
      open.push(index);
    }
    // The wire row carries no proposal id, so an execute cannot be paired with the one proposal it
    // redeemed when several are open: the facade lets any of them be redeemed. Keep every open
    // proposal waiting until the completed executes at least equal their number, so none is ever
    // shown as prepared that may still wait for a decision.
    if (open.length > 0 && redeemed >= open.length) {
      markSuperseded(marked, open);
      open = [];
      redeemed = 0;
    }
  });
  return marked;
}

// A Git step an execute may still redeem, shared by markSupersededGitProposals and
// markRedeemedGitProposals: any non-execute call that succeeded as waiting for approval or
// prepared, and a stage-class proposal answered ready, which carries no outcome (Full access).
function isOpenGitProposal(tool: CodingSafeActivityTool): boolean {
  if (tool.tool === "keiko_git_execute" || tool.state !== "succeeded") return false;
  const outcome = tool.presentation?.gitOutcome;
  if (outcome === undefined) return tool.tool === "keiko_git_stage";
  return outcome === "waiting-for-approval" || outcome === "prepared";
}

/**
 * An execute names what it carried out when exactly one proposal was open before it. The wire row
 * of an execute carries no proposal id, so with none or several open it keeps the generic label.
 * Open proposals are cleared by the same rule as {@link markSupersededGitProposals}: once as many
 * completed executes as proposals followed.
 */
function markRedeemedGitProposals(items: readonly TimelineItem[]): readonly TimelineItem[] {
  const marked = [...items];
  let open: CodingSafeActivityTool[] = [];
  let redeemed = 0;
  marked.forEach((item, index) => {
    if (item.kind !== "tool" || gitProposalKey(item) !== undefined) return;
    if (item.tool.tool === "keiko_git_execute") {
      const label = redeemedLabelKey(open);
      if (label !== undefined) marked[index] = { ...item, redeemedLabel: label };
      if (open.length > 0 && executeCompleted(item.tool)) redeemed += 1;
    } else if (isOpenGitProposal(item.tool)) {
      open.push(item.tool);
    }
    if (open.length > 0 && redeemed >= open.length) {
      open = [];
      redeemed = 0;
    }
  });
  return marked;
}

function redeemedLabelKey(
  open: readonly CodingSafeActivityTool[],
): CodingWorkbenchMessageKey | undefined {
  const only = open.length === 1 ? open[0] : undefined;
  return only === undefined ? undefined : proposalLabelKey(only);
}

/** A Git proposal's own label; an unstage reads as one, though it shares the stage tool's name. */
function proposalLabelKey(tool: CodingSafeActivityTool): CodingWorkbenchMessageKey | undefined {
  if (tool.tool === "keiko_git_stage" && tool.presentation?.gitAction === "unstage")
    return "codingWorkbench.timeline.tool.git_unstage";
  if (tool.tool === "execute") return programLabelKey(tool.presentation?.programKind);
  return toolLabelKey(tool.tool);
}

// A Code Mode program reads as what it does when the server named a kind; otherwise as a tool run.
function programLabelKey(
  kind: CodingSafeActivityProgramKind | undefined,
): CodingWorkbenchMessageKey {
  if (kind === "command") return "codingWorkbench.timeline.tool.execute_command";
  if (kind === "schedule") return "codingWorkbench.timeline.tool.execute_schedule";
  return "codingWorkbench.timeline.tool.execute";
}

function markSuperseded(marked: TimelineItem[], indexes: readonly number[]): void {
  for (const at of indexes) {
    const item = marked[at];
    if (item?.kind === "tool") marked[at] = { ...item, superseded: true };
  }
}

function executeCompleted(tool: CodingSafeActivityTool): boolean {
  return tool.state === "succeeded" && tool.presentation?.gitOutcome === "completed";
}

function compactToolItems(items: readonly TimelineItem[]): readonly TimelineItem[] {
  const compacted: TimelineItem[] = [];
  for (const item of items) {
    const previous = compacted.at(-1);
    if (item.kind === "tool" && canMergeToolItem(previous, item.tool)) {
      // The merged row keeps the id of its first call: the id is the React key, and a key that
      // changed as members joined would remount the row and collapse what the reader had opened.
      compacted[compacted.length - 1] = { ...previous, count: previous.count + 1 };
    } else {
      compacted.push(item);
    }
  }
  return compacted;
}

function groupCompletedTools(items: readonly TimelineItem[]): readonly TimelineItem[] {
  const grouped: TimelineItem[] = [];
  for (const item of items) {
    const previous = grouped.at(-1);
    if (item.kind !== "tool" || !shownAsSucceeded(item.tool)) {
      grouped.push(item);
    } else if (previous?.kind === "group") {
      grouped[grouped.length - 1] = { ...previous, tools: [...previous.tools, item] };
    } else if (previous?.kind === "tool" && shownAsSucceeded(previous.tool)) {
      grouped[grouped.length - 1] = {
        kind: "group",
        id: `group:${previous.id}`,
        occurredAt: previous.occurredAt,
        order: previous.order,
        tools: [previous, item],
      };
    } else {
      grouped.push(item);
    }
  }
  return grouped;
}

// A call folds into the "N steps" group only when its card itself reads "Succeeded": a Git step
// Keiko refused keeps the call state `succeeded` but must stay visible on its own (lab T37, #4271).
function shownAsSucceeded(tool: CodingSafeActivityTool): boolean {
  return shownToolState(tool) === "succeeded";
}

function canMergeToolItem(
  previous: TimelineItem | undefined,
  tool: CodingSafeActivityTool,
): previous is Extract<TimelineItem, { kind: "tool" }> {
  return (
    previous?.kind === "tool" &&
    previous.tool.state === "succeeded" &&
    tool.state === "succeeded" &&
    previous.tool.tool === tool.tool &&
    previous.tool.presentation === undefined &&
    tool.presentation === undefined
  );
}

interface TimelineWindow {
  readonly virtual: boolean;
  readonly start: number;
  readonly visible: readonly TimelineItem[];
  readonly end: number;
  readonly onScroll: (event: UIEvent<HTMLOListElement>) => void;
  /** Binds the virtualized list so it follows its own newest rows (and a question) when long. */
  readonly listRef: RefCallback<HTMLElement>;
  /** Rows measure themselves only while the list is virtualized; a short list needs no heights. */
  readonly measure: boolean;
  readonly measureRow: (id: string, height: number) => void;
  readonly hasMeasured: (id: string) => boolean;
  readonly spacerBefore: number;
  readonly spacerAfter: number;
}

// Cumulative prefix sums so index → offset is O(1) after an O(n) build. Recomputed only when the
// items array or a measured height actually changes (memoised on the height version). Prunes
// cached heights for ids that dropped out of the current items so the cache does not grow
// unbounded over a long-lived session — turn eviction from `droppedEventCount` and cross-run
// switches both replace whole swathes of ids that would otherwise linger forever.
function useCumulativeOffsets(
  items: readonly TimelineItem[],
  heightsRef: RefObject<ReadonlyMap<string, number>>,
  heightsVersion: number,
  virtual: boolean,
): readonly number[] {
  return useMemo(() => {
    // A short list renders every row and never reads an offset: skip the O(n) build entirely.
    if (!virtual) return [0];
    const offsets = new Array<number>(items.length + 1);
    offsets[0] = 0;
    const measured = heightsRef.current ?? new Map<string, number>();
    const liveIds = new Set<string>();
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (item === undefined) continue;
      liveIds.add(item.id);
      const known = measured.get(item.id);
      offsets[index + 1] = (offsets[index] ?? 0) + (known ?? ROW_HEIGHT_BY_KIND[item.kind]);
    }
    if (measured.size > liveIds.size) {
      const pruned = new Map<string, number>();
      for (const [id, height] of measured) if (liveIds.has(id)) pruned.set(id, height);
      heightsRef.current = pruned;
    }
    return offsets;
    // heightsVersion is the reactive signal that a cached height changed; heightsRef itself is
    // reference-stable, so React would otherwise never re-evaluate this memo on remeasurement.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, heightsVersion, virtual]);
}

// First index whose cumulative end offset is strictly greater than the scroll offset. Binary
// search keeps large feeds O(log n) even when many heights have been measured.
function indexAtOffset(cumulative: readonly number[], offset: number): number {
  let lo = 0;
  let hi = cumulative.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const nextOffset = cumulative[mid + 1] ?? 0;
    if (nextOffset <= offset) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// The virtualized list is its own scroller inside the session stream, which follows the newest
// content by itself. Without this the stream's follow-newest scrolled to the list's outer edge
// while the list stayed at its oldest rows: new rows and a pending question landed below the
// list's inner fold. The same hook the stream uses keeps the list at its newest rows while the
// reader is at the bottom, and never yanks a reader who scrolled up into the history.
function useVirtualListFollow(
  virtual: boolean,
  items: readonly TimelineItem[],
  totalHeight: number,
  questions: readonly unknown[],
): { readonly listRef: RefCallback<HTMLElement>; readonly onScroll: () => void } {
  const scrollRef = useRef<HTMLElement | null>(null);
  const questionKey = questions.length === 0 ? "" : String(questions.length);
  const growthKey = virtual
    ? `${String(items.length)}:${items.at(-1)?.id ?? ""}:${String(totalHeight)}:${questionKey}`
    : "short";
  const follow = useFollowNewest(scrollRef, growthKey);
  const { resume, paused } = follow;
  // A question is a decision the run waits for: a new one brings the list to its end even when the
  // reader had scrolled up, as the stream itself does for the run's own prompts.
  useEffect(() => {
    if (virtual && questionKey !== "") resume();
  }, [virtual, questionKey, resume]);
  // The stream's way back to the newest row shows while this list stopped following, and resumes it.
  const reportList = useContext(ListFollowContext);
  const listPaused = virtual && paused;
  useEffect(() => {
    reportList?.({ paused: listPaused, resume });
  }, [reportList, listPaused, resume]);
  useEffect(
    () => (): void => {
      reportList?.({ paused: false, resume: () => undefined });
    },
    [reportList],
  );
  return { listRef: follow.regionRef, onScroll: follow.onScroll };
}

// The measured heights of the rows the virtualizer has laid out, by row id. Held in a ref so a
// scroll-induced commit never rebuilds them; the version is the reactive signal that one changed.
function useRowHeights(): {
  readonly heightsRef: RefObject<ReadonlyMap<string, number>>;
  readonly heightsVersion: number;
  readonly measureRow: (id: string, height: number) => void;
  readonly hasMeasured: (id: string) => boolean;
} {
  const heightsRef = useRef<ReadonlyMap<string, number>>(new Map());
  const [heightsVersion, setHeightsVersion] = useState(0);
  const measureRow = useCallback((id: string, height: number): void => {
    const map = heightsRef.current;
    if (map.get(id) === height) return;
    const next = new Map(map);
    next.set(id, height);
    heightsRef.current = next;
    setHeightsVersion((value) => value + 1);
  }, []);
  const hasMeasured = useCallback((id: string): boolean => heightsRef.current.has(id), []);
  return { heightsRef, heightsVersion, measureRow, hasMeasured };
}

function useTimelineWindow(
  items: readonly TimelineItem[],
  questions: readonly unknown[],
): TimelineWindow {
  const [scrollTop, setScrollTop] = useState(0);
  const { heightsRef, heightsVersion, measureRow, hasMeasured } = useRowHeights();
  const virtual = items.length > VIRTUAL_THRESHOLD;
  const cumulative = useCumulativeOffsets(items, heightsRef, heightsVersion, virtual);
  const follow = useVirtualListFollow(virtual, items, cumulative.at(-1) ?? 0, questions);
  const { onScroll: followScroll } = follow;
  const onScroll = useCallback(
    (event: UIEvent<HTMLOListElement>): void => {
      followScroll();
      setScrollTop(event.currentTarget.scrollTop);
    },
    [followScroll],
  );
  const common = { onScroll, listRef: follow.listRef, measure: virtual, measureRow, hasMeasured };
  if (!virtual) {
    return {
      ...common,
      virtual: false,
      start: 0,
      visible: items,
      end: items.length,
      spacerBefore: 0,
      spacerAfter: 0,
    };
  }
  const startIndex = Math.max(0, indexAtOffset(cumulative, scrollTop) - OVERSCAN_ROWS);
  const start = Math.min(startIndex, Math.max(0, items.length - VISIBLE_ROWS));
  const end = Math.min(items.length, start + VISIBLE_ROWS);
  const totalHeight = cumulative[items.length] ?? 0;
  return {
    ...common,
    virtual: true,
    start,
    visible: items.slice(start, end),
    end,
    spacerBefore: cumulative[start] ?? 0,
    spacerAfter: Math.max(0, totalHeight - (cumulative[end] ?? totalHeight)),
  };
}

function activityNeedsAttention(activity: UseCodingWorkbenchSafeActivityResult): boolean {
  return (
    retryableActivity(activity.status) ||
    // A feed kept on screen while its connection is re-read is not confirmed live: say so.
    (activity.status === "loading" && activity.feed !== null) ||
    activity.feed?.truncated === true ||
    activity.feed?.turns.some((turn) => turn.truncated) === true ||
    (activity.feed?.droppedEventCount ?? 0) > 0
  );
}

// #3880: an unpaired window cannot connect its activity; the run status sentence says why.
function useShownActivityAttention(activity: UseCodingWorkbenchSafeActivityResult): boolean {
  const needed = activityNeedsAttention(activity);
  const held = useHeldNotice("activity", needed);
  return needed && !held;
}

function ActivityStatus({
  activity,
  attention,
  t,
}: {
  readonly activity: UseCodingWorkbenchSafeActivityResult;
  readonly attention: boolean;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  const truncated =
    activity.feed?.truncated === true ||
    activity.feed?.turns.some((turn) => turn.truncated) === true;
  if (!attention) return null;
  return (
    <div className={styles.activityStatus} data-activity-state={activity.status}>
      {/* This sits inside the session stream's `role="log"`, which already announces additions. A
          second live region here would announce the same sentence twice; the key remounts the node
          so a changed status is an addition the log announces once. */}
      <p key={activity.status}>{t(`codingWorkbench.activity.status.${activity.status}`)}</p>
      {truncated ? <p>{t("codingWorkbench.activity.truncated")}</p> : null}
      {(activity.feed?.droppedEventCount ?? 0) > 0 ? (
        <p>
          {t("codingWorkbench.activity.dropped", {
            count: activity.feed?.droppedEventCount ?? 0,
          })}
        </p>
      ) : null}
      {retryableActivity(activity.status) ? (
        <button className={styles.cmpActivityRetry} type="button" onClick={activity.retry}>
          {t("codingWorkbench.activity.retry")}
        </button>
      ) : null}
    </div>
  );
}

function retryableActivity(status: UseCodingWorkbenchSafeActivityResult["status"]): boolean {
  return (
    status === "unavailable" ||
    status === "disconnected" ||
    status === "offline" ||
    status === "error"
  );
}

function QuestionSummary({
  questions,
}: {
  readonly questions: UseCodingWorkbenchQuestionsResult;
}): ReactNode {
  const shown = questions.questions.length === 0 && QUESTION_SUMMARY_STATES.has(questions.status);
  // #3880: an unpaired window cannot list its questions; the run status sentence says why.
  const held = useHeldNotice("questions", shown);
  if (!shown || held) return null;
  return <CodingWorkbenchQuestionsSurface result={questions} variant="inline" />;
}

function TimelineContent({
  items,
  timeline,
  questions,
  restoreFocusRef,
  t,
}: {
  readonly items: readonly TimelineItem[];
  readonly timeline: TimelineWindow;
  readonly questions: UseCodingWorkbenchQuestionsResult;
  readonly restoreFocusRef: RefObject<HTMLHeadingElement | null>;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  const hasQuestion = questions.questions.length > 0;
  if (items.length === 0 && !hasQuestion) {
    return null;
  }
  return (
    <>
      {timeline.virtual ? (
        <p id="coding-workbench-timeline-instructions" className={styles.helpText}>
          {t("codingWorkbench.timeline.instructions")}
        </p>
      ) : null}
      <TimelineList
        items={items}
        timeline={timeline}
        questions={questions}
        restoreFocusRef={restoreFocusRef}
        t={t}
      />
    </>
  );
}

interface TimelineListProps {
  readonly items: readonly TimelineItem[];
  readonly timeline: TimelineWindow;
  readonly questions: UseCodingWorkbenchQuestionsResult;
  readonly restoreFocusRef: RefObject<HTMLHeadingElement | null>;
  readonly t: CodingWorkbenchTranslate;
}

function TimelineList({
  items,
  timeline,
  questions,
  restoreFocusRef,
  t,
}: TimelineListProps): ReactNode {
  const { virtual, end, onScroll, listRef, spacerBefore, spacerAfter } = timeline;
  const questionCount = questions.questions.length > 0 ? 1 : 0;
  const total = items.length + questionCount;
  return (
    <ol
      ref={listRef}
      className={styles.timeline}
      data-virtual={virtual}
      aria-label={t("codingWorkbench.timeline.listLabel")}
      aria-describedby={virtual ? "coding-workbench-timeline-instructions" : undefined}
      tabIndex={virtual ? 0 : undefined}
      onScroll={onScroll}
      data-timeline-rows=""
    >
      {virtual && spacerBefore > 0 ? <TimelineSpacer size={spacerBefore} /> : null}
      <TimelineRows timeline={timeline} total={total} t={t} />
      {virtual && end < items.length && spacerAfter > 0 ? (
        <TimelineSpacer size={spacerAfter} />
      ) : null}
      {questionCount > 0 ? (
        <QuestionRow
          result={questions}
          position={items.length + 1}
          total={total}
          restoreFocusRef={restoreFocusRef}
        />
      ) : null}
    </ol>
  );
}

function TimelineRows({
  timeline,
  total,
  t,
}: {
  readonly timeline: TimelineWindow;
  readonly total: number;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  const { start, visible, measure, measureRow, hasMeasured } = timeline;
  return visible.map((item, index) => (
    <TimelineRow
      key={item.id}
      item={item}
      position={start + index + 1}
      total={total}
      t={t}
      measureRow={measureRow}
      hasMeasured={hasMeasured}
      measure={measure}
    />
  ));
}

function TimelineSpacer({ size }: { readonly size: number }): ReactNode {
  return <li className={styles.timelineSpacer} style={{ blockSize: size }} aria-hidden="true" />;
}

// Measure the rendered <li> after mount / when the id changes and report its height so the
// virtualizer's cumulative offsets track the real layout instead of a fixed 64 px estimate. A
// zero measurement (jsdom without layout) is treated as "not measured yet" — the per-kind
// default height wins. Skip already-measured rows entirely: a scroll-induced commit would
// otherwise force a synchronous offsetHeight layout read on every visible row on every scroll,
// which is exactly the layout thrash the virtualizer is supposed to avoid.
function useRowMeasurement(
  id: string,
  measureRow: (id: string, height: number) => void,
  hasMeasured: (id: string) => boolean,
  enabled = true,
): RefObject<HTMLLIElement | null> {
  const ref = useRef<HTMLLIElement>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!enabled || node === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (node.offsetHeight > 0) measureRow(id, node.offsetHeight);
    });
    observer.observe(node);
    return (): void => observer.disconnect();
  }, [enabled, id, measureRow]);
  // Deliberately no dependency array: the effect must fire whenever the row commits so an
  // unmeasured row picks up its height as soon as the browser has laid it out. The hasMeasured
  // guard is what keeps the effect cheap — once a row's height is cached, subsequent commits
  // (including scroll-induced ones) short-circuit before touching `offsetHeight`, which is what
  // the pre-fix version would otherwise thrash on every visible row on every scroll.
  useLayoutEffect(() => {
    if (!enabled || hasMeasured(id)) return;
    const node = ref.current;
    if (node === null) return;
    const height = node.offsetHeight;
    if (height > 0) measureRow(id, height);
  });
  return ref;
}

// Memoized so a height measurement (which re-renders the list) leaves every row whose item,
// position and callbacks are unchanged alone: the items array is stable between feed updates, so
// only the row whose own content changed renders again.
const TimelineRow = memo(function TimelineRow({
  item,
  position,
  total,
  t,
  measureRow,
  hasMeasured,
  measure,
}: {
  readonly item: TimelineItem;
  readonly position: number;
  readonly total: number;
  readonly t: CodingWorkbenchTranslate;
  readonly measureRow: (id: string, height: number) => void;
  readonly hasMeasured: (id: string) => boolean;
  readonly measure: boolean;
}): ReactNode {
  const rowProps = { item, position, total, t, measureRow, hasMeasured, measure };
  if (item.kind === "group") return <ToolGroupRow {...rowProps} item={item} />;
  if (item.kind === "message") return <MessageRow {...rowProps} item={item} />;
  if (item.kind === "tool") return <ToolRow {...rowProps} item={item} />;
  if (item.kind === "plan") return <PlanRow {...rowProps} item={item} />;
  return <EventRow {...rowProps} item={item} />;
});

interface RowProps<T extends TimelineItem> {
  readonly item: T;
  readonly position: number;
  readonly total: number;
  readonly t: CodingWorkbenchTranslate;
  readonly measureRow: (id: string, height: number) => void;
  readonly hasMeasured: (id: string) => boolean;
  readonly measure: boolean;
}

function MessageRow({
  item,
  position,
  total,
  t,
  measureRow,
  hasMeasured,
  measure,
}: RowProps<Extract<TimelineItem, { kind: "message" }>>): ReactNode {
  const rowRef = useRowMeasurement(item.id, measureRow, hasMeasured, measure);
  return (
    <li
      ref={rowRef}
      className={styles.timelineItem}
      aria-posinset={position}
      aria-setsize={total}
      data-timeline-kind="message"
    >
      {item.message.origin === "keiko" ? (
        <KeikoNote message={item.message} t={t} />
      ) : (
        <article className={styles.timelineBody} data-message-role={item.message.role}>
          {/* The agent's role is announced, not drawn above every step: repeated on each message
              between tool rows it was the loudest text of the timeline (#3897 UI review). */}
          <p className={item.message.role === "assistant" ? "sr-only" : styles.timelineTitle}>
            {t(`codingWorkbench.activity.role.${item.message.role}`)}
          </p>
          {item.message.reasoning === undefined &&
          item.message.fullReasoning === undefined ? null : (
            <ModelReasoning message={item.message} live={item.live} t={t} />
          )}
          <div className={styles.messageText}>
            <MessageContent message={item.message} runId={item.runId} live={item.live} t={t} />
          </div>
        </article>
      )}
    </li>
  );
}

// #4491: a turn Keiko dispatched itself (a continuation of the person's accepted request) is never
// shown as the person's own message. It reads as a compact note labelled as Keiko's, collapsed until
// the reader opens it, and it is told apart by the message's own origin, never by its text.
function KeikoNote({
  message,
  t,
}: {
  readonly message: CodingSafeActivityMessage;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  return (
    <article className={styles.timelineBody} data-message-role="user" data-message-origin="keiko">
      <details className={styles.cmpKeikoNote}>
        <summary className={styles.cmpActivitySummary}>
          <span>{t("codingWorkbench.activity.role.keiko")}</span>
        </summary>
        <p className={styles.cmpKeikoNoteText}>
          {message.segments.map((segment) => segment.text).join("")}
          {truncationFor(message, t) ?? null}
        </p>
      </details>
    </article>
  );
}

// #3878: the model's own reasoning, apart from the answer. It is shown as the model wrote it under a
// plain "Thinking" summary: a warning-coloured "Unverified" read as a failed check on every step
// (#3897, owner), and a note inside every block was text Keiko added around the model's own (#3907,
// owner: less is more). The timeline's boundary sentence still says it is unverified. It is
// collapsed until the reader opens it, also while its turn streams, and its text is excluded from
// the log's live announcements: the session stream is a `role="log"`, whose additions a screen
// reader reads out, and unverified reasoning would crowd out the answer the reader needs (#3873
// review). A collapsed block exposes only its summary; an opened one keeps its streaming text out of
// the announcement with a nested `aria-live="off"`. The collapsed state is never driven from the
// run's state, so every toggle is the reader's and is reported, and it is remembered for the run.
// The reasoning is never cut to fit the feed (owner decision "Work-ending limits"): the block shows
// it whole, and the part the feed does not carry is read only once the reader opens it.
function ModelReasoning({
  message,
  live,
  t,
}: {
  readonly message: CodingSafeActivityMessage;
  readonly live: boolean;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  const texts = useContext(ModelTextsContext);
  const { messageId } = message;
  const shown = shownText(
    message.reasoning?.text ?? "",
    message.reasoning?.truncated === true,
    message.fullReasoning,
    texts.reasoning.get(messageId),
  );
  const onToggle = (event: SyntheticEvent<HTMLDetailsElement>): void => {
    if (event.currentTarget.open) {
      texts.openReasoning.add(messageId);
      texts.readReasoning(messageId);
    } else texts.openReasoning.delete(messageId);
  };
  return (
    <details
      className={styles.cmpReasoning}
      aria-live="off"
      open={texts.openReasoning.has(messageId)}
      onToggle={onToggle}
    >
      <summary
        className={styles.cmpActivitySummary}
        onClick={(event) => reportCodingWorkbenchSummaryActivated("model-reasoning", event)}
      >
        <span>{t(reasoningTitle(message, live))}</span>
      </summary>
      <p className={styles.cmpReasoningText}>
        {shown.source}
        <TextTrailing
          state={shown.state}
          onRetry={() => texts.retryText("reasoning", messageId)}
          t={t}
        />
      </p>
    </details>
  );
}

// "Thinking…" while the model still thinks: its message is live and no answer text arrived yet;
// "Thought" once it answers or moves on. The feed carries no reasoning timestamps, so the summary
// names no duration it could not prove.
function reasoningTitle(
  message: CodingSafeActivityMessage,
  live: boolean,
): "codingWorkbench.activity.reasoning.thinking" | "codingWorkbench.activity.reasoning.title" {
  const answering = message.segments.some((segment) => segment.text.trim() !== "");
  return live && !answering
    ? "codingWorkbench.activity.reasoning.thinking"
    : "codingWorkbench.activity.reasoning.title";
}

function MessageContent({
  message,
  runId,
  live,
  t,
}: {
  readonly message: CodingSafeActivityMessage;
  readonly t: CodingWorkbenchTranslate;
  readonly runId: string;
  readonly live: boolean;
}): ReactNode {
  if (message.role === "assistant")
    return <AssistantAnswer message={message} runId={runId} live={live} t={t} />;
  // Segments are the feed's transport bound (4,096 characters each), not paragraphs: a long prompt
  // is one text, so it renders as one block. A paragraph per segment opened a gap at an arbitrary
  // character, mid-word or between the CR and LF of a Windows line ending (#4068 W12).
  return (
    <p>
      {message.segments.map((segment) => segment.text).join("")}
      {truncationFor(message, t) ?? null}
    </p>
  );
}

// What an answer shows: its complete Markdown source once read, otherwise the part the feed carries.
// A model's answer is never cut to fit the bounded feed, so the truncation mark appears only for a
// real cut — the server's memory bound, or a failed read of the rest — and a still-loading rest is
// said as such, never marked as cut.
interface ShownAnswer {
  readonly source: string;
  /** `failed`: reading the rest failed, so the cut is marked and a retry is offered. */
  readonly state: "whole" | "loading" | "cut" | "failed";
}

// The same rule for the answer and the reasoning: the carried part, or the longer held text.
function shownText(
  carried: string,
  carriedCut: boolean,
  full: CodingSafeActivityMessage["fullAnswer"],
  held: CodingWorkbenchAnswerText | undefined,
): ShownAnswer {
  if (full === undefined) return { source: carried, state: carriedCut ? "cut" : "whole" };
  if (held === undefined) {
    return { source: carried, state: wholeOrCut(carried, full, false) };
  }
  const source = held.text.length >= carried.length ? held.text : carried;
  if (held.failed) return { source, state: "failed" };
  // A newer page can report the cut before the next feed update does: either source marks it.
  return { source, state: wholeOrCut(source, full, held.truncated) };
}

function wholeOrCut(
  source: string,
  full: NonNullable<CodingSafeActivityMessage["fullAnswer"]>,
  heldCut: boolean,
): ShownAnswer["state"] {
  if (source.length < full.length) return "loading";
  return full.truncated || heldCut ? "cut" : "whole";
}

function shownAnswer(
  message: CodingSafeActivityMessage,
  answer: CodingWorkbenchAnswerText | undefined,
): ShownAnswer {
  return shownText(
    message.segments.map((segment) => segment.text).join(""),
    message.truncated || message.segments.some((segment) => segment.truncated),
    message.fullAnswer,
    answer,
  );
}

function AssistantAnswer({
  message,
  runId,
  live,
  t,
}: {
  readonly message: CodingSafeActivityMessage;
  readonly t: CodingWorkbenchTranslate;
  readonly runId: string;
  readonly live: boolean;
}): ReactNode {
  const texts = useContext(ModelTextsContext);
  const shown = shownAnswer(message, texts.answers.get(message.messageId));
  // A streaming answer re-renders as a whole on every delta. Parsing is linear (about 18 ms per
  // 100 KB), but a long answer's deltas can arrive faster than it renders: the deferred source lets
  // React skip the stale ones and keep the window responsive, and always settles on the newest.
  const deferredSource = useDeferredValue(shown.source);
  const source = live ? deferredSource : shown.source;
  // While the answer still streams, SafeMarkdown renders its code without highlighting or list
  // evidence on every update; the finished answer renders in full as soon as it is finished — also
  // while the run waits for the operator's decision.
  return (
    <>
      <SafeMarkdownBoundary
        source={source}
        streaming={live}
        diagnosticCorrelationId={runId}
        diagnosticMessageId={message.messageId}
        trailing={
          shown.state === "whole" ? undefined : (
            <TextTrailing
              state={shown.state}
              onRetry={() => texts.retryText("answer", message.messageId)}
              t={t}
            />
          )
        }
        richContent={CODING_WORKBENCH_RICH_CONTENT}
      />
      <OutputLimitNote message={message} t={t} />
      {live || shown.source.trim().length === 0 ? null : (
        <div className={styles.cmpMessageActions}>
          <WorkbenchAnswerCopyButton
            text={shown.source}
            partial={shown.state !== "whole"}
            runId={runId}
            t={t}
          />
        </div>
      )}
    </>
  );
}

// The runtime reported the turn's finish as the model's output limit: the answer ends there.
function OutputLimitNote({
  message,
  t,
}: {
  readonly message: CodingSafeActivityMessage;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  if (message.outputLimitReached !== true) return null;
  return (
    <p className={styles.cmpOutputLimitNote} data-testid="coding-answer-output-limit">
      {t("codingWorkbench.activity.outputLimitReached")}
    </p>
  );
}

// The end of a model text that is not shown whole: still loading, cut, or a failed read with its
// next action.
function TextTrailing({
  state,
  onRetry,
  t,
}: {
  readonly state: ShownAnswer["state"];
  readonly onRetry: () => void;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  if (state === "whole") return null;
  if (state === "cut") return <TruncationMark t={t} />;
  if (state === "loading")
    return (
      <span className={styles.cmpAnswerLoading}>{t("codingWorkbench.activity.answerLoading")}</span>
    );
  return (
    <span className={styles.truncationMark}>
      … {t("codingWorkbench.activity.textReadFailed")}{" "}
      <button type="button" className={styles.cmpTextRetry} onClick={onRetry}>
        {t("codingWorkbench.activity.textRetry")}
      </button>
    </span>
  );
}

// The answer's own Markdown source, as the model wrote it, is what lands on the clipboard. The
// outcome is recorded body-free under the run's correlation: never the copied text.
function WorkbenchAnswerCopyButton({
  text,
  partial,
  runId,
  t,
}: {
  readonly text: string;
  /** A cut, failed or still loading answer is never copied as if it were the model's full text. */
  readonly partial: boolean;
  readonly runId: string;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  const labels = useMemo<AnswerCopyButtonLabels>(
    () => ({
      copy: t("codingWorkbench.activity.copy.answer"),
      copied: t("codingWorkbench.activity.copy.copied"),
      copiedStatus: t("codingWorkbench.activity.copy.copiedStatus"),
      failedStatus: t("codingWorkbench.activity.copy.failedStatus"),
    }),
    [t],
  );
  const onOutcome = useCallback(
    (error?: unknown) => {
      reportWorkbenchAnswerCopy(runId, error);
    },
    [runId],
  );
  return <AnswerCopyButton text={text} labels={labels} onOutcome={onOutcome} partial={partial} />;
}

function reportWorkbenchAnswerCopy(runId: string, error?: unknown): void {
  const correlationId = isActivityLogCorrelationId(runId) ? runId : undefined;
  const evidence = { grounded: false, strippedGroupCount: 0, keptGroupCount: 0 } as const;
  if (error === undefined) {
    reportClientDiagnostic("Keiko Coding Workbench answer copied.", {
      correlationId,
      answerCopy: { outcome: "copied", ...evidence },
    });
    return;
  }
  reportClientDiagnostic("Keiko Coding Workbench answer copy failed.", {
    correlationId,
    answerCopy: { outcome: "failed", ...evidence },
    errorKind: "unavailable",
    errorEvidence: clientErrorEvidence(error),
  });
}

function truncationFor(
  message: CodingSafeActivityMessage,
  t: CodingWorkbenchTranslate,
): ReactNode | undefined {
  return message.truncated || message.segments.some((segment) => segment.truncated) ? (
    <TruncationMark t={t} />
  ) : undefined;
}

function ToolRow({
  item,
  grouped = false,
  position,
  total,
  t,
  measureRow,
  hasMeasured,
  measure,
}: RowProps<Extract<TimelineItem, { kind: "tool" }>> & { readonly grouped?: boolean }): ReactNode {
  const rowRef = useRowMeasurement(item.id, measureRow, hasMeasured, measure && !grouped);
  const { tool } = item;
  const shownState = useShownToolState(tool, item.superseded === true);
  const origin = toolFailureOrigin(tool);
  return (
    <li
      ref={rowRef}
      className={styles.timelineItem}
      aria-posinset={position}
      aria-setsize={total}
      aria-busy={shownState === "running" || shownState === "pending"}
      data-timeline-kind="tool"
    >
      <details
        className={styles.toolCard}
        data-tool-state={shownState}
        {...(origin === undefined ? {} : { "data-failure-origin": origin })}
        open={opensWithFailure(origin) || OPEN_WITH_REASON_STATES.has(shownState)}
      >
        <summary
          className={styles.cmpActivitySummary}
          data-timeline-row=""
          onKeyDown={moveRowFocus}
          onClick={(event) => reportCodingWorkbenchSummaryActivated("tool", event)}
        >
          <span className={styles.toolIcon} aria-hidden="true" />
          <ToolRowTitle tool={tool} label={item.redeemedLabel} t={t} />
          {item.count > 1 ? (
            <span className={styles.toolCount}>
              {t("codingWorkbench.activity.toolCount", { count: item.count })}
            </span>
          ) : null}
          <ToolSummaryEnd tool={tool} state={shownState} origin={origin} t={t} />
        </summary>
        <ToolRowBody tool={tool} origin={origin} state={shownState} t={t} />
      </details>
    </li>
  );
}

// The row's name in words, with the raw tool id only as a tooltip, and what it is about.
function ToolRowTitle({
  tool,
  label,
  t,
}: {
  readonly tool: CodingSafeActivityTool;
  readonly label: CodingWorkbenchMessageKey | undefined;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  return (
    <div className={styles.toolMeta}>
      <p className={styles.timelineTitle} title={tool.tool}>
        {humanizeToolName(tool, label, t)}
      </p>
      <ToolSubject tool={tool} />
    </div>
  );
}

// An opened row: a failure's plain explanation and duration first, then the call's own text.
function ToolRowBody({
  tool,
  origin,
  state,
  t,
}: {
  readonly tool: CodingSafeActivityTool;
  readonly origin: CodingSafeActivityToolFailureOrigin | undefined;
  readonly state: ShownToolState;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  return (
    <>
      {origin === undefined ? (
        <ToolOutcome tool={tool} state={state} t={t} />
      ) : (
        <>
          <ToolFailureExplanation tool={tool} origin={origin} t={t} />
          <ToolRowDuration tool={tool} t={t} />
        </>
      )}
      <ToolTextDetail tool={tool} t={t} />
      <ToolPresentationDetails tool={tool} t={t} />
    </>
  );
}

// What the row is about: a shell call's command line, else the file a read returned.
function ToolSubject({ tool }: { readonly tool: CodingSafeActivityTool }): ReactNode {
  const command = tool.presentation?.command;
  if (command !== undefined) return <ToolCommandPreview command={command} />;
  const path = tool.presentation?.relativePath;
  if (path !== undefined) return <code className={styles.toolName}>{path}</code>;
  const task = subagentSubject(tool);
  return task === undefined ? null : <span className={styles.toolName}>{task}</span>;
}

// A subagent row names the agent it started and the task, as "explore — Count test files".
function subagentSubject(tool: CodingSafeActivityTool): string | undefined {
  const agent = tool.presentation?.agentName?.text;
  const description = tool.presentation?.taskDescription?.text;
  if (agent === undefined || description === undefined) return agent ?? description;
  return `${agent} — ${description}`;
}

function ToolRowDuration({
  tool,
  t,
}: {
  readonly tool: CodingSafeActivityTool;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  const locale = useLocale();
  return (
    <ToolDuration
      durationMs={tool.presentation?.durationMs ?? tool.presentation?.bridgeDurationMs}
      t={t}
      format={(durationMs) =>
        durationMs < 60_000
          ? formatDurationMs(durationMs, locale)
          : formatRunDuration(durationMs, t)
      }
    />
  );
}

// The row's end: who caused a failure; a quiet check and the duration for a success, no word; the
// state badge for anything still open or unfinished.
function ToolSummaryEnd({
  tool,
  state,
  origin,
  t,
}: {
  readonly tool: CodingSafeActivityTool;
  readonly state: ShownToolState;
  readonly origin: CodingSafeActivityToolFailureOrigin | undefined;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  const runningSince = useExecutionStart(state, tool.occurredAt);
  if (origin !== undefined) return <ToolFailureLabel tool={tool} origin={origin} t={t} />;
  if (state === "succeeded") {
    return (
      <>
        <span className="sr-only">{t("codingWorkbench.activity.toolState.succeeded")}</span>
        <ToolOutputShortenedLabel tool={tool} t={t} />
        <ToolRowDuration tool={tool} t={t} />
      </>
    );
  }
  return (
    <>
      <ToolStateBadge tool={tool} state={state} t={t} />
      {state === "running" ? <RunningFor since={runningSince} t={t} /> : null}
    </>
  );
}

// A call held for a decision is reported running from the instant it was held, so its server
// instant includes the wait. The executing time starts when the hold ends: the client instant of
// a call seen leaving the hold replaces the reported one.
function useExecutionStart(state: ShownToolState, reported: string): string {
  const [previous, setPrevious] = useState(state);
  const [resumedAt, setResumedAt] = useState<string | null>(null);
  if (previous !== state) {
    setPrevious(state);
    if (state === "running" && previous.startsWith("waiting-for-")) {
      setResumedAt(new Date().toISOString());
    }
  }
  return resumedAt !== null && state === "running" ? resumedAt : reported;
}

// How long a call has been running, from one second on. It ticks silently: a timer is no live
// region, so a screen reader is never interrupted once a second.
function RunningFor({
  since,
  t,
}: {
  readonly since: string;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  const now = useSecondClock(true);
  const started = Date.parse(since);
  const elapsed = Number.isNaN(started) ? 0 : now - started;
  if (elapsed < 1_000) return null;
  return (
    <span className={styles.cmpToolDuration} role="timer">
      {formatRunDuration(elapsed, t)}
    </span>
  );
}

// The runtime completes a shell call whatever its command returned and reports the exit code; a
// non-zero code is the command's answer, for example a test run that reproduces a defect, not a
// failed call. The timeline shows that code as OpenCode does instead of a red "Failed" (#4098
// acceptance). The run's own state and its verification evidence still count the command as
// failed; only the card's presentation changes.
//
// The same holds for a verification the server knows never checked anything (#3579): the operator's
// package-script decision still open, a repository with nothing the verifier can run, and a run whose
// steps were skipped, denied or cancelled. The model still reads a refusal; the card says what
// happened instead of "Failed". A check that ran and went red keeps the failed badge.
type UnrunVerificationOutcome = Extract<
  CodingSafeActivityVerificationOutcome,
  | "waiting-for-trust"
  | "no-runnable-steps"
  | "not-run"
  | "isolation-unavailable"
  | "dependencies-unavailable"
>;
//
// And for a governed Git step (lab T37, #4271): the facade answers a refused commit, stage or branch
// as a completed call, so its tool state reads "succeeded" for a step that never happened. The server's
// closed Git outcome decides the badge instead: still waiting for the human, or not done.
type UnfinishedGitState = "not-done" | "waiting-for-approval" | "prepared";
// A proposal that a completed execute step carried out: a commit reads "committed", any other
// governed Git step "carried-out", never "prepared" beside the execute row that finished it.
type RedeemedGitState = "committed" | "carried-out";
type ShownToolState =
  | CodingSafeActivityTool["state"]
  | "exited"
  | UnrunVerificationOutcome
  | UnfinishedGitState
  | RedeemedGitState;

const UNRUN_VERIFICATION_OUTCOMES: ReadonlySet<CodingSafeActivityVerificationOutcome> = new Set([
  "waiting-for-trust",
  "no-runnable-steps",
  "not-run",
  "isolation-unavailable",
  "dependencies-unavailable",
]);

// The cards that open to the reason they ended as they did, rather than staying a one-line row.
const OPEN_WITH_REASON_STATES: ReadonlySet<ShownToolState> = new Set([
  "failed",
  "denied",
  "exited",
  "waiting-for-trust",
  "no-runnable-steps",
  "not-run",
  "isolation-unavailable",
  "dependencies-unavailable",
  "not-done",
  "waiting-for-approval",
]);

function unfinishedGitState(
  outcome: CodingSafeActivityGitOutcome | undefined,
): UnfinishedGitState | undefined {
  if (outcome === undefined || outcome === "completed") return undefined;
  return outcome === "waiting-for-approval" || outcome === "prepared" ? outcome : "not-done";
}

function isUnrunVerificationOutcome(
  outcome: CodingSafeActivityVerificationOutcome | undefined,
): outcome is UnrunVerificationOutcome {
  return outcome !== undefined && UNRUN_VERIFICATION_OUTCOMES.has(outcome);
}

// A succeeded call's badge: how its Git step really ended, a proposal a later step took up, or done.
// A finished run cannot be waiting for a decision: with no ask open any more, a proposal still
// reading "waiting" is a step that was never carried out.
function succeededToolState(
  tool: CodingSafeActivityTool,
  superseded: boolean,
  runEnded: boolean,
): ShownToolState {
  const git = unfinishedGitState(tool.presentation?.gitOutcome);
  if (git === undefined) return "succeeded";
  if (superseded && (git === "waiting-for-approval" || git === "prepared")) {
    return tool.tool === "keiko_git_commit" ? "committed" : "carried-out";
  }
  if (git !== "waiting-for-approval") return git;
  return runEnded ? "not-done" : git;
}

// The one tool the package-script trust decision gates: its call is the open row the pause holds.
// Any other call open beside it (parallel tool calls) keeps its own running state and timer.
const TRUST_GATED_TOOL = "keiko_verification";

function isOpenTool(tool: CodingSafeActivityTool): boolean {
  return tool.state === "running" || tool.state === "pending";
}

// A call that has not finished while the person's decision on it is pending is blocked on the
// human, not executing: the ask names its call exactly (`awaitingCallId`), never a guess.
function isHeldForApproval(
  tool: CodingSafeActivityTool,
  awaitingCallId: string | undefined,
): boolean {
  return (
    awaitingCallId !== undefined &&
    tool.callId === awaitingCallId &&
    (tool.state === "running" || tool.state === "pending")
  );
}

function useShownToolState(tool: CodingSafeActivityTool, superseded: boolean): ShownToolState {
  const awaitingCallId = useContext(AwaitingApprovalCallIdContext);
  const runEnded = useContext(RunEndedContext);
  const heldForTrust = useContext(HeldForTrustContext);
  return shownToolState(tool, superseded, awaitingCallId, runEnded, heldForTrust);
}

function shownToolState(
  tool: CodingSafeActivityTool,
  superseded = false,
  awaitingCallId?: string,
  runEnded = false,
  heldForTrust = false,
): ShownToolState {
  if (isHeldForApproval(tool, awaitingCallId)) return "waiting-for-approval";
  if (heldForTrust && isOpenTool(tool) && tool.tool === TRUST_GATED_TOOL) {
    return "waiting-for-trust";
  }
  if (tool.state === "succeeded") return succeededToolState(tool, superseded, runEnded);
  return tool.state === "failed" ? failedToolState(tool) : tool.state;
}

function failedToolState(tool: CodingSafeActivityTool): ShownToolState {
  const exitCode = tool.presentation?.exitCode;
  if (exitCode !== undefined && exitCode !== 0) return "exited";
  const outcome = tool.presentation?.verificationOutcome;
  return isUnrunVerificationOutcome(outcome) ? outcome : tool.state;
}

function ToolStateBadge({
  tool,
  state,
  t,
}: {
  readonly tool: CodingSafeActivityTool;
  readonly state: ShownToolState;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  return (
    <span className={styles.activityBadge} data-state={state}>
      {state === "exited"
        ? t("codingWorkbench.activity.toolState.exited", { code: tool.presentation?.exitCode ?? 0 })
        : t(`codingWorkbench.activity.toolState.${state}`)}
    </span>
  );
}

// Why a call ended as it did, in words: a command's exit status, how a verification ended, or that
// the tool reported an error to the model. Without it a failed call opened to nothing but its tool
// name (#3897).
function ToolOutcome({
  tool,
  state,
  t,
}: {
  readonly tool: CodingSafeActivityTool;
  readonly state: ShownToolState;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  const verificationOutcome = tool.presentation?.verificationOutcome;
  if (verificationOutcome !== undefined) {
    return (
      <p className={styles.cmpToolOutcome}>
        {t(`codingWorkbench.activity.verification.${verificationOutcome}`)}
      </p>
    );
  }
  const sentence = toolOutcomeSentence(tool, state, t);
  return sentence === undefined ? null : <p className={styles.cmpToolOutcome}>{sentence}</p>;
}

// The sentence follows the badge the row shows, never the raw outcome: a proposal taken up by a later
// step reads prepared, and one still "waiting" in a run that is over reads not done.
function toolOutcomeSentence(
  tool: CodingSafeActivityTool,
  state: ShownToolState,
  t: CodingWorkbenchTranslate,
): string | undefined {
  // A proposal its execute step carried out is finished: its badge says so and needs no sentence.
  if (state === "committed" || state === "carried-out") return undefined;
  if (state === "prepared") return t("codingWorkbench.activity.git.prepared");
  // A carried-out Git step needs no sentence beyond its "Succeeded" badge.
  const gitOutcome = tool.presentation?.gitOutcome;
  if (gitOutcome === undefined || gitOutcome === "completed") return undefined;
  if (gitOutcome === "waiting-for-approval" && state !== "waiting-for-approval") {
    return t("codingWorkbench.activity.git.not-done");
  }
  return t(`codingWorkbench.activity.git.${gitOutcome}`);
}

function ToolPresentationDetails({
  tool,
  t,
}: {
  readonly tool: CodingSafeActivityTool;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  const facts = tool.presentation;
  if (facts === undefined) return null;
  return (
    <div className={styles.cmpToolFacts}>
      {facts.readByteCount === undefined ? null : (
        <p>
          {facts.totalFileLines === undefined
            ? t("codingWorkbench.activity.readBytes", { bytes: facts.readByteCount })
            : t("codingWorkbench.activity.readFacts", {
                bytes: facts.readByteCount,
                lines: facts.totalFileLines,
              })}
        </p>
      )}
      {facts.returnedPathCount === undefined ? null : (
        <p>{t("codingWorkbench.activity.returnedPaths", { count: facts.returnedPathCount })}</p>
      )}
      {facts.refusalReason === undefined || facts.refusalReason === "FILE_NOT_UTF8" ? null : (
        <p>{t(`codingWorkbench.activity.editRefusal.${facts.refusalReason}`)}</p>
      )}
      {facts.affectedRelativePath === undefined ? null : (
        <p>{t("codingWorkbench.activity.affectedFile", { path: facts.affectedRelativePath })}</p>
      )}
    </div>
  );
}

function ToolGroupRow({
  item,
  position,
  total,
  t,
  measureRow,
  hasMeasured,
  measure,
}: RowProps<Extract<TimelineItem, { kind: "group" }>>): ReactNode {
  const rowRef = useRowMeasurement(item.id, measureRow, hasMeasured, measure);
  // A closed group renders no rows: they mount the first time a reader opens it and stay mounted,
  // so a long run's folded work costs nothing until someone looks at it.
  const [opened, setOpened] = useState(false);
  return (
    <li
      ref={rowRef}
      className={styles.timelineItem}
      aria-posinset={position}
      aria-setsize={total}
      data-timeline-kind="group"
    >
      <details
        className={styles.cmpToolGroup}
        onToggle={(event) => {
          if (event.currentTarget.open) setOpened(true);
        }}
      >
        <summary
          className={styles.cmpActivitySummary}
          data-timeline-row=""
          onKeyDown={moveRowFocus}
          onClick={(event) => {
            setOpened(true);
            reportCodingWorkbenchSummaryActivated("activity-group", event);
          }}
        >
          {toolGroupSummary(item.tools, t)}
        </summary>
        {opened ? (
          <GroupedTools item={item} t={t} measureRow={measureRow} hasMeasured={hasMeasured} />
        ) : null}
      </details>
    </li>
  );
}

function GroupedTools({
  item,
  t,
  measureRow,
  hasMeasured,
}: Pick<
  RowProps<Extract<TimelineItem, { kind: "group" }>>,
  "item" | "t" | "measureRow" | "hasMeasured"
>): ReactNode {
  return (
    <ol className={styles.cmpGroupedTools}>
      {item.tools.map((tool, index) => (
        <ToolRow
          grouped
          key={tool.id}
          item={tool}
          position={index + 1}
          total={item.tools.length}
          t={t}
          measureRow={measureRow}
          hasMeasured={hasMeasured}
          measure={false}
        />
      ))}
    </ol>
  );
}

/** The catalog key of a tool's name in words; undefined for a tool Keiko has no name for. */
export function toolLabelKey(tool: string): CodingWorkbenchMessageKey | undefined {
  // The id is runtime text: `constructor` must not resolve to a member inherited from Object.
  return Object.hasOwn(KNOWN_TOOL_LABEL_KEYS, tool) ? KNOWN_TOOL_LABEL_KEYS[tool] : undefined;
}

// A tool Keiko has no name for (an MCP server's, a newer runtime's) is a "Tool"; its raw id stays
// in the row's tooltip, never in the row's text.
function humanizeToolName(
  tool: CodingSafeActivityTool,
  redeemed: CodingWorkbenchMessageKey | undefined,
  t: CodingWorkbenchTranslate,
): string {
  const key = redeemed ?? proposalLabelKey(tool);
  return t(key ?? "codingWorkbench.timeline.tool.unknown");
}

function PlanRow({
  item,
  position,
  total,
  t,
  measureRow,
  hasMeasured,
  measure,
}: RowProps<Extract<TimelineItem, { kind: "plan" }>>): ReactNode {
  const rowRef = useRowMeasurement(item.id, measureRow, hasMeasured, measure);
  return (
    <li
      ref={rowRef}
      className={styles.timelineItem}
      aria-posinset={position}
      aria-setsize={total}
      data-timeline-kind="plan"
    >
      <details className={styles.planCard} open={item.open}>
        <summary
          className={styles.cmpActivitySummary}
          onClick={(event) => reportCodingWorkbenchSummaryActivated("plan", event)}
        >
          <p className={styles.timelineTitle}>{t("codingWorkbench.activity.plan.title")}</p>
          <PlanProgress steps={item.plan.steps} t={t} />
        </summary>
        <ol className={styles.planSteps}>
          {item.plan.steps.map((step, index) => (
            <li key={`${item.plan.anchorMessageId}:${String(index)}`} data-plan-state={step.state}>
              <span>{step.text}</span>
              <span className={styles.activityBadge} data-state={step.state}>
                {t(`codingWorkbench.activity.planState.${step.state}`)}
              </span>
              {step.truncated ? <TruncationMark t={t} /> : null}
            </li>
          ))}
        </ol>
        {item.plan.truncated ? <p>{t("codingWorkbench.activity.plan.truncated")}</p> : null}
      </details>
    </li>
  );
}

/** "2/5 completed" beside the plan title, so the closed card still shows how far the run is. */
function PlanProgress({
  steps,
  t,
}: {
  readonly steps: CodingSafeActivityPlan["steps"];
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  if (steps.length === 0) return null;
  const completed = steps.filter((step) => step.state === "completed").length;
  return (
    <span
      className={styles.activityBadge}
      data-state={completed === steps.length ? "completed" : undefined}
    >
      {t("codingWorkbench.activity.plan.progress", { completed, total: steps.length })}
    </span>
  );
}

function EventRow({
  item,
  position,
  total,
  t,
  measureRow,
  hasMeasured,
  measure,
}: RowProps<Extract<TimelineItem, { kind: "event" }>>): ReactNode {
  const rowRef = useRowMeasurement(item.id, measureRow, hasMeasured, measure);
  const tone = itemTone(item);
  const detail = timelineEventDetail(item, t);
  return (
    <li
      ref={rowRef}
      className={styles.timelineItem}
      aria-posinset={position}
      aria-setsize={total}
      data-timeline-kind="event"
      data-event-tone={tone}
    >
      <details className={styles.eventCard} open={tone === "attention"}>
        <summary
          className={styles.cmpActivitySummary}
          onClick={(event) => reportCodingWorkbenchSummaryActivated("event", event)}
        >
          {eventTitle(item.event, t)}
        </summary>
        {detail.length > 0 ? <p className={styles.timelineDetail}>{detail}</p> : null}
        <VerificationDetail event={item.event} t={t} />
        <RunFailureReport event={item.event} t={t} />
      </details>
    </li>
  );
}

/**
 * A run that settled `failed` offers the existing user-initiated error report. The server uses the
 * run id as the run's Activity Log correlation id, so the report selects that run's lines; an id
 * that is not a valid correlation id falls back to the most recent registered failure. A run whose
 * changes were not checked offers "Run the check now" instead (#4491): nothing broke inside Keiko,
 * and the button is the person's own request to run the check, so it is shown as their message.
 */
function RunFailureReport({
  event,
  t,
}: {
  readonly event: CodingWorkbenchRuntimeSseEvent;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  const onRunCheck = useContext(RunCheckContext);
  if (onRunCheck !== undefined && eventOffersRunCheck(event, true)) {
    return (
      <p className={styles.timelineDetail} data-run-check="">
        <button type="button" className={styles.cmpRunCheckAction} onClick={onRunCheck}>
          {t("codingWorkbench.event.runCheck.action")}
        </button>
      </p>
    );
  }
  if (!eventOffersErrorReport(event)) return null;
  const correlationId = isActivityLogCorrelationId(event.runId) ? event.runId : undefined;
  return (
    <p className={styles.timelineDetail} data-run-failure-report="">
      <SupportReportButton correlationId={correlationId} errorKey={`coding-run-${event.runId}`} />
    </p>
  );
}

const TURN_FAILURE_CAUSE_KEYS: Readonly<Partial<Record<string, CodingWorkbenchMessageKey>>> = {
  "provider-failed": "codingWorkbench.event.turnCause.provider-failed",
  "stream-incomplete": "codingWorkbench.event.turnCause.stream-incomplete",
  "turn-rejected": "codingWorkbench.event.turnCause.turn-rejected",
  "output-exhausted": "codingWorkbench.event.turnCause.output-exhausted",
  "empty-answer": "codingWorkbench.event.turnCause.empty-answer",
  "invalid-tool-call": "codingWorkbench.event.turnCause.invalid-tool-call",
};

function timelineEventDetail(
  item: Extract<TimelineItem, { kind: "event" }>,
  t: CodingWorkbenchTranslate,
): string {
  const event = item.event;
  if (
    event.kind !== "runtime-event" ||
    event.eventKind !== "failure-redacted" ||
    item.turnFailureProgress === "terminal"
  )
    return eventDetail(event, t);
  const key = TURN_FAILURE_CAUSE_KEYS[event.failureCode ?? ""];
  if (key === undefined) return eventDetail(event, t);
  const cause = t(key);
  if (item.turnFailureProgress === "finished") return cause;
  const progress = t(`codingWorkbench.event.turnProgress.${item.turnFailureProgress}`);
  return `${cause} ${progress}`;
}

type VerificationSummary = NonNullable<
  Extract<CodingWorkbenchRuntimeSseEvent, { kind: "runtime-event" }>["verificationSummary"]
>;

// The canonical failed count includes denials. Only an explicit denied subset can distinguish
// those blocked steps from executed failures; historical summaries retain their original facts.
function shownVerificationStatus(
  summary: VerificationSummary,
): VerificationSummary["status"] | "notRun" {
  if (summary.status === "passed") return "passed";
  const deniedCount = summary.deniedCount ?? 0;
  if (summary.failedCount === deniedCount) {
    if (summary.passedCount === 0) return "notRun";
    if (deniedCount > 0) return "partial";
  }
  return summary.status;
}

function verificationCheckCounts(
  summary: VerificationSummary,
  number: Intl.NumberFormat,
  t: CodingWorkbenchTranslate,
): string {
  if (summary.deniedCount === undefined) {
    return t("codingWorkbench.verification.checks", {
      passed: number.format(summary.passedCount),
      failed: number.format(summary.failedCount),
      skipped: number.format(summary.skippedCount),
    });
  }
  return t("codingWorkbench.verification.checksWithBlocked", {
    passed: number.format(summary.passedCount),
    failed: number.format(summary.failedCount - summary.deniedCount),
    blocked: number.format(summary.deniedCount),
    skipped: number.format(summary.skippedCount),
  });
}

/** A duration as a reader takes it in: milliseconds below a second, seconds with one decimal above. */
function formatDurationMs(durationMs: number, locale: Locale): string {
  if (durationMs < 1000) {
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(durationMs)} ms`;
  }
  const seconds = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(
    durationMs / 1000,
  );
  return `${seconds} s`;
}

function VerificationDetail({
  event,
  t,
}: {
  readonly event: CodingWorkbenchRuntimeSseEvent;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  const locale = useLocale();
  const number = useMemo(
    () => new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }),
    [locale],
  );
  const summary = event.kind === "runtime-event" ? event.verificationSummary : undefined;
  if (summary === undefined) return null;
  return (
    <div className={`${styles.timelineDetail} ${styles.cmpVerificationFacts}`}>
      <p>
        {t("codingWorkbench.verification.result", {
          verifier: t(`codingWorkbench.verification.verifier.${summary.verifierId}`),
          status: t(`codingWorkbench.verification.status.${shownVerificationStatus(summary)}`),
        })}
      </p>
      <p>{verificationCheckCounts(summary, number, t)}</p>
      <p>
        {t("codingWorkbench.verification.duration", {
          duration: formatDurationMs(summary.durationMs, locale),
        })}
      </p>
    </div>
  );
}

// A replaced check stays in the run details, closed: only the latest verdict asks for attention.
function itemTone(
  item: Extract<TimelineItem, { kind: "event" }>,
): "attention" | "routine" | "success" {
  return item.superseded ? "routine" : eventTone(item.event);
}

function eventTone(event: CodingWorkbenchRuntimeSseEvent): "attention" | "routine" | "success" {
  if (event.state === "failed" || event.failureCode !== undefined) return "attention";
  if (event.kind === "runtime-event" && event.eventKind === "failure-redacted") return "attention";
  if (event.kind === "runtime-event" && event.verificationSummary !== undefined) {
    const shown = shownVerificationStatus(event.verificationSummary);
    if (shown === "notRun") return "routine";
    return shown === "passed" ? "success" : "attention";
  }
  if (event.state === "succeeded") return "success";
  return "routine";
}

function QuestionRow({
  result,
  position,
  total,
  restoreFocusRef,
}: {
  readonly result: UseCodingWorkbenchQuestionsResult;
  readonly position: number;
  readonly total: number;
  readonly restoreFocusRef: RefObject<HTMLHeadingElement | null>;
}): ReactNode {
  return (
    <li
      className={styles.timelineItem}
      aria-posinset={position}
      aria-setsize={total}
      data-timeline-kind="question"
    >
      <CodingWorkbenchQuestionsSurface
        result={result}
        variant="inline"
        restoreFocusRef={restoreFocusRef}
      />
    </li>
  );
}

function TruncationMark({ t }: { readonly t: CodingWorkbenchTranslate }): ReactNode {
  return (
    <span className={styles.truncationMark}>… {t("codingWorkbench.activity.truncationMark")}</span>
  );
}
