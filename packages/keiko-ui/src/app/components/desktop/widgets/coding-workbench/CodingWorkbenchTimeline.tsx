/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- The virtualized overflow list must receive focus for native keyboard scrolling. */
import { useState, type ReactNode, type UIEvent } from "react";
import type { CodingWorkbenchRuntimeSseEvent } from "@oscharko-dev/keiko-contracts";
import { useTranslate, type I18nTranslate } from "@/lib/i18n";
import { eventDetail, eventTitle } from "./codingWorkbenchLabels";
import { PanelTitle } from "./CodingWorkbenchPanelTitle";
import styles from "./CodingWorkbenchWindow.module.css";

const VIRTUAL_THRESHOLD = 100;
const VISIBLE_ROWS = 96;
const ROW_HEIGHT = 64;

export function Timeline({
  events,
}: {
  readonly events: readonly CodingWorkbenchRuntimeSseEvent[];
}): ReactNode {
  const t = useTranslate();
  const timeline = useTimelineWindow(events);
  return (
    <section className={styles.card} aria-labelledby="timeline-title">
      <PanelTitle eyebrow={t("codingWorkbench.timeline.eyebrow")} id="timeline-title">
        {t("codingWorkbench.timeline.title")}
      </PanelTitle>
      <TimelineContent events={events} timeline={timeline} t={t} />
    </section>
  );
}

interface TimelineWindow {
  readonly virtual: boolean;
  readonly start: number;
  readonly visible: readonly CodingWorkbenchRuntimeSseEvent[];
  readonly end: number;
  readonly onScroll: (event: UIEvent<HTMLOListElement>) => void;
}

function useTimelineWindow(events: readonly CodingWorkbenchRuntimeSseEvent[]): TimelineWindow {
  const [scrollTop, setScrollTop] = useState(0);
  const virtual = events.length > VIRTUAL_THRESHOLD;
  const start = virtual
    ? Math.min(Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 8), events.length - VISIBLE_ROWS)
    : 0;
  const visible = virtual ? events.slice(start, start + VISIBLE_ROWS) : events;
  const end = start + visible.length;
  const onScroll = (event: UIEvent<HTMLOListElement>): void =>
    setScrollTop(event.currentTarget.scrollTop);
  return { virtual, start, visible, end, onScroll };
}

function TimelineContent({
  events,
  timeline,
  t,
}: {
  readonly events: readonly CodingWorkbenchRuntimeSseEvent[];
  readonly timeline: TimelineWindow;
  readonly t: I18nTranslate;
}): ReactNode {
  if (events.length === 0)
    return <p className={styles.emptyText}>{t("codingWorkbench.timeline.empty")}</p>;
  return (
    <>
      {timeline.virtual ? (
        <p id="coding-workbench-timeline-instructions" className={styles.helpText}>
          {t("codingWorkbench.timeline.instructions")}
        </p>
      ) : null}
      <TimelineList events={events} timeline={timeline} t={t} />
    </>
  );
}

function TimelineList({
  events,
  timeline: { virtual, start, visible, end, onScroll },
  t,
}: {
  readonly events: readonly CodingWorkbenchRuntimeSseEvent[];
  readonly timeline: TimelineWindow;
  readonly t: I18nTranslate;
}): ReactNode {
  return (
    <ol
      className={styles.timeline}
      aria-label={t("codingWorkbench.timeline.listLabel")}
      aria-describedby={virtual ? "coding-workbench-timeline-instructions" : undefined}
      tabIndex={virtual ? 0 : undefined}
      onScroll={onScroll}
    >
      {virtual && start > 0 ? <TimelineSpacer size={start * ROW_HEIGHT} /> : null}
      {visible.map((event, index) => (
        <TimelineRow
          key={`${event.runId}:${event.cursor}`}
          event={event}
          position={start + index + 1}
          total={events.length}
          t={t}
        />
      ))}
      {virtual && end < events.length ? (
        <TimelineSpacer size={(events.length - end) * ROW_HEIGHT} />
      ) : null}
    </ol>
  );
}

function TimelineSpacer({ size }: { readonly size: number }): ReactNode {
  return <li className={styles.timelineSpacer} style={{ blockSize: size }} aria-hidden="true" />;
}

function TimelineRow({
  event,
  position,
  total,
  t,
}: {
  readonly event: CodingWorkbenchRuntimeSseEvent;
  readonly position: number;
  readonly total: number;
  readonly t: I18nTranslate;
}): ReactNode {
  return (
    <li className={styles.timelineItem} aria-posinset={position} aria-setsize={total}>
      <span className={styles.timelineMarker} aria-hidden="true" />
      <div>
        <p className={styles.timelineTitle}>{eventTitle(event, t)}</p>
        <p className={styles.timelineDetail}>{eventDetail(event, t)}</p>
      </div>
    </li>
  );
}
