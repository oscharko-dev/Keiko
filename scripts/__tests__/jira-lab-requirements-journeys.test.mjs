// Journey checks S01, S02, S06, S10, S12 and S13 of the requirements lab (epic #4173): the graders
// are exercised with stubbed turns, an in-memory Jira and an in-memory skill library, never with
// Keiko or Jira. Fixtures that mirror a product format (template front matter, report exports,
// comment text) come from the product's own producers in the built packages.
import { Buffer } from "node:buffer";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCorpus, STRUCTURE_RULES } from "../testing/jira-chat-lab/requirements/corpus.mjs";
import { JOURNEYS } from "../testing/jira-chat-lab/requirements/journey-checks.mjs";
import {
  complianceFieldIds,
  parseProgressAnswer,
  progressTruth,
} from "../testing/jira-chat-lab/requirements/progress-report.mjs";
import { parseCsv } from "../testing/jira-chat-lab/requirements/report-export.mjs";
import {
  EPIC_SUMMARY_PATTERN,
  epicTemplateMarkdown,
  proposedSections,
  templateMarkdown,
} from "../testing/jira-chat-lab/requirements/templates.mjs";

const PACKAGES = join(import.meta.dirname, "..", "..", "packages");
const load = (path) => import(pathToFileURL(join(PACKAGES, path)).href);
const { parseJiraIssueTemplate, compileJiraTemplatePattern } = await load(
  "keiko-contracts/dist/jira-issue-template.js",
);
const { renderProposedJiraIssueTemplate } = await load(
  "keiko-connectors/dist/jira-issue-template-instance.js",
);
const { exportJiraReport, jiraReportCommentText } = await load(
  "keiko-connectors/dist/jira-report-export.js",
);

const FIELDS = { epicLink: "customfield_10001", storyPoints: "customfield_10002" };
const wiki = (sections) => sections.map((name) => `h3. ${name}\nInhalt.`).join("\n\n");
const CATEGORY = { "To Do": "new", "In Progress": "indeterminate", Done: "done" };
const REQUIREMENTS = buildCorpus(1).truth.map((item) => item.id);

/** One Jira issue as the search returns it. */
function issue(key, type, status, fields = {}) {
  return {
    key,
    fields: {
      issuetype: { name: type },
      status: { name: status, statusCategory: { key: CATEGORY[status] } },
      summary: `Vorgang ${key}`,
      labels: [],
      ...fields,
    },
  };
}

/** A context whose `act` runs the product's effects for one turn. */
function context({ issues = [], truth = {}, act = () => ({}), extra = {} } = {}) {
  const calls = { turns: 0 };
  return {
    calls,
    truth: { fieldIds: FIELDS, issues: [], ...truth },
    refusals: () => 0,
    search: async (query) => {
      const type = /issuetype = (\w+)/.exec(query)?.[1];
      const project = /project = (\w+)/.exec(query)?.[1];
      return issues.filter(
        (entry) =>
          entry.key.startsWith(`${project}-`) &&
          (type === undefined || entry.fields.issuetype.name === type),
      );
    },
    turn: async () => {
      calls.turns += 1;
      const { answer = "", toolExchanges = [], writes = 0 } = act();
      return {
        answer,
        toolExchanges,
        failure: undefined,
        durationMs: 1000,
        toolCalls: toolExchanges.length,
        approvals: { reads: 1, writes },
      };
    },
    deselectSkill: () => Promise.resolve(),
    ...extra,
  };
}

const CHAT = { id: "chat", jiraPodBinding: { podId: "pod-1" } };

/** A completed `jira.report` exchange with `data`. */
const reportExchange = (data) => ({
  call: { id: "call-report", name: "jira_report", arguments: {} },
  result: {
    toolRef: { canonicalId: "keiko.jira.report", contractVersion: 1 },
    status: "completed",
    data: { outcome: "succeeded", status: "complete", reportId: REPORT_ID, ...data },
  },
});
const REPORT_ID = "11111111-2222-3333-4444-555555555555";
const DIGEST = "a".repeat(64);

// ---------- S10 ----------

describe("S10 progress of a project", () => {
  const world = [
    issue("RPT-1", "Epic", "To Do"),
    issue("RPT-2", "Epic", "Done"),
    issue("RPT-3", "Task", "Done", { [FIELDS.epicLink]: "RPT-1", [FIELDS.storyPoints]: 3 }),
    issue("RPT-4", "Task", "In Progress", { [FIELDS.epicLink]: "RPT-1", [FIELDS.storyPoints]: 2 }),
    issue("RPT-5", "Sub-task", "Done", { parent: { key: "RPT-3" } }),
    issue("RPT-6", "Bug", "To Do", { [FIELDS.epicLink]: "RPT-2" }),
    issue("RPT-7", "Task", "Done", { [FIELDS.storyPoints]: 5 }),
  ];
  const GREEN = [
    "ANZAHL;Epic;To Do;1",
    "ANZAHL;Epic;Done;1",
    "ANZAHL;Task;Done;2",
    "ANZAHL;Task;In Progress;1",
    "ANZAHL;Sub-task;Done;1",
    "ANZAHL;Bug;To Do;1",
    "EPIC;RPT-1;3;2",
    "EPIC;RPT-2;1;0",
    "SCHÄTZUNG;10;8;2",
  ];
  const grade = (lines, overrides = {}) =>
    JOURNEYS.S10(
      context({ issues: world, act: () => ({ answer: lines.join("\n") }), ...overrides }),
      CHAT,
    );
  const without = (prefix) => GREEN.filter((line) => !line.startsWith(prefix));

  it("is green and covers all three obligations for an exact answer", async () => {
    const check = await grade(GREEN);
    expect(check.status).toBe("green");
    expect(check.covers).toEqual(["counts-by-type-status", "per-epic-progress", "estimate-totals"]);
  });

  it("reads a comma decimal and ignores lines that are no data lines", async () => {
    const check = await grade([
      "Hier das Ergebnis:",
      ...GREEN.slice(0, -1),
      "SCHÄTZUNG;10,0;8,0;2,0",
    ]);
    expect(check.status).toBe("green");
  });

  it.each([
    ["a wrong epic member count", "EPIC;RPT-1;3;2", "EPIC;RPT-1;2;2"],
    ["a wrong epic done count", "EPIC;RPT-1;3;2", "EPIC;RPT-1;3;3"],
    ["a wrong estimate", "SCHÄTZUNG;10;8;2", "SCHÄTZUNG;10;5;5"],
    ["a wrong type/status count", "ANZAHL;Task;Done;2", "ANZAHL;Task;Done;3"],
  ])("is red and credits nothing for %s", async (_name, from, to) => {
    const check = await grade(GREEN.map((line) => (line === from ? to : line)));
    expect(check.status).toBe("red");
  });

  it("is red when an epic, a combination or the estimate is missing", async () => {
    expect((await grade(without("EPIC;RPT-2"))).status).toBe("red");
    expect((await grade(without("ANZAHL;Bug"))).status).toBe("red");
    expect((await grade(without("SCHÄTZUNG"))).status).toBe("red");
  });

  it("is red for an invented epic or combination and for a line stated twice differently", async () => {
    expect((await grade([...GREEN, "EPIC;RPT-99;1;0"])).status).toBe("red");
    expect((await grade([...GREEN, "ANZAHL;Story;Done;1"])).status).toBe("red");
    expect((await grade([...GREEN, "EPIC;RPT-1;4;2"])).status).toBe("red");
  });

  it("does not credit what the instance gives no input for", async () => {
    const check = await grade(without("SCHÄTZUNG"), {
      truth: { fieldIds: { epicLink: FIELDS.epicLink } },
    });
    expect(check.status).toBe("green");
    expect(check.covers).toEqual(["counts-by-type-status", "per-epic-progress"]);
    const bare = await grade(
      without("EPIC").filter((line) => !line.startsWith("SCH")),
      {
        truth: { fieldIds: {} },
      },
    );
    expect(bare.covers).toEqual(["counts-by-type-status"]);
  });

  it("asks for the estimate line only when the instance has the estimate field", async () => {
    const prompts = [];
    const ctx = context({ issues: world, truth: { fieldIds: { epicLink: FIELDS.epicLink } } });
    const turn = ctx.turn;
    ctx.turn = (chat, prompt) => {
      prompts.push(prompt);
      return turn(chat, prompt);
    };
    await JOURNEYS.S10(ctx, CHAT);
    expect(prompts[0]).toContain("EPIC;");
    expect(prompts[0]).not.toContain("SCHÄTZUNG");
  });

  it("parses decimals with a comma", () => {
    expect(parseProgressAnswer("SCHÄTZUNG;1,5;1;0,5").estimate).toEqual([1.5, 1, 0.5]);
  });
});

describe("S10 with a time-tracking estimate", () => {
  const HOUR = 3600;
  const ESTIMATE = {
    fieldId: "timeoriginalestimate",
    writeFieldId: "timetracking",
    unit: "seconds",
    label: "Original Estimate",
  };
  const truth = {
    fieldIds: { ...FIELDS, storyPoints: "timeoriginalestimate" },
    estimate: ESTIMATE,
  };
  const seconds = (hours) => ({ timeoriginalestimate: hours * HOUR });
  const world = [
    issue("RPT-1", "Epic", "To Do"),
    issue("RPT-3", "Task", "Done", { [FIELDS.epicLink]: "RPT-1", ...seconds(3) }),
    issue("RPT-4", "Task", "In Progress", { [FIELDS.epicLink]: "RPT-1", ...seconds(2) }),
    issue("RPT-7", "Task", "Done", { ...seconds(5) }),
  ];
  const BASE = [
    "ANZAHL;Epic;To Do;1",
    "ANZAHL;Task;Done;2",
    "ANZAHL;Task;In Progress;1",
    "EPIC;RPT-1;2;1",
  ];
  const grade = (estimateLine, issues = world) =>
    JOURNEYS.S10(
      context({ issues, truth, act: () => ({ answer: [...BASE, estimateLine].join("\n") }) }),
      CHAT,
    );

  it("is green for the exact hours and covers the estimate obligation", async () => {
    const check = await grade("SCHÄTZUNG;10;8;2");
    expect(check.status).toBe("green");
    expect(check.covers).toContain("estimate-totals");
  });

  it.each([
    ["the raw seconds", "SCHÄTZUNG;36000;28800;7200"],
    ["a wrong total", "SCHÄTZUNG;11;8;3"],
    ["swapped done and remaining", "SCHÄTZUNG;10;2;8"],
  ])("is red for %s", async (_name, line) => {
    expect((await grade(line)).status).toBe("red");
  });

  it("converts fractional hours exactly", async () => {
    const half = [
      issue("RPT-1", "Epic", "To Do"),
      issue("RPT-3", "Task", "Done", { [FIELDS.epicLink]: "RPT-1", timeoriginalestimate: 5400 }),
    ];
    const answer = [
      "ANZAHL;Epic;To Do;1",
      "ANZAHL;Task;Done;1",
      "EPIC;RPT-1;1;1",
      "SCHÄTZUNG;1,5;1,5;0",
    ].join("\n");
    const check = await JOURNEYS.S10(
      context({ issues: half, truth, act: () => ({ answer }) }),
      CHAT,
    );
    expect(check.status).toBe("green");
    expect(progressTruth(half, truth.fieldIds, ESTIMATE).estimate).toEqual({
      total: 1.5,
      done: 1.5,
      remaining: 0,
    });
  });

  it("names the estimate by the id it is written with in templates and compliance", () => {
    expect(complianceFieldIds(truth).storyPoints).toBe("timetracking");
    expect(complianceFieldIds({ fieldIds: FIELDS }).storyPoints).toBe(FIELDS.storyPoints);
    expect(complianceFieldIds({ fieldIds: { epicLink: "x" } })).toEqual({ epicLink: "x" });
  });

  it("keeps story points untouched when no unit is recorded", () => {
    const points = [issue("RPT-3", "Task", "Done", { [FIELDS.storyPoints]: 3 })];
    expect(progressTruth(points, FIELDS).estimate.total).toBe(3);
    expect(progressTruth(points, FIELDS, { unit: "points" }).estimate.total).toBe(3);
  });

  it("asks for hours of the Original Estimate and names the recorded field", async () => {
    const prompts = [];
    const ctx = context({ issues: world, truth });
    const turn = ctx.turn;
    ctx.turn = (chat, prompt) => {
      prompts.push(prompt);
      return turn(chat, prompt);
    };
    await JOURNEYS.S10(ctx, CHAT);
    expect(prompts[0]).toContain("in Stunden");
    expect(prompts[0]).toContain("Original Estimate");
    expect(prompts[0]).not.toContain("Story Points");
  });

  it("names the recorded story-points field in the points prompt", async () => {
    const prompts = [];
    const ctx = context({
      issues: [],
      truth: {
        estimate: { fieldId: "customfield_10002", unit: "points", label: "Aufwandspunkte" },
      },
    });
    const turn = ctx.turn;
    ctx.turn = (chat, prompt) => {
      prompts.push(prompt);
      return turn(chat, prompt);
    };
    await JOURNEYS.S10(ctx, CHAT);
    expect(prompts[0]).toContain("Aufwandspunkte");
    expect(prompts[0]).not.toContain("Stunden");
  });
});

// ---------- S12 ----------

describe("S12 requirement coverage matrix", () => {
  const OPEN = REQUIREMENTS.filter((_, index) => (index + 1) % 10 === 0);
  const covered = REQUIREMENTS.filter((id) => !OPEN.includes(id));
  const keyOf = (id) => `RPT-${REQUIREMENTS.indexOf(id) + 1}`;
  const issues = covered.map((id) =>
    issue(keyOf(id), "Task", "Done", { summary: `Umsetzung ${id} Schritt 1` }),
  );
  const row = (id, keys) => `${id};${keys.length > 0 ? "ABGEDECKT" : "OFFEN"};${keys.join(", ")}`;
  const ANSWER = REQUIREMENTS.map((id) => row(id, OPEN.includes(id) ? [] : [keyOf(id)])).join("\n");
  const item = (id) => ({
    id,
    covered: true,
    coveredBy: [keyOf(id)],
    coveredByTotal: 1,
  });
  const summary = (ids) =>
    reportExchange({
      report: {
        digest: DIGEST,
        coverage: {
          requirements: {
            declared: REQUIREMENTS.length,
            covered: covered.length,
            uncovered: { total: OPEN.length, items: OPEN },
            items: { total: ids.length, items: ids.map((id) => item(id)) },
          },
        },
      },
    });
  const page = (ids) =>
    reportExchange({
      section: {
        name: "requirements",
        items: ids.map((id) => (OPEN.includes(id) ? { id, covered: false } : item(id))),
      },
    });
  const TOOL = [summary(covered.slice(0, 15)), page(REQUIREMENTS)];
  const ctxOf = (answer, toolExchanges = TOOL, extra = {}) =>
    context({
      issues,
      truth: { uncoveredRequirements: OPEN },
      act: () => ({ answer, toolExchanges }),
      ...extra,
    });

  it("is green when the answer and the tool state what Jira holds", async () => {
    const check = await JOURNEYS.S12(ctxOf(ANSWER), CHAT);
    expect(check.status).toBe("green");
    expect(check.covers).toEqual(["coverage-matrix", "uncovered-requirements"]);
  });

  it("is red when a requirement is open in the answer but named in Jira", async () => {
    const wrong = ANSWER.replace(row(covered[0], [keyOf(covered[0])]), `${covered[0]};OFFEN;`);
    expect((await JOURNEYS.S12(ctxOf(wrong), CHAT)).status).toBe("red");
  });

  it("is red when the answer names a different issue or leaves out the covering issues", async () => {
    const other = ANSWER.replace(keyOf(covered[0]), "RPT-999");
    expect((await JOURNEYS.S12(ctxOf(other), CHAT)).status).toBe("red");
    const bare = ANSWER.replace(row(covered[1], [keyOf(covered[1])]), `${covered[1]};ABGEDECKT;`);
    expect((await JOURNEYS.S12(ctxOf(bare), CHAT)).status).toBe("red");
  });

  it("is red when an open requirement is called covered or a requirement is missing", async () => {
    const claimed = ANSWER.replace(`${OPEN[0]};OFFEN;`, `${OPEN[0]};ABGEDECKT;RPT-1`);
    expect((await JOURNEYS.S12(ctxOf(claimed), CHAT)).status).toBe("red");
    const missing = ANSWER.split("\n").slice(1).join("\n");
    expect((await JOURNEYS.S12(ctxOf(missing), CHAT)).status).toBe("red");
  });

  it("is red when the tool did not state a requirement the answer claims", async () => {
    const check = await JOURNEYS.S12(ctxOf(ANSWER, [summary(covered.slice(0, 15))]), CHAT);
    expect(check.status).toBe("red");
    expect(check.detail).toContain("not reported by the tool");
  });

  it("is red when the tool states a different coverage than Jira", async () => {
    const lying = page(REQUIREMENTS).result.data.section.items.map((entry) =>
      entry.id === covered[0] ? { ...entry, coveredBy: ["RPT-999"] } : entry,
    );
    const tool = [
      {
        ...page([]),
        result: {
          ...page([]).result,
          data: { ...page([]).result.data, section: { name: "requirements", items: lying } },
        },
      },
    ];
    expect(
      (await JOURNEYS.S12(ctxOf(ANSWER, [summary(covered.slice(0, 15)), ...tool]), CHAT)).status,
    ).toBe("red");
  });

  it("credits nothing without a complete report with requirement coverage", async () => {
    const none = await JOURNEYS.S12(ctxOf(ANSWER, []), CHAT);
    expect(none.status).toBe("unverified");
    expect(none.covers).toEqual([]);
    const incomplete = {
      ...TOOL[1],
      result: { ...TOOL[1].result, data: { ...TOOL[1].result.data, status: "incomplete" } },
    };
    expect((await JOURNEYS.S12(ctxOf(ANSWER, [incomplete]), CHAT)).status).toBe("unverified");
  });

  it("credits nothing when the laboratory drifted from the seeded ground truth", async () => {
    const check = await JOURNEYS.S12(
      context({
        issues,
        truth: { uncoveredRequirements: OPEN.slice(1) },
        act: () => ({ answer: ANSWER, toolExchanges: TOOL }),
      }),
      CHAT,
    );
    expect(check.status).toBe("unverified");
  });
});

// ---------- S13 ----------

describe("S13 report export and Jira comment", () => {
  const KEYS = ["RPT-1", "RPT-2", "RPT-3"];
  const rows = (keys) =>
    keys.map((key) => ({
      issue: {
        key,
        typeName: "Task",
        subtask: false,
        summary: `=Vorgang, "${key}"`,
        statusName: "To Do",
        category: "new",
        parentKey: undefined,
        linkedKeys: [],
        assigned: false,
        dueDate: undefined,
        estimate: undefined,
        deviations: [],
        requirementIds: [],
      },
      classification: "orphan",
      containerKeys: [],
      overdue: false,
    }));
  const progress = {
    total: 3,
    new: 3,
    indeterminate: 0,
    done: 0,
    noCategory: 0,
    donePercent: 0,
    estimate: { total: 0, done: 0, remaining: 0, unestimated: 3 },
  };
  const report = (keys) => ({
    digest: DIGEST,
    generatedAt: "2026-11-01T00:00:00.000Z",
    scope: {
      projectKey: "RPT",
      jql: "project = RPT",
      estimateUnit: "seconds",
      asOf: "2026-11-01",
      timeZone: "UTC",
    },
    completeness: {
      complete: true,
      issuesRead: keys.length,
      issuesTotal: keys.length,
      pageCount: 1,
    },
    hierarchy: { discovery: "complete", fieldCount: 1 },
    progress: { project: progress, byType: [], byStatus: [], unassigned: 3, overdue: 0 },
    epics: [],
    compliance: {
      requiredFieldRules: "applied",
      checker: "none",
      issuesChecked: keys.length,
      issuesWithDeviations: 0,
      deviationCount: 0,
      byRule: [],
      deviations: [],
    },
    coverage: { uncoveredEpics: [], orphans: keys, requirements: undefined },
    rows: rows(keys),
  });
  const COMMENT = jiraReportCommentText(report(KEYS));
  const TOOL = [
    reportExchange({
      report: { digest: DIGEST, completeness: { complete: true, issuesRead: 3, issuesTotal: 3 } },
    }),
    reportExchange({ section: { name: "comment", text: COMMENT } }),
  ];
  const world = KEYS.map((key) => issue(key, key === "RPT-1" ? "Epic" : "Task", "To Do"));
  const truth = { issues: [{ key: "RPT-1", type: "Epic" }] };

  function ctxOf({ comments = [{ id: "9", body: COMMENT }], files, tool = TOOL } = {}) {
    const stored = [{ id: "1", body: "alt" }];
    return context({
      issues: world,
      truth,
      act: () => {
        stored.push(...comments);
        return { toolExchanges: tool };
      },
      extra: {
        comments: async () => stored,
        exportReport: async (_chat, _id, format) =>
          files === undefined ? exportJiraReport(report(KEYS), format) : files(format),
      },
    });
  }

  it("is green for the computed comment text and exports that list exactly the issues", async () => {
    const check = await JOURNEYS.S13(ctxOf(), CHAT);
    expect(check.status).toBe("green");
    expect(check.covers).toEqual(["report-export", "jira-comment"]);
  });

  it("is red when the comment is the model's own text, even with the right digest", async () => {
    const own = `Bericht, digest ${DIGEST}: alles gut`;
    const check = await JOURNEYS.S13(ctxOf({ comments: [{ id: "9", body: own }] }), CHAT);
    expect(check.status).toBe("red");
  });

  it("is red without a new comment or with two", async () => {
    expect((await JOURNEYS.S13(ctxOf({ comments: [] }), CHAT)).status).toBe("red");
    const twice = [
      { id: "9", body: COMMENT },
      { id: "10", body: COMMENT },
    ];
    expect((await JOURNEYS.S13(ctxOf({ comments: twice }), CHAT)).status).toBe("red");
  });

  it("is red when the CSV export lacks an issue Jira holds or lists an invented one", async () => {
    for (const keys of [KEYS.slice(1), [...KEYS, "RPT-9"]]) {
      const check = await JOURNEYS.S13(
        ctxOf({ files: (format) => exportJiraReport(report(keys), format) }),
        CHAT,
      );
      expect(check.status).toBe("red");
    }
  });

  it("is red for an export of another report, a damaged file or a refused export", async () => {
    const other = (format) => ({
      ...exportJiraReport(report(KEYS), format),
      reportDigest: "b".repeat(64),
    });
    expect((await JOURNEYS.S13(ctxOf({ files: other }), CHAT)).status).toBe("red");
    const damaged = (format) => ({ ...exportJiraReport(report(KEYS), format), byteCount: 1 });
    expect((await JOURNEYS.S13(ctxOf({ files: damaged }), CHAT)).status).toBe("red");
    const refused = () => Promise.reject(new TypeError("Live Chat HTTP stage failed"));
    const check = await JOURNEYS.S13(ctxOf({ files: refused }), CHAT);
    expect(check.status).toBe("red");
    expect(check.detail).toContain("export request failed");
  });

  it("is red when the report read fewer issues than Jira holds", async () => {
    const short = [
      reportExchange({
        report: { digest: DIGEST, completeness: { complete: true, issuesRead: 2, issuesTotal: 3 } },
      }),
      TOOL[1],
    ];
    expect((await JOURNEYS.S13(ctxOf({ tool: short }), CHAT)).status).toBe("red");
  });

  it("credits nothing without a complete report in the turn", async () => {
    const check = await JOURNEYS.S13(ctxOf({ tool: [] }), CHAT);
    expect(check.status).toBe("unverified");
    expect(check.covers).toEqual([]);
  });

  it("parses the product's CSV export, quoted cells and byte order mark included", () => {
    const csv = exportJiraReport(report(KEYS), "csv").content;
    const records = parseCsv(csv);
    expect(records.filter((record) => record[0] === "issue").map((record) => record[1])).toEqual(
      KEYS,
    );
    expect(records.find((record) => record[0] === "issue")?.at(-1)).toBe(`'=Vorgang, "RPT-1"`);
  });
});

// ---------- templates: S01, S02, S06 ----------

describe("the lab's template", () => {
  it("is a template the product parses, with the structure rule's sections, labels and summary", () => {
    const parsed = parseJiraIssueTemplate(epicTemplateMarkdown("REQ"));
    expect(parsed.ok).toBe(true);
    expect(parsed.template.project).toBe("REQ");
    expect(parsed.template.issueType).toBe("Epic");
    expect(parsed.template.activations).toEqual([{ kind: "create" }]);
    expect(parsed.template.requiredSections).toEqual(STRUCTURE_RULES.Epic.sections);
    expect(parsed.template.labels.required).toEqual(STRUCTURE_RULES.Epic.labels);
    const pattern = compileJiraTemplatePattern(parsed.template.summary.pattern);
    expect(pattern.test("[LH-001] Anmeldung")).toBe(true);
    expect(pattern.test("Schnelltest")).toBe(false);
    expect(pattern.test("[LH-1] Anmeldung")).toBe(false);
  });

  it("builds a template for a type without labels or summary pattern", () => {
    const parsed = parseJiraIssueTemplate(
      templateMarkdown({ project: "rpt", issueType: "Task", rule: STRUCTURE_RULES.Task }),
    );
    expect(parsed.ok).toBe(true);
    expect(parsed.template.project).toBe("RPT");
    expect(parsed.template.requiredSections).toEqual(STRUCTURE_RULES.Task.sections);
    expect(EPIC_SUMMARY_PATTERN).toContain("LH-");
  });

  it("reads the sections of a proposal the product rendered", () => {
    const markdown = renderProposedJiraIssueTemplate({
      projectKey: "RPT",
      issueType: "Epic",
      requiredFields: [],
      sections: ["Ziel", "Quelle"],
    });
    expect(proposedSections(markdown)).toEqual(["Ziel", "Quelle"]);
  });
});

/** An in-memory skill library behind the routes the template helpers call. */
function library({ proposals = [], validation, onPropose } = {}) {
  const skills = new Map();
  let counter = 0;
  const http = async (_name, path, body, method = "POST") => {
    if (path === "/api/skills" && method === "POST") {
      counter += 1;
      const skill = { id: `skill-${counter}`, revision: 1, digest: "d" };
      skills.set(skill.id, Buffer.from(body.contentBase64, "base64").toString("utf8"));
      return { skill };
    }
    if (method === "DELETE") {
      skills.delete(decodeURIComponent(path.split("/").at(-1)));
      return null;
    }
    if (path === "/api/skills/jira-templates") {
      return {
        templates: [...skills].map(([id, markdown]) => {
          const parsed = parseJiraIssueTemplate(markdown);
          return {
            id,
            valid: parsed.ok,
            ...(parsed.ok
              ? {
                  project: parsed.template.project,
                  issueType: parsed.template.issueType,
                  activations: parsed.template.activations.map((a) => a.kind),
                }
              : {}),
          };
        }),
      };
    }
    if (path.endsWith("/validate")) {
      return validation ?? { valid: true, findings: [], checked: { project: true } };
    }
    if (path.endsWith("/propose")) {
      onPropose?.(skills);
      return { proposals };
    }
    throw new TypeError(`unexpected route ${path}`);
  };
  return { http, skills };
}

const refusal = (violations, extra = {}) => ({
  call: { id: "call-create", name: "jira_create", arguments: {} },
  result: {
    toolRef: { canonicalId: "keiko.jira.create", contractVersion: 1 },
    status: "failed",
    data: { outcome: "rejected", reason: "field-validation", violations, ...extra },
  },
});
const created = (key) => ({
  call: { id: "call-create-2", name: "jira_create", arguments: {} },
  result: {
    toolRef: { canonicalId: "keiko.jira.create", contractVersion: 1 },
    status: "completed",
    data: { outcome: "succeeded", issueKey: key, issueId: "10" },
  },
});
const VIOLATIONS = [
  { ruleId: "summary-pattern", subject: "summary", template: "REQ/Epic" },
  { ruleId: "section-missing", subject: "Ziel", template: "REQ/Epic" },
];
const epicIssue = (key, requirement, overrides = {}) =>
  issue(key, "Epic", "To Do", {
    summary: `[${requirement}] Titel`,
    description: wiki(STRUCTURE_RULES.Epic.sections),
    labels: ["anforderung"],
    ...overrides,
  });

describe("S01 template defined, activated and applied", () => {
  /** The REQ project: the turn writes the epic the stub model produces. */
  function setup({ epic = epicIssue("REQ-1", "LH-004"), http, pod = true } = {}) {
    const lib = library();
    const issues = [];
    const ctx = context({
      issues,
      act: () => {
        if (epic !== undefined) issues.push(epic);
        return { toolExchanges: [created("REQ-1")], writes: 0 };
      },
      extra: { http: http ?? lib.http },
    });
    return { ctx, lib, chat: pod ? CHAT : { id: "chat" } };
  }

  it("is green for a listed, active, valid template and a conforming epic, and removes the template", async () => {
    const { ctx, lib, chat } = setup();
    const check = await JOURNEYS.S01(ctx, chat);
    expect(check.status).toBe("green");
    expect(check.covers).toEqual(["template-defined", "template-activated", "template-applied"]);
    expect(lib.skills.size).toBe(0);
  });

  it("is red when the epic does not satisfy the template", async () => {
    const { ctx } = setup({ epic: epicIssue("REQ-1", "LH-004", { labels: [] }) });
    expect((await JOURNEYS.S01(ctx, CHAT)).status).toBe("red");
    const wrongId = setup({ epic: epicIssue("REQ-1", "LH-009") });
    expect((await JOURNEYS.S01(wrongId.ctx, CHAT)).status).toBe("red");
  });

  it("is red when the instance contradicts the template", async () => {
    const lib = library({
      validation: {
        valid: true,
        findings: [{ ruleId: "field-unavailable" }],
        checked: { project: true },
      },
    });
    const { ctx } = setup({ http: lib.http });
    expect((await JOURNEYS.S01(ctx, CHAT)).status).toBe("red");
  });

  it("is red when the library does not list the template as valid and active on create", async () => {
    const lib = library();
    const http = async (name, path, body, method) => {
      const value = await lib.http(name, path, body, method);
      return path === "/api/skills/jira-templates"
        ? { templates: value.templates.map((entry) => ({ ...entry, activations: ["edit"] })) }
        : value;
    };
    const { ctx } = setup({ http });
    expect((await JOURNEYS.S01(ctx, CHAT)).status).toBe("red");
  });

  it("credits nothing without a Jira Pod and still removes the template when the turn fails", async () => {
    const noPod = setup({ pod: false });
    const unverified = await JOURNEYS.S01(noPod.ctx, noPod.chat);
    expect(unverified.status).toBe("unverified");
    expect(noPod.lib.skills.size).toBe(0);
    const failing = setup();
    failing.ctx.turn = () => Promise.reject(new TypeError("boom"));
    await expect(JOURNEYS.S01(failing.ctx, CHAT)).rejects.toThrow("boom");
    expect(failing.lib.skills.size).toBe(0);
  });
});

describe("S06 violations repaired before any write", () => {
  const conforming = epicIssue("REQ-1", "LH-005");
  function setup({ exchanges, epics = [conforming] }) {
    const lib = library();
    const issues = [];
    const ctx = context({
      issues,
      act: () => {
        issues.push(...epics);
        return { toolExchanges: exchanges };
      },
      extra: { http: lib.http },
    });
    return { ctx, lib };
  }

  it("is green when a refusal precedes the one write and the written epic satisfies the template", async () => {
    const { ctx, lib } = setup({ exchanges: [refusal(VIOLATIONS), created("REQ-1")] });
    const check = await JOURNEYS.S06(ctx, CHAT);
    expect(check.status).toBe("green");
    expect(check.covers).toEqual(["violations-detected", "repaired-before-write"]);
    expect(lib.skills.size).toBe(0);
  });

  it("credits nothing when the gate was never exercised", async () => {
    const { ctx } = setup({ exchanges: [created("REQ-1")] });
    const check = await JOURNEYS.S06(ctx, CHAT);
    expect(check.status).toBe("unverified");
    expect(check.covers).toEqual([]);
  });

  it("does not take an unreadable library or another template's refusal for a detection", async () => {
    const unreadable = [{ ruleId: "template-unreadable", subject: "x", template: "*" }];
    const foreign = [{ ruleId: "section-missing", subject: "Ziel", template: "OTHER/Epic" }];
    for (const violations of [unreadable, foreign]) {
      const { ctx } = setup({ exchanges: [refusal(violations), created("REQ-1")] });
      expect((await JOURNEYS.S06(ctx, CHAT)).status).toBe("unverified");
    }
  });

  it("is red when a refused write carried a receipt or nothing was written after it", async () => {
    const receipt = setup({
      exchanges: [refusal(VIOLATIONS, { issueKey: "REQ-1" }), created("REQ-1")],
    });
    expect((await JOURNEYS.S06(receipt.ctx, CHAT)).status).toBe("red");
    const abandoned = setup({ exchanges: [refusal(VIOLATIONS)], epics: [] });
    expect((await JOURNEYS.S06(abandoned.ctx, CHAT)).status).toBe("red");
  });

  it("is red when a violating issue reached Jira", async () => {
    const bad = epicIssue("REQ-2", "LH-005", {
      summary: "Schnelltest",
      description: "Kurzer Test.",
    });
    const { ctx } = setup({
      exchanges: [refusal(VIOLATIONS), created("REQ-1")],
      epics: [conforming, bad],
    });
    const check = await JOURNEYS.S06(ctx, CHAT);
    expect(check.status).toBe("red");
    expect(check.detail).toContain("1 violate the template");
  });

  it("reads the failed items of a refused draft as refusals too", async () => {
    const draft = (items, status) => ({
      call: { id: "call-draft", name: "jira_draft", arguments: {} },
      result: {
        toolRef: { canonicalId: "keiko.jira.draft", contractVersion: 3 },
        status,
        data: { outcome: "rejected", items },
      },
    });
    const { ctx } = setup({
      exchanges: [
        draft(
          [
            {
              ref: "e1",
              state: "failed",
              detail: { reason: "field-validation", violations: VIOLATIONS },
            },
          ],
          "failed",
        ),
        draft([{ ref: "e1", state: "created", issueKey: "REQ-1" }], "completed"),
      ],
    });
    expect((await JOURNEYS.S06(ctx, CHAT)).status).toBe("green");
  });
});

describe("S02 template proposed from existing issues", () => {
  const proposal = (type) => ({
    issueType: type,
    sampledIssueCount: 9,
    markdown: renderProposedJiraIssueTemplate({
      projectKey: "RPT",
      issueType: type,
      requiredFields: [],
      sections: STRUCTURE_RULES[type].sections,
    }),
  });
  const PROPOSALS = ["Epic", "Task", "Bug"].map((type) => proposal(type));

  it("is green when the proposals mirror the issues, proposing activates nothing and the lead activates by defining", async () => {
    const lib = library({ proposals: PROPOSALS });
    const check = await JOURNEYS.S02(context({ extra: { http: lib.http } }), CHAT);
    expect(check.status).toBe("green");
    expect(check.covers).toEqual([
      "proposal-from-existing-issues",
      "proposal-reviewed-before-activation",
    ]);
    expect(lib.skills.size).toBe(0);
  });

  it("is red when a proposal misses a section or invents one", async () => {
    const short = PROPOSALS.map((entry) =>
      entry.issueType === "Task"
        ? { ...entry, markdown: entry.markdown.replace("## Testhinweise", "## Erfunden") }
        : entry,
    );
    const lib = library({ proposals: short });
    const check = await JOURNEYS.S02(context({ extra: { http: lib.http } }), CHAT);
    expect(check.status).toBe("red");
    expect(check.detail).toContain("missing [testhinweise] surplus [erfunden]");
  });

  it("is red when a type has no proposal or the proposal was drawn from no issue", async () => {
    for (const proposals of [
      PROPOSALS.slice(0, 2),
      PROPOSALS.map((entry) => ({ ...entry, sampledIssueCount: 0 })),
    ]) {
      const lib = library({ proposals });
      expect((await JOURNEYS.S02(context({ extra: { http: lib.http } }), CHAT)).status).toBe("red");
    }
  });

  it("is red when proposing already activated a template", async () => {
    const lib = library({
      proposals: PROPOSALS,
      onPropose: (skills) => skills.set("leak", PROPOSALS[0].markdown),
    });
    const check = await JOURNEYS.S02(context({ extra: { http: lib.http } }), CHAT);
    expect(check.status).toBe("red");
    expect(check.detail).toContain("library unchanged by proposing false");
  });

  it("is red when the proposal does not validate against the instance, and credits nothing without a Pod", async () => {
    const invalid = library({
      proposals: PROPOSALS,
      validation: {
        valid: true,
        findings: [{ ruleId: "field-unavailable" }],
        checked: { project: true },
      },
    });
    expect((await JOURNEYS.S02(context({ extra: { http: invalid.http } }), CHAT)).status).toBe(
      "red",
    );
    const lib = library({ proposals: PROPOSALS });
    const check = await JOURNEYS.S02(context({ extra: { http: lib.http } }), { id: "chat" });
    expect(check.status).toBe("unverified");
    expect(check.covers).toEqual([]);
  });
});
