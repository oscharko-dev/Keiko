"use client";
import type { ReactNode } from "react";
import { JiraWriteApproval } from "./JiraWriteApproval";
import type {
  ChatToolExchange,
  ChatToolTranscript,
  ChatTurnState,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import { useOptionalWidgetTranslate as useTranslate } from "@/lib/optional-widget-i18n";
import {
  jiraToolLabel,
  jiraToolState,
  jiraToolOutcomeHelp,
  jiraToolPartialNotice,
} from "./jira-tool-presentation";
import styles from "./JiraChatTools.module.css";
import { JiraReportCard } from "./JiraReportCard";
import { jiraReportView } from "./jira-report-view";
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
  const partial = jiraToolPartialNotice(exchange);
  return (
    <section className={styles.cmpCard} aria-label={t(mcp ? "chat.mcp.tool" : "chat.jira.tool")}>
      <strong>{mcp ? exchange.call.name : t(jiraToolLabel(exchange))}</strong>
      <output>{t(state)}</output>
      {help === undefined ? null : <p>{t(help)}</p>}
      {report === undefined ? null : <JiraReportCard view={report} chatId={chatId} />}
      {report === undefined && partial !== undefined ? <p>{t(partial)}</p> : null}
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
