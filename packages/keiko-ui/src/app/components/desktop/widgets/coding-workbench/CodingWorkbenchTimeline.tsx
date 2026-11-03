/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- The virtualized overflow list and restored timeline heading need programmatic keyboard focus. */
"use client";

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefCallback,
  type RefObject,
  type UIEvent,
} from "react";
import type {
  CodingSafeActivityMessage,
  CodingSafeActivityPlan,
  CodingSafeActivityTool,
  CodingWorkbenchRuntimeSseEvent,
} from "@oscharko-dev/keiko-contracts";
import type { CodingSafeActivityVerificationOutcome } from "@oscharko-dev/keiko-contracts/runtime/coding-safe-activity";

import type { UseCodingWorkbenchQuestionsResult } from "@/lib/useCodingWorkbenchQuestions";
import type { UseCodingWorkbenchSafeActivityResult } from "@/lib/useCodingWorkbenchSafeActivity";
import {
  reportCodingWorkbenchSummaryActivated,
  reportCodingWorkbenchInteraction,
} from "@/lib/coding-workbench-interaction";
import { useLocale, type Locale } from "@/lib/i18n";
import { useFollowNewest } from "@/lib/useFollowNewest";
import { SafeMarkdownBoundary } from "../../SafeMarkdown";
import {
  useCodingWorkbenchTranslate,
  type CodingWorkbenchTranslate,
} from "./coding-workbench-i18n";
import type { CodingWorkbenchMessageKey } from "./coding-workbench-i18n.en";
import { eventDetail, eventTitle } from "./codingWorkbenchLabels";
import { modelGatewayRetrying, settledRunState } from "./codingWorkbenchRunFacts";
import { CodingWorkbenchQuestionsSurface } from "./CodingWorkbenchQuestions";
import { CODING_WORKBENCH_RICH_CONTENT } from "./CodingWorkbenchRichContent";
import { useHeldNotice } from "./codingWorkbenchPairingHold";
import styles from "./CodingWorkbenchWindow.module.css";

const VIRTUAL_THRESHOLD = 100;
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
  question: "codingWorkbench.timeline.tool.question",
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
      readonly count: number;
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
}

export function Timeline({
  active = false,
  generating = active,
  events,
  activity,
  questions,
  focusRef,
}: CodingWorkbenchTimelineProps): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const internalTitleRef = useRef<HTMLHeadingElement>(null);
  const titleRef = focusRef ?? internalTitleRef;
  const [showEvents, setShowEvents] = useState(false);
  const allItems = useTimelineItems(events, activity.feed, generating, active);
  const items = useShownItems(allItems, showEvents);
  const timeline = useTimelineWindow(items, questions.questions);
  const attention = useShownActivityAttention(activity);
  if (!active && allItems.length === 0 && questions.questions.length === 0 && !attention)
    return null;
  return (
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
      <TimelineContent
        items={items}
        timeline={timeline}
        questions={questions}
        restoreFocusRef={titleRef}
        t={t}
      />
    </section>
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
          (item) => showEvents || item.kind !== "event" || eventTone(item.event) === "attention",
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
  feed: UseCodingWorkbenchSafeActivityResult["feed"],
  generating: boolean,
  active: boolean,
): readonly TimelineItem[] {
  return useMemo(
    () =>
      timelineItems(
        events,
        feed,
        openMessageId(feed, generating),
        active ? (feed?.runId ?? events.at(-1)?.runId) : undefined,
      ),
    [events, feed, generating, active],
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
  for (const event of events) {
    newestByRun.set(event.runId, event);
    if (event.kind === "runtime-event" && event.eventKind === "failure-redacted") {
      lastFailureByRun.set(event.runId, event.cursor);
    }
  }
  return events.map((event, index) => ({
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
  }));
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

function timelineItems(
  events: readonly CodingWorkbenchRuntimeSseEvent[],
  feed: UseCodingWorkbenchSafeActivityResult["feed"],
  liveMessageId: string | undefined,
  activeRunId: string | undefined,
): readonly TimelineItem[] {
  const items: TimelineItem[] = timelineEventItems(events, activeRunId);
  let order = events.length;
  for (const turn of feed?.turns ?? []) {
    if (feed === null) break;
    for (const message of turn.messages) {
      if (!hasVisibleMessageContent(message)) continue;
      items.push({
        kind: "message",
        id: `message:${message.messageId}`,
        occurredAt: message.occurredAt,
        order,
        message,
        runId: feed.runId,
        live: message.messageId === liveMessageId,
      });
      order += 1;
    }
    for (const tool of turn.tools) {
      items.push({
        kind: "tool",
        id: `tool:${tool.callId}`,
        occurredAt: tool.occurredAt,
        order,
        tool,
        count: 1,
      });
      order += 1;
    }
  }
  const orderedItems = [...items];
  orderedItems.sort(compareTimelineItems);
  const compacted = compactToolItems(orderedItems);
  return feed?.plan === undefined
    ? compacted
    : insertPlan(compacted, feed.plan, order, activeRunId !== undefined);
}

function hasVisibleMessageContent(message: CodingSafeActivityMessage): boolean {
  return (
    message.truncated ||
    message.reasoning !== undefined ||
    message.segments.some((segment) => segment.truncated || segment.text.trim().length > 0)
  );
}

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
    if (item.kind !== "tool" || item.tool.state !== "succeeded") {
      grouped.push(item);
    } else if (previous?.kind === "group") {
      grouped[grouped.length - 1] = { ...previous, tools: [...previous.tools, item] };
    } else if (previous?.kind === "tool" && previous.tool.state === "succeeded") {
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
  const { resume } = follow;
  // A question is a decision the run waits for: a new one brings the list to its end even when the
  // reader had scrolled up, as the stream itself does for the run's own prompts.
  useEffect(() => {
    if (virtual && questionKey !== "") resume();
  }, [virtual, questionKey, resume]);
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
      <article className={styles.timelineBody} data-message-role={item.message.role}>
        {/* The agent's role is announced, not drawn above every step: repeated on each message
            between tool rows it was the loudest text of the timeline (#3897 UI review). */}
        <p className={item.message.role === "assistant" ? "sr-only" : styles.timelineTitle}>
          {t(`codingWorkbench.activity.role.${item.message.role}`)}
        </p>
        {item.message.reasoning === undefined ? null : (
          <ModelReasoning reasoning={item.message.reasoning} t={t} />
        )}
        <div className={styles.messageText}>
          <MessageContent message={item.message} runId={item.runId} live={item.live} t={t} />
        </div>
      </article>
    </li>
  );
}

// #3878: the model's own reasoning, apart from the answer. It is shown as the model wrote it under a
// plain "Thinking" summary: a warning-coloured "Unverified" read as a failed check on every step
// (#3897, owner), and a note inside every block was text Keiko added around the model's own (#3907,
// owner: less is more). The timeline's boundary sentence still says it is unverified. It is
// collapsed until the reader opens it, also while its turn streams, and its text is excluded from
// the log's live announcements: the session stream is a `role="log"`, whose additions a screen
// reader reads out, and up to 8 KiB of unverified reasoning per message would crowd out the answer
// the reader needs (#3873 review). A collapsed block exposes only its summary; an opened one keeps
// its streaming text out of the announcement with a nested `aria-live="off"`. The collapsed state
// is never driven from the run's state, so every toggle is the reader's and is reported.
function ModelReasoning({
  reasoning,
  t,
}: {
  readonly reasoning: NonNullable<CodingSafeActivityMessage["reasoning"]>;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  return (
    <details className={styles.cmpReasoning} aria-live="off">
      <summary
        className={styles.cmpActivitySummary}
        onClick={(event) => reportCodingWorkbenchSummaryActivated("model-reasoning", event)}
      >
        <span>{t("codingWorkbench.activity.reasoning.title")}</span>
      </summary>
      <p className={styles.cmpReasoningText}>
        {reasoning.text}
        {reasoning.truncated ? <TruncationMark t={t} /> : null}
      </p>
    </details>
  );
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
  if (message.role === "assistant") {
    // While the answer still streams, SafeMarkdown renders its code without highlighting or list
    // evidence on every update; the finished answer renders in full as soon as it is finished — also
    // while the run waits for the operator's decision.
    return (
      <SafeMarkdownBoundary
        source={message.segments.map((segment) => segment.text).join("")}
        streaming={live}
        diagnosticCorrelationId={runId}
        diagnosticMessageId={message.messageId}
        trailing={truncationFor(message, t)}
        richContent={CODING_WORKBENCH_RICH_CONTENT}
      />
    );
  }
  return (
    <>
      {message.segments.map((segment, index) => (
        <p key={`${message.messageId}:${String(index)}`}>
          {segment.text}
          {segment.truncated ? <TruncationMark t={t} /> : null}
        </p>
      ))}
      {message.truncated && !message.segments.some((segment) => segment.truncated) ? (
        <TruncationMark t={t} />
      ) : null}
    </>
  );
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
  const shownState = shownToolState(item.tool);
  return (
    <li
      ref={rowRef}
      className={styles.timelineItem}
      aria-posinset={position}
      aria-setsize={total}
      data-timeline-kind="tool"
    >
      <details
        className={styles.toolCard}
        data-tool-state={shownState}
        open={OPEN_WITH_REASON_STATES.has(shownState)}
      >
        <summary
          className={styles.cmpActivitySummary}
          onClick={(event) => reportCodingWorkbenchSummaryActivated("tool", event)}
        >
          <span className={styles.toolIcon} aria-hidden="true" />
          <div className={styles.toolMeta}>
            <p className={styles.timelineTitle}>{humanizeToolName(item.tool.tool, t)}</p>
            {item.tool.presentation?.relativePath === undefined ? null : (
              <code className={styles.toolName}>{item.tool.presentation.relativePath}</code>
            )}
          </div>
          {item.count > 1 ? (
            <span className={styles.toolCount}>
              {t("codingWorkbench.activity.toolCount", { count: item.count })}
            </span>
          ) : null}
          <ToolStateBadge tool={item.tool} state={shownState} t={t} />
        </summary>
        <ToolOutcome tool={item.tool} t={t} />
        <code className={styles.toolName}>{item.tool.tool}</code>
        <ToolPresentationDetails tool={item.tool} t={t} />
      </details>
    </li>
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
  "waiting-for-trust" | "no-runnable-steps" | "not-run"
>;
type ShownToolState = CodingSafeActivityTool["state"] | "exited" | UnrunVerificationOutcome;

const UNRUN_VERIFICATION_OUTCOMES: ReadonlySet<CodingSafeActivityVerificationOutcome> = new Set([
  "waiting-for-trust",
  "no-runnable-steps",
  "not-run",
]);

// The cards that open to the reason they ended as they did, rather than staying a one-line row.
const OPEN_WITH_REASON_STATES: ReadonlySet<ShownToolState> = new Set([
  "failed",
  "denied",
  "exited",
  "waiting-for-trust",
  "no-runnable-steps",
  "not-run",
]);

function isUnrunVerificationOutcome(
  outcome: CodingSafeActivityVerificationOutcome | undefined,
): outcome is UnrunVerificationOutcome {
  return outcome !== undefined && UNRUN_VERIFICATION_OUTCOMES.has(outcome);
}

function shownToolState(tool: CodingSafeActivityTool): ShownToolState {
  if (tool.state !== "failed") return tool.state;
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
  t,
}: {
  readonly tool: CodingSafeActivityTool;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  const exitCode = tool.presentation?.exitCode;
  if (exitCode !== undefined) {
    return (
      <p className={styles.cmpToolOutcome}>
        {t("codingWorkbench.activity.exitCode", { code: exitCode })}
      </p>
    );
  }
  const verificationOutcome = tool.presentation?.verificationOutcome;
  if (verificationOutcome !== undefined) {
    return (
      <p className={styles.cmpToolOutcome}>
        {t(`codingWorkbench.activity.verification.${verificationOutcome}`)}
      </p>
    );
  }
  return tool.state === "failed" ? (
    <p className={styles.cmpToolOutcome}>{t("codingWorkbench.activity.toolError")}</p>
  ) : null;
}

function ToolPresentationDetails({
  tool,
  t,
}: {
  readonly tool: CodingSafeActivityTool;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  const locale = useLocale();
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
      {facts.refusalReason === undefined ? null : (
        <p>{t("codingWorkbench.activity.editRefusal", { reason: facts.refusalReason })}</p>
      )}
      {facts.affectedRelativePath === undefined ? null : (
        <p>{t("codingWorkbench.activity.affectedFile", { path: facts.affectedRelativePath })}</p>
      )}
      {facts.bridgeDurationMs === undefined ? null : (
        <p>
          {t("codingWorkbench.activity.serviceDuration", {
            duration: formatDurationMs(facts.bridgeDurationMs, locale),
          })}
        </p>
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
  const count = item.tools.reduce((sum, tool) => sum + tool.count, 0);
  return (
    <li
      ref={rowRef}
      className={styles.timelineItem}
      aria-posinset={position}
      aria-setsize={total}
      data-timeline-kind="group"
    >
      <details className={styles.cmpToolGroup}>
        <summary
          className={styles.cmpActivitySummary}
          onClick={(event) => reportCodingWorkbenchSummaryActivated("activity-group", event)}
        >
          {t("codingWorkbench.activity.groupCount", { count })}
        </summary>
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
      </details>
    </li>
  );
}

function humanizeToolName(tool: string, t: CodingWorkbenchTranslate): string {
  // The id is runtime text: `constructor` must not resolve to a member inherited from Object.
  const knownKey = Object.hasOwn(KNOWN_TOOL_LABEL_KEYS, tool)
    ? KNOWN_TOOL_LABEL_KEYS[tool]
    : undefined;
  if (knownKey !== undefined) return t(knownKey);
  return tool
    .replace(/^keiko[_-]/u, "")
    .split(/[_\-.]+/u)
    .filter((part) => part.length > 0)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
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
  const tone = eventTone(item.event);
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
      </details>
    </li>
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

// A summary in which no check passed and none failed ran nothing: every step was skipped. It is
// shown as not run rather than as a failure the counts beside it contradict (#3897 UI review:
// "Tests: Failed · 0 passed, 0 unsuccessful, 1 skipped").
function shownVerificationStatus(
  summary: VerificationSummary,
): VerificationSummary["status"] | "notRun" {
  if (summary.status !== "passed" && summary.passedCount === 0 && summary.failedCount === 0) {
    return "notRun";
  }
  return summary.status;
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
      <p>
        {t("codingWorkbench.verification.checks", {
          passed: number.format(summary.passedCount),
          failed: number.format(summary.failedCount),
          skipped: number.format(summary.skippedCount),
        })}
      </p>
      <p>
        {t("codingWorkbench.verification.duration", {
          duration: formatDurationMs(summary.durationMs, locale),
        })}
      </p>
    </div>
  );
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
