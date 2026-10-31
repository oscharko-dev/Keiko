import {
  JIRA_REPORT_READ_SLICE_MS,
  type JiraReportIncompleteReason,
  type JiraReportStatus,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type {
  ManagedMcpInvocationContext,
  ManagedMcpToolResult,
} from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { parseJiraReportArgs, type JiraReportArgs } from "./jira-report-args.js";
import {
  JIRA_REPORT_EXPORTS_VIEW,
  jiraReportProgressView,
  jiraReportSectionPage,
  jiraReportState,
  jiraReportSummary,
} from "./jira-report-result.js";
import {
  advanceJiraReportSession,
  type JiraReportReadDeps,
  type JiraReportSession,
} from "./jira-report-session.js";
import { JIRA_REPORT_STORE_MAX_BYTES, type JiraReportStore } from "./jira-report-store.js";
import { createJiraReportTemplateChecker } from "./jira-report-template-checker.js";
import type { JiraReportCheckerPort } from "./jira-report-types.js";
import { jiraReadFailure } from "./jira-managed-metadata.js";
import type { JiraManagedConnection } from "./jira-managed-connection.js";

export type JiraReportRefusal =
  "invalid-input" | "unsupported-deployment" | "report-not-found" | "report-busy";

/** Body-free facts about one call of the tool; the composing server maps them to its log. */
export interface JiraReportActivity {
  readonly phase: "read" | "section" | "refused";
  readonly status?: JiraReportStatus;
  readonly reason?: JiraReportIncompleteReason;
  readonly refusal?: JiraReportRefusal;
  readonly scopeKind: "project" | "jql" | "project-jql" | "report";
  readonly continued: boolean;
  readonly issuesRead: number;
  readonly issuesTotal?: number;
  readonly pageCount: number;
  readonly issuesWithDeviations: number;
  readonly deviationCount: number;
  readonly ruleIds: readonly string[];
  readonly requirementCount: number;
  readonly durationMs: number;
}

export interface JiraReportToolDeps<Context extends ManagedMcpInvocationContext> {
  readonly store: JiraReportStore;
  /** Binds a report to the Chat and authority that started it. */
  readonly owner: (context: Context) => string;
  /** An explicit checker wins; otherwise the connection's template source feeds the check. */
  readonly checker?: JiraReportCheckerPort | undefined;
  readonly activity?: ((activity: JiraReportActivity, context: Context) => void) | undefined;
  readonly now?: (() => number) | undefined;
  readonly sliceMs?: number | undefined;
  readonly memoryBudgetBytes?: number | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

function scopeKind(session: JiraReportSession): JiraReportActivity["scopeKind"] {
  const { projectKey, jql } = session.request;
  if (projectKey !== undefined && jql !== undefined) return "project-jql";
  return projectKey === undefined ? "jql" : "project";
}
function totalOf(session: JiraReportSession): number | undefined {
  return session.report?.completeness.issuesTotal ?? session.total;
}
function optionalActivity(session: JiraReportSession): Partial<JiraReportActivity> {
  const total = totalOf(session);
  return {
    ...(session.incomplete === undefined ? {} : { reason: session.incomplete }),
    ...(total === undefined ? {} : { issuesTotal: total }),
  };
}
function sessionActivity(
  session: JiraReportSession,
  base: Pick<JiraReportActivity, "phase" | "continued" | "durationMs">,
): JiraReportActivity {
  const compliance = session.report?.compliance;
  return {
    ...base,
    ...optionalActivity(session),
    status: jiraReportState(session),
    scopeKind: scopeKind(session),
    issuesRead: session.report?.completeness.issuesRead ?? session.issues.size,
    pageCount: session.pageCount,
    issuesWithDeviations: compliance?.issuesWithDeviations ?? 0,
    deviationCount: compliance?.deviationCount ?? 0,
    ruleIds: compliance?.byRule.map((item) => item.ruleId) ?? [],
    requirementCount: session.request.requirementIds.length,
  };
}
function refuse<Context extends ManagedMcpInvocationContext>(
  deps: JiraReportToolDeps<Context>,
  context: Context,
  refusal: JiraReportRefusal,
  startedAt: number,
): ManagedMcpToolResult {
  deps.activity?.(
    {
      phase: "refused",
      refusal,
      scopeKind: "report",
      continued: false,
      issuesRead: 0,
      pageCount: 0,
      issuesWithDeviations: 0,
      deviationCount: 0,
      ruleIds: [],
      requirementCount: 0,
      durationMs: (deps.now ?? Date.now)() - startedAt,
    },
    context,
  );
  return jiraReadFailure(refusal);
}

function readView(session: JiraReportSession, elapsedMs: number): ManagedMcpToolResult {
  const status = jiraReportState(session);
  const data: Record<string, CatalogJsonObject[keyof CatalogJsonObject]> = {
    outcome: "succeeded",
    status,
    reportId: session.id,
    progress: jiraReportProgressView(session, elapsedMs),
    exports: [...JIRA_REPORT_EXPORTS_VIEW],
  };
  if (session.report !== undefined) data.report = jiraReportSummary(session.report);
  if (status === "reading") {
    data.nextStartAt = session.startAt;
    if (session.failureReason !== undefined) data.lastFailure = session.failureReason;
  }
  return { data };
}
function sectionView(
  session: JiraReportSession,
  args: Extract<JiraReportArgs, { kind: "continue" }>,
): ManagedMcpToolResult {
  const { report } = session;
  if (report === undefined) return readView(session, 0);
  const section = jiraReportSectionPage(report, args.section, args.startAt, args.maxResults);
  return {
    data: {
      outcome: "succeeded",
      status: jiraReportState(session),
      reportId: session.id,
      section,
      ...(typeof section.nextStartAt === "number" ? { nextStartAt: section.nextStartAt } : {}),
    },
  };
}

async function advance<Context extends ManagedMcpInvocationContext>(
  session: JiraReportSession,
  context: Context,
  connection: JiraManagedConnection,
  deps: JiraReportToolDeps<Context>,
  now: () => number,
): Promise<void> {
  const readDeps: JiraReportReadDeps = {
    baseUrl: connection.baseUrl,
    http: connection.http,
    signal: context.signal,
    beforeEffect: context.beforeEffect,
    now,
    sliceMs: deps.sliceMs ?? JIRA_REPORT_READ_SLICE_MS,
    memoryBudgetBytes: deps.memoryBudgetBytes ?? JIRA_REPORT_STORE_MAX_BYTES,
    checker:
      deps.checker ??
      (connection.issueTemplates === undefined
        ? undefined
        : createJiraReportTemplateChecker(connection.issueTemplates)),
    sleep: deps.sleep,
  };
  session.busy = true;
  try {
    if (session.phase !== "finished") await advanceJiraReportSession(session, readDeps);
  } finally {
    session.busy = false;
    session.lastUsedAt = now();
    deps.store.settle();
  }
}

async function runSession<Context extends ManagedMcpInvocationContext>(
  session: JiraReportSession,
  args: JiraReportArgs,
  context: Context,
  connection: JiraManagedConnection,
  deps: JiraReportToolDeps<Context>,
): Promise<ManagedMcpToolResult> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  await advance(session, context, connection, deps, now);
  const section =
    args.kind === "continue" && args.section !== "summary" && session.report !== undefined;
  deps.activity?.(
    sessionActivity(session, {
      phase: section ? "section" : "read",
      continued: args.kind === "continue",
      durationMs: now() - startedAt,
    }),
    context,
  );
  return args.kind === "continue" && section
    ? sectionView(session, args)
    : readView(session, now() - session.startedAt);
}

/** `jira.report`: start a report, resume one that is still reading, or page a finished one. */
export async function executeJiraReportTool<Context extends ManagedMcpInvocationContext>(
  rawArgs: CatalogJsonObject,
  context: Context,
  connection: JiraManagedConnection,
  deps: JiraReportToolDeps<Context>,
): Promise<ManagedMcpToolResult> {
  const startedAt = (deps.now ?? Date.now)();
  const args = parseJiraReportArgs(rawArgs);
  if (args === undefined) return refuse(deps, context, "invalid-input", startedAt);
  if (connection.deployment !== "data-center")
    return refuse(deps, context, "unsupported-deployment", startedAt);
  const owner = deps.owner(context);
  const session =
    args.kind === "new"
      ? deps.store.start(owner, args.request)
      : deps.store.get(args.reportId, owner);
  if (session === undefined) return refuse(deps, context, "report-not-found", startedAt);
  if (session.busy) return refuse(deps, context, "report-busy", startedAt);
  return runSession(session, args, context, connection, deps);
}
