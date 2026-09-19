/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- The virtualized overflow list and restored timeline heading need programmatic keyboard focus. */
"use client";

import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
  type UIEvent,
} from "react";
import type {
  CodingSafeActivityMessage,
  CodingSafeActivityPlan,
  CodingSafeActivityTool,
  CodingWorkbenchRuntimeSseEvent,
} from "@oscharko-dev/keiko-contracts";

import type { UseCodingWorkbenchQuestionsResult } from "@/lib/useCodingWorkbenchQuestions";
import type { UseCodingWorkbenchSafeActivityResult } from "@/lib/useCodingWorkbenchSafeActivity";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { SafeMarkdownBoundary } from "../../SafeMarkdown";
import {
  useCodingWorkbenchTranslate,
  type CodingWorkbenchTranslate,
} from "./coding-workbench-i18n";
import type { CodingWorkbenchMessageKey } from "./coding-workbench-i18n.en";
import { eventDetail, eventTitle } from "./codingWorkbenchLabels";
import { CodingWorkbenchQuestionsSurface } from "./CodingWorkbenchQuestions";
import styles from "./CodingWorkbenchWindow.module.css";

const VIRTUAL_THRESHOLD = 100;
const VISIBLE_ROWS = 96;
const OVERSCAN_ROWS = 8;
// Known tool identifiers map to Coding Workbench catalog message keys, not to English strings —
// otherwise a German session would render English labels in the localized timeline. The keys are
// resolved through `t(...)` inside `ToolRow`.
const KNOWN_TOOL_LABEL_KEYS: Readonly<Record<string, CodingWorkbenchMessageKey>> = {
  keiko_git_status: "codingWorkbench.timeline.tool.git_status",
  keiko_repository_search: "codingWorkbench.timeline.tool.repository_search",
  keiko_workspace_discover: "codingWorkbench.timeline.tool.workspace_discover",
  keiko_workspace_read: "codingWorkbench.timeline.tool.workspace_read",
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
    }
  | {
      readonly kind: "event";
      readonly id: string;
      readonly occurredAt: string;
      readonly order: number;
      readonly event: CodingWorkbenchRuntimeSseEvent;
    };

export interface CodingWorkbenchTimelineProps {
  readonly active?: boolean;
  readonly events: readonly CodingWorkbenchRuntimeSseEvent[];
  readonly activity: UseCodingWorkbenchSafeActivityResult;
  readonly questions: UseCodingWorkbenchQuestionsResult;
  readonly focusRef?: RefObject<HTMLHeadingElement | null>;
}

export function Timeline({
  active = false,
  events,
  activity,
  questions,
  focusRef,
}: CodingWorkbenchTimelineProps): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const internalTitleRef = useRef<HTMLHeadingElement>(null);
  const titleRef = focusRef ?? internalTitleRef;
  const [showEvents, setShowEvents] = useState(false);
  const allItems = useMemo(() => timelineItems(events, activity.feed), [activity.feed, events]);
  const items = useMemo(
    () =>
      groupCompletedTools(
        allItems.filter(
          (item) => showEvents || item.kind !== "event" || eventTone(item.event) === "attention",
        ),
      ),
    [allItems, showEvents],
  );
  const timeline = useTimelineWindow(items);
  if (!active && allItems.length === 0 && questions.questions.length === 0) return null;
  return (
    <section className={styles.cmpConversation} aria-labelledby="timeline-title">
      <TimelineHeading titleRef={titleRef} t={t} />
      {active ? <ActivityStatus activity={activity} t={t} /> : null}
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
        reportClientDiagnostic("[keiko] coding workbench run details toggled");
      }}
    >
      {t("codingWorkbench.timeline.details")}
    </button>
  );
}

function timelineItems(
  events: readonly CodingWorkbenchRuntimeSseEvent[],
  feed: UseCodingWorkbenchSafeActivityResult["feed"],
): readonly TimelineItem[] {
  const items: TimelineItem[] = events.map((event, index) => ({
    kind: "event",
    id: `event:${event.runId}:${event.cursor}`,
    occurredAt: event.occurredAt,
    order: index,
    event,
  }));
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
  return feed?.plan === undefined ? compacted : insertPlan(compacted, feed.plan, order);
}

function hasVisibleMessageContent(message: CodingSafeActivityMessage): boolean {
  return (
    message.truncated ||
    message.segments.some((segment) => segment.truncated || segment.text.trim().length > 0)
  );
}

function compareTimelineItems(left: TimelineItem, right: TimelineItem): number {
  const byTime = left.occurredAt.localeCompare(right.occurredAt);
  return byTime === 0 ? left.order - right.order : byTime;
}

function insertPlan(
  items: readonly TimelineItem[],
  plan: CodingSafeActivityPlan,
  order: number,
): readonly TimelineItem[] {
  const planItem: TimelineItem = {
    kind: "plan",
    id: `plan:${String(plan.revision)}`,
    occurredAt: plan.updatedAt,
    order,
    plan,
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
      compacted[compacted.length - 1] = {
        ...previous,
        id: `${previous.id}:${item.tool.callId}`,
        count: previous.count + 1,
      };
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
    previous.tool.tool === tool.tool
  );
}

interface TimelineWindow {
  readonly virtual: boolean;
  readonly start: number;
  readonly visible: readonly TimelineItem[];
  readonly end: number;
  readonly onScroll: (event: UIEvent<HTMLOListElement>) => void;
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
): readonly number[] {
  return useMemo(() => {
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
  }, [items, heightsVersion]);
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

function useTimelineWindow(items: readonly TimelineItem[]): TimelineWindow {
  const [scrollTop, setScrollTop] = useState(0);
  const heightsRef = useRef<ReadonlyMap<string, number>>(new Map());
  const [heightsVersion, setHeightsVersion] = useState(0);
  const cumulative = useCumulativeOffsets(items, heightsRef, heightsVersion);
  const virtual = items.length > VIRTUAL_THRESHOLD;
  const measureRow = useCallback((id: string, height: number): void => {
    const map = heightsRef.current;
    if (map.get(id) === height) return;
    const next = new Map(map);
    next.set(id, height);
    heightsRef.current = next;
    setHeightsVersion((value) => value + 1);
  }, []);
  const hasMeasured = useCallback((id: string): boolean => heightsRef.current.has(id), []);
  const onScroll = useCallback(
    (event: UIEvent<HTMLOListElement>): void => setScrollTop(event.currentTarget.scrollTop),
    [],
  );
  if (!virtual) {
    return {
      virtual: false,
      start: 0,
      visible: items,
      end: items.length,
      onScroll,
      measureRow,
      hasMeasured,
      spacerBefore: 0,
      spacerAfter: 0,
    };
  }
  const startIndex = Math.max(0, indexAtOffset(cumulative, scrollTop) - OVERSCAN_ROWS);
  const start = Math.min(startIndex, Math.max(0, items.length - VISIBLE_ROWS));
  const end = Math.min(items.length, start + VISIBLE_ROWS);
  const visible = items.slice(start, end);
  const totalHeight = cumulative[items.length] ?? 0;
  return {
    virtual: true,
    start,
    visible,
    end,
    onScroll,
    measureRow,
    hasMeasured,
    spacerBefore: cumulative[start] ?? 0,
    spacerAfter: Math.max(0, totalHeight - (cumulative[end] ?? totalHeight)),
  };
}

function ActivityStatus({
  activity,
  t,
}: {
  readonly activity: UseCodingWorkbenchSafeActivityResult;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  const truncated =
    activity.feed?.truncated === true ||
    activity.feed?.turns.some((turn) => turn.truncated) === true;
  if (
    !truncated &&
    !retryableActivity(activity.status) &&
    (activity.feed?.droppedEventCount ?? 0) === 0
  )
    return null;
  return (
    <div className={styles.activityStatus} data-activity-state={activity.status}>
      <p role="status" aria-live="polite" aria-atomic="true">
        {t(`codingWorkbench.activity.status.${activity.status}`)}
      </p>
      {truncated ? <p>{t("codingWorkbench.activity.truncated")}</p> : null}
      {(activity.feed?.droppedEventCount ?? 0) > 0 ? (
        <p>
          {t("codingWorkbench.activity.dropped", {
            count: activity.feed?.droppedEventCount ?? 0,
          })}
        </p>
      ) : null}
      {retryableActivity(activity.status) ? (
        <button className={styles.button} type="button" onClick={activity.retry}>
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
  if (questions.questions.length > 0 || !QUESTION_SUMMARY_STATES.has(questions.status)) return null;
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
  const {
    virtual,
    start,
    visible,
    end,
    onScroll,
    measureRow,
    hasMeasured,
    spacerBefore,
    spacerAfter,
  } = timeline;
  const questionCount = questions.questions.length > 0 ? 1 : 0;
  const total = items.length + questionCount;
  return (
    <ol
      className={styles.timeline}
      data-virtual={virtual}
      aria-label={t("codingWorkbench.timeline.listLabel")}
      aria-describedby={virtual ? "coding-workbench-timeline-instructions" : undefined}
      tabIndex={virtual ? 0 : undefined}
      onScroll={onScroll}
    >
      {virtual && spacerBefore > 0 ? <TimelineSpacer size={spacerBefore} /> : null}
      {visible.map((item, index) => (
        <TimelineRow
          key={item.id}
          item={item}
          position={start + index + 1}
          total={total}
          t={t}
          measureRow={measureRow}
          hasMeasured={hasMeasured}
        />
      ))}
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

function TimelineRow({
  item,
  position,
  total,
  t,
  measureRow,
  hasMeasured,
}: {
  readonly item: TimelineItem;
  readonly position: number;
  readonly total: number;
  readonly t: CodingWorkbenchTranslate;
  readonly measureRow: (id: string, height: number) => void;
  readonly hasMeasured: (id: string) => boolean;
}): ReactNode {
  const rowProps = { item, position, total, t, measureRow, hasMeasured };
  if (item.kind === "group") return <ToolGroupRow {...rowProps} item={item} />;
  if (item.kind === "message") return <MessageRow {...rowProps} item={item} />;
  if (item.kind === "tool") return <ToolRow {...rowProps} item={item} />;
  if (item.kind === "plan") return <PlanRow {...rowProps} item={item} />;
  return <EventRow {...rowProps} item={item} />;
}

interface RowProps<T extends TimelineItem> {
  readonly item: T;
  readonly position: number;
  readonly total: number;
  readonly t: CodingWorkbenchTranslate;
  readonly measureRow: (id: string, height: number) => void;
  readonly hasMeasured: (id: string) => boolean;
}

function MessageRow({
  item,
  position,
  total,
  t,
  measureRow,
  hasMeasured,
}: RowProps<Extract<TimelineItem, { kind: "message" }>>): ReactNode {
  const rowRef = useRowMeasurement(item.id, measureRow, hasMeasured);
  return (
    <li
      ref={rowRef}
      className={styles.timelineItem}
      aria-posinset={position}
      aria-setsize={total}
      data-timeline-kind="message"
    >
      <article className={styles.timelineBody} data-message-role={item.message.role}>
        <p className={styles.timelineTitle}>
          {t(`codingWorkbench.activity.role.${item.message.role}`)}
        </p>
        <div className={styles.messageText}>
          <MessageContent message={item.message} runId={item.runId} t={t} />
        </div>
      </article>
    </li>
  );
}

function MessageContent({
  message,
  runId,
  t,
}: {
  readonly message: CodingSafeActivityMessage;
  readonly t: CodingWorkbenchTranslate;
  readonly runId: string;
}): ReactNode {
  if (message.role === "assistant") {
    return (
      <SafeMarkdownBoundary
        source={message.segments.map((segment) => segment.text).join("")}
        applyScopeId={`coding-workbench:${message.messageId}`}
        diagnosticCorrelationId={runId}
        diagnosticMessageId={message.messageId}
        trailing={truncationFor(message, t)}
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
}: RowProps<Extract<TimelineItem, { kind: "tool" }>> & { readonly grouped?: boolean }): ReactNode {
  const rowRef = useRowMeasurement(item.id, measureRow, hasMeasured, !grouped);
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
        data-tool-state={item.tool.state}
        open={item.tool.state === "failed" || item.tool.state === "denied"}
        onToggle={() => reportClientDiagnostic("[keiko] coding workbench tool details toggled")}
      >
        <summary className={styles.cmpActivitySummary}>
          <span className={styles.toolIcon} aria-hidden="true" />
          <div className={styles.toolMeta}>
            <p className={styles.timelineTitle}>{humanizeToolName(item.tool.tool, t)}</p>
          </div>
          {item.count > 1 ? (
            <span className={styles.toolCount}>
              {t("codingWorkbench.activity.toolCount", { count: item.count })}
            </span>
          ) : null}
          <span className={styles.activityBadge} data-state={item.tool.state}>
            {t(`codingWorkbench.activity.toolState.${item.tool.state}`)}
          </span>
        </summary>
        <code className={styles.toolName}>{item.tool.tool}</code>
      </details>
    </li>
  );
}

function ToolGroupRow({
  item,
  position,
  total,
  t,
  measureRow,
  hasMeasured,
}: RowProps<Extract<TimelineItem, { kind: "group" }>>): ReactNode {
  const rowRef = useRowMeasurement(item.id, measureRow, hasMeasured);
  const count = item.tools.reduce((sum, tool) => sum + tool.count, 0);
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
        onToggle={() => reportClientDiagnostic("[keiko] coding workbench activity group toggled")}
      >
        <summary className={styles.cmpActivitySummary}>
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
            />
          ))}
        </ol>
      </details>
    </li>
  );
}

function humanizeToolName(tool: string, t: CodingWorkbenchTranslate): string {
  const knownKey = KNOWN_TOOL_LABEL_KEYS[tool];
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
}: RowProps<Extract<TimelineItem, { kind: "plan" }>>): ReactNode {
  const rowRef = useRowMeasurement(item.id, measureRow, hasMeasured);
  return (
    <li
      ref={rowRef}
      className={styles.timelineItem}
      aria-posinset={position}
      aria-setsize={total}
      data-timeline-kind="plan"
    >
      <details
        className={styles.planCard}
        onToggle={() => reportClientDiagnostic("[keiko] coding workbench plan details toggled")}
      >
        <summary className={styles.cmpActivitySummary}>
          <p className={styles.timelineTitle}>{t("codingWorkbench.activity.plan.title")}</p>
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

function EventRow({
  item,
  position,
  total,
  t,
  measureRow,
  hasMeasured,
}: RowProps<Extract<TimelineItem, { kind: "event" }>>): ReactNode {
  const rowRef = useRowMeasurement(item.id, measureRow, hasMeasured);
  const tone = eventTone(item.event);
  return (
    <li
      ref={rowRef}
      className={styles.timelineItem}
      aria-posinset={position}
      aria-setsize={total}
      data-timeline-kind="event"
      data-event-tone={tone}
    >
      <details
        className={styles.eventCard}
        open={tone === "attention"}
        onToggle={() => reportClientDiagnostic("[keiko] coding workbench event details toggled")}
      >
        <summary className={styles.cmpActivitySummary}>{eventTitle(item.event, t)}</summary>
        <p className={styles.timelineDetail}>{eventDetail(item.event, t)}</p>
      </details>
    </li>
  );
}

function eventTone(event: CodingWorkbenchRuntimeSseEvent): "attention" | "routine" | "success" {
  if (event.failureCode !== undefined) return "attention";
  if (event.kind === "runtime-event" && event.eventKind === "failure-redacted") return "attention";
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
