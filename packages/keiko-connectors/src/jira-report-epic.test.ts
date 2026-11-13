import { describe, expect, it } from "vitest";
import type { AtlassianHttpBodyPort } from "./atlassian-http-port.js";
import {
  fixtureJira,
  syntheticProject,
  type FixtureIssue,
  type FixtureOptions,
} from "./jira-report.fixture.js";
import { CONNECTION, CONTEXT, NOW, record, reportOf } from "./jira-report.harness.js";
import { createJiraReportStore } from "./jira-report-store.js";
import { executeJiraReportTool, type JiraReportActivity } from "./jira-report-tool.js";

const issues = syntheticProject(120);

/** The members of an Epic and, independently of the report code, the sub-tasks of those members. */
function expectedScope(
  source: readonly FixtureIssue[],
  epic: string,
  link = true,
): readonly FixtureIssue[] {
  const members = new Set(
    source
      .filter((issue) => (link && issue.epic === epic) || issue.parent === epic)
      .map((issue) => issue.key),
  );
  return source.filter(
    (issue) =>
      issue.key === epic ||
      members.has(issue.key) ||
      (issue.parent !== undefined && members.has(issue.parent)),
  );
}
/** An Epic whose sub-tasks include a done one, so that a missed sub-task changes the figure. */
const EPIC =
  ["REP-1", "REP-2", "REP-3"].find((epic) =>
    expectedScope(issues, epic).some(
      (issue) => issue.type === "Sub-task" && issue.category === "done",
    ),
  ) ?? "REP-1";

/** A minimal JQL reading of the clauses Keiko composes, so a fixture answers like Jira would. */
function selectFrom(source: readonly FixtureIssue[]): (jql: string) => readonly FixtureIssue[] {
  return (jql) => {
    const epic = /key = "([^"]+)"/u.exec(jql)?.[1] ?? "";
    const linked = /cf\[\d+\] = "([^"]+)"/u.exec(jql)?.[1];
    const listed = /parent in \(([^)]*)\)/u.exec(jql)?.[1];
    const parents = new Set([...(listed ?? "").matchAll(/"([^"]+)"/gu)].map((match) => match[1]));
    return source.filter(
      (issue) =>
        (issue.key === epic && listed === undefined) ||
        (issue.epic !== undefined && issue.epic === linked && listed === undefined) ||
        (issue.parent === epic && listed === undefined) ||
        (issue.parent !== undefined && parents.has(issue.parent)),
    );
  };
}

interface Run {
  readonly result: Awaited<ReturnType<typeof executeJiraReportTool>>;
  readonly activity: JiraReportActivity[];
  readonly searches: readonly string[];
  readonly call: (args: Parameters<typeof executeJiraReportTool>[0]) => Promise<Run["result"]>;
}
type Wrap = (base: AtlassianHttpBodyPort) => AtlassianHttpBodyPort;
async function run(
  args: Parameters<typeof executeJiraReportTool>[0],
  options: Partial<FixtureOptions> = {},
  wrap: Wrap = (base) => base,
): Promise<Run> {
  const source = options.issues ?? issues;
  const fixture = fixtureJira({ issues: source, select: selectFrom(source), ...options });
  const activity: JiraReportActivity[] = [];
  const store = createJiraReportStore({ now: () => NOW });
  const call = (input: Parameters<typeof executeJiraReportTool>[0]): Promise<Run["result"]> =>
    executeJiraReportTool(
      input,
      CONTEXT,
      { ...CONNECTION(fixture), http: wrap(fixture.http) },
      {
        store,
        owner: () => "chat-1",
        now: () => NOW,
        sleep: () => Promise.resolve(),
        activity: (item) => activity.push(item),
      },
    );
  const result = await call(args);
  return {
    result,
    activity,
    call,
    searches: fixture.requests.filter((item) => item.includes("search?")),
  };
}
function respondJson(
  base: AtlassianHttpBodyPort,
  edit: (items: Record<string, unknown>[]) => void,
): Wrap {
  return () => async (request) => {
    const answer = await base(request);
    if (!new URL(request.url).pathname.endsWith("/field") || answer.kind !== "response")
      return answer;
    const items = JSON.parse(answer.bodyText) as Record<string, unknown>[];
    edit(items);
    return { ...answer, bodyText: JSON.stringify(items) };
  };
}
const fieldEdit =
  (edit: (items: Record<string, unknown>[]) => void): Wrap =>
  (base) =>
    respondJson(base, edit)(base);
const refuse =
  (base: AtlassianHttpBodyPort): AtlassianHttpBodyPort =>
  (request) => {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/search") && (url.searchParams.get("jql") ?? "").includes("cf["))
      return Promise.resolve({
        kind: "response",
        status: 400,
        bodyText: "{}",
        bodyBytes: 2,
        truncated: false,
      });
    return base(request);
  };

function reportIdOf(result: Awaited<ReturnType<typeof executeJiraReportTool>>): string {
  const { reportId } = result.data;
  if (typeof reportId !== "string") throw new TypeError("The result carries no report id");
  return reportId;
}

describe("an Epic-scoped report (#4356)", () => {
  it("counts the sub-tasks of the Epic's members, as an independent readback does", async () => {
    const h = await run({ epicKey: EPIC });
    const expected = expectedScope(issues, EPIC);
    const done = expected.filter((issue) => issue.category === "done").length;
    expect(expected.some((issue) => issue.type === "Sub-task" && issue.category === "done")).toBe(
      true,
    );
    expect(h.result.data.status).toBe("complete");
    const report = reportOf(h.result);
    expect(record(record(report.progress).project)).toMatchObject({
      total: expected.length,
      done,
      donePercent: Math.round((done * 1000) / expected.length) / 10,
    });
    expect(record(report.scope)).toMatchObject({ epicKey: EPIC, epicLink: "field" });
    expect(h.activity.at(-1)).toMatchObject({ scopeKind: "epic", status: "complete" });
  });

  it("addresses the Epic Link by its id from the field catalog, never by a display name", async () => {
    const renamed = fieldEdit((items) => {
      const link = items.find((item) => item.id === "customfield_10014");
      if (link === undefined) throw new Error("The fixture has no Epic Link field");
      link.id = "customfield_10777";
      link.name = "Epic-Verknüpfung";
    });
    const h = await run({ epicKey: EPIC }, {}, renamed);
    expect(h.result.data.status).toBe("complete");
    const jql = String(record(reportOf(h.result).scope).jql);
    expect(jql).toContain('cf[10777] = "');
    expect(jql).not.toMatch(/Epic|Verkn/u);
    expect(h.searches.some((search) => decodeURIComponent(search).includes("Epic"))).toBe(false);
    const expected = expectedScope(issues, EPIC);
    expect(record(record(reportOf(h.result).progress).project).total).toBe(expected.length);
  });

  it("reads by parent alone only when the readable field list has no Epic Link field", async () => {
    const children = issues.map((issue) =>
      issue.epic === undefined ? issue : { ...issue, epic: undefined, parent: issue.epic },
    );
    const dropped = fieldEdit((items) => {
      items.splice(
        items.findIndex((item) => item.id === "customfield_10014"),
        1,
      );
    });
    const h = await run({ epicKey: EPIC }, { issues: children }, dropped);
    expect(h.result.data.status).toBe("complete");
    expect(record(reportOf(h.result).scope)).toMatchObject({ epicLink: "absent" });
    expect(String(record(reportOf(h.result).scope).jql)).not.toContain("cf[");
    expect(record(record(reportOf(h.result).progress).project).total).toBe(
      expectedScope(children, EPIC, false).length,
    );
  });

  it("never narrows silently: a refused clause or an ambiguous field is a labelled gap", async () => {
    const refused = await run({ epicKey: EPIC }, {}, refuse);
    const again = reportOf(await refused.call({ reportId: reportIdOf(refused.result) }));
    expect(refused.result.data.status).not.toBe("complete");
    expect(record(again.completeness)).toMatchObject({ complete: false, reason: "read-failed" });
    const doubled = fieldEdit((items) => {
      const link = items.find((item) => item.id === "customfield_10014");
      items.push({ ...link, id: "customfield_10778" });
    });
    const ambiguous = await run({ epicKey: EPIC }, {}, doubled);
    const second = reportOf(await ambiguous.call({ reportId: reportIdOf(ambiguous.result) }));
    expect(record(second.completeness)).toMatchObject({ complete: false, reason: "read-failed" });
    const unreadable = await run({ epicKey: EPIC }, { omitFieldList: true });
    expect(unreadable.result.data.status).not.toBe("complete");
  });

  it("combines with a caller clause and a project instead of widening them", async () => {
    const h = await run({ projectKey: "REP", epicKey: EPIC, jql: "statusCategory = Done" });
    const jql = String(record(reportOf(h.result).scope).jql);
    expect(jql.startsWith("(statusCategory = Done) AND (key = ")).toBe(true);
    expect(h.searches.at(-1)).toContain("project");
  });

  it("is incomplete, not empty, for an Epic the account cannot see", async () => {
    const h = await run({ epicKey: "REP-99999" });
    expect(h.result.data.status).not.toBe("complete");
    expect(JSON.stringify(h.activity)).not.toMatch(/REP-/u);
  });

  it("reads an Epic above the old bound in several queries and counts every issue once", async () => {
    const story = issues.find((issue) => issue.type === "Story");
    const task = issues.find((issue) => issue.type === "Sub-task");
    const epic = issues.find((issue) => issue.type === "Epic");
    if (story === undefined || task === undefined || epic === undefined)
      throw new Error("The fixture lacks a type");
    const stories = Array.from({ length: 300 }, (_, index): FixtureIssue => ({
      ...story,
      key: `REP-${String(1000 + index)}`,
      epic: "REP-1",
      category: index % 3 === 0 ? "done" : "indeterminate",
      status: index % 3 === 0 ? "Closed" : "Working",
    }));
    const subtasks = stories.map((parent, index): FixtureIssue => ({
      ...task,
      key: `REP-${String(5000 + index)}`,
      parent: parent.key,
      // The first sub-task is selected by the Epic Link as well as by its parent: it counts once.
      ...(index === 0 ? { epic: "REP-1" } : {}),
      category: index % 2 === 0 ? "done" : "new",
      status: index % 2 === 0 ? "Closed" : "Open",
    }));
    const big = [{ ...epic, key: "REP-1" }, ...stories, ...subtasks];
    const h = await run({ epicKey: "REP-1" }, { issues: big });
    expect(h.result.data.status).toBe("complete");
    const report = reportOf(h.result);
    const done = big.filter((issue) => issue.category === "done").length;
    expect(record(record(report.progress).project)).toMatchObject({ total: big.length, done });
    expect(record(report.completeness)).toMatchObject({ complete: true, issuesRead: big.length });
    expect(record(report.scope)).toMatchObject({ epicMemberCount: 300 });
    expect(String(record(report.scope).epicMembersDigest)).toMatch(/^[0-9a-f]{64}$/u);
    const windows = new Set(
      h.searches
        .map(
          (search) => new URLSearchParams(search.slice(search.indexOf("?") + 1)).get("jql") ?? "",
        )
        .filter((jql) => jql.includes("parent in (")),
    );
    expect(windows.size).toBeGreaterThan(1);
    const fewer = await run(
      { epicKey: "REP-1" },
      { issues: big.slice(0, -40).filter((i) => i.key !== "REP-1000") },
    );
    expect(String(record(reportOf(fewer.result).scope).epicMembersDigest)).not.toBe(
      String(record(report.scope).epicMembersDigest),
    );
  });

  it("is incomplete for an Epic beyond the member bound, never narrowed", async () => {
    const h = await run({ epicKey: EPIC }, { totalFor: () => 20_000 });
    expect(h.result.data.status).not.toBe("complete");
    expect(h.result.data.report).toBeUndefined();
  });

  it.each([
    [{ epicKey: "REP-1" }, true],
    [{ epicKey: 'REP-1" OR 1=1' }, false],
    [{ epicKey: "" }, false],
  ])("validates the Epic key %j", async (args, accepted) => {
    const h = await run(args);
    expect(h.activity[0]?.phase === "refused").toBe(!accepted);
  });
});
