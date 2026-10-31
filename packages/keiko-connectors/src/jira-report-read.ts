import type {
  JiraReportFailureReason,
  JiraReportIncompleteReason,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { asArray, asRecord } from "./atlassian-sync-classify.js";
import { buildJiraReport, type JiraReportInput } from "./jira-report-aggregate.js";
import { createJiraReportHttp, type JiraReportHttp } from "./jira-report-http.js";
import { parseJiraReportIssue, type JiraReportFieldPlan } from "./jira-report-issue.js";
import {
  discoverHierarchyFields,
  loadRequiredFields,
  type JiraReportFailure,
  type JiraReportHierarchyFields,
  type JiraReportRequiredFields,
} from "./jira-report-metadata.js";
import type {
  JiraReport,
  JiraReportCheckerPort,
  JiraReportComplianceChecker,
  JiraReportFieldCatalogEntry,
} from "./jira-report-types.js";
import {
  jiraReportIssueCost,
  type JiraReportReadDeps,
  type JiraReportSession,
} from "./jira-report-session.js";

const GROWTH_STREAK = 4;
const TRANSIENT_FAILURE_LIMIT = 3;
const INIT_FAILURE_LIMIT = 2;
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
const TRANSIENT: ReadonlySet<string> = new Set(["timeout", "unavailable", "rate-limited"]);

/** The closed word for a Jira failure; a 400 on the search is the caller's query. */
export function jiraReportFailure(
  reason: JiraReportFailure,
  search: boolean,
): JiraReportFailureReason {
  switch (reason) {
    case "field-validation":
      return search ? "invalid-jql" : "unavailable";
    case "auth-failed":
      return "auth";
    case "permission-denied":
      return "permission";
    case "not-found":
    case "rate-limited":
    case "timeout":
    case "malformed-payload":
    case "bounds-exceeded":
      return reason;
    default:
      return "unavailable";
  }
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

function completenessOf(
  session: JiraReportSession,
  reason: JiraReportIncompleteReason | undefined,
): JiraReportInput["completeness"] {
  return {
    complete: reason === undefined,
    ...(reason === undefined ? {} : { reason }),
    ...(reason === undefined || session.failure === undefined ? {} : { failure: session.failure }),
    issuesRead: session.issues.size,
    issuesTotal: session.total,
    pageCount: session.pageCount,
  };
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
    completeness: completenessOf(session, reason),
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
    (unchanged ? undefined : "scope-changed") ??
    (session.checker === "unavailable" ? "template-unreadable" : undefined);
  session.incomplete = incomplete;
  session.report = buildJiraReportOf(session, deps, incomplete);
  session.issues = new Map();
  session.phase = "finished";
}
function buildJiraReportOf(
  session: JiraReportSession,
  deps: JiraReportReadDeps,
  incomplete: JiraReportIncompleteReason | undefined,
): ReturnType<typeof buildJiraReport> {
  return buildJiraReport(reportInput(session, deps, incomplete));
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

/** What keeps a report from being trusted: metadata the figures depend on that could not be read. */
function initializationProblem(
  session: JiraReportSession,
  hierarchy: JiraReportHierarchyFields,
  required: JiraReportRequiredFields,
): JiraReportFailure | undefined {
  // Named parent fields stand in for discovery; the caller took responsibility for them.
  if (hierarchy.discovery === "unavailable" && session.request.parentFieldIds.length === 0)
    return hierarchy.reason ?? "unavailable";
  if (session.request.projectKey !== undefined && required.state !== "applied")
    return required.reason ?? "unavailable";
  return undefined;
}
async function initialize(
  session: JiraReportSession,
  deps: JiraReportReadDeps,
  http: JiraReportHttp,
): Promise<void> {
  const hierarchy = await discoverHierarchyFields(http);
  const required: JiraReportRequiredFields =
    session.request.projectKey === undefined
      ? { state: "unavailable", byType: new Map() }
      : await loadRequiredFields(http, session.request.projectKey);
  session.hierarchy = hierarchy;
  session.required = required;
  const problem = initializationProblem(session, hierarchy, required);
  if (problem !== undefined) {
    // The next call asks again; a second failure ends the report instead of degrading it silently.
    session.failure = jiraReportFailure(problem, false);
    session.initFailures += 1;
    if (session.initFailures >= INIT_FAILURE_LIMIT) finish(session, deps, "read-failed");
    return;
  }
  const checker = bindChecker(deps.checker, hierarchy.catalog);
  session.checker = checkerState(checker);
  session.plan = fieldPlan(
    session,
    hierarchy,
    required,
    typeof checker === "string" ? undefined : checker,
  );
  session.fieldList = fieldListOf(session.plan);
  session.failure = undefined;
  if (session.fieldList.length > FIELD_LIST_MAX_CHARS) {
    session.failure = "bounds-exceeded";
    finish(session, deps, "read-failed");
    return;
  }
  session.phase = "reading";
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
type Ingest = "ok" | "invalid" | "repeated" | "budget";
function ingestPage(
  session: JiraReportSession,
  raws: readonly unknown[],
  plan: JiraReportFieldPlan,
  budget: number,
): Ingest {
  for (const raw of raws) {
    const issue = parseJiraReportIssue(raw, plan);
    if (issue === undefined) return "invalid";
    if (session.issues.has(issue.key)) return "repeated";
    session.issues.set(issue.key, issue);
    session.bytes += jiraReportIssueCost(issue);
    session.lastKey = issue.key;
    session.startAt += 1;
    if (session.bytes > budget) return "budget";
  }
  return "ok";
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
function onPageFailure(
  session: JiraReportSession,
  deps: JiraReportReadDeps,
  reason: JiraReportFailure,
): void {
  // A body over the transport cap reads as a malformed payload: ask for fewer issues per page.
  if (reason === "malformed-payload" && session.pageSize > 1) {
    adaptPageSize(session, true);
    return;
  }
  session.failure = jiraReportFailure(reason, true);
  if (reason === "malformed-payload") {
    finish(session, deps, "issue-too-large");
    return;
  }
  session.transientFailures += 1;
  if (!TRANSIENT.has(reason) || session.transientFailures >= TRANSIENT_FAILURE_LIMIT)
    finish(session, deps, "read-failed");
}

/** The page's own new issues. A page that starts at the last issue read proves nothing moved. */
function newIssuesOf(
  session: JiraReportSession,
  page: PageRead,
  overlap: number,
): readonly unknown[] | undefined {
  if (overlap === 0) return page.issues;
  const first = asRecord(page.issues[0]);
  return first?.key === session.lastKey ? page.issues.slice(1) : undefined;
}
function scopeMoved(session: JiraReportSession, page: PageRead): boolean {
  return session.total !== undefined && page.total !== undefined && page.total !== session.total;
}
function onPageRead(
  session: JiraReportSession,
  deps: JiraReportReadDeps,
  page: PageRead,
  overlap: number,
): void {
  const plan = session.plan;
  const fresh = newIssuesOf(session, page, overlap);
  if (plan === undefined) {
    finish(session, deps, "read-failed");
    return;
  }
  if (fresh === undefined || scopeMoved(session, page)) {
    finish(session, deps, "scope-changed");
    return;
  }
  const ingested = ingestPage(session, fresh, plan, deps.memoryBudgetBytes);
  session.pageCount += 1;
  session.transientFailures = 0;
  session.failure = undefined;
  session.total = page.total ?? session.total;
  adaptPageSize(session, false);
  if (ingested === "ok") {
    const done =
      fresh.length === 0 || (session.total !== undefined && session.startAt >= session.total);
    if (done) finish(session, deps);
    return;
  }
  const reasons = {
    invalid: "read-failed",
    repeated: "scope-changed",
    budget: "memory-budget",
  } as const;
  finish(session, deps, reasons[ingested]);
}
async function readNextPage(
  session: JiraReportSession,
  deps: JiraReportReadDeps,
  http: JiraReportHttp,
): Promise<void> {
  const overlap = session.pageSize > 1 && session.lastKey !== undefined ? 1 : 0;
  const query = new URLSearchParams({
    jql: session.jql,
    startAt: String(session.startAt - overlap),
    maxResults: String(session.pageSize),
    fields: session.fieldList,
  });
  const outcome = await http.getRecord(`search?${query.toString()}`);
  const page = outcome.ok ? readPage(outcome.body) : undefined;
  if (page !== undefined) onPageRead(session, deps, page, overlap);
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
