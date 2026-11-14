import { expect, it } from "vitest";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { AtlassianWriteHttpOutcome } from "./atlassian-write-http.js";
import {
  executeJiraVersionLinkMutation as mutate,
  isJiraVersionLinkMutation,
} from "./jira-managed-version-link-mutations.js";
import { JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";
import { scriptedJiraMutationRequest as port } from "./jira-test-request/_support.js";
import {
  VERSION_LINK_MUTATION_CASES as CASES,
  VERSION_LINK_CONTEXT as CONTEXT,
  VERSION_LINK_EXPECTED as EXPECTED,
  VERSION_LINK_OLD_NODES as OLD_NODES,
  versionLinkMutationFixture as fixture,
} from "../../../tests/support/jira-version-link-mutation-fixture.js";

it("recognizes only the four fixed native version-link identities", () => {
  for (const selected of CASES) expect(isJiraVersionLinkMutation(selected.tool)).toBe(true);
  expect(isJiraVersionLinkMutation("jira.remote-http")).toBe(false);
  expect(isJiraVersionLinkMutation("jira.create-version")).toBe(false);
});
it.each(CASES)(
  "matches the full reviewed native set and independently confirms $tool once",
  async (selected) => {
    const f = fixture(selected);
    expect(await mutate(selected.tool, selected.args, f.request)).toEqual({
      ok: true,
      receipt: selected.expectedReceipt,
    });
    expect(f.writes()).toBe(1);
    expect(f.calls.filter(({ method }) => method !== "GET")).toEqual([
      { path: selected.path, method: selected.method, body: selected.nativeBody, expect: "none" },
    ]);
    expect(f.calls.slice(0, 4).map(({ path }) => path)).toEqual([
      "myself",
      "project/10000",
      "version/81",
      "version/81/remotelink",
    ]);
    expect(f.calls.slice(5).map(({ path }) => path)).toEqual([
      "myself",
      "project/10000",
      "version/81",
      "version/81/remotelink",
    ]);
  },
);
it.each(CASES)(
  "$tool preflight reads the same exact snapshots without any effect",
  async (selected) => {
    const f = fixture(selected);
    expect(await mutate(selected.tool, selected.args, f.request, true)).toEqual({
      ok: true,
      receipt: {},
    });
    expect(f.writes()).toBe(0);
    expect(f.calls.every(({ method }) => method === "GET")).toBe(true);
  },
);
it.each(CASES)(
  "preserves the known $tool target after a lost ACK without any replay/readback",
  async (selected) => {
    const f = fixture(selected);
    f.controls.lostAck = true;
    expect(await mutate(selected.tool, selected.args, f.request)).toMatchObject({
      ok: false,
      reason: "timeout",
      receipt: selected.expectedReceipt,
    });
    expect(f.writes()).toBe(1);
    expect(f.calls.at(-1)?.method).toBe(selected.method);
  },
);
it.each([200, 201, 202, 204])(
  "every readable HTTP %i ACK requires the complete independent set",
  async (status) => {
    const selected = CASES[2];
    const f = fixture(selected);
    f.controls.status = status;
    expect(await mutate(selected.tool, selected.args, f.request)).toEqual({
      ok: true,
      receipt: selected.expectedReceipt,
    });
    expect(f.calls.at(-1)?.path).toBe("version/81/remotelink");
  },
);
it.each(["denyReadback", "absentReadback", "throwReadback"] as const)(
  "does not infer deletion from %s",
  async (control) => {
    const selected = CASES[3];
    const f = fixture(selected);
    f.controls[control] = true;
    if (control === "throwReadback")
      await expect(mutate(selected.tool, selected.args, f.request)).rejects.toBeInstanceOf(
        JiraAcknowledgedMutationError,
      );
    else
      expect(await mutate(selected.tool, selected.args, f.request)).toMatchObject({
        ok: false,
        receipt: selected.expectedReceipt,
      });
    expect(f.writes()).toBe(1);
  },
);
it.each(["omitSelf", "omitValue", "duplicate"] as const)(
  "refuses an incomplete or ambiguous %s reviewed collection before an effect",
  async (control) => {
    const selected = CASES[2];
    const f = fixture(selected);
    f.controls[control] = true;
    expect((await mutate(selected.tool, selected.args, f.request)).ok).toBe(false);
    expect(f.writes()).toBe(0);
  },
);
it.each([
  { name: CASES[0].tool, args: { ...CASES[0].args, globalId: "other:link" } },
  { name: CASES[0].tool, args: { ...CASES[0].args, valueNodes: [{ path: "", kind: "null" }] } },
  {
    name: CASES[0].tool,
    args: { ...CASES[0].args, valueNodes: [{ path: "", kind: "object", childCount: 0 }] },
  },
  {
    name: CASES[0].tool,
    args: { ...CASES[0].args, expectedLinks: [{ globalId: "release:link" }] },
  },
  { name: CASES[0].tool, args: { ...CASES[0].args, expectedLinks: [EXPECTED[0], EXPECTED[0]] } },
  { name: CASES[0].tool, args: { ...CASES[0].args, headers: { Authorization: "synthetic" } } },
  { name: CASES[2].tool, args: { ...CASES[2].args, valueNodes: OLD_NODES } },
  { name: CASES[3].tool, args: { ...CASES[3].args, confirmAll: false } },
] satisfies readonly {
  readonly name: (typeof CASES)[number]["tool"];
  readonly args: CatalogJsonObject;
}[])("refuses malformed/rebinding inputs before native reads: %#", async ({ name, args }) => {
  const request = port([]);
  expect((await mutate(name, args, request)).ok).toBe(false);
  expect(request).not.toHaveBeenCalled();
});
it.each([".", "..", "x/y", "x\\y", "x%2fy", "x\n", "\ud800"])(
  "refuses unaddressable selected global ID %j before reads",
  async (globalId) => {
    const request = port([]);
    expect((await mutate(CASES[1].tool, { ...CASES[1].args, globalId }, request)).ok).toBe(false);
    expect(request).not.toHaveBeenCalled();
  },
);
it("refuses native parent/actor changes and stale reviewed values before effects", async () => {
  for (const alter of [
    (f: ReturnType<typeof fixture>): void => {
      f.actor.key = "another-actor";
    },
    (f: ReturnType<typeof fixture>): void => {
      f.version.projectId = 99999;
    },
    (f: ReturnType<typeof fixture>): void => {
      f.links.set("release:link", true);
    },
    (f: ReturnType<typeof fixture>): void => {
      f.links.set("unreviewed:link", null);
    },
  ]) {
    const f = fixture(CASES[2]);
    alter(f);
    expect((await mutate(CASES[2].tool, CASES[2].args, f.request)).ok).toBe(false);
    expect(f.writes()).toBe(0);
  }
});
it("does not turn native row order into identity or a completeness claim", async () => {
  const f = fixture(CASES[2]);
  expect(
    await mutate(
      CASES[2].tool,
      { ...CASES[2].args, expectedLinks: [...EXPECTED].reverse() },
      f.request,
    ),
  ).toMatchObject({ ok: true });
});
it("reports a proven existing raw value without POST or generated ID inference", async () => {
  const f = fixture(CASES[0]);
  expect(
    await mutate(CASES[0].tool, { ...CASES[0].args, valueNodes: OLD_NODES }, f.request),
  ).toMatchObject({
    ok: false,
    reason: "conflict",
    detail: { unchanged: true },
    receipt: CASES[0].expectedReceipt,
  });
  expect(f.writes()).toBe(0);
});
it("cannot confirm when another retained value changes after the one acknowledged effect", async () => {
  const f = fixture(CASES[2]);
  f.controls.afterWrite = (): void => {
    f.links.set("other:link", false);
  };
  expect(await mutate(CASES[2].tool, CASES[2].args, f.request)).toMatchObject({
    ok: false,
    reason: "conflict",
    receipt: CASES[2].expectedReceipt,
  });
  expect(f.writes()).toBe(1);
});
it("bounds complete review values without truncating or dropping unknown rows", async () => {
  const request = port([]);
  expect(
    await mutate(
      CASES[2].tool,
      {
        ...CASES[2].args,
        expectedLinks: Array.from(
          { length: TOOL_CATALOG_LIMITS.maxArrayItems + 1 },
          (_, index) => ({
            globalId: `link:${String(index)}`,
            valueNodes: [{ path: "", kind: "null" }],
          }),
        ),
      },
      request,
    ),
  ).toMatchObject({ ok: false, reason: "bounds-exceeded" });
  expect(request).not.toHaveBeenCalled();
});
it("requires explicit all-links acceptance even when the reviewed set is known", async () => {
  const request = port([]);
  expect((await mutate(CASES[3].tool, CONTEXT, request)).ok).toBe(false);
  expect(request).not.toHaveBeenCalled();
});
it("refuses an oversized all-links receipt before DELETE instead of losing identities after the effect", async () => {
  const f = fixture(CASES[3]);
  f.links.clear();
  const expectedLinks = Array.from({ length: 20 }, (_, index) => {
    const globalId = `${"x".repeat(1000)}:${String(index)}`;
    f.links.set(globalId, null);
    return { globalId, valueNodes: [{ path: "", kind: "null" }] };
  });
  expect(await mutate(CASES[3].tool, { ...CASES[3].args, expectedLinks }, f.request)).toMatchObject(
    { ok: false, reason: "bounds-exceeded" },
  );
  expect(f.writes()).toBe(0);
});
function response(body: Record<string, unknown>): AtlassianWriteHttpOutcome {
  return { ok: true, status: 200, body };
}
function contextReads(): readonly AtlassianWriteHttpOutcome[] {
  return [
    response({ key: "synthetic-actor", name: "synthetic-user", active: true }),
    response({ id: "10000", key: "SYN", name: "Synthetic project" }),
    response({ id: "81", projectId: 10000, ...CONTEXT.expectedVersionSnapshot }),
  ];
}
function linkRows(value: unknown): AtlassianWriteHttpOutcome {
  return response({
    links: [
      {
        self: "https://proxy.invalid/context/rest/api/2/version/81/remotelink/release%3Alink",
        link: value,
      },
    ],
  });
}
it.each([
  { value: null, nodes: [{ path: "", kind: "null" }] },
  { value: 0, nodes: [{ path: "", kind: "number", numberValue: 0 }] },
  { value: "", nodes: [{ path: "", kind: "string", textValue: "" }] },
  { value: [], nodes: [{ path: "", kind: "array", childCount: 0 }] },
  { value: {}, nodes: [{ path: "", kind: "object", childCount: 0 }] },
  {
    value: '{"literal":true}',
    nodes: [{ path: "", kind: "string", textValue: '{"literal":true}' }],
  },
])(
  "selected-path POST preserves raw bounded value $value and never adds an envelope or second parse",
  async ({ value, nodes }) => {
    const request = port([
      ...contextReads(),
      linkRows(true),
      { ok: true, status: 201, body: undefined },
      ...contextReads(),
      linkRows(value),
    ]);
    const args = {
      ...CASES[1].args,
      valueNodes: nodes,
      expectedLinks: [
        {
          globalId: "release:link",
          valueNodes: [{ path: "", kind: "boolean", booleanValue: true }],
        },
      ],
    };
    expect(await mutate(CASES[1].tool, args, request)).toEqual({
      ok: true,
      receipt: CASES[1].expectedReceipt,
    });
    expect(request.mock.calls[4]).toEqual([
      "version/81/remotelink/release%3Alink",
      "POST",
      value,
      "none",
    ]);
  },
);
it("permits explicit deterministic creation only after a complete native absence observation", async () => {
  const f = fixture(CASES[0]);
  f.links.delete("release:link");
  expect(
    await mutate(CASES[0].tool, { ...CASES[0].args, expectedLinks: [EXPECTED[1]] }, f.request),
  ).toEqual({ ok: true, receipt: CASES[0].expectedReceipt });
  expect(f.writes()).toBe(1);
});
it("allows an opaque URL-like global ID in collection POST data without following it or using it as a route", async () => {
  const globalId = "system=https://remote.invalid/release&id=1";
  const value = { globalId, enabled: false };
  const observed = response({
    links: [
      {
        self: `https://proxy.invalid/context/rest/api/2/version/81/remotelink/${encodeURIComponent(globalId)}`,
        link: value,
      },
    ],
  });
  const request = port([
    ...contextReads(),
    response({ links: [] }),
    { ok: true, status: 201, body: undefined },
    ...contextReads(),
    observed,
  ]);
  const args = {
    ...CASES[0].args,
    globalId,
    expectedLinks: [],
    valueNodes: [
      { path: "", kind: "object", childCount: 2 },
      { path: "/globalId", kind: "string", textValue: globalId },
      { path: "/enabled", kind: "boolean", booleanValue: false },
    ],
  };
  expect(await mutate(CASES[0].tool, args, request)).toMatchObject({
    ok: true,
    receipt: { globalId, linkPresent: true },
  });
  expect(request.mock.calls[4]).toEqual(["version/81/remotelink", "POST", value, "none"]);
  expect(request.mock.calls.every(([path]) => !path.includes("remote.invalid"))).toBe(true);
});
it.each([
  { ok: false, reason: "permission-denied", httpStatus: 403 },
  { ok: false, reason: "not-found", httpStatus: 404 },
  { ok: false, reason: "unavailable", httpStatus: 503 },
] satisfies readonly AtlassianWriteHttpOutcome[])(
  "does not turn a refused native write into success or retry: %#",
  async (failure) => {
    const request = port([...contextReads(), linkRows(true), failure]);
    const args = {
      ...CASES[2].args,
      expectedLinks: [
        {
          globalId: "release:link",
          valueNodes: [{ path: "", kind: "boolean", booleanValue: true }],
        },
      ],
    };
    expect(await mutate(CASES[2].tool, args, request)).toMatchObject({
      ok: false,
      receipt: CASES[2].expectedReceipt,
    });
    expect(request.mock.calls).toHaveLength(5);
  },
);
it("rejects a contradictory native self instead of following or retargeting it", async () => {
  const request = port([
    ...contextReads(),
    response({
      links: [
        {
          self: "https://proxy.invalid/rest/api/2/version/82/remotelink/release%3Alink",
          link: true,
        },
      ],
    }),
  ]);
  const args = {
    ...CASES[2].args,
    expectedLinks: [
      { globalId: "release:link", valueNodes: [{ path: "", kind: "boolean", booleanValue: true }] },
    ],
  };
  expect(await mutate(CASES[2].tool, args, request)).toMatchObject({
    ok: false,
    reason: "conflict",
  });
  expect(request.mock.calls.every(([, method = "GET"]) => method === "GET")).toBe(true);
  expect(request.mock.calls.map(([path]) => path)).toEqual([
    "myself",
    "project/10000",
    "version/81",
    "version/81/remotelink",
  ]);
});

// #4357 AC3: a refused version-link write names the rule the model must satisfy, one fixed sentence
// per cause, pinned exactly; none may be cut by the 200-byte bound of a detail message.
async function refusedWith(
  name: (typeof CASES)[number]["tool"],
  args: CatalogJsonObject,
): Promise<{ readonly reason: string; readonly detail: unknown }> {
  const request = port([]);
  const attempt = await mutate(name, args, request);
  expect(request).not.toHaveBeenCalled();
  if (attempt.ok) throw new TypeError("Expected a refusal");
  for (const message of attempt.detail?.messages ?? []) {
    expect(new TextEncoder().encode(message).length).toBeLessThanOrEqual(200);
    expect(message).not.toMatch(/…$/u);
  }
  return { reason: attempt.reason, detail: attempt.detail };
}
const invalidField = (messages: readonly string[], fieldId?: string): unknown => ({
  validation: "invalid-field",
  messages,
  ...(fieldId === undefined ? {} : { fieldId }),
});
it("names the arguments a version-link write takes when another one is sent", async () => {
  expect(
    await refusedWith(CASES[0].tool, { ...CASES[0].args, headers: { Authorization: "x" } }),
  ).toEqual({
    reason: "field-validation",
    detail: invalidField([
      "This call takes only versionId, expectedProjectId, expectedActorKey, expectedVersionSnapshot, expectedLinks, globalId, valueNodes. Nothing was written.",
    ]),
  });
  expect(
    await refusedWith(CASES[3].tool, { ...CASES[3].args, valueNodes: OLD_NODES }),
  ).toMatchObject({
    detail: {
      messages: [
        "This call takes only versionId, expectedProjectId, expectedActorKey, expectedVersionSnapshot, expectedLinks, confirmAll. Nothing was written.",
      ],
    },
  });
});
it("names the version, project, actor and snapshot rule", async () => {
  expect(await refusedWith(CASES[0].tool, { ...CASES[0].args, versionId: "x" })).toEqual({
    reason: "field-validation",
    detail: invalidField([
      "versionId, expectedProjectId, expectedActorKey and expectedVersionSnapshot must be exactly as the version read lists them, the snapshot with every field. Nothing was written.",
    ]),
  });
});
const GLOBAL_ID_RULE =
  "A globalId is non-blank text of at most 2048 characters without control characters; one that selects a link also has no / \\ or % and is not . or .. Nothing was written.";
it.each([
  [
    "expectedLinks that is not a list",
    { expectedLinks: "x" },
    "expectedLinks must be the complete current list of the version's remote links, each as { globalId, valueNodes }. Nothing was written.",
  ],
  [
    "an expectedLinks entry of the wrong shape",
    { expectedLinks: [{ globalId: "release:link" }] },
    "Each expectedLinks entry takes exactly globalId and valueNodes, as the version's remote link read lists them. Nothing was written.",
  ],
  [
    "an expectedLinks globalId that is not valid",
    { expectedLinks: [{ globalId: "", valueNodes: [{ path: "", kind: "null" }] }] },
    GLOBAL_ID_RULE,
  ],
  [
    "a repeated expectedLinks globalId",
    { expectedLinks: [EXPECTED[0], EXPECTED[0]] },
    "expectedLinks must not repeat a globalId: list each remote link of the version once. Nothing was written.",
  ],
] as const)("names the rule for %s", async (_name, change, message) => {
  expect(await refusedWith(CASES[0].tool, { ...CASES[0].args, ...change })).toEqual({
    reason: "field-validation",
    detail: invalidField([message], "expectedLinks"),
  });
});
it.each([".", "..", "x/y", "x\\y", "x%2fy", "x\n"])(
  "names the global ID rule for a selected link %j",
  async (globalId) => {
    expect(await refusedWith(CASES[1].tool, { ...CASES[1].args, globalId })).toEqual({
      reason: "field-validation",
      detail: invalidField([GLOBAL_ID_RULE], "globalId"),
    });
  },
);
it("names the all-links acceptance a delete of every link needs", async () => {
  expect(await refusedWith(CASES[3].tool, { ...CASES[3].args, confirmAll: false })).toEqual({
    reason: "field-validation",
    detail: invalidField(
      [
        "Deleting all remote links takes confirmAll:true and expectedLinks, the complete current list. Nothing was written.",
      ],
      "confirmAll",
    ),
  });
});
it("names the value rule and the size a link value must fit, for a reviewed and a new value", async () => {
  const huge = [{ path: "", kind: "string", textValue: "界".repeat(12000) }];
  expect(
    await refusedWith(CASES[0].tool, {
      ...CASES[0].args,
      expectedLinks: [{ globalId: "release:link", valueNodes: [] }],
    }),
  ).toEqual({
    reason: "field-validation",
    detail: {
      fieldId: "expectedLinks",
      validation: "invalid-field",
      messages: [
        "Each expectedLinks valueNodes must be that link's complete typed value, within 32768 UTF-8 JSON bytes and the depth and node limits. Nothing was written.",
      ],
    },
  });
  expect(
    await refusedWith(CASES[0].tool, {
      ...CASES[0].args,
      expectedLinks: [{ globalId: "release:link", valueNodes: huge }],
    }),
  ).toMatchObject({ reason: "bounds-exceeded", detail: { validation: "bounds-exceeded" } });
  expect(await refusedWith(CASES[0].tool, { ...CASES[0].args, valueNodes: [] })).toEqual({
    reason: "field-validation",
    detail: {
      fieldId: "valueNodes",
      validation: "invalid-field",
      messages: [
        "valueNodes must be the complete new link value as typed nodes, null and empty values kept, within 32768 UTF-8 JSON bytes. Nothing was written.",
      ],
    },
  });
  expect(await refusedWith(CASES[0].tool, { ...CASES[0].args, valueNodes: huge })).toMatchObject({
    reason: "bounds-exceeded",
    detail: { fieldId: "valueNodes", validation: "bounds-exceeded" },
  });
});
it("says why a review set over the item bound cannot be reviewed", async () => {
  expect(
    await refusedWith(CASES[2].tool, {
      ...CASES[2].args,
      expectedLinks: Array.from({ length: TOOL_CATALOG_LIMITS.maxArrayItems + 1 }, (_, index) => ({
        globalId: `link:${String(index)}`,
        valueNodes: [{ path: "", kind: "null" }],
      })),
    }),
  ).toEqual({
    reason: "bounds-exceeded",
    detail: {
      messages: [
        "expectedLinks holds more links, or more argument bytes, than Keiko can review in one call. Nothing was written.",
      ],
    },
  });
});
it("keeps the sentence with the unchanged flag when the set already matches", async () => {
  const f = fixture(CASES[0]);
  expect(
    await mutate(CASES[0].tool, { ...CASES[0].args, valueNodes: OLD_NODES }, f.request),
  ).toMatchObject({
    ok: false,
    reason: "conflict",
    detail: {
      unchanged: true,
      messages: [
        "The complete reviewed link set already matches the requested state. Nothing was written.",
      ],
    },
  });
});
