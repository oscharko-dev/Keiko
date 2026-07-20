/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- The virtualized overflow list and restored timeline heading need programmatic keyboard focus. */
"use client";

import { useMemo, useRef, useState, type ReactNode, type RefObject, type UIEvent } from "react";
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
const ROW_HEIGHT = 64;
const QUESTION_SUMMARY_STATES = new Set(["offline", "error", "stale", "unpaired"]);

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
}

export function Timeline({ events, activity, questions }: CodingWorkbenchTimelineProps): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const titleRef = useRef<HTMLHeadingElement>(null);
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
      <p className={styles.helpText}>{t("codingWorkbench.activity.reasoningBoundary")}</p>
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
}

function useTimelineWindow(items: readonly TimelineItem[]): TimelineWindow {
  const [scrollTop, setScrollTop] = useState(0);
  const virtual = items.length > VIRTUAL_THRESHOLD;
  const start = virtual
    ? Math.min(Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 8), items.length - VISIBLE_ROWS)
    : 0;
  const visible = virtual ? items.slice(start, start + VISIBLE_ROWS) : items;
  const end = start + visible.length;
  const onScroll = (event: UIEvent<HTMLOListElement>): void =>
    setScrollTop(event.currentTarget.scrollTop);
  return { virtual, start, visible, end, onScroll };
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
  timeline: { virtual, start, visible, end, onScroll },
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
      {virtual && start > 0 ? <TimelineSpacer size={start * ROW_HEIGHT} /> : null}
      {visible.map((item, index) => (
        <TimelineRow key={item.id} item={item} position={start + index + 1} total={total} t={t} />
      ))}
      {virtual && end < items.length ? (
        <TimelineSpacer size={(items.length - end) * ROW_HEIGHT} />
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

function TimelineRow({
  item,
  position,
  total,
  t,
}: {
  readonly item: TimelineItem;
  readonly position: number;
  readonly total: number;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  if (item.kind === "message")
    return <MessageRow item={item} position={position} total={total} t={t} />;
  if (item.kind === "tool") return <ToolRow item={item} position={position} total={total} t={t} />;
  if (item.kind === "plan") return <PlanRow item={item} position={position} total={total} t={t} />;
  return <EventRow item={item} position={position} total={total} t={t} />;
}

interface RowProps<T extends TimelineItem> {
  readonly item: T;
  readonly position: number;
  readonly total: number;
  readonly t: CodingWorkbenchTranslate;
}

function MessageRow({
  item,
  position,
  total,
  t,
}: RowProps<Extract<TimelineItem, { kind: "message" }>>): ReactNode {
  return (
    <li
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
}: RowProps<Extract<TimelineItem, { kind: "tool" }>>): ReactNode {
  return (
    <li
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
}: RowProps<Extract<TimelineItem, { kind: "plan" }>>): ReactNode {
  return (
    <li
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
}: RowProps<Extract<TimelineItem, { kind: "event" }>>): ReactNode {
  return (
    <li
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
