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
  jiraToolDetailsLabel,
  jiraToolLabel,
  jiraToolRegionLabel,
  jiraToolState,
  jiraToolOutcomeHelp,
  jiraLocalAccessDenialNotice,
  knowledgeReviewFailureNotice,
  jiraToolPartialNotice,
} from "./jira-tool-presentation";
import styles from "./JiraChatTools.module.css";
import { JiraReportCard } from "./JiraReportCard";
import { jiraReportView } from "./jira-report-view";
import { ChatProcessingPipeline } from "./ChatProcessingPipeline";
import { chatProcessingSteps } from "./chat-processing-pipeline";
import { useJiraResultEvidence } from "./jira-result-evidence";
import { JIRA_AGILE_TOOLS } from "./jira-agile-presentation";
import { JIRA_PROJECT_METADATA_TOOLS } from "./jira-project-metadata-presentation";
import { JIRA_COLLABORATION_TOOLS } from "./jira-collaboration-presentation";
import { JIRA_ADMINISTRATION_TOOLS } from "./jira-administration-presentation";
import { JIRA_DIRECTORY_TOOLS } from "./jira-directory-presentation";
import { JIRA_ACCESS_TOOLS } from "./jira-access-presentation";
import { JIRA_PROJECT_ASSOCIATION_TOOLS } from "./jira-project-association-presentation";
import { JIRA_CORE_METADATA_TOOLS } from "./jira-core-metadata-presentation";
import { JIRA_INSTANCE_TOOLS } from "./jira-instance-presentation";
import { JIRA_ROLE_TOOLS } from "./jira-role-presentation";
import { JIRA_RELEASE_TOOLS } from "./jira-release-presentation";
import { JIRA_LOOKUP_TOOLS } from "./jira-lookup-presentation";
import { JIRA_JQL_TOOLS } from "./jira-jql-presentation";
import { JIRA_AGILE_CONTEXT_TOOLS } from "./jira-agile-context-presentation";
import { JIRA_ADMIN_METADATA_TOOLS } from "./jira-admin-metadata-presentation";
import { JIRA_RUNTIME_SETTINGS_TOOLS } from "./jira-runtime-settings-presentation";
import { JIRA_MAINTENANCE_TOOLS } from "./jira-maintenance-presentation";
import { JIRA_VIEW_SETTINGS_TOOLS } from "./jira-view-settings-presentation";
import { JIRA_JOB_OBSERVATION_TOOLS } from "./jira-job-observation-presentation";
import { JIRA_ADMINISTRATIVE_OBSERVATION_TOOLS } from "./jira-administrative-observation-presentation";
import { JIRA_PROPERTY_TOOLS } from "./jira-property-presentation";
import { JIRA_ISSUE_CONTEXT_TOOLS } from "./jira-issue-context-presentation";
import { JIRA_MONITORING_WRITE_TOOLS } from "./jira-monitoring-presentation";
import { JIRA_PROPERTY_MUTATION_TOOLS } from "./jira-property-mutation-presentation";
import { JIRA_PARTICIPATION_TOOLS } from "./jira-participation-presentation";
import { JIRA_FILE_METADATA_TOOLS } from "./jira-file-metadata-presentation";
import { JIRA_SAVED_VIEW_TOOLS } from "./jira-saved-view-presentation";
import { JIRA_ACCOUNT_DIAGNOSTIC_TOOLS } from "./jira-account-diagnostic-presentation";
import { JIRA_APPLICATION_SETTINGS_TOOLS } from "./jira-application-settings-presentation";
import { JIRA_REMOTE_VERSION_LINK_TOOLS } from "./jira-remote-version-link-presentation";
import { JIRA_WORKLOG_FEED_TOOLS } from "./jira-worklog-feed-presentation";
import { JIRA_IDENTITY_OBSERVATION_TOOLS } from "./jira-identity-observation-presentation";
import { JIRA_SELECTED_WORKLOG_TOOLS } from "./jira-selected-worklog-presentation";
import { JIRA_SAVED_CONFIGURATION_WRITE_TOOLS } from "./jira-saved-configuration-presentation";
import { JIRA_RELEASE_LIFECYCLE_TOOLS } from "./jira-release-lifecycle-presentation";
import { JIRA_LINK_MUTATION_TOOLS } from "./jira-link-mutation-presentation";
import { JIRA_CONFIGURATION_MUTATION_TOOLS } from "./jira-configuration-mutation-presentation";
import { JIRA_PLANNING_MUTATION_TOOLS } from "./jira-planning-mutation-presentation";
import { JIRA_ACCESS_CONFIGURATION_TOOLS } from "./jira-access-configuration-presentation";
import {
  jiraToolOutcomeView,
  JIRA_OUTCOME_ITEMS_SHOWN,
  JIRA_PROJECT_TOOLS,
  type JiraOutcomeItem,
  type JiraOutcomeRule,
  type JiraToolOutcomeView,
} from "./jira-tool-outcome";
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
function JiraToolResultDetails({ exchange }: { readonly exchange: ChatToolExchange }): ReactNode {
  const t = useTranslate();
  const data = exchange.result?.data ?? exchange.draftProgress;
  if (data == null) return null;
  return (
    <details>
      <summary>{t(jiraToolDetailsLabel(exchange))}</summary>
      <pre className={styles.cmpResult}>{JSON.stringify(data, null, 2)}</pre>
    </details>
  );
}
function JiraContextLink({ href, label }: {
  readonly href: string | undefined;
  readonly label: "chat.jira.outcome.openBoard" | "chat.jira.outcome.openFilter";
}): ReactNode {
  const t = useTranslate();
  return href === undefined ? null : (
    <a className="sm-link" href={href} target="_blank" rel="noopener noreferrer">
      {t(label)}
      <span className="sr-only"> {t("chat.jira.outcome.newTab")}</span>
    </a>
  );
}
function JiraResultItems({ items }: { readonly items: readonly JiraOutcomeItem[] }): ReactNode {
  const t = useTranslate();
  return (
    <ul className={styles.cmpResultItems} aria-label={t("chat.jira.outcome.results")}>
      {items.map((item, index) => {
        const title = (
          <>
            {item.key === undefined ? null : <strong>{item.key}</strong>}
            {item.name === undefined ? null : <span>{item.name}</span>}
          </>
        );
        return (
          <li key={`${item.key ?? item.name ?? ""}:${String(index)}`}>
            <div className={styles.cmpResultTitle}>
              {item.href === undefined ? (
                title
              ) : (
                <a className="sm-link" href={item.href} target="_blank" rel="noopener noreferrer">
                  {title}
                  <span className="sr-only"> {t("chat.jira.outcome.newTab")}</span>
                </a>
              )}
            </div>
            {item.projectId === undefined ? null : (
              <p>{t("chat.jira.outcome.projectId", { id: item.projectId })}</p>
            )}
            {item.facts.map((fact) => (
              <p key={fact.label} className={styles.cmpResultText}>
                {t(fact.label)}: {fact.value}
              </p>
            ))}
            <JiraContextLink href={item.boardHref} label="chat.jira.outcome.openBoard" />
            <JiraContextLink href={item.filterHref} label="chat.jira.outcome.openFilter" />
            {item.status === undefined ? null : <p>{item.status}</p>}
            {item.labels.map((label) => (
              <p key={label}>{t(label)}</p>
            ))}
            {item.body === undefined ? null : <p className={styles.cmpResultText}>{item.body}</p>}
          </li>
        );
      })}
    </ul>
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
} as const;

function JiraResultCounts({ view }: { readonly view: JiraToolOutcomeView }): ReactNode {
  const t = useTranslate();
  return (
    <>
      {view.returnedCount === undefined ? null : (
        <p>
          {view.total === undefined
            ? t("chat.jira.outcome.returned", { count: view.returnedCount })
            : t("chat.jira.outcome.returnedTotal", {
                count: view.returnedCount,
                total: view.total,
              })}
        </p>
      )}
      {view.stagedCount === undefined ? null : (
        <p>{t("chat.jira.outcome.staged", { count: view.stagedCount })}</p>
      )}
      {view.unreadableCount === 0 ? null : (
        <p>{t("chat.jira.outcome.unreadable", { count: view.unreadableCount })}</p>
      )}
      {view.unresolvedCount === undefined || view.unresolvedCount === 0 ? null : (
        <p>{t("chat.jira.outcome.unresolved", { count: view.unresolvedCount })}</p>
      )}
    </>
  );
}
function JiraResultList({ items }: { readonly items: readonly JiraOutcomeItem[] }): ReactNode {
  const t = useTranslate();
  return (
    <>
      {items.length === 0 ? null : (
        <JiraResultItems items={items.slice(0, JIRA_OUTCOME_ITEMS_SHOWN)} />
      )}
      {items.length <= JIRA_OUTCOME_ITEMS_SHOWN ? null : (
        <details className={styles.cmpResultMore}>
          <summary>
            {t("chat.jira.outcome.more", { count: items.length - JIRA_OUTCOME_ITEMS_SHOWN })}
          </summary>
          <JiraResultItems items={items.slice(JIRA_OUTCOME_ITEMS_SHOWN)} />
        </details>
      )}
    </>
  );
}
function JiraResultProblems({ view }: { readonly view: JiraToolOutcomeView }): ReactNode {
  const t = useTranslate();
  return (
    <>
      {view.problems.length === 0 ? null : (
        <ul className={styles.cmpResultProblems} aria-label={t("chat.jira.outcome.problems")}>
          {view.problems.map((problem, index) => (
            <li key={`${problem.field ?? ""}:${String(index)}`}>
              {problem.field === undefined ? null : <strong>{problem.field}: </strong>}
              <span>{problem.message}</span>
            </li>
          ))}
        </ul>
      )}
      {view.validation === undefined ? null : <p>{t(VALIDATION_MESSAGES[view.validation])}</p>}
      {view.rules.length === 0 ? null : (
        <ul className={styles.cmpResultProblems} aria-label={t("chat.jira.outcome.rules")}>
          {view.rules.map((rule) => (
            <li key={`${rule.ruleId}:${rule.subject}`}>
              {t(RULE_MESSAGES[rule.ruleId], { subject: rule.subject })}
            </li>
          ))}
        </ul>
      )}
      {view.failure === undefined ||
      view.validation !== undefined ||
      view.rules.length > 0 ? null : (
        <p>{t(view.failure)}</p>
      )}
    </>
  );
}
/** Read the saved receipt directly; reloading a Chat neither fetches Jira nor repeats a write. */
function JiraToolOutcome({ exchange }: { readonly exchange: ChatToolExchange }): ReactNode {
  const view = jiraToolOutcomeView(exchange);
  return (
    <>
      <JiraResultCounts view={view} />
      <JiraResultList items={view.items} />
      <JiraResultProblems view={view} />
    </>
  );
}
function resultCardSemantics(exchange: ChatToolExchange): {
  readonly tag: "div" | "section";
  readonly role: "group" | undefined;
  readonly label: ReturnType<typeof jiraToolLabel>;
} {
  return [
    JIRA_IDENTITY_OBSERVATION_TOOLS,
    JIRA_SELECTED_WORKLOG_TOOLS,
    JIRA_SAVED_CONFIGURATION_WRITE_TOOLS,
    JIRA_RELEASE_LIFECYCLE_TOOLS,
    JIRA_LINK_MUTATION_TOOLS,
    JIRA_CONFIGURATION_MUTATION_TOOLS,
    JIRA_PLANNING_MUTATION_TOOLS,
    JIRA_ACCESS_CONFIGURATION_TOOLS,
    JIRA_REMOTE_VERSION_LINK_TOOLS,
    JIRA_WORKLOG_FEED_TOOLS,
    JIRA_ACCOUNT_DIAGNOSTIC_TOOLS,
    JIRA_APPLICATION_SETTINGS_TOOLS,
    JIRA_PROJECT_TOOLS,
    JIRA_AGILE_TOOLS,
    JIRA_PROJECT_METADATA_TOOLS,
    JIRA_COLLABORATION_TOOLS,
    JIRA_SAVED_VIEW_TOOLS,
    JIRA_FILE_METADATA_TOOLS,
    JIRA_PARTICIPATION_TOOLS,
    JIRA_ADMINISTRATION_TOOLS,
    JIRA_DIRECTORY_TOOLS,
    JIRA_ACCESS_TOOLS,
    JIRA_PROJECT_ASSOCIATION_TOOLS,
    JIRA_CORE_METADATA_TOOLS,
    JIRA_INSTANCE_TOOLS,
    JIRA_ROLE_TOOLS,
    JIRA_RELEASE_TOOLS,
    JIRA_LOOKUP_TOOLS,
    JIRA_JQL_TOOLS,
    JIRA_AGILE_CONTEXT_TOOLS,
    JIRA_ADMIN_METADATA_TOOLS,
    JIRA_RUNTIME_SETTINGS_TOOLS,
    JIRA_MAINTENANCE_TOOLS,
    JIRA_VIEW_SETTINGS_TOOLS,
    JIRA_JOB_OBSERVATION_TOOLS,
    JIRA_ADMINISTRATIVE_OBSERVATION_TOOLS,
    JIRA_PROPERTY_TOOLS,
    JIRA_ISSUE_CONTEXT_TOOLS,
    JIRA_MONITORING_WRITE_TOOLS,
    JIRA_PROPERTY_MUTATION_TOOLS,
  ].some((tools) => tools.has(exchange.call.name))
    ? { tag: "div", role: "group", label: jiraToolLabel(exchange) }
    : { tag: "section", role: undefined, label: jiraToolRegionLabel(exchange) };
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
  const localDenial = jiraLocalAccessDenialNotice(exchange);
  const { tag: Card, role, label } = resultCardSemantics(exchange);
  return (
    <Card className={styles.cmpCard} role={role} aria-label={t(label)}>
      <strong>{mcp ? exchange.call.name : t(jiraToolLabel(exchange))}</strong>
      <output>{t(state)}</output>
      {help === undefined ? null : <p>{t(help)}</p>}
      {localDenial === undefined ? null : <p>{t(localDenial)}</p>}
      {report === undefined ? null : <JiraReportCard view={report} chatId={chatId} />}
      {report === undefined && partial !== undefined ? <p>{t(partial)}</p> : null}
      {exchange.call.name.startsWith("jira_") ? (
        report === undefined ? (
          <JiraToolOutcome exchange={exchange} />
        ) : null
      ) : (
        <JiraToolResultDetails exchange={exchange} />
      )}
    </Card>
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
  messageId,
  showPending = false,
  waitingForDecision = false,
}: {
  readonly transcript: ChatToolTranscript | undefined;
  readonly turnState?: ChatTurnState | undefined;
  readonly chatId?: string | undefined;
  readonly messageId?: string | undefined;
  readonly showPending?: boolean | undefined;
  readonly waitingForDecision?: boolean | undefined;
}): ReactNode {
  useJiraResultEvidence(transcript, turnState, messageId);
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
