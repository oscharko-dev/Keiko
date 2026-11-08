import { describe, expect, it } from "vitest";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { AtlassianHttpBodyPort, AtlassianHttpBodyResult } from "./atlassian-http-port.js";
import type { ManagedMcpToolResult } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import type { JiraReport } from "./jira-report-types.js";
import { POINTS, fixtureJira, response, syntheticProject } from "./jira-report.fixture.js";
import { CONNECTION, CONTEXT, NOW, idOf, record, reportOf } from "./jira-report.harness.js";
import { createJiraReportStore } from "./jira-report-store.js";
import { executeJiraReportTool, type JiraReportActivity } from "./jira-report-tool.js";
import { exportJiraReport, jiraReportCommentText } from "./jira-report-export.js";

const CONFIG = {
  estimation: { type: "field", field: { fieldId: POINTS, displayName: "Story Points" } },
};
const SCREEN_FIELD = {
  fieldId: POINTS,
  name: "Story Points",
  schema: { type: "number" },
  required: false,
};
interface Options {
  readonly boards?: readonly unknown[];
  readonly configurations?: Readonly<Record<string, unknown>>;
  readonly screenFields?: readonly unknown[];
  readonly boardStatus?: number;
  readonly pageSize?: number;
}
function boardPage(url: URL, options: Options): AtlassianHttpBodyResult {
  if (url.searchParams.get("projectKeyOrId") !== "REP") return { ...response({}), status: 404 };
  if (options.boardStatus !== undefined) return { ...response({}), status: options.boardStatus };
  const boards = options.boards ?? [{ id: 7 }];
  const startAt = Number(url.searchParams.get("startAt"));
  const values = boards.slice(startAt, startAt + (options.pageSize ?? 50));
  return response({ startAt, isLast: startAt + values.length === boards.length, values });
}
function transport(
  base: AtlassianHttpBodyPort,
  options: Options,
  requests: string[],
): AtlassianHttpBodyPort {
  return async (request) => {
    requests.push(`${request.method} ${request.url}`);
    const url = new URL(request.url);
    if (url.pathname.endsWith("/agile/1.0/board")) return boardPage(url, options);
    const board = /\/board\/(\d+)\/configuration$/u.exec(url.pathname)?.[1];
    if (board !== undefined) return response(options.configurations?.[board] ?? CONFIG);
    const answer = await base(request);
    if (
      url.pathname.includes("/createmeta/REP/issuetypes/") &&
      answer.kind === "response" &&
      answer.status === 200
    ) {
      const body = JSON.parse(answer.bodyText) as { values: unknown[] };
      const values = [...body.values, ...(options.screenFields ?? [])];
      return response({ values, isLast: true, total: values.length });
    }
    return answer;
  };
}
interface ReportRun {
  readonly result: ManagedMcpToolResult;
  readonly report: Record<string, unknown>;
  readonly stored: JiraReport | undefined;
  readonly activity: readonly JiraReportActivity[];
  readonly requests: readonly string[];
  readonly call: (args: CatalogJsonObject) => Promise<ManagedMcpToolResult>;
}
async function run(
  options: Options = {},
  args: CatalogJsonObject = { projectKey: "REP" },
): Promise<ReportRun> {
  const points = [3, 5, 8];
  const fixture = fixtureJira({
    issues: syntheticProject(4).map((issue, index) => ({
      ...issue,
      ...(points[index] === undefined ? {} : { points: points[index] }),
    })),
  });
  const store = createJiraReportStore({ now: () => NOW });
  const activity: JiraReportActivity[] = [];
  const requests: string[] = [];
  const connection = { ...CONNECTION(fixture), http: transport(fixture.http, options, requests) };
  const call = (input: CatalogJsonObject): Promise<ManagedMcpToolResult> =>
    executeJiraReportTool(input, CONTEXT, connection, {
      store,
      owner: () => "chat-1",
      now: () => NOW,
      sleep: () => Promise.resolve(),
      activity: (item) => activity.push(item),
    });
  const result = await call(args);
  const stored = store.peek(idOf(result), "chat-1")?.report;
  return { result, report: reportOf(result), stored, activity, requests, call };
}

describe("project estimate discovery (#4321 C4)", () => {
  it("uses the board's Story Points field without an explicit estimateFieldId", async () => {
    const h = await run();
    expect(h.result.data.status).toBe("complete");
    expect(record(record(h.report.progress).project).estimate).toEqual({
      total: 16,
      done: 8,
      remaining: 8,
      unestimated: 1,
    });
    expect(h.report.scope).toMatchObject({
      estimateFieldId: POINTS,
      estimateFieldName: "Story Points",
      estimateSource: "board-configuration",
      estimateUnit: "custom-field",
    });
    expect(h.stored?.scope.estimateFieldId).toBe(POINTS);
    expect(h.activity).toEqual([
      expect.objectContaining({ estimateSource: "board-configuration" }),
    ]);
    expect(JSON.stringify(h.activity)).not.toMatch(/Story Points|customfield_|REP|jira\.example/u);
    const repeated = await h.call({ reportId: idOf(h.result) });
    expect(reportOf(repeated)).toEqual(h.report);
    expect(h.requests.filter((request) => request.includes("/board?"))).toHaveLength(1);
  });

  it("prefers board configuration to a different Story Points field on the screens", async () => {
    const h = await run({ screenFields: [{ ...SCREEN_FIELD, fieldId: "customfield_10999" }] });
    expect(h.report.scope).toMatchObject({
      estimateFieldId: POINTS,
      estimateSource: "board-configuration",
    });
  });

  it.each([undefined, 403, 404])(
    "uses a numeric Story Points field on project screens when boards are absent or unreadable (%s)",
    async (boardStatus) => {
      const h = await run({
        boards: [],
        screenFields: [SCREEN_FIELD],
        ...(boardStatus === undefined ? {} : { boardStatus }),
      });
      expect(h.result.data.status).toBe("complete");
      expect(h.report.scope).toMatchObject({
        estimateFieldId: POINTS,
        estimateSource: "project-screen",
      });
      expect(record(record(h.report.progress).project).estimate).toEqual({
        total: 16,
        done: 8,
        remaining: 8,
        unestimated: 1,
      });
    },
  );

  it("pages every project board before accepting a unique field", async () => {
    const h = await run({ boards: [{ id: 7 }, { id: 8 }], pageSize: 1 });
    expect(h.report.scope).toMatchObject({
      estimateFieldId: POINTS,
      estimateSource: "board-configuration",
    });
    expect(h.requests.filter((request) => request.includes("/board?"))).toHaveLength(2);
  });

  it.each([
    { boards: [] },
    { boards: [], screenFields: [{ ...SCREEN_FIELD, schema: { type: "string" } }] },
    { configurations: { "7": { estimation: { type: "issueCount" } } } },
  ])(
    "never turns a globally named field or an issue-count board into a project estimate (%j)",
    async (options) => {
      const h = await run(options);
      expect(h.result.data.status).toBe("complete");
      expect(h.report.scope).toMatchObject({
        estimateSource: "unavailable",
        estimateUnit: "unavailable",
        estimateUnavailableReason: "field-not-found",
      });
      expect(record(record(h.report.progress).project).estimate).toBeNull();
      expect(h.report.figures).toContain("Estimate: unavailable");
      expect(h.report.figures).not.toContain("Issues without an estimate:");
      if (h.stored === undefined) throw new Error("Missing fixture report");
      expect(exportJiraReport(h.stored, "markdown").content).toContain("Estimate: unavailable");
      expect(exportJiraReport(h.stored, "csv").content).toContain("estimateUnit=unavailable");
      expect(jiraReportCommentText(h.stored)).toContain("Estimate: unavailable");
      expect(h.requests.filter((request) => request.includes("/search?"))).toHaveLength(1);
      expect(h.requests.find((request) => request.includes("/search?"))).not.toMatch(
        /timeoriginalestimate|customfield_10200/u,
      );
    },
  );

  it("does not select arbitrarily between conflicting boards", async () => {
    const h = await run({
      boards: [{ id: 7 }, { id: 8 }],
      configurations: {
        "8": { estimation: { type: "field", field: { fieldId: "timeoriginalestimate" } } },
      },
      screenFields: [SCREEN_FIELD],
    });
    expect(h.report.scope).toMatchObject({ estimateUnavailableReason: "ambiguous-field" });
    expect(record(record(h.report.progress).project).estimate).toBeNull();
  });

  it.each([{}, { id: "../7" }, { id: -1 }, { id: 1.5 }])(
    "never dispatches a configuration request for malformed board identity %j",
    async (board) => {
      const h = await run({ boards: [board] });
      expect(h.report.scope).toMatchObject({ estimateUnavailableReason: "metadata-unavailable" });
      expect(h.requests.some((request) => request.endsWith("/configuration"))).toBe(false);
      expect(record(record(h.report.progress).project).estimate).toBeNull();
    },
  );

  it.each(["../private", "", 42])(
    "refuses an invalid configured estimate field %j",
    async (fieldId) => {
      const h = await run({
        configurations: { "7": { estimation: { type: "field", field: { fieldId } } } },
      });
      expect(h.report.scope).toMatchObject({ estimateUnavailableReason: "metadata-unavailable" });
      expect(record(record(h.report.progress).project).estimate).toBeNull();
    },
  );

  it("does not select arbitrarily between different project-screen fields", async () => {
    const h = await run({
      boards: [],
      screenFields: [SCREEN_FIELD, { ...SCREEN_FIELD, fieldId: "customfield_10999" }],
    });
    expect(h.report.scope).toMatchObject({ estimateUnavailableReason: "ambiguous-field" });
  });

  it("keeps a partially read board configuration unavailable instead of overriding it with screen metadata", async () => {
    const h = await run({
      boards: [{ id: 7 }, { id: 8 }],
      screenFields: [SCREEN_FIELD],
      configurations: { "8": { estimation: { type: "field", field: { fieldId: "../private" } } } },
    });
    expect(h.report.scope).toMatchObject({
      estimateSource: "unavailable",
      estimateUnavailableReason: "metadata-unavailable",
    });
    expect(record(record(h.report.progress).project).estimate).toBeNull();
  });

  it.each([403, 500])(
    "discloses unreadable board metadata when no screen fallback exists (%s)",
    async (boardStatus) => {
      const h = await run({ boardStatus });
      expect(h.report.scope).toMatchObject({
        estimateSource: "unavailable",
        estimateUnavailableReason: "metadata-unavailable",
      });
      expect(h.activity[0]).toMatchObject({
        estimateSource: "unavailable",
        estimateUnavailableReason: "metadata-unavailable",
      });
    },
  );

  it("requires a project or an explicit field for a JQL-only report", async () => {
    const h = await run({}, { jql: "project = REP" });
    expect(h.report.scope).toMatchObject({ estimateUnavailableReason: "project-not-specified" });
    expect(record(record(h.report.progress).project).estimate).toBeNull();
    expect(h.requests.some((request) => request.includes("/agile/"))).toBe(false);
  });

  it("honors an explicit field without board requests and keeps an observed null distinct from unavailable", async () => {
    const h = await run({}, { projectKey: "REP", estimateFieldId: "timeoriginalestimate" });
    expect(h.report.scope).toMatchObject({
      estimateFieldId: "timeoriginalestimate",
      estimateUnit: "seconds",
      estimateSource: "explicit-field",
    });
    expect(record(record(h.report.progress).project).estimate).toEqual({
      total: 0,
      done: 0,
      remaining: 0,
      unestimated: 4,
    });
    expect(h.requests.some((request) => request.includes("/agile/"))).toBe(false);
  });
});
