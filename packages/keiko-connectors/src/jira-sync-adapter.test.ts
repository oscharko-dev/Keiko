// Jira Cloud v3 sync adapter tests (Issue #2243, ADR-0128 D3/D5). Hermetic: the injected fixture
// transport mirrors createInMemoryConfluenceFixture — no network, no atlassian.net. Covers JQL
// composition/opacity, full-set enumeration with token pagination, the incremental fetch/carry
// partition with call-count assertions, the per-issue failure matrix (identical vocabulary to
// #2242), hostile-ADF bounding with a wall-clock bound, and the composed-document mapping.

import { describe, expect, it } from "vitest";
import { AtlassianCredentialCustodyError } from "./atlassian-credential-custody.js";
import type {
  AtlassianHttpBodyPort,
  AtlassianHttpBodyRequest,
  AtlassianHttpBodyResult,
} from "./atlassian-http-port.js";
import type { AtlassianSyncFetchContext, AtlassianSyncItem } from "./atlassian-sync-lane.js";
import {
  composeJiraScopeJql,
  createJiraSyncSource,
  JIRA_INCREMENTAL_SYNC_OVERLAP_MS,
  laterJiraProviderTimestamp,
  parseJiraProviderTimestampMs,
  type JiraSyncEnumerationSnapshot,
  type JiraSyncSourceOptions,
} from "./jira-sync-adapter.js";
import {
  buildHostileJiraAdfDocument,
  createInMemoryJiraFixture,
  type JiraFixtureIssue,
  type JiraFixtureProject,
} from "./jira-sync-fixtures.js";

const BASE_URL = "https://tenant.example";

function adf(text: string): unknown {
  return {
    type: "doc",
    version: 1,
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

function fixtureIssue(id: number, overrides: Partial<JiraFixtureIssue> = {}): JiraFixtureIssue {
  return {
    issueId: String(10_000 + id),
    key: `PLAT-${String(id)}`,
    summary: `Issue ${String(id)}`,
    updated: "2026-05-01T10:00:00.000+0000",
    descriptionAdf: adf(`Description of issue ${String(id)}.`),
    ...overrides,
  };
}

function project(key: string, issues: readonly JiraFixtureIssue[]): JiraFixtureProject {
  return { key, issues };
}

function contextFor(http: AtlassianHttpBodyPort, maxItems = 2_000): AtlassianSyncFetchContext {
  return { http, deadlineExceeded: () => false, maxItems };
}

function sourceFor(
  projects: readonly JiraFixtureProject[],
  options: Partial<JiraSyncSourceOptions> = {},
  fixture: Partial<Parameters<typeof createInMemoryJiraFixture>[0]> = {},
): {
  readonly source: ReturnType<typeof createJiraSyncSource>;
  readonly context: AtlassianSyncFetchContext;
  readonly requests: AtlassianHttpBodyRequest[];
} {
  const requests: AtlassianHttpBodyRequest[] = [];
  const http = createInMemoryJiraFixture({
    baseUrl: BASE_URL,
    projects,
    onRequest: (request) => {
      requests.push(request);
    },
    ...fixture,
  });
  const source = createJiraSyncSource({
    baseUrl: BASE_URL,
    connectorId: "cred-test",
    projectKeys: projects.map((entry) => entry.key),
    ...options,
  });
  return { source, context: contextFor(http), requests };
}

async function fetchedItem(
  harness: ReturnType<typeof sourceFor>,
  issueId: string,
): Promise<AtlassianSyncItem> {
  const outcome = await harness.source.fetchItem(
    { itemKey: `jira:cred-test:${issueId}`, issueId },
    harness.context,
  );
  if (outcome.kind !== "item") throw new Error(`expected item, got ${outcome.kind}`);
  return outcome.item;
}

describe("createJiraSyncSource — construction guards", () => {
  it("refuses invalid connector ids, empty scopes, invalid project keys, bad URLs, and oversized JQL", () => {
    const base = { baseUrl: BASE_URL, connectorId: "cred-x", projectKeys: ["PLAT"] };
    expect(() => createJiraSyncSource({ ...base, connectorId: "a:b" })).toThrow(
      AtlassianCredentialCustodyError,
    );
    expect(() => createJiraSyncSource({ ...base, projectKeys: [] })).toThrow(
      AtlassianCredentialCustodyError,
    );
    expect(() => createJiraSyncSource({ ...base, projectKeys: ["lower"] })).toThrow(
      AtlassianCredentialCustodyError,
    );
    expect(() => createJiraSyncSource({ ...base, baseUrl: "http://tenant.example" })).toThrow(
      AtlassianCredentialCustodyError,
    );
    expect(() => createJiraSyncSource({ ...base, jql: "" })).toThrow(
      AtlassianCredentialCustodyError,
    );
    expect(() => createJiraSyncSource({ ...base, jql: "x".repeat(3000) })).toThrow(
      AtlassianCredentialCustodyError,
    );
  });
});

describe("JQL composition", () => {
  it("scopes to the approved projects with stable ordering when no user JQL is present", () => {
    expect(composeJiraScopeJql(["PLAT", "CORE"], undefined)).toBe(
      "project IN (PLAT, CORE) ORDER BY id ASC",
    );
  });

  it("narrows with AND-parenthesized opaque user JQL", () => {
    expect(composeJiraScopeJql(["PLAT"], 'labels = auth AND text ~ "login"')).toBe(
      'project IN (PLAT) AND (labels = auth AND text ~ "login")',
    );
  });

  it("transports the composed JQL in the search request URL", async () => {
    const harness = sourceFor([project("PLAT", [fixtureIssue(1)])], { jql: "labels = auth" });
    await harness.source.enumerate(harness.context);
    const search = harness.requests.find((request) => request.url.includes("/search/jql"));
    expect(search).toBeDefined();
    const jql = new URL(search?.url ?? "").searchParams.get("jql");
    expect(jql).toBe("project IN (PLAT) AND (labels = auth)");
  });
});

describe("enumerate — full id-set walk with token pagination", () => {
  it("enumerates a ≥50-issue project across nextPageToken pages", async () => {
    const issues = Array.from({ length: 55 }, (_, index) => fixtureIssue(index + 1));
    const harness = sourceFor([project("PLAT", issues)]);
    const outcome = await harness.source.enumerate(harness.context);
    expect(outcome).toMatchObject({ ok: true, complete: true });
    if (!outcome.ok) throw new Error("unreachable");
    expect(outcome.refs).toHaveLength(55);
    expect(outcome.refs[0]).toStrictEqual({ itemKey: "jira:cred-test:10001", issueId: "10001" });
    const searchRequests = harness.requests.filter((request) =>
      request.url.includes("/search/jql"),
    );
    expect(searchRequests).toHaveLength(6);
  });

  it("stops early with complete=false once the enumeration crosses the lane's item ceiling", async () => {
    const issues = Array.from({ length: 30 }, (_, index) => fixtureIssue(index + 1));
    const requests: AtlassianHttpBodyRequest[] = [];
    const http = createInMemoryJiraFixture({
      baseUrl: BASE_URL,
      projects: [project("PLAT", issues)],
      onRequest: (request) => {
        requests.push(request);
      },
    });
    const source = createJiraSyncSource({
      baseUrl: BASE_URL,
      connectorId: "cred-test",
      projectKeys: ["PLAT"],
    });
    const outcome = await source.enumerate(contextFor(http, 20));
    expect(outcome).toMatchObject({ ok: true, complete: false });
  });

  it("never snapshots a truncated enumeration", async () => {
    const issues = Array.from({ length: 30 }, (_, index) => fixtureIssue(index + 1));
    const snapshots: JiraSyncEnumerationSnapshot[] = [];
    const http = createInMemoryJiraFixture({
      baseUrl: BASE_URL,
      projects: [project("PLAT", issues)],
    });
    const source = createJiraSyncSource({
      baseUrl: BASE_URL,
      connectorId: "cred-test",
      projectKeys: ["PLAT"],
      onEnumerated: (snapshot) => {
        snapshots.push(snapshot);
      },
    });
    await source.enumerate(contextFor(http, 20));
    expect(snapshots).toHaveLength(0);
  });

  it("maps enumeration transport failures onto the closed reason vocabulary", async () => {
    const cases: readonly (readonly [AtlassianHttpBodyResult, string])[] = [
      [
        { kind: "response", status: 401, bodyText: "", bodyBytes: 0, truncated: false },
        "auth-failed",
      ],
      [
        { kind: "response", status: 403, bodyText: "", bodyBytes: 0, truncated: false },
        "permission-denied",
      ],
      [
        { kind: "response", status: 429, bodyText: "", bodyBytes: 0, truncated: false },
        "rate-limited",
      ],
      [
        { kind: "response", status: 503, bodyText: "", bodyBytes: 0, truncated: false },
        "unavailable",
      ],
      [{ kind: "timeout" }, "timeout"],
      [{ kind: "network-error" }, "unavailable"],
      [
        { kind: "response", status: 200, bodyText: "<not json", bodyBytes: 9, truncated: false },
        "malformed-payload",
      ],
      [
        { kind: "response", status: 200, bodyText: "{}", bodyBytes: 2, truncated: false },
        "malformed-payload",
      ],
    ];
    for (const [result, reason] of cases) {
      const source = createJiraSyncSource({
        baseUrl: BASE_URL,
        connectorId: "cred-test",
        projectKeys: ["PLAT"],
      });
      const outcome = await source.enumerate(contextFor(() => Promise.resolve(result)));
      expect(outcome).toStrictEqual({ ok: false, reason });
    }
  });

  it("skips hostile search entries (missing/unsafe ids or keys) instead of failing the walk", async () => {
    const payload = {
      issues: [
        {
          id: "10001",
          key: "PLAT-1",
          fields: { summary: "ok", updated: "2026-05-01T10:00:00.000+0000" },
        },
        { id: "not-numeric", key: "PLAT-2", fields: {} },
        { id: "10003", key: "not a key!", fields: {} },
        { id: "10004" },
        "not-a-record",
      ],
      isLast: true,
    };
    const source = createJiraSyncSource({
      baseUrl: BASE_URL,
      connectorId: "cred-test",
      projectKeys: ["PLAT"],
    });
    const outcome = await source.enumerate(
      contextFor(() =>
        Promise.resolve({
          kind: "response",
          status: 200,
          bodyText: JSON.stringify(payload),
          bodyBytes: JSON.stringify(payload).length,
          truncated: false,
        }),
      ),
    );
    expect(outcome).toMatchObject({ ok: true, complete: true });
    if (!outcome.ok) throw new Error("unreachable");
    expect(outcome.refs.map((ref) => ref.issueId)).toStrictEqual(["10001"]);
  });

  it("treats an explicit null nextPageToken as the last page", async () => {
    const payload = { issues: [], nextPageToken: null };
    const source = createJiraSyncSource({
      baseUrl: BASE_URL,
      connectorId: "cred-test",
      projectKeys: ["PLAT"],
    });
    const outcome = await source.enumerate(
      contextFor(() =>
        Promise.resolve({
          kind: "response",
          status: 200,
          bodyText: JSON.stringify(payload),
          bodyBytes: 40,
          truncated: false,
        }),
      ),
    );
    expect(outcome).toStrictEqual({ ok: true, refs: [], complete: true });
  });

  it("terminates a never-ending token chain at the request ceiling as malformed-payload", async () => {
    const body = JSON.stringify({ issues: [], nextPageToken: "again" });
    const source = createJiraSyncSource({
      baseUrl: BASE_URL,
      connectorId: "cred-test",
      projectKeys: ["PLAT"],
    });
    const outcome = await source.enumerate(
      contextFor(() =>
        Promise.resolve({
          kind: "response",
          status: 200,
          bodyText: body,
          bodyBytes: body.length,
          truncated: false,
        }),
      ),
    );
    expect(outcome).toStrictEqual({ ok: false, reason: "malformed-payload" });
  });

  it("fails enumeration with timeout once the run deadline is exceeded", async () => {
    const source = createJiraSyncSource({
      baseUrl: BASE_URL,
      connectorId: "cred-test",
      projectKeys: ["PLAT"],
    });
    const context: AtlassianSyncFetchContext = {
      http: () => Promise.resolve({ kind: "network-error" }),
      deadlineExceeded: () => true,
      maxItems: 100,
    };
    expect(await source.enumerate(context)).toStrictEqual({ ok: false, reason: "timeout" });
  });

  it("rejects a hostile oversized nextPageToken as malformed-payload", async () => {
    const http: AtlassianHttpBodyPort = () =>
      Promise.resolve({
        kind: "response",
        status: 200,
        bodyText: JSON.stringify({ issues: [], nextPageToken: "t".repeat(5_000) }),
        bodyBytes: 5_100,
        truncated: false,
      });
    const source = createJiraSyncSource({
      baseUrl: BASE_URL,
      connectorId: "cred-test",
      projectKeys: ["PLAT"],
    });
    expect(await source.enumerate(contextFor(http))).toStrictEqual({
      ok: false,
      reason: "malformed-payload",
    });
  });
});

describe("incremental partition — updated-watermark narrowing", () => {
  const WATERMARK = "2026-05-01T10:00:00.000+0000";
  const BEFORE_OVERLAP = "2026-05-01T09:54:59.000+0000"; // watermark - overlap - 1s → carried
  const INSIDE_OVERLAP = "2026-05-01T09:55:01.000+0000"; // inside overlap → re-fetched
  const AFTER_WATERMARK = "2026-05-01T11:00:00.000+0000";

  it("carries known unchanged issues, re-fetches updated/overlap/new/unparseable ones, and snapshots the watermark", async () => {
    const issues = [
      fixtureIssue(1, { updated: BEFORE_OVERLAP }),
      fixtureIssue(2, { updated: INSIDE_OVERLAP }),
      fixtureIssue(3, { updated: AFTER_WATERMARK }),
      fixtureIssue(4, { updated: BEFORE_OVERLAP }), // not in baseline → force-fetched
      fixtureIssue(5, { updated: "garbage-timestamp" }),
    ];
    const snapshots: JiraSyncEnumerationSnapshot[] = [];
    const harness = sourceFor([project("PLAT", issues)], {
      incremental: {
        providerWatermark: WATERMARK,
        knownItemKeys: [
          "jira:cred-test:10001",
          "jira:cred-test:10002",
          "jira:cred-test:10003",
          "jira:cred-test:10005",
        ],
      },
      onEnumerated: (snapshot) => {
        snapshots.push(snapshot);
      },
    });
    const outcome = await harness.source.enumerate(harness.context);
    if (!outcome.ok) throw new Error("expected ok enumeration");
    expect(outcome.refs.map((ref) => ref.issueId)).toStrictEqual([
      "10002",
      "10003",
      "10004",
      "10005",
    ]);
    expect(snapshots).toStrictEqual([
      {
        carriedItemKeys: ["jira:cred-test:10001"],
        providerWatermark: AFTER_WATERMARK,
      },
    ]);
    expect(parseJiraProviderTimestampMs(WATERMARK)).toBe(
      Date.parse("2026-05-01T10:00:00.000+00:00"),
    );
    const insideOverlapMs = parseJiraProviderTimestampMs(INSIDE_OVERLAP) ?? NaN;
    const watermarkMs = parseJiraProviderTimestampMs(WATERMARK) ?? NaN;
    expect(insideOverlapMs >= watermarkMs - JIRA_INCREMENTAL_SYNC_OVERLAP_MS).toBe(true);
  });

  it("re-fetches everything fail-closed when the persisted watermark is unparseable", async () => {
    const issues = [fixtureIssue(1, { updated: BEFORE_OVERLAP })];
    const harness = sourceFor([project("PLAT", issues)], {
      incremental: {
        providerWatermark: "not-a-timestamp",
        knownItemKeys: ["jira:cred-test:10001"],
      },
    });
    const outcome = await harness.source.enumerate(harness.context);
    if (!outcome.ok) throw new Error("expected ok enumeration");
    expect(outcome.refs).toHaveLength(1);
  });

  it("orders provider timestamps by UTC instant with unparseable candidates ignored", () => {
    expect(laterJiraProviderTimestamp(undefined, WATERMARK)).toBe(WATERMARK);
    expect(laterJiraProviderTimestamp(WATERMARK, AFTER_WATERMARK)).toBe(AFTER_WATERMARK);
    expect(laterJiraProviderTimestamp(AFTER_WATERMARK, WATERMARK)).toBe(AFTER_WATERMARK);
    expect(laterJiraProviderTimestamp(WATERMARK, "garbage")).toBe(WATERMARK);
    expect(laterJiraProviderTimestamp("garbage", WATERMARK)).toBe(WATERMARK);
    expect(laterJiraProviderTimestamp(undefined, undefined)).toBeUndefined();
  });
});

describe("fetchItem — issue documents, metadata, and the failure matrix", () => {
  const RICH_FIELDS: Record<string, unknown> = {
    status: { name: "In Progress" },
    issuetype: { name: "Bug" },
    assignee: { displayName: "Alice Example" },
    labels: ["auth"],
    priority: { name: "High" },
    timetracking: { originalEstimate: "1w", remainingEstimate: "2d" },
    parent: { key: "PLAT-1" },
    subtasks: [{ key: "PLAT-3" }],
    issuelinks: [{ type: { outward: "blocks" }, outwardIssue: { key: "PLAT-9" } }],
  };

  it("composes one document per issue: KEY: summary title, metadata line, description, ordered comments, browse link", async () => {
    const issue = fixtureIssue(2, {
      summary: "Fix login flow",
      extraFields: RICH_FIELDS,
      descriptionAdf: {
        type: "doc",
        version: 1,
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Steps below." }] },
          {
            type: "bulletList",
            content: [
              {
                type: "listItem",
                content: [{ type: "paragraph", content: [{ type: "text", text: "First" }] }],
              },
            ],
          },
        ],
      },
      comments: [
        {
          author: "Alice Example",
          created: "2026-05-01T10:22:33.000+0000",
          bodyAdf: adf("First comment."),
        },
        {
          author: "Bob Reporter",
          created: "2026-05-02T08:00:00.000+0000",
          bodyAdf: adf("Second comment."),
        },
      ],
    });
    const harness = sourceFor([project("PLAT", [issue])]);
    const item = await fetchedItem(harness, issue.issueId);
    expect(item.title).toBe("PLAT-2: Fix login flow");
    expect(item.relativePath).toBe(`issues/${issue.issueId}.html`);
    expect(item.webuiPath).toBe("/browse/PLAT-2");
    expect(item.contentHtml).toContain("Status: In Progress | Type: Bug | Priority: High");
    expect(item.contentHtml).toContain("Remaining estimate: 2d");
    expect(item.contentHtml).toContain("Steps below.");
    expect(item.contentHtml).toContain("- First");
    const firstComment = item.contentHtml.indexOf("Alice Example — 2026-05-01T10:22:33.000+0000");
    const secondComment = item.contentHtml.indexOf("Bob Reporter — 2026-05-02T08:00:00.000+0000");
    expect(firstComment).toBeGreaterThan(-1);
    expect(secondComment).toBeGreaterThan(firstComment);
    const metadata = JSON.parse(item.citationMetadataJson ?? "{}") as Record<string, unknown>;
    expect(metadata).toMatchObject({
      issueKey: "PLAT-2",
      status: "In Progress",
      issueType: "Bug",
      labels: ["auth"],
      remainingEstimate: "2d",
      parentKey: "PLAT-1",
      subtaskKeys: ["PLAT-3"],
      linkedIssues: [{ linkType: "blocks", issueKey: "PLAT-9" }],
    });
  });

  it("captures absence: an issue without optional fields yields minimal metadata and no empty sections", async () => {
    const issue = fixtureIssue(7, { descriptionAdf: undefined });
    const harness = sourceFor([project("PLAT", [issue])]);
    const item = await fetchedItem(harness, issue.issueId);
    const metadata = JSON.parse(item.citationMetadataJson ?? "{}") as Record<string, unknown>;
    expect(metadata.issueKey).toBe("PLAT-7");
    expect(metadata.parentKey).toBeUndefined();
    expect(metadata.subtaskKeys).toBeUndefined();
    expect(metadata.linkedIssues).toBeUndefined();
    expect(metadata.remainingEstimate).toBeUndefined();
    expect(item.contentHtml).not.toContain("data-connector-description");
    expect(item.contentHtml).not.toContain("data-connector-comments");
  });

  it("classifies the per-issue failure matrix: 401 fatal, 403 denied, 404 missing, 429 rate-limited, 5xx unavailable, timeout, malformed", async () => {
    const issues = [
      fixtureIssue(1, { bodyStatus: 401 }),
      fixtureIssue(2, { bodyStatus: 403 }),
      fixtureIssue(3, { bodyStatus: 500 }),
      fixtureIssue(4, { malformedBody: true }),
      fixtureIssue(5, { bodyStatus: 429 }),
    ];
    const harness = sourceFor([project("PLAT", issues)]);
    await expect(fetchedItemOutcome(harness, "10001")).resolves.toStrictEqual({
      kind: "fatal",
      reason: "auth-failed",
    });
    await expect(fetchedItemOutcome(harness, "10002")).resolves.toStrictEqual({
      kind: "skipped",
      reason: "permission-denied",
    });
    await expect(fetchedItemOutcome(harness, "99999")).resolves.toStrictEqual({ kind: "missing" });
    await expect(fetchedItemOutcome(harness, "10003")).resolves.toStrictEqual({
      kind: "skipped",
      reason: "unavailable",
    });
    await expect(fetchedItemOutcome(harness, "10004")).resolves.toStrictEqual({
      kind: "skipped",
      reason: "malformed-payload",
    });
    await expect(fetchedItemOutcome(harness, "10005")).resolves.toStrictEqual({
      kind: "skipped",
      reason: "rate-limited",
    });
    const timeoutSource = createJiraSyncSource({
      baseUrl: BASE_URL,
      connectorId: "cred-test",
      projectKeys: ["PLAT"],
    });
    await expect(
      timeoutSource.fetchItem(
        { itemKey: "jira:cred-test:1", issueId: "1" },
        contextFor(() => Promise.resolve({ kind: "timeout" })),
      ),
    ).resolves.toStrictEqual({ kind: "skipped", reason: "timeout" });
  });

  it("skips a transport-truncated issue payload with bounds-exceeded", async () => {
    const source = createJiraSyncSource({
      baseUrl: BASE_URL,
      connectorId: "cred-test",
      projectKeys: ["PLAT"],
    });
    const outcome = await source.fetchItem(
      { itemKey: "jira:cred-test:1", issueId: "1" },
      contextFor(() =>
        Promise.resolve({
          kind: "response",
          status: 200,
          bodyText: '{"id":"1"',
          bodyBytes: 9,
          truncated: true,
        }),
      ),
    );
    expect(outcome).toStrictEqual({ kind: "skipped", reason: "bounds-exceeded" });
  });

  it("degrades comment failures to an issue without comments (the body remains citable)", async () => {
    const issue = fixtureIssue(3, { comments: [{ author: "A", created: "t", bodyAdf: adf("c") }] });
    const harness = sourceFor(
      [project("PLAT", [issue])],
      {},
      {
        override: (request) =>
          request.url.includes("/comment")
            ? { kind: "response", status: 500, bodyText: "", bodyBytes: 0, truncated: false }
            : undefined,
      },
    );
    const item = await fetchedItem(harness, issue.issueId);
    expect(item.contentHtml).toContain("Description of issue 3.");
    expect(item.contentHtml).not.toContain("data-connector-comments");
  });

  it("skips an issue whose payload carries an unsafe key as malformed-payload", async () => {
    const issue = fixtureIssue(9, { key: "not a key!" });
    const harness = sourceFor([project("PLAT", [issue])]);
    await expect(fetchedItemOutcome(harness, issue.issueId)).resolves.toStrictEqual({
      kind: "skipped",
      reason: "malformed-payload",
    });
  });

  it("bounds and indexes the 10k-node hostile ADF document within a wall-clock budget, with an explicit degradation marker", async () => {
    const issue = fixtureIssue(6, { descriptionAdf: buildHostileJiraAdfDocument(10_000) });
    const harness = sourceFor([project("PLAT", [issue])]);
    const startedAt = performance.now();
    const item = await fetchedItem(harness, issue.issueId);
    expect(performance.now() - startedAt).toBeLessThan(5_000);
    expect(item.byteLength).toBeLessThanOrEqual(2_000_000);
    expect(item.contentHtml).toContain("hostile breadth node 0");
    // The fixture's 100-deep chain exceeds the converter depth cap: bounded, marked, indexed.
    expect(item.contentHtml).toContain("[Content truncated: conversion limits reached]");
  });

  it("truncates a node-budget-exceeding hostile document with an explicit conversion marker", async () => {
    const issue = fixtureIssue(8, { descriptionAdf: buildHostileJiraAdfDocument(45_000) });
    const harness = sourceFor([project("PLAT", [issue])]);
    const item = await fetchedItem(harness, issue.issueId);
    expect(item.contentHtml).toContain("[Content truncated: conversion limits reached]");
  });
});

async function fetchedItemOutcome(
  harness: ReturnType<typeof sourceFor>,
  issueId: string,
): Promise<unknown> {
  return harness.source.fetchItem(
    { itemKey: `jira:cred-test:${issueId}`, issueId },
    harness.context,
  );
}
