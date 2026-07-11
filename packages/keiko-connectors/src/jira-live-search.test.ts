// Issue #2248 — live JQL search executor tests. Hermetic: the transport is the in-memory Jira
// fixture (no network, no atlassian.net), backoff sleeps are recorded no-ops, and the clock is
// injected wherever a bound depends on it. The parity acceptance criterion is proven against a
// SHARED fixture issue flowing through BOTH the #2243 sync mapping and the live mapping.

import { describe, expect, it } from "vitest";
import {
  ATLASSIAN_JQL_MAX_CHARS,
  ATLASSIAN_LIVE_SEARCH_MAX_RESULTS,
  validateJiraLiveSearchResult,
  type JiraIssueCitationMetadata,
} from "@oscharko-dev/keiko-contracts";
import { sha256Hex } from "@oscharko-dev/keiko-security";
import { AtlassianCredentialCustodyError } from "./atlassian-credential-custody.js";
import type {
  AtlassianHttpBodyPort,
  AtlassianHttpBodyRequest,
  AtlassianHttpBodyResult,
} from "./atlassian-http-port.js";
import type { AtlassianSyncFetchContext } from "./atlassian-sync-lane.js";
import { createJiraSyncSource } from "./jira-sync-adapter.js";
import { createInMemoryJiraFixture, type JiraFixtureIssue } from "./jira-sync-fixtures.js";
import {
  ATLASSIAN_LIVE_SEARCH_TIMEOUT_MS,
  JIRA_LIVE_SEARCH_MAX_PAGE_REQUESTS,
  JIRA_LIVE_SEARCH_TEMPLATE_JQL,
  executeJiraLiveSearch,
  resolveJiraLiveSearchJql,
} from "./jira-live-search.js";

const BASE_URL = "https://tenant.example";
const JQL = "labels = urgent ORDER BY updated DESC";

// The shared parity fixture: every citation-metadata field the #2243 mapping captures, including
// the remaining estimate, parent, subtasks, and directional links the #2248 AC calls out.
const RICH_ISSUE: JiraFixtureIssue = {
  issueId: "10007",
  key: "PROJ-7",
  summary: "Login token expires early",
  updated: "2026-05-01T10:22:33.000+0000",
  extraFields: {
    status: { name: "In Progress" },
    issuetype: { name: "Bug" },
    assignee: { displayName: "Alice Doe" },
    reporter: { displayName: "Bob Roe" },
    labels: ["auth", "urgent"],
    priority: { name: "High" },
    resolution: { name: "Unresolved" },
    timetracking: { originalEstimate: "3d", remainingEstimate: "2d" },
    parent: { key: "PROJ-1" },
    subtasks: [{ key: "PROJ-8" }, { key: "PROJ-9" }],
    issuelinks: [
      { type: { outward: "blocks", inward: "is blocked by" }, outwardIssue: { key: "PROJ-20" } },
      { type: { outward: "relates to", inward: "relates to" }, inwardIssue: { key: "PROJ-21" } },
    ],
    created: "2026-04-01T08:00:00.000+0000",
  },
};

function plainIssue(index: number): JiraFixtureIssue {
  return {
    issueId: String(20_000 + index),
    key: `PROJ-${String(100 + index)}`,
    summary: `Plain issue ${String(index)}`,
    updated: "2026-05-02T09:00:00.000+0000",
  };
}

interface CountingPort {
  readonly port: AtlassianHttpBodyPort;
  readonly requests: AtlassianHttpBodyRequest[];
}

function countingFixture(
  issues: readonly JiraFixtureIssue[],
  options: {
    readonly searchPageSize?: number;
    readonly override?: (request: AtlassianHttpBodyRequest) => AtlassianHttpBodyResult | undefined;
  } = {},
): CountingPort {
  const requests: AtlassianHttpBodyRequest[] = [];
  const port = createInMemoryJiraFixture({
    baseUrl: BASE_URL,
    projects: [{ key: "PROJ", issues }],
    ...(options.searchPageSize === undefined ? {} : { searchPageSize: options.searchPageSize }),
    ...(options.override === undefined ? {} : { override: options.override }),
    onRequest: (request) => {
      requests.push(request);
    },
  });
  return { port, requests };
}

function response(status: number, bodyText = "{}"): AtlassianHttpBodyResult {
  return { kind: "response", status, bodyText, bodyBytes: bodyText.length, truncated: false };
}

describe("resolveJiraLiveSearchJql (templates, Issue #2248 Scope 2)", () => {
  it("composes the assigned-to-me-open template from fixed parts", () => {
    expect(resolveJiraLiveSearchJql({ templateId: "assigned-to-me-open" })).toBe(
      "assignee = currentUser() AND resolution = EMPTY ORDER BY updated DESC",
    );
    expect(JIRA_LIVE_SEARCH_TEMPLATE_JQL["assigned-to-me-open"]).toBe(
      resolveJiraLiveSearchJql({ templateId: "assigned-to-me-open" }),
    );
  });

  it("passes free-form JQL through opaquely and fails closed on XOR violations", () => {
    expect(resolveJiraLiveSearchJql({ jql: JQL })).toBe(JQL);
    expect(() => resolveJiraLiveSearchJql({})).toThrow(AtlassianCredentialCustodyError);
    expect(() => resolveJiraLiveSearchJql({ jql: JQL, templateId: "assigned-to-me-open" })).toThrow(
      AtlassianCredentialCustodyError,
    );
  });
});

describe("executeJiraLiveSearch — result mapping and parity (Issue #2248 AC3/AC4)", () => {
  it("maps the shared fixture issue identically to the #2243 sync citation metadata", async () => {
    const { port } = countingFixture([RICH_ISSUE]);
    const live = await executeJiraLiveSearch({ http: port }, { baseUrl: BASE_URL, jql: JQL });
    if (!live.ok) throw new Error(`expected live success, got ${live.reason}`);
    expect(live.result.issues).toHaveLength(1);
    const liveIssue = live.result.issues[0];
    if (liveIssue === undefined) throw new Error("expected one live issue");

    // The SAME fixture issue through the #2243 sync fetch path.
    const source = createJiraSyncSource({
      baseUrl: BASE_URL,
      connectorId: "conn-1",
      projectKeys: ["PROJ"],
    });
    const context: AtlassianSyncFetchContext = {
      http: port,
      deadlineExceeded: () => false,
      maxItems: 100,
    };
    const fetched = await source.fetchItem(
      { itemKey: "jira:conn-1:10007", issueId: "10007" },
      context,
    );
    if (fetched.kind !== "item") throw new Error(`expected sync item, got ${fetched.kind}`);
    const syncMetadata = JSON.parse(
      fetched.item.citationMetadataJson ?? "{}",
    ) as JiraIssueCitationMetadata;

    // Identical citation-metadata fields — including remainingEstimate, parentKey, subtaskKeys,
    // and directional linked-issue keys (the AC3 field list).
    expect(liveIssue.metadata).toEqual(syncMetadata);
    expect(liveIssue.metadata.remainingEstimate).toBe("2d");
    expect(liveIssue.metadata.originalEstimate).toBe("3d");
    expect(liveIssue.metadata.parentKey).toBe("PROJ-1");
    expect(liveIssue.metadata.subtaskKeys).toEqual(["PROJ-8", "PROJ-9"]);
    expect(liveIssue.metadata.linkedIssues).toEqual([
      { linkType: "blocks", issueKey: "PROJ-20" },
      { linkType: "relates to", issueKey: "PROJ-21" },
    ]);
    // The live browse URL resolves to the same click-through the synced webuiPath denotes.
    expect(liveIssue.browseUrl).toBe(`${BASE_URL}${fetched.item.webuiPath ?? ""}`);
    expect(liveIssue.summary).toBe("Login token expires early");
  });

  it("answers the freshness envelope: source live, queriedAt, jqlDigest, contract-valid", async () => {
    const { port } = countingFixture([RICH_ISSUE, plainIssue(1)]);
    const now = (): number => 1_750_000_000_000;
    const live = await executeJiraLiveSearch({ http: port, now }, { baseUrl: BASE_URL, jql: JQL });
    if (!live.ok) throw new Error(`expected live success, got ${live.reason}`);
    expect(live.result.source).toBe("live");
    expect(live.result.queriedAt).toBe(1_750_000_000_000);
    expect(live.result.jqlDigest).toBe(sha256Hex(JQL));
    expect(live.result.truncated).toBe(false);
    expect(live.result.totalMatched).toBe(2);
    expect(validateJiraLiveSearchResult(live.result).ok).toBe(true);
    const serialized = JSON.stringify(live.result);
    expect(serialized).not.toContain("urgent ORDER BY");
  });

  it("composes browse URLs under a Data Center context path", async () => {
    const contextBase = "https://intranet.example/jira";
    const requests: AtlassianHttpBodyRequest[] = [];
    const port = createInMemoryJiraFixture({
      baseUrl: contextBase,
      projects: [{ key: "PROJ", issues: [RICH_ISSUE] }],
      onRequest: (request) => {
        requests.push(request);
      },
    });
    const live = await executeJiraLiveSearch({ http: port }, { baseUrl: contextBase, jql: JQL });
    if (!live.ok) throw new Error(`expected live success, got ${live.reason}`);
    expect(live.result.issues[0]?.browseUrl).toBe("https://intranet.example/jira/browse/PROJ-7");
    expect(requests.every((request) => request.url.startsWith(contextBase))).toBe(true);
  });

  it("flattens hostile summaries to bounded single-line text", async () => {
    const hostile: JiraFixtureIssue = {
      ...RICH_ISSUE,
      summary: `ring the  bell\n${"x".repeat(600)}`,
    };
    const { port } = countingFixture([hostile]);
    const live = await executeJiraLiveSearch({ http: port }, { baseUrl: BASE_URL, jql: JQL });
    if (!live.ok) throw new Error(`expected live success, got ${live.reason}`);
    const summary = live.result.issues[0]?.summary ?? "";
    expect(summary.startsWith("ring the bell x")).toBe(true);
    expect(summary).toHaveLength(500);
    expect(validateJiraLiveSearchResult(live.result).ok).toBe(true);
  });

  it("answers an empty result for a query with no matches", async () => {
    const { port, requests } = countingFixture([]);
    const live = await executeJiraLiveSearch({ http: port }, { baseUrl: BASE_URL, jql: JQL });
    if (!live.ok) throw new Error(`expected live success, got ${live.reason}`);
    expect(live.result.issues).toEqual([]);
    expect(live.result.truncated).toBe(false);
    expect(live.result.totalMatched).toBe(0);
    expect(requests).toHaveLength(1);
  });
});

describe("executeJiraLiveSearch — bounds at boundary values (Issue #2248 AC6)", () => {
  it("returns a complete result at exactly the requested cap", async () => {
    const issues = Array.from({ length: 12 }, (_, index) => plainIssue(index));
    const { port } = countingFixture(issues, { searchPageSize: 10 });
    const live = await executeJiraLiveSearch(
      { http: port },
      { baseUrl: BASE_URL, jql: JQL, maxResults: 12 },
    );
    if (!live.ok) throw new Error(`expected live success, got ${live.reason}`);
    expect(live.result.issues).toHaveLength(12);
    expect(live.result.truncated).toBe(false);
    expect(live.result.totalMatched).toBe(12);
  });

  it("stops AT the cap with truncated coverage when more matches exist", async () => {
    const issues = Array.from({ length: 15 }, (_, index) => plainIssue(index));
    const { port } = countingFixture(issues, { searchPageSize: 10 });
    const live = await executeJiraLiveSearch(
      { http: port },
      { baseUrl: BASE_URL, jql: JQL, maxResults: 12 },
    );
    if (!live.ok) throw new Error(`expected live success, got ${live.reason}`);
    expect(live.result.issues).toHaveLength(12);
    expect(live.result.truncated).toBe(true);
    expect(live.result.totalMatched).toBeUndefined();
    expect(validateJiraLiveSearchResult(live.result).ok).toBe(true);
  });

  it("stops after one page when the cap is full and a token continues", async () => {
    const issues = Array.from({ length: 20 }, (_, index) => plainIssue(index));
    const { port, requests } = countingFixture(issues, { searchPageSize: 10 });
    const live = await executeJiraLiveSearch(
      { http: port },
      { baseUrl: BASE_URL, jql: JQL, maxResults: 10 },
    );
    if (!live.ok) throw new Error(`expected live success, got ${live.reason}`);
    expect(live.result.issues).toHaveLength(10);
    expect(live.result.truncated).toBe(true);
    expect(requests).toHaveLength(1);
  });

  it("walks token pagination to completion below the cap", async () => {
    const issues = Array.from({ length: 25 }, (_, index) => plainIssue(index));
    const { port, requests } = countingFixture(issues, { searchPageSize: 10 });
    const live = await executeJiraLiveSearch({ http: port }, { baseUrl: BASE_URL, jql: JQL });
    if (!live.ok) throw new Error(`expected live success, got ${live.reason}`);
    expect(live.result.issues).toHaveLength(25);
    expect(live.result.totalMatched).toBe(25);
    expect(requests).toHaveLength(3);
    // Every page request stays on the composed search endpoint with the live field list —
    // the shared metadata fields, and never the description (live results carry no bodies).
    for (const request of requests) {
      expect(request.url).toContain("/rest/api/3/search/jql?jql=");
      expect(request.url).toContain("fields=summary,status,issuetype");
      expect(request.url).not.toContain("description");
    }
  });

  it("terminates a hostile looping token chain at the page ceiling with deduplicated issues", async () => {
    const loopBody = JSON.stringify({
      issues: [
        { id: "1", key: "PROJ-1", fields: { summary: "One" } },
        { id: "2", key: "PROJ-2", fields: { summary: "Two" } },
      ],
      nextPageToken: "loop",
    });
    const { port, requests } = countingFixture([], {
      override: (request) =>
        request.url.includes("/search/jql") ? response(200, loopBody) : undefined,
    });
    const live = await executeJiraLiveSearch({ http: port }, { baseUrl: BASE_URL, jql: JQL });
    if (!live.ok) throw new Error(`expected live success, got ${live.reason}`);
    expect(live.result.issues.map((issue) => issue.key)).toEqual(["PROJ-1", "PROJ-2"]);
    expect(live.result.truncated).toBe(true);
    expect(requests).toHaveLength(JIRA_LIVE_SEARCH_MAX_PAGE_REQUESTS);
  });

  it("classifies an oversized page token as malformed-payload", async () => {
    const body = JSON.stringify({ issues: [], nextPageToken: "x".repeat(5_000) });
    const { port } = countingFixture([], {
      override: (request) =>
        request.url.includes("/search/jql") ? response(200, body) : undefined,
    });
    const live = await executeJiraLiveSearch({ http: port }, { baseUrl: BASE_URL, jql: JQL });
    expect(live).toEqual({ ok: false, reason: "malformed-payload" });
  });

  it("fails the whole action with timeout when the 15s deadline passes mid-walk", async () => {
    const issues = Array.from({ length: 25 }, (_, index) => plainIssue(index));
    let clock = 0;
    const { port, requests } = countingFixture(issues, { searchPageSize: 10 });
    const live = await executeJiraLiveSearch(
      {
        http: (request) => {
          // Every page consumes 10s of the 15s budget: pages 1 and 2 are admitted (0s and 10s
          // elapsed), page 3 is refused by the deadline check before any connection is
          // attempted — the whole action fails closed as a typed timeout, never a partial
          // result.
          clock += 10_000;
          return port(request);
        },
        now: () => clock,
      },
      { baseUrl: BASE_URL, jql: JQL },
    );
    expect(live).toEqual({ ok: false, reason: "timeout" });
    expect(requests).toHaveLength(2);
    expect(ATLASSIAN_LIVE_SEARCH_TIMEOUT_MS).toBe(15_000);
  });

  it("throws the custody validation error on out-of-bounds caller input", async () => {
    const { port } = countingFixture([]);
    const cases: readonly { jql: string; maxResults?: number }[] = [
      { jql: "" },
      { jql: "x".repeat(ATLASSIAN_JQL_MAX_CHARS + 1) },
      { jql: JQL, maxResults: 0 },
      { jql: JQL, maxResults: ATLASSIAN_LIVE_SEARCH_MAX_RESULTS + 1 },
      { jql: JQL, maxResults: 1.5 },
    ];
    for (const input of cases) {
      await expect(
        executeJiraLiveSearch({ http: port }, { baseUrl: BASE_URL, ...input }),
      ).rejects.toThrow(AtlassianCredentialCustodyError);
    }
    await expect(
      executeJiraLiveSearch({ http: port }, { baseUrl: "http://tenant.example", jql: JQL }),
    ).rejects.toThrow(AtlassianCredentialCustodyError);
  });
});

describe("executeJiraLiveSearch — degradation matrix (Issue #2248 AC6)", () => {
  function failingPort(result: AtlassianHttpBodyResult): {
    readonly port: AtlassianHttpBodyPort;
    readonly requests: AtlassianHttpBodyRequest[];
  } {
    return countingFixture([], {
      override: (request) => (request.url.includes("/search/jql") ? result : undefined),
    });
  }

  it("classifies 401, 403, and transport timeouts as typed content-free reasons", async () => {
    const matrix: readonly { result: AtlassianHttpBodyResult; reason: string }[] = [
      { result: response(401, '{"detail":"bad token"}'), reason: "auth-failed" },
      { result: response(403, '{"detail":"no browse permission"}'), reason: "permission-denied" },
      { result: { kind: "timeout" }, reason: "timeout" },
      { result: { kind: "network-error" }, reason: "unavailable" },
      { result: response(200, "<html>not json"), reason: "malformed-payload" },
    ];
    for (const entry of matrix) {
      const { port } = failingPort(entry.result);
      const live = await executeJiraLiveSearch({ http: port }, { baseUrl: BASE_URL, jql: JQL });
      expect(live).toEqual({ ok: false, reason: entry.reason });
    }
  });

  it("retries 429 with the D3 backoff (Retry-After honored and capped) before rate-limited", async () => {
    const delays: number[] = [];
    const rateLimited: AtlassianHttpBodyResult = {
      kind: "response",
      status: 429,
      bodyText: "{}",
      bodyBytes: 2,
      truncated: false,
      retryAfterMs: 60_000,
    };
    const { port, requests } = failingPort(rateLimited);
    const live = await executeJiraLiveSearch(
      {
        http: port,
        sleep: (ms) => {
          delays.push(ms);
          return Promise.resolve();
        },
      },
      { baseUrl: BASE_URL, jql: JQL },
    );
    expect(live).toEqual({ ok: false, reason: "rate-limited" });
    expect(requests).toHaveLength(5);
    // A hostile 60s Retry-After is capped at the shared 8s ceiling on every attempt.
    expect(delays).toEqual([8_000, 8_000, 8_000, 8_000]);
  });

  it("retries 5xx with exponential backoff before unavailable", async () => {
    const delays: number[] = [];
    const { port, requests } = failingPort(response(503));
    const live = await executeJiraLiveSearch(
      {
        http: port,
        sleep: (ms) => {
          delays.push(ms);
          return Promise.resolve();
        },
      },
      { baseUrl: BASE_URL, jql: JQL },
    );
    expect(live).toEqual({ ok: false, reason: "unavailable" });
    expect(requests).toHaveLength(5);
    expect(delays).toEqual([500, 1_000, 2_000, 4_000]);
  });

  it("classifies a byte-capped truncated page as bounds-exceeded", async () => {
    const { port } = failingPort({
      kind: "response",
      status: 200,
      bodyText: '{"issues":[',
      bodyBytes: 11,
      truncated: true,
    });
    const live = await executeJiraLiveSearch({ http: port }, { baseUrl: BASE_URL, jql: JQL });
    expect(live).toEqual({ ok: false, reason: "bounds-exceeded" });
  });
});
