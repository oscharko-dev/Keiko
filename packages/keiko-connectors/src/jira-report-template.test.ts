import { describe, expect, it } from "vitest";
import {
  parseJiraIssueTemplate,
  type JiraIssueTemplate,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpInvocationContext } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import type { AtlassianWriteHttpOutcome } from "./atlassian-write-http.js";
import {
  EPIC_LINK,
  fixtureJira,
  syntheticProject,
  type FixtureIssue,
  type FixtureOptions,
} from "./jira-report.fixture.js";
import {
  gateJiraMutationByTemplates,
  type JiraIssueTemplateSet,
  type JiraIssueTemplateSource,
  type JiraTemplateGateResult,
} from "./jira-managed-template-gate.js";
import { createJiraReportStore } from "./jira-report-store.js";
import { executeJiraReportTool } from "./jira-report-tool.js";
import type { JiraReport } from "./jira-report-types.js";

const NOW = Date.parse("2026-10-31T12:00:00Z");
const CONTEXT: ManagedMcpInvocationContext = {
  invocationId: "invocation",
  correlationId: "correlation",
  signal: new AbortController().signal,
  beforeEffect: () => true,
};
const GOOD = "## Context\nWhy\n## Acceptance criteria\n* it works";
const BAD = "## Context\nWhy";

function template(...rules: readonly string[]): JiraIssueTemplate {
  const result = parseJiraIssueTemplate(
    [
      "---",
      "keiko: jira-issue-template",
      "version: 1",
      "project: REP",
      "issueType: Story",
      "activateOn: [edit]",
      ...rules,
      "---",
      "## Context",
      "## Acceptance criteria",
    ].join("\n"),
  );
  if (!result.ok) throw new Error("fixture template must parse");
  return result.template;
}

/** Stories get the compliant description, except the first, which lacks a required section. */
function project(): {
  issues: readonly FixtureIssue[];
  violating: FixtureIssue;
  conforming: FixtureIssue;
} {
  const base = syntheticProject(40);
  const stories = base.filter((issue) => issue.type === "Story");
  const [violating, conforming] = stories;
  if (violating === undefined || conforming === undefined) throw new Error("fixture has stories");
  const issues = base.map((issue) =>
    issue.type === "Story"
      ? { ...issue, description: issue.key === violating.key ? BAD : GOOD }
      : issue,
  );
  return {
    issues,
    violating: { ...violating, description: BAD },
    conforming: { ...conforming, description: GOOD },
  };
}

async function reportOf(
  source: JiraIssueTemplateSource | undefined,
  options: Partial<FixtureOptions> = {},
  extraArgs: CatalogJsonObject = {},
): Promise<JiraReport> {
  const { issues } = project();
  // Create metadata that requires nothing: the instance's own required-field rule must not mix
  // into the template's, and the metadata stays readable so the report can complete.
  const fixture = fixtureJira({ issues, noRequiredFields: true, ...options });
  const store = createJiraReportStore({ now: () => NOW });
  const result = await executeJiraReportTool(
    { projectKey: "REP", ...extraArgs },
    CONTEXT,
    {
      deployment: "data-center",
      baseUrl: "https://jira.example.invalid/context",
      http: fixture.http,
      ...(source === undefined ? {} : { issueTemplates: source }),
    },
    { store, owner: () => "chat-1", now: () => NOW, sleep: () => Promise.resolve() },
  );
  const id = result.data.reportId;
  const report = typeof id === "string" ? store.get(id, "chat-1")?.report : undefined;
  if (report === undefined) throw new Error("the report must be complete");
  return report;
}

/** The write gate for an edit of the same issue, with the same template source. */
function gateOf(
  source: JiraIssueTemplateSource,
  issue: FixtureIssue,
): Promise<JiraTemplateGateResult> {
  const issueBody = {
    id: issue.key.slice(4),
    key: issue.key,
    fields: {
      project: { key: "REP" },
      issuetype: { id: "11", name: "Story" },
      status: { id: "1", name: "Open" },
      summary: issue.summary,
      description: issue.description ?? null,
      labels: [...issue.labels],
      issuelinks: [],
    },
  };
  const request = (path: string): Promise<AtlassianWriteHttpOutcome> =>
    Promise.resolve(
      path.startsWith("issue/")
        ? { ok: true, status: 200, body: issueBody }
        : { ok: true, status: 200, body: undefined, items: [] },
    );
  return gateJiraMutationByTemplates({
    request,
    source,
    operation: "edit",
    metadata: [],
    validated: { fields: {}, update: {} },
    target: { issueKey: issue.key },
  });
}

const SET = (...templates: JiraIssueTemplate[]): JiraIssueTemplateSet => ({
  templates,
  unreadable: 0,
});

function deviationKeys(report: JiraReport, ruleId: string): readonly string[] {
  return report.compliance.deviations
    .filter((deviation) => deviation.ruleIds.includes(ruleId))
    .map((deviation) => deviation.key);
}

describe("the report and the write gate share one template source", () => {
  it("lists an issue the gate refuses, and neither names a conforming one", async () => {
    const { violating, conforming } = project();
    const source: JiraIssueTemplateSource = () => SET(template());
    const report = await reportOf(source);
    const refused = await gateOf(source, violating);
    const allowed = await gateOf(source, conforming);

    expect(refused).toMatchObject({
      ok: false,
      reason: "field-validation",
      violations: [{ ruleId: "section-missing", subject: "Acceptance criteria" }],
    });
    expect(allowed).toEqual({ ok: true });
    expect(deviationKeys(report, "section-missing")).toEqual([violating.key]);
    expect(deviationKeys(report, "section-missing")).not.toContain(conforming.key);
    expect(report.compliance).toMatchObject({ checker: "applied", issuesWithDeviations: 1 });
    expect(report.compliance.deviations[0]?.fieldIds).toEqual(["description"]);
    expect(report.completeness).toMatchObject({ complete: true });
  });

  it("agrees on rules a summary and a label raise", async () => {
    const source: JiraIssueTemplateSource = () =>
      SET(template("summaryMinLength: 200", "requiredLabels: [reviewed]"));
    const report = await reportOf(source);
    const { violating } = project();
    const refused = await gateOf(source, violating);
    const gateRules = refused.ok ? [] : (refused.violations ?? []).map((item) => item.ruleId);
    expect(gateRules).toEqual(expect.arrayContaining(["summary-too-short", "label-missing"]));
    for (const ruleId of gateRules) expect(deviationKeys(report, ruleId)).toContain(violating.key);
  });

  it("ignores a template that governs only create or a transition, as the edit gate does", async () => {
    const createOnly = parseJiraIssueTemplate(
      "---\nkeiko: jira-issue-template\nversion: 1\nproject: REP\nissueType: Story\nactivateOn: [create]\n---\n## Acceptance criteria\n",
    );
    if (!createOnly.ok) throw new Error("fixture template must parse");
    const source: JiraIssueTemplateSource = () => SET(createOnly.template);
    const report = await reportOf(source);
    expect(report.compliance).toMatchObject({ checker: "none", deviationCount: 0 });
    expect(await gateOf(source, project().violating)).toEqual({ ok: true });
  });

  it("reports no template check when the connection has no source", async () => {
    const report = await reportOf(undefined);
    expect(report.compliance).toMatchObject({ checker: "none", deviationCount: 0 });
  });
});

describe("an unreadable template source never reads as zero deviations", () => {
  const broken: JiraIssueTemplateSource = () => ({
    templates: [template()],
    unreadable: 1,
    unreadableNames: ["Story template"],
  });

  it("marks the report incomplete with a closed reason, and the gate refuses the same state", async () => {
    const report = await reportOf(broken);
    expect(report.compliance).toMatchObject({
      checker: "unavailable",
      issuesWithDeviations: 0,
      deviationCount: 0,
    });
    expect(report.completeness).toMatchObject({
      complete: false,
      reason: "template-unreadable",
    });
    expect(await gateOf(broken, project().conforming)).toMatchObject({
      ok: false,
      violations: [{ ruleId: "template-unreadable", subject: "Story template" }],
    });
  });

  it("keeps the figures of every issue it read", async () => {
    const report = await reportOf(broken);
    expect(report.progress.project.total).toBe(project().issues.length);
  });

  it("surfaces a source that throws instead of reporting a pass", async () => {
    const { issues } = project();
    const fixture = fixtureJira({ issues });
    const store = createJiraReportStore({ now: () => NOW });
    const run = (): Promise<unknown> =>
      executeJiraReportTool(
        { projectKey: "REP" },
        CONTEXT,
        {
          deployment: "data-center",
          baseUrl: "https://jira.example.invalid/context",
          http: fixture.http,
          issueTemplates: () => {
            throw new Error("store unavailable");
          },
        },
        { store, owner: () => "chat-1", now: () => NOW, sleep: () => Promise.resolve() },
      );
    await expect(run()).rejects.toThrow("store unavailable");
  });
});

describe("template field references", () => {
  const byName = (): JiraIssueTemplateSet => SET(template("requiredFields: [Does not exist]"));

  it("raises field-unavailable per issue when the instance field list was read", async () => {
    const report = await reportOf(byName);
    expect(report.compliance.checker).toBe("applied");
    expect(deviationKeys(report, "field-unavailable").length).toBeGreaterThan(0);
  });

  it("states the check unavailable when a name cannot be resolved because the list was not read", async () => {
    // Without the field list the hierarchy cannot be discovered; naming the parent field takes
    // that responsibility, which is the only way a report completes without the list.
    const report = await reportOf(byName, { omitFieldList: true }, { parentFieldIds: [EPIC_LINK] });
    expect(report.compliance).toMatchObject({ checker: "unavailable", deviationCount: 0 });
    expect(report.completeness).toMatchObject({ complete: false, reason: "template-unreadable" });
  });

  it("asks Jira for the fields the templates read", async () => {
    const { issues } = project();
    const fixture = fixtureJira({ issues });
    const store = createJiraReportStore({ now: () => NOW });
    const args: CatalogJsonObject = { projectKey: "REP" };
    await executeJiraReportTool(
      args,
      CONTEXT,
      {
        deployment: "data-center",
        baseUrl: "https://jira.example.invalid/context",
        http: fixture.http,
        issueTemplates: () => SET(template("requiredFields: [customfield_10100]")),
      },
      { store, owner: () => "chat-1", now: () => NOW, sleep: () => Promise.resolve() },
    );
    const search = fixture.requests.find((request) => request.includes("search?"));
    expect(search).toContain("customfield_10100");
    expect(search).toContain("description");
    expect(search).toContain("labels");
  });
});
