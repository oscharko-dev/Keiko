"use client";
import { useId, type ReactNode } from "react";
import type { ChatToolExchange, ChatTurnState } from "@oscharko-dev/keiko-contracts/bff-wire";
import { useOptionalWidgetTranslate as useTranslate } from "@/lib/optional-widget-i18n";
import cardStyles from "./JiraChatTools.module.css";
import styles from "./JiraProgress.module.css";
import {
  batchProgressOf,
  batchProgressView,
  type ProgressTone,
  requirementsTone,
  type RequirementsReadView,
} from "./jira-tool-progress";

/** A counted bar; without a value it is indeterminate and the phase text stands alone. */
function ProgressBar({
  tone,
  label,
  value,
  max,
  stopped = false,
}: {
  readonly tone: ProgressTone;
  readonly label: string;
  readonly value: number | undefined;
  readonly max: number;
  readonly stopped?: boolean;
}): ReactNode {
  const labelId = useId();
  const indeterminate = value === undefined;
  const counted = value === undefined ? {} : { "aria-valuemax": max, "aria-valuenow": value };
  return (
    <div
      className={styles.cmpProgress}
      data-tone={tone}
      data-stopped={stopped ? "true" : undefined}
      data-indeterminate={indeterminate && !stopped ? "true" : undefined}
    >
      <span id={labelId} className={styles.cmpLabel}>
        {label}
      </span>
      <progress
        className={styles.cmpTrack}
        aria-labelledby={labelId}
        aria-valuemin={0}
        max={max > 0 ? max : undefined}
        value={value}
        data-complete={value === max ? "true" : undefined}
        {...counted}
      />
    </div>
  );
}

/** The counted progress of a draft batch, shown inside the batch's own tool card. */
export function BatchProgress({
  exchange,
  turnState,
}: {
  readonly exchange: ChatToolExchange;
  /** Once the turn no longer runs, a batch that never completed has stopped; this says why. */
  readonly turnState: ChatTurnState | undefined;
}): ReactNode {
  const t = useTranslate();
  const progress = batchProgressOf(exchange);
  if (progress === undefined) return null;
  const view = batchProgressView(exchange, progress, turnState);
  return (
    <div className={styles.cmpRegion}>
      <ProgressBar
        tone={view.tone}
        label={t(view.text, view.values)}
        value={view.value}
        max={view.max}
        stopped={view.stopped}
      />
      {view.notes.length === 0 ? null : (
        <ul className={cardStyles.cmpProblems}>
          {view.notes.map((note) => (
            <li key={note.key}>{t(note.key, note.values)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One card per read: what the turn has read of the requirements, across all pages. */
export function RequirementsReadCard({
  view,
  label,
}: {
  readonly view: RequirementsReadView;
  readonly label: string;
}): ReactNode {
  const t = useTranslate();
  const text = t("chat.requirements.read", { done: view.done, total: view.total });
  return (
    <section className={cardStyles.cmpCard} aria-label={label}>
      <div className={styles.cmpRegion}>
        <ProgressBar
          tone={requirementsTone(view)}
          label={text}
          value={view.done}
          max={Math.max(view.total, 1)}
        />
        {view.cuts.length === 0 ? null : (
          <ul className={cardStyles.cmpProblems}>
            <li>{view.cuts.map((cut) => t(cut.key, { count: cut.count })).join(" · ")}</li>
          </ul>
        )}
      </div>
    </section>
  );
}
