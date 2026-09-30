"use client";

import { useId, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useContextDisclosure } from "./useContextDisclosure";
import type {
  ChatContextSegmentWire,
  ChatContextStatusWire,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import { useLocale, useTranslate, type I18nTranslate } from "@/lib/i18n";
import styles from "./ChatContextMeter.module.css";

export interface ChatContextMeterProps {
  readonly status: ChatContextStatusWire | undefined;
  readonly busy: boolean;
  readonly compacting: boolean;
  readonly error: boolean;
  readonly onCompact: () => void;
  readonly onRetry: () => void;
}

function contextTone(ratio: number | undefined): string {
  if (ratio === undefined) return "unknown";
  if (ratio >= 0.9) return "critical";
  if (ratio >= 0.8) return "warning";
  return "normal";
}

function ContextMetrics({ status }: { readonly status: ChatContextStatusWire }): ReactNode {
  const t = useTranslate();
  const locale = useLocale();
  const number = (value: number): string => value.toLocaleString(locale);
  const rows = [
    [t("chat.context.used"), number(status.estimatedInputTokens)],
    [t("chat.context.inputBudget"), number(status.inputBudgetTokens)],
    [t("chat.context.window"), number(status.contextWindowTokens)],
    [t("chat.context.outputReserve"), number(status.reservedOutputTokens)],
    [t("chat.context.safetyMargin"), number(status.safetyMarginTokens)],
  ];
  return (
    <>
      <dl className={styles.cmpMetrics}>
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <ContextFootnotes status={status} />
    </>
  );
}

// ─── Window breakdown (field report 1.1.13) ──────────────────────────────────────────────────
// One bar over the whole window and one legend row per share, in the order the server stacks them.
// Input shares use the design system's categorical data colours; space that is not input (free,
// compaction buffer, reserves) is drawn neutral or hatched, never distinguished by colour alone.

function segmentLabel(t: I18nTranslate, segment: ChatContextSegmentWire): string {
  const labels: Record<ChatContextSegmentWire["id"], string> = {
    system: t("chat.context.segment.system"),
    summary: t("chat.context.segment.summary"),
    messages: t("chat.context.segment.messages"),
    knowledge: t("chat.context.segment.knowledge"),
    free: t("chat.context.segment.free"),
    "compaction-buffer": t("chat.context.segment.compactionBuffer"),
    "output-reserve": t("chat.context.outputReserve"),
    "safety-margin": t("chat.context.safetyMargin"),
  };
  return labels[segment.id];
}

function segmentDetail(
  t: I18nTranslate,
  segment: ChatContextSegmentWire,
  status: ChatContextStatusWire,
): string | undefined {
  const count = segment.count ?? 0;
  if (segment.id === "messages" && count > 0)
    return t(count === 1 ? "chat.context.count.messages.one" : "chat.context.count.messages", {
      count,
    });
  if (segment.id === "summary" && count > 0)
    return t(count === 1 ? "chat.context.count.summary.one" : "chat.context.count.summary", {
      count,
    });
  const sources = status.knowledgeSources;
  if (segment.id !== "knowledge" || sources === undefined) return undefined;
  return t("chat.context.count.references", {
    sent: sources.sentReferenceCount,
    available: sources.availableReferenceCount,
  });
}

function visibleSegments(segments: readonly ChatContextSegmentWire[]): ChatContextSegmentWire[] {
  // An empty summary is noise; every other share stays listed so the window always adds up.
  return segments.filter((segment) => segment.id !== "summary" || segment.tokens > 0);
}

function SegmentBar({
  segments,
  window,
}: {
  readonly segments: readonly ChatContextSegmentWire[];
  readonly window: number;
}): ReactNode {
  return (
    <div className={styles.cmpBar} aria-hidden="true">
      {segments.map((segment) => (
        <span
          key={segment.id}
          className={styles.cmpBarSegment}
          data-segment={segment.id}
          style={{ flexGrow: segment.tokens / Math.max(1, window) }}
        />
      ))}
    </div>
  );
}

function SegmentRow({
  segment,
  status,
}: {
  readonly segment: ChatContextSegmentWire;
  readonly status: ChatContextStatusWire;
}): ReactNode {
  const t = useTranslate();
  const locale = useLocale();
  const detail = segmentDetail(t, segment, status);
  const share = (segment.tokens / Math.max(1, status.contextWindowTokens)) * 100;
  return (
    <li className={styles.cmpLegendRow} data-segment={segment.id}>
      <span className={styles.cmpSwatch} data-segment={segment.id} aria-hidden="true" />
      <span className={styles.cmpLegendLabel}>
        {segmentLabel(t, segment)}
        {detail === undefined ? null : <span className={styles.cmpLegendDetail}>{detail}</span>}
      </span>
      <span className={styles.cmpLegendValue}>{segment.tokens.toLocaleString(locale)}</span>
      <span className={styles.cmpLegendShare}>{formatContextPercent(share, locale)} %</span>
    </li>
  );
}

function ContextBreakdown({
  status,
  segments,
}: {
  readonly status: ChatContextStatusWire;
  readonly segments: readonly ChatContextSegmentWire[];
}): ReactNode {
  const t = useTranslate();
  const locale = useLocale();
  const shown = visibleSegments(segments);
  return (
    <>
      <p className={styles.cmpTotal}>
        {t("chat.context.total", {
          used: status.estimatedInputTokens.toLocaleString(locale),
          window: status.contextWindowTokens.toLocaleString(locale),
        })}
      </p>
      <SegmentBar segments={shown} window={status.contextWindowTokens} />
      <ul className={styles.cmpLegend} aria-label={t("chat.context.breakdown")}>
        {shown.map((segment) => (
          <SegmentRow key={segment.id} segment={segment} status={status} />
        ))}
      </ul>
      <ContextNotes status={status} />
    </>
  );
}

function ContextNotes({ status }: { readonly status: ChatContextStatusWire }): ReactNode {
  const t = useTranslate();
  const locale = useLocale();
  const number = (value: number): string => value.toLocaleString(locale);
  const sources = status.knowledgeSources;
  const trimmed =
    sources !== undefined && sources.sentReferenceCount < sources.availableReferenceCount;
  const until =
    status.autoCompactionAtTokens === undefined
      ? undefined
      : Math.max(0, status.autoCompactionAtTokens - status.estimatedInputTokens);
  return (
    <>
      {trimmed ? (
        <p className={styles.cmpWarning} role="note">
          {t("chat.context.referencesTrimmed", {
            sent: number(sources.sentReferenceCount),
            available: number(sources.availableReferenceCount),
          })}
        </p>
      ) : null}
      {status.lastRequest === undefined ? null : (
        <p className={styles.cmpHelp}>
          {t(
            status.lastRequest.measured
              ? "chat.context.lastRequestMeasured"
              : "chat.context.lastRequestEstimated",
            { tokens: number(status.lastRequest.promptTokens) },
          )}
        </p>
      )}
      {until === undefined ? null : (
        <p className={styles.cmpHelp}>
          {t("chat.context.untilCompaction", { tokens: number(until) })}
        </p>
      )}
    </>
  );
}

function ContextSummary({ status }: { readonly status: ChatContextStatusWire }): ReactNode {
  return status.segments === undefined ? (
    <ContextMetrics status={status} />
  ) : (
    <>
      <ContextBreakdown status={status} segments={status.segments} />
      <ContextFootnotes status={status} />
    </>
  );
}

// Savings, pending compaction and the assumed-window hint, shared by both presentations.
function ContextFootnotes({ status }: { readonly status: ChatContextStatusWire }): ReactNode {
  const t = useTranslate();
  const locale = useLocale();
  const number = (value: number): string => value.toLocaleString(locale);
  return (
    <>
      {status.compaction === undefined ? null : (
        <p className={styles.cmpSavings}>
          {t("chat.context.saved", {
            tokens: number(status.compaction.tokensSaved),
            count: number(status.compaction.messagesCompacted),
          })}
        </p>
      )}
      {status.pendingCompaction === undefined ? null : (
        <p className={styles.cmpSavings}>
          {t("chat.context.pending", {
            before: number(status.pendingCompaction.tokensBefore),
            after: number(status.pendingCompaction.tokensAfter),
          })}
        </p>
      )}
      {status.contextWindowAssumed === true ? (
        <p className={styles.cmpHelp}>{t("chat.context.windowAssumed")}</p>
      ) : null}
    </>
  );
}

function ContextDetails(props: ChatContextMeterProps): ReactNode {
  const t = useTranslate();
  return (
    <>
      {props.status === undefined ? (
        <p>{t("chat.context.unavailable")}</p>
      ) : (
        <ContextSummary status={props.status} />
      )}
      <p className={styles.cmpHelp}>{t("chat.context.estimate")}</p>
      <p className={styles.cmpHelp}>{t("chat.context.automatic")}</p>
      <p className={styles.cmpHelp}>{t("chat.context.retained")}</p>
      {props.status?.knowledgeSources === undefined ? null : (
        <p className={styles.cmpHelp}>{t("chat.context.sourcesPolicy")}</p>
      )}
      {props.error ? (
        <p>
          <output>
            {t("chat.context.error")}{" "}
            <button type="button" onClick={props.onRetry}>
              {t("chat.context.retry")}
            </button>
          </output>
        </p>
      ) : null}
      <button
        type="button"
        className={styles.cmpCompact}
        disabled={props.busy || props.compacting || props.status?.canCompact !== true}
        onClick={props.onCompact}
      >
        {t(props.compacting ? "chat.context.compacting" : "chat.context.compact")}
      </button>
      {props.busy ? <p className={styles.cmpHelp}>{t("chat.context.wait")}</p> : null}
    </>
  );
}

function ContextRing({
  percent,
  compacting,
}: {
  readonly percent: number | undefined;
  readonly compacting: boolean;
}): ReactNode {
  return (
    <svg
      viewBox="0 0 24 24"
      width="24"
      height="24"
      aria-hidden="true"
      className={compacting ? styles.cmpSpinning : undefined}
    >
      <circle className={styles.cmpTrack} cx="12" cy="12" r="9" fill="none" strokeWidth="3" />
      <circle
        className={styles.cmpFill}
        cx="12"
        cy="12"
        r="9"
        fill="none"
        strokeWidth="3"
        pathLength="100"
        strokeDasharray="100"
        strokeDashoffset={100 - Math.min(100, percent ?? 0)}
        transform="rotate(-90 12 12)"
      />
    </svg>
  );
}

export function ChatContextMeter(props: ChatContextMeterProps): ReactNode {
  const t = useTranslate();
  const locale = useLocale();
  const id = useId();
  const disclosure = useContextDisclosure();
  const ratio = contextRatio(props.status);
  const percent = ratio === undefined ? undefined : ratio * 100;
  const percentLabel = percent === undefined ? undefined : formatContextPercent(percent, locale);
  const label =
    percentLabel === undefined
      ? t("chat.context.unavailable")
      : t("chat.context.label", { percent: percentLabel });
  return (
    <div className={styles.cmpRoot} data-tone={contextTone(ratio)} aria-busy={props.compacting}>
      <button
        type="button"
        ref={disclosure.trigger}
        className={styles.cmpTrigger}
        aria-label={label}
        title={label}
        aria-controls={disclosure.open ? id : undefined}
        aria-expanded={disclosure.open}
        onClick={disclosure.toggle}
      >
        <ContextRing percent={percent} compacting={props.compacting} />
      </button>
      {disclosure.open
        ? createPortal(
            <section
              ref={disclosure.panel}
              id={id}
              className={styles.cmpPanel}
              style={disclosure.position}
              aria-label={t("chat.context.title")}
            >
              <h3>
                {percentLabel === undefined
                  ? t("chat.context.title")
                  : t("chat.context.heading", { percent: percentLabel })}
              </h3>
              <ContextDetails {...props} />
            </section>,
            document.body,
          )
        : null}
    </div>
  );
}

function formatContextPercent(percent: number, locale: string): string {
  if (percent > 0 && percent < 0.1) return `<${(0.1).toLocaleString(locale)}`;
  return percent.toLocaleString(locale, { maximumFractionDigits: 1 });
}

function contextRatio(status: ChatContextMeterProps["status"]): number | undefined {
  return status === undefined
    ? undefined
    : status.estimatedInputTokens / Math.max(1, status.inputBudgetTokens);
}
