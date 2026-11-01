import type {
  JiraReportFailureReason,
  JiraReportIncompleteReason,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { JiraReportHttpDeps } from "./jira-report-http.js";
import type { JiraReportFieldPlan } from "./jira-report-issue.js";
import { jqlClause, reportJql } from "./jira-report-jql.js";
import type {
  JiraReportHierarchyFields,
  JiraReportRequiredFields,
} from "./jira-report-metadata.js";
import type {
  JiraReport,
  JiraReportCheckerPort,
  JiraReportIssue,
  JiraReportScope,
} from "./jira-report-types.js";

export { reportJql, stripJqlOrdering } from "./jira-report-jql.js";

/** Validated request arguments; the model supplies scope and options, never numbers. */
export interface JiraReportRequest {
  readonly projectKey: string | undefined;
  readonly jql: string | undefined;
  readonly estimateFieldId: string | undefined;
  /** The date overdue is judged against (UTC); the date of the first call when absent. */
  readonly asOf: string | undefined;
  readonly parentFieldIds: readonly string[];
  readonly requirementIds: readonly string[];
}

export interface JiraReportSession {
  readonly id: string;
  /** Binds the report to the Chat that started it. */
  readonly owner: string;
  /** Binds it to the Jira instance and credential it was started with. */
  readonly fingerprint: string;
  readonly request: JiraReportRequest;
  readonly scope: JiraReportScope;
  readonly jql: string;
  readonly startedAt: number;
  phase: "new" | "reading" | "finished";
  busy: boolean;
  lastUsedAt: number;
  plan: JiraReportFieldPlan | undefined;
  /** How the compliance checker was bound at the start; `unavailable` ends the report incomplete. */
  checker: JiraReport["compliance"]["checker"];
  hierarchy: JiraReportHierarchyFields | undefined;
  required: JiraReportRequiredFields | undefined;
  issues: Map<string, JiraReportIssue>;
  /** The last issue read; the next page starts at it, so a shifted scope shows at the boundary. */
  lastKey: string | undefined;
  startAt: number;
  total: number | undefined;
  pageSize: number;
  pageCeiling: number;
  successStreak: number;
  pageCount: number;
  bytes: number;
  transientFailures: number;
  initFailures: number;
  incomplete: JiraReportIncompleteReason | undefined;
  failure: JiraReportFailureReason | undefined;
  report: JiraReport | undefined;
}

/** How the parent relation was found so far: counts and one closed word, never a field id. */
export function jiraReportHierarchyOf(session: JiraReportSession): JiraReport["hierarchy"] {
  const plan = session.plan;
  return {
    discovery: session.hierarchy?.discovery ?? "unavailable",
    fieldCount: plan?.parentFieldIds.length ?? 0,
    observedFieldCount: plan?.parentFieldsSeen.size ?? 0,
    rejectedFieldCount: plan?.parentFieldsRejected.size ?? 0,
  };
}

export interface JiraReportReadDeps extends JiraReportHttpDeps {
  readonly now: () => number;
  readonly sliceMs: number;
  readonly memoryBudgetBytes: number;
  readonly checker: JiraReportCheckerPort | undefined;
}

export const JIRA_REPORT_INITIAL_PAGE_SIZE = 100;
export const JIRA_REPORT_MAX_PAGE_SIZE = 1000;
/** Retained size of one report while it is read and built; a safety bound, not a scope limit. */
export const JIRA_REPORT_SESSION_MAX_BYTES = 192 * 1024 * 1024;
// A record, its map entries, its graph entries and its export row at the peak of building.
const ISSUE_BASE_BYTES = 1200;
const CHARACTER_BYTES = 2;
const ENTRY_BYTES = 96;

/** What one issue keeps resident until the report is built; deliberately not an underestimate. */
export function jiraReportIssueCost(issue: JiraReportIssue): number {
  const text =
    issue.key.length +
    issue.summary.length +
    issue.statusName.length +
    issue.typeName.length +
    (issue.parentKey?.length ?? 0) +
    issue.linkedKeys.reduce((sum, key) => sum + key.length, 0) +
    issue.requirementIds.reduce((sum, id) => sum + id.length, 0) +
    issue.labels.reduce((sum, label) => sum + label.length, 0) +
    issue.deviations.reduce(
      (sum, item) => sum + item.ruleId.length + (item.fieldId?.length ?? 0),
      0,
    );
  const entries =
    issue.linkedKeys.length +
    issue.deviations.length +
    issue.requirementIds.length +
    issue.labels.length;
  return ISSUE_BASE_BYTES + CHARACTER_BYTES * text + ENTRY_BYTES * entries;
}

export function createJiraReportSession(input: {
  readonly id: string;
  readonly owner: string;
  readonly fingerprint: string;
  readonly request: JiraReportRequest;
  readonly now: number;
}): JiraReportSession {
  const { request } = input;
  return {
    id: input.id,
    owner: input.owner,
    fingerprint: input.fingerprint,
    request,
    scope: {
      ...(request.projectKey === undefined ? {} : { projectKey: request.projectKey }),
      jql: request.jql === undefined ? "" : (jqlClause(request.jql) ?? ""),
      ...(request.estimateFieldId === undefined
        ? {}
        : { estimateFieldId: request.estimateFieldId }),
      estimateUnit: request.estimateFieldId === undefined ? "seconds" : "custom-field",
      asOf: request.asOf ?? new Date(input.now).toISOString().slice(0, 10),
      timeZone: "UTC",
    },
    jql: reportJql(request.projectKey, request.jql),
    startedAt: input.now,
    phase: "new",
    busy: false,
    lastUsedAt: input.now,
    plan: undefined,
    checker: "none",
    hierarchy: undefined,
    required: undefined,
    issues: new Map(),
    lastKey: undefined,
    startAt: 0,
    total: undefined,
    pageSize: JIRA_REPORT_INITIAL_PAGE_SIZE,
    pageCeiling: JIRA_REPORT_MAX_PAGE_SIZE,
    successStreak: 0,
    pageCount: 0,
    bytes: 0,
    transientFailures: 0,
    initFailures: 0,
    incomplete: undefined,
    failure: undefined,
    report: undefined,
  };
}
