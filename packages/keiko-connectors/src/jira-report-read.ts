import type {
  JiraReportFailureReason,
  JiraReportIncompleteReason,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { JIRA_REPORT_FAILURE_REASONS } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { asArray, asRecord } from "./atlassian-sync-classify.js";
import { buildJiraReport, type JiraReportInput } from "./jira-report-aggregate.js";
import { createJiraReportHttp, type JiraReportHttp } from "./jira-report-http.js";
import {
  parseJiraReportIssue,
  rejectNonParentFields,
  retractRejectedParents,
  type JiraReportFieldPlan,
} from "./jira-report-issue.js";
import { fetchJiraReportPage } from "./jira-report-page.js";
import { resolveJiraReportEstimate } from "./jira-report-estimate.js";
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
  jiraReportHierarchyOf,
  jiraReportIssueCost,
  jiraReportProposalCost,
  type JiraReportReadDeps,
  type JiraReportSession,
} from "./jira-report-session.js";

const GROWTH_STREAK = 4;
const TRANSIENT_FAILURE_LIMIT = 3;
const INIT_FAILURE_LIMIT = 2;
const TRANSIENT: ReadonlySet<string> = new Set(["timeout", "unavailable", "rate-limited"]);

/** The closed word for a Jira failure; a 400 on the search is the caller's query. */
export function jiraReportFailure(
  reason: JiraReportFailure,
  search: boolean,
): JiraReportFailureReason {
  if (reason === "field-validation") return search ? "invalid-jql" : "unavailable";
  if (reason === "auth-failed") return "auth";
  if (reason === "permission-denied") return "permission";
  return JIRA_REPORT_FAILURE_REASONS.find((value) => value === reason) ?? "unavailable";
}

/**
 * The issue types whose read create screen lacks the estimate field although the project offers it
 * on another type's. Without a type that carries it, the field is unknown to the screens and no
 * type is exempt: an explicitly named field that no screen lists stays strictly required.
 */
function estimateNotApplicableTypes(
  required: JiraReportRequiredFields,
  fieldId: string | undefined,
): ReadonlySet<string> {
  const screens = [...(required.estimateByType ?? [])];
  if (fieldId === undefined || !screens.some(([, ids]) => ids.includes(fieldId))) return new Set();
  return new Set(screens.filter(([, ids]) => !ids.includes(fieldId)).map(([typeId]) => typeId));
}

function fieldPlan(
  session: JiraReportSession,
  hierarchy: JiraReportHierarchyFields,
  required: JiraReportRequiredFields,
  checker: JiraReportComplianceChecker | undefined,
): JiraReportFieldPlan {
  return {
    parentFieldIds: [...new Set([...hierarchy.parentFieldIds, ...session.request.parentFieldIds])],
    namedParentFieldIds: new Set(session.request.parentFieldIds),
    parentFieldsSeen: new Set(),
    parentFieldsNonKey: new Set(),
    parentFieldsRejected: new Set(),
    parentProposals: new Map(),
    omittedFields: new Set(),
    estimateFieldId: session.scope.estimateFieldId,
    estimateNotApplicableTypes: estimateNotApplicableTypes(
      required,
      session.scope.estimateFieldId,
    ),
    requirementIds: new Set(session.request.requirementIds),
    requiredByType: required.byType,
    checker,
    includeDescription: session.request.requirementIds.length > 0,
  };
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
    hierarchy: jiraReportHierarchyOf(session),
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
  if (session.plan !== undefined) {
    session.issues = new Map(retractRejectedParents(session.issues, session.plan));
    session.plan.parentProposals.clear();
  }
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
  const { failure, ...estimate } = await resolveJiraReportEstimate(
    http,
    session.request,
    required,
    hierarchy.catalog,
  );
  const { estimateUnavailableReason: _previousReason, ...scope } = session.scope;
  session.scope = { ...scope, ...estimate };
  if (failure !== undefined) {
    session.failure = jiraReportFailure(failure, false);
    finish(session, deps, "read-failed");
    return;
  }
  session.plan = fieldPlan(
    session,
    hierarchy,
    required,
    typeof checker === "string" ? undefined : checker,
  );
  session.failure = undefined;
  session.phase = "reading";
}

interface PageRead {
  readonly issues: readonly unknown[];
  readonly total: number;
}
/**
 * A search page is evidence of completion only with Jira's own pagination coordinates: the total
 * is a non-negative integer, the page starts where it was asked to, and it holds no more issues
 * than the total leaves after that offset. Anything else is a malformed payload, never an
 * empty or complete scope.
 */
function readPage(body: Record<string, unknown>, startAt: number): PageRead | undefined {
  const issues = asArray(body.issues);
  const { total } = body;
  if (issues === undefined || typeof total !== "number") return undefined;
  if (!Number.isSafeInteger(total) || total < 0) return undefined;
  if (body.startAt !== startAt || startAt + issues.length > total) return undefined;
  return { issues, total };
}
type Ingest = "ok" | "invalid" | "repeated" | "budget" | "omitted" | "slice";
type ParsedIssue = Exclude<Awaited<ReturnType<typeof parseJiraReportIssue>>, undefined>;
/** A hit contributes observations only when it survives the slice and is retained. */
function issueFieldPlan(plan: JiraReportFieldPlan): JiraReportFieldPlan {
  return {
    ...plan,
    parentFieldsSeen: new Set(),
    parentFieldsNonKey: new Set(),
    parentProposals: new Map(),
    omittedFields: new Set(),
  };
}
function retainFieldObservations(plan: JiraReportFieldPlan, observed: JiraReportFieldPlan): void {
  for (const id of observed.parentFieldsSeen) plan.parentFieldsSeen.add(id);
  for (const id of observed.parentFieldsNonKey) plan.parentFieldsNonKey.add(id);
  for (const [key, proposals] of observed.parentProposals) plan.parentProposals.set(key, proposals);
}
function retainIssue(
  session: JiraReportSession,
  parsed: ParsedIssue,
  plan: JiraReportFieldPlan,
  budget: number,
): Ingest {
  const { issue } = parsed;
  if (plan.omittedFields.size > 0) return "omitted";
  if (session.issues.has(issue.key)) return "repeated";
  session.issues.set(issue.key, issue);
  session.bytes += jiraReportIssueCost(issue) + jiraReportProposalCost(plan, issue.key);
  session.lastKey = issue.key;
  session.startAt += 1;
  if (parsed.checkerUnavailable) session.checker = "unavailable";
  return session.bytes > budget ? "budget" : "ok";
}
interface PageAdmission {
  readonly http: JiraReportHttp;
  readonly deadline: number;
  readonly deps: JiraReportReadDeps;
  readonly signal: AbortSignal;
}
function sliceAvailable({ deps, deadline, signal }: PageAdmission): boolean {
  return !signal.aborted && deps.now() < deadline;
}
function nativeSliceAvailable(plan: JiraReportFieldPlan, admission: PageAdmission): boolean {
  return plan.checker?.requiresNativeEvidence !== true || sliceAvailable(admission);
}
/** Sequential issue admission bounds concurrency; each issue's independent parents share the HTTP gate. */
async function ingestPage(
  session: JiraReportSession,
  raws: readonly unknown[],
  plan: JiraReportFieldPlan,
  admission: PageAdmission,
  index = 0,
): Promise<Ingest> {
  if (index === raws.length) return "ok";
  if (!nativeSliceAvailable(plan, admission)) return "slice";
  const observed = issueFieldPlan(plan);
  const parsed = await parseJiraReportIssue(raws[index], observed, admission.http.request);
  if (!nativeSliceAvailable(plan, admission)) return "slice";
  if (parsed === undefined) return "invalid";
  const retained = retainIssue(session, parsed, observed, admission.deps.memoryBudgetBytes);
  if (retained === "ok" || retained === "budget") retainFieldObservations(plan, observed);
  return retained === "ok" ? ingestPage(session, raws, plan, admission, index + 1) : retained;
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
  return session.total !== undefined && page.total !== session.total;
}
async function onPageRead(
  session: JiraReportSession,
  deps: JiraReportReadDeps,
  page: PageRead,
  overlap: number,
  admission: PageAdmission,
): Promise<void> {
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
  const ingested = await ingestPage(session, fresh, plan, admission);
  rejectNonParentFields(plan);
  session.pageCount += 1;
  session.transientFailures = 0;
  session.failure = undefined;
  session.total = page.total;
  if (ingested === "slice") return;
  adaptPageSize(session, false);
  if (ingested === "ok") {
    if (fresh.length === 0 || session.startAt >= page.total) finish(session, deps);
    return;
  }
  const reasons = {
    invalid: "read-failed",
    omitted: "read-failed",
    repeated: "scope-changed",
    budget: "memory-budget",
  } as const;
  // A field the account may not see is left out of the hit; the report cannot count it as empty.
  if (ingested === "omitted") session.failure = "permission";
  if (ingested === "invalid") session.failure = "malformed-payload";
  finish(session, deps, reasons[ingested]);
}
async function readNextPage(session: JiraReportSession, admission: PageAdmission): Promise<void> {
  const { deps, http } = admission;
  if (session.plan === undefined) {
    finish(session, deps, "read-failed");
    return;
  }
  const overlap = session.pageSize > 1 && session.lastKey !== undefined ? 1 : 0;
  const fetched = await fetchJiraReportPage(http, session.plan, {
    jql: session.jql,
    startAt: session.startAt - overlap,
    maxResults: session.pageSize,
  });
  if (fetched.kind === "moved") {
    finish(session, deps, "scope-changed");
    return;
  }
  if (fetched.kind === "failed") {
    onPageFailure(session, deps, fetched.reason);
    return;
  }
  const page = readPage(fetched.body, session.startAt - overlap);
  if (page !== undefined) await onPageRead(session, deps, page, overlap, admission);
  else {
    // Jira answered, but without coherent pagination: fewer issues per page cannot repair that.
    session.failure = "malformed-payload";
    finish(session, deps, "read-failed");
  }
}

async function pump(session: JiraReportSession, admission: PageAdmission): Promise<void> {
  if (session.phase !== "reading" || !sliceAvailable(admission)) return;
  const before = session.transientFailures;
  await readNextPage(session, admission);
  // A transient failure ends this slice; the next call of the tool resumes at the same offset.
  if (session.transientFailures > before) return;
  await pump(session, admission);
}

/** Read Jira until the scope is complete or the slice ends; the session carries the progress. */
export async function advanceJiraReportSession(
  session: JiraReportSession,
  deps: JiraReportReadDeps,
): Promise<void> {
  const deadline = deps.now() + deps.sliceMs;
  const signal = AbortSignal.any([
    deps.signal,
    AbortSignal.timeout(Math.max(1, Math.ceil(deps.sliceMs))),
  ]);
  const http = createJiraReportHttp(deps, {
    signal,
    beforeEffect: () => deps.now() < deadline && deps.beforeEffect(),
  });
  if (session.phase === "new") await initialize(session, deps, http);
  await pump(session, { http, deps, deadline, signal });
}
