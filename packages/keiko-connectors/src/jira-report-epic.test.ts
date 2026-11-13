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
import { jiraReportEpicClause } from "./jira-report-epic.js";

const issues = syntheticProject(120);
/** The members of an Epic and, independently of the report code, the sub-tasks of those members. */
function expectedScope(epic: string): readonly FixtureIssue[] {
  const members = new Set(
    issues.filter((issue) => issue.epic === epic || issue.parent === epic).map((i) => i.key),
  );
  return issues.filter(
    (issue) =>
      issue.key === epic ||
      members.has(issue.key) ||
      (issue.parent !== undefined && members.has(issue.parent)),
  );
}

/** An Epic whose sub-tasks include a done one, so that a missed sub-task changes the figure. */
const EPIC =
  ["REP-1", "REP-2", "REP-3"].find((epic) =>
    expectedScope(epic).some((issue) => issue.type === "Sub-task" && issue.category === "done"),
  ) ?? "REP-1";

/** A minimal JQL reading of the clauses Keiko composes, so the fixture answers like Jira would. */
function select(jql: string): readonly FixtureIssue[] {
  const epic = /key = "([^"]+)"/u.exec(jql)?.[1] ?? "";
  const listed = /parent in \(([^)]*)\)/u.exec(jql)?.[1];
  const parents = new Set([...(listed ?? "").matchAll(/"([^"]+)"/gu)].map((match) => match[1]));
  return issues.filter(
    (issue) =>
      issue.key === epic ||
      issue.epic === epic ||
      issue.parent === epic ||
      (issue.parent !== undefined && parents.has(issue.parent)),
  );
}

interface Run {
  readonly result: Awaited<ReturnType<typeof executeJiraReportTool>>;
  readonly activity: JiraReportActivity[];
  readonly searches: readonly string[];
}
async function run(
  args: Parameters<typeof executeJiraReportTool>[0],
  options: Partial<FixtureOptions> = {},
  wrap: (base: AtlassianHttpBodyPort) => AtlassianHttpBodyPort = (base) => base,
): Promise<Run> {
  const fixture = fixtureJira({ issues, select, ...options });
  const activity: JiraReportActivity[] = [];
  const result = await executeJiraReportTool(
    args,
    CONTEXT,
    { ...CONNECTION(fixture), http: wrap(fixture.http) },
    {
      store: createJiraReportStore({ now: () => NOW }),
      owner: () => "chat-1",
      now: () => NOW,
      sleep: () => Promise.resolve(),
      activity: (item) => activity.push(item),
    },
  );
  return {
    result,
    activity,
    searches: fixture.requests.filter((item) => item.includes("search?")),
  };
}

describe("an Epic-scoped report (#4356)", () => {
  it("counts the sub-tasks of the Epic's members, as an independent readback does", async () => {
    const h = await run({ epicKey: EPIC });
    const expected = expectedScope(EPIC);
    const done = expected.filter((issue) => issue.category === "done").length;
    const subtasks = expected.filter((issue) => issue.type === "Sub-task");
    // The scenario is only meaningful when a done sub-task decides the figure.
    expect(subtasks.some((issue) => issue.category === "done")).toBe(true);
    expect(h.result.data.status).toBe("complete");
    const report = reportOf(h.result);
    expect(record(record(report.progress).project)).toMatchObject({
      total: expected.length,
      done,
      donePercent: Math.round((done * 1000) / expected.length) / 10,
    });
    expect(record(report.scope)).toMatchObject({ epicKey: EPIC });
    expect(h.activity.at(-1)).toMatchObject({ scopeKind: "epic", status: "complete" });
  });

  it("states the composed JQL so a reader can reconcile it, and it reads back to the same set", async () => {
    const h = await run({ epicKey: EPIC });
    const jql = String(record(reportOf(h.result).scope).jql);
    expect(
      jql.startsWith(
        `key = "${EPIC}" OR "Epic Link" = "${EPIC}" OR parent = "${EPIC}" OR parent in (`,
      ),
    ).toBe(true);
    expect(select(jql).map((issue) => issue.key)).toEqual(
      expectedScope(EPIC).map((issue) => issue.key),
    );
  });

  it("falls back to the parent relation when the instance has no Epic Link clause", async () => {
    const h = await run(
      { epicKey: EPIC },
      {},
      (base) =>
        (request): ReturnType<AtlassianHttpBodyPort> => {
          const url = new URL(request.url);
          if (
            url.pathname.endsWith("/search") &&
            (url.searchParams.get("jql") ?? "").includes("Epic Link")
          )
            return Promise.resolve({
              kind: "response",
              status: 400,
              bodyText: "{}",
              bodyBytes: 2,
              truncated: false,
            });
          return base(request);
        },
    );
    expect(h.result.data.status).toBe("complete");
    const jql = String(record(reportOf(h.result).scope).jql);
    expect(jql).not.toContain("Epic Link");
    expect(jql).toContain("parent in (");
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

  it("refuses an Epic whose members do not fit the composed clause, never narrowing it silently", async () => {
    const story = issues.find((issue) => issue.type === "Story");
    const epic = issues.find((issue) => issue.type === "Epic");
    if (story === undefined || epic === undefined) throw new Error("The fixture lacks a type");
    const many: FixtureIssue[] = [
      { ...epic, key: "REP-1" },
      ...Array.from({ length: 400 }, (_, index) => ({
        ...story,
        key: `REP-${String(1000 + index)}`,
        epic: "REP-1",
      })),
    ];
    const h = await run({ epicKey: "REP-1" }, { issues: many, select: () => many });
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

  it("composes only quoted keys", () => {
    expect(jiraReportEpicClause("REP-1", false, ["REP-2", "REP-3"])).toBe(
      'key = "REP-1" OR parent = "REP-1" OR parent in ("REP-2", "REP-3")',
    );
  });
});
