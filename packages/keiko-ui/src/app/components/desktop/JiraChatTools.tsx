"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ChatToolReadGrantView } from "@oscharko-dev/keiko-contracts";
import type { ChatToolExchange, ChatToolTranscript } from "@oscharko-dev/keiko-contracts/bff-wire";
import { JIRA_MANAGED_READ_TOOLS } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  useOptionalWidgetTranslate as useTranslate,
  type WidgetMessageKey,
} from "@/lib/optional-widget-i18n";
import { decideJiraChatReadConsent } from "@/lib/atlassian-connectors-api";
import { actionTypeLabelKey } from "./widgets/connectors/connector-labels";
import styles from "./JiraChatTools.module.css";
const STATE_KEYS: Readonly<Record<ChatToolReadGrantView["state"], WidgetMessageKey>> = {
  pending: "chat.jira.pending",
  granted: "chat.jira.granted",
  rejected: "chat.jira.rejected",
  expired: "chat.jira.expired",
  revoked: "chat.jira.revoked",
};

function useConsent(
  grant: ChatToolReadGrantView,
  decide: typeof decideJiraChatReadConsent,
): {
  view: ChatToolReadGrantView;
  busy: boolean;
  failed: boolean;
  submit: (decision: "approve" | "reject") => Promise<void>;
} {
  const [resolved, setResolved] = useState<ChatToolReadGrantView>();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const locked = useRef(false);
  const [expired, setExpired] = useState(() => Date.now() >= grant.expiresAt);
  useEffect(() => {
    const timer = setTimeout(() => setExpired(true), Math.max(0, grant.expiresAt - Date.now()));
    return (): void => {
      clearTimeout(timer);
    };
  }, [grant.expiresAt]);
  const current =
    grant.state === "pending" && resolved?.grantId === grant.grantId ? resolved : grant;
  const view =
    expired && (current.state === "pending" || current.state === "granted")
      ? { ...current, state: "expired" as const }
      : current;
  const submit = async (decision: "approve" | "reject"): Promise<void> => {
    if (locked.current || view.state !== "pending") return;
    locked.current = true;
    setBusy(true);
    setFailed(false);
    try {
      setResolved(await decide(grant, decision));
    } catch {
      setFailed(true);
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };
  return { view, busy, failed, submit };
}

export function JiraReadConsent({
  grant,
  decide = decideJiraChatReadConsent,
}: {
  readonly grant: ChatToolReadGrantView;
  readonly decide?: typeof decideJiraChatReadConsent;
}): ReactNode {
  const t = useTranslate();
  const { view, busy, failed, submit } = useConsent(grant, decide);
  return (
    <section className={styles.card} aria-label={t("chat.jira.title")}>
      <strong>{t("chat.jira.title")}</strong>
      <p>{t("chat.jira.disclosure")}</p>
      <output aria-live="polite">{t(busy ? "chat.jira.working" : STATE_KEYS[view.state])}</output>
      {failed ? <p role="alert">{t("chat.jira.failed")}</p> : null}
      {view.state === "pending" ? (
        <div className={styles.actions}>
          <button
            type="button"
            className="lk-btn lk-btn-primary"
            disabled={busy}
            onClick={() => {
              void submit("approve");
            }}
          >
            {t("chat.jira.approve")}
          </button>
          <button
            type="button"
            className="lk-btn"
            disabled={busy}
            onClick={() => {
              void submit("reject");
            }}
          >
            {t("chat.jira.reject")}
          </button>
        </div>
      ) : null}
    </section>
  );
}
function JiraToolExchange({ exchange }: { readonly exchange: ChatToolExchange }): ReactNode {
  const t = useTranslate();
  const tool = JIRA_MANAGED_READ_TOOLS.find(
    (name) => name.replace(/[.-]/gu, "_") === exchange.call.name,
  );
  const state =
    exchange.result === undefined
      ? "chat.jira.running"
      : exchange.result.status === "completed"
        ? "chat.jira.complete"
        : "chat.jira.unavailable";
  return (
    <section className={styles.card} aria-label={t("chat.jira.tool")}>
      <strong>{t(tool === undefined ? "chat.jira.tool" : actionTypeLabelKey(tool))}</strong>
      <output>{t(state)}</output>
      {exchange.result?.data == null ? null : (
        <details>
          <summary>{t("chat.jira.details")}</summary>
          <pre className={styles.result}>{JSON.stringify(exchange.result.data, null, 2)}</pre>
        </details>
      )}
    </section>
  );
}
export function JiraChatTools({
  transcript,
}: {
  readonly transcript: ChatToolTranscript | undefined;
}): ReactNode {
  if (transcript === undefined) return null;
  return (
    <div className={styles.stack}>
      {transcript.readGrant === undefined ? null : (
        <JiraReadConsent key={transcript.readGrant.grantId} grant={transcript.readGrant} />
      )}
      {transcript.exchanges.map((exchange) => (
        <JiraToolExchange key={exchange.call.id} exchange={exchange} />
      ))}
    </div>
  );
}
