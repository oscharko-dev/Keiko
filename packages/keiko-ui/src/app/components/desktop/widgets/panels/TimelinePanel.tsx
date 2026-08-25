"use client";

import type { CSSProperties, ReactElement } from "react";

import { useTranslate, type I18nTranslate } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n-messages.en";

import { useActivitySubscription, type ActivityEvent } from "../shared/activityBus";
import styles from "./TimelinePanel.module.css";

const KIND_COLOR: Record<ActivityEvent["type"], string> = {
  step: "var(--accent-cyan)",
  approval: "var(--accent-amber)",
  approved: "var(--state-success)",
  rejected: "var(--state-danger)",
  stopped: "var(--text-tertiary)",
  open: "var(--accent-violet)",
  run: "var(--accent-cyan)",
  delivery: "var(--state-success)",
};

const KIND_LABEL_KEYS: Record<ActivityEvent["type"], MessageKey> = {
  step: "activity.kind.step",
  approval: "activity.kind.approval",
  approved: "activity.kind.approved",
  rejected: "activity.kind.rejected",
  stopped: "activity.kind.stopped",
  open: "activity.kind.open",
  run: "activity.kind.run",
  delivery: "activity.kind.delivery",
};

function eventText(event: ActivityEvent, translate: I18nTranslate): string {
  if (event.labelKey !== undefined) return translate(event.labelKey);
  return event.text ?? translate("activity.event.unknown");
}

function eventTime(time: number): string {
  return new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function TimelineEvent({
  event,
  translate,
}: {
  readonly event: ActivityEvent;
  readonly translate: I18nTranslate;
}): ReactElement {
  const style = { "--activity-color": KIND_COLOR[event.type] } as CSSProperties;
  return (
    <li className={styles.event} style={style}>
      <span className={styles.dot} aria-hidden="true" />
      <div className={styles.content}>
        <span className={styles.kind}>{translate(KIND_LABEL_KEYS[event.type])}</span>
        <span className={styles.text}>{eventText(event, translate)}</span>
        <span className={styles.meta}>
          {event.agent ?? event.tool ?? translate("activity.actor.workspace")}
          <time dateTime={new Date(event.time).toISOString()}>{eventTime(event.time)}</time>
        </span>
      </div>
    </li>
  );
}

export default function TimelinePanel(): ReactElement {
  const events = useActivitySubscription();
  const translate = useTranslate();

  return (
    <section className={styles.root} aria-label={translate("activity.timeline.label")}>
      {events.length === 0 ? (
        <div className={styles.empty}>
          <strong>{translate("activity.empty.title")}</strong>
          <span>{translate("activity.empty.description")}</span>
        </div>
      ) : (
        <ol className={styles.timeline}>
          {events.map((event, index) => (
            <TimelineEvent
              key={event.id ?? `${event.time}-${index}`}
              event={event}
              translate={translate}
            />
          ))}
        </ol>
      )}
    </section>
  );
}
