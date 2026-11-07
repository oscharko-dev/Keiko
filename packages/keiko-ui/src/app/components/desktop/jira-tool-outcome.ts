import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  JIRA_FIELD_VALIDATION_FAILURES,
  JIRA_TEMPLATE_RULE_IDS,
  type JiraFieldValidationFailure,
  type JiraTemplateRuleId,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";

/** One Jira issue a tool call created, changed or read, as a person recognises it. */
export interface JiraOutcomeIssue {
  readonly key: string;
  readonly summary?: string;
  readonly href?: string;
}

/** Why Jira refused a change, in Jira's own words and with the field's display name. */
export interface JiraOutcomeProblem {
  readonly field?: string;
  readonly message: string;
}

/** A project lead's template rule the change broke, by its closed id and the element it names. */
export interface JiraOutcomeRule {
  readonly ruleId: JiraTemplateRuleId;
  readonly subject: string;
}

/** What a business user reads instead of the raw tool result (#4173). */
export interface JiraToolOutcomeView {
  readonly issues: readonly JiraOutcomeIssue[];
  readonly hiddenIssueCount: number;
  readonly problems: readonly JiraOutcomeProblem[];
  readonly rules: readonly JiraOutcomeRule[];
  /** Keiko's own field check refused the change before Jira saw it; Jira's words come as problems. */
  readonly validation?: JiraFieldValidationFailure;
}

/** More than a handful of read issues is a list the answer itself summarises. */
export const JIRA_OUTCOME_ISSUES_SHOWN = 5;
const ISSUE_KEY = /^[A-Z][A-Z0-9_]{0,63}-\d{1,12}$/u;

type UnknownRecord = Readonly<Record<string, unknown>>;

function record(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}
/** Only a plain web link opens Jira; anything else stays an unlinked key. */
function webLink(value: unknown): string | undefined {
  const candidate = text(value);
  if (candidate === undefined) return undefined;
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}
function issueOf(source: UnknownRecord | undefined, keyField: string): JiraOutcomeIssue[] {
  const key = text(source?.[keyField]);
  if (key === undefined || !ISSUE_KEY.test(key)) return [];
  const summary = text(source?.summary);
  const href = webLink(source?.browseUrl);
  return [
    { key, ...(summary === undefined ? {} : { summary }), ...(href === undefined ? {} : { href }) },
  ];
}
function listed(value: unknown, keyField: string): JiraOutcomeIssue[] {
  return Array.isArray(value) ? value.flatMap((entry) => issueOf(record(entry), keyField)) : [];
}
function uniqueIssues(issues: readonly JiraOutcomeIssue[]): JiraOutcomeIssue[] {
  const seen = new Map<string, JiraOutcomeIssue>();
  for (const issue of issues) if (!seen.has(issue.key)) seen.set(issue.key, issue);
  return [...seen.values()];
}
function problemsOf(data: UnknownRecord | undefined): JiraOutcomeProblem[] {
  const fieldErrors = Array.isArray(data?.fieldErrors) ? data.fieldErrors : [];
  const messages = Array.isArray(data?.messages) ? data.messages : [];
  return [
    ...fieldErrors.flatMap((entry): JiraOutcomeProblem[] => {
      const error = record(entry);
      const message = text(error?.message);
      if (message === undefined) return [];
      const field = text(error?.fieldName) ?? text(error?.fieldId);
      return [{ ...(field === undefined ? {} : { field }), message }];
    }),
    ...messages.flatMap((entry): JiraOutcomeProblem[] => {
      const message = text(entry);
      return message === undefined ? [] : [{ message }];
    }),
  ];
}

function ruleOf(entry: unknown): JiraOutcomeRule[] {
  const violation = record(entry);
  const ruleId = JIRA_TEMPLATE_RULE_IDS.find((id) => id === violation?.ruleId);
  const subject = text(violation?.subject);
  return ruleId === undefined || subject === undefined ? [] : [{ ruleId, subject }];
}
/** The template rules a refusal names, on the call itself or on each refused draft item. */
function rulesOf(data: UnknownRecord | undefined): JiraOutcomeRule[] {
  const own = Array.isArray(data?.violations) ? data.violations : [];
  const items = Array.isArray(data?.items) ? data.items : [];
  const itemViolations = items.flatMap((item): unknown[] => {
    const violations = record(item)?.violations;
    return Array.isArray(violations) ? violations : [];
  });
  const seen = new Set<string>();
  return [...own, ...itemViolations].flatMap(ruleOf).filter((rule) => {
    const key = `${rule.ruleId}:${rule.subject}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function validationOf(data: UnknownRecord | undefined): {
  readonly validation?: JiraFieldValidationFailure;
} {
  const validation = JIRA_FIELD_VALIDATION_FAILURES.find((value) => value === data?.validation);
  return validation === undefined ? {} : { validation };
}

/** The issues and refusal reasons a Jira exchange carries; MCP and knowledge tools carry none. */
export function jiraToolOutcomeView(exchange: ChatToolExchange): JiraToolOutcomeView {
  const name = exchange.call.name;
  if (!name.startsWith("jira_"))
    return { issues: [], hiddenIssueCount: 0, problems: [], rules: [] };
  const data = record(exchange.result?.data);
  const issues = uniqueIssues([
    ...issueOf(data, "issueKey"),
    ...listed(data?.items, "key"),
    ...listed(record(exchange.draftProgress)?.items, "issueKey"),
  ]);
  return {
    issues: issues.slice(0, JIRA_OUTCOME_ISSUES_SHOWN),
    hiddenIssueCount: Math.max(0, issues.length - JIRA_OUTCOME_ISSUES_SHOWN),
    problems: problemsOf(data),
    rules: rulesOf(data),
    ...validationOf(data),
  };
}
