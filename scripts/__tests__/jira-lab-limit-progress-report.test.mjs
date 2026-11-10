// The limit block uses the real native reader and the real installed-template reader.
// Only their HTTP boundaries and the orchestrator's ordinary UI turn are substituted.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import { parseJiraIssueTemplate } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as reports from "../testing/jira-chat-lab/requirements/progress-report.mjs";

const PROJECT = "LIM7";
const EPIC_LINK = "customfield_10100";
const STEP = "ac3-report";
const REPORT_ID = "11111111-2222-4333-8444-555555555555";
const FIELD_CATALOG = [
  { id: "summary", name: "Summary" },
  { id: "description", name: "Description" },
  { id: "labels", name: "Labels" },
  { id: "parent", name: "Parent" },
  { id: "issuelinks", name: "Issue Links" },
  { id: EPIC_LINK, name: "Epic Link" },
];
const roots = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function entrypoint() {
  expect(reports.runProgressReport, "the contracted report block must exist").toBeTypeOf(
    "function",
  );
  return reports.runProgressReport;
}

function issues() {
  return Array.from({ length: 305 }, (_, index) => ({
    id: String(20001 + index),
    key: `${PROJECT}-${index + 1}`,
    fields: {
      project: { id: "10000", key: PROJECT },
      issuetype: {
        id: index === 0 ? "1" : "2",
        name: index === 0 ? "Epic" : "Task",
        subtask: false,
      },
      status: { id: "11", name: "To Do", statusCategory: { key: "new" } },
      labels: index === 1 ? [] : ["anforderung", "keiko-requirement"],
      summary: "Synthetic private issue summary",
      description: "Synthetic private issue description",
      issuelinks: [],
      [EPIC_LINK]: index === 0 || index === 2 ? null : `${PROJECT}-1`,
    },
  }));
}

function templates() {
  return ["Epic", "Task", "Bug"].map((issueType, index) => ({
    id: `11111111-2222-4333-8444-${String(index + 1).padStart(12, "0")}`,
    revision: 1,
    valid: true,
    project: PROJECT,
    issueType,
    activations: ["create"],
    body: [
      "---",
      "keiko: jira-issue-template",
      "version: 1",
      `project: ${PROJECT}`,
      `issueType: ${issueType}`,
      "activateOn: [create]",
      "requiredLabels: [anforderung]",
      ...(issueType === "Task" ? [`parentField: ${EPIC_LINK}`, "parentIssueTypes: [Epic]"] : []),
      "---",
      "",
    ].join("\n"),
  }));
}

function scopeOf(installed) {
  return {
    project: PROJECT,
    issueTypes: ["Epic", "Task", "Bug"],
    labelsForTypes: ["Epic", "Task", "Bug"],
    parentForTypes: { Task: EPIC_LINK },
    templates: installed.map(({ id, revision, body }) => {
      const parsed = parseJiraIssueTemplate(body);
      if (!parsed.ok) throw new TypeError("Synthetic formal template must parse");
      return {
        id,
        revision,
        sha256: createHash("sha256").update(body).digest("hex"),
        rules: parsed.template,
      };
    }),
  };
}

function nativePages(native) {
  return Array.from({ length: Math.ceil(native.length / 100) }, (_, index) => ({
    startAt: index * 100,
    maxResults: 100,
    total: native.length,
    count: Math.min(100, native.length - index * 100),
  }));
}

function simulationTruth(native, installed) {
  return {
    source: "progress-simulation",
    seedVersion: 2,
    project: PROJECT,
    issueCount: native.length,
    templateScope: scopeOf(installed),
    fieldIds: { epicLink: EPIC_LINK },
    fieldCatalog: FIELD_CATALOG,
    native: {
      issues: native.map(({ id, key, fields }) => {
        const { summary, description, issuelinks, ...minimal } = fields;
        const fieldDigests = Object.fromEntries(
          Object.entries({ summary, description, issuelinks }).map(([field, value]) => [
            field,
            createHash("sha256")
              .update(JSON.stringify({ present: true, value }))
              .digest("hex"),
          ]),
        );
        return { id, key, fields: minimal, fieldDigests };
      }),
      pages: nativePages(native),
    },
    issues: native.map(({ id, key, fields }, index) => ({
      id,
      key,
      type: fields.issuetype.name,
      typeId: fields.issuetype.id,
      subtask: false,
      status: fields.status.name,
      category: "new",
      labels: [...fields.labels],
      ...(fields[EPIC_LINK] === null ? {} : { epic: fields[EPIC_LINK] }),
      deviations: index === 1 ? ["label:anforderung"] : index === 2 ? ["parent"] : [],
    })),
  };
}

function progress(total) {
  return {
    total,
    new: total,
    indeterminate: 0,
    done: 0,
    noCategory: 0,
    donePercent: 0,
    estimate: null,
  };
}

function reportExchange() {
  return {
    call: { id: "report-summary", name: "jira_report", arguments: { projectKey: PROJECT } },
    result: {
      toolRef: { canonicalId: "keiko.jira.report", contractVersion: 1 },
      status: "completed",
      data: {
        outcome: "succeeded",
        status: "complete",
        reportId: REPORT_ID,
        report: {
          digest: "a".repeat(64),
          generatedAt: "2026-11-08T00:00:00Z",
          scope: {
            projectKey: PROJECT,
            estimateUnit: "unavailable",
            estimateSource: "unavailable",
            estimateUnavailableReason: "field-not-found",
          },
          completeness: { complete: true, issuesRead: 305, issuesTotal: 305, pageCount: 4 },
          progress: {
            project: progress(305),
            byType: [
              { typeName: "Epic", total: 1, done: 0 },
              { typeName: "Task", total: 304, done: 0 },
            ],
            byStatus: {
              total: 2,
              items: [
                { typeName: "Epic", statusName: "To Do", category: "new", total: 1 },
                { typeName: "Task", statusName: "To Do", category: "new", total: 304 },
              ],
            },
          },
          epics: { total: 1, items: [{ key: "LIM7-1", members: progress(303) }] },
          compliance: {
            checker: "applied",
            requiredFieldRules: "applied",
            issuesChecked: 305,
            issuesJudged: 305,
            issuesWithoutTemplate: 0,
            withoutTemplateByType: [],
            issuesWithDeviations: 2,
            deviationCount: 2,
            deviations: {
              total: 2,
              items: [
                {
                  key: "LIM7-2",
                  ruleIds: ["label-missing"],
                  fieldIds: ["labels"],
                  details: ["label-missing: anforderung"],
                },
                {
                  key: "LIM7-3",
                  ruleIds: ["parent-missing"],
                  fieldIds: [EPIC_LINK],
                  details: ["parent-missing: Epic Link"],
                },
              ],
            },
          },
        },
      },
    },
  };
}

function templateBrowser(installed) {
  const get = vi.fn((target) => {
    const url = new URL(target);
    expect(url.origin).toBe("http://127.0.0.1:1983");
    let value;
    if (url.pathname === "/api/skills/jira-templates") {
      value = { templates: installed.map(({ body: _body, ...item }) => item) };
    } else {
      const skill = installed.find((item) => url.pathname === `/api/skills/${item.id}`);
      expect(skill, "only currently listed revision-bound skills may be read").toBeDefined();
      expect(url.searchParams.get("revision")).toBe(String(skill.revision));
      value = { skill: structuredClone(skill) };
    }
    return Promise.resolve({
      ok: () => true,
      status: () => 200,
      json: () => Promise.resolve(value),
    });
  });
  return { url: () => "http://127.0.0.1:1983/", request: { get } };
}

function intentFixture(directory, truth) {
  const path = join(directory, "browser-limit-run.pending.json");
  const data = { "progress-simulation": { truth } };
  const records = [];
  const persist = () =>
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, data }), { mode: 0o600 });
  persist();
  return {
    path,
    records,
    persist,
    data,
    get state() {
      return structuredClone(data);
    },
    record(name, value) {
      expect(name, "the report may only write its own existing intent slot").toBe(STEP);
      data[name] = structuredClone(value);
      records.push(structuredClone(value));
      persist();
    },
  };
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "keiko-limit-report-"));
  roots.push(directory);
  mkdirSync(join(directory, "secrets"), { mode: 0o700 });
  writeFileSync(join(directory, "secrets", "admin-password"), "synthetic-only", { mode: 0o600 });
  const native = issues();
  const installed = templates();
  const intent = intentFixture(directory, simulationTruth(native, installed));
  const requests = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((target, options) => {
      const url = new URL(target);
      expect(options.method).toBe("GET");
      expect(url.origin).toBe("http://127.0.0.1:18081");
      expect(url.pathname).toBe("/rest/api/2/search");
      expect(url.searchParams.get("maxResults")).toBe("100");
      expect(url.searchParams.get("jql")).toBe("project = LIM7 ORDER BY key ASC");
      requests.push(url);
      const startAt = Number(url.searchParams.get("startAt"));
      return Promise.resolve(
        new globalThis.Response(
          JSON.stringify({
            startAt,
            maxResults: 100,
            total: native.length,
            issues: native.slice(startAt, startAt + 100),
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );
    }),
  );
  const turn = {
    clientTurnId: "synthetic-turn",
    user: { turnState: "completed" },
    exchanges: [reportExchange()],
    answer: [
      "ANZAHL;Epic;To Do;1",
      "ANZAHL;Task;To Do;304",
      "EPIC;LIM7-1;303;0",
      "SCHÄTZUNG;NICHT_VERFÜGBAR;field-not-found",
      "SCOPE-LÜCKE;SCHÄTZUNG;field-not-found",
      "LIM7-2: Label anforderung fehlt",
      "LIM7-3: Epic-Zuordnung fehlt",
    ].join("\n"),
  };
  const controller = new globalThis.AbortController();
  const ctx = {
    sessionDir: directory,
    session: { directory, httpPort: 18081, syntheticOnly: true },
    projectKey: PROJECT,
    locale: "de",
    modelId: "synthetic-model",
    intent,
    page: templateBrowser(installed),
    signal: controller.signal,
    reportChat: { id: "report-only", knowledgeSources: [] },
    chat: { id: "documents-chat", knowledgeSources: ["must-not-read"] },
    turn: vi.fn(() => Promise.resolve(structuredClone(turn))),
  };
  return { ctx, turn, native, installed, intent, requests, controller };
}

describe("W8/W9 runProgressReport existing limit-run block", () => {
  it("does not equate a Kosten table row with the independently selected Story Points metric", () => {
    const field = "customfield_10106";
    const truth = reports.progressTruth(
      [
        {
          key: "LIM7-1",
          fields: {
            issuetype: { name: "Story" },
            status: { name: "Done", statusCategory: { key: "done" } },
            [field]: 1170,
          },
        },
      ],
      { storyPoints: field },
      { fieldId: field, unit: "points", label: "Story Points" },
    );
    const table = "| Kennzahl | Gesamt | Erledigt | Offen |\n| --- | --- | --- | --- |\n";
    expect(
      reports.gradeProgress(table + "| Story Points | 1.170 | 1.170 | 0 |", truth).estimate,
    ).toMatchObject({ graded: true, ok: true });
    expect(
      reports.gradeProgress(table + "| Kosten | 1.170 | 1.170 | 0 |", truth).estimate,
    ).toMatchObject({ graded: true, ok: false });
  });

  it("exports the contracted entrypoint without starting a session", () => {
    entrypoint();
  });

  it("grades the UI report and answer against fresh native pages and writes only the existing intent", async () => {
    const run = entrypoint();
    const f = fixture();
    const result = await run(f.ctx, { truthFile: f.intent.path });
    expect(result).toMatchObject({
      step: STEP,
      status: "green",
      evidenceFile: f.intent.path,
      counts: { issues: 305, pages: 4, deviations: 2, deviatingIssues: 2, falseFindings: 0 },
    });
    expect(f.ctx.turn).toHaveBeenCalledTimes(1);
    expect(f.ctx.turn.mock.calls[0][0]).toBe(f.ctx.reportChat);
    expect(f.ctx.turn.mock.calls[0][2]).toMatchObject({ operations: [] });
    expect(f.requests.map((url) => url.searchParams.get("startAt"))).toEqual([
      "0",
      "100",
      "200",
      "300",
    ]);
    expect(f.ctx.page.request.get).toHaveBeenCalled();
    expect(f.intent.records.length).toBeGreaterThan(1);
    expect(JSON.parse(readFileSync(f.intent.path, "utf8")).data[STEP]).toBeDefined();
    expect(readFileSync(f.intent.path, "utf8")).not.toContain("Synthetic private issue");
    expect(result.detail).not.toMatch(/LIM7-|http|Label anforderung/u);
  });

  it("reuses a settled turn on resume but independently rechecks the native snapshot", async () => {
    const run = entrypoint();
    const f = fixture();
    expect((await run(f.ctx, { truthFile: f.intent.path })).status).toBe("green");
    expect((await run(f.ctx, { truthFile: f.intent.path })).status).toBe("green");
    expect(f.ctx.turn).toHaveBeenCalledTimes(1);
    expect(f.requests).toHaveLength(8);
    f.native[1].fields.labels.push("anforderung");
    expect((await run(f.ctx, { truthFile: f.intent.path })).status).toBe("unverified");
    expect(f.ctx.turn).toHaveBeenCalledTimes(1);
  });

  it("checks full installed summary rules through the existing checker without retaining native text", async () => {
    const run = entrypoint();
    const f = fixture();
    f.installed[1].body = f.installed[1].body.replace(
      "activateOn: [create]",
      "activateOn: [create]\nsummaryMinLength: 15",
    );
    f.native[4].fields.summary = "Short private";
    f.intent.data["progress-simulation"].truth = simulationTruth(f.native, f.installed);
    f.intent.persist();
    const compliance = f.turn.exchanges[0].result.data.report.compliance;
    compliance.issuesWithDeviations = 3;
    compliance.deviationCount = 3;
    compliance.deviations.total = 3;
    compliance.deviations.items.push({
      key: "LIM7-5",
      ruleIds: ["summary-too-short"],
      fieldIds: ["summary"],
      details: ["summary-too-short: at least 15 characters"],
    });
    f.turn.answer += "\nLIM7-5: Zusammenfassung entspricht nicht der Mindestlänge";
    expect(await run(f.ctx, { truthFile: f.intent.path })).toMatchObject({
      status: "green",
      counts: { deviations: 3, deviatingIssues: 3 },
    });
    expect(readFileSync(f.intent.path, "utf8")).not.toContain("Short private");
  });

  it.each(["native-status", "native-parent", "template-revision", "truth-project"])(
    "does not credit stale %s evidence",
    async (kind) => {
      const run = entrypoint();
      const f = fixture();
      if (kind === "native-status") f.native[1].fields.status.name = "Done";
      if (kind === "native-parent") f.native[2].fields[EPIC_LINK] = "LIM7-1";
      if (kind === "template-revision") f.installed[1].revision = 2;
      if (kind === "truth-project") {
        f.intent.data["progress-simulation"].truth.project = "OTHER";
        f.intent.persist();
      }
      expect((await run(f.ctx, { truthFile: f.intent.path })).status).toBe("unverified");
    },
  );

  it.each([
    "missing-card",
    "foreign-scope",
    "partial-card",
    "false-finding",
    "zero-estimate",
    "wrong-count",
  ])("does not credit %s even when the other evidence agrees", async (kind) => {
    const run = entrypoint();
    const f = fixture();
    const report = f.turn.exchanges[0].result.data.report;
    if (kind === "missing-card") f.turn.exchanges = [];
    if (kind === "foreign-scope") report.scope.projectKey = "OTHER";
    if (kind === "partial-card") report.completeness.complete = false;
    if (kind === "false-finding") report.compliance.deviations.items[0].key = "LIM7-1";
    if (kind === "zero-estimate")
      report.progress.project.estimate = { total: 0, done: 0, remaining: 0, unestimated: 305 };
    if (kind === "wrong-count") report.progress.byType[1].total = 303;
    expect((await run(f.ctx, { truthFile: f.intent.path })).status).not.toBe("green");
  });

  it("never replays a turn whose terminal response was lost", async () => {
    const run = entrypoint();
    const f = fixture();
    f.ctx.turn.mockRejectedValueOnce(new TypeError("Synthetic interrupted UI observation"));
    expect((await run(f.ctx, { truthFile: f.intent.path })).status).toBe("unverified");
    expect((await run(f.ctx, { truthFile: f.intent.path })).status).toBe("unverified");
    expect(f.ctx.turn).toHaveBeenCalledTimes(1);
  });

  it.each(["failure", "lab-limit", "cancelled", "failed", "missing-state"])(
    "never attests a %s UI turn as terminal success or replays it",
    async (kind) => {
      const run = entrypoint();
      const f = fixture();
      if (kind === "failure") f.turn.failure = "synthetic-provider-refusal";
      if (kind === "lab-limit") f.turn.termination = "lab-limit";
      if (kind === "cancelled" || kind === "failed") f.turn.user.turnState = kind;
      if (kind === "missing-state") delete f.turn.user.turnState;
      const result = await run(f.ctx, { truthFile: f.intent.path });
      expect(result.status).toBe("unverified");
      expect(f.intent.records.some((record) => record.phase === "settled")).toBe(false);
      expect((await run(f.ctx, { truthFile: f.intent.path })).status).toBe("unverified");
      expect(f.ctx.turn).toHaveBeenCalledTimes(1);
    },
  );

  it("does not substitute a second evidence file or start a cancelled turn", async () => {
    const run = entrypoint();
    const f = fixture();
    const other = join(f.ctx.sessionDir, "other.json");
    writeFileSync(other, readFileSync(f.intent.path), { mode: 0o600 });
    expect((await run(f.ctx, { truthFile: other })).status).toBe("unverified");
    f.controller.abort();
    expect((await run(f.ctx, { truthFile: f.intent.path })).status).toBe("unverified");
    expect(f.ctx.turn).not.toHaveBeenCalled();
  });
});
