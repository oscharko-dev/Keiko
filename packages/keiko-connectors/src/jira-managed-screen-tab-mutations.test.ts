import { expect, it } from "vitest";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { AtlassianWriteHttpOutcome } from "./atlassian-write-http.js";
import {
  executeJiraScreenTabMutation as mutate,
  isJiraScreenTabMutation,
} from "./jira-managed-screen-tab-mutations.js";
import { JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { scriptedJiraMutationRequest as port } from "./jira-test-request/_support.js";

const SELECTED = { screenId: "11", expectedScreenName: "Review screen" };
const SCREEN_PATH = "screens?startAt=0&maxResults=100&search=Review+screen";
function body(body: Record<string, unknown>): AtlassianWriteHttpOutcome {
  return { ok: true, status: 200, body };
}
function rows(items: readonly unknown[]): AtlassianWriteHttpOutcome {
  return { ok: true, status: 200, body: undefined, items };
}
const SCREEN = body({
  startAt: 0,
  maxResults: 100,
  total: 1,
  isLast: true,
  screens: [{ id: 11, name: "Review screen" }],
});
const ORIGINAL = [
  { id: 21, name: "Fields" },
  { id: 22, name: "Other" },
];
function writes(request: ReturnType<typeof port>): readonly Parameters<JiraMutationRequest>[] {
  return request.mock.calls.filter(([, method]) => method !== undefined && method !== "GET");
}

it("creates one tab using an observed screen and independently confirms its new native ID", async () => {
  const request = port([
    SCREEN,
    rows(ORIGINAL),
    body({ id: 23, name: "Implementation" }),
    SCREEN,
    rows([...ORIGINAL, { id: 23, name: "Implementation" }]),
  ]);
  expect(
    await mutate("jira.create-screen-tab", { ...SELECTED, name: "Implementation" }, request),
  ).toEqual({
    ok: true,
    receipt: { screenId: "11", tabId: "23" },
  });
  expect(request.mock.calls).toEqual([
    [SCREEN_PATH, "GET", undefined, "json"],
    ["screens/11/tabs", "GET", undefined, "json-array"],
    ["screens/11/tabs", "POST", { name: "Implementation" }, "json"],
    [SCREEN_PATH, "GET", undefined, "json"],
    ["screens/11/tabs", "GET", undefined, "json-array"],
  ]);
});

it("renames only the reviewed native tab and reads the same parent again", async () => {
  const request = port([
    SCREEN,
    rows(ORIGINAL),
    body({ id: 21, name: "Implementation" }),
    SCREEN,
    rows([{ id: 21, name: "Implementation" }, ORIGINAL[1]]),
  ]);
  expect(
    await mutate(
      "jira.rename-screen-tab",
      {
        ...SELECTED,
        tabId: "21",
        expectedName: "Fields",
        name: "Implementation",
      },
      request,
    ),
  ).toEqual({ ok: true, receipt: { screenId: "11", tabId: "21" } });
  expect(writes(request)).toEqual([
    ["screens/11/tabs/21", "PUT", { name: "Implementation" }, "none"],
  ]);
});

it.each([204, 200, 202])(
  "deletes a matching reviewed field snapshot after HTTP %i only with complete same-parent absence",
  async (status) => {
    const request = port([
      SCREEN,
      rows(ORIGINAL),
      rows([{ id: "summary", name: "Summary" }]),
      { ok: true, status, body: undefined },
      SCREEN,
      rows([ORIGINAL[1]]),
    ]);
    expect(
      await mutate(
        "jira.delete-screen-tab",
        {
          ...SELECTED,
          tabId: "21",
          expectedName: "Fields",
          expectedFieldIds: ["summary"],
        },
        request,
      ),
    ).toEqual({ ok: true, receipt: { screenId: "11", tabId: "21" } });
    expect(request.mock.calls[2]).toEqual([
      "screens/11/tabs/21/fields",
      "GET",
      undefined,
      "json-array",
    ]);
    expect(writes(request)).toEqual([["screens/11/tabs/21", "DELETE", undefined, "none"]]);
  },
);

it("follows native screen continuation to bind a selected ID on a second result page", async () => {
  const request = port([
    body({
      startAt: 0,
      maxResults: 100,
      total: 2,
      isLast: false,
      screens: [{ id: 10, name: "Another review screen" }],
    }),
    body({
      startAt: 1,
      maxResults: 100,
      total: 2,
      isLast: true,
      screens: [{ id: 11, name: "Review screen" }],
    }),
    rows(ORIGINAL),
  ]);
  expect(
    await mutate("jira.create-screen-tab", { ...SELECTED, name: "Implementation" }, request, true),
  ).toEqual({ ok: true, receipt: {} });
  expect(request.mock.calls[1]?.[0]).toBe("screens?startAt=1&maxResults=100&search=Review+screen");
  expect(writes(request)).toEqual([]);
});

it("keeps an unproven end of the screen search unavailable instead of inventing absence", async () => {
  const request = port([
    body({ startAt: 0, maxResults: 100, screens: [{ id: 10, name: "Another screen" }] }),
  ]);
  expect(
    await mutate("jira.create-screen-tab", { ...SELECTED, name: "Implementation" }, request),
  ).toEqual({ ok: false, reason: "bounds-exceeded" });
  expect(writes(request)).toEqual([]);
});

it.each([
  body({
    startAt: 0,
    maxResults: 100,
    total: 1,
    isLast: true,
    screens: [{ id: 11, name: "Changed name" }],
  }),
  body({ startAt: 0, maxResults: 100, total: 0, isLast: true, screens: [] }),
  { ok: false, reason: "permission-denied", httpStatus: 403 } satisfies AtlassianWriteHttpOutcome,
])("refuses an unbound or denied screen before a tab write: %#", async (first) => {
  const request = port([first]);
  expect(
    (await mutate("jira.create-screen-tab", { ...SELECTED, name: "Implementation" }, request)).ok,
  ).toBe(false);
  expect(writes(request)).toEqual([]);
});

it("does not create a duplicate named tab", async () => {
  const request = port([SCREEN, rows(ORIGINAL)]);
  expect(await mutate("jira.create-screen-tab", { ...SELECTED, name: "Fields" }, request)).toEqual({
    ok: false,
    reason: "conflict",
  });
  expect(writes(request)).toEqual([]);
});

it("refuses a creation whose known result could not fit the existing tab collection bound", async () => {
  const items = Array.from({ length: TOOL_CATALOG_LIMITS.maxArrayItems }, (_, index) => ({
    id: index + 1,
    name: `Tab ${String(index)}`,
  }));
  const request = port([SCREEN, rows(items)]);
  expect(await mutate("jira.create-screen-tab", { ...SELECTED, name: "New tab" }, request)).toEqual(
    { ok: false, reason: "bounds-exceeded" },
  );
  expect(writes(request)).toEqual([]);
});

it("marks an independently observed unchanged name as a no-op with persistent target IDs", async () => {
  const request = port([SCREEN, rows(ORIGINAL)]);
  expect(
    await mutate(
      "jira.rename-screen-tab",
      {
        ...SELECTED,
        tabId: "21",
        expectedName: "Fields",
        name: "Fields",
      },
      request,
    ),
  ).toMatchObject({
    ok: false,
    reason: "conflict",
    receipt: { screenId: "11", tabId: "21" },
    detail: { unchanged: true },
  });
  expect(writes(request)).toEqual([]);
});

it("refuses a stale reviewed tab name before either rename or delete", async () => {
  const request = port([SCREEN, rows([{ id: 21, name: "Changed" }, ORIGINAL[1]])]);
  expect(
    await mutate(
      "jira.rename-screen-tab",
      {
        ...SELECTED,
        tabId: "21",
        expectedName: "Fields",
        name: "Implementation",
      },
      request,
    ),
  ).toEqual({ ok: false, reason: "conflict" });
  expect(writes(request)).toEqual([]);
});

it("refuses to delete the final native tab before looking up fields or dispatching DELETE", async () => {
  const request = port([SCREEN, rows([ORIGINAL[0]])]);
  const result = await mutate(
    "jira.delete-screen-tab",
    {
      ...SELECTED,
      tabId: "21",
      expectedName: "Fields",
      expectedFieldIds: [],
    },
    request,
  );
  expect(result).toMatchObject({
    ok: false,
    reason: "conflict",
    detail: { messages: [expect.stringContaining("at least one tab")] },
  });
  expect(request).toHaveBeenCalledTimes(2);
  expect(writes(request)).toEqual([]);
});

it.each([
  { fields: [{ id: "description", name: "Description" }], reason: "conflict", changed: true },
  {
    fields: [
      { id: "summary", name: "Summary" },
      { id: "summary", name: "Duplicate" },
    ],
    reason: "malformed-payload",
    changed: false,
  },
])(
  "refuses changed or duplicated field snapshots before deletion: %#",
  async ({ fields, reason, changed }) => {
    const request = port([SCREEN, rows(ORIGINAL), rows(fields)]);
    const result = await mutate(
      "jira.delete-screen-tab",
      {
        ...SELECTED,
        tabId: "21",
        expectedName: "Fields",
        expectedFieldIds: ["summary"],
      },
      request,
    );
    expect(result).toMatchObject({ ok: false, reason });
    if (changed)
      expect(result).toMatchObject({
        detail: { messages: [expect.stringContaining("field layout changed")] },
      });
    expect(writes(request)).toEqual([]);
  },
);

it("requires the reviewed field order as well as membership", async () => {
  const request = port([
    SCREEN,
    rows(ORIGINAL),
    rows([
      { id: "description", name: "Description" },
      { id: "summary", name: "Summary" },
    ]),
  ]);
  expect(
    await mutate(
      "jira.delete-screen-tab",
      {
        ...SELECTED,
        tabId: "21",
        expectedName: "Fields",
        expectedFieldIds: ["summary", "description"],
      },
      request,
    ),
  ).toMatchObject({ ok: false, reason: "conflict" });
  expect(writes(request)).toEqual([]);
});

it("retains acknowledged target IDs when independent readback is denied", async () => {
  const request = port([
    SCREEN,
    rows(ORIGINAL),
    body({ id: 23 }),
    { ok: false, reason: "permission-denied", httpStatus: 403 },
  ]);
  expect(
    await mutate("jira.create-screen-tab", { ...SELECTED, name: "Implementation" }, request),
  ).toEqual({
    ok: false,
    reason: "permission-denied",
    receipt: { screenId: "11", tabId: "23" },
  });
  expect(writes(request)).toHaveLength(1);
});

it("retains a known screen context on a lost creation response without retrying POST", async () => {
  const request = port([SCREEN, rows(ORIGINAL), { ok: false, reason: "timeout" }]);
  expect(
    await mutate("jira.create-screen-tab", { ...SELECTED, name: "Implementation" }, request),
  ).toEqual({
    ok: false,
    reason: "timeout",
    receipt: { screenId: "11" },
  });
  expect(request).toHaveBeenCalledTimes(3);
  expect(writes(request)).toHaveLength(1);
});

it("does not accept a pre-existing tab ID as proof of a fresh creation", async () => {
  const request = port([SCREEN, rows(ORIGINAL), body({ id: 21 })]);
  expect(
    await mutate("jira.create-screen-tab", { ...SELECTED, name: "Implementation" }, request),
  ).toEqual({
    ok: false,
    reason: "conflict",
    receipt: { screenId: "11", tabId: "21" },
  });
  expect(writes(request)).toHaveLength(1);
});

it.each([
  body({ id: 22 }),
  { ok: true, status: 200, body: undefined } satisfies AtlassianWriteHttpOutcome,
])(
  "never borrows an acknowledgement ID to retarget the independently admitted rename",
  async (acknowledgement) => {
    const request = port([
      SCREEN,
      rows(ORIGINAL),
      acknowledgement,
      SCREEN,
      rows([{ id: 21, name: "Implementation" }, ORIGINAL[1]]),
    ]);
    expect(
      await mutate(
        "jira.rename-screen-tab",
        {
          ...SELECTED,
          tabId: "21",
          expectedName: "Fields",
          name: "Implementation",
        },
        request,
      ),
    ).toEqual({ ok: true, receipt: { screenId: "11", tabId: "21" } });
    expect(writes(request)).toEqual([
      ["screens/11/tabs/21", "PUT", { name: "Implementation" }, "none"],
    ]);
  },
);

it("keeps deletion unconfirmed when native readback loses the final-tab invariant", async () => {
  const request = port([
    SCREEN,
    rows(ORIGINAL),
    rows([]),
    { ok: true, status: 204, body: undefined },
    SCREEN,
    rows([]),
  ]);
  expect(
    await mutate(
      "jira.delete-screen-tab",
      {
        ...SELECTED,
        tabId: "21",
        expectedName: "Fields",
        expectedFieldIds: [],
      },
      request,
    ),
  ).toEqual({ ok: false, reason: "conflict", receipt: { screenId: "11", tabId: "21" } });
  expect(writes(request)).toHaveLength(1);
});

it("attaches acknowledged IDs to a thrown readback failure without replaying the write", async () => {
  const cause = new TypeError("Synthetic readback failure");
  const request = port([SCREEN, rows(ORIGINAL), body({ id: 23 }), cause]);
  const failure = await mutate(
    "jira.create-screen-tab",
    { ...SELECTED, name: "Implementation" },
    request,
  ).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(JiraAcknowledgedMutationError);
  expect(failure).toMatchObject({ cause, receipt: { screenId: "11", tabId: "23" } });
  expect(writes(request)).toHaveLength(1);
});

const INVALID: readonly [Parameters<typeof mutate>[0], CatalogJsonObject][] = [
  ["jira.create-screen-tab", { ...SELECTED, name: " Trimmed " }],
  ["jira.create-screen-tab", { screenId: "11", name: "New" }],
  ["jira.create-screen-tab", { ...SELECTED, name: "New", url: "https://untrusted.invalid" }],
  ["jira.rename-screen-tab", { ...SELECTED, tabId: "21", name: "New" }],
  [
    "jira.rename-screen-tab",
    { ...SELECTED, tabId: "21/fields", expectedName: "Fields", name: "New" },
  ],
  ["jira.delete-screen-tab", { ...SELECTED, tabId: "21", expectedName: "Fields" }],
  [
    "jira.delete-screen-tab",
    { ...SELECTED, tabId: "21", expectedName: "Fields", expectedFieldIds: ["summary", "summary"] },
  ],
];
it.each(INVALID)(
  "refuses unsupported %s arguments before even reading Jira",
  async (operation, args) => {
    const request = port([]);
    expect((await mutate(operation, args, request)).ok).toBe(false);
    expect(request).not.toHaveBeenCalled();
  },
);

it("recognizes only the three fixed native tab mutations", () => {
  expect(isJiraScreenTabMutation("jira.delete-screen-tab")).toBe(true);
  expect(isJiraScreenTabMutation("constructor")).toBe(false);
  expect(isJiraScreenTabMutation("jira.delete-screen")).toBe(false);
});

// #4357 AC3: a screen lookup Jira itself refused keeps the closed fact that Jira refused it, so a
// model is never told that Keiko refused before sending.
it("keeps the fact that Jira refused the screen lookup, with its own explanation", async () => {
  const request = port([
    {
      ok: false,
      reason: "not-found",
      httpStatus: 404,
      remote: { fromJira: true, messages: ["No such screen search."] },
    },
  ]);
  expect(
    await mutate("jira.create-screen-tab", { ...SELECTED, name: "Implementation" }, request),
  ).toEqual({
    ok: false,
    reason: "not-found",
    detail: { fromJira: true, messages: ["No such screen search."] },
  });
  expect(writes(request)).toEqual([]);
});
it("leaves a screen lookup Keiko refused without that fact", async () => {
  const request = port([body({ screens: "not a list" })]);
  const refused = await mutate("jira.create-screen-tab", { ...SELECTED, name: "x" }, request);
  expect(refused).toMatchObject({ ok: false });
  expect(JSON.stringify(refused)).not.toContain("fromJira");
});
