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
interface JiraOutcomeProblem {
  /** The draft item the refusal belongs to. */
  readonly ref?: string;
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
  /** Keiko's own field check refused these draft items; each is named by its reference. */
  readonly itemValidations: readonly JiraOutcomeItemValidation[];
  /** Problems beyond the shown ones, counted rather than dropped silently. */
  readonly hiddenProblemCount: number;
}

/** One draft item Keiko's own field check refused before Jira saw it. */
export interface JiraOutcomeItemValidation {
  readonly ref: string;
  readonly validation: JiraFieldValidationFailure;
}

/** More than a handful of read issues is a list the answer itself summarises. */
const JIRA_OUTCOME_ISSUES_SHOWN = 5;
const JIRA_OUTCOME_PROBLEMS_SHOWN = 20;
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
/** A read lists `key`; a draft's item rows list `issueKey` (the production draft schema). */
function listed(value: unknown): JiraOutcomeIssue[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => {
        const item = record(entry);
        return item?.issueKey === undefined ? issueOf(item, "key") : issueOf(item, "issueKey");
      })
    : [];
}

interface ListedKeys {
  readonly shown: readonly JiraOutcomeIssue[];
  readonly count: number;
}
const RANGE = /^([A-Z][A-Z0-9_]{0,254})-(\d{1,15})\.\.\1-(\d{1,15})$/u;
interface KeyRun {
  readonly project: string;
  readonly from: number;
  readonly to: number;
}
function runOf(part: string): KeyRun | undefined {
  const range = RANGE.exec(part);
  const project = range?.[1];
  const from = Number(range?.[2]);
  const to = Number(range?.[3]);
  return project === undefined || to < from || !Number.isSafeInteger(to)
    ? undefined
    : { project, from, to };
}
/** One `KEY-3` or `KEY-3..KEY-9` part: the keys it names, as many as fit, and how many in all. */
function partKeys(part: string, room: number): ListedKeys {
  const run = runOf(part);
  if (run === undefined) {
    const single = ISSUE_KEY.test(part);
    return { shown: single && room > 0 ? [{ key: part }] : [], count: single ? 1 : 0 };
  }
  const shown: JiraOutcomeIssue[] = [];
  for (let n = run.from; n <= run.to && shown.length < room; n += 1)
    shown.push({ key: `${run.project}-${String(n)}` });
  return { shown, count: run.to - run.from + 1 };
}
/** One entry of a compact draft's key list: several comma-joined keys and ranges. */
function rangeKeys(entry: string, room: number): ListedKeys {
  const shown: JiraOutcomeIssue[] = [];
  let count = 0;
  for (const part of entry.split(",")) {
    const parsed = partKeys(part.trim(), room - shown.length);
    shown.push(...parsed.shown);
    count += parsed.count;
  }
  return { shown, count };
}
/** A listed key opens under the result's own browse prefix; without a web prefix it stays plain. */
function linked(issue: JiraOutcomeIssue, prefix: unknown): JiraOutcomeIssue {
  const base = text(prefix);
  const href = base === undefined ? undefined : webLink(`${base}${issue.key}`);
  return href === undefined ? issue : { ...issue, href };
}
/** The created and found keys a compact large-draft result lists as ranges, and those it counts. */
function compactKeys(data: UnknownRecord | undefined): ListedKeys {
  if (data?.compact !== true) return { shown: [], count: 0 };
  const shown: JiraOutcomeIssue[] = [];
  let count = typeof data.unlistedKeyCount === "number" ? Math.max(0, data.unlistedKeyCount) : 0;
  for (const name of ["createdRanges", "existingRanges"]) {
    const entries = Array.isArray(data[name]) ? (data[name] as unknown[]) : [];
    for (const entry of entries) {
      if (typeof entry !== "string") continue;
      const parsed = rangeKeys(entry, JIRA_OUTCOME_ISSUES_SHOWN - shown.length);
      shown.push(...parsed.shown);
      count += parsed.count;
    }
  }
  return { shown: shown.map((issue) => linked(issue, data.browseUrlPrefix)), count };
}
function uniqueIssues(issues: readonly JiraOutcomeIssue[]): JiraOutcomeIssue[] {
  const seen = new Map<string, JiraOutcomeIssue>();
  for (const issue of issues) if (!seen.has(issue.key)) seen.set(issue.key, issue);
  return [...seen.values()];
}
function problemsOf(data: UnknownRecord | undefined, ref?: string): JiraOutcomeProblem[] {
  const fieldErrors = Array.isArray(data?.fieldErrors) ? data.fieldErrors : [];
  const messages = Array.isArray(data?.messages) ? data.messages : [];
  const own = ref === undefined ? {} : { ref };
  return [
    ...fieldErrors.flatMap((entry): JiraOutcomeProblem[] => {
      const error = record(entry);
      const message = text(error?.message);
      if (message === undefined) return [];
      const field = text(error?.fieldName) ?? text(error?.fieldId);
      return [{ ...own, ...(field === undefined ? {} : { field }), message }];
    }),
    ...messages.flatMap((entry): JiraOutcomeProblem[] => {
      const message = text(entry);
      return message === undefined ? [] : [{ ...own, message }];
    }),
  ];
}
/** Jira's words for each refused draft item, tied to the item's reference. */
function itemProblemsOf(data: UnknownRecord | undefined): JiraOutcomeProblem[] {
  const items = Array.isArray(data?.items) ? data.items : [];
  return items.flatMap((entry) => {
    const item = record(entry);
    return problemsOf(item, text(item?.ref));
  });
}
function itemValidationsOf(data: UnknownRecord | undefined): JiraOutcomeItemValidation[] {
  const items = Array.isArray(data?.items) ? data.items : [];
  return items.flatMap((entry): JiraOutcomeItemValidation[] => {
    const item = record(entry);
    const ref = text(item?.ref);
    const validation = JIRA_FIELD_VALIDATION_FAILURES.find((value) => value === item?.validation);
    return ref === undefined || validation === undefined ? [] : [{ ref, validation }];
  });
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

const EMPTY_OUTCOME: JiraToolOutcomeView = {
  issues: [],
  hiddenIssueCount: 0,
  problems: [],
  rules: [],
  itemValidations: [],
  hiddenProblemCount: 0,
};

/** The issues and refusal reasons a Jira exchange carries; MCP and knowledge tools carry none. */
export function jiraToolOutcomeView(exchange: ChatToolExchange): JiraToolOutcomeView {
  const name = exchange.call.name;
  if (!name.startsWith("jira_")) return EMPTY_OUTCOME;
  const data = record(exchange.result?.data);
  const issues = uniqueIssues([
    ...issueOf(data, "issueKey"),
    ...listed(data?.items),
    ...listed(record(exchange.draftProgress)?.items),
  ]);
  const ranged = compactKeys(data);
  const room = Math.max(0, JIRA_OUTCOME_ISSUES_SHOWN - issues.length);
  const shown = [...issues, ...ranged.shown.slice(0, room)].slice(0, JIRA_OUTCOME_ISSUES_SHOWN);
  const problems = [...problemsOf(data), ...itemProblemsOf(data)];
  return {
    issues: shown,
    hiddenIssueCount: Math.max(0, issues.length + ranged.count - shown.length),
    problems: problems.slice(0, JIRA_OUTCOME_PROBLEMS_SHOWN),
    hiddenProblemCount: Math.max(0, problems.length - JIRA_OUTCOME_PROBLEMS_SHOWN),
    rules: rulesOf(data),
    itemValidations: itemValidationsOf(data),
    ...validationOf(data),
  };
}
