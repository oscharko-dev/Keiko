import { describe, expect, it } from "vitest";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { fixtureJira, POINTS, response, syntheticProject } from "./jira-report.fixture.js";
import { CONNECTION, CONTEXT, NOW, record, reportOf } from "./jira-report.harness.js";
import { createJiraReportStore } from "./jira-report-store.js";
import { executeJiraReportTool } from "./jira-report-tool.js";
import type { AtlassianHttpBodyPort } from "./atlassian-http-port.js";

/** S10: the project reports Tasks with time tracking; its Scrum board estimates Stories in points. */
function taskTransport(scrum: boolean): AtlassianHttpBodyPort {
  const sample = syntheticProject(6).find((issue) => issue.type === "Bug");
  if (sample === undefined) throw new TypeError("Expected synthetic Task source");
  const native = fixtureJira({
    issues: [{ ...sample, seconds: 7200, points: 8, category: "done" }],
  });
  return async (request) => {
    const path = new URL(request.url).pathname;
    if (path.endsWith("/agile/1.0/board"))
      return response({ startAt: 0, isLast: true, values: [{ id: 7 }] });
    if (path.endsWith("/board/7/configuration"))
      return response({
        estimation: scrum
          ? { type: "field", field: { fieldId: POINTS, displayName: "Story Points" } }
          : { type: "issueCount" },
      });
    if (path.endsWith("/createmeta/REP/issuetypes"))
      return response({ isLast: true, values: [{ id: "12", name: "Task" }] });
    if (path.endsWith("/createmeta/REP/issuetypes/12"))
      return response({
        isLast: true,
        values: [
          { fieldId: "summary", name: "Summary", required: true },
          { fieldId: "timetracking", name: "Time Tracking", required: false },
        ],
      });
    const result = await native.http(request);
    if (!path.endsWith("/search") || result.kind !== "response" || result.status !== 200)
      return result;
    const body = JSON.parse(result.bodyText) as {
      issues: { fields: { issuetype: { name: string } } }[];
    };
    for (const issue of body.issues) issue.fields.issuetype.name = "Task";
    return response(body);
  };
}
async function run(scrum: boolean, args: CatalogJsonObject): Promise<Record<string, unknown>> {
  const http = taskTransport(scrum);
  const connection = { ...CONNECTION({ http, requests: [], searches: [] }), http };
  const result = await executeJiraReportTool(args, CONTEXT, connection, {
    store: createJiraReportStore({ now: () => NOW }),
    owner: () => "chat-1",
    now: () => NOW,
  });
  expect(result.data.status).toBe("complete");
  return reportOf(result);
}

describe("estimate selection retains dev time-tracking parity (#4321 C4)", () => {
  it.each([
    [
      "Scrum board with Story Points but Tasks with time tracking only",
      true,
      { projectKey: "REP" },
    ],
    ["Kanban without a Story Points field", false, { projectKey: "REP" }],
    ["JQL without a project", true, { jql: "issuetype = Task" }],
  ] as const)("reports hours for %s", async (_name, scrum, args) => {
    const report = await run(scrum, args);
    expect(report.scope).toMatchObject({
      estimateFieldId: "timeoriginalestimate",
      estimateUnit: "seconds",
      estimateSource: "time-tracking",
    });
    expect(record(record(report.progress).project).estimate).toEqual({
      total: 7200,
      done: 7200,
      remaining: 0,
      unestimated: 0,
    });
    expect(report.figures).toContain("Estimate in hours");
    expect(report.figures).toContain("2;2;0");
  });
});
