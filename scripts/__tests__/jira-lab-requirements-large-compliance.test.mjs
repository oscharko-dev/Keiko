// W8: the existing Chat journey is judged against independent native GET pages, never against
// report findings as truth. No Jira, model, server or laboratory process is started here.
import { Buffer } from "node:buffer";
import { URL } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SCENARIOS } from "../testing/jira-chat-lab/requirements/catalog.mjs";
import { JOURNEYS } from "../testing/jira-chat-lab/requirements/journey-checks.mjs";
import * as nativeQueries from "../testing/jira-chat-lab/requirements/journeys.mjs";
import * as deviations from "../testing/jira-chat-lab/requirements/deviation-report.mjs";

const native = vi.hoisted(() => ({ issues: [], requests: [], alter: undefined }));
vi.mock("../testing/jira-chat-lab/lab-client.mjs", async (original) => ({
  ...(await original()),
  basicAuth: () => "synthetic-private-auth",
  labRequest: (_session, method, path) => {
    const url = new URL(path, "https://jira.example.invalid");
    native.requests.push({ method, path, url });
    const startAt = Number(url.searchParams.get("startAt"));
    const value = {
      startAt,
      maxResults: 100,
      total: native.issues.length,
      issues: native.issues.slice(startAt, startAt + 100),
    };
    native.alter?.(value);
    return Promise.resolve({ status: 200, value });
  },
}));

const EPIC_LINK = "customfield_10001";
const REPORT_ID = "11111111-2222-4333-8444-555555555555";
const DIGEST = "a".repeat(64);
const OBLIGATIONS = ["large-deviating-issues", "large-deviation-detail", "independent-paged-jql"];
const CHAT = { id: "synthetic-chat", jiraPodBinding: { podId: "synthetic-pod" } };

// Independent fixed population: 45 epics, 1,995 tasks, 450 bugs. Defect frequencies are the
// acceptance contract, not imported from the seed or the product template checker.
function nativeIssue(index, project) {
  const ordinal = index + 1;
  const type = ordinal <= 45 ? "Epic" : ordinal <= 2040 ? "Task" : "Bug";
  const absentParent = type === "Task" && (ordinal - 45) % 11 === 0;
  return {
    id: String(10000 + ordinal),
    key: `${project}-${ordinal}`,
    fields: {
      issuetype: { name: type },
      status: { name: "To Do", statusCategory: { key: "new" } },
      labels: ordinal % 7 === 0 ? [] : ["anforderung"],
      [EPIC_LINK]: type === "Epic" || absentParent ? null : `${project}-1`,
    },
  };
}

function truthIssue(issue) {
  const { fields } = issue;
  return {
    key: issue.key,
    type: fields.issuetype.name,
    status: fields.status.name,
    labels: [...fields.labels],
    ...(fields[EPIC_LINK] === null ? {} : { epic: fields[EPIC_LINK] }),
    deviations: [
      ...(fields.labels.length === 0 ? ["label:anforderung"] : []),
      ...(fields.issuetype.name === "Task" && fields[EPIC_LINK] === null ? ["parent"] : []),
    ],
  };
}

function entryOf(issue) {
  const label = issue.deviations.includes("label:anforderung");
  const parent = issue.deviations.includes("parent");
  return {
    key: issue.key,
    ruleIds: [...(label ? ["label-missing"] : []), ...(parent ? ["parent-missing"] : [])],
    fieldIds: [...(label ? ["labels"] : []), ...(parent ? [EPIC_LINK] : [])],
    details: issue.deviations.map((code) => (code === "parent" ? "Epic fehlt" : "Label fehlt")),
  };
}

function exchange(data, args, id) {
  return {
    call: { id, name: "jira_report", arguments: args },
    result: {
      toolRef: { canonicalId: "keiko.jira.report", contractVersion: 1 },
      status: "completed",
      data: { outcome: "succeeded", status: "complete", reportId: REPORT_ID, ...data },
    },
  };
}

function reportExchanges(issues, project) {
  const items = issues
    .filter((issue) => issue.deviations.length > 0)
    .map((issue) => entryOf(issue));
  const identity = {
    digest: DIGEST,
    generatedAt: "2026-11-08T00:00:00Z",
    completeness: {
      complete: true,
      issuesRead: issues.length,
      issuesTotal: issues.length,
      pageCount: 25,
    },
  };
  const first = exchange(
    {
      report: {
        ...identity,
        scope: { projectKey: project },
        compliance: {
          checker: "applied",
          requiredFieldRules: "applied",
          issuesChecked: issues.length,
          issuesJudged: issues.length,
          issuesWithoutTemplate: 0,
          withoutTemplateByType: [],
          issuesWithDeviations: items.length,
          deviationCount: 536,
          deviations: {
            total: items.length,
            items: items.slice(0, 15),
            section: "deviations",
            nextStartAt: 15,
          },
        },
      },
    },
    { projectKey: project },
    "report-summary",
  );
  const pages = Array.from({ length: Math.ceil((items.length - 15) / 100) }, (_, index) => {
    const startAt = 15 + index * 100;
    const rows = items.slice(startAt, startAt + 100);
    const section = { name: "deviations", startAt, total: items.length, items: rows };
    if (startAt + rows.length < items.length) section.nextStartAt = startAt + rows.length;
    return exchange(
      { report: structuredClone(identity), section },
      { reportId: REPORT_ID, section: "deviations", startAt, maxResults: 100 },
      `report-page-${index}`,
    );
  });
  return [first, ...pages];
}

function fixture(project = "LRG") {
  native.issues = Array.from({ length: 2490 }, (_, index) => nativeIssue(index, project));
  const issues = native.issues.map((issue) => truthIssue(issue));
  const turn = {
    answer: issues
      .filter((issue) => issue.deviations.length > 0)
      .map(
        (issue) =>
          `${issue.key}: ${issue.deviations.map((code) => (code === "parent" ? "Epic-Zuordnung fehlt" : "Label anforderung fehlt")).join("; ")}`,
      )
      .join("\n"),
    toolExchanges: reportExchanges(issues, project),
    durationMs: 1000,
    toolCalls: 6,
  };
  const imports = [];
  const deletes = [];
  let turns = 0;
  const ctx = {
    truth: {
      projects: { large: project },
      large: {
        seedVersion: 2,
        project,
        issueCount: 2490,
        fieldIds: { epicLink: EPIC_LINK },
        templateScope: { issueTypes: ["Epic", "Task", "Bug"] },
        issues,
      },
    },
    turn: () => {
      turns += 1;
      return Promise.resolve(turn);
    },
    searchPages: (query, fields) => nativeQueries.pagedJql({}, query, fields),
    http: (name, path, body) => {
      if (name === "template-import") {
        imports.push(Buffer.from(body.contentBase64, "base64").toString("utf8"));
        return Promise.resolve({ skill: { id: `skill-${imports.length}`, revision: 1 } });
      }
      if (name === "template-delete") deletes.push(path);
      return Promise.resolve(null);
    },
  };
  return { ctx, turn, imports, deletes, turns: () => turns, run: () => JOURNEYS.S11b(ctx, CHAT) };
}

function subtaskFixture() {
  const f = fixture();
  const truth = f.ctx.truth.large;
  for (const ordinal of [2491, 2492]) {
    const key = `LRG-${ordinal}`;
    native.issues.push({
      id: String(10000 + ordinal),
      key,
      fields: {
        issuetype: { name: "Sub-task", subtask: true },
        status: { name: "To Do", statusCategory: { key: "new" } },
        labels: [],
        parent: { key: "LRG-46" },
      },
    });
    truth.issues.push({
      key,
      type: "Sub-task",
      status: "To Do",
      labels: [],
      parent: "LRG-46",
      deviations: [],
    });
  }
  truth.issueCount = 2492;
  f.turn.toolExchanges = reportExchanges(truth.issues, truth.project);
  const compliance = f.turn.toolExchanges[0].result.data.report.compliance;
  compliance.issuesChecked = 2490;
  compliance.issuesWithoutTemplate = 2;
  compliance.withoutTemplateByType = [{ typeName: "Sub-task", count: 2 }];
  f.turn.answer += "\nVORLAGENLÜCKE;Sub-task;2";
  return { ...f, compliance };
}

beforeEach(() => {
  native.requests = [];
  native.alter = undefined;
});

describe("W8 large compliance journey S11b", () => {
  it("exports the same pure grade for a runtime project in the limit-run", async () => {
    const f = fixture("LIM7");
    expect(deviations.gradeLargeDeviationReport).toBeTypeOf("function");
    expect(nativeQueries.pagedJql).toBeTypeOf("function");
    const observed = await nativeQueries.pagedJql(
      {},
      "project = LIM7 ORDER BY key ASC",
      `issuetype,labels,${EPIC_LINK}`,
    );
    const grade = deviations.gradeLargeDeviationReport(
      f.turn.toolExchanges,
      observed,
      f.ctx.truth.large,
      f.turn.answer,
    );
    expect(grade).toMatchObject({
      status: "green",
      counts: { issues: 2490, pages: 25, deviations: 536, deviatingIssues: 510, falseFindings: 0 },
    });
  });

  it("is wired into the ordinary catalog with all three independent obligations", () => {
    expect(SCENARIOS.find((scenario) => scenario.id === "S11b")).toMatchObject({
      requirement: "AC3",
      obligations: OBLIGATIONS,
    });
    expect(JOURNEYS.S11b).toBeTypeOf("function");
  });

  it("matches exactly 510 issues and 536 deviations through actual JQL pages of 100", async () => {
    const f = fixture();
    const check = await f.run();
    expect(check.status).toBe("green");
    expect(check.covers).toEqual(OBLIGATIONS);
    expect(check.detail).toContain("510/510");
    expect(check.detail).toContain("536");
    expect(native.requests).toHaveLength(25);
    expect(native.requests.map(({ url }) => url.searchParams.get("startAt"))).toEqual(
      Array.from({ length: 25 }, (_, index) => String(index * 100)),
    );
    for (const request of native.requests) {
      expect(request.method).toBe("GET");
      expect(request.url.pathname).toBe("/rest/api/2/search");
      expect(request.url.searchParams.get("maxResults")).toBe("100");
      expect(request.url.searchParams.get("jql")).toBe("project = LRG ORDER BY key ASC");
      expect(request.url.searchParams.get("fields").split(",")).toEqual(
        expect.arrayContaining(["issuetype", "labels", EPIC_LINK]),
      );
    }
  });

  it("activates only the seeded label and Task/Epic clauses and removes all three templates", async () => {
    const f = fixture();
    expect((await f.run()).status).toBe("green");
    expect(f.imports).toHaveLength(3);
    for (const markdown of f.imports) {
      expect(markdown).toContain("project: LRG");
      expect(markdown).toContain('requiredLabels: ["anforderung"]');
      expect(markdown).not.toMatch(/summaryPattern|requiredFields|^## /mu);
      if (markdown.includes('issueType: "Task"')) {
        expect(markdown).toContain(`parentField: "${EPIC_LINK}"`);
        expect(markdown).toContain('parentIssueTypes: ["Epic"]');
      } else expect(markdown).not.toContain("parentField:");
    }
    expect(f.deletes).toEqual([
      "/api/skills/skill-3",
      "/api/skills/skill-2",
      "/api/skills/skill-1",
    ]);
  });

  it.each(["legacy", "missing-issues", "missing-paging"])(
    "credits nothing for %s evidence",
    async (kind) => {
      const f = fixture();
      if (kind === "legacy") delete f.ctx.truth.large.seedVersion;
      if (kind === "missing-issues") delete f.ctx.truth.large.issues;
      if (kind === "missing-paging") delete f.ctx.searchPages;
      const check = await f.run();
      expect(check).toMatchObject({ status: "unverified", covers: [] });
      expect(f.turns()).toBe(0);
    },
  );

  it("does not infer three native pages from a claimed report pageCount", async () => {
    const f = fixture();
    f.ctx.searchPages = () =>
      Promise.resolve({
        issues: native.issues,
        pages: [{ startAt: 0, maxResults: 100, total: 2490, count: 2490 }],
      });
    expect(await f.run()).toMatchObject({ status: "unverified", covers: [] });
  });

  it("refuses seed drift even when the answer and report agree with the stale seed", async () => {
    const f = fixture();
    native.issues[6].fields.labels = ["anforderung"];
    expect(await f.run()).toMatchObject({ status: "unverified", covers: [] });
  });

  it.each([
    "summary-only",
    "page-gap",
    "duplicate-key",
    "changed-total",
    "changed-digest",
    "changed-report",
    "incomplete",
    "foreign-scope",
  ])("does not merge away %s report evidence", async (kind) => {
    const f = fixture();
    const pages = f.turn.toolExchanges;
    if (kind === "summary-only") pages.splice(1);
    if (kind === "page-gap") pages.splice(2, 1);
    if (kind === "duplicate-key")
      pages[2].result.data.section.items[0] = structuredClone(
        pages[1].result.data.section.items[0],
      );
    if (kind === "changed-total") pages[2].result.data.section.total += 1;
    if (kind === "changed-digest") pages[2].result.data.report.digest = "b".repeat(64);
    if (kind === "changed-report")
      pages[2].result.data.reportId = "22222222-2222-4333-8444-555555555555";
    if (kind === "incomplete") pages[0].result.data.report.completeness.complete = false;
    if (kind === "foreign-scope") pages[0].result.data.report.scope.projectKey = "RPT";
    const check = await f.run();
    expect(check.status).not.toBe("green");
    expect(check.covers).toEqual([]);
  });

  it("rejects a structured false positive even when the answer omits it", async () => {
    const f = fixture();
    f.turn.toolExchanges.at(-1).result.data.section.items.at(-1).key = "LRG-1";
    expect(await f.run()).toMatchObject({ status: "red", covers: [] });
  });

  it("rejects an answer-only false positive and a missing overlapping parent finding", async () => {
    const f = fixture();
    f.turn.answer += "\nLRG-1: Label anforderung fehlt";
    expect(await f.run()).toMatchObject({ status: "red", covers: [] });
    f.turn.answer = f.turn.answer
      .replace("\nLRG-1: Label anforderung fehlt", "")
      .replace(
        "LRG-56: Label anforderung fehlt; Epic-Zuordnung fehlt",
        "LRG-56: Label anforderung fehlt",
      );
    expect(await f.run()).toMatchObject({ status: "red", covers: [] });
  });
});

describe("W8 existing independent JQL paging owner", () => {
  it.each(["total-drift", "wrong-offset", "duplicate", "empty-intermediate", "oversized-page"])(
    "refuses %s instead of claiming complete native evidence",
    async (kind) => {
      fixture();
      native.alter = (page) => {
        if (page.startAt !== 100) return;
        if (kind === "total-drift") page.total -= 1;
        if (kind === "wrong-offset") page.startAt = 101;
        if (kind === "duplicate") page.issues[0] = native.issues[0];
        if (kind === "empty-intermediate") page.issues = [];
        if (kind === "oversized-page") page.issues.push(native.issues[200]);
      };
      expect(nativeQueries.pagedJql).toBeTypeOf("function");
      await expect(
        nativeQueries.pagedJql({}, "project = LRG ORDER BY key ASC", "issuetype,labels"),
      ).rejects.toThrow(TypeError);
      expect(native.requests).toHaveLength(2);
    },
  );
});

describe("W8 explicit template scope with unregulated subtasks", () => {
  it("keeps every native issue while judging only the three declared template types", async () => {
    const f = subtaskFixture();
    expect(await f.run()).toMatchObject({ status: "green", covers: OBLIGATIONS });
    expect(native.requests).toHaveLength(25);
    expect(native.requests[0].url.searchParams.get("fields").split(",")).toContain("parent");
    expect(f.imports).toHaveLength(3);
    expect(f.imports.every((markdown) => !markdown.includes('issueType: "Sub-task"'))).toBe(true);
    const observed = await f.ctx.searchPages(
      "project = LRG ORDER BY key ASC",
      `issuetype,status,labels,parent,${EPIC_LINK}`,
    );
    const grade = deviations.gradeLargeDeviationReport(
      f.turn.toolExchanges,
      observed,
      f.ctx.truth.large,
      f.turn.answer,
    );
    expect(grade).toMatchObject({
      status: "green",
      counts: {
        issues: 2492,
        pages: 25,
        deviations: 536,
        deviatingIssues: 510,
        falseFindings: 0,
        templateCheckedIssues: 2490,
        issuesWithoutTemplate: 2,
      },
    });
  });

  it.each(["missing", "widened", "duplicate"])(
    "does not invent the %s template scope",
    async (kind) => {
      const f = fixture();
      if (kind === "missing") delete f.ctx.truth.large.templateScope;
      if (kind === "widened") f.ctx.truth.large.templateScope.issueTypes.push("Sub-task");
      if (kind === "duplicate") f.ctx.truth.large.templateScope.issueTypes.push("Task");
      expect(await f.run()).toMatchObject({ status: "unverified", covers: [] });
      expect(f.turns()).toBe(0);
    },
  );

  it.each([
    "checked-total",
    "uncovered-total",
    "wrong-type",
    "duplicate-type",
    "unjudged",
    "partial-fields",
  ])("refuses %s native coverage evidence", async (kind) => {
    const f = subtaskFixture();
    if (kind === "checked-total") f.compliance.issuesChecked = 2492;
    if (kind === "uncovered-total") f.compliance.issuesWithoutTemplate = 0;
    if (kind === "wrong-type") f.compliance.withoutTemplateByType = [{ typeName: "Bug", count: 2 }];
    if (kind === "duplicate-type")
      f.compliance.withoutTemplateByType = [
        { typeName: "Sub-task", count: 1 },
        { typeName: "Sub-task", count: 1 },
      ];
    if (kind === "unjudged") f.compliance.issuesJudged = 2490;
    if (kind === "partial-fields") f.compliance.requiredFieldRules = "partial";
    expect(await f.run()).toMatchObject({ status: "unverified", covers: [] });
  });

  it.each(["missing", "zero", "wrong-type", "duplicated"])(
    "requires an exact readable scope gap instead of %s",
    async (kind) => {
      const f = subtaskFixture();
      const rows = {
        missing: "",
        zero: "VORLAGENLÜCKE;Sub-task;0",
        "wrong-type": "VORLAGENLÜCKE;Bug;2",
        duplicated: "VORLAGENLÜCKE;Sub-task;2\nVORLAGENLÜCKE;Sub-task;2",
      };
      f.turn.answer = f.turn.answer.replace("VORLAGENLÜCKE;Sub-task;2", rows[kind]);
      expect(await f.run()).toMatchObject({ status: "red", covers: [] });
    },
  );

  it.each(["missing", "changed"])(
    "does not substitute an Epic Link for a %s native system parent",
    async (kind) => {
      const f = subtaskFixture();
      if (kind === "missing") delete native.issues.at(-1).fields.parent;
      else native.issues.at(-1).fields.parent = { key: "LRG-47" };
      expect(await f.run()).toMatchObject({ status: "unverified", covers: [] });
    },
  );

  it("rejects an invented subtask label finding while retaining all real Task findings", async () => {
    const f = subtaskFixture();
    f.turn.toolExchanges.at(-1).result.data.section.items.at(-1).key = "LRG-2491";
    expect(await f.run()).toMatchObject({ status: "red", covers: [] });
  });
});
