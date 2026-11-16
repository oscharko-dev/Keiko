import { describe, expect, it } from "vitest";
import type { AtlassianHttpBodyPort } from "./atlassian-http-port.js";
import { fixtureJira, response, syntheticProject } from "./jira-report.fixture.js";
import { CONNECTION, CONTEXT, NOW, record } from "./jira-report.harness.js";
import { createJiraReportStore } from "./jira-report-store.js";
import { executeJiraReportTool } from "./jira-report-tool.js";
import type { JiraReport } from "./jira-report-types.js";

/** What a German instance calls the English names of the fixture; ids, flags and category keys stay. */
const GERMAN_TYPES: Readonly<Record<string, string>> = {
  Epic: "Epos",
  Story: "Anforderung",
  Bug: "Fehler",
  "Sub-task": "Teilaufgabe",
};
const GERMAN_STATUSES: Readonly<Record<string, string>> = {
  Open: "Offen",
  Working: "In Arbeit",
  Closed: "Erledigt",
};
const GERMAN_CATEGORIES: Readonly<Record<string, string>> = {
  "To Do": "Zu erledigen",
  "In Progress": "In Arbeit",
  Done: "Erledigt",
};

function localized(base: AtlassianHttpBodyPort): AtlassianHttpBodyPort {
  return async (request) => {
    const answer = await base(request);
    if (!new URL(request.url).pathname.endsWith("/search") || answer.kind !== "response")
      return answer;
    const body = JSON.parse(answer.bodyText) as { issues: { fields: Record<string, unknown> }[] };
    for (const issue of body.issues) {
      const type = record(issue.fields.issuetype);
      const status = record(issue.fields.status);
      const category = record(status.statusCategory);
      type.name = GERMAN_TYPES[String(type.name)] ?? type.name;
      status.name = GERMAN_STATUSES[String(status.name)] ?? status.name;
      category.name = GERMAN_CATEGORIES[String(category.name)] ?? category.name;
    }
    return response(body);
  };
}
async function reportOf(translate: boolean): Promise<JiraReport> {
  const fixture = fixtureJira({ issues: syntheticProject(120) });
  const store = createJiraReportStore({ now: () => NOW });
  const result = await executeJiraReportTool(
    { projectKey: "REP" },
    CONTEXT,
    { ...CONNECTION(fixture), http: translate ? localized(fixture.http) : fixture.http },
    { store, owner: () => "chat-1", now: () => NOW, sleep: () => Promise.resolve() },
  );
  const { reportId: id } = result.data;
  if (typeof id !== "string") throw new TypeError("The result carries no report id");
  const report = store.peek(id, "chat-1")?.report;
  if (result.data.status !== "complete" || report === undefined)
    throw new Error("The report must be complete");
  return report;
}
const english = (names: Readonly<Record<string, string>>, name: string): string =>
  Object.entries(names).find(([, german]) => german === name)?.[0] ?? name;

describe("a localized instance reads like an English one (#4356)", () => {
  it("never decides by a type, status or category display name: every figure matches", async () => {
    const [base, german] = [await reportOf(false), await reportOf(true)];
    // The names are the only thing that differs.
    expect(german.progress.byStatus.map((item) => item.typeName)).toContain("Anforderung");
    expect(german.progress.byStatus.map((item) => item.statusName)).toContain("Erledigt");
    expect(german.progress.project).toEqual(base.progress.project);
    expect(german.progress.unassigned).toBe(base.progress.unassigned);
    expect(german.progress.overdue).toBe(base.progress.overdue);
    const back = german.progress.byStatus.map((item) => ({
      ...item,
      typeName: english(GERMAN_TYPES, item.typeName),
      statusName: english(GERMAN_STATUSES, item.statusName),
    }));
    const key = (item: { typeName: string; statusName: string }): string =>
      `${item.typeName}|${item.statusName}`;
    expect([...back].sort((a, b) => key(a).localeCompare(key(b)))).toEqual(
      [...base.progress.byStatus].sort((a, b) => key(a).localeCompare(key(b))),
    );
    // The container roles, orphans and epics follow the hierarchy, not an "Epic" type name.
    expect(german.coverage.containerRoles).toBe(base.coverage.containerRoles);
    expect(german.coverage.uncoveredEpics).toEqual(base.coverage.uncoveredEpics);
    expect(german.coverage.orphans).toEqual(base.coverage.orphans);
    expect(german.epics.map((epic) => [epic.key, epic.members, epic.linked])).toEqual(
      base.epics.map((epic) => [epic.key, epic.members, epic.linked]),
    );
    // Only the labels of the types the checker did not judge differ; the counts are the same.
    const { withoutTemplateByType: germanTypes, ...germanRest } = german.compliance;
    const { withoutTemplateByType: baseTypes, ...baseRest } = base.compliance;
    expect(germanRest).toEqual(baseRest);
    const counted = (items: readonly { typeName: string; count: number }[]): string[] =>
      items.map((item) => `${english(GERMAN_TYPES, item.typeName)}:${String(item.count)}`).sort();
    expect(counted(germanTypes)).toEqual(counted(baseTypes));
  });
});
