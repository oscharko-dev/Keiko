import { describe, expect, it, vi } from "vitest";
import {
  JIRA_MANAGED_READ_TOOLS,
  type JiraManagedReadToolName,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type {
  CanonicalToolId,
  CatalogDigest,
  CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type {
  ManagedMcpInvocationContext,
  ManagedMcpProvider,
  ManagedMcpToolDeclaration,
  ManagedMcpToolResult,
} from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { createJiraManagedProvider, type JiraManagedConnection } from "./jira-managed-tools.js";
import type { AtlassianHttpBodyPort } from "./atlassian-http-port.js";
import { field, response } from "../../../tests/support/jira-managed-remote.js";

// The connector owns handler selection, argument validation and remote projection; the server
// owns the public schemas. These private declarations exercise every advertised read handler.
function declaration(name: string, risk: "read" | "write" = "read"): ManagedMcpToolDeclaration {
  return {
    name,
    risk,
    descriptor: {
      toolRef: { canonicalId: `fixture.${name}` as CanonicalToolId, contractVersion: 1 },
      descriptorDigest: "a".repeat(64) as CatalogDigest,
      description: "Synthetic Jira read declaration",
      inputSchema: { type: "object" },
      resultSchema: { type: "object" },
      effects: ["connector-access"],
      actionMapping: [{ action: name, effects: ["connector-access"] }],
      policyReferences: ["adr-0128.d4"],
      handlerRequirement: { id: name, contractVersion: 1 },
      bounds: {
        maxArgumentBytes: 8192,
        maxResultBytes: 262144,
        maxResultCount: 100,
        maxDurationMs: 15000,
      },
      idempotency: "read-only",
      cancellation: "before-effect",
    },
  };
}
interface ReadFixture {
  readonly http: ReturnType<typeof vi.fn<AtlassianHttpBodyPort>>;
  readonly connection: ReturnType<typeof vi.fn<() => JiraManagedConnection>>;
  readonly beforeEffect: ReturnType<typeof vi.fn<() => boolean>>;
  readonly controller: AbortController;
  readonly provider: ManagedMcpProvider<ManagedMcpInvocationContext>;
  readonly run: (
    name: JiraManagedReadToolName,
    args?: CatalogJsonObject,
  ) => Promise<ManagedMcpToolResult>;
}
function fixture(body: unknown, deployment: "data-center" | "cloud" = "data-center"): ReadFixture {
  const http = vi.fn<AtlassianHttpBodyPort>(() => Promise.resolve(response(body)));
  const connection = vi.fn(() => ({
    deployment,
    baseUrl: "https://jira.example.invalid/context",
    http,
  }));
  const beforeEffect = vi.fn(() => true);
  const controller = new AbortController();
  const provider = createJiraManagedProvider({
    connection,
    declarations: JIRA_MANAGED_READ_TOOLS.map((name) => declaration(name)),
  });
  return {
    http,
    connection,
    beforeEffect,
    controller,
    provider,
    run: async (
      name: JiraManagedReadToolName,
      args: CatalogJsonObject = {},
    ): Promise<ManagedMcpToolResult> => {
      const tool = provider.tools().find((candidate) => candidate.name === name);
      if (tool === undefined) throw new TypeError("Missing advertised read");
      const result = await tool.execute(args, {
        invocationId: "synthetic-read",
        correlationId: "synthetic-read",
        signal: controller.signal,
        beforeEffect,
      });
      for (const [request] of http.mock.calls) {
        expect(request.method).toBe("GET");
        expect(request.bodyJson).toBeUndefined();
        expect(request.maxBodyBytes).toBeLessThanOrEqual(262144);
        expect(request.signal).toBe(controller.signal);
      }
      return result;
    },
  };
}
const ISSUE = {
  id: "10001",
  key: "SYN-1",
  fields: {
    summary: "Synthetic issue",
    description: "Synthetic description",
    labels: ["synthetic"],
    assignee: null,
    status: { id: "1", name: "Open", self: "omit-me" },
    reporter: { name: "reader", displayName: "Reader", emailAddress: "omit-me" },
    created: "2026-10-28",
    updated: "2026-10-29",
    duedate: "2026-10-30",
  },
};
const COMMENT = { id: "10", body: "Synthetic comment", created: "2026-10-28" };
const PROJECTS = [
  { id: "2", key: "ZZZ", name: "Last" },
  { id: "1", key: "AAA", name: "First", self: "omit-me" },
];
const META = field("summary", "string", true);
const REMOTE_PAGE = { startAt: 0, maxResults: 25, total: 1, isLast: true };
const READS: readonly {
  name: JiraManagedReadToolName;
  args: CatalogJsonObject;
  body: unknown;
  path: string;
}[] = [
  { name: "jira.projects", args: {}, body: PROJECTS, path: "project" },
  {
    name: "jira.issue-types",
    args: { projectKey: "SYN" },
    path: "issue/createmeta/SYN/issuetypes",
    body: { ...REMOTE_PAGE, values: [{ id: "1", name: "Task", subtask: false }] },
  },
  {
    name: "jira.create-fields",
    args: { projectKey: "SYN", issueTypeId: "1" },
    path: "issue/createmeta/SYN/issuetypes/1",
    body: { ...REMOTE_PAGE, values: [META] },
  },
  {
    name: "jira.edit-fields",
    args: { issueKey: "SYN-1" },
    path: "issue/SYN-1/editmeta",
    body: { fields: { summary: META } },
  },
  {
    name: "jira.search",
    args: { jql: 'project = "SYN"' },
    path: "search",
    body: { startAt: 0, maxResults: 25, total: 1, issues: [ISSUE] },
  },
  { name: "jira.issue", args: { issueKey: "SYN-1" }, path: "issue/SYN-1", body: ISSUE },
  {
    name: "jira.comments",
    args: { issueKey: "SYN-1" },
    path: "issue/SYN-1/comment",
    body: { startAt: 0, maxResults: 25, total: 1, comments: [COMMENT] },
  },
  {
    name: "jira.transitions",
    args: { issueKey: "SYN-1" },
    path: "issue/SYN-1/transitions",
    body: {
      transitions: [
        { id: "31", name: "Finish", to: { id: "2", name: "Done" }, fields: { summary: META } },
      ],
    },
  },
  {
    name: "jira.assignable-users",
    args: { projectKey: "SYN", query: "reader" },
    path: "user/assignable/search",
    body: [{ name: "reader", displayName: "Reader", active: true, emailAddress: "omit-me" }],
  },
];

describe("source managed Jira read dispatch", () => {
  it.each(READS)(
    "executes $name through the context-bound DC v2 HTTP port",
    async ({ name, args, body, path }) => {
      const f = fixture(body);
      const result = await f.run(name, args);
      expect(result.isError).toBeUndefined();
      expect(result.data).toMatchObject({ outcome: "succeeded", startAt: 0 });
      expect(result.data.items).toHaveLength(name === "jira.projects" ? 2 : 1);
      expect(JSON.stringify(result)).not.toContain("omit-me");
      expect(f.http).toHaveBeenCalledTimes(1);
      const url = new URL(f.http.mock.calls[0]?.[0].url ?? "");
      expect(url.origin).toBe("https://jira.example.invalid");
      expect(url.pathname).toBe(`/context/rest/api/2/${path}`);
      expect(f.beforeEffect).toHaveBeenCalledTimes(1);
      if (name === "jira.search") expect(url.searchParams.get("jql")).toBe(args.jql);
      if (name === "jira.assignable-users") expect(url.searchParams.get("username")).toBe("reader");
      if (name === "jira.transitions")
        expect(url.searchParams.get("expand")).toBe("transitions.fields");
    },
  );
  it("keeps its advertised inventory stable and rejects unsupported declaration/risk pairs", () => {
    const f = fixture([]);
    expect(f.provider.tools()).toBe(f.provider.tools());
    expect(f.provider.tools().map(({ name }) => name)).toEqual(JIRA_MANAGED_READ_TOOLS);
    for (const entry of [
      declaration("jira.unknown"),
      declaration("jira.issue", "write"),
      declaration("jira.comment", "write"),
    ]) {
      expect(() =>
        createJiraManagedProvider({ connection: f.connection, declarations: [entry] }),
      ).toThrow(TypeError);
    }
  });
  it.each(READS)(
    "refuses cloud $name without guessing a v3 route",
    async ({ name, args, body }) => {
      const f = fixture(body, "cloud");
      expect(await f.run(name, args)).toEqual({
        data: { outcome: "failed", reason: "unsupported-deployment" },
        isError: true,
      });
      expect(f.http).not.toHaveBeenCalled();
    },
  );
  it.each(["denied", "cancelled"])("keeps %s reads free of remote effects", async (mode) => {
    const f = fixture(PROJECTS);
    if (mode === "denied") f.beforeEffect.mockReturnValue(false);
    else f.controller.abort();
    expect((await f.run("jira.projects")).isError).toBe(true);
    expect(f.http).not.toHaveBeenCalled();
  });
});

it.each([
  ["jira.projects", { extra: true }],
  ["jira.projects", { startAt: -1 }],
  ["jira.projects", { startAt: 1000001 }],
  ["jira.projects", { maxResults: 0 }],
  ["jira.projects", { maxResults: 101 }],
  ["jira.projects", { maxResults: 1.5 }],
  ["jira.issue", { issueKey: "../secret" }],
  ["jira.issue", { issueKey: "SYN-1", fields: [] }],
  ["jira.issue", { issueKey: "SYN-1", startAt: 0 }],
  ["jira.search", { jql: "" }],
  ["jira.search", { jql: "x".repeat(100001) }],
  ["jira.issue-types", { projectKey: "../x" }],
  ["jira.create-fields", { projectKey: "SYN", issueTypeId: "invalid" }],
  ["jira.create-fields", { projectKey: "SYN" }],
  ["jira.comments", {}],
  ["jira.assignable-users", {}],
  ["jira.assignable-users", { issueKey: "SYN-1", projectKey: "SYN" }],
  ["jira.assignable-users", { projectKey: "SYN", query: 1 }],
  ["jira.assignable-users", { projectKey: "SYN", query: "x".repeat(257) }],
] satisfies readonly (readonly [JiraManagedReadToolName, CatalogJsonObject])[])(
  "refuses invalid %s input %j before connection resolution",
  async (name, args) => {
    const f = fixture({});
    expect(await f.run(name, args)).toEqual({
      data: { outcome: "failed", reason: "invalid-input" },
      isError: true,
    });
    expect(f.connection).not.toHaveBeenCalled();
    expect(f.http).not.toHaveBeenCalled();
  },
);

it.each([
  [401, "auth-failed"],
  [403, "permission-denied"],
  [404, "not-found"],
  [400, "field-validation"],
  [409, "conflict"],
] as const)(
  "returns closed failure for HTTP %s without exposing remote details",
  async (status, reason) => {
    const f = fixture({});
    f.http.mockResolvedValue(response({ privateDetail: "omit-me" }, status));
    expect(await f.run("jira.projects")).toEqual({
      data: { outcome: "failed", reason },
      isError: true,
    });
    expect(f.http).toHaveBeenCalledTimes(1);
  },
);

it.each(["timeout", "network-error"] as const)(
  "classifies %s without pretending to observe a project",
  async (kind) => {
    const f = fixture([]);
    f.http.mockResolvedValue({ kind });
    expect(await f.run("jira.projects")).toMatchObject({
      isError: true,
      data: { outcome: "failed", reason: kind === "timeout" ? "timeout" : "unavailable" },
    });
  },
);

it.each([
  ["jira.projects", {}, {}],
  ["jira.projects", {}, [PROJECTS[0], PROJECTS[0]]],
  ["jira.projects", {}, [{ id: "1", key: "SYN" }]],
  ["jira.issue", { issueKey: "SYN-1" }, {}],
  [
    "jira.issue",
    { issueKey: "SYN-1" },
    { ...ISSUE, fields: { ...ISSUE.fields, description: { type: "doc" } } },
  ],
  ["jira.issue", { issueKey: "SYN-1" }, { ...ISSUE, fields: { ...ISSUE.fields, labels: [1] } }],
  [
    "jira.search",
    { jql: "project=SYN" },
    { startAt: 1, maxResults: 25, total: 1, issues: [ISSUE] },
  ],
  [
    "jira.search",
    { jql: "project=SYN" },
    { startAt: 0, maxResults: 25, total: "1", issues: [ISSUE] },
  ],
  [
    "jira.comments",
    { issueKey: "SYN-1" },
    { startAt: 0, maxResults: 25, total: 2, comments: [COMMENT, COMMENT] },
  ],
  [
    "jira.comments",
    { issueKey: "SYN-1" },
    { startAt: 0, maxResults: 25, total: 1, comments: [{ ...COMMENT, created: 1 }] },
  ],
  ["jira.transitions", { issueKey: "SYN-1" }, { transitions: [{ id: "1" }] }],
  [
    "jira.transitions",
    { issueKey: "SYN-1" },
    { transitions: [{ id: "1", name: "Open", fields: [] }] },
  ],
  ["jira.edit-fields", { issueKey: "SYN-1" }, { fields: [] }],
  ["jira.create-fields", { projectKey: "SYN", issueTypeId: "1" }, { ...REMOTE_PAGE, values: [{}] }],
  [
    "jira.issue-types",
    { projectKey: "SYN" },
    { ...REMOTE_PAGE, values: [{ id: "x", name: "Task", subtask: false }] },
  ],
  ["jira.assignable-users", { projectKey: "SYN" }, [{ name: "reader", active: true }]],
] satisfies readonly (readonly [JiraManagedReadToolName, CatalogJsonObject, unknown])[])(
  "fails closed on malformed %s payload %j",
  async (name, args, body) => {
    expect(await fixture(body).run(name, args)).toMatchObject({
      isError: true,
      data: { outcome: "failed", reason: "malformed-payload" },
    });
  },
);

it("sorts and slices a fully validated local project collection", async () => {
  const f = fixture(PROJECTS);
  expect((await f.run("jira.projects", { maxResults: 1 })).data).toEqual({
    outcome: "succeeded",
    items: [{ id: "1", key: "AAA", name: "First" }],
    startAt: 0,
    total: 2,
    nextStartAt: 1,
  });
  expect((await f.run("jira.projects", { startAt: 1, maxResults: 1 })).data).toEqual({
    outcome: "succeeded",
    items: [{ id: "2", key: "ZZZ", name: "Last" }],
    startAt: 1,
    total: 2,
  });
});
it("returns search continuation only at the validated remote page boundary", async () => {
  const f = fixture({ startAt: 2, maxResults: 1, total: 4, issues: [ISSUE] });
  const result = await f.run("jira.search", { jql: "project=SYN", startAt: 2, maxResults: 1 });
  expect(result.data).toMatchObject({ startAt: 2, total: 4, nextStartAt: 3 });
  expect(result.data.items).toMatchObject([
    {
      key: "SYN-1",
      browseUrl: "https://jira.example.invalid/context/browse/SYN-1",
      assigneeEmpty: true,
    },
  ]);
  expect(JSON.stringify(result)).not.toContain("description");
});
it("keeps legacy metadata paging distinct from issue paging", async () => {
  const f = fixture({ start: 1, size: 1, last: false, total: 3, values: [META] });
  expect(
    (
      await f.run("jira.create-fields", {
        projectKey: "SYN",
        issueTypeId: "1",
        startAt: 1,
        maxResults: 1,
      })
    ).data,
  ).toMatchObject({ startAt: 1, nextStartAt: 2, items: [{ id: "summary", required: true }] });
});
it("retains transition metadata availability and safely omits malformed targets", async () => {
  const f = fixture({
    transitions: [
      { id: "1", name: "First" },
      { id: "2", name: "Second", fields: null, to: {} },
    ],
  });
  expect(
    (await f.run("jira.transitions", { issueKey: "SYN-1", startAt: 1, maxResults: 1 })).data,
  ).toMatchObject({
    items: [{ id: "2", metadataAvailable: false }],
    startAt: 1,
    total: 2,
    browseUrl: "https://jira.example.invalid/context/browse/SYN-1",
  });
});
it("uses issue-scoped assignment lookup and resumes until an actual empty page", async () => {
  const f = fixture([{ name: "reader", displayName: "Reader", active: false }]);
  expect(
    (await f.run("jira.assignable-users", { issueKey: "SYN-1", startAt: 2, maxResults: 1 })).data,
  ).toMatchObject({ startAt: 2, nextStartAt: 3 });
  expect(new URL(f.http.mock.calls[0]?.[0].url ?? "").searchParams.get("issueKey")).toBe("SYN-1");
  f.http.mockResolvedValue(response([]));
  expect((await f.run("jira.assignable-users", { projectKey: "SYN", startAt: 3 })).data).toEqual({
    outcome: "succeeded",
    items: [],
    startAt: 3,
  });
});
it("projects selected custom fields from their observed schema without publishing extra fields", async () => {
  const f = fixture({
    ...ISSUE,
    fields: { ...ISSUE.fields, customfield_1: "Selected", customfield_2: "omit-me" },
    names: { customfield_1: "Synthetic" },
    schema: {
      customfield_1: {
        type: "string",
        custom: "com.atlassian.jira.plugin.system.customfieldtypes:textfield",
      },
    },
  });
  const result = await f.run("jira.issue", { issueKey: "SYN-1", fields: ["customfield_1"] });
  expect(result.data.items).toMatchObject([
    { fieldValues: [{ id: "customfield_1", state: "value", text: "Selected" }] },
  ]);
  const url = new URL(f.http.mock.calls[0]?.[0].url ?? "");
  expect(url.searchParams.get("fields")).toContain("customfield_1");
  expect(url.searchParams.get("expand")).toBe("names,schema");
  expect(JSON.stringify(result)).not.toContain("omit-me");
});
it("bounds a near-cap comment page with a continuation at the first unpublished comment", async () => {
  const comments = Array.from({ length: 30 }, (_, index) => ({
    ...COMMENT,
    id: String(index),
    body: "x".repeat(8600),
  }));
  const f = fixture({ startAt: 0, maxResults: 30, total: 30, comments });
  const result = await f.run("jira.comments", { issueKey: "SYN-1", maxResults: 30 });
  expect(result.data.outcome).toBe("succeeded");
  expect(Array.isArray(result.data.items)).toBe(true);
  const count = Array.isArray(result.data.items) ? result.data.items.length : 0;
  expect(count).toBeGreaterThan(0);
  expect(count).toBeLessThan(comments.length);
  expect(result.data.nextStartAt).toBe(count);
  expect(Buffer.byteLength(JSON.stringify(result.data))).toBeLessThan(262144);
  expect(result.data.items).toEqual(comments.slice(0, count));
});
it("rejects an oversized project collection before silently slicing it", async () => {
  const f = fixture(
    Array.from({ length: 1001 }, (_, index) => ({
      id: String(index),
      key: `S${String(index)}`,
      name: "Synthetic",
    })),
  );
  expect(await f.run("jira.projects")).toEqual({
    isError: true,
    data: { outcome: "failed", reason: "bounds-exceeded" },
  });
});
it("refuses a description whose Unicode bytes exceed the catalog string limit", async () => {
  const f = fixture({ ...ISSUE, fields: { ...ISSUE.fields, description: "漢".repeat(30000) } });
  expect(await f.run("jira.issue", { issueKey: "SYN-1" })).toEqual({
    isError: true,
    data: { outcome: "failed", reason: "bounds-exceeded" },
  });
});
