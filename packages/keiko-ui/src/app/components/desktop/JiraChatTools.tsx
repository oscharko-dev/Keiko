"use client";
import type { ReactNode } from "react";
import { JiraWriteApproval } from "./JiraWriteApproval";
import type {
  ChatToolExchange,
  ChatToolTranscript,
  ChatTurnState,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  useOptionalWidgetTranslate as useTranslate,
  type OptionalWidgetTranslate,
} from "@/lib/optional-widget-i18n";
import {
  knowledgeTurnCoverage,
  knowledgeCoverageIssues,
  type KnowledgeCoverageIssue,
} from "@oscharko-dev/keiko-contracts/runtime/knowledge-turn-coverage";
import {
  jiraToolLabel,
  jiraToolRegionLabel,
  jiraToolState,
  jiraToolOutcomeHelp,
  knowledgeReviewFailureNotice,
  jiraToolPartialNotice,
} from "./jira-tool-presentation";
import styles from "./JiraChatTools.module.css";
import { JiraReportCard } from "./JiraReportCard";
import { jiraReportView } from "./jira-report-view";
import { ChatProcessingPipeline } from "./ChatProcessingPipeline";
import {
  jiraToolOutcomeView,
  type JiraOutcomeIssue,
  type JiraOutcomeRule,
} from "./jira-tool-outcome";
import { chatProcessingSteps } from "./chat-processing-pipeline";
const COVERAGE_ISSUE_MESSAGES = {
  "pending-reads": "chat.knowledgeCoverage.pendingReads",
  "unavailable-documents": "chat.knowledgeCoverage.unavailableDocuments",
  "refused-scopes": "chat.knowledgeCoverage.refusedScopes",
  "failed-operations": "chat.knowledgeCoverage.failedOperations",
  "omitted-requirements": "chat.knowledgeCoverage.omittedRequirements",
  "truncated-requirements": "chat.knowledgeCoverage.truncatedRequirements",
  "missing-criteria": "chat.knowledgeCoverage.missingCriteria",
} as const;

function coverageIssueText(issue: KnowledgeCoverageIssue, t: OptionalWidgetTranslate): string {
  return issue.kind === "requested-reviews"
    ? t("chat.knowledgeCoverage.requestedReviews", {
        completed: issue.completed,
        requested: issue.requested,
      })
    : t(COVERAGE_ISSUE_MESSAGES[issue.kind], { count: issue.count });
}

/** Existing immutable receipts carry the same caveat through SSE, reconciliation and reload. */
function KnowledgeCoverageNotice({
  transcript,
  turnState,
}: {
  readonly transcript: ChatToolTranscript | undefined;
  readonly turnState: ChatTurnState | undefined;
}): ReactNode {
  const t = useTranslate();
  const issues = knowledgeCoverageIssues(knowledgeTurnCoverage(transcript?.exchanges ?? []));
  if (turnState === "pending" || issues.length === 0) return null;
  return (
    <div className="grounded-uncertainty" role="alert">
      <strong>{t("chat.knowledgeCoverage.title")}</strong>
      <ul className="grounded-uncertainty-list">
        {issues.map((issue) => (
          <li key={issue.kind}>{coverageIssueText(issue, t)}</li>
        ))}
      </ul>
    </div>
  );
}

function jiraReportOf(exchange: ChatToolExchange): ReturnType<typeof jiraReportView> {
  return exchange.call.name === "jira_report" ? jiraReportView(exchange.result?.data) : undefined;
}
function JiraIssueName({ issue }: { readonly issue: JiraOutcomeIssue }): ReactNode {
  const t = useTranslate();
  const label = (
    <>
      <strong>{issue.key}</strong>
      {issue.summary === undefined ? null : <span> {issue.summary}</span>}
    </>
  );
  if (issue.href === undefined) return label;
  return (
    <a className="sm-link" href={issue.href} target="_blank" rel="noopener noreferrer">
      {label}
      <span className="sr-only">{t("chat.jira.outcome.newTab")}</span>
    </a>
  );
}
const RULE_MESSAGES = {
  "summary-too-short": "chat.jira.outcome.rule.summary-too-short",
  "summary-too-long": "chat.jira.outcome.rule.summary-too-long",
  "summary-pattern": "chat.jira.outcome.rule.summary-pattern",
  "section-missing": "chat.jira.outcome.rule.section-missing",
  "section-empty": "chat.jira.outcome.rule.section-empty",
  "field-missing": "chat.jira.outcome.rule.field-missing",
  "field-unavailable": "chat.jira.outcome.rule.field-unavailable",
  "label-missing": "chat.jira.outcome.rule.label-missing",
  "label-pattern": "chat.jira.outcome.rule.label-pattern",
  "label-count": "chat.jira.outcome.rule.label-count",
  "parent-missing": "chat.jira.outcome.rule.parent-missing",
  "template-unreadable": "chat.jira.outcome.rule.template-unreadable",
} as const satisfies Readonly<Record<JiraOutcomeRule["ruleId"], string>>;
const VALIDATION_MESSAGES = {
  "required-field": "chat.jira.outcome.validation.required-field",
  "unsupported-field": "chat.jira.outcome.validation.unsupported-field",
  "invalid-field": "chat.jira.outcome.validation.invalid-field",
  "invalid-operation": "chat.jira.outcome.validation.invalid-operation",
  "bounds-exceeded": "chat.jira.outcome.validation.bounds-exceeded",
} as const satisfies Readonly<
  Record<NonNullable<ReturnType<typeof jiraToolOutcomeView>["validation"]>, string>
>;
/** The project lead's rules a refused change broke, as sentences rather than rule ids. */
function JiraTemplateRules({ rules }: { readonly rules: readonly JiraOutcomeRule[] }): ReactNode {
  const t = useTranslate();
  if (rules.length === 0) return null;
  return (
    <ul className={styles.cmpProblems} aria-label={t("chat.jira.outcome.rules")}>
      {rules.map((rule) => (
        <li key={`${rule.ruleId}:${rule.subject}`}>
          {t(RULE_MESSAGES[rule.ruleId], { subject: rule.subject })}
        </li>
      ))}
    </ul>
  );
}
/** What happened, in a person's terms: the issues touched and why Jira refused, never raw data. */
function JiraToolOutcome({
  view,
}: {
  readonly view: ReturnType<typeof jiraToolOutcomeView>;
}): ReactNode {
  const t = useTranslate();
  return (
    <>
      {view.issues.length === 0 ? null : (
        <ul className={styles.cmpIssues} aria-label={t("chat.jira.outcome.issues")}>
          {view.issues.map((issue) => (
            <li key={issue.key}>
              <JiraIssueName issue={issue} />
            </li>
          ))}
          {view.hiddenIssueCount === 0 ? null : (
            <li className={styles.cmpMoreIssues}>
              {t("chat.jira.outcome.more", { count: view.hiddenIssueCount })}
            </li>
          )}
        </ul>
      )}
      {view.problems.length === 0 ? null : (
        <ul className={styles.cmpProblems} aria-label={t("chat.jira.outcome.problems")}>
          {view.problems.map((problem, index) => (
            <li key={`${problem.field ?? ""}:${String(index)}`}>
              {problem.field === undefined ? null : <strong>{problem.field}: </strong>}
              {problem.message}
            </li>
          ))}
        </ul>
      )}
      {view.validation === undefined ? null : <p>{t(VALIDATION_MESSAGES[view.validation])}</p>}
      <JiraTemplateRules rules={view.rules} />
    </>
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
  // A settled review failure already identifies its cause while outer synthesis continues.
  const help =
    knowledgeReviewFailureNotice(exchange) ??
    (turnState === "pending" ? undefined : jiraToolOutcomeHelp(state));
  const report = jiraReportOf(exchange);
  const partial = jiraToolPartialNotice(exchange);
  return (
    <section className={styles.cmpCard} aria-label={t(jiraToolRegionLabel(exchange))}>
      <strong>{mcp ? exchange.call.name : t(jiraToolLabel(exchange))}</strong>
      <output>{t(state)}</output>
      {help === undefined ? null : <p>{t(help)}</p>}
      {report === undefined ? null : <JiraReportCard view={report} chatId={chatId} />}
      {report === undefined && partial !== undefined ? <p>{t(partial)}</p> : null}
      {report === undefined ? <JiraToolOutcome view={jiraToolOutcomeView(exchange)} /> : null}
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
  showPending = false,
  waitingForDecision = false,
}: {
  readonly transcript: ChatToolTranscript | undefined;
  readonly turnState?: ChatTurnState | undefined;
  readonly chatId?: string | undefined;
  readonly showPending?: boolean | undefined;
  readonly waitingForDecision?: boolean | undefined;
}): ReactNode {
  const steps = chatProcessingSteps(transcript, turnState, showPending, waitingForDecision);
  if (steps.length === 0) return null;
  return (
    <div className={styles.cmpLayout}>
      <div className={styles.cmpContent}>
        <ChatProcessingPipeline steps={steps} />
        <div className={styles.cmpStack}>
          <KnowledgeCoverageNotice transcript={transcript} turnState={turnState} />
          {transcript?.exchanges.map((exchange) => (
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
      </div>
    </div>
  );
}
