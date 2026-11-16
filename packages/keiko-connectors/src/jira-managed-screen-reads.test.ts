import { describe, expect, it, vi } from "vitest";
import { TOOL_CATALOG_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { executeJiraScreenRead, isJiraScreenRead } from "./jira-managed-screen-reads.js";

function requestFor(items: readonly unknown[]): ReturnType<typeof vi.fn<JiraMutationRequest>> {
  return vi
    .fn<JiraMutationRequest>()
    .mockResolvedValue({ ok: true, status: 200, body: undefined, items });
}
const TAB = { id: 10, name: "Main", self: "https://untrusted.invalid/screen" };
const FIELD = {
  id: "customfield_10010",
  name: "Acceptance criteria",
  type: "custom",
  showWhenEmpty: false,
};
describe("bounded native screen inspection", () => {
  it.each([
    ["jira.screen-tabs", { screenId: "7" }, "screens/7/tabs", [TAB]],
    [
      "jira.screen-tabs",
      { screenId: "9223372036854775807", projectKey: "SYN" },
      "screens/9223372036854775807/tabs?projectKey=SYN",
      [TAB],
    ],
    [
      "jira.screen-tab-fields",
      { screenId: "7", tabId: "9007199254740993" },
      "screens/7/tabs/9007199254740993/fields",
      [FIELD],
    ],
    [
      "jira.screen-tab-fields",
      { screenId: "7", tabId: "10", projectKey: "SYN" },
      "screens/7/tabs/10/fields?projectKey=SYN",
      [FIELD],
    ],
    ["jira.screen-available-fields", { screenId: "7" }, "screens/7/availableFields", [FIELD]],
  ] as const)("uses only the fixed JSON-array route for %s", async (name, args, path, items) => {
    const request = requestFor(items);
    expect((await executeJiraScreenRead(name, args, request)).data).toMatchObject({
      outcome: "succeeded",
      ...args,
      startAt: 0,
      total: 1,
    });
    expect(request).toHaveBeenCalledExactlyOnceWith(path, "GET", undefined, "json-array");
  });
  it("retains exact tab IDs and names while dropping native URLs and undeclared metadata", async () => {
    const result = await executeJiraScreenRead(
      "jira.screen-tabs",
      { screenId: "7" },
      requestFor([TAB, { id: "9223372036854775807", name: "Other", required: true }]),
    );
    expect(result.data.items).toEqual([
      { id: "10", name: "Main" },
      { id: "9223372036854775807", name: "Other" },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/https|self|required/u);
  });
  it("keeps observed field options without claiming requiredness or inferring missing flags", async () => {
    const result = await executeJiraScreenRead(
      "jira.screen-tab-fields",
      { screenId: "7", tabId: "10" },
      requestFor([
        FIELD,
        {
          id: "summary",
          name: "Summary",
          required: true,
          showWhenEmpty: null,
          type: null,
          self: "https://untrusted.invalid/field",
        },
      ]),
    );
    expect(result.data).toMatchObject({
      screenId: "7",
      tabId: "10",
      items: [FIELD, { id: "summary", name: "Summary" }],
    });
    expect(JSON.stringify(result)).not.toMatch(/required|https|self/u);
  });
  it("pages the complete native collection locally and preserves native ordering", async () => {
    const request = requestFor([TAB, { id: 11, name: "Second" }]);
    const first = await executeJiraScreenRead(
      "jira.screen-tabs",
      { screenId: "7", maxResults: 1 },
      request,
    );
    const second = await executeJiraScreenRead(
      "jira.screen-tabs",
      { screenId: "7", startAt: 1, maxResults: 1 },
      request,
    );
    expect(first.data).toMatchObject({
      total: 2,
      startAt: 0,
      nextStartAt: 1,
      items: [{ id: "10" }],
    });
    expect(second.data).toEqual({
      outcome: "succeeded",
      screenId: "7",
      total: 2,
      startAt: 1,
      items: [{ id: "11", name: "Second" }],
    });
    expect(request.mock.calls).toEqual([
      ["screens/7/tabs", "GET", undefined, "json-array"],
      ["screens/7/tabs", "GET", undefined, "json-array"],
    ]);
  });
  it("reports an observed empty collection without inventing fields or mandatory settings", async () => {
    expect(
      (
        await executeJiraScreenRead(
          "jira.screen-available-fields",
          { screenId: "7" },
          requestFor([]),
        )
      ).data,
    ).toEqual({ outcome: "succeeded", screenId: "7", items: [], startAt: 0, total: 0 });
  });
  it.each([
    { screenId: 7 },
    { screenId: "0" },
    { screenId: "07" },
    { screenId: "-7" },
    { screenId: "9223372036854775808" },
    { screenId: "../7" },
    { screenId: "7", url: "https://untrusted.invalid" },
    { screenId: "7", projectKey: "SYN&other=1" },
    { screenId: "7", projectKey: null },
    { screenId: "7", startAt: -1 },
    { screenId: "7", startAt: 1.5 },
    { screenId: "7", startAt: 1_000_001 },
    { screenId: "7", maxResults: 0 },
    { screenId: "7", maxResults: 101 },
  ] satisfies CatalogJsonObject[])(
    "refuses invalid scope or paging before transport %#",
    async (args) => {
      const request = requestFor([]);
      expect((await executeJiraScreenRead("jira.screen-tabs", args, request)).data).toMatchObject({
        outcome: "failed",
        reason: "invalid-input",
      });
      expect(request).not.toHaveBeenCalled();
    },
  );
  it.each([
    ["jira.screen-tab-fields", { screenId: "7" }],
    ["jira.screen-tab-fields", { screenId: "7", tabId: 10 }],
    ["jira.screen-tabs", { screenId: "7", tabId: "10" }],
    ["jira.screen-available-fields", { screenId: "7", projectKey: "SYN" }],
  ] as const)("never adds unsupported native routing parameters for %s", async (name, args) => {
    const request = requestFor([]);
    expect((await executeJiraScreenRead(name, args, request)).isError).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });
  it.each([
    { items: [{ id: Number.MAX_SAFE_INTEGER + 1, name: "Rounded" }] },
    { items: [{ id: "01", name: "Noncanonical" }] },
    { items: [{ id: 10, name: "" }] },
    {
      items: [
        { id: 10, name: "Main" },
        { id: "10", name: "Duplicate" },
      ],
    },
  ])("refuses imprecise or ambiguous tab metadata %#", async ({ items }) => {
    expect(
      (await executeJiraScreenRead("jira.screen-tabs", { screenId: "7" }, requestFor(items))).data,
    ).toMatchObject({ outcome: "failed", reason: "malformed-payload" });
  });
  it.each([
    { items: [{ ...FIELD, id: 10010 }] },
    { items: [{ ...FIELD, name: null }] },
    { items: [{ ...FIELD, type: {} }] },
    { items: [{ ...FIELD, showWhenEmpty: "false" }] },
    { items: [FIELD, FIELD] },
  ])(
    "refuses malformed field metadata instead of fabricating a partial page %#",
    async ({ items }) => {
      expect(
        (
          await executeJiraScreenRead(
            "jira.screen-available-fields",
            { screenId: "7" },
            requestFor(items),
          )
        ).data,
      ).toMatchObject({ outcome: "failed", reason: "malformed-payload" });
    },
  );
  it("refuses a native collection above the existing catalog bound", async () => {
    const items = Array.from({ length: TOOL_CATALOG_LIMITS.maxArrayItems + 1 }, (_, i) => ({
      id: i + 1,
      name: "Tab",
    }));
    expect(
      (await executeJiraScreenRead("jira.screen-tabs", { screenId: "7" }, requestFor(items))).data,
    ).toEqual({ outcome: "failed", reason: "bounds-exceeded" });
  });
  it.each(["permission-denied", "auth-failed", "rate-limited", "not-found"] as const)(
    "preserves a native %s refusal without a query or permission fallback",
    async (reason) => {
      const request = vi
        .fn<JiraMutationRequest>()
        .mockResolvedValue({ ok: false, reason, remote: { messages: ["Native refusal"] } });
      expect(
        (
          await executeJiraScreenRead(
            "jira.screen-tabs",
            { screenId: "7", projectKey: "SYN" },
            request,
          )
        ).data,
      ).toEqual({ outcome: "failed", reason, messages: ["Native refusal"] });
      expect(request).toHaveBeenCalledTimes(1);
    },
  );
  it("requires a native array and exact successful status", async () => {
    for (const response of [
      { ok: true, status: 200, body: { items: [] } },
      { ok: true, status: 204, body: undefined, items: [] },
    ] as const) {
      const request = vi.fn<JiraMutationRequest>().mockResolvedValue(response);
      expect(
        (await executeJiraScreenRead("jira.screen-tabs", { screenId: "7" }, request)).isError,
      ).toBe(true);
    }
  });
  it("recognizes only the three declared screen reads", () => {
    expect(isJiraScreenRead("jira.screen-tabs")).toBe(true);
    expect(isJiraScreenRead("jira.screen-tab-fields")).toBe(true);
    expect(isJiraScreenRead("jira.screen-available-fields")).toBe(true);
    expect(isJiraScreenRead("jira.screen-delete")).toBe(false);
    expect(isJiraScreenRead("constructor")).toBe(false);
  });
});
