import { describe, expect, it } from "vitest";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { AtlassianHttpBodyPort, AtlassianHttpBodyResult } from "./atlassian-http-port.js";
import type { ManagedMcpToolResult } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import type { JiraReport } from "./jira-report-types.js";
import {
  POINTS,
  fixtureJira,
  response,
  syntheticProject,
  type FixtureIssue,
} from "./jira-report.fixture.js";
import {
  CONNECTION,
  CONTEXT,
  NOW,
  harness,
  idOf,
  record,
  reportOf,
} from "./jira-report.harness.js";
import { JIRA_STORY_POINTS_SCHEMA_KEY } from "./jira-report-estimate.js";
import { createJiraReportStore } from "./jira-report-store.js";
import { executeJiraReportTool, type JiraReportActivity } from "./jira-report-tool.js";
import { exportJiraReport, jiraReportCommentText } from "./jira-report-export.js";

const CONFIG = {
  estimation: { type: "field", field: { fieldId: POINTS, displayName: "Story Points" } },
};
const SCREEN_FIELD = {
  fieldId: POINTS,
  name: "Story Points",
  schema: { type: "number", custom: JIRA_STORY_POINTS_SCHEMA_KEY },
  required: false,
};
interface Options {
  readonly boards?: readonly unknown[];
  readonly configurations?: Readonly<Record<string, unknown>>;
  readonly screenFields?: readonly unknown[];
  readonly boardStatus?: number;
  readonly pageSize?: number;
  /** Replaces the default four-issue project with these issues (points as the fixture carries them). */
  readonly issues?: readonly FixtureIssue[];
  /** Issue type ids whose create screen and search hits do not carry the Story Points field. */
  readonly withoutEstimateTypes?: readonly string[];
  /**
   * Search hits of these issue types leave the estimate field out although their create screen
   * lists it, as Jira does for a field the account may not see.
   */
  readonly withheldEstimateTypes?: readonly string[];
  /** Hits at or after this issue number are the ones that withhold it (default: every hit). */
  readonly withheldFromIssue?: number;
}
const TYPE_ID: Readonly<Record<string, string>> = { Epic: "10", Story: "11", Bug: "12", "Sub-task": "13" };
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
    if (answer.kind !== "response" || answer.status !== 200) return answer;
    if (url.pathname.includes("/createmeta/REP/issuetypes/")) return createMetaOf(url, answer, options);
    if (url.pathname.endsWith("/search")) return searchOf(answer, options);
    return answer;
  };
}
function createMetaOf(
  url: URL,
  answer: Extract<AtlassianHttpBodyResult, { readonly kind: "response" }>,
  options: Options,
): AtlassianHttpBodyResult {
  const typeId = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
  const carries = !(options.withoutEstimateTypes ?? []).includes(typeId);
  const body = JSON.parse(answer.bodyText) as { values: unknown[] };
  const values = [
    ...body.values.filter((value) => record(value).fieldId !== "timetracking"),
    ...(carries ? (options.screenFields ?? [SCREEN_FIELD]) : []),
  ];
  return response({ values, isLast: true, total: values.length });
}
/** Jira omits a field its type does not have, and one the account may not see, from a hit. */
function searchOf(
  answer: Extract<AtlassianHttpBodyResult, { readonly kind: "response" }>,
  options: Options,
): AtlassianHttpBodyResult {
  const body = JSON.parse(answer.bodyText) as {
    issues: { key: string; fields: Record<string, unknown> }[];
  };
  for (const issue of body.issues) {
    const typeId = String(record(issue.fields.issuetype).id);
    const number = Number(String(issue.key).slice("REP-".length));
    if ((options.withoutEstimateTypes ?? []).includes(typeId)) delete issue.fields[POINTS];
    if (
      (options.withheldEstimateTypes ?? []).includes(typeId) &&
      number >= (options.withheldFromIssue ?? 0)
    )
      delete issue.fields[POINTS];
  }
  return response(body);
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
    issues:
      options.issues ??
      syntheticProject(4).map((issue, index) => ({
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
    const h = await run({
      screenFields: [SCREEN_FIELD, { ...SCREEN_FIELD, fieldId: "customfield_10999" }],
    });
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

  it("finds a localized Story Points field by its schema key and refuses a name-only match", async () => {
    const localized = await run({
      boards: [],
      screenFields: [{ ...SCREEN_FIELD, name: "Storypunkte" }],
    });
    expect(localized.report.scope).toMatchObject({
      estimateFieldId: POINTS,
      estimateFieldName: "Storypunkte",
      estimateSource: "project-screen",
    });
    for (const schema of [{ type: "number" }, { type: "number", custom: "x.y:float" }]) {
      const named = await run({ boards: [], screenFields: [{ ...SCREEN_FIELD, schema }] });
      expect(named.report.scope).toMatchObject({
        estimateSource: "unavailable",
        estimateUnavailableReason: "field-not-found",
      });
    }
  });

  it("pages every project board before accepting a unique field", async () => {
    const h = await run({ boards: [{ id: 7 }, { id: 8 }], pageSize: 1 });
    expect(h.report.scope).toMatchObject({
      estimateFieldId: POINTS,
      estimateSource: "board-configuration",
    });
    expect(h.requests.filter((request) => request.includes("/board?"))).toHaveLength(2);
  });

  it.each([
    { boards: [], screenFields: [] },
    { boards: [], screenFields: [{ ...SCREEN_FIELD, schema: { type: "string" } }] },
    { configurations: { "7": { estimation: { type: "issueCount" } } }, screenFields: [] },
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
      screenFields: [SCREEN_FIELD, { fieldId: "timetracking", name: "Time Tracking" }],
    });
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
  });

  it.each([{}, { id: "../7" }, { id: -1 }, { id: 1.5 }])(
    "never dispatches a configuration request for malformed board identity %j",
    async (board) => {
      const h = await run({ boards: [board], screenFields: [] });
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
        screenFields: [],
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

  it("falls back to independently read screen metadata when board configuration is incomplete", async () => {
    const h = await run({
      boards: [{ id: 7 }, { id: 8 }],
      screenFields: [SCREEN_FIELD],
      configurations: { "8": { estimation: { type: "field", field: { fieldId: "../private" } } } },
    });
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
  });

  it.each([403, 500])(
    "discloses unreadable board metadata when no screen fallback exists (%s)",
    async (boardStatus) => {
      const h = await run({ boardStatus, screenFields: [] });
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

  it("preserves dev time tracking for a JQL-only report", async () => {
    const h = await run({}, { jql: "project = REP" });
    expect(h.report.scope).toMatchObject({
      estimateFieldId: "timeoriginalestimate",
      estimateUnit: "seconds",
      estimateSource: "time-tracking",
    });
    expect(record(record(h.report.progress).project).estimate).toEqual({
      total: 0,
      done: 0,
      remaining: 0,
      unestimated: 4,
    });
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

describe("estimated and unestimated issues per issue type", () => {
  function typesOf(h: ReportRun): readonly Record<string, unknown>[] {
    const byType = record(h.report.progress).byType;
    if (!Array.isArray(byType)) throw new TypeError("The summary must carry byType");
    return byType.map((item) => record(item));
  }
  const sum = (items: readonly Record<string, unknown>[], key: string): number =>
    items.reduce((total, item) => total + Number(item[key]), 0);

  it("counts them per type from the same source as the project figure, and the counts add up", async () => {
    const h = await run();
    const types = typesOf(h);
    const estimate = record(record(h.report.progress).project).estimate;
    expect(types.length).toBeGreaterThan(0);
    expect(sum(types, "unestimated")).toBe(record(estimate).unestimated);
    expect(sum(types, "unestimated")).toBe(1);
    for (const item of types)
      expect(Number(item.estimated) + Number(item.unestimated)).toBe(item.total);
    expect(sum(types, "estimated")).toBe(3);
    expect(
      h.stored?.progress.byType.map(({ typeName, estimated }) => [typeName, estimated]),
    ).toEqual(types.map((item) => [item.typeName, item.estimated]));
  });

  it("reports no per-type estimate where the project has none", async () => {
    const h = await run({ boards: [], screenFields: [] });
    const types = typesOf(h);
    expect(types.length).toBeGreaterThan(0);
    for (const item of types) {
      expect(item.estimated).toBeNull();
      expect(item.unestimated).toBeNull();
    }
  });

  it("counts a project whose issues all lack an estimate as unestimated in every type", async () => {
    const h = harness({
      issues: syntheticProject(6).map(({ points: _points, seconds: _seconds, ...rest }) => rest),
    });
    const result = await h.run({ projectKey: "REP" });
    const progress = record(record(reportOf(result)).progress);
    const types = (progress.byType as unknown[]).map((item) => record(item));
    for (const item of types) {
      expect(item.unestimated).toBe(item.total);
      expect(item.estimated).toBe(0);
    }
  });
});

describe("an issue type that does not carry the estimate field (#4356)", () => {
  const BUG = "12";
  const SUBTASK = "13";
  const EPIC = "10";
  const WITHOUT = [EPIC, BUG, SUBTASK] as const;
  const issues = syntheticProject(250);
  interface Readback {
    readonly types: ReadonlyMap<string, { total: number; done: number; unestimated: number }>;
    readonly statuses: ReadonlyMap<string, number>;
    readonly estimate: { total: number; done: number; remaining: number; unestimated: number };
  }
  /** Computed straight from the fixture's issues, the way an independent JQL readback would. */
  function readback(source: readonly FixtureIssue[], carrying: ReadonlySet<string>): Readback {
    const types = new Map<string, { total: number; done: number; unestimated: number }>();
    const statuses = new Map<string, number>();
    const estimate = { total: 0, done: 0, remaining: 0, unestimated: 0 };
    for (const issue of source) {
      const type = types.get(issue.type) ?? { total: 0, done: 0, unestimated: 0 };
      type.total += 1;
      if (issue.category === "done") type.done += 1;
      const points = carrying.has(TYPE_ID[issue.type] ?? "") ? issue.points : undefined;
      if (points === undefined) {
        type.unestimated += 1;
        estimate.unestimated += 1;
      } else {
        estimate.total += points;
        if (issue.category === "done") estimate.done += points;
      }
      types.set(issue.type, type);
      const status = `${issue.type}|${issue.status}|${issue.category}`;
      statuses.set(status, (statuses.get(status) ?? 0) + 1);
    }
    estimate.remaining = estimate.total - estimate.done;
    return { types, statuses, estimate };
  }
  function figuresOf(h: ReportRun): {
    readonly types: Map<string, { total: number; done: number; unestimated: number }>;
    readonly statuses: Map<string, number>;
  } {
    if (h.stored === undefined) throw new Error("Missing stored report");
    const { progress } = h.stored;
    const types = new Map(
      progress.byType.map((item) => [
        item.typeName,
        { total: item.total, done: item.done, unestimated: Number(item.unestimated) },
      ]),
    );
    const statuses = new Map(
      progress.byStatus.map((item) => [
        `${item.typeName}|${item.statusName}|${item.category}`,
        item.total,
      ]),
    );
    return { types, statuses };
  }

  it("reads every accessible issue and matches the independent readback over several pages", async () => {
    const h = await run({ issues, withoutEstimateTypes: WITHOUT });
    expect(h.result.data.status).toBe("complete");
    expect(h.report.completeness).toMatchObject({ complete: true, issuesRead: 250 });
    expect(h.requests.filter((request) => request.includes("/search?")).length).toBeGreaterThan(1);
    const expected = readback(issues, new Set(["11"]));
    const actual = figuresOf(h);
    expect(actual.types).toEqual(expected.types);
    expect(actual.statuses).toEqual(expected.statuses);
    expect(record(record(h.report.progress).project).estimate).toEqual(expected.estimate);
    expect(h.report.scope).toMatchObject({ estimateFieldId: POINTS });
  });

  it("is complete when only one type lacks the field and still sums the estimate of the others", async () => {
    const h = await run({ issues, withoutEstimateTypes: [BUG] });
    expect(h.result.data.status).toBe("complete");
    const expected = readback(issues, new Set([EPIC, "11", SUBTASK]));
    expect(record(record(h.report.progress).project).estimate).toEqual(expected.estimate);
    expect(figuresOf(h).types).toEqual(expected.types);
  });

  it("stays incomplete when a type that carries the field has it withheld", async () => {
    const h = await run({ issues, withheldEstimateTypes: ["11"] });
    expect(h.result.data.status).toBe("incomplete");
    expect(h.report.completeness).toMatchObject({
      complete: false,
      reason: "read-failed",
      failure: "permission",
      issuesTotal: 250,
    });
    expect(Number(record(h.report.completeness).issuesRead)).toBeLessThan(250);
    expect(h.activity).toHaveLength(1);
    expect(h.activity[0]).toMatchObject({
      phase: "read",
      status: "incomplete",
      reason: "read-failed",
      failure: "permission",
      issuesTotal: 250,
    });
    expect(JSON.stringify(h.activity)).not.toMatch(/REP-|customfield_|Story Points|jira\.example/u);
  });

  it("keeps only the independently measured prefix when a later page withholds it", async () => {
    const h = await run({ issues, withheldEstimateTypes: ["11"], withheldFromIssue: 150 });
    expect(h.result.data.status).toBe("incomplete");
    // REP-152 is the first story the later page withholds the estimate of.
    expect(h.report.completeness).toMatchObject({ complete: false, issuesRead: 151 });
    const prefix = readback(issues.slice(0, 151), new Set(["11", EPIC, BUG, SUBTASK]));
    expect(record(record(h.report.progress).project).estimate).toEqual(prefix.estimate);
    expect(JSON.stringify(h.activity)).not.toMatch(/REP-|customfield_|jira\.example/u);
  });

  it("keeps a measured zero and an explicit null apart from a type without the field", async () => {
    const story = (key: string, points: number | undefined): FixtureIssue => ({
      ...syntheticProject(8).find((item) => item.type === "Story")!,
      key,
      category: "indeterminate",
      status: "Working",
      ...(points === undefined ? {} : { points }),
    });
    const bug = { ...syntheticProject(8).find((item) => item.type === "Bug")!, key: "REP-12" };
    const h = await run({
      issues: [story("REP-10", 0), story("REP-11", undefined), bug],
      withoutEstimateTypes: [BUG],
    });
    expect(h.result.data.status).toBe("complete");
    expect(record(record(h.report.progress).project).estimate).toEqual({
      total: 0,
      done: 0,
      remaining: 0,
      unestimated: 2,
    });
    const stories = figuresOf(h).types.get("Story");
    expect(stories).toMatchObject({ total: 2, unestimated: 1 });
  });

  it("never exempts a field the screens do not list at all", async () => {
    const h = await run(
      { issues, withoutEstimateTypes: WITHOUT, screenFields: [] },
      { projectKey: "REP", estimateFieldId: POINTS },
    );
    expect(h.result.data.status).toBe("incomplete");
    expect(h.report.completeness).toMatchObject({ complete: false, failure: "permission" });
  });
});
