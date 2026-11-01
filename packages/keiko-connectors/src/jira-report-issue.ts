import {
  isSafeAtlassianIdentifier,
  JIRA_REPORT_REQUIRED_FIELD_RULE,
  JIRA_REPORT_STATUS_CATEGORIES,
  type JiraReportStatusCategory,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { asArray, asRecord } from "./atlassian-sync-classify.js";
import { compareCodePoints } from "./jira-report-order.js";
import type {
  JiraReportComplianceChecker,
  JiraReportDeviation,
  JiraReportIssue,
} from "./jira-report-types.js";

/** Everything the parser needs from the instance and the request; derived once per report. */
export interface JiraReportFieldPlan {
  /** Custom fields that may name the issue's parent: discovered by schema shape or caller-named. */
  readonly parentFieldIds: readonly string[];
  /** The ones the caller named; they are never narrowed away. */
  readonly namedParentFieldIds: ReadonlySet<string>;
  /** Collects the parent fields that held a parent key on an issue; the report states the count. */
  readonly parentFieldsSeen: Set<string>;
  /** Collects discovered fields that held a value which is no issue key. */
  readonly parentFieldsNonKey: Set<string>;
  /** Discovered fields shown not to hold a parent: later pages no longer request them. */
  readonly parentFieldsRejected: Set<string>;
  /**
   * The parent keys a discovered field proposed, per issue. A field shown unreliable on a later
   * page takes its proposals back before the report is built.
   */
  readonly parentProposals: Map<string, readonly ParentProposal[]>;
  /** Requested fields a hit left out; an omission is unreadable evidence, never an empty value. */
  readonly omittedFields: Set<string>;
  readonly estimateFieldId: string;
  readonly requirementIds: ReadonlySet<string>;
  readonly requiredByType: ReadonlyMap<string, readonly string[]>;
  readonly checker: JiraReportComplianceChecker | undefined;
  readonly includeDescription: boolean;
}

/** One discovered field's claim that an issue has the given parent. */
export type ParentProposal = readonly [fieldId: string, parentKey: string];

const ISSUE_KEY = /^[A-Za-z]\w{0,254}-[1-9]\d{0,17}$/u;
const RULE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const SUBJECT_CHARS_MAX = 120;
/** A subject is one short line: control characters and line breaks become spaces. */
const CONTROL_CHARACTERS = /\p{Cc}+/gu;
function subjectOf(value: string | undefined): string | undefined {
  const subject = value?.replaceAll(CONTROL_CHARACTERS, " ").trim().slice(0, SUBJECT_CHARS_MAX);
  return subject === undefined || subject.length === 0 ? undefined : subject;
}
const TOKEN_PATTERN = /[A-Za-z0-9][A-Za-z0-9._-]*/gu;
const SUMMARY_MAX = 255;
const LABEL_CHARS_MAX = 255;
const CATEGORIES: ReadonlySet<string> = new Set(JIRA_REPORT_STATUS_CATEGORIES);

function reference(value: unknown): Record<string, unknown> | undefined {
  return asRecord(value);
}
function stringOf(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.slice(0, max) : undefined;
}
function category(status: Record<string, unknown> | undefined): JiraReportStatusCategory {
  const key = reference(status?.statusCategory)?.key;
  return typeof key === "string" && CATEGORIES.has(key)
    ? (key as JiraReportStatusCategory)
    : "undefined";
}
/** A Jira value that names another issue: a key, or an object carrying one. */
function issueKeyOf(value: unknown): string | undefined {
  const key = typeof value === "string" ? value : reference(value)?.key;
  return isSafeAtlassianIdentifier(key) ? key : undefined;
}
/** A parent field proves itself by value: an issue key (or an object carrying one), nothing else. */
function parentFieldKeyOf(value: unknown): string | undefined {
  const key = typeof value === "string" ? value : reference(value)?.key;
  return typeof key === "string" && ISSUE_KEY.test(key) ? key : undefined;
}
function parentKeyOf(
  key: string,
  fields: Record<string, unknown>,
  plan: JiraReportFieldPlan,
): string | undefined {
  const system = issueKeyOf(fields.parent);
  if (system !== undefined) return system;
  const proposals: ParentProposal[] = [];
  for (const id of plan.parentFieldIds) {
    const proposed = parentFieldKeyOf(fields[id]);
    if (proposed !== undefined) {
      plan.parentFieldsSeen.add(id);
      proposals.push([id, proposed]);
    } else if (!plan.namedParentFieldIds.has(id) && !isEmptyJiraValue(fields[id])) {
      plan.parentFieldsNonKey.add(id);
    }
  }
  if (proposals.length > 0) plan.parentProposals.set(key, proposals);
  return proposals[0]?.[1];
}
/**
 * A discovered field is a parent field only when its values are issue keys everywhere or nowhere:
 * one that held something else besides a key is an app's business field that happens to mention an
 * issue, and one that never held a key is no parent field at all. Either way later pages stop
 * asking for it, and `retractRejectedParents` takes back what it proposed. A field the caller
 * named is the caller's mapping and is never narrowed.
 */
export function rejectNonParentFields(plan: JiraReportFieldPlan): void {
  for (const id of plan.parentFieldsNonKey) {
    plan.parentFieldsRejected.add(id);
    plan.parentFieldsSeen.delete(id);
  }
}
/** The issues with the parent their still-trusted fields propose; others are left as they are. */
export function retractRejectedParents(
  issues: ReadonlyMap<string, JiraReportIssue>,
  plan: JiraReportFieldPlan,
): ReadonlyMap<string, JiraReportIssue> {
  const result = new Map(issues);
  for (const [key, proposals] of plan.parentProposals) {
    const issue = result.get(key);
    const kept = proposals.find(([id]) => !plan.parentFieldsRejected.has(id));
    if (issue !== undefined && issue.parentKey !== kept?.[1])
      result.set(key, { ...issue, parentKey: kept?.[1] });
  }
  return result;
}
function linkedKeysOf(fields: Record<string, unknown>): readonly string[] {
  const keys = new Set<string>();
  for (const link of asArray(fields.issuelinks) ?? []) {
    const record = reference(link);
    for (const side of [record?.inwardIssue, record?.outwardIssue]) {
      const key = issueKeyOf(side);
      if (key !== undefined) keys.add(key);
    }
  }
  return [...keys].sort(compareCodePoints);
}
function estimateOf(
  fields: Record<string, unknown>,
  plan: JiraReportFieldPlan,
): number | undefined {
  const value = fields[plan.estimateFieldId];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
/** Jira returns null (or an empty collection or string) for a field without a value. */
export function isEmptyJiraValue(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value === "string") return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}
function requiredDeviations(
  fields: Record<string, unknown>,
  typeId: string,
  plan: JiraReportFieldPlan,
): readonly JiraReportDeviation[] {
  const result: JiraReportDeviation[] = [];
  for (const fieldId of plan.requiredByType.get(typeId) ?? []) {
    if (!Object.hasOwn(fields, fieldId)) plan.omittedFields.add(fieldId);
    else if (isEmptyJiraValue(fields[fieldId]))
      result.push({ ruleId: JIRA_REPORT_REQUIRED_FIELD_RULE, fieldId });
  }
  return result;
}
/** Jira states an unassigned issue as `null`; a hit without the field says nothing about it. */
function assignedOf(fields: Record<string, unknown>, plan: JiraReportFieldPlan): boolean {
  if (!Object.hasOwn(fields, "assignee")) plan.omittedFields.add("assignee");
  return fields.assignee !== null && fields.assignee !== undefined;
}
function checkerDeviations(
  facts: Parameters<JiraReportComplianceChecker["check"]>[0],
  plan: JiraReportFieldPlan,
): readonly JiraReportDeviation[] {
  if (plan.checker === undefined) return [];
  const result: JiraReportDeviation[] = [];
  for (const item of plan.checker.check(facts)) {
    if (!RULE_ID_PATTERN.test(item.ruleId)) continue;
    const fieldId =
      item.fieldId !== undefined && /^\w{1,64}$/u.test(item.fieldId) ? item.fieldId : undefined;
    const subject = subjectOf(item.subject);
    result.push({
      ruleId: item.ruleId,
      ...(fieldId === undefined ? {} : { fieldId }),
      ...(subject === undefined ? {} : { subject }),
    });
  }
  return result;
}
function dedupeDeviations(items: readonly JiraReportDeviation[]): readonly JiraReportDeviation[] {
  const seen = new Set<string>();
  const result: JiraReportDeviation[] = [];
  for (const item of items) {
    const id = `${item.ruleId}\u0000${item.fieldId ?? ""}\u0000${item.subject ?? ""}`;
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(item);
  }
  return result.sort(
    (left, right) =>
      compareCodePoints(left.ruleId, right.ruleId) ||
      compareCodePoints(left.fieldId ?? "", right.fieldId ?? "") ||
      compareCodePoints(left.subject ?? "", right.subject ?? ""),
  );
}
/** A trailing dot, dash or underscore ends a sentence, not an identifier. */
function trimTrailingSeparators(token: string): string {
  let end = token.length;
  while (end > 0 && ".-_".includes(token.charAt(end - 1))) end -= 1;
  return token.slice(0, end);
}
/**
 * Every label the response carries: the trace a write left on the issue and the requirement ids
 * are read from them, so no count cut may hide one. The memory budget charges each label.
 */
function labelsOf(fields: Record<string, unknown>): readonly string[] {
  const labels = asArray(fields.labels)?.filter(
    (item): item is string => typeof item === "string" && item.length > 0,
  );
  return (labels ?? []).map((label) => label.slice(0, LABEL_CHARS_MAX));
}
function referencedRequirements(
  summary: string,
  labels: readonly string[],
  fields: Record<string, unknown>,
  plan: JiraReportFieldPlan,
): readonly string[] {
  if (plan.requirementIds.size === 0) return [];
  const description = typeof fields.description === "string" ? fields.description : "";
  const found = new Set<string>();
  for (const text of [summary, ...labels, description]) {
    for (const match of text.matchAll(TOKEN_PATTERN)) {
      const token = trimTrailingSeparators(match[0]);
      if (plan.requirementIds.has(token)) found.add(token);
    }
  }
  return [...found].sort(compareCodePoints);
}
function checkerFacts(
  key: string,
  fields: Record<string, unknown>,
  plan: JiraReportFieldPlan,
  state: {
    readonly typeName: string;
    readonly typeId: string;
    readonly category: JiraReportStatusCategory;
  },
): Parameters<JiraReportComplianceChecker["check"]>[0] {
  const selected: Record<string, unknown> = {};
  for (const id of plan.checker?.fieldIds ?? [])
    if (Object.hasOwn(fields, id)) selected[id] = fields[id];
  return {
    key,
    projectKey: stringOf(reference(fields.project)?.key, 128) ?? "",
    issueTypeId: state.typeId,
    typeName: state.typeName,
    category: state.category,
    fields: selected,
  };
}

interface IssueIdentity {
  readonly key: string;
  readonly fields: Record<string, unknown>;
  readonly typeName: string;
  readonly typeId: string;
  readonly subtask: boolean;
}
function typeOf(
  fields: Record<string, unknown>,
): { readonly name: string; readonly id: string; readonly subtask: boolean } | undefined {
  const type = reference(fields.issuetype);
  const name = stringOf(type?.name, 255);
  return name === undefined
    ? undefined
    : { name, id: stringOf(type?.id, 32) ?? "", subtask: type?.subtask === true };
}
function identityOf(value: unknown): IssueIdentity | undefined {
  const raw = asRecord(value);
  const fields = asRecord(raw?.fields);
  const key = raw?.key;
  const type = fields === undefined ? undefined : typeOf(fields);
  if (fields === undefined || type === undefined || !isSafeAtlassianIdentifier(key))
    return undefined;
  return { key, fields, typeName: type.name, typeId: type.id, subtask: type.subtask };
}

/** Project one Jira search hit onto the compact record. A hit without key and type is refused. */
export function parseJiraReportIssue(
  value: unknown,
  plan: JiraReportFieldPlan,
): JiraReportIssue | undefined {
  const identity = identityOf(value);
  if (identity === undefined) return undefined;
  const { key, fields, typeName, typeId, subtask } = identity;
  const status = reference(fields.status);
  const statusCategory = category(status);
  const summary = stringOf(fields.summary, SUMMARY_MAX) ?? "";
  const facts = checkerFacts(key, fields, plan, { typeName, typeId, category: statusCategory });
  const labels = labelsOf(fields);
  return {
    key,
    typeName,
    subtask,
    summary,
    statusName: stringOf(status?.name, 255) ?? "",
    category: statusCategory,
    parentKey: parentKeyOf(key, fields, plan),
    linkedKeys: linkedKeysOf(fields),
    assigned: assignedOf(fields, plan),
    dueDate: stringOf(fields.duedate, 32),
    estimate: estimateOf(fields, plan),
    deviations: dedupeDeviations([
      ...requiredDeviations(fields, typeId, plan),
      ...checkerDeviations(facts, plan),
    ]),
    templateJudged: plan.checker !== undefined && (plan.checker.covers?.(facts) ?? true),
    requirementIds: referencedRequirements(summary, labels, fields, plan),
    labels,
  };
}
