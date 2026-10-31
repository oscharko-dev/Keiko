import {
  isSafeAtlassianIdentifier,
  JIRA_REPORT_REQUIRED_FIELD_RULE,
  JIRA_REPORT_STATUS_CATEGORIES,
  type JiraReportStatusCategory,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { asArray, asRecord } from "./atlassian-sync-classify.js";
import type {
  JiraReportComplianceChecker,
  JiraReportDeviation,
  JiraReportIssue,
} from "./jira-report-types.js";

/** Everything the parser needs from the instance and the request; derived once per report. */
export interface JiraReportFieldPlan {
  /** Fields whose value names the issue's parent (Epic Link, Parent Link, caller-named). */
  readonly parentFieldIds: readonly string[];
  readonly epicNameFieldId: string | undefined;
  readonly estimateFieldId: string;
  readonly requirementIds: ReadonlySet<string>;
  readonly requiredByType: ReadonlyMap<string, readonly string[]>;
  readonly checker: JiraReportComplianceChecker | undefined;
  readonly includeDescription: boolean;
}

const RULE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const TOKEN_PATTERN = /[A-Za-z0-9][A-Za-z0-9._-]*/gu;
const SUMMARY_MAX = 255;
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
function parentKeyOf(
  fields: Record<string, unknown>,
  plan: JiraReportFieldPlan,
): string | undefined {
  const candidates = [fields.parent, ...plan.parentFieldIds.map((id) => fields[id])];
  for (const candidate of candidates) {
    const key = issueKeyOf(candidate);
    if (key !== undefined) return key;
  }
  return undefined;
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
  return [...keys].sort();
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
    if (Object.hasOwn(fields, fieldId) && isEmptyJiraValue(fields[fieldId]))
      result.push({ ruleId: JIRA_REPORT_REQUIRED_FIELD_RULE, fieldId });
  }
  return result;
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
      item.fieldId !== undefined && /^[A-Za-z0-9_]{1,64}$/u.test(item.fieldId)
        ? item.fieldId
        : undefined;
    result.push(fieldId === undefined ? { ruleId: item.ruleId } : { ruleId: item.ruleId, fieldId });
  }
  return result;
}
function dedupeDeviations(items: readonly JiraReportDeviation[]): readonly JiraReportDeviation[] {
  const seen = new Set<string>();
  const result: JiraReportDeviation[] = [];
  for (const item of items) {
    const id = `${item.ruleId}\u0000${item.fieldId ?? ""}`;
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(item);
  }
  return result.sort(
    (left, right) =>
      left.ruleId.localeCompare(right.ruleId, "en") ||
      (left.fieldId ?? "").localeCompare(right.fieldId ?? "", "en"),
  );
}
function referencedRequirements(
  summary: string,
  fields: Record<string, unknown>,
  plan: JiraReportFieldPlan,
): readonly string[] {
  if (plan.requirementIds.size === 0) return [];
  const labels = asArray(fields.labels)?.filter((item) => typeof item === "string") ?? [];
  const description = typeof fields.description === "string" ? fields.description : "";
  const found = new Set<string>();
  for (const text of [summary, ...labels, description]) {
    for (const match of text.matchAll(TOKEN_PATTERN)) {
      const token = match[0].replace(/[._-]+$/u, "");
      if (plan.requirementIds.has(token)) found.add(token);
    }
  }
  return [...found].sort();
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
function hasEpicName(fields: Record<string, unknown>, plan: JiraReportFieldPlan): boolean {
  const name = plan.epicNameFieldId === undefined ? undefined : fields[plan.epicNameFieldId];
  return typeof name === "string" && name.trim().length > 0;
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
  return {
    key,
    typeName,
    subtask,
    summary,
    statusName: stringOf(status?.name, 255) ?? "",
    category: statusCategory,
    parentKey: parentKeyOf(fields, plan),
    linkedKeys: linkedKeysOf(fields),
    assigned: fields.assignee !== null,
    dueDate: stringOf(fields.duedate, 32),
    estimate: estimateOf(fields, plan),
    epicMarker: hasEpicName(fields, plan),
    deviations: dedupeDeviations([
      ...requiredDeviations(fields, typeId, plan),
      ...checkerDeviations(facts, plan),
    ]),
    requirementIds: referencedRequirements(summary, fields, plan),
  };
}
