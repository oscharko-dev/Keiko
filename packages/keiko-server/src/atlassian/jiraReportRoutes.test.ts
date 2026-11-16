import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeLogText } from "@oscharko-dev/keiko-activity-log/reader";
import {
  createJiraReportStore,
  exportJiraReport,
  type JiraReportStore,
} from "@oscharko-dev/keiko-connectors";
import { createInMemoryUiStore, createNodeUiStore } from "../store/index.js";
import {
  JIRA_REPORT_IDLE_TTL_MS,
  type JiraReportExportResponse,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
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
import { retainJiraReportExports } from "./jiraReportPersistence.js";

const REPORT_ID = "11111111-2222-4333-8444-555555555555";
const DIGEST = "d".repeat(64);

function seeded(owner = "chat-1", now = Date.now): JiraReportStore {
  const store = createJiraReportStore({ newId: () => REPORT_ID, now });
  const session = store.start(owner, {
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
      inferredFieldCount: 0,
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
      byType: [{ typeName: "Task", total: 1, done: 0, estimated: 0, unestimated: 1 }],
      byStatus: [{ typeName: "Task", statusName: "Open", category: "new", total: 1 }],
      unassigned: 1,
      overdue: 0,
    },
    epics: [],
    compliance: {
      requiredFieldRules: "applied",
      checker: "none",
      issuesChecked: 1,
      issuesJudged: 1,
      issuesWithoutTemplate: 1,
      withoutTemplateByType: [{ typeName: "Task", count: 1 }],
      issuesWithDeviations: 0,
      deviationCount: 0,
      byRule: [],
      deviations: [],
    },
    coverage: {
      containerRoles: "unobserved",
      uncoveredEpics: [],
      orphans: ["REP-1"],
      requirements: undefined,
    },
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
          templateJudged: false,
          requiredJudged: false,
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
  return {
    jiraReportStore: store,
    activityLog: logs,
    store: { findChatById: (id: string) => ({ id }) },
  } as unknown as UiHandlerDeps;
}
function onlyLine(logs: ReturnType<typeof createBufferedServerLogSink>): string {
  const [event] = logs.events;
  if (event === undefined) throw new Error("Missing activity event");
  return formatActivityLogProofLine(event);
}

describe("Jira report export route", () => {
  it("records a failed retention attempt before continuing the remaining reports", () => {
    const store = createInMemoryUiStore();
    try {
      const project = store.createProject(process.cwd());
      const chat = store.createChat(project.path, "Report fixture", "synthetic");
      const reports = seeded(chat.id);
      const first = reports.finished(chat.id)[0];
      const port = store.jiraReportExports;
      if (first === undefined || port === undefined)
        throw new TypeError("Missing retention fixture");
      vi.spyOn(reports, "finished").mockReturnValue([
        first,
        { ...first, id: "22222222-2222-4333-8444-555555555555" },
      ]);
      const logs = createBufferedServerLogSink();
      const beforeContinuation: unknown[] = [];
      vi.spyOn(port, "touch")
        .mockImplementationOnce(() => {
          throw new Error("SYN-99 private-report-body");
        })
        .mockImplementationOnce(() => {
          beforeContinuation.push(...logs.events);
          return false;
        });
      retainJiraReportExports({ store, activityLog: logs }, reports, chat.id, "retention-fixture");
      expect(beforeContinuation).toHaveLength(1);
      expect(beforeContinuation[0]).toMatchObject({
        op: "atlassian.jira-report",
        level: "warn",
        correlationId: "retention-fixture",
        extra: { phase: "retain", refusal: "export-unavailable" },
      });
      expect(logs.events.at(-1)).toMatchObject({
        extra: { phase: "retain", retainedReportCount: 1, refusal: "export-unavailable" },
      });
      for (const event of logs.events)
        expectActivityLogProof("atlassian.jira-report.line", formatActivityLogProofLine(event));
      expect(JSON.stringify(logs.events)).not.toMatch(
        /SYN-99|private-report-body|Only task|REP-1/u,
      );
    } finally {
      store.close();
    }
  });

  it("retains finished exports once and records retention failures without report text (#4390)", () => {
    const store = createInMemoryUiStore();
    try {
      const project = store.createProject(process.cwd());
      const chat = store.createChat(project.path, "Report fixture", "synthetic");
      const reports = seeded(chat.id);
      const port = store.jiraReportExports;
      if (port === undefined) throw new TypeError("Missing export port");
      const put = vi.spyOn(port, "put");
      const logs = createBufferedServerLogSink();
      retainJiraReportExports({ store, activityLog: logs }, reports, chat.id, "retention-fixture");
      retainJiraReportExports({ store, activityLog: logs }, reports, chat.id, "retention-fixture");
      expect(put).toHaveBeenCalledTimes(1);
      expect(logs.events.at(-1)).toMatchObject({
        op: "atlassian.jira-report",
        extra: { phase: "retain", retainedReportCount: 1 },
      });
      vi.spyOn(port, "touch").mockImplementation(() => {
        throw new Error("SYN-99 private-report-body");
      });
      retainJiraReportExports({ store, activityLog: logs }, reports, chat.id, "retention-fixture");
      expect(logs.events.at(-1)).toMatchObject({
        extra: { phase: "retain", retainedReportCount: 0, refusal: "export-unavailable" },
        level: "warn",
      });
      const line = formatActivityLogProofLine(logs.events.at(-1) ?? {});
      expectActivityLogProof("atlassian.jira-report.line", line);
      expect(JSON.stringify(logs.events)).not.toMatch(
        /SYN-99|private-report-body|Only task|REP-1/u,
      );
    } finally {
      vi.restoreAllMocks();
      store.close();
    }
  });

  it.each(["markdown", "csv"] as const)(
    "keeps an unexpired %s download after closing and reopening the UI database (#4390)",
    (format) => {
      const root = mkdtempSync(join(realpathSync(tmpdir()), "keiko-report-restart-"));
      const path = join(root, "ui.db");
      let now = Date.now();
      const options = { now: (): number => now };
      let store = createNodeUiStore(path, options);
      try {
        const project = store.createProject(root);
        const chat = store.createChat(project.path, "Report fixture", "synthetic");
        const reports = seeded(chat.id, options.now);
        const session = reports.peek(REPORT_ID, chat.id);
        if (session?.report === undefined) throw new TypeError("Missing report fixture");
        const expected = exportJiraReport(session.report, format);
        retainJiraReportExports({ store }, reports, chat.id, "restart-fixture");
        store.close();
        now += JIRA_REPORT_IDLE_TTL_MS - 1;
        store = createNodeUiStore(path, options);
        const result = exportJiraReportRoute(context(`chatId=${chat.id}&format=${format}`), {
          ...deps(createJiraReportStore()),
          store,
        });
        expect(result.status).toBe(200);
        expect(result.body).toEqual(expected);
        now += 2;
        expect(
          exportJiraReportRoute(context(`chatId=${chat.id}&format=${format}`), {
            ...deps(createJiraReportStore()),
            store,
          }).status,
        ).toBe(404);
        store.deleteChat(chat.id);
        expect(
          exportJiraReportRoute(context(`chatId=${chat.id}&format=${format}`), {
            ...deps(reports),
            store,
          }).status,
        ).toBe(404);
      } finally {
        store.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

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
  it.each([
    "explicit-field",
    "board-configuration",
    "project-screen",
    "time-tracking",
    "unavailable",
  ] as const)(
    "retains the closed estimate source %s through the registered writer and analyzer",
    (estimateSource) => {
      const logs = createBufferedServerLogSink();
      recordJiraReportActivity(logs, "correlation-estimate", {
        phase: "read",
        status: "complete",
        scopeKind: "project",
        continued: false,
        issuesRead: 4,
        issuesTotal: 4,
        pageCount: 1,
        issuesWithDeviations: 0,
        deviationCount: 0,
        ruleIds: [],
        requirementCount: 0,
        durationMs: 1,
        estimateSource,
        ...(estimateSource === "unavailable"
          ? { estimateUnavailableReason: "field-not-found" as const }
          : {}),
      });
      const line = onlyLine(logs);
      expect(expectActivityLogProof("atlassian.jira-report.line", line)).toMatchObject({
        op: "atlassian.jira-report",
        correlationId: "correlation-estimate",
        estimateSource,
        ...(estimateSource === "unavailable"
          ? { estimateUnavailableReason: "field-not-found" }
          : {}),
      });
      expect(analyzeLogText(line).timelines).toHaveLength(1);
      expect(line).not.toMatch(/Story Points|customfield_|timeoriginalestimate|REP-/u);
    },
  );

  it.each(["permission", "effect-denied", "cancelled"] as const)(
    "reconstructs %s from counts and closed codes alone",
    (failure) => {
      const logs = createBufferedServerLogSink();
      recordJiraReportActivity(logs, "correlation-2", {
        phase: "read",
        status: "incomplete",
        reason: "read-failed",
        failure,
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
        failure,
        level: "warn",
        errorKind: "read-failed",
        issuesRead: 250,
        ruleIds: ["required-field-empty", "template.bug.reproduction"],
      });
      expect(analyzeLogText(line).timelines).toHaveLength(1);
    },
  );

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
        inferredFieldCount: 1,
      },
      durationMs: 2,
    });
    expect(expectActivityLogProof("atlassian.jira-report.line", onlyLine(logs))).toMatchObject({
      hierarchyDiscovery: "complete",
      hierarchyFieldCount: 3,
      hierarchyObservedFieldCount: 1,
      hierarchyRejectedFieldCount: 2,
      hierarchyInferredFieldCount: 1,
    });
  });

  it("records the size of a section page and whether its byte budget cut it (S12 of #4173)", () => {
    const logs = createBufferedServerLogSink();
    recordJiraReportActivity(logs, "correlation-5", {
      phase: "section",
      status: "complete",
      scopeKind: "report",
      continued: true,
      issuesRead: 181,
      pageCount: 4,
      issuesWithDeviations: 0,
      deviationCount: 0,
      ruleIds: [],
      requirementCount: 41,
      sectionPage: { itemCount: 41, total: 41, byteFitted: false },
      durationMs: 3,
    });
    expect(expectActivityLogProof("atlassian.jira-report.line", onlyLine(logs))).toMatchObject({
      phase: "section",
      sectionItemCount: 41,
      sectionItemTotal: 41,
      sectionByteFitted: false,
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
