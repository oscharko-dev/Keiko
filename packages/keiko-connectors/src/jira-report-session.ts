import type { JiraReportIncompleteReason } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { asArray } from "./atlassian-sync-classify.js";
import { buildJiraReport, type JiraReportInput } from "./jira-report-aggregate.js";
import {
  createJiraReportHttp,
  type JiraReportHttp,
  type JiraReportHttpDeps,
} from "./jira-report-http.js";
import { parseJiraReportIssue, type JiraReportFieldPlan } from "./jira-report-issue.js";
import {
  discoverHierarchyFields,
  loadRequiredFields,
  type JiraReportHierarchyFields,
  type JiraReportRequiredFields,
} from "./jira-report-metadata.js";
import type {
  JiraReport,
  JiraReportCheckerPort,
  JiraReportComplianceChecker,
  JiraReportFieldCatalogEntry,
  JiraReportIssue,
  JiraReportScope,
} from "./jira-report-types.js";

/** Validated request arguments; the model supplies scope and options, never numbers. */
export interface JiraReportRequest {
  readonly projectKey: string | undefined;
  readonly jql: string | undefined;
  readonly estimateFieldId: string | undefined;
  readonly parentFieldIds: readonly string[];
  readonly requirementIds: readonly string[];
}

export interface JiraReportSession {
  readonly id: string;
  /** Binds the report to the Chat and authority that started it. */
  readonly owner: string;
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
  fieldList: string;
  hierarchy: JiraReportHierarchyFields | undefined;
  required: JiraReportRequiredFields | undefined;
  issues: Map<string, JiraReportIssue>;
  startAt: number;
  total: number | undefined;
  pageSize: number;
  pageCeiling: number;
  successStreak: number;
  pageCount: number;
  bytes: number;
  shifted: boolean;
  transientFailures: number;
  incomplete: JiraReportIncompleteReason | undefined;
  failureReason: string | undefined;
  report: JiraReport | undefined;
}

export interface JiraReportReadDeps extends JiraReportHttpDeps {
  readonly now: () => number;
  readonly sliceMs: number;
  readonly memoryBudgetBytes: number;
  readonly checker: JiraReportCheckerPort | undefined;
}

const INITIAL_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 1000;
const GROWTH_STREAK = 4;
const TRANSIENT_FAILURE_LIMIT = 3;
const FIELD_LIST_MAX_CHARS = 6000;
const BASE_FIELDS = [
  "summary",
  "status",
  "issuetype",
  "project",
  "parent",
  "issuelinks",
  "labels",
  "assignee",
  "duedate",
];

const ORDER_BY = /^order\s+by\b/iu;
/** Ordering outside quotes is replaced by the report's own stable ordering. */
export function stripJqlOrdering(jql: string): string {
  let quote: string | undefined;
  for (let index = 0; index < jql.length; index += 1) {
    const char = jql.charAt(index);
    if (quote !== undefined) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") quote = char;
    else if (
      (index === 0 || /[\s)]/u.test(jql.charAt(index - 1))) &&
      ORDER_BY.test(jql.slice(index))
    )
      return jql.slice(0, index).trim();
  }
  return jql.trim();
}
/** The effective query: the project and the caller's clause, in a stable order. */
export function reportJql(projectKey: string | undefined, jql: string | undefined): string {
  const clause = jql === undefined ? "" : stripJqlOrdering(jql);
  const parts = [
    ...(projectKey === undefined ? [] : [`project = "${projectKey}"`]),
    ...(clause.length === 0 ? [] : [projectKey === undefined ? clause : `(${clause})`]),
  ];
  return `${parts.join(" AND ")} ORDER BY key ASC`;
}

export function createJiraReportSession(input: {
  readonly id: string;
  readonly owner: string;
  readonly request: JiraReportRequest;
  readonly now: number;
}): JiraReportSession {
  const clause = input.request.jql === undefined ? "" : stripJqlOrdering(input.request.jql);
  return {
    id: input.id,
    owner: input.owner,
    request: input.request,
    scope: {
      ...(input.request.projectKey === undefined ? {} : { projectKey: input.request.projectKey }),
      jql: clause,
      ...(input.request.estimateFieldId === undefined
        ? {}
        : { estimateFieldId: input.request.estimateFieldId }),
    },
    jql: reportJql(input.request.projectKey, input.request.jql),
    startedAt: input.now,
    phase: "new",
    busy: false,
    lastUsedAt: input.now,
    plan: undefined,
    checker: "none",
    fieldList: "",
    hierarchy: undefined,
    required: undefined,
    issues: new Map(),
    startAt: 0,
    total: undefined,
    pageSize: INITIAL_PAGE_SIZE,
    pageCeiling: MAX_PAGE_SIZE,
    successStreak: 0,
    pageCount: 0,
    bytes: 0,
    shifted: false,
    transientFailures: 0,
    incomplete: undefined,
    failureReason: undefined,
    report: undefined,
  };
}

function fieldPlan(
  session: JiraReportSession,
  hierarchy: JiraReportHierarchyFields,
  required: JiraReportRequiredFields,
  checker: JiraReportComplianceChecker | undefined,
): JiraReportFieldPlan {
  return {
    parentFieldIds: [...new Set([...hierarchy.parentFieldIds, ...session.request.parentFieldIds])],
    epicNameFieldId: hierarchy.epicNameFieldId,
    estimateFieldId: session.request.estimateFieldId ?? "timeoriginalestimate",
    requirementIds: new Set(session.request.requirementIds),
    requiredByType: required.byType,
    checker,
    includeDescription: session.request.requirementIds.length > 0,
  };
}
function fieldListOf(plan: JiraReportFieldPlan): string {
  const ids = new Set<string>(BASE_FIELDS);
  ids.add(plan.estimateFieldId);
  for (const id of plan.parentFieldIds) ids.add(id);
  if (plan.epicNameFieldId !== undefined) ids.add(plan.epicNameFieldId);
  for (const fields of plan.requiredByType.values()) for (const id of fields) ids.add(id);
  for (const id of plan.checker?.fieldIds ?? []) ids.add(id);
  if (plan.includeDescription) ids.add("description");
  return [...ids].join(",");
}

function reportInput(
  session: JiraReportSession,
  deps: JiraReportReadDeps,
  reason: JiraReportIncompleteReason | undefined,
): JiraReportInput {
  const { request } = session;
  return {
    issues: [...session.issues.values()],
    scope: session.scope,
    completeness: {
      complete: reason === undefined,
      ...(reason === undefined ? {} : { reason }),
      issuesRead: session.issues.size,
      issuesTotal: session.total,
      pageCount: session.pageCount,
    },
    hierarchy: {
      discovery: session.hierarchy?.discovery ?? "unavailable",
      fieldCount: session.plan?.parentFieldIds.length ?? 0,
    },
    requiredFieldRules:
      request.projectKey === undefined
        ? "not-requested"
        : (session.required?.state ?? "unavailable"),
    checker: session.checker,
    declaredRequirements: request.requirementIds,
    now: new Date(deps.now()),
  };
}
function finish(
  session: JiraReportSession,
  deps: JiraReportReadDeps,
  reason?: JiraReportIncompleteReason,
): void {
  const unchanged = session.total === undefined || session.issues.size === session.total;
  const incomplete =
    reason ??
    (session.shifted || !unchanged ? "scope-changed" : undefined) ??
    (session.checker === "unavailable" ? "template-unreadable" : undefined);
  session.incomplete = incomplete;
  session.report = buildJiraReport(reportInput(session, deps, incomplete));
  session.issues = new Map();
  session.phase = "finished";
}

type BoundChecker = JiraReportComplianceChecker | "none" | "unavailable";

/** A binder resolves against the instance's field list; a plain checker applies as it is. */
function bindChecker(
  port: JiraReportCheckerPort | undefined,
  catalog: readonly JiraReportFieldCatalogEntry[] | undefined,
): BoundChecker {
  if (port === undefined) return "none";
  return "bind" in port ? port.bind(catalog) : port;
}
function checkerState(checker: BoundChecker): JiraReport["compliance"]["checker"] {
  return typeof checker === "string" ? checker : "applied";
}

async function initialize(
  session: JiraReportSession,
  deps: JiraReportReadDeps,
  http: JiraReportHttp,
): Promise<void> {
  const hierarchy = await discoverHierarchyFields(http);
  const required =
    session.request.projectKey === undefined
      ? ({ state: "unavailable", byType: new Map() } as const)
      : await loadRequiredFields(http, session.request.projectKey);
  session.hierarchy = hierarchy;
  session.required = required;
  const checker = bindChecker(deps.checker, hierarchy.catalog);
  session.checker = checkerState(checker);
  session.plan = fieldPlan(
    session,
    hierarchy,
    required,
    typeof checker === "string" ? undefined : checker,
  );
  session.fieldList = fieldListOf(session.plan);
  if (session.fieldList.length > FIELD_LIST_MAX_CHARS) {
    session.failureReason = "bounds-exceeded";
    finish(session, deps, "read-failed");
    return;
  }
  session.phase = "reading";
}

function issueCost(issue: JiraReportIssue): number {
  return (
    256 +
    2 * (issue.summary.length + issue.statusName.length + issue.typeName.length) +
    48 * (issue.linkedKeys.length + issue.deviations.length + issue.requirementIds.length)
  );
}
interface PageRead {
  readonly issues: readonly unknown[];
  readonly total: number | undefined;
}
function readPage(body: Record<string, unknown>): PageRead | undefined {
  const issues = asArray(body.issues);
  if (issues === undefined) return undefined;
  const total =
    typeof body.total === "number" && Number.isSafeInteger(body.total) ? body.total : undefined;
  return { issues, total };
}
function ingestPage(
  session: JiraReportSession,
  page: PageRead,
  plan: JiraReportFieldPlan,
): boolean {
  for (const raw of page.issues) {
    const issue = parseJiraReportIssue(raw, plan);
    if (issue === undefined) return false;
    if (session.issues.has(issue.key)) session.shifted = true;
    else {
      session.issues.set(issue.key, issue);
      session.bytes += issueCost(issue);
    }
  }
  return true;
}
function adaptPageSize(session: JiraReportSession, truncated: boolean): void {
  if (truncated) {
    session.pageCeiling = Math.max(1, Math.floor(session.pageSize / 2));
    session.pageSize = session.pageCeiling;
    session.successStreak = 0;
    return;
  }
  session.successStreak += 1;
  if (session.successStreak >= GROWTH_STREAK && session.pageSize < session.pageCeiling) {
    session.pageSize = Math.min(session.pageSize * 2, session.pageCeiling);
    session.successStreak = 0;
  }
}
function onPageFailure(session: JiraReportSession, deps: JiraReportReadDeps, reason: string): void {
  // A body over the transport cap reads as a malformed payload: ask for fewer issues per page.
  if (reason === "malformed-payload" && session.pageSize > 1) {
    adaptPageSize(session, true);
    return;
  }
  session.failureReason = reason;
  if (reason === "malformed-payload") {
    finish(session, deps, "issue-too-large");
    return;
  }
  session.transientFailures += 1;
  const transient = reason === "timeout" || reason === "unavailable" || reason === "rate-limited";
  if (!transient || session.transientFailures >= TRANSIENT_FAILURE_LIMIT)
    finish(session, deps, "read-failed");
}
function onPageRead(session: JiraReportSession, deps: JiraReportReadDeps, page: PageRead): void {
  const plan = session.plan;
  if (plan === undefined || !ingestPage(session, page, plan)) {
    finish(session, deps, "read-failed");
    return;
  }
  session.pageCount += 1;
  session.transientFailures = 0;
  session.total = page.total ?? session.total;
  session.startAt += page.issues.length;
  adaptPageSize(session, false);
  const done =
    page.issues.length === 0 || (session.total !== undefined && session.startAt >= session.total);
  if (session.bytes > deps.memoryBudgetBytes) finish(session, deps, "memory-budget");
  else if (done) finish(session, deps);
}
async function readNextPage(
  session: JiraReportSession,
  deps: JiraReportReadDeps,
  http: JiraReportHttp,
): Promise<void> {
  const query = new URLSearchParams({
    jql: session.jql,
    startAt: String(session.startAt),
    maxResults: String(session.pageSize),
    fields: session.fieldList,
  });
  const outcome = await http.getRecord(`search?${query.toString()}`);
  const page = outcome.ok ? readPage(outcome.body) : undefined;
  if (page !== undefined) onPageRead(session, deps, page);
  else onPageFailure(session, deps, outcome.ok ? "malformed-payload" : outcome.reason);
}

async function pump(
  session: JiraReportSession,
  deps: JiraReportReadDeps,
  http: JiraReportHttp,
  deadline: number,
): Promise<void> {
  if (session.phase !== "reading" || deps.signal.aborted || deps.now() >= deadline) return;
  const before = session.transientFailures;
  await readNextPage(session, deps, http);
  // A transient failure ends this slice; the next call of the tool resumes at the same offset.
  if (session.transientFailures > before) return;
  await pump(session, deps, http, deadline);
}

/** Read Jira until the scope is complete or the slice ends; the session carries the progress. */
export async function advanceJiraReportSession(
  session: JiraReportSession,
  deps: JiraReportReadDeps,
): Promise<void> {
  const http = createJiraReportHttp(deps);
  const deadline = deps.now() + deps.sliceMs;
  if (session.phase === "new") await initialize(session, deps, http);
  await pump(session, deps, http, deadline);
}
