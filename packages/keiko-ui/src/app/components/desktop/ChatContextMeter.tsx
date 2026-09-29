"use client";

import { useId, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useContextDisclosure } from "./useContextDisclosure";
import type { ChatContextStatusWire } from "@oscharko-dev/keiko-contracts/bff-wire";
import { useLocale, useTranslate } from "@/lib/i18n";
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
      {status.compaction === undefined ? null : (
        <p className={styles.cmpSavings}>
          {t("chat.context.saved", {
            tokens: number(status.compaction.tokensSaved),
            count: number(status.compaction.messagesCompacted),
          })}
        </p>
      )}
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
        <ContextMetrics status={props.status} />
      )}
      <p className={styles.cmpHelp}>{t("chat.context.estimate")}</p>
      <p className={styles.cmpHelp}>{t("chat.context.automatic")}</p>
      <p className={styles.cmpHelp}>{t("chat.context.retained")}</p>
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
  const id = useId();
  const disclosure = useContextDisclosure();
  const ratio =
    props.status === undefined
      ? undefined
      : props.status.estimatedInputTokens / Math.max(1, props.status.inputBudgetTokens);
  const percent = ratio === undefined ? undefined : Math.floor(ratio * 100);
  const label =
    percent === undefined ? t("chat.context.unavailable") : t("chat.context.label", { percent });
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
                {t("chat.context.title")} {percent === undefined ? "" : `${String(percent)} %`}
              </h3>
              <ContextDetails {...props} />
            </section>,
            document.body,
          )
        : null}
    </div>
  );
}
