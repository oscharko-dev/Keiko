import { describe, expect, it } from "vitest";
import {
  parseJiraIssueTemplate,
  type JiraIssueTemplate,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolResult } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import type { AtlassianHttpBodyPort } from "./atlassian-http-port.js";
import { CONTEXT, NOW, idOf, record, reportOf } from "./jira-report.harness.js";
import {
  ACCEPTANCE,
  DECOY_BLOB,
  fixtureJira,
  response,
  syntheticProject,
  type FixtureIssue,
  type FixtureOptions,
} from "./jira-report.fixture.js";
import { exportJiraReport, jiraReportCommentText } from "./jira-report-export.js";
import type { JiraReportHttp } from "./jira-report-http.js";
import { loadRequiredFields } from "./jira-report-metadata.js";
import { JIRA_REPORT_SESSION_MAX_BYTES } from "./jira-report-session.js";
import { createJiraReportStore } from "./jira-report-store.js";
import { executeJiraReportTool, type JiraReportToolDeps } from "./jira-report-tool.js";
import type { JiraIssueTemplateSet } from "./jira-managed-template-gate.js";
import type { JiraReport } from "./jira-report-types.js";
import type { ManagedMcpInvocationContext } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";

type Body = Record<string, unknown>;
/** Rewrites a Jira answer in flight: the path it answers and its parsed body. */
type Rewrite = (path: string, body: Body) => Body;

function through(http: AtlassianHttpBodyPort, rewrite: Rewrite | undefined): AtlassianHttpBodyPort {
  if (rewrite === undefined) return http;
  return async (request) => {
    const answer = await http(request);
    if (answer.kind !== "response" || answer.status !== 200) return answer;
    const path = new URL(request.url).pathname.replace(/^.*\/rest\/api\/2\//u, "");
    return response(rewrite(path, JSON.parse(answer.bodyText) as Body));
  };
}
function issuesOf(body: Body): Body[] {
  return Array.isArray(body.issues) ? (body.issues as Body[]) : [];
}
function fieldsOf(issue: Body): Body {
  return issue.fields as Body;
}

interface Run {
  readonly result: ManagedMcpToolResult;
  readonly report: JiraReport | undefined;
  readonly again: () => Promise<ManagedMcpToolResult>;
}
async function run(
  options: FixtureOptions,
  extra: {
    readonly rewrite?: Rewrite;
    readonly args?: CatalogJsonObject;
    readonly deps?: Partial<JiraReportToolDeps<ManagedMcpInvocationContext>>;
    readonly templates?: JiraIssueTemplateSet;
  } = {},
): Promise<Run> {
  const fixture = fixtureJira(options);
  const store = createJiraReportStore({ now: () => NOW });
  const { templates } = extra;
  const connection = {
    deployment: "data-center" as const,
    baseUrl: "https://jira.example.invalid/context",
    identity: "credential-1",
    http: through(fixture.http, extra.rewrite),
    ...(templates === undefined ? {} : { issueTemplates: (): JiraIssueTemplateSet => templates }),
  };
  const deps: JiraReportToolDeps<ManagedMcpInvocationContext> = {
    store,
    owner: () => "chat-1",
    now: () => NOW,
    sleep: () => Promise.resolve(),
    ...extra.deps,
  };
  const call = (args: CatalogJsonObject): Promise<ManagedMcpToolResult> =>
    executeJiraReportTool(args, CONTEXT, connection, deps);
  const result = await call({ projectKey: "REP", ...extra.args });
  const id = idOf(result);
  const again = (): Promise<ManagedMcpToolResult> => call({ reportId: id });
  return { result, report: store.peek(id, "chat-1")?.report, again };
}
async function finished(started: Run): Promise<Run> {
  if (started.result.data.status !== "reading") return started;
  const result = await started.again();
  return { ...started, result, report: undefined };
}
function completenessOf(result: ManagedMcpToolResult): Record<string, unknown> {
  return record(reportOf(result).completeness);
}

describe("an omitted requested field is unreadable evidence, never an empty value (D1)", () => {
  const issues = syntheticProject(40);
  const options: FixtureOptions = { issues, requireFixVersions: true };

  it("control: an explicit null counts as unassigned and an empty required field deviates", async () => {
    const { result } = await run(options);
    expect(result.data.status).toBe("complete");
    const report = reportOf(result);
    expect(record(report.progress).unassigned).toBeGreaterThan(0);
    expect(record(report.compliance).deviationCount).toBeGreaterThan(0);
  });

  it("ends incomplete when the hits leave out the assignee and the required fields", async () => {
    const strip: Rewrite = (path, body) => {
      if (path !== "search") return body;
      for (const issue of issuesOf(body)) {
        const fields = fieldsOf(issue);
        Reflect.deleteProperty(fields, "assignee");
        Reflect.deleteProperty(fields, ACCEPTANCE);
      }
      return body;
    };
    const { result } = await run(options, { rewrite: strip });
    expect(result.data.status).toBe("incomplete");
    expect(completenessOf(result)).toMatchObject({
      complete: false,
      reason: "read-failed",
      failure: "permission",
    });
  });

  it("ends incomplete when only the assignee is left out", async () => {
    const strip: Rewrite = (path, body) => {
      if (path === "search")
        for (const issue of issuesOf(body)) Reflect.deleteProperty(fieldsOf(issue), "assignee");
      return body;
    };
    const { result } = await run(options, { rewrite: strip });
    expect(completenessOf(result)).toMatchObject({ complete: false, failure: "permission" });
  });
});

describe("create metadata is trusted only with Jira's completion evidence (D2)", () => {
  const issues = syntheticProject(40);
  const early = { startAt: 0, maxResults: 50, total: 4, isLast: false, values: [] };

  it("control: the unchanged metadata finds the missing required acceptance field", async () => {
    const { result } = await run({ issues });
    expect(result.data.status).toBe("complete");
    expect(record(reportOf(result).compliance)).toMatchObject({ requiredFieldRules: "applied" });
    expect(record(reportOf(result).compliance).deviationCount).toBeGreaterThan(0);
  });

  it("refuses an early empty page of the issue types", async () => {
    const rewrite: Rewrite = (path, body) => (path.endsWith("/issuetypes") ? early : body);
    const started = await finished(await run({ issues }, { rewrite }));
    expect(started.result.data.status).toBe("incomplete");
    expect(completenessOf(started.result)).toMatchObject({
      complete: false,
      reason: "read-failed",
      failure: "malformed-payload",
    });
    expect(record(reportOf(started.result).compliance).requiredFieldRules).not.toBe("applied");
  });

  it("refuses an early empty page of a type's field metadata", async () => {
    const rewrite: Rewrite = (path, body) => (path.includes("/issuetypes/") ? early : body);
    const started = await finished(await run({ issues }, { rewrite }));
    expect(started.result.data.status).toBe("incomplete");
    expect(completenessOf(started.result)).toMatchObject({ failure: "malformed-payload" });
    expect(record(reportOf(started.result).compliance).requiredFieldRules).not.toBe("applied");
  });

  describe("page coordinates and completion", () => {
    function pages(...bodies: Body[]): JiraReportHttp {
      const queue = [...bodies];
      return {
        getArray: () => Promise.resolve({ ok: false, reason: "not-found" }),
        getRecord: (): ReturnType<JiraReportHttp["getRecord"]> => {
          const body = queue.shift();
          return Promise.resolve(
            body === undefined
              ? { ok: false as const, reason: "not-found" as const }
              : { ok: true as const, body },
          );
        },
      };
    }
    const reasonOf = async (...bodies: Body[]): Promise<string | undefined> =>
      (await loadRequiredFields(pages(...bodies), "REP")).reason;

    it("rejects a page that starts elsewhere than asked, or that proves nothing", async () => {
      expect(await reasonOf({ startAt: 7, total: 1, isLast: true, values: [] })).toBe(
        "malformed-payload",
      );
      expect(await reasonOf({ values: [{ id: "10" }] })).toBe("malformed-payload");
      expect(await reasonOf({ total: -1, values: [{ id: "10" }] })).toBe("malformed-payload");
      expect(await reasonOf({ total: "4", values: [{ id: "10" }] })).toBe("malformed-payload");
      expect(await reasonOf({ startAt: 0, total: 3, isLast: false, values: [] })).toBe(
        "malformed-payload",
      );
    });

    it("reads a multi-page collection to its total and accepts an empty collection that says so", async () => {
      const read = await loadRequiredFields(
        pages(
          { startAt: 0, total: 2, isLast: false, values: [{ id: "11" }] },
          { startAt: 1, total: 2, isLast: true, values: [{ id: "12" }] },
          { startAt: 0, total: 1, isLast: true, values: [] },
          { startAt: 0, total: 1, isLast: true, values: [] },
        ),
        "REP",
      );
      expect(read.state).toBe("applied");
      const none = await loadRequiredFields(
        pages({ startAt: 0, total: 0, isLast: true, values: [] }),
        "REP",
      );
      expect(none.state).toBe("applied");
    });
  });
});

describe("search pagination evidence must be coherent before a report completes (D3)", () => {
  const issues = syntheticProject(20);
  const withPage =
    (patch: (body: Body) => Body): Rewrite =>
    (path, body) =>
      path === "search" ? patch(body) : body;

  it("control: a numeric total of zero is a complete, empty report", async () => {
    const { result } = await run({ issues: [] });
    expect(result.data.status).toBe("complete");
    expect(completenessOf(result)).toMatchObject({ complete: true, issuesRead: 0, issuesTotal: 0 });
  });

  it.each([
    ["a string total", { total: "181", issues: [] }],
    ["a negative total", { total: -3, issues: [] }],
    ["a fractional total", { total: 1.5, issues: [] }],
    ["a missing total", { total: undefined, issues: [] }],
    ["a page at another offset", { startAt: 40 }],
  ] as const)("does not complete on %s", async (_name, patch) => {
    const { result } = await run(
      { issues },
      { rewrite: withPage((body) => ({ ...body, ...patch })) },
    );
    expect(result.data.status).toBe("incomplete");
    expect(completenessOf(result)).toMatchObject({
      complete: false,
      reason: "read-failed",
      failure: "malformed-payload",
    });
  });

  it("does not complete on a page that holds more issues than the total leaves", async () => {
    const { result } = await run(
      { issues },
      { rewrite: withPage((body) => ({ ...body, total: 3 })) },
    );
    expect(completenessOf(result)).toMatchObject({ complete: false, failure: "malformed-payload" });
  });
});

/** A report that has initialized and read nothing, charged just under the per-report bound. */
async function nearlyFull(
  extraDeps: Partial<JiraReportToolDeps<ManagedMcpInvocationContext>>,
): Promise<{ readonly resume: () => Promise<ManagedMcpToolResult> }> {
  const fixture = fixtureJira({ issues: syntheticProject(30) });
  const store = createJiraReportStore({ now: () => NOW });
  const connection = {
    deployment: "data-center" as const,
    baseUrl: "https://jira.example.invalid/context",
    identity: "credential-1",
    http: fixture.http,
  };
  const deps: JiraReportToolDeps<ManagedMcpInvocationContext> = {
    store,
    owner: () => "chat-1",
    now: () => NOW,
    sleep: () => Promise.resolve(),
    ...extraDeps,
  };
  // A zero slice initializes the report and reads nothing.
  const first = await executeJiraReportTool({ projectKey: "REP" }, CONTEXT, connection, {
    ...deps,
    sliceMs: 0,
  });
  const id = idOf(first);
  const session = store.peek(id, "chat-1");
  if (session === undefined) throw new Error("the report must be resumable");
  session.bytes = JIRA_REPORT_SESSION_MAX_BYTES - 1;
  return { resume: () => executeJiraReportTool({ reportId: id }, CONTEXT, connection, deps) };
}

describe("each report is bounded by its own memory budget through the default path (D5)", () => {
  it("finishes incomplete at the per-report bound, not at the shared store bound", async () => {
    const resumed = await (await nearlyFull({})).resume();
    expect(resumed.data.status).toBe("incomplete");
    expect(completenessOf(resumed)).toMatchObject({ reason: "memory-budget" });
  });

  it("never lets an override raise the bound", async () => {
    const resumed = await (
      await nearlyFull({ memoryBudgetBytes: Number.MAX_SAFE_INTEGER })
    ).resume();
    expect(completenessOf(resumed)).toMatchObject({ reason: "memory-budget" });
  });
});

describe("a rule counts each issue once, the deviations are counted separately (D6)", () => {
  it("counts two empty required fields of one issue as one issue of the rule", async () => {
    const { report } = await run({ issues: syntheticProject(40), requireFixVersions: true });
    if (report === undefined) throw new Error("the report must be complete");
    const rule = report.compliance.byRule.find((item) => item.ruleId === "required-field-empty");
    // Every story lacks fixVersions; the ones without acceptance criteria lack a second field.
    expect(report.compliance.deviationCount).toBeGreaterThan(
      report.compliance.issuesWithDeviations,
    );
    expect(rule?.count).toBe(report.compliance.issuesWithDeviations);
    const markdown = exportJiraReport(report, "markdown").content;
    expect(markdown).toMatch(
      new RegExp(String.raw`\| required.field.empty \| ${String(rule?.count)} \|`, "u"),
    );
    expect(jiraReportCommentText(report)).toContain(
      `Rule required-field-empty: ${String(rule?.count)} issues`,
    );
  });
});

describe("template violations keep their distinct subjects (D4)", () => {
  function template(...rules: readonly string[]): JiraIssueTemplate {
    const parsed = parseJiraIssueTemplate(
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
    if (!parsed.ok) throw new Error("fixture template must parse");
    return parsed.template;
  }

  it("enumerates two missing sections and two missing labels of one issue", async () => {
    const emptyStories = syntheticProject(40).map((issue) =>
      issue.type === "Story" ? { ...issue, description: "" } : issue,
    );
    const { report } = await run(
      { issues: emptyStories, noRequiredFields: true },
      {
        templates: {
          templates: [template("requiredLabels: [reviewed, approved]")],
          unreadable: 0,
        },
      },
    );
    if (report === undefined) throw new Error("the report must be complete");
    const entry = report.compliance.deviations[0];
    expect(entry?.details).toEqual([
      "label-missing: approved",
      "label-missing: reviewed",
      "section-missing: Acceptance criteria",
      "section-missing: Context",
    ]);
    const stories = emptyStories.filter((issue) => issue.type === "Story").length;
    expect(report.compliance.deviationCount).toBe(stories * 4);
    expect(report.compliance.issuesWithDeviations).toBe(stories);
    for (const rule of ["label-missing", "section-missing"])
      expect(report.compliance.byRule.find((item) => item.ruleId === rule)?.count).toBe(stories);
  });
});

describe("labels are never cut before the trace and requirements are read (D7)", () => {
  const filler = Array.from({ length: 64 }, (_, index) => `ordinary-${String(index)}`);
  const withTrace = (issues: readonly FixtureIssue[], labels: readonly string[]): FixtureIssue[] =>
    issues.map((issue) => (issue.key === "REP-1" ? { ...issue, labels } : issue));

  it("covers the requirement whether the trace label comes first or after 64 others", async () => {
    const short = await run(
      { issues: withTrace(syntheticProject(12), ["REQ-004"]) },
      { args: { requirementIds: ["REQ-004"] } },
    );
    const long = await run(
      { issues: withTrace(syntheticProject(12), [...filler, "REQ-004", "keiko:trace"]) },
      { args: { requirementIds: ["REQ-004"] } },
    );
    expect(record(record(reportOf(short.result).coverage).requirements)).toMatchObject({
      covered: 1,
    });
    expect(record(record(reportOf(long.result).coverage).requirements)).toMatchObject({
      covered: 1,
    });
    const row = long.report?.rows.find((item) => item.issue.key === "REP-1");
    expect(row?.issue.labels).toHaveLength(66);
    expect(row?.issue.labels).toContain("keiko:trace");
  });
});

describe("containers the scope does not show hold are disclosed, not asserted away (D8)", () => {
  it("control: a populated project observes its containers and lists the empty epic", async () => {
    const { result } = await run({ issues: syntheticProject(60) });
    expect(record(reportOf(result).coverage)).toMatchObject({ containerRoles: "observed" });
    expect(record(record(reportOf(result).coverage).uncoveredEpics).items).toEqual(["REP-4"]);
  });

  it("states the classification as unobserved when the project holds only epics", async () => {
    const { result, report } = await run({ issues: syntheticProject(4) });
    expect(result.data.status).toBe("complete");
    expect(record(reportOf(result).coverage)).toMatchObject({ containerRoles: "unobserved" });
    const markdown = report === undefined ? "" : exportJiraReport(report, "markdown").content;
    expect(markdown).toContain("Not determinable");
  });

  it("states it when a JQL scope leaves out the children of the epics", async () => {
    const epicsOnly = (): readonly FixtureIssue[] =>
      syntheticProject(60).filter((issue) => issue.type === "Epic");
    const { result } = await run({ issues: syntheticProject(60), select: epicsOnly });
    expect(record(reportOf(result).coverage)).toMatchObject({ containerRoles: "unobserved" });
  });
});

function orphanKeys(result: ManagedMcpToolResult): string[] {
  const items = record(record(reportOf(result).coverage).orphans).items as readonly Body[];
  return items.map((item) => String(item.key));
}

describe("an issue key in a business field is no parent without role evidence (D9)", () => {
  const issues = syntheticProject(30);
  const mention = (hold: (key: string) => boolean): Rewrite => {
    return (path, body) => {
      if (path !== "search") return body;
      for (const issue of issuesOf(body)) {
        const key = String(issue.key);
        const fields = fieldsOf(issue);
        if (key === "REP-9") fields[DECOY_BLOB] = { key: "REP-1", hasValue: true };
        else if (!hold(key) && DECOY_BLOB in fields) fields[DECOY_BLOB] = null;
      }
      return body;
    };
  };

  it("keeps the orphan an orphan when the field holds other non-key values", async () => {
    const { result } = await run({ issues }, { rewrite: mention(() => true) });
    const orphans = orphanKeys(result);
    expect(orphans).toContain("REP-9");
    expect(record(reportOf(result).hierarchy)).toMatchObject({
      observedFieldCount: 1,
      rejectedFieldCount: 2,
    });
  });

  it("takes the proposal back when the contradicting values come on a later page", async () => {
    const keyNumber = (key: string): number => Number(key.slice(4));
    const { result } = await run(
      { issues, pageClamp: 8 },
      { rewrite: mention((key) => keyNumber(key) >= 20) },
    );
    const orphans = orphanKeys(result);
    expect(orphans).toContain("REP-9");
  });

  it("honours the field when the caller names it", async () => {
    const { result } = await run(
      { issues },
      { rewrite: mention(() => true), args: { parentFieldIds: [DECOY_BLOB] } },
    );
    const orphans = orphanKeys(result);
    expect(orphans).not.toContain("REP-9");
  });
});
