// The large seeded project LRG and the large-project step of S10 (epic #4173, #4174, #4181 AC1):
// the plan and its recorded truth, the JQL oracle, and the step graded with stubbed turns against an
// in-memory Jira. The report fixtures come from the product's own producers in the built packages;
// the answer lines come from the oracle's own truth, never from a restated formula.
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LARGE_PROJECT,
  LARGE_SHAPE,
  gradeReportFigures,
  largeJiraFigures,
  largePlan,
  largeProjectPart,
  largeTruth,
  matchesSeededTruth,
} from "../testing/jira-chat-lab/requirements/large-project.mjs";
import { JOURNEYS } from "../testing/jira-chat-lab/requirements/journey-checks.mjs";
import { SCENARIOS } from "../testing/jira-chat-lab/requirements/catalog.mjs";

const PACKAGES = join(import.meta.dirname, "..", "..", "packages");
const load = (path) => import(pathToFileURL(join(PACKAGES, path)).href);
const { buildJiraReport } = await load("keiko-connectors/dist/jira-report-aggregate.js");
const { jiraReportSummary, jiraReportSectionPage } = await load(
  "keiko-connectors/dist/jira-report-result.js",
);

// ---------- the plan ----------

describe("the large project plan", () => {
  const plan = largePlan();

  it("holds about 2,500 issues of three types and every status, and is deterministic", () => {
    expect(plan.length).toBeGreaterThanOrEqual(2400);
    expect(plan.length).toBeLessThanOrEqual(2600);
    expect(largePlan()).toEqual(plan);
    expect(new Set(plan.map((item) => item.type))).toEqual(new Set(["Epic", "Task", "Bug"]));
    const members = plan.filter((item) => item.type !== "Epic");
    expect(new Set(members.map((item) => item.status))).toEqual(
      new Set(["To Do", "In Progress", "Done"]),
    );
  });

  it("accounts for every linked member and orphan and gives epics different figures", () => {
    const truth = largeTruth(
      plan,
      plan.map((_, index) => `${LARGE_PROJECT}-${index + 1}`),
      {},
    );
    expect(truth.epics).toHaveLength(LARGE_SHAPE.epics);
    const orphans = plan.filter((item) => item.type === "Task" && item.epic === undefined);
    expect(orphans).toHaveLength(181);
    expect(truth.epics.reduce((sum, epic) => sum + epic.members, 0) + orphans.length).toBe(
      plan.filter((item) => item.type !== "Epic").length,
    );
    expect(new Set(truth.epics.map((epic) => `${epic.members}/${epic.done}`)).size).toBeGreaterThan(
      LARGE_SHAPE.epics / 2,
    );
    expect(truth.counts.reduce((sum, entry) => sum + entry.count, 0)).toBe(truth.issueCount);
    expect(plan.filter((item) => item.type === "Bug").every((item) => item.epic >= 0)).toBe(true);
    expect(
      plan
        .filter((item) => item.type === "Task" && !item.deviations.includes("parent"))
        .every((item) => item.epic >= 0),
    ).toBe(true);
  });

  it("refuses a key list that does not match the plan", () => {
    expect(() => largeTruth(plan, ["LRG-1"], {})).toThrow(TypeError);
  });

  it("W7 seeds exactly every seventh label and every eleventh task parent as deviations", () => {
    let taskOrdinal = 0;
    plan.forEach((item, index) => {
      if (item.type === "Task") taskOrdinal += 1;
      const missingLabel = (index + 1) % 7 === 0;
      const missingParent = item.type === "Task" && taskOrdinal % 11 === 0;
      expect(item.labels).toEqual(missingLabel ? [] : ["anforderung"]);
      expect(item.deviations).toEqual([
        ...(missingLabel ? ["label:anforderung"] : []),
        ...(missingParent ? ["parent"] : []),
      ]);
      if (item.type !== "Epic") expect(item.epic === undefined).toBe(missingParent);
    });
    expect(taskOrdinal).toBe(1995);
    expect(plan.filter((item) => item.deviations.includes("label:anforderung"))).toHaveLength(355);
    expect(plan.filter((item) => item.deviations.includes("parent"))).toHaveLength(181);
    expect(plan.filter((item) => item.deviations.length === 2)).toHaveLength(26);
    expect(plan.filter((item) => item.deviations.length > 0)).toHaveLength(510);
  });

  it("W7 records all version-two issue facts without inventing epic parents for orphans", () => {
    const keys = plan.map((_, index) => `${LARGE_PROJECT}-${index + 1}`);
    const truth = largeTruth(plan, keys, { epicLink: "customfield_10001" });
    expect(truth.seedVersion).toBe(2);
    expect(truth.issues).toHaveLength(2490);
    expect(truth.issues).toEqual(
      plan.map((item, index) => ({
        key: keys[index],
        type: item.type,
        status: item.status,
        labels: item.labels,
        ...(item.epic === undefined ? {} : { epic: keys[item.epic] }),
        deviations: item.deviations,
      })),
    );
    expect(truth.issues[55]).toEqual({
      key: "LRG-56",
      type: "Task",
      status: "In Progress",
      labels: [],
      deviations: ["label:anforderung", "parent"],
    });
    const orphanKeys = new Set(
      truth.issues.filter((item) => item.deviations.includes("parent")).map((item) => item.key),
    );
    expect(orphanKeys.size).toBe(181);
    expect(truth.epics.reduce((sum, epic) => sum + epic.members, 0) + orphanKeys.size).toBe(2445);
    expect(truth.counts.reduce((sum, entry) => sum + entry.count, 0)).toBe(2490);
  });

  it("is a separate obligation of S10 that the existing ones do not replace", () => {
    const s10 = SCENARIOS.find((scenario) => scenario.id === "S10");
    expect(s10.obligations).toEqual([
      "counts-by-type-status",
      "per-epic-progress",
      "estimate-totals",
      "large-project-report",
      "unavailable-metrics-labelled",
    ]);
  });
});

// ---------- an in-memory Jira and the product's own report ----------

const SMALL = { epics: 4, tasksBase: 5, taskSpread: 3, taskStep: 2, bugsBase: 2, bugSpread: 2 };
const KEY_OF = (index) => `${LARGE_PROJECT}-${index + 1}`;
const CATEGORY_KEY = { "To Do": "new", "In Progress": "indeterminate", Done: "done" };
const FIELD_IDS = { epicLink: "customfield_10001", epicName: "customfield_10000" };

function worldOf(shape) {
  const plan = largePlan(shape);
  const keys = plan.map((_, index) => KEY_OF(index));
  return {
    plan,
    keys,
    large: largeTruth(plan, keys, FIELD_IDS),
    issues: plan.map((item, index) => ({
      key: keys[index],
      type: item.type,
      status: item.status,
      summary: item.summary,
      epicKey: item.epic === undefined ? undefined : keys[item.epic],
    })),
  };
}

/** The JQL forms the oracle sends, evaluated over the in-memory project. */
function clauseMatches(issue, clause) {
  const text = (pattern) => pattern.exec(clause)?.[1];
  if (clause === `project = ${LARGE_PROJECT}`) return true;
  if (text(/^issuetype = "(.+)"$/u) !== undefined)
    return issue.type === text(/^issuetype = "(.+)"$/u);
  if (text(/^status = "(.+)"$/u) !== undefined) return issue.status === text(/^status = "(.+)"$/u);
  const category = text(/^statusCategory = "?([^"]+)"?$/u);
  if (category !== undefined) return issue.status === category;
  const epic = text(/^"Epic Link" = (\S+)$/u);
  if (epic !== undefined) return issue.epicKey === epic;
  throw new TypeError(`Unexpected JQL clause ${clause}`);
}
const countOf = (issues) => async (jql) =>
  issues.filter((issue) => jql.split(" AND ").every((clause) => clauseMatches(issue, clause)))
    .length;

function productReport(issues, estimateScope = { estimateUnit: "points" }) {
  return buildJiraReport({
    issues: issues.map((issue) => ({
      key: issue.key,
      typeName: issue.type,
      subtask: false,
      summary: issue.summary,
      statusName: issue.status,
      category: CATEGORY_KEY[issue.status],
      parentKey: issue.epicKey,
      linkedKeys: [],
      assigned: false,
      dueDate: undefined,
      estimate: undefined,
      deviations: [],
      templateJudged: false,
      requiredJudged: false,
      requirementIds: [],
      labels: [],
    })),
    scope: {
      projectKey: LARGE_PROJECT,
      jql: `project = ${LARGE_PROJECT}`,
      ...estimateScope,
      asOf: "2026-11-02",
      timeZone: "UTC",
    },
    completeness: {
      complete: true,
      issuesRead: issues.length,
      issuesTotal: issues.length,
      pageCount: 1,
    },
    hierarchy: {
      discovery: "complete",
      fieldCount: 1,
      observedFieldCount: 1,
      rejectedFieldCount: 0,
      inferredFieldCount: 0,
    },
    requiredFieldRules: "not-requested",
    checker: "none",
    declaredRequirements: [],
    now: new Date("2026-11-02T00:00:00Z"),
  });
}

const exchange = (data) => ({
  call: { id: "call-report", name: "jira_report", arguments: {} },
  result: {
    toolRef: { canonicalId: "keiko.jira.report", contractVersion: 1 },
    status: "completed",
    data: { outcome: "succeeded", status: "complete", reportId: "report-1", ...data },
  },
});
const summaryExchange = (report, mutate = (summary) => summary) =>
  exchange({ report: mutate(jiraReportSummary(report)) });

/** The answer lines of the S10 format for exactly the figures the oracle derives. */
function answerLines(world, change = (lines) => lines) {
  const counts = world.large.counts.map(
    ({ type, status, count }) => `ANZAHL;${type};${status};${count}`,
  );
  const epics = world.large.epics.map(({ key, members, done }) => `EPIC;${key};${members};${done}`);
  return change([...counts, ...epics]).join("\n");
}

function stepContext(world, { answer, exchanges, jira = world.issues, extra = {} }) {
  const turns = [];
  return {
    turns,
    truth: { large: world.large, fieldIds: {} },
    count: countOf(jira),
    freshChat: async () => ({ id: "second-chat" }),
    turn: async (chat, prompt) => {
      turns.push({ chat, prompt });
      return { answer, toolExchanges: exchanges, failure: undefined, durationMs: 1, toolCalls: 1 };
    },
    ...extra,
  };
}

describe("the independent Jira read of the large project", () => {
  const world = worldOf(SMALL);

  it("counts by JQL alone what the plan recorded", async () => {
    const jira = await largeJiraFigures(countOf(world.issues), world.large);
    expect(jira.total).toBe(world.large.issueCount);
    expect(matchesSeededTruth(jira, world.large)).toBe(true);
    expect(jira.category.Done).toBe(world.issues.filter((issue) => issue.status === "Done").length);
  });

  it("notices a project that no longer holds what was seeded", async () => {
    const moved = world.issues.findIndex(
      (issue) => issue.type !== "Epic" && issue.status !== "Done",
    );
    const drifted = world.issues.map((issue, index) =>
      index === moved ? { ...issue, status: "Done" } : issue,
    );
    const jira = await largeJiraFigures(countOf(drifted), world.large);
    expect(matchesSeededTruth(jira, world.large)).toBe(false);
  });

  it("W7 keeps orphan tasks in project progress and detects an invented epic membership", async () => {
    const orphans = world.issues.filter(
      (issue) => issue.type === "Task" && issue.epicKey === undefined,
    );
    expect(orphans).toHaveLength(2);
    const jira = await largeJiraFigures(countOf(world.issues), world.large);
    expect(jira.total).toBe(40);
    expect([...jira.epics.values()].reduce((sum, epic) => sum + epic.total, 0)).toBe(34);
    expect(matchesSeededTruth(jira, world.large)).toBe(true);
    expect(
      gradeReportFigures([summaryExchange(productReport(world.issues))], jira).problems,
    ).toEqual([]);
    const drifted = world.issues.map((issue) =>
      issue.key === orphans[0].key ? { ...issue, epicKey: world.keys[0] } : issue,
    );
    const changed = await largeJiraFigures(countOf(drifted), world.large);
    expect(changed.total).toBe(jira.total);
    expect(changed.byStatus).toEqual(jira.byStatus);
    expect(matchesSeededTruth(changed, world.large)).toBe(false);
    expect(
      gradeReportFigures([summaryExchange(productReport(drifted))], jira).problems.length,
    ).toBeGreaterThan(0);
  });
});

describe("the figures of the completed report", () => {
  const world = worldOf(SMALL);
  const report = productReport(world.issues);
  const jiraOf = () => largeJiraFigures(countOf(world.issues), world.large);

  it("equal Jira when the report is the product's own for the project", async () => {
    const graded = gradeReportFigures([summaryExchange(report)], await jiraOf());
    expect(graded.problems).toEqual([]);
    expect(graded.epicsStated).toBe(SMALL.epics);
  });

  it("are undefined when the turn holds no complete report of the project", async () => {
    const jira = await jiraOf();
    expect(gradeReportFigures([], jira)).toBeUndefined();
    const reading = exchange({ report: jiraReportSummary(report), status: "reading" });
    expect(gradeReportFigures([reading], jira)).toBeUndefined();
    const other = summaryExchange(report, (summary) => ({
      ...summary,
      scope: { ...summary.scope, projectKey: "RPT" },
    }));
    expect(gradeReportFigures([other], jira)).toBeUndefined();
  });

  it.each([
    [
      "a wrong done total",
      (summary) => ({
        ...summary,
        progress: { ...summary.progress, project: { ...summary.progress.project, done: 1 } },
      }),
      "done",
    ],
    [
      "a wrong type count",
      (summary) => ({
        ...summary,
        progress: {
          ...summary.progress,
          byType: summary.progress.byType.map((entry) => ({ ...entry, total: entry.total + 1 })),
        },
      }),
      "issues",
    ],
    [
      "a wrong epic member count",
      (summary) => ({
        ...summary,
        epics: {
          ...summary.epics,
          items: summary.epics.items.map((epic, index) =>
            index === 0 ? { ...epic, members: { ...epic.members, total: 99 } } : epic,
          ),
        },
      }),
      "stated twice",
    ],
    [
      "a wrong epic line in the plain figures",
      (summary) => ({
        ...summary,
        figures: summary.figures.replace(`${KEY_OF(0)};Epic;`, `${KEY_OF(0)};Epic;9`),
      }),
      "instead of",
    ],
    [
      "a missing epic count",
      (summary) => ({ ...summary, epics: { ...summary.epics, total: 3 } }),
      "epics 3",
    ],
    [
      "an incomplete read",
      (summary) => ({
        ...summary,
        completeness: { ...summary.completeness, issuesRead: summary.completeness.issuesRead - 1 },
      }),
      "issues read",
    ],
  ])("differ for %s", async (_name, mutate, expected) => {
    const graded = gradeReportFigures([summaryExchange(report, mutate)], await jiraOf());
    expect(graded.problems.length).toBeGreaterThan(0);
    expect(graded.problems.join(" ")).toContain(expected);
  });

  it("do not count an epic the report leaves out of every list", async () => {
    const summary = jiraReportSummary(report);
    const bare = { ...summary, figures: "", epics: { ...summary.epics, items: [] } };
    const graded = gradeReportFigures([exchange({ report: bare })], await jiraOf());
    expect(graded.problems.filter((problem) => problem.endsWith("not stated"))).toHaveLength(
      SMALL.epics,
    );
  });

  it("take the epics of a section page of the very same report", async () => {
    const summary = jiraReportSummary(report);
    const bare = { ...summary, figures: "", epics: { ...summary.epics, items: [] } };
    const page = (digest) =>
      exchange({
        report: { digest },
        section: jiraReportSectionPage(report, "epics", 0, 100),
      });
    const jira = await jiraOf();
    const same = gradeReportFigures([exchange({ report: bare }), page(report.digest)], jira);
    expect(same.problems).toEqual([]);
    const foreign = gradeReportFigures([exchange({ report: bare }), page("0".repeat(64))], jira);
    expect(foreign.problems.filter((problem) => problem.endsWith("not stated"))).toHaveLength(
      SMALL.epics,
    );
  });
});

// S10, Gemma: a turn that opened the report with its status and epic sections and read no summary.
describe("the figures of a report read through its sections", () => {
  const world = worldOf(SMALL);
  const report = productReport(world.issues);
  const jiraOf = () => largeJiraFigures(countOf(world.issues), world.large);
  const sectionExchange = (name, { projectKey = LARGE_PROJECT, mutate = (page) => page } = {}) => ({
    ...exchange({
      report: { completeness: jiraReportSummary(report).completeness, digest: report.digest },
      section: mutate(jiraReportSectionPage(report, name, 0, 100)),
    }),
    call: { id: `call-${name}`, name: "jira_report", arguments: { projectKey, section: name } },
  });

  it("equal Jira when both sections are the product's own for the project", async () => {
    const graded = gradeReportFigures(
      [sectionExchange("statuses"), sectionExchange("epics")],
      await jiraOf(),
    );
    expect(graded.problems).toEqual([]);
    expect(graded.epicsStated).toBe(SMALL.epics);
  });

  it("credit nothing without both sections of this project", async () => {
    const jira = await jiraOf();
    expect(gradeReportFigures([sectionExchange("statuses")], jira)).toBeUndefined();
    expect(gradeReportFigures([sectionExchange("epics")], jira)).toBeUndefined();
    const other = { projectKey: "RPT" };
    expect(
      gradeReportFigures(
        [sectionExchange("statuses", other), sectionExchange("epics", other)],
        jira,
      ),
    ).toBeUndefined();
  });

  it.each([
    ["a wrong status total", "statuses", 0, (item) => ({ ...item, total: item.total + 1 })],
    ["a wrong epic count", "epics", 0, (item) => ({ ...item, members: { total: 99, done: 0 } })],
  ])("differ for %s", async (_name, section, index, change) => {
    const mutate = (page) => ({
      ...page,
      items: page.items.map((item, position) => (position === index ? change(item) : item)),
    });
    const exchanges = ["statuses", "epics"].map((name) =>
      sectionExchange(name, name === section ? { mutate } : {}),
    );
    expect(gradeReportFigures(exchanges, await jiraOf()).problems.length).toBeGreaterThan(0);
  });

  it("differ when a row is missing", async () => {
    const mutate = (page) => ({ ...page, items: page.items.slice(1) });
    const graded = gradeReportFigures(
      [sectionExchange("statuses", { mutate }), sectionExchange("epics")],
      await jiraOf(),
    );
    expect(graded.problems.join(" ")).toContain("type/status rows");
    const withoutEpic = gradeReportFigures(
      [sectionExchange("statuses"), sectionExchange("epics", { mutate })],
      await jiraOf(),
    );
    expect(withoutEpic.problems.join(" ")).toContain("not stated");
  });
});

describe("the large-project step", () => {
  const world = worldOf(SMALL);
  const exchanges = [summaryExchange(productReport(world.issues))];

  it("is green and covers its own obligation when report and answer equal Jira", async () => {
    const ctx = stepContext(world, { answer: answerLines(world), exchanges });
    const { part, turn } = await largeProjectPart(ctx);
    expect(part).toMatchObject({ status: "green", covers: ["large-project-report"] });
    expect(ctx.turns).toHaveLength(1);
    expect(ctx.turns[0].chat).toEqual({ id: "second-chat" });
    expect(ctx.turns[0].prompt).toContain(`Jira-Projekts ${LARGE_PROJECT}`);
    expect(ctx.turns[0].prompt).not.toContain("SCHÄTZUNG");
    expect(turn.durationMs).toBe(1);
  });

  it.each([
    [
      "a wrong epic line",
      (lines) => lines.map((line) => line.replace(/^(EPIC;[^;]+);\d+/u, "$1;1")),
    ],
    [
      "a missing epic line",
      (lines) => lines.filter((line) => !line.startsWith(`EPIC;${KEY_OF(0)};`)),
    ],
    [
      "a wrong type/status line",
      (lines) => lines.map((line) => line.replace(/^(ANZAHL;Task;Done);\d+/u, "$1;1")),
    ],
    ["an invented epic", (lines) => [...lines, "EPIC;LRG-999;1;0"]],
  ])("is red for %s in the answer although the report is right", async (_name, change) => {
    const ctx = stepContext(world, { answer: answerLines(world, change), exchanges });
    const { part } = await largeProjectPart(ctx);
    expect(part.status).toBe("red");
  });

  it("is red when the answer is right but the report states another figure", async () => {
    const wrong = [
      summaryExchange(productReport(world.issues), (summary) => ({
        ...summary,
        progress: { ...summary.progress, project: { ...summary.progress.project, done: 0 } },
      })),
    ];
    const { part } = await largeProjectPart(
      stepContext(world, { answer: answerLines(world), exchanges: wrong }),
    );
    expect(part.status).toBe("red");
  });

  it("is unverified and covers nothing without a complete report of the project", async () => {
    const { part } = await largeProjectPart(
      stepContext(world, { answer: answerLines(world), exchanges: [] }),
    );
    expect(part).toMatchObject({ status: "unverified", covers: [] });
    expect(part.detail).toContain("no complete jira.report");
  });

  it("is unverified when Jira no longer holds what the seed recorded", async () => {
    const drifted = world.issues.slice(0, -1);
    const { part } = await largeProjectPart(
      stepContext(world, { answer: answerLines(world), exchanges, jira: drifted }),
    );
    expect(part).toMatchObject({ status: "unverified", covers: [] });
    expect(part.detail).toContain("drifted");
  });

  it("sends no turn and credits nothing in a laboratory without the large project", async () => {
    const ctx = stepContext(world, { answer: "", exchanges });
    ctx.truth = { fieldIds: {} };
    const { part, turn } = await largeProjectPart(ctx);
    expect(part).toMatchObject({ status: "unverified", covers: [] });
    expect(part.detail).toContain("--only LRG");
    expect(ctx.turns).toHaveLength(0);
    expect(turn.toolCalls).toBe(0);
  });

  it("credits nothing when the context offers no second Chat or JQL count", async () => {
    const noChat = stepContext(world, { answer: "", exchanges, extra: { freshChat: undefined } });
    expect((await largeProjectPart(noChat)).part.covers).toEqual([]);
    const noCount = stepContext(world, { answer: "", exchanges, extra: { count: undefined } });
    expect((await largeProjectPart(noCount)).part.covers).toEqual([]);
  });
});

describe("S10 with the large project", () => {
  const world = worldOf(SMALL);
  const RPT_ANSWER = ["ANZAHL;Epic;To Do;1", "EPIC;RPT-1;0;0"].join("\n");
  const rptIssue = {
    key: "RPT-1",
    fields: {
      issuetype: { name: "Epic" },
      status: { name: "To Do", statusCategory: { key: "new" } },
    },
  };
  const s10 = (answers, truth) => {
    let turns = 0;
    const responses = [
      { answer: answers[0], toolExchanges: [] },
      { answer: answers[1], toolExchanges: [summaryExchange(productReport(world.issues))] },
      {
        answer: "SCHÄTZUNG;NICHT_VERFÜGBAR;field-not-found\nSCOPE-LÜCKE;SCHÄTZUNG;field-not-found",
        toolExchanges: [
          summaryExchange(
            productReport(world.issues, {
              estimateUnit: "unavailable",
              estimateSource: "unavailable",
              estimateUnavailableReason: "field-not-found",
            }),
          ),
        ],
      },
    ];
    return JOURNEYS.S10(
      {
        truth: { fieldIds: { epicLink: "customfield_10001" }, ...truth },
        search: async () => [rptIssue],
        count: countOf(world.issues),
        freshChat: async () => ({ id: "second-chat" }),
        turn: async () => ({
          ...responses[turns++],
          failure: undefined,
          durationMs: 1000,
          toolCalls: 1,
        }),
      },
      { id: "chat" },
    );
  };

  it("covers the large-project obligation next to the existing ones when both are exact", async () => {
    const check = await s10([RPT_ANSWER, answerLines(world)], { large: world.large });
    expect(check.status).toBe("green");
    expect(check.covers).toEqual([
      "counts-by-type-status",
      "per-epic-progress",
      "large-project-report",
      "unavailable-metrics-labelled",
    ]);
  });

  it("keeps the existing grades unrelaxed: a wrong RPT answer is red whatever LRG says", async () => {
    const check = await s10(["ANZAHL;Epic;To Do;2", answerLines(world)], { large: world.large });
    expect(check.status).toBe("red");
  });

  it("is red when only the large project fails", async () => {
    const check = await s10([RPT_ANSWER, "ANZAHL;Epic;To Do;1"], { large: world.large });
    expect(check.status).toBe("red");
  });

  it("leaves the large-project obligation uncovered in a laboratory without LRG", async () => {
    const check = await s10([RPT_ANSWER], {});
    expect(check.status).toBe("green");
    expect(check.covers).not.toContain("large-project-report");
  });
});
