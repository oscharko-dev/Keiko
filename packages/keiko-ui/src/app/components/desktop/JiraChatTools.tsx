"use client";
import type { ReactNode } from "react";
import { useJiraDecision } from "./useJiraDecision";
import { JiraDecisionActions } from "./JiraDecisionActions";
import { JiraWriteApproval } from "./JiraWriteApproval";
import type { ChatToolReadGrantView } from "@oscharko-dev/keiko-contracts";
import type {
  ChatToolExchange,
  ChatToolTranscript,
  ChatTurnState,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  useOptionalWidgetTranslate as useTranslate,
  type WidgetMessageKey,
} from "@/lib/optional-widget-i18n";
import { decideJiraChatReadConsent } from "@/lib/atlassian-connectors-api";
import { jiraToolLabel, jiraToolState, jiraToolOutcomeHelp } from "./jira-tool-presentation";
import styles from "./JiraChatTools.module.css";
import { chatToolReadGrants } from "@/lib/chat-tool-events";
import { JiraReportCard } from "./JiraReportCard";
import { jiraReportView } from "./jira-report-view";
const STATE_KEYS: Readonly<Record<ChatToolReadGrantView["state"], WidgetMessageKey>> = {
  pending: "chat.jira.pending",
  granted: "chat.jira.granted",
  rejected: "chat.jira.rejected",
  expired: "chat.jira.expired",
  revoked: "chat.jira.revoked",
};

export function JiraReadConsent({
  grant,
  decide = decideJiraChatReadConsent,
}: {
  readonly grant: ChatToolReadGrantView;
  readonly decide?: typeof decideJiraChatReadConsent;
}): ReactNode {
  const t = useTranslate();
  const { view, busy, failed, submit } = useJiraDecision({
    key: grant.grantId,
    current: grant,
    decide: (decision) => decide(grant, decision),
  });
  const mcp = grant.kind === "mcp-chat-read";
  const title = mcp ? "chat.mcp.title" : "chat.jira.title";
  return (
    <section className={styles.cmpCard} aria-label={t(title)}>
      <strong>{t(title)}</strong>
      <p>{t(mcp ? "chat.mcp.disclosure" : "chat.jira.disclosure")}</p>
      <output aria-live="polite">{t(busy ? "chat.jira.working" : STATE_KEYS[view.state])}</output>
      {failed ? <p role="alert">{t("chat.jira.failed")}</p> : null}
      {view.state === "pending" ? (
        <JiraDecisionActions
          disabled={busy}
          approve={t("chat.jira.approve")}
          reject={t("chat.jira.reject")}
          submit={submit}
        />
      ) : null}
    </section>
  );
}
function hasPartialJiraResult(exchange: ChatToolExchange): boolean {
  return (
    !exchange.call.name.startsWith("mcp_") &&
    exchange.result?.status === "completed" &&
    exchange.result.page.truncated
  );
}
function jiraReportOf(exchange: ChatToolExchange): ReturnType<typeof jiraReportView> {
  return exchange.call.name === "jira_report" ? jiraReportView(exchange.result?.data) : undefined;
}
function JiraToolExchange({
  exchange,
  turnState,
  chatId,
}: {
  readonly exchange: ChatToolExchange;
  readonly turnState: ChatTurnState | undefined;
  readonly chatId: string | undefined;
}): ReactNode {
  const t = useTranslate();
  const mcp = exchange.call.name.startsWith("mcp_");
  const state = jiraToolState(exchange, turnState);
  const help = jiraToolOutcomeHelp(state);
  const report = jiraReportOf(exchange);
  return (
    <section className={styles.cmpCard} aria-label={t(mcp ? "chat.mcp.tool" : "chat.jira.tool")}>
      <strong>{mcp ? exchange.call.name : t(jiraToolLabel(exchange))}</strong>
      <output>{t(state)}</output>
      {help === undefined ? null : <p>{t(help)}</p>}
      {report === undefined ? null : <JiraReportCard view={report} chatId={chatId} />}
      {report === undefined && hasPartialJiraResult(exchange) ? (
        <p>{t("chat.jira.partial")}</p>
      ) : null}
      {exchange.result?.data == null ? null : (
        <details>
          <summary>{t(mcp ? "chat.mcp.details" : "chat.jira.details")}</summary>
          <pre className={styles.cmpResult}>{JSON.stringify(exchange.result.data, null, 2)}</pre>
        </details>
      )}
    </section>
  );
}
export function JiraChatTools({
  transcript,
  turnState,
  chatId,
}: {
  readonly transcript: ChatToolTranscript | undefined;
  readonly turnState?: ChatTurnState | undefined;
  readonly chatId?: string | undefined;
}): ReactNode {
  if (transcript === undefined) return null;
  return (
    <div className={styles.cmpStack}>
      {chatToolReadGrants(transcript).map((grant) => (
        <JiraReadConsent key={grant.grantId} grant={grant} />
      ))}
      {transcript.exchanges.map((exchange) => (
        <div key={exchange.call.id}>
          {exchange.approval === undefined ? null : (
            <JiraWriteApproval
              key={exchange.approval.approvalId}
              approval={exchange.approval}
              call={exchange.call}
              turnState={turnState}
            />
          )}
          <JiraToolExchange exchange={exchange} turnState={turnState} chatId={chatId} />
        </div>
      ))}
    </div>
  );
}
