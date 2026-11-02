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
  jiraToolDetailsLabel,
  jiraToolLabel,
  jiraToolRegionLabel,
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
function JiraToolResultDetails({ exchange }: { readonly exchange: ChatToolExchange }): ReactNode {
  const t = useTranslate();
  if (exchange.result?.data == null) return null;
  return (
    <details>
      <summary>{t(jiraToolDetailsLabel(exchange))}</summary>
      <pre className={styles.cmpResult}>{JSON.stringify(exchange.result.data, null, 2)}</pre>
    </details>
  );
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
  // While the turn runs the state says enough; the help explains what a finished turn left open.
  const help = turnState === "pending" ? undefined : jiraToolOutcomeHelp(state);
  const report = jiraReportOf(exchange);
  const partial = jiraToolPartialNotice(exchange);
  return (
    <section className={styles.cmpCard} aria-label={t(jiraToolRegionLabel(exchange))}>
      <strong>{mcp ? exchange.call.name : t(jiraToolLabel(exchange))}</strong>
      <output>{t(state)}</output>
      {help === undefined ? null : <p>{t(help)}</p>}
      {report === undefined ? null : <JiraReportCard view={report} chatId={chatId} />}
      {report === undefined && partial !== undefined ? <p>{t(partial)}</p> : null}
      <JiraToolResultDetails exchange={exchange} />
    </section>
  );
}
/** The card already says what an undecided action is waiting for. */
function awaitsDecision(exchange: ChatToolExchange, turnState: ChatTurnState | undefined): boolean {
  return (
    exchange.approval?.state === "pending" &&
    exchange.result === undefined &&
    turnState === "pending"
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
        <div key={exchange.call.id} className={styles.cmpExchange}>
          {exchange.approval === undefined ? null : (
            <JiraWriteApproval
              key={exchange.approval.approvalId}
              approval={exchange.approval}
              call={exchange.call}
              turnState={turnState}
            />
          )}
          {awaitsDecision(exchange, turnState) ? null : (
            <JiraToolExchange exchange={exchange} turnState={turnState} chatId={chatId} />
          )}
        </div>
      ))}
    </div>
  );
}
