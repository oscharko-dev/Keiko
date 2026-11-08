import { describe, expect, it, vi } from "vitest";
import { parseJiraIssueTemplate } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { AtlassianHttpBodyPort } from "./atlassian-http-port.js";
import { asArray, asRecord } from "./atlassian-sync-classify.js";
import { EPIC_LINK, fixtureJira, syntheticProject } from "./jira-report.fixture.js";
import { createJiraReportTemplateChecker } from "./jira-report-template-checker.js";
import {
  createJiraReportSession,
  JIRA_REPORT_SESSION_MAX_BYTES,
  type JiraReportReadDeps,
} from "./jira-report-session.js";
import { advanceJiraReportSession } from "./jira-report-read.js";
import { response } from "../../../tests/support/jira-managed-remote.js";

const NATIVE_PARENT = { id: "1", key: "REP-1", fields: { issuetype: { id: "10", name: "Epic" } } };

function fixture(parent: Record<string, unknown> | "denied" = NATIVE_PARENT) {
  const parsed = parseJiraIssueTemplate(
    [
      "---",
      "keiko: jira-issue-template",
      "version: 1",
      "project: REP",
      "issueType: Story",
      "activateOn: [create, edit]",
      `parentField: ${EPIC_LINK}`,
      "parentIssueTypes: [Epic]",
      "---",
    ].join("\n"),
  );
  if (!parsed.ok) throw new TypeError("Expected formal parent template");
  const sample = syntheticProject(8).find(({ type }) => type === "Story");
  if (sample === undefined) throw new TypeError("Expected synthetic Story");
  const issues = [5, 6, 7].map((index) => ({ ...sample, key: `REP-${index}`, epic: "REP-1" }));
  const native = fixtureJira({ issues, noRequiredFields: true, pageClamp: 2 });
  const clock = { now: 0, expireAfterParent: false };
  const controller = new AbortController();
  const beforeEffect = vi.fn(() => true);
  const parentReads: string[] = [];
  const http = vi.fn<AtlassianHttpBodyPort>(async (request) => {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/issue/REP-1")) {
      expect(request.method).toBe("GET");
      expect(url.search).toBe("?fields=issuetype");
      parentReads.push(url.pathname);
      if (clock.expireAfterParent) clock.now += 2000;
      return parent === "denied" ? response({}, 403) : response(parent);
    }
    return native.http(request);
  });
  const session = createJiraReportSession({
    id: "parent-report",
    owner: "owner",
    fingerprint: "bound-pod",
    now: 0,
    request: {
      projectKey: "REP",
      jql: undefined,
      estimateFieldId: undefined,
      asOf: undefined,
      parentFieldIds: [],
      requirementIds: [],
    },
  });
  const deps: JiraReportReadDeps = {
    baseUrl: "https://jira.example.invalid/context",
    http,
    signal: controller.signal,
    beforeEffect,
    now: () => clock.now,
    sliceMs: 1000,
    memoryBudgetBytes: JIRA_REPORT_SESSION_MAX_BYTES,
    checker: createJiraReportTemplateChecker(() => ({
      templates: [parsed.template],
      unreadable: 0,
    })),
    sleep: async () => undefined,
  };
  return { session, deps, http, parentReads, clock, controller, beforeEffect, native };
}

function editSearchFields(
  f: ReturnType<typeof fixture>,
  edit: (fields: Record<string, unknown>) => void,
): void {
  const original = f.http.getMockImplementation();
  if (original === undefined) throw new TypeError("Expected report transport");
  f.http.mockImplementation(async (request) => {
    const result = await original(request);
    if (!new URL(request.url).pathname.endsWith("/search")) return result;
    if (result.kind !== "response" || typeof result.bodyText !== "string")
      throw new TypeError("Expected native search response");
    const page = asRecord(JSON.parse(result.bodyText));
    const issues = asArray(page?.issues);
    if (page === undefined || issues === undefined)
      throw new TypeError("Expected native search page");
    for (const issue of issues) {
      const fields = asRecord(asRecord(issue)?.fields);
      if (fields === undefined) throw new TypeError("Expected native issue fields");
      edit(fields);
    }
    return response(page);
  });
}

describe("report parent types reuse independently bound native evidence", () => {
  it("judges every paginated issue against its measured parent type", async () => {
    const f = fixture();
    await advanceJiraReportSession(f.session, f.deps);
    expect(f.session.report?.completeness).toMatchObject({
      complete: true,
      issuesRead: 3,
      issuesTotal: 3,
    });
    expect(f.session.report?.compliance).toMatchObject({
      checker: "applied",
      issuesChecked: 3,
      issuesJudged: 3,
      deviationCount: 0,
      issuesWithDeviations: 0,
    });
    expect(f.parentReads).toHaveLength(3);
    expect(f.native.searches.length).toBeGreaterThan(1);
    expect(f.http.mock.calls.every(([request]) => request.method === "GET")).toBe(true);
  });

  it("counts a genuinely observed parent-type mismatch without trusting embedded relation hints", async () => {
    const f = fixture({ ...NATIVE_PARENT, fields: { issuetype: { id: "11", name: "Story" } } });
    await advanceJiraReportSession(f.session, f.deps);
    expect(f.session.report?.completeness.complete).toBe(true);
    expect(f.session.report?.compliance).toMatchObject({
      checker: "applied",
      deviationCount: 3,
      issuesWithDeviations: 3,
      byRule: [{ ruleId: "parent-type-mismatch", count: 3 }],
    });
  });

  it.each([
    "denied",
    { ...NATIVE_PARENT, id: "9", key: "OTHER-9" },
    { ...NATIVE_PARENT, fields: {} },
    { ...NATIVE_PARENT, fields: { issuetype: { id: "10" } } },
  ] as const)(
    "keeps unavailable or contradictory parent facts out of deviation totals",
    async (parent) => {
      const f = fixture(parent);
      await advanceJiraReportSession(f.session, f.deps);
      expect(f.session.report?.completeness).toMatchObject({
        complete: false,
        reason: "template-unreadable",
        issuesRead: 3,
        issuesTotal: 3,
      });
      expect(f.session.report?.compliance).toMatchObject({
        checker: "unavailable",
        deviationCount: 0,
        issuesWithDeviations: 0,
        byRule: [],
      });
      expect(f.session.report?.rows.every(({ issue }) => !issue.templateJudged)).toBe(true);
    },
  );

  it("retains only measured deviations when another parent's native evidence is unavailable", async () => {
    const f = fixture("denied");
    const original = f.http.getMockImplementation();
    if (original === undefined) throw new TypeError("Expected report transport");
    let parents = 0;
    f.http.mockImplementation(async (request) => {
      if (new URL(request.url).pathname.endsWith("/issue/REP-1") && parents++ === 0)
        return response({ ...NATIVE_PARENT, fields: { issuetype: { id: "11", name: "Story" } } });
      return original(request);
    });
    await advanceJiraReportSession(f.session, f.deps);
    expect(f.session.report?.compliance).toMatchObject({
      checker: "unavailable",
      deviationCount: 1,
      issuesWithDeviations: 1,
      byRule: [{ ruleId: "parent-type-mismatch", count: 1 }],
    });
    expect(f.session.report?.completeness).toMatchObject({
      complete: false,
      reason: "template-unreadable",
    });
  });

  it("does not count an omitted requested parent property as an absent parent", async () => {
    const f = fixture();
    editSearchFields(f, (fields) => {
      delete fields[EPIC_LINK];
    });
    await advanceJiraReportSession(f.session, f.deps);
    expect(f.session.report?.completeness).toMatchObject({
      complete: false,
      reason: "template-unreadable",
      issuesRead: 3,
    });
    expect(f.session.report?.compliance).toMatchObject({
      checker: "unavailable",
      issuesJudged: 0,
      deviationCount: 0,
      issuesWithDeviations: 0,
      byRule: [],
    });
    expect(f.parentReads).toEqual([]);
  });

  it("counts an explicitly null parent as observed absence without fetching an invented parent", async () => {
    const f = fixture();
    editSearchFields(f, (fields) => {
      fields[EPIC_LINK] = null;
    });
    await advanceJiraReportSession(f.session, f.deps);
    expect(f.session.report?.completeness).toMatchObject({ complete: true, issuesRead: 3 });
    expect(f.session.report?.compliance).toMatchObject({
      checker: "applied",
      issuesJudged: 3,
      deviationCount: 3,
      issuesWithDeviations: 3,
      byRule: [{ ruleId: "parent-missing", count: 3 }],
    });
    expect(f.parentReads).toEqual([]);
  });

  it("resumes the same issue under a fresh slice instead of retaining deadline loss as a violation", async () => {
    const f = fixture();
    f.clock.expireAfterParent = true;
    editSearchFields(f, (fields) => {
      if (!f.clock.expireAfterParent) return;
      // The first hit is unreadable before and after its asynchronous parent check. Its next
      // observation is corrected; neither omission nor hierarchy discovery may survive the slice.
      delete fields.timeoriginalestimate;
      delete fields.labels;
    });
    await advanceJiraReportSession(f.session, f.deps);
    expect(f.session).toMatchObject({
      phase: "reading",
      startAt: 0,
      checker: "applied",
      report: undefined,
    });
    expect(f.parentReads).toHaveLength(1);
    expect(f.session.plan?.omittedFields.size).toBe(0);
    expect(f.session.plan?.parentFieldsSeen.size).toBe(0);
    expect(f.session.plan?.parentFieldsNonKey.size).toBe(0);
    expect(f.session.plan?.parentFieldsRejected.size).toBe(0);
    expect(f.session.plan?.parentProposals.size).toBe(0);
    f.clock.expireAfterParent = false;
    await advanceJiraReportSession(f.session, f.deps);
    expect(f.session.report?.completeness).toMatchObject({ complete: true, issuesRead: 3 });
    expect(f.session.report?.compliance).toMatchObject({ checker: "applied", deviationCount: 0 });
    expect(f.parentReads).toHaveLength(4);
    expect(f.native.searches.map(({ startAt }) => startAt).slice(0, 2)).toEqual([0, 0]);
  });

  it("does not read a parent after current report authority is revoked", async () => {
    const f = fixture();
    const original = f.http.getMockImplementation();
    if (original === undefined) throw new TypeError("Expected report transport");
    f.http.mockImplementation(async (request) => {
      const result = await original(request);
      if (new URL(request.url).pathname.endsWith("/search")) f.beforeEffect.mockReturnValue(false);
      return result;
    });
    await advanceJiraReportSession(f.session, f.deps);
    expect(f.parentReads).toEqual([]);
    expect(f.session.checker).toBe("unavailable");
    expect([...f.session.issues.values()].flatMap(({ deviations }) => deviations)).toEqual([]);
  });

  it("keeps parent reads inside the existing retained-memory bound", async () => {
    const f = fixture();
    await advanceJiraReportSession(f.session, { ...f.deps, memoryBudgetBytes: 1 });
    expect(f.session.report?.completeness).toMatchObject({
      complete: false,
      reason: "memory-budget",
      issuesRead: 1,
    });
    expect(f.parentReads).toHaveLength(1);
  });

  it("stops after cancellation without converting the unfinished issue into a deviation", async () => {
    const f = fixture();
    const original = f.http.getMockImplementation();
    if (original === undefined) throw new TypeError("Expected report transport");
    f.http.mockImplementation(async (request) => {
      const result = await original(request);
      if (new URL(request.url).pathname.endsWith("/issue/REP-1")) f.controller.abort();
      return result;
    });
    await advanceJiraReportSession(f.session, f.deps);
    expect(f.parentReads).toHaveLength(1);
    expect(f.session).toMatchObject({
      phase: "reading",
      startAt: 0,
      checker: "applied",
      report: undefined,
    });
    expect(f.session.issues.size).toBe(0);
  });
});
