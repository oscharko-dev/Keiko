"use client";
import { useState, type ReactNode } from "react";
import { JiraHumanInput } from "./JiraHumanInput";
import { JiraWriteApproval } from "./JiraWriteApproval";
import type {
  ChatToolExchange,
  ChatToolTranscript,
  ChatTurnState,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  useOptionalWidgetTranslate as useTranslate,
  type OptionalWidgetTranslate,
  type WidgetMessageKey,
} from "@/lib/optional-widget-i18n";
import {
  knowledgeTurnCoverage,
  knowledgeCoverageIssues,
  type KnowledgeCoverageIssue,
} from "@oscharko-dev/keiko-contracts/runtime/knowledge-turn-coverage";
import {
  jiraToolDetailsLabel,
  JIRA_CATALOG_TOOLS,
  isKnownJiraToolAlias,
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
import type { JiraDraftProblemCode } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { useJiraResultEvidence } from "./jira-result-evidence";
import {
  jiraToolOutcomeView,
  knowledgeToolOutcomeView,
  JIRA_OUTCOME_ITEMS_SHOWN,
  type JiraOutcomeItem,
  type JiraOutcomeItemName,
  type JiraOutcomeRule,
  type JiraToolOutcomeView,
} from "./jira-tool-outcome";
import { BatchProgress, RequirementsReadCard } from "./JiraProgressCards";
import {
  batchProgressOf,
  requirementsReadGroups,
  type RequirementsReadGroups,
} from "./jira-tool-progress";
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
    <div>
      <p>{t("chat.tool.readableResultUnavailable")}</p>
      <details>
        <summary>{t(jiraToolDetailsLabel(exchange))}</summary>
        <p>{t("chat.tool.readableResultHelp")}</p>
      </details>
    </div>
  );
}
function JiraContextLink({
  href,
  label,
}: {
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
function JiraResultTitle({ item }: { readonly item: JiraOutcomeItem }): ReactNode {
  const t = useTranslate();
  const name = item.nameLabel === undefined ? item.name : t(item.nameLabel);
  const title = (
    <>
      {item.key === undefined ? null : <strong>{item.key}</strong>}
      {name === undefined ? null : (
        <>
          {" "}
          <span>{name}</span>
        </>
      )}
    </>
  );
  return (
    <div className={styles.cmpResultTitle}>
      {item.href === undefined ? (
        title
      ) : (
        <a className="sm-link" href={item.href} target="_blank" rel="noopener noreferrer">
          {title} <span className="sr-only">{t("chat.jira.outcome.newTab")}</span>
        </a>
      )}
    </div>
  );
}
function JiraResultItem({ item }: { readonly item: JiraOutcomeItem }): ReactNode {
  const t = useTranslate();
  return (
    <>
      <JiraResultTitle item={item} />
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
    </>
  );
}
function JiraResultItems({
  items,
  label = "chat.jira.outcome.results",
  more = 0,
}: {
  readonly items: readonly JiraOutcomeItem[];
  readonly label?: WidgetMessageKey | undefined;
  /** Results counted but not listed; a person reads "and N more", never the rest. */
  readonly more?: number;
}): ReactNode {
  const t = useTranslate();
  return (
    <ul className={styles.cmpResultItems} aria-label={t(label)}>
      {items.map((item, index) => (
        <li key={`${item.key ?? item.name ?? ""}:${String(index)}`}>
          <JiraResultItem item={item} />
        </li>
      ))}
      {more === 0 ? null : (
        <li className={styles.cmpMoreIssues}>{t("chat.jira.outcome.more", { count: more })}</li>
      )}
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
  "parent-type-mismatch": "chat.jira.outcome.rule.parent-type-mismatch",
  "template-unreadable": "chat.jira.outcome.rule.template-unreadable",
  "template-missing": "chat.jira.outcome.rule.template-missing",
  "template-not-activated": "chat.jira.outcome.rule.template-not-activated",
} as const satisfies Readonly<Record<JiraOutcomeRule["ruleId"], string>>;
/** One sentence per closed draft problem; it says what to change, and "{position}" is the item. */
const DRAFT_PROBLEM_MESSAGES = {
  "draft-shape": "chat.jira.outcome.draftProblem.draft-shape",
  "items-missing": "chat.jira.outcome.draftProblem.items-missing",
  "item-shape": "chat.jira.outcome.draftProblem.item-shape",
  "item-ref": "chat.jira.outcome.draftProblem.item-ref",
  "item-ids": "chat.jira.outcome.draftProblem.item-ids",
  "item-fields": "chat.jira.outcome.draftProblem.item-fields",
  "item-parent": "chat.jira.outcome.draftProblem.item-parent",
  "item-links": "chat.jira.outcome.draftProblem.item-links",
  "item-requirements": "chat.jira.outcome.draftProblem.item-requirements",
  "ref-duplicate": "chat.jira.outcome.draftProblem.ref-duplicate",
  "ref-self": "chat.jira.outcome.draftProblem.ref-self",
  "ref-unknown": "chat.jira.outcome.draftProblem.ref-unknown",
  "ref-cycle": "chat.jira.outcome.draftProblem.ref-cycle",
} as const satisfies Record<JiraDraftProblemCode, string>;
const VALIDATION_MESSAGES = {
  "required-field": "chat.jira.outcome.validation.required-field",
  "unsupported-field": "chat.jira.outcome.validation.unsupported-field",
  "invalid-field": "chat.jira.outcome.validation.invalid-field",
  "invalid-operation": "chat.jira.outcome.validation.invalid-operation",
  "bounds-exceeded": "chat.jira.outcome.validation.bounds-exceeded",
  "invalid-epic-link": "chat.jira.outcome.validation.invalid-epic-link",
} as const;

/** The issues a partial draft write left uncreated. */
function JiraNotCreatedLine({ count }: { readonly count: number | undefined }): ReactNode {
  const t = useTranslate();
  return count === undefined ? null : <p>{t("chat.jira.outcome.notCreated", { count })}</p>;
}
function JiraResultCounts({ view }: { readonly view: JiraToolOutcomeView }): ReactNode {
  const t = useTranslate();
  return (
    <>
      {view.facts?.map((fact) => (
        <p key={fact.label}>
          {t(fact.label)}: {fact.value}
        </p>
      ))}
      {view.labels?.map((label) => (
        <p key={label}>{t(label)}</p>
      ))}
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
      <JiraNotCreatedLine count={view.notCreatedCount} />
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
/** The rows past the open ones: a closed disclosure mounts none of them, so the card stays finite. */
function JiraMoreRows({
  items,
  label,
  lazy,
}: {
  readonly items: readonly JiraOutcomeItem[];
  readonly label: WidgetMessageKey | undefined;
  /** Mount the rows only once the disclosure is open (a draft write can list thousands). */
  readonly lazy: boolean;
}): ReactNode {
  const t = useTranslate();
  const [open, setOpen] = useState(false);
  return (
    <details
      className={styles.cmpResultMore}
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
      }}
    >
      <summary>
        {items.length === 1
          ? t("chat.jira.outcome.moreResultsOne")
          : t("chat.jira.outcome.moreResults", { count: items.length })}
      </summary>
      {open || !lazy ? <JiraResultItems items={items} label={label} /> : null}
    </details>
  );
}
function JiraResultList({ view }: { readonly view: JiraToolOutcomeView }): ReactNode {
  const t = useTranslate();
  const { items, resultsLabel: label } = view;
  const shown = view.visibleItems ?? JIRA_OUTCOME_ITEMS_SHOWN;
  if (view.overflow === "count") {
    const hidden = Math.max(0, items.length - JIRA_OUTCOME_ITEMS_SHOWN) + view.unlistedItemCount;
    return items.length === 0 ? null : (
      <JiraResultItems
        items={items.slice(0, JIRA_OUTCOME_ITEMS_SHOWN)}
        label={label}
        more={hidden}
      />
    );
  }
  return (
    <>
      {items.length === 0 ? null : <JiraResultItems items={items.slice(0, shown)} label={label} />}
      {items.length <= shown ? null : (
        <JiraMoreRows
          items={items.slice(shown)}
          label={label}
          lazy={view.visibleItems !== undefined}
        />
      )}
      {view.unlistedItemCount === 0 ? null : (
        <p className={styles.cmpMoreIssues}>
          {t("chat.jira.outcome.more", { count: view.unlistedItemCount })}
        </p>
      )}
    </>
  );
}
/** The reviewed summary, else the item's place in the draft: never the model's own reference. */
function JiraItemName({ item }: { readonly item: JiraOutcomeItemName }): ReactNode {
  const t = useTranslate();
  let name: string;
  if (item.unlisted === true) name = t("chat.jira.outcome.itemUnlisted");
  else if (item.summary === undefined)
    name = t("chat.jira.outcome.itemOrdinal", { position: item.position });
  else name = item.ambiguous === true ? `${item.summary} (${String(item.position)})` : item.summary;
  return <strong>{name} </strong>;
}
function JiraProblemList({ view }: { readonly view: JiraToolOutcomeView }): ReactNode {
  const t = useTranslate();
  return view.problems.length === 0 ? null : (
    <ul className={styles.cmpResultProblems} aria-label={t("chat.jira.outcome.problems")}>
      {view.problems.map((problem, index) => (
        <li key={`${String(problem.item?.position ?? 0)}:${problem.field ?? ""}:${String(index)}`}>
          {problem.item === undefined ? null : <JiraItemName item={problem.item} />}
          {problem.field === undefined ? null : <strong>{problem.field}: </strong>}
          <span>{problem.message}</span>
        </li>
      ))}
      {view.hiddenProblemCount === 0 ? null : (
        <li className={styles.cmpMoreIssues}>
          {t("chat.jira.outcome.more", { count: view.hiddenProblemCount })}
        </li>
      )}
    </ul>
  );
}
/** The problems about one item: their sentence continues after the item's name. */
const ITEM_DRAFT_PROBLEMS: ReadonlySet<JiraDraftProblemCode> = new Set([
  "item-shape",
  "item-ref",
  "item-ids",
  "item-fields",
  "item-parent",
  "item-links",
  "item-requirements",
  "ref-self",
  "ref-unknown",
]);
/** What to change in a refused draft, in one sentence per closed problem. */
function JiraDraftProblemLine({ view }: { readonly view: JiraToolOutcomeView }): ReactNode {
  const t = useTranslate();
  const { draftProblem, draftRefusal } = view;
  if (draftRefusal !== undefined) return <p>{t(draftRefusal)}</p>;
  if (draftProblem === undefined) return null;
  const sentence = t(DRAFT_PROBLEM_MESSAGES[draftProblem.problem]);
  if (!ITEM_DRAFT_PROBLEMS.has(draftProblem.problem)) return <p>{sentence}</p>;
  // Without a position the sentence says "An item", never "Item 0".
  const item =
    draftProblem.position === undefined
      ? t("chat.jira.outcome.draftItemUnknown")
      : t("chat.jira.outcome.draftItem", { position: draftProblem.position });
  return <p>{`${item} ${sentence}`}</p>;
}
function JiraRuleList({ view }: { readonly view: JiraToolOutcomeView }): ReactNode {
  const t = useTranslate();
  return view.rules.length === 0 ? null : (
    <ul className={styles.cmpResultProblems} aria-label={t("chat.jira.outcome.rules")}>
      {view.rules.map((rule) => (
        <li key={`${rule.ruleId}:${rule.subject}`}>
          {t(RULE_MESSAGES[rule.ruleId], { subject: rule.subject })}
        </li>
      ))}
    </ul>
  );
}
/** A change that was made although the issue already broke template rules in untouched fields. */
function JiraRuleNotices({ view }: { readonly view: JiraToolOutcomeView }): ReactNode {
  const t = useTranslate();
  return view.templateNotices.length === 0 ? null : (
    <>
      <p>{t("chat.jira.outcome.templateNotices")}</p>
      <ul className={styles.cmpResultProblems} aria-label={t("chat.jira.outcome.rules")}>
        {view.templateNotices.map((rule) => (
          <li key={`${rule.ruleId}:${rule.subject}`}>
            {t(RULE_MESSAGES[rule.ruleId], { subject: rule.subject })}
          </li>
        ))}
      </ul>
    </>
  );
}
function JiraResultProblems({ view }: { readonly view: JiraToolOutcomeView }): ReactNode {
  const t = useTranslate();
  const nothingSent =
    view.validation !== undefined ||
    view.itemValidations.length > 0 ||
    view.draftProblem !== undefined;
  return (
    <>
      <JiraProblemList view={view} />
      <JiraDraftProblemLine view={view} />
      {view.validation === undefined ? null : <p>{t(VALIDATION_MESSAGES[view.validation])}</p>}
      {view.itemValidations.map((item, index) => (
        <p key={`${String(item.item.position)}:${String(index)}`}>
          <JiraItemName item={item.item} />
          {t(VALIDATION_MESSAGES[item.validation])}
        </p>
      ))}
      {nothingSent ? <p>{t("chat.jira.outcome.nothingSent")}</p> : null}
      <JiraRuleList view={view} />
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
  const t = useTranslate();
  const view = jiraToolOutcomeView(exchange);
  return (
    <>
      <JiraResultCounts view={view} />
      {exchange.call.name === "jira_draft" && view.items.length > 0 ? (
        <ul className={styles.cmpResultItems} aria-label={t("chat.jira.outcome.results")}>
          <li>
            <JiraResultList view={view} />
          </li>
        </ul>
      ) : (
        <JiraResultList view={view} />
      )}
      <JiraResultProblems view={view} />
      <JiraRuleNotices view={view} />
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
  const localDenial = jiraLocalAccessDenialNotice(exchange);
  const known = isKnownJiraToolAlias(exchange.call.name);
  const body = (
    <JiraCardBody label={known ? t(jiraToolLabel(exchange)) : undefined}>
      <strong>{mcp ? exchange.call.name : t(jiraToolLabel(exchange))}</strong>
      <output>{t(state)}</output>
      {help === undefined ? null : <p>{t(help)}</p>}
      {localDenial === undefined ? null : <p>{t(localDenial)}</p>}
      <BatchProgress exchange={exchange} turnState={turnState} />
      <JiraToolContents exchange={exchange} report={report} chatId={chatId} />
    </JiraCardBody>
  );
  return <JiraCardFrame exchange={exchange}>{body}</JiraCardFrame>;
}
/** A known Jira tool's card is a labelled group, carried by the native fieldset (S6819). */
function JiraCardBody({
  label,
  children,
}: {
  readonly label: string | undefined;
  readonly children: ReactNode;
}): ReactNode {
  return label === undefined ? (
    <div className={styles.cmpCardBody}>{children}</div>
  ) : (
    <fieldset className={styles.cmpCardBody} aria-label={label}>
      {children}
    </fieldset>
  );
}
/**
 * A write receipt keeps the stable "Jira action" region; reads are only grouped, so a message with
 * several cards never repeats one landmark.
 */
function JiraCardFrame({
  exchange,
  children,
}: {
  readonly exchange: ChatToolExchange;
  readonly children: ReactNode;
}): ReactNode {
  const t = useTranslate();
  const receipt =
    !isKnownJiraToolAlias(exchange.call.name) ||
    exchange.approval !== undefined ||
    exchange.draftProgress !== undefined;
  return receipt ? (
    <section className={styles.cmpCard} aria-label={t(jiraToolRegionLabel(exchange))}>
      {children}
    </section>
  ) : (
    <div className={styles.cmpCard}>{children}</div>
  );
}
function JiraToolContents({
  exchange,
  report,
  chatId,
}: {
  readonly exchange: ChatToolExchange;
  readonly report: ReturnType<typeof jiraReportView>;
  readonly chatId: string | undefined;
}): ReactNode {
  const t = useTranslate();
  if (report !== undefined) return <JiraReportCard view={report} chatId={chatId} />;
  const partial = jiraToolPartialNotice(exchange);
  return (
    <>
      {partial === undefined ? null : <p>{t(partial)}</p>}
      {readableResult(exchange) ? (
        <JiraToolOutcome exchange={exchange} />
      ) : (
        <JiraToolResultDetails exchange={exchange} />
      )}
    </>
  );
}
/** A known Jira alias or a versioned Knowledge receipt has a readable view; anything else has none. */
function readableResult(exchange: ChatToolExchange): boolean {
  return (
    isKnownJiraToolAlias(exchange.call.name) || knowledgeToolOutcomeView(exchange) !== undefined
  );
}
/** States the progress beside the cards already shows; a card that says only this says nothing. */
const PROGRESS_ONLY_STATES: ReadonlySet<WidgetMessageKey> = new Set([
  "chat.jira.complete",
  "chat.jira.running",
]);
const VALIDATION_TOOLS: ReadonlySet<string> = new Set([
  "jira_validate_project_key",
  "jira_validate_license",
  "jira_validate_create_user_password",
  "jira_validate_update_user_password",
  "jira_anonymization_validation",
  "jira_anonymization_rerun_validation",
]);
/** Ordinary read contents belong in the model answer; only caveats and draft facts earn a card. */
function outcomeIsEmpty(view: JiraToolOutcomeView): boolean {
  return (
    view.stagedCount === undefined &&
    view.unresolvedCount === undefined &&
    view.unreadableCount === 0 &&
    view.problems.length === 0 &&
    view.rules.length === 0 &&
    view.itemValidations.length === 0 &&
    view.validation === undefined &&
    view.failure === undefined
  );
}
function hasResultContent(exchange: ChatToolExchange): boolean {
  return (
    (JIRA_CATALOG_TOOLS.has(exchange.call.name) && exchange.result !== undefined) ||
    VALIDATION_TOOLS.has(exchange.call.name) ||
    knowledgeReviewFailureNotice(exchange) !== undefined ||
    jiraReportOf(exchange) !== undefined ||
    jiraToolPartialNotice(exchange) !== undefined ||
    !outcomeIsEmpty(jiraToolOutcomeView(exchange))
  );
}
/** A tool card appears only when it tells the person something the progress does not. */
function toolCardHasContent(
  exchange: ChatToolExchange,
  turnState: ChatTurnState | undefined,
): boolean {
  if (batchProgressOf(exchange) !== undefined) return true;
  if (requirementsReadGroups([exchange]).cards.has(exchange.call.id)) return true;
  if (!PROGRESS_ONLY_STATES.has(jiraToolState(exchange, turnState))) return true;
  // A result without a readable view still explains that it has none.
  if (!readableResult(exchange)) return (exchange.result?.data ?? exchange.draftProgress) != null;
  return hasResultContent(exchange);
}
/** The card already says what an undecided action is waiting for. */
function awaitsDecision(exchange: ChatToolExchange, turnState: ChatTurnState | undefined): boolean {
  return (
    exchange.approval?.state === "pending" &&
    exchange.result === undefined &&
    turnState === "pending"
  );
}
/** The exchanges that earn a card, and whether any card or coverage notice shows at all. */
function visibleToolCards(
  transcript: ChatToolTranscript | undefined,
  turnState: ChatTurnState | undefined,
): { readonly exchanges: readonly ChatToolExchange[]; readonly cards: boolean } {
  const all = transcript?.exchanges ?? [];
  const reads = requirementsReadGroups(all);
  const exchanges = all.filter(
    (exchange) =>
      !reads.folded.has(exchange.call.id) &&
      (exchange.approval !== undefined ||
        exchange.humanInput !== undefined ||
        reads.cards.has(exchange.call.id) ||
        toolCardHasContent(exchange, turnState)),
  );
  const notice =
    turnState !== "pending" && knowledgeCoverageIssues(knowledgeTurnCoverage(all)).length > 0;
  return { exchanges, cards: exchanges.length > 0 || notice };
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
  useJiraResultEvidence(transcript, turnState, messageId, toolCardHasContent);
  const steps = chatProcessingSteps(transcript, turnState, showPending, waitingForDecision);
  if (steps.length === 0) return null;
  const { exchanges, cards } = visibleToolCards(transcript, turnState);
  const reads = requirementsReadGroups(transcript?.exchanges ?? []);
  return (
    <div className={styles.cmpLayout}>
      <div className={styles.cmpContent} data-cards={cards}>
        <ChatProcessingPipeline steps={steps} />
        {cards ? (
          <div className={styles.cmpStack}>
            <KnowledgeCoverageNotice transcript={transcript} turnState={turnState} />
            {exchanges.map((exchange) => (
              <ToolExchangeCards
                key={exchange.call.id}
                exchange={exchange}
                reads={reads}
                turnState={turnState}
                chatId={chatId}
              />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ToolExchangeCards({
  exchange,
  reads,
  turnState,
  chatId,
}: {
  readonly exchange: ChatToolExchange;
  readonly reads: RequirementsReadGroups;
  readonly turnState: ChatTurnState | undefined;
  readonly chatId: string | undefined;
}): ReactNode {
  const t = useTranslate();
  const read = reads.cards.get(exchange.call.id);
  // A single page keeps its readable Knowledge card; several pages read as one counted card.
  const singleReadable = read?.pageCount === 1 && knowledgeToolOutcomeView(exchange) !== undefined;
  if (read !== undefined && !singleReadable)
    return <RequirementsReadCard view={read} label={t("chat.requirements.tool")} />;
  return (
    <div className={styles.cmpExchange}>
      {exchange.humanInput === undefined ? null : (
        <JiraHumanInput
          key={exchange.humanInput.requestId}
          initial={exchange.humanInput}
          turnState={turnState}
        />
      )}
      {exchange.approval === undefined ? null : (
        <JiraWriteApproval
          key={exchange.approval.approvalId}
          approval={exchange.approval}
          call={exchange.call}
          turnState={turnState}
        />
      )}
      {awaitsDecision(exchange, turnState) || !toolCardHasContent(exchange, turnState) ? null : (
        <JiraToolExchange exchange={exchange} turnState={turnState} chatId={chatId} />
      )}
    </div>
  );
}
