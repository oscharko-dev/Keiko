import { expect, it, vi } from "vitest";
import type { JiraMutationOperation } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { AtlassianHttpBodyPort, AtlassianHttpBodyResult } from "./atlassian-http-port.js";
import { executeJiraManagedMutation } from "./jira-managed-mutations.js";

import {
  field,
  REQUIRED_CUSTOM,
  FIELDS,
  response,
  fixtureRead,
  fixtureWrite,
  type SyntheticJira,
} from "../../../tests/support/jira-managed-remote.js";

function fixture(): {
  controller: AbortController;
  beforeEffect: ReturnType<typeof vi.fn<() => boolean>>;
  http: ReturnType<typeof vi.fn<AtlassianHttpBodyPort>>;
  run: (
    operation: JiraMutationOperation,
    args: CatalogJsonObject,
  ) => ReturnType<typeof executeJiraManagedMutation>;
} {
  const state: SyntheticJira = {
    fields: {
      summary: "Original",
      assignee: { name: "previous-user" },
      status: { id: "1" },
      labels: ["initial"],
    },
    comment: "",
  };
  const http = vi.fn<AtlassianHttpBodyPort>((request) => {
    const path = new URL(request.url).pathname;
    return Promise.resolve(
      request.method === "GET"
        ? fixtureRead(path, state)
        : fixtureWrite(path, request.bodyJson, state),
    );
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
  expect(f.http.mock.calls.map(([request]) => request.method)).toEqual(["GET", "POST", "GET"]);
  expect(f.http.mock.calls[0]?.[0].url).toContain(
    "/context/rest/api/2/issue/createmeta/10000/issuetypes/10001?startAt=0&maxResults=100",
  );
  expect(
    JSON.parse(
      f.http.mock.calls.find(([request]) => request.method !== "GET")?.[0].bodyJson ?? "null",
    ),
  ).toEqual({
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
  expect(f.http.mock.calls.map(([request]) => request.method)).toEqual([
    "GET",
    "GET",
    "PUT",
    "GET",
  ]);
  expect(
    JSON.parse(
      f.http.mock.calls.find(([request]) => request.method !== "GET")?.[0].bodyJson ?? "null",
    ),
  ).toEqual({
    fields: { summary: "Changed" },
    update: {},
  });
});
it("confirms changed label membership while preserving unrelated labels", async () => {
  const f = fixture();
  expect(
    await f.run("jira.edit", {
      issueKey: "SYN-1",
      updates: [{ fieldId: "labels", operation: "add", value: "triage" }],
    }),
  ).toEqual({ ok: true, receipt: { issueKey: "SYN-1" } });
  expect(f.http.mock.calls.filter(([request]) => request.method === "PUT")).toHaveLength(1);
});
it("does not attribute a label operation whose final membership already held", async () => {
  const f = fixture();
  expect(
    await f.run("jira.edit", {
      issueKey: "SYN-1",
      updates: [{ fieldId: "labels", operation: "add", value: "initial" }],
    }),
  ).toEqual({ ok: false, reason: "conflict" });
  expect(f.http.mock.calls.filter(([request]) => request.method === "PUT")).toHaveLength(1);
});
it("compares replaced label sets independently of their returned order", async () => {
  const f = fixture();
  const original = f.http.getMockImplementation();
  let written = false;
  f.http.mockImplementation(async (request) => {
    const result = await original?.(request);
    if (request.method === "PUT") written = true;
    else if (written && request.method === "GET")
      return response({ id: "10001", key: "SYN-1", fields: { labels: ["b", "a"] } });
    return result ?? response({}, 500);
  });
  expect(await f.run("jira.edit", { issueKey: "SYN-1", fields: { labels: ["a", "b"] } })).toEqual({
    ok: true,
    receipt: { issueKey: "SYN-1" },
  });
});
it("confirms explicit clearing without treating omitted fields as clears", async () => {
  const f = fixture();
  expect(await f.run("jira.edit", { issueKey: "SYN-1", fields: { labels: null } })).toEqual({
    ok: true,
    receipt: { issueKey: "SYN-1" },
  });
  const body = f.http.mock.calls.find(([request]) => request.method === "PUT")?.[0].bodyJson;
  expect(JSON.parse(body ?? "null")).toEqual({ fields: { labels: null }, update: {} });
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
  expect(f.http.mock.calls.map(([request]) => request.method)).toEqual([
    "GET",
    "GET",
    "POST",
    "GET",
  ]);
  expect(
    JSON.parse(
      f.http.mock.calls.find(([request]) => request.method !== "GET")?.[0].bodyJson ?? "null",
    ),
  ).toEqual({
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
  expect(f.http.mock.calls.map(([request]) => request.method)).toEqual([
    "GET",
    "GET",
    "PUT",
    "GET",
  ]);
  expect(f.http.mock.calls[0]?.[0].url).toContain("/user/assignable/search?");
  expect(
    JSON.parse(
      f.http.mock.calls.find(([request]) => request.method !== "GET")?.[0].bodyJson ?? "null",
    ),
  ).toEqual({
    name: "synthetic-user",
  });
});
it("clears an assignee only when current metadata permits clearing", async () => {
  const f = fixture();
  expect(await f.run("jira.assign", { issueKey: "SYN-1", clearAssignee: true })).toEqual({
    ok: true,
    receipt: { issueKey: "SYN-1" },
  });
  expect(
    JSON.parse(
      f.http.mock.calls.find(([request]) => request.method !== "GET")?.[0].bodyJson ?? "null",
    ),
  ).toEqual({ name: null });
});
it("writes Data Center plain text comments and requires the returned comment identity", async () => {
  const f = fixture();
  expect(await f.run("jira.comment", { issueKey: "SYN-1", body: "Synthetic\ncomment" })).toEqual({
    ok: true,
    receipt: { issueKey: "SYN-1", commentId: "10002" },
  });
  expect(f.http).toHaveBeenCalledTimes(2);
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
  expect(f.http.mock.calls.map(([request]) => request.method)).toEqual([
    "GET",
    "GET",
    "PUT",
    "GET",
    "GET",
  ]);
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
  expect(
    JSON.parse(
      f.http.mock.calls.find(([request]) => request.method !== "GET")?.[0].bodyJson ?? "null",
    ),
  ).toEqual({
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
        ...(kind === "inactive" ? { assigneeName: "synthetic-user" } : { clearAssignee: true }),
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

const CONFIRMED_OPERATIONS: [JiraMutationOperation, CatalogJsonObject][] = [
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
];
it.each(CONFIRMED_OPERATIONS)(
  "does not confirm %s when the acknowledged mutation cannot be read back",
  async (operation, args) => {
    const f = fixture();
    const original = f.http.getMockImplementation();
    if (original === undefined) throw new Error("Expected fixture");
    f.http.mockImplementation((request) => {
      const path = new URL(request.url).pathname;
      const afterWrite = f.http.mock.calls.some(([call]) => call.method !== "GET");
      return afterWrite &&
        request.method === "GET" &&
        (path.endsWith("/issue/SYN-1") || path.endsWith("/comment/10002"))
        ? Promise.resolve(response({}, 403))
        : original(request);
    });
    expect(await f.run(operation, args)).toEqual({
      ok: false,
      reason: "permission-denied",
      httpStatus: 403,
    });
    expect(f.http.mock.calls.filter(([request]) => request.method !== "GET")).toHaveLength(1);
  },
);
it.each(CONFIRMED_OPERATIONS)(
  "does not confirm %s when independent state contradicts the acknowledged action",
  async (operation, args) => {
    const f = fixture();
    const original = f.http.getMockImplementation();
    if (original === undefined) throw new Error("Expected fixture");
    f.http.mockImplementation((request) => {
      const path = new URL(request.url).pathname;
      const afterWrite = f.http.mock.calls.some(([call]) => call.method !== "GET");
      if (afterWrite && request.method === "GET" && path.endsWith("/comment/10002"))
        return Promise.resolve(response({ id: "10002", body: "Changed by another actor" }));
      if (afterWrite && request.method === "GET" && path.endsWith("/issue/SYN-1"))
        return Promise.resolve(
          response({
            id: "10001",
            key: "SYN-1",
            fields: {
              summary: "Changed by another actor",
              assignee: { name: "another-user" },
              status: { id: "1" },
              customfield_10000: "Other",
            },
          }),
        );
      return original(request);
    });
    expect(await f.run(operation, args)).toEqual({ ok: false, reason: "conflict" });
    expect(f.http.mock.calls.filter(([request]) => request.method !== "GET")).toHaveLength(1);
  },
);
it("does not attribute an unchanged pre-existing summary to a newly acknowledged edit", async () => {
  const f = fixture();
  expect(await f.run("jira.edit", { issueKey: "SYN-1", fields: { summary: "Original" } })).toEqual({
    ok: false,
    reason: "conflict",
  });
  expect(f.http.mock.calls.filter(([request]) => request.method !== "GET")).toHaveLength(1);
});
it("does not attribute a pre-existing assignee to a newly acknowledged assignment", async () => {
  const f = fixture();
  f.http.mockResolvedValueOnce(response([{ name: "previous-user", active: true }]));
  expect(await f.run("jira.assign", { issueKey: "SYN-1", assigneeName: "previous-user" })).toEqual({
    ok: false,
    reason: "conflict",
  });
  expect(f.http.mock.calls.filter(([request]) => request.method !== "GET")).toHaveLength(1);
});
it("does not attribute an already-held target status to a transition from matching fields alone", async () => {
  const f = fixture();
  const original = f.http.getMockImplementation();
  if (original === undefined) throw new Error("Expected fixture");
  f.http.mockImplementation((request) => {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path.endsWith("transitions"))
      return Promise.resolve(
        response({
          transitions: [
            { id: "31", to: { id: "1" }, fields: { customfield_10000: REQUIRED_CUSTOM } },
          ],
        }),
      );
    if (
      request.method === "GET" &&
      path.endsWith("/issue/SYN-1") &&
      f.http.mock.calls.some(([call]) => call.method !== "GET")
    )
      return Promise.resolve(
        response({
          id: "10001",
          key: "SYN-1",
          fields: { status: { id: "1" }, customfield_10000: "Required" },
        }),
      );
    return original(request);
  });
  expect(
    await f.run("jira.transition", {
      issueKey: "SYN-1",
      transitionId: "31",
      fields: { customfield_10000: "Required" },
    }),
  ).toEqual({ ok: false, reason: "conflict" });
  expect(f.http.mock.calls.filter(([request]) => request.method !== "GET")).toHaveLength(1);
});
it("does not repeat an acknowledged edit when authority is lost before readback", async () => {
  const f = fixture();
  f.beforeEffect
    .mockReturnValueOnce(true)
    .mockReturnValueOnce(true)
    .mockReturnValueOnce(true)
    .mockReturnValue(false);
  expect((await f.run("jira.edit", { issueKey: "SYN-1", fields: { summary: "Changed" } })).ok).toBe(
    false,
  );
  expect(f.http.mock.calls.map(([request]) => request.method)).toEqual(["GET", "GET", "PUT"]);
});
it("refuses an edit before PUT when its prior issue state cannot be read", async () => {
  const f = fixture();
  const original = f.http.getMockImplementation();
  if (original === undefined) throw new Error("Expected fixture");
  f.http.mockImplementation((request) =>
    new URL(request.url).pathname.endsWith("/issue/SYN-1")
      ? Promise.resolve(response({}, 403))
      : original(request),
  );
  expect((await f.run("jira.edit", { issueKey: "SYN-1", fields: { summary: "Changed" } })).ok).toBe(
    false,
  );
  expect(f.http.mock.calls.every(([request]) => request.method === "GET")).toBe(true);
});
it.each(["jira.create", "jira.comment"] as const)(
  "requires the created %s identity as well as matching content",
  async (operation) => {
    const f = fixture();
    const original = f.http.getMockImplementation();
    if (original === undefined) throw new Error("Expected fixture");
    f.http.mockImplementation(async (request) => {
      const result = await original(request);
      const path = new URL(request.url).pathname;
      if (
        request.method !== "GET" ||
        (!path.endsWith("/issue/SYN-1") && !path.endsWith("/comment/10002")) ||
        result.kind !== "response"
      )
        return result;
      const body = JSON.parse(result.bodyText) as Record<string, unknown>;
      return response({ ...body, id: "different-resource" });
    });
    const args: CatalogJsonObject =
      operation === "jira.create"
        ? {
            projectId: "10000",
            issueTypeId: "10001",
            fields: { summary: "Synthetic", customfield_10000: "Required" },
          }
        : { issueKey: "SYN-1", body: "Synthetic" };
    expect(await f.run(operation, args)).toEqual({ ok: false, reason: "conflict" });
    expect(f.http.mock.calls.filter(([request]) => request.method !== "GET")).toHaveLength(1);
  },
);
