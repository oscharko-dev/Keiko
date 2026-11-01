import { describe, expect, it } from "vitest";
import { analyzeLogText } from "@oscharko-dev/keiko-activity-log/reader";
import { createJiraReportStore, type JiraReportStore } from "@oscharko-dev/keiko-connectors";
import type { JiraReportExportResponse } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import type { UiHandlerDeps } from "../deps.js";
import type { RouteContext } from "../routes.js";
import { matchRoute } from "../routes.js";
import { exportJiraReportRoute } from "./jiraReportRoutes.js";
import { recordJiraReportActivity } from "./jiraReportActivity.js";

const REPORT_ID = "11111111-2222-4333-8444-555555555555";
const DIGEST = "d".repeat(64);

function seeded(): JiraReportStore {
  const store = createJiraReportStore({ newId: () => REPORT_ID });
  const session = store.start("chat-1", {
    projectKey: "REP",
    jql: undefined,
    estimateFieldId: undefined,
    asOf: undefined,
    parentFieldIds: [],
    requirementIds: [],
  });
  session.report = {
    digest: DIGEST,
    generatedAt: "2026-10-31T12:00:00.000Z",
    scope: {
      projectKey: "REP",
      jql: "",
      estimateUnit: "seconds",
      asOf: "2026-10-31",
      timeZone: "UTC",
    },
    completeness: { complete: true, issuesRead: 1, issuesTotal: 1, pageCount: 1 },
    hierarchy: {
      discovery: "complete",
      fieldCount: 1,
      observedFieldCount: 1,
      rejectedFieldCount: 0,
    },
    progress: {
      project: {
        total: 1,
        new: 1,
        indeterminate: 0,
        done: 0,
        noCategory: 0,
        donePercent: 0,
        estimate: { total: 0, done: 0, remaining: 0, unestimated: 1 },
      },
      byType: [{ typeName: "Task", total: 1, done: 0 }],
      byStatus: [{ typeName: "Task", statusName: "Open", category: "new", total: 1 }],
      unassigned: 1,
      overdue: 0,
    },
    epics: [],
    compliance: {
      requiredFieldRules: "applied",
      checker: "none",
      issuesChecked: 1,
      issuesWithDeviations: 0,
      deviationCount: 0,
      byRule: [],
      deviations: [],
    },
    coverage: { uncoveredEpics: [], orphans: ["REP-1"], requirements: undefined },
    rows: [
      {
        issue: {
          key: "REP-1",
          typeName: "Task",
          subtask: false,
          summary: "Only task",
          statusName: "Open",
          category: "new",
          parentKey: undefined,
          linkedKeys: [],
          assigned: false,
          dueDate: undefined,
          estimate: undefined,
          deviations: [],
          requirementIds: [],
          labels: [],
        },
        classification: "orphan",
        containerKeys: [],
        overdue: false,
      },
    ],
  };
  session.phase = "finished";
  return store;
}
function context(query: string, reportId = REPORT_ID): RouteContext {
  return {
    req: {} as RouteContext["req"],
    res: {} as RouteContext["res"],
    params: { reportId },
    url: new URL(
      `http://127.0.0.1/api/atlassian-connectors/jira-reports/${reportId}/export?${query}`,
    ),
    correlationId: "correlation-1",
  };
}
function deps(
  store: JiraReportStore | undefined,
  logs = createBufferedServerLogSink(),
): UiHandlerDeps {
  return { jiraReportStore: store, activityLog: logs } as unknown as UiHandlerDeps;
}
function onlyLine(logs: ReturnType<typeof createBufferedServerLogSink>): string {
  const [event] = logs.events;
  if (event === undefined) throw new Error("Missing activity event");
  return formatActivityLogProofLine(event);
}

describe("Jira report export route", () => {
  it("is mounted on the documented path", () => {
    const match = matchRoute("GET", `/api/atlassian-connectors/jira-reports/${REPORT_ID}/export`);
    expect(match).toMatchObject({ params: { reportId: REPORT_ID } });
    expect(match).not.toBe("method-not-allowed");
  });

  it.each([
    ["markdown", "text/markdown", ".md"],
    ["csv", "text/csv", ".csv"],
  ] as const)("serves the stored report as %s", (format, mediaType, extension) => {
    const logs = createBufferedServerLogSink();
    const result = exportJiraReportRoute(
      context(`chatId=chat-1&format=${format}`),
      deps(seeded(), logs),
    );
    expect(result.status).toBe(200);
    expect(result.headers).toEqual({ "Cache-Control": "no-store" });
    const body = result.body as JiraReportExportResponse;
    expect(body).toMatchObject({ format, mediaType, reportDigest: DIGEST });
    expect(body.fileName.endsWith(extension)).toBe(true);
    expect(body.content).toContain("REP-1");
    const line = onlyLine(logs);
    expect(expectActivityLogProof("atlassian.jira-report.line", line)).toMatchObject({
      op: "atlassian.jira-report",
      phase: "export",
      format,
      byteCount: body.byteCount,
    });
    expect(line).not.toContain("REP-1");
    expect(line).not.toContain("Only task");
    expect(analyzeLogText(line).timelines).toHaveLength(1);
  });

  it.each([
    ["another Chat", "chatId=chat-2&format=csv", 404, "export-unavailable"],
    ["an unknown report format", "chatId=chat-1&format=pdf", 400, "invalid-format"],
    ["a missing Chat", "format=csv", 400, "invalid-format"],
  ] as const)("refuses %s with a logged, closed reason", (_name, query, status, refusal) => {
    const logs = createBufferedServerLogSink();
    const result = exportJiraReportRoute(context(query), deps(seeded(), logs));
    expect(result.status).toBe(status);
    expect(expectActivityLogProof("atlassian.jira-report.line", onlyLine(logs))).toMatchObject({
      phase: "export",
      level: "warn",
      refusal,
    });
  });

  it("refuses when no store exists or the report id is malformed", () => {
    expect(exportJiraReportRoute(context("chatId=chat-1&format=csv"), deps(undefined)).status).toBe(
      404,
    );
    expect(
      exportJiraReportRoute(context("chatId=chat-1&format=csv", "../x"), deps(seeded())).status,
    ).toBe(400);
  });
});

describe("Jira report activity", () => {
  it("reconstructs a read from counts and rule ids alone", () => {
    const logs = createBufferedServerLogSink();
    recordJiraReportActivity(logs, "correlation-2", {
      phase: "read",
      status: "incomplete",
      reason: "read-failed",
      failure: "permission",
      scopeKind: "project-jql",
      continued: true,
      issuesRead: 250,
      issuesTotal: 253,
      pageCount: 3,
      issuesWithDeviations: 2,
      deviationCount: 3,
      ruleIds: ["required-field-empty", "template.bug.reproduction"],
      requirementCount: 4,
      durationMs: 12,
    });
    const line = onlyLine(logs);
    expect(expectActivityLogProof("atlassian.jira-report.line", line)).toMatchObject({
      phase: "read",
      status: "incomplete",
      reason: "read-failed",
      failure: "permission",
      level: "warn",
      errorKind: "read-failed",
      issuesRead: 250,
      ruleIds: ["required-field-empty", "template.bug.reproduction"],
    });
    expect(analyzeLogText(line).timelines).toHaveLength(1);
  });

  it("records how the parent relation was found as counts and one closed word", () => {
    const logs = createBufferedServerLogSink();
    recordJiraReportActivity(logs, "correlation-4", {
      phase: "read",
      status: "complete",
      scopeKind: "project",
      continued: false,
      issuesRead: 10,
      pageCount: 1,
      issuesWithDeviations: 0,
      deviationCount: 0,
      ruleIds: [],
      requirementCount: 0,
      hierarchy: {
        discovery: "complete",
        fieldCount: 3,
        observedFieldCount: 1,
        rejectedFieldCount: 2,
      },
      durationMs: 2,
    });
    expect(expectActivityLogProof("atlassian.jira-report.line", onlyLine(logs))).toMatchObject({
      hierarchyDiscovery: "complete",
      hierarchyFieldCount: 3,
      hierarchyObservedFieldCount: 1,
      hierarchyRejectedFieldCount: 2,
    });
  });

  it("records how many arguments a refused call named wrongly, never the names (#4181)", () => {
    const logs = createBufferedServerLogSink();
    recordJiraReportActivity(logs, "correlation-3", {
      phase: "refused",
      refusal: "invalid-input",
      invalidArgumentCount: 2,
      scopeKind: "report",
      continued: false,
      issuesRead: 0,
      pageCount: 0,
      issuesWithDeviations: 0,
      deviationCount: 0,
      ruleIds: [],
      requirementCount: 0,
      durationMs: 1,
    });
    const line = onlyLine(logs);
    expect(expectActivityLogProof("atlassian.jira-report.line", line)).toMatchObject({
      phase: "refused",
      refusal: "invalid-input",
      errorKind: "invalid-request",
      invalidArgumentCount: 2,
    });
  });

  it("records a refusal to list the Chat's requirements as unavailable, without any identifier (#4181)", () => {
    const logs = createBufferedServerLogSink();
    recordJiraReportActivity(logs, "correlation-4", {
      phase: "refused",
      refusal: "requirements-unavailable",
      scopeKind: "report",
      continued: false,
      issuesRead: 0,
      pageCount: 0,
      issuesWithDeviations: 0,
      deviationCount: 0,
      ruleIds: [],
      requirementCount: 0,
      durationMs: 1,
    });
    expect(expectActivityLogProof("atlassian.jira-report.line", onlyLine(logs))).toMatchObject({
      phase: "refused",
      refusal: "requirements-unavailable",
      errorKind: "unavailable",
      level: "warn",
    });
  });
});
