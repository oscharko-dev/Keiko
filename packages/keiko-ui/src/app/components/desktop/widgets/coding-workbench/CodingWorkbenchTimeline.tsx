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
import {
  useCodingWorkbenchTranslate,
  type CodingWorkbenchTranslate,
} from "./coding-workbench-i18n";
import { eventDetail, eventTitle } from "./codingWorkbenchLabels";
import { CodingWorkbenchQuestionsSurface } from "./CodingWorkbenchQuestions";
import { PanelTitle } from "./CodingWorkbenchPanelTitle";
import styles from "./CodingWorkbenchWindow.module.css";

const VIRTUAL_THRESHOLD = 100;
const VISIBLE_ROWS = 96;
const OVERSCAN_ROWS = 8;
// Per-kind default heights used until a row has been rendered and measured. A single 64 px
// estimate (the pre-fix value) is 4–20x too small for plan cards and multi-segment messages,
// which is what makes scroll offsets drift on long feeds.
const ROW_HEIGHT_BY_KIND: Record<TimelineItemKind, number> = {
  message: 96,
  tool: 72,
  plan: 320,
  event: 88,
};
const QUESTION_SUMMARY_STATES = new Set(["offline", "error", "stale", "unpaired"]);

type TimelineItemKind = "message" | "tool" | "plan" | "event";

type TimelineItem =
  | {
      readonly kind: "message";
      readonly id: string;
      readonly occurredAt: string;
      readonly order: number;
      readonly message: CodingSafeActivityMessage;
    }
  | {
      readonly kind: "tool";
      readonly id: string;
      readonly occurredAt: string;
      readonly order: number;
      readonly tool: CodingSafeActivityTool;
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
  readonly events: readonly CodingWorkbenchRuntimeSseEvent[];
  readonly activity: UseCodingWorkbenchSafeActivityResult;
  readonly questions: UseCodingWorkbenchQuestionsResult;
  readonly focusRef?: RefObject<HTMLHeadingElement | null>;
}

export function Timeline({
  events,
  activity,
  questions,
  focusRef,
}: CodingWorkbenchTimelineProps): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const internalTitleRef = useRef<HTMLHeadingElement>(null);
  const titleRef = focusRef ?? internalTitleRef;
  const items = useMemo(() => timelineItems(events, activity.feed), [activity.feed, events]);
  const timeline = useTimelineWindow(items);
  return (
    <section className={styles.card} aria-labelledby="timeline-title">
      <PanelTitle
        eyebrow={t("codingWorkbench.timeline.eyebrow")}
        id="timeline-title"
        headingRef={titleRef}
        focusable
      >
        {t("codingWorkbench.timeline.title")}
      </PanelTitle>
      <p className="sr-only">{t("codingWorkbench.activity.reasoningBoundary")}</p>
      <ActivityStatus activity={activity} t={t} />
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
    for (const message of turn.messages) {
      items.push({
        kind: "message",
        id: `message:${message.messageId}`,
        occurredAt: message.occurredAt,
        order,
        message,
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
      });
      order += 1;
    }
  }
  items.sort(compareTimelineItems);
  return feed?.plan === undefined ? items : insertPlan(items, feed.plan, order);
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
    return <p className={styles.emptyText}>{t("codingWorkbench.timeline.empty")}</p>;
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

function TimelineList({
  items,
  timeline: {
    virtual,
    start,
    visible,
    end,
    onScroll,
    measureRow,
    hasMeasured,
    spacerBefore,
    spacerAfter,
  },
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
  const questionCount = questions.questions.length > 0 ? 1 : 0;
  const total = items.length + questionCount;
  return (
    <ol
      className={styles.timeline}
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
): RefObject<HTMLLIElement | null> {
  const ref = useRef<HTMLLIElement>(null);
  // Deliberately no dependency array: the effect must fire whenever the row commits so an
  // unmeasured row picks up its height as soon as the browser has laid it out. The hasMeasured
  // guard is what keeps the effect cheap — once a row's height is cached, subsequent commits
  // (including scroll-induced ones) short-circuit before touching `offsetHeight`, which is what
  // the pre-fix version would otherwise thrash on every visible row on every scroll.
  useLayoutEffect(() => {
    if (hasMeasured(id)) return;
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
      <span className={styles.timelineMarker} aria-hidden="true" />
      <article className={styles.timelineBody}>
        <p className={styles.timelineTitle}>
          {t(`codingWorkbench.activity.role.${item.message.role}`)}
        </p>
        <div className={styles.messageText}>
          {item.message.segments.map((segment, index) => (
            <p key={`${item.message.messageId}:${String(index)}`}>
              {segment.text}
              {segment.truncated ? <TruncationMark t={t} /> : null}
            </p>
          ))}
          {item.message.truncated && !item.message.segments.some((segment) => segment.truncated) ? (
            <TruncationMark t={t} />
          ) : null}
        </div>
      </article>
    </li>
  );
}

function ToolRow({
  item,
  position,
  total,
  t,
  measureRow,
  hasMeasured,
}: RowProps<Extract<TimelineItem, { kind: "tool" }>>): ReactNode {
  const rowRef = useRowMeasurement(item.id, measureRow, hasMeasured);
  return (
    <li
      ref={rowRef}
      className={styles.timelineItem}
      aria-posinset={position}
      aria-setsize={total}
      data-timeline-kind="tool"
    >
      <span className={styles.timelineMarker} aria-hidden="true" />
      <article className={styles.toolCard} data-tool-state={item.tool.state}>
        <p className={styles.timelineTitle}>
          {t("codingWorkbench.activity.tool", { tool: item.tool.tool })}
        </p>
        <span className={styles.activityBadge} data-state={item.tool.state}>
          {t(`codingWorkbench.activity.toolState.${item.tool.state}`)}
        </span>
      </article>
    </li>
  );
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
      <span className={styles.timelineMarker} aria-hidden="true" />
      <section className={styles.planCard} aria-label={t("codingWorkbench.activity.plan.title")}>
        <p className={styles.timelineTitle}>{t("codingWorkbench.activity.plan.title")}</p>
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
      </section>
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
  return (
    <li
      ref={rowRef}
      className={styles.timelineItem}
      aria-posinset={position}
      aria-setsize={total}
      data-timeline-kind="event"
    >
      <span className={styles.timelineMarker} aria-hidden="true" />
      <div className={styles.timelineBody}>
        <p className={styles.timelineTitle}>{eventTitle(item.event, t)}</p>
        <p className={styles.timelineDetail}>{eventDetail(item.event, t)}</p>
      </div>
    </li>
  );
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
      <span className={styles.timelineMarker} aria-hidden="true" />
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
