import { describe, expect, it } from "vitest";
import type { JiraReportHttp } from "./jira-report-http.js";
import type { JiraReportFieldPlan } from "./jira-report-issue.js";
import { fetchJiraReportPage } from "./jira-report-page.js";

function plan(): JiraReportFieldPlan {
  return {
    parentFieldIds: [],
    namedParentFieldIds: new Set(),
    parentFieldsSeen: new Set(),
    parentFieldsNonKey: new Set(),
    parentFieldsRejected: new Set(),
    parentProposals: new Map(),
    omittedFields: new Set(),
    estimateFieldId: "timeoriginalestimate",
    requirementIds: new Set(),
    requiredByType: new Map([
      ["11", Array.from({ length: 300 }, (_, index) => `customfield_${String(20000 + index)}`)],
    ]),
    checker: undefined,
    includeDescription: false,
  };
}

function chunkedRead(offset: number | undefined): {
  readonly http: JiraReportHttp;
  readonly requests: URL[];
} {
  const requests: URL[] = [];
  return {
    requests,
    http: {
      request: () => Promise.resolve({ ok: false, reason: "not-found" }),
      getAgileRecord: () => Promise.resolve({ ok: false, reason: "not-found" }),
      getArray: () => Promise.resolve({ ok: true, items: [] }),
      getRecord: (path): ReturnType<JiraReportHttp["getRecord"]> => {
        const url = new URL(path, "https://jira.example.invalid/rest/api/2/");
        requests.push(url);
        const first = requests.length === 1;
        return Promise.resolve({
          ok: true,
          body: {
            startAt: first ? 8 : offset,
            total: 9,
            issues: [{ key: "REP-9", fields: first ? { summary: "Observed" } : { labels: [] } }],
          },
        });
      },
    },
  };
}

describe("native field chunks describe the same search page", () => {
  it.each([0, 7, 9, undefined])(
    "refuses a later chunk at %s even when keys and totals match",
    async (offset) => {
      const { http, requests } = chunkedRead(offset);
      const result = await fetchJiraReportPage(http, plan(), {
        jql: "project = REP ORDER BY key",
        startAt: 8,
        maxResults: 1,
      });
      expect(requests.length).toBeGreaterThan(1);
      expect(requests.every((url) => url.searchParams.get("startAt") === "8")).toBe(true);
      expect(result).toEqual({ kind: "moved" });
    },
  );

  it("merges disjoint fields only when each observed native offset agrees", async () => {
    const { http, requests } = chunkedRead(8);
    const result = await fetchJiraReportPage(http, plan(), {
      jql: "project = REP ORDER BY key",
      startAt: 8,
      maxResults: 1,
    });
    expect(requests.length).toBeGreaterThan(1);
    expect(result).toEqual({
      kind: "page",
      body: {
        startAt: 8,
        total: 9,
        issues: [{ key: "REP-9", fields: { summary: "Observed", labels: [] } }],
      },
    });
  });
});
