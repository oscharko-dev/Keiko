import { expect, it, vi } from "vitest";
import type { JiraMutationOperation } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { AtlassianHttpBodyPort, AtlassianHttpBodyResult } from "./atlassian-http-port.js";
import { executeJiraManagedMutation } from "./jira-managed-mutations.js";

function field(id: string, type: string, required = false): Record<string, unknown> {
  return { fieldId: id, name: id, required, operations: ["set"], schema: { type, system: id } };
}
const REQUIRED_CUSTOM = {
  ...field("customfield_10000", "string", true),
  schema: { type: "string", custom: "com.atlassian.jira.plugin.system.customfieldtypes:textfield" },
};
const FIELDS = [
  field("project", "project", true),
  field("issuetype", "issuetype", true),
  field("summary", "string", true),
  REQUIRED_CUSTOM,
];
function response(body: unknown, status = 200): AtlassianHttpBodyResult {
  const bodyText = body === undefined ? "" : JSON.stringify(body);
  return {
    kind: "response",
    status,
    bodyText,
    bodyBytes: Buffer.byteLength(bodyText),
    truncated: false,
  };
}
function fixture(): {
  controller: AbortController;
  beforeEffect: ReturnType<typeof vi.fn<() => boolean>>;
  http: ReturnType<typeof vi.fn<AtlassianHttpBodyPort>>;
  run: (
    operation: JiraMutationOperation,
    args: CatalogJsonObject,
  ) => ReturnType<typeof executeJiraManagedMutation>;
} {
  const http = vi.fn<AtlassianHttpBodyPort>((request) => {
    const path = new URL(request.url).pathname;
    if (request.method === "GET") {
      if (path.includes("createmeta"))
        return Promise.resolve(
          response({ values: FIELDS, start: 0, size: 100, last: true, total: FIELDS.length }),
        );
      if (path.endsWith("editmeta"))
        return Promise.resolve(
          response({
            fields: { summary: field("summary", "string"), assignee: field("assignee", "user") },
          }),
        );
      if (path.endsWith("transitions"))
        return Promise.resolve(
          response({ transitions: [{ id: "31", fields: { customfield_10000: REQUIRED_CUSTOM } }] }),
        );
      if (path.endsWith("assignable/search"))
        return Promise.resolve(response([{ name: "synthetic-user", active: true }]));
    }
    if (path.endsWith("/issue"))
      return Promise.resolve(response({ key: "SYN-1", id: "10001" }, 201));
    if (path.endsWith("/comment")) return Promise.resolve(response({ id: "10002" }, 201));
    return Promise.resolve(response(undefined, 204));
  });
  const controller = new AbortController();
  const beforeEffect = vi.fn(() => true);
  return {
    controller,
    beforeEffect,
    http,
    run: (operation, args) =>
      executeJiraManagedMutation(
        operation,
        args,
        {
          invocationId: "synthetic",
          correlationId: "synthetic",
          signal: controller.signal,
          beforeEffect,
        },
        { deployment: "data-center", baseUrl: "https://jira.example.invalid/context", http },
      ),
  };
}
it("creates through current paged metadata and the selected numeric routing identities", async () => {
  const f = fixture();
  expect(
    await f.run("jira.create", {
      projectId: "10000",
      issueTypeId: "10001",
      fields: { summary: "Synthetic", customfield_10000: "Required" },
    }),
  ).toEqual({ ok: true, receipt: { issueKey: "SYN-1", issueId: "10001" } });
  expect(f.http.mock.calls.map(([request]) => request.method)).toEqual(["GET", "POST"]);
  expect(f.http.mock.calls[0]?.[0].url).toContain(
    "/context/rest/api/2/issue/createmeta/10000/issuetypes/10001?startAt=0&maxResults=100",
  );
  expect(JSON.parse(f.http.mock.calls[1]?.[0].bodyJson ?? "null")).toEqual({
    fields: {
      project: { id: "10000" },
      issuetype: { id: "10001" },
      summary: "Synthetic",
      customfield_10000: "Required",
    },
    update: {},
  });
});
it("edits only fields available in freshly retrieved edit metadata", async () => {
  const f = fixture();
  expect(await f.run("jira.edit", { issueKey: "SYN-1", fields: { summary: "Changed" } })).toEqual({
    ok: true,
    receipt: { issueKey: "SYN-1" },
  });
  expect(f.http.mock.calls.map(([request]) => request.method)).toEqual(["GET", "PUT"]);
  expect(JSON.parse(f.http.mock.calls[1]?.[0].bodyJson ?? "null")).toEqual({
    fields: { summary: "Changed" },
    update: {},
  });
});
it("submits required transition fields and the transition in the same POST", async () => {
  const f = fixture();
  expect(
    await f.run("jira.transition", {
      issueKey: "SYN-1",
      transitionId: "31",
      fields: { customfield_10000: "Screen value" },
    }),
  ).toEqual({ ok: true, receipt: { issueKey: "SYN-1", transitionId: "31" } });
  expect(f.http.mock.calls.map(([request]) => request.method)).toEqual(["GET", "POST"]);
  expect(JSON.parse(f.http.mock.calls[1]?.[0].bodyJson ?? "null")).toEqual({
    transition: { id: "31" },
    fields: { customfield_10000: "Screen value" },
    update: {},
  });
});
it("assigns a current active user with Assign permission without depending on edit metadata", async () => {
  const f = fixture();
  expect(await f.run("jira.assign", { issueKey: "SYN-1", assigneeName: "synthetic-user" })).toEqual(
    { ok: true, receipt: { issueKey: "SYN-1" } },
  );
  expect(f.http.mock.calls.map(([request]) => request.method)).toEqual(["GET", "PUT"]);
  expect(f.http.mock.calls[0]?.[0].url).toContain("/user/assignable/search?");
  expect(JSON.parse(f.http.mock.calls[1]?.[0].bodyJson ?? "null")).toEqual({
    name: "synthetic-user",
  });
});
it("clears an assignee only when current metadata permits clearing", async () => {
  const f = fixture();
  expect(await f.run("jira.assign", { issueKey: "SYN-1", assigneeName: null })).toEqual({
    ok: true,
    receipt: { issueKey: "SYN-1" },
  });
  expect(JSON.parse(f.http.mock.calls[1]?.[0].bodyJson ?? "null")).toEqual({ name: null });
});
it("writes Data Center plain text comments and requires the returned comment identity", async () => {
  const f = fixture();
  expect(await f.run("jira.comment", { issueKey: "SYN-1", body: "Synthetic\ncomment" })).toEqual({
    ok: true,
    receipt: { issueKey: "SYN-1", commentId: "10002" },
  });
  expect(f.http).toHaveBeenCalledOnce();
  expect(JSON.parse(f.http.mock.calls[0]?.[0].bodyJson ?? "null")).toEqual({
    body: "Synthetic\ncomment",
  });
});
it.each(["jira.create", "jira.transition"] as const)(
  "refuses missing required fields for %s before any mutation",
  async (operation) => {
    const f = fixture();
    const args: CatalogJsonObject =
      operation === "jira.create"
        ? { projectId: "10000", issueTypeId: "10001", fields: { summary: "Synthetic" } }
        : { issueKey: "SYN-1", transitionId: "31", fields: {} };
    expect(await f.run(operation, args)).toEqual({ ok: false, reason: "field-validation" });
    expect(f.http.mock.calls.map(([request]) => request.method)).toEqual(["GET"]);
  },
);
it.each([
  ["jira.create", { projectId: "10000/other", issueTypeId: "10001", fields: {} }],
  ["jira.create", { projectId: "10000", issueTypeId: "10001", fields: { project: { id: "999" } } }],
  ["jira.edit", { issueKey: "SYN-1", fields: { project: { id: "999" } } }],
  ["jira.edit", { issueKey: "SYN-1", fields: {} }],
  ["jira.edit", { issueKey: "SYN-1", fields: { summary: "Allowed" }, credentials: "forbidden" }],
  ["jira.transition", { issueKey: "SYN-1", transitionId: "31?extra", fields: {} }],
  ["jira.transition", { issueKey: "SYN-1", transitionId: "31", worklog: {} }],
  ["jira.comment", { issueKey: "SYN-1", body: { type: "doc" } }],
  ["jira.comment", { issueKey: "SYN-1", body: " " }],
  ["jira.comment", { issueKey: "SYN-1", body: "x".repeat(32769) }],
  ["jira.comment", { issueKey: "../outside", body: "Synthetic" }],
  ["jira.assign", { issueKey: "SYN-1", assigneeName: "" }],
  [
    "jira.assign",
    { issueKey: "SYN-1", assigneeName: "synthetic-user", baseUrl: "https://other.invalid" },
  ],
] satisfies [JiraMutationOperation, CatalogJsonObject][])(
  "rejects malformed/routing/compound %s arguments before HTTP (%#)",
  async (operation, args) => {
    const f = fixture();
    expect(await f.run(operation, args)).toEqual({ ok: false, reason: "field-validation" });
    expect(f.http).not.toHaveBeenCalled();
  },
);
it("collects all create pages before validating a required field on a later page", async () => {
  const f = fixture();
  f.http
    .mockResolvedValueOnce(
      response({ values: FIELDS.slice(0, 2), start: 0, size: 100, last: false, total: 4 }),
    )
    .mockResolvedValueOnce(
      response({ values: FIELDS.slice(2), start: 2, size: 100, last: true, total: 4 }),
    );
  expect(
    await f.run("jira.create", {
      projectId: "10000",
      issueTypeId: "10001",
      fields: { summary: "Synthetic" },
    }),
  ).toEqual({ ok: false, reason: "field-validation" });
  expect(f.http.mock.calls.map(([request]) => request.method)).toEqual(["GET", "GET"]);
  expect(f.http.mock.calls[1]?.[0].url).toContain("startAt=2");
});
it("refuses duplicate fields across metadata pages instead of accepting incomplete capability data", async () => {
  const f = fixture();
  f.http
    .mockResolvedValueOnce(
      response({ values: FIELDS.slice(0, 2), start: 0, size: 100, last: false, total: 4 }),
    )
    .mockResolvedValueOnce(
      response({ values: FIELDS.slice(0, 2), start: 2, size: 100, last: true, total: 4 }),
    );
  expect(
    await f.run("jira.create", { projectId: "10000", issueTypeId: "10001", fields: {} }),
  ).toEqual({ ok: false, reason: "malformed-payload" });
  expect(f.http.mock.calls.map(([request]) => request.method)).toEqual(["GET", "GET"]);
});
it("bounds an upstream that never finishes its metadata pages", async () => {
  const f = fixture();
  f.http.mockImplementation((request) =>
    Promise.resolve(
      response({
        values: [FIELDS[0]],
        start: Number(new URL(request.url).searchParams.get("startAt")),
        size: 100,
        last: false,
      }),
    ),
  );
  expect(
    await f.run("jira.create", { projectId: "10000", issueTypeId: "10001", fields: {} }),
  ).toEqual({ ok: false, reason: "bounds-exceeded" });
  expect(f.http).toHaveBeenCalledTimes(10);
  expect(f.http.mock.calls.every(([request]) => request.method === "GET")).toBe(true);
});
it("does not fabricate a required unsupported plugin field", async () => {
  const f = fixture();
  f.http.mockResolvedValueOnce(
    response({
      values: [
        ...FIELDS,
        {
          ...field("customfield_10001", "string", true),
          schema: { type: "string", custom: "unsupported:plugin" },
        },
      ],
      start: 0,
      size: 100,
      last: true,
    }),
  );
  expect(
    await f.run("jira.create", {
      projectId: "10000",
      issueTypeId: "10001",
      fields: { summary: "Synthetic", customfield_10000: "Required" },
    }),
  ).toEqual({ ok: false, reason: "field-validation" });
  expect(f.http).toHaveBeenCalledOnce();
});
it("revalidates metadata when edit operations change between actions", async () => {
  const f = fixture();
  const args = { issueKey: "SYN-1", fields: { summary: "Synthetic" } };
  expect((await f.run("jira.edit", args)).ok).toBe(true);
  f.http.mockResolvedValueOnce(
    response({ fields: { summary: { ...field("summary", "string"), operations: [] } } }),
  );
  expect(await f.run("jira.edit", args)).toEqual({ ok: false, reason: "field-validation" });
  expect(f.http.mock.calls.map(([request]) => request.method)).toEqual(["GET", "PUT", "GET"]);
});
it("keeps approved arguments stable while metadata is outstanding", async () => {
  const f = fixture();
  let release: ((value: AtlassianHttpBodyResult) => void) | undefined;
  f.http.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const args = { issueKey: "SYN-1", fields: { summary: "Approved" } };
  const pending = f.run("jira.edit", args);
  args.fields.summary = "Changed after admission";
  release?.(response({ fields: { summary: field("summary", "string") } }));
  expect((await pending).ok).toBe(true);
  expect(JSON.parse(f.http.mock.calls[1]?.[0].bodyJson ?? "null")).toEqual({
    fields: { summary: "Approved" },
    update: {},
  });
});
it.each(["inactive", "unassign-forbidden"] as const)(
  "refuses an %s assignee without PUT",
  async (kind) => {
    const f = fixture();
    f.http.mockResolvedValueOnce(
      kind === "inactive"
        ? response([{ name: "synthetic-user", active: false }])
        : response({ fields: { assignee: field("assignee", "user", true) } }),
    );
    expect(
      await f.run("jira.assign", {
        issueKey: "SYN-1",
        assigneeName: kind === "inactive" ? "synthetic-user" : null,
      }),
    ).toEqual({ ok: false, reason: "field-validation" });
    expect(f.http.mock.calls.map(([request]) => request.method)).toEqual(["GET"]);
  },
);
it.each([400, 401, 403, 429, 500, 503])(
  "does not retry mutation HTTP %i for POST or PUT",
  async (status) => {
    for (const operation of ["jira.comment", "jira.edit"] as const) {
      const f = fixture();
      const original = f.http.getMockImplementation();
      if (original === undefined) throw new Error("Expected HTTP fixture");
      f.http.mockImplementation((request) =>
        request.method === "GET" ? original(request) : Promise.resolve(response({}, status)),
      );
      const args: CatalogJsonObject =
        operation === "jira.comment"
          ? { issueKey: "SYN-1", body: "Synthetic" }
          : { issueKey: "SYN-1", fields: { summary: "Synthetic" } };
      expect((await f.run(operation, args)).ok).toBe(false);
      expect(f.http.mock.calls.filter(([request]) => request.method !== "GET")).toHaveLength(1);
    }
  },
);
it.each([
  [
    "jira.create",
    {
      projectId: "10000",
      issueTypeId: "10001",
      fields: { summary: "Synthetic", customfield_10000: "Required" },
    },
  ],
  ["jira.edit", { issueKey: "SYN-1", fields: { summary: "Synthetic" } }],
  ["jira.assign", { issueKey: "SYN-1", assigneeName: "synthetic-user" }],
  ["jira.comment", { issueKey: "SYN-1", body: "Synthetic" }],
  [
    "jira.transition",
    { issueKey: "SYN-1", transitionId: "31", fields: { customfield_10000: "Required" } },
  ],
] satisfies [JiraMutationOperation, CatalogJsonObject][])(
  "does not confirm an unexpected 200 response for %s",
  async (operation, args) => {
    const f = fixture();
    const original = f.http.getMockImplementation();
    if (original === undefined) throw new Error("Expected HTTP fixture");
    f.http.mockImplementation((request) =>
      request.method === "GET"
        ? original(request)
        : Promise.resolve(response({ key: "SYN-1", id: "10001" }, 200)),
    );
    expect(await f.run(operation, args)).toEqual({ ok: false, reason: "malformed-payload" });
  },
);
it("rechecks admission between fresh metadata and mutation dispatch", async () => {
  const f = fixture();
  f.beforeEffect.mockReturnValueOnce(true).mockReturnValue(false);
  expect(
    (await f.run("jira.edit", { issueKey: "SYN-1", fields: { summary: "Approved" } })).ok,
  ).toBe(false);
  expect(f.http.mock.calls.map(([request]) => request.method)).toEqual(["GET"]);
});
it("does not access Jira after cancellation", async () => {
  const f = fixture();
  f.controller.abort();
  expect((await f.run("jira.comment", { issueKey: "SYN-1", body: "Synthetic" })).ok).toBe(false);
  expect(f.http).not.toHaveBeenCalled();
});
it("does not route Data Center writes into a Cloud connection", async () => {
  const f = fixture();
  expect(
    (
      await executeJiraManagedMutation(
        "jira.comment",
        { issueKey: "SYN-1", body: "Synthetic" },
        {
          invocationId: "synthetic",
          correlationId: "synthetic",
          signal: f.controller.signal,
          beforeEffect: f.beforeEffect,
        },
        { deployment: "cloud", baseUrl: "https://jira.example.invalid", http: f.http },
      )
    ).ok,
  ).toBe(false);
  expect(f.http).not.toHaveBeenCalled();
});
it("does not confirm a created comment without a returned comment identity", async () => {
  const f = fixture();
  f.http.mockResolvedValueOnce(response({}, 201));
  expect(await f.run("jira.comment", { issueKey: "SYN-1", body: "Synthetic" })).toEqual({
    ok: false,
    reason: "malformed-payload",
  });
  expect(f.http).toHaveBeenCalledOnce();
});
it("refuses contradictory duplicate assignment identities before PUT", async () => {
  const f = fixture();
  f.http.mockResolvedValueOnce(
    response([
      { name: "synthetic-user", active: true },
      { name: "synthetic-user", active: false },
    ]),
  );
  expect(await f.run("jira.assign", { issueKey: "SYN-1", assigneeName: "synthetic-user" })).toEqual(
    { ok: false, reason: "field-validation" },
  );
  expect(f.http.mock.calls.map(([request]) => request.method)).toEqual(["GET"]);
});
