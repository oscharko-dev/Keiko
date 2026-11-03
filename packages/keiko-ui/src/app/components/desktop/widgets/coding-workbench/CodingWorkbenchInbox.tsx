"use client";

import type { ReactNode } from "react";
import type { CodingWorkbenchRuntimeInboxItem } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-api";

import type { CodingWorkbenchInboxStatus } from "@/lib/useCodingWorkbenchInbox";
import {
  useCodingWorkbenchTranslate,
  type CodingWorkbenchTranslate,
} from "./coding-workbench-i18n";
import windowStyles from "./CodingWorkbenchWindow.module.css";
import styles from "./CodingWorkbenchInbox.module.css";

export interface CodingWorkbenchInboxProps {
  readonly status: CodingWorkbenchInboxStatus;
  /** The waiting messages in the order the model receives them. */
  readonly items: readonly CodingWorkbenchRuntimeInboxItem[];
  /** A runtime mutation is in flight: the controls wait instead of racing it. */
  readonly busy: boolean;
  readonly onCancel: (itemId: string) => void;
  /** Changes a queued message to Send now, so it joins the running task at its next step. */
  readonly onSendNow: (itemId: string) => void;
  readonly onRetry: () => void;
}

interface InboxRowProps {
  readonly item: CodingWorkbenchRuntimeInboxItem;
  readonly busy: boolean;
  readonly onCancel: (itemId: string) => void;
  readonly onSendNow: (itemId: string) => void;
  readonly t: CodingWorkbenchTranslate;
}

function InboxRow({ item, busy, onCancel, onSendNow, t }: InboxRowProps): ReactNode {
  const empty = item.preview.length === 0;
  const text = empty ? t("codingWorkbench.inbox.emptyPreview") : item.preview;
  return (
    <li className={styles.cmpInboxItem} data-delivery={item.delivery}>
      <span
        className={styles.cmpInboxBadge}
        data-delivery={item.delivery}
        title={t(`codingWorkbench.inbox.delivery.${item.delivery}.help`)}
      >
        {t(`codingWorkbench.inbox.delivery.${item.delivery}`)}
      </span>
      <p className={styles.cmpInboxText} data-empty={empty ? "true" : "false"}>
        {text}
      </p>
      <span className={styles.cmpInboxActions}>
        {item.delivery === "queue" ? (
          <button
            className={windowStyles.button}
            type="button"
            disabled={busy}
            aria-label={t("codingWorkbench.inbox.sendNow.item", { text })}
            onClick={(): void => onSendNow(item.itemId)}
          >
            {t("codingWorkbench.inbox.sendNow")}
          </button>
        ) : null}
        <button
          className={windowStyles.button}
          type="button"
          disabled={busy}
          aria-label={t("codingWorkbench.inbox.cancel.item", { text })}
          onClick={(): void => onCancel(item.itemId)}
        >
          {t("codingWorkbench.inbox.cancel")}
        </button>
      </span>
    </li>
  );
}

function summaryText(count: number, busy: boolean, t: CodingWorkbenchTranslate): string {
  if (busy) return t("codingWorkbench.inbox.busy");
  return t(count === 1 ? "codingWorkbench.inbox.summary.one" : "codingWorkbench.inbox.summary", {
    count,
  });
}

/**
 * The messages the operator sent into the running turn that the runtime has not taken yet (S07,
 * ADR-0137 D10), in the order the model receives them. Each row says how the message will be
 * delivered, shows the operator's own words, and offers Cancel and, for a queued message, Send now.
 * Nothing is shown while nothing waits. The outcome of an action is the next list: a message the
 * turn already took simply leaves it and appears in the conversation. A failed read is a retryable
 * error, never an empty list that would pass for "nothing is waiting".
 */
export function CodingWorkbenchInbox({
  status,
  items,
  busy,
  onCancel,
  onSendNow,
  onRetry,
}: CodingWorkbenchInboxProps): ReactNode {
  const t = useCodingWorkbenchTranslate();
  if (status === "error") {
    return (
      <section className={styles.cmpInbox} aria-label={t("codingWorkbench.inbox.region")}>
        <div className={styles.cmpInboxError}>
          <p className={styles.cmpInboxErrorText} role="alert">
            {t("codingWorkbench.inbox.error")}
          </p>
          <button className={windowStyles.button} type="button" onClick={onRetry}>
            {t("codingWorkbench.inbox.retry")}
          </button>
        </div>
      </section>
    );
  }
  if (status !== "ready" || items.length === 0) return null;
  return (
    <section className={styles.cmpInbox} aria-label={t("codingWorkbench.inbox.region")}>
      <output className={styles.cmpInboxSummary}>{summaryText(items.length, busy, t)}</output>
      <ul className={styles.cmpInboxList}>
        {items.map((item) => (
          <InboxRow
            key={item.itemId}
            item={item}
            busy={busy}
            onCancel={onCancel}
            onSendNow={onSendNow}
            t={t}
          />
        ))}
      </ul>
    </section>
  );
}
