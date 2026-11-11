import { expect, it } from "vitest";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { AtlassianWriteHttpOutcome } from "./atlassian-write-http.js";
import {
  executeJiraScreenConfigurationMutation as mutate,
  isJiraScreenConfigurationMutation,
} from "./jira-managed-screen-configuration.js";
import { JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";
import { scriptedJiraMutationRequest as port } from "./jira-test-request/_support.js";
import {
  SCREEN_CONFIGURATION_FIXTURE_CASES as CASES,
  SCREEN_CONFIGURATION_PARENT as PARENT,
  SCREEN_CONFIGURATION_FIELDS as FIELDS,
  SCREEN_CONFIGURATION_TABS as TABS,
} from "../../../tests/support/jira-screen-configuration-fixture.js";

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
const ADDED = { id: "customfield_10001", name: "Review", type: "custom" };
const ACK: AtlassianWriteHttpOutcome = { ok: true, status: 204, body: undefined };
function current(): readonly AtlassianWriteHttpOutcome[] {
  return [SCREEN, rows(TABS), rows(FIELDS)];
}
function writes(request: ReturnType<typeof port>): ReturnType<typeof port>["mock"]["calls"] {
  return request.mock.calls.filter(([, method]) => method !== undefined && method !== "GET");
}

it("recognizes exactly the six fixed screen operations", () => {
  for (const selected of CASES) expect(isJiraScreenConfigurationMutation(selected.tool)).toBe(true);
  expect(isJiraScreenConfigurationMutation("jira.screen-http")).toBe(false);
  expect(isJiraScreenConfigurationMutation("jira.delete-screen")).toBe(false);
});
it("adds only an independently available named field and confirms its exact membership", async () => {
  const request = port([
    ...current(),
    rows([ADDED]),
    ACK,
    SCREEN,
    rows(TABS),
    rows([...FIELDS, ADDED]),
  ]);
  expect(await mutate(CASES[1].tool, CASES[1].args, request)).toEqual({
    ok: true,
    receipt: CASES[1].expectedReceipt,
  });
  expect(writes(request)).toEqual([
    ["screens/11/tabs/21/fields", "POST", { fieldId: "customfield_10001" }, "none"],
  ]);
  expect(request.mock.calls[3]).toEqual([
    "screens/11/availableFields",
    "GET",
    undefined,
    "json-array",
  ]);
});
it.each([200, 202, 204])(
  "requires independent same-parent complete absence after DELETE HTTP %i",
  async (status) => {
    const request = port([
      ...current(),
      { ok: true, status, body: undefined },
      SCREEN,
      rows(TABS),
      rows([FIELDS[0]]),
    ]);
    expect(await mutate(CASES[2].tool, CASES[2].args, request)).toEqual({
      ok: true,
      receipt: CASES[2].expectedReceipt,
    });
    expect(writes(request)).toEqual([
      ["screens/11/tabs/21/fields/description", "DELETE", undefined, "none"],
    ]);
  },
);
it("uses only a documented native position and proves the entire moved order", async () => {
  const request = port([...current(), ACK, SCREEN, rows(TABS), rows([...FIELDS].reverse())]);
  expect(await mutate(CASES[3].tool, CASES[3].args, request)).toEqual({
    ok: true,
    receipt: CASES[3].expectedReceipt,
  });
  expect(writes(request)).toEqual([
    ["screens/11/tabs/21/fields/summary/move", "POST", { position: "Last" }, "none"],
  ]);
});
it.each([
  { fieldId: "summary", position: "Last" },
  { fieldId: "summary", position: "Later" },
  { fieldId: "description", position: "First" },
  { fieldId: "description", position: "Earlier" },
])(
  "uses the documented native $position field move without a model URL",
  async ({ fieldId, position }) => {
    const request = port([...current(), ACK, SCREEN, rows(TABS), rows([...FIELDS].reverse())]);
    expect(
      await mutate(
        "jira.move-screen-tab-field",
        { ...PARENT, expectedFields: FIELDS, fieldId, position },
        request,
      ),
    ).toEqual({
      ok: true,
      receipt: { screenId: "11", tabId: "21", fieldId },
    });
    expect(writes(request)).toEqual([
      [`screens/11/tabs/21/fields/${fieldId}/move`, "POST", { position }, "none"],
    ]);
  },
);
it("writes explicit false and independently observes it instead of treating it as missing", async () => {
  const old = [{ ...FIELDS[0], showWhenEmpty: true }, FIELDS[1]];
  const request = port([SCREEN, rows(TABS), rows(old), ACK, ...current()]);
  expect(
    await mutate(
      "jira.set-screen-field-show-when-empty",
      {
        ...PARENT,
        expectedFields: old,
        fieldId: "summary",
        showWhenEmpty: false,
      },
      request,
    ),
  ).toEqual({
    ok: true,
    receipt: { screenId: "11", tabId: "21", fieldId: "summary", showWhenEmpty: false },
  });
  expect(writes(request)).toEqual([
    [
      "screens/11/tabs/21/fields/summary/updateShowWhenEmptyIndicator/false",
      "PUT",
      undefined,
      "none",
    ],
  ]);
});
it("moves a tab to native zero-based position zero and preserves both reviewed names", async () => {
  const request = port([SCREEN, rows(TABS), ACK, SCREEN, rows([...TABS].reverse())]);
  expect(
    await mutate("jira.move-screen-tab", { ...PARENT, tabId: "22", position: 0 }, request),
  ).toEqual({
    ok: true,
    receipt: { screenId: "11", tabId: "22" },
  });
  expect(writes(request)).toEqual([["screens/11/tabs/22/move/0", "POST", undefined, "none"]]);
});
it("retains full int64 screen and tab identities without numeric coercion", async () => {
  const screenId = "9007199254740993";
  const tabId = "9007199254740995";
  const tabs = [{ id: tabId, name: "Fields" }, TABS[1]];
  const screen = body({
    startAt: 0,
    maxResults: 100,
    total: 1,
    isLast: true,
    screens: [{ id: screenId, name: "Review screen" }],
  });
  const request = port([screen, rows(tabs), ACK, screen, rows([...tabs].reverse())]);
  expect(
    await mutate(
      "jira.move-screen-tab",
      { screenId, expectedScreenName: "Review screen", tabId, expectedTabs: tabs, position: 1 },
      request,
    ),
  ).toEqual({
    ok: true,
    receipt: { screenId, tabId },
  });
  expect(writes(request)).toEqual([
    [`screens/${screenId}/tabs/${tabId}/move/1`, "POST", undefined, "none"],
  ]);
});
it("does not invent a default screen identity or success after the native default endpoint acknowledges", async () => {
  const request = port([rows([ADDED]), ACK]);
  const result = await mutate(CASES[0].tool, CASES[0].args, request);
  expect(result).toMatchObject({
    ok: false,
    reason: "unavailable",
    receipt: { fieldId: "customfield_10001", fieldPresent: true },
  });
  expect(result.receipt).not.toHaveProperty("screenId");
  expect(result.receipt).not.toHaveProperty("tabId");
  expect(request.mock.calls).toEqual([
    ["field", "GET", undefined, "json-array"],
    ["screens/addToDefault/customfield_10001", "POST", undefined, "none"],
  ]);
});
it.each(CASES)("preflight $tool performs no native write", async (selected) => {
  const responses =
    selected.tool === "jira.add-default-screen-field"
      ? [rows([ADDED])]
      : selected.tool === "jira.move-screen-tab"
        ? [SCREEN, rows(TABS)]
        : [...current(), ...(selected.tool === "jira.add-screen-tab-field" ? [rows([ADDED])] : [])];
  const request = port(responses);
  expect(await mutate(selected.tool, selected.args, request, true)).toEqual({
    ok: true,
    receipt: {},
  });
  expect(writes(request)).toEqual([]);
});
it.each([
  { ...CASES[3].args, afterFieldId: "summary" },
  { ...CASES[3].args, afterFieldId: "unknown" },
  { ...CASES[3].args, position: "Middle" },
  { ...CASES[3].args, afterFieldId: "../other" },
  { ...CASES[3].args, after: "https://untrusted.invalid/field/description" },
  {
    ...CASES[3].args,
    expectedTabs: [
      { id: "21", name: "Fields" },
      { id: "21", name: "Other" },
    ],
  },
  { ...CASES[3].args, expectedFields: [FIELDS[0], { ...FIELDS[0], name: "Other" }] },
  { ...CASES[3].args, expectedFields: [{ id: "summary", name: "Summary" }, FIELDS[1]] },
] satisfies readonly CatalogJsonObject[])(
  "refuses incomplete, duplicate or unbound move inputs before any request: %#",
  async (args) => {
    const request = port([]);
    expect(await mutate("jira.move-screen-tab-field", args, request)).toMatchObject({
      ok: false,
      reason: "field-validation",
    });
    expect(request).not.toHaveBeenCalled();
  },
);
it("refuses an unproven anchor selector even when it names a reviewed field", async () => {
  const request = port([]);
  expect(
    await mutate(
      CASES[3].tool,
      { ...PARENT, expectedFields: FIELDS, fieldId: "summary", afterFieldId: "description" },
      request,
    ),
  ).toMatchObject({ ok: false, reason: "field-validation" });
  expect(request).not.toHaveBeenCalled();
});
it.each([-1, 2, 0.5, 2147483648])(
  "refuses an invalid zero-based tab position %i before any request",
  async (position) => {
    const request = port([]);
    expect(await mutate("jira.move-screen-tab", { ...PARENT, position }, request)).toMatchObject({
      ok: false,
      reason: "field-validation",
    });
    expect(request).not.toHaveBeenCalled();
  },
);
it.each([
  { script: [SCREEN, rows([...TABS].reverse()), rows(FIELDS)] },
  { script: [SCREEN, rows([{ ...TABS[0], name: "Renamed" }, TABS[1]])] },
  { script: [SCREEN, rows(TABS), rows([...FIELDS].reverse())] },
  { script: [SCREEN, rows(TABS), rows([{ ...FIELDS[0], showWhenEmpty: null }, FIELDS[1]])] },
  { script: [SCREEN, rows(TABS), rows([{ ...FIELDS[0], type: null }, FIELDS[1]])] },
  {
    script: [
      body({
        startAt: 0,
        maxResults: 100,
        total: 1,
        isLast: true,
        screens: [{ id: 12, name: "Review screen" }],
      }),
    ],
  },
])(
  "refuses stale identity, complete order or unknown-vs-false metadata before effects: %#",
  async ({ script }) => {
    const request = port(script);
    expect((await mutate(CASES[2].tool, CASES[2].args, request)).ok).toBe(false);
    expect(writes(request)).toEqual([]);
  },
);
it.each([
  { available: [] },
  { available: [{ ...ADDED, name: "Renamed" }] },
  { available: [{ ...ADDED, id: "customfield_10002" }] },
])("requires exact available-field identity and reviewed name: %#", async ({ available }) => {
  const request = port([...current(), rows(available)]);
  expect((await mutate(CASES[1].tool, CASES[1].args, request)).ok).toBe(false);
  expect(writes(request)).toEqual([]);
});
it("does not treat a partial, duplicate or oversized native layout as complete", async () => {
  for (const fields of [
    [FIELDS[0], FIELDS[0]],
    Array.from({ length: TOOL_CATALOG_LIMITS.maxArrayItems + 1 }, (_, index) => ({
      id: `field_${String(index)}`,
      name: "Field",
    })),
  ]) {
    const request = port([SCREEN, rows(TABS), rows(fields)]);
    expect((await mutate(CASES[2].tool, CASES[2].args, request)).ok).toBe(false);
    expect(writes(request)).toEqual([]);
  }
});
it.each([
  {
    tool: "jira.move-screen-tab" as const,
    args: { ...PARENT, position: 0 },
    script: [SCREEN, rows(TABS)],
  },
  {
    tool: "jira.move-screen-tab-field" as const,
    args: { ...PARENT, fieldId: "summary", expectedFields: FIELDS, position: "First" },
    script: current(),
  },
  {
    tool: "jira.set-screen-field-show-when-empty" as const,
    args: { ...PARENT, fieldId: "summary", expectedFields: FIELDS, showWhenEmpty: false },
    script: current(),
  },
])("reports a proven unchanged $tool without dispatch", async ({ tool, args, script }) => {
  const request = port(script);
  expect(await mutate(tool, args, request)).toMatchObject({
    ok: false,
    reason: "conflict",
    detail: { unchanged: true },
  });
  expect(writes(request)).toEqual([]);
});
it.each([
  { ok: false, reason: "timeout" },
  { ok: false, reason: "not-found", httpStatus: 404 },
  { ok: false, reason: "permission-denied", httpStatus: 403 },
  { ok: false, reason: "unavailable", httpStatus: 503 },
] satisfies readonly AtlassianWriteHttpOutcome[])(
  "retains the reviewed identity and never replays an uncertain or refused effect: %#",
  async (failure) => {
    const request = port([...current(), failure]);
    expect(await mutate(CASES[2].tool, CASES[2].args, request)).toMatchObject({
      ok: false,
      receipt: CASES[2].expectedReceipt,
    });
    expect(writes(request)).toHaveLength(1);
    expect(request).toHaveBeenCalledTimes(4);
  },
);
it.each([
  { confirmation: [SCREEN, rows(TABS), rows(FIELDS)] },
  { confirmation: [SCREEN, rows(TABS), { ok: false, reason: "not-found", httpStatus: 404 }] },
  { confirmation: [{ ok: false, reason: "permission-denied", httpStatus: 403 }] },
  { confirmation: [SCREEN, rows([{ ...TABS[0], name: "Changed" }, TABS[1]])] },
] satisfies readonly { readonly confirmation: readonly AtlassianWriteHttpOutcome[] }[])(
  "keeps acknowledged removal unconfirmed when independent evidence fails: %#",
  async ({ confirmation }) => {
    const request = port([...current(), ACK, ...confirmation]);
    expect(await mutate(CASES[2].tool, CASES[2].args, request)).toMatchObject({
      ok: false,
      receipt: CASES[2].expectedReceipt,
    });
    expect(writes(request)).toHaveLength(1);
  },
);
it("does not confirm a show flag that the independent response omitted", async () => {
  const request = port([
    ...current(),
    ACK,
    SCREEN,
    rows(TABS),
    rows([{ id: "summary", name: "Summary", type: "system" }, FIELDS[1]]),
  ]);
  expect(await mutate(CASES[4].tool, CASES[4].args, request)).toMatchObject({
    ok: false,
    reason: "unavailable",
    receipt: CASES[4].expectedReceipt,
  });
});
it("does not claim nothing was written when a tab name changes after acknowledgement", async () => {
  const request = port([
    ...current(),
    ACK,
    SCREEN,
    rows([{ ...TABS[0], name: "Changed" }, TABS[1]]),
  ]);
  const result = await mutate(CASES[2].tool, CASES[2].args, request);
  expect(result).toMatchObject({ ok: false, receipt: CASES[2].expectedReceipt });
  if (result.ok) throw new TypeError("Unexpected confirmation of a changed tab");
  expect(result.detail?.messages?.join(" ")).toContain("acknowledged");
  expect(result.detail?.messages?.join(" ")).not.toContain("Nothing was written");
});
it("does not confirm a moved field if unrelated metadata changed concurrently", async () => {
  const request = port([
    ...current(),
    ACK,
    SCREEN,
    rows(TABS),
    rows([FIELDS[1], { ...FIELDS[0], showWhenEmpty: true }]),
  ]);
  expect(await mutate(CASES[3].tool, CASES[3].args, request)).toMatchObject({
    ok: false,
    reason: "unavailable",
    receipt: CASES[3].expectedReceipt,
  });
});
it("keeps an acknowledged identity when independent readback throws", async () => {
  const request = port([...current(), ACK, new TypeError("Synthetic readback failure")]);
  await expect(mutate(CASES[2].tool, CASES[2].args, request)).rejects.toBeInstanceOf(
    JiraAcknowledgedMutationError,
  );
  expect(writes(request)).toHaveLength(1);
});
it("refuses the default route without explicit acceptance and never accepts a guessed screen", async () => {
  for (const args of [
    { fieldId: "customfield_10001", expectedFieldName: "Review" },
    { ...CASES[0].args, acceptUnverifiedDefault: false },
    { ...CASES[0].args, screenId: "1" },
  ]) {
    const request = port([]);
    expect(await mutate(CASES[0].tool, args, request)).toMatchObject({
      ok: false,
      reason: "field-validation",
    });
    expect(request).not.toHaveBeenCalled();
  }
});
