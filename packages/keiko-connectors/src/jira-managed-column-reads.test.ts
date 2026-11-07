import { expect, it, vi } from "vitest";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import {
  executeJiraColumnRead as read,
  isJiraColumnRead,
} from "./jira-managed-column-reads.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";

interface FixturePayload {
  readonly body?: Record<string, unknown> | undefined;
  readonly items?: readonly unknown[] | undefined;
}
function response(payload: FixturePayload): ReturnType<typeof vi.fn<JiraMutationRequest>> {
  return vi.fn<JiraMutationRequest>().mockResolvedValue({
    ok: true, status: 200, body: payload.body,
    ...(payload.items === undefined ? {} : { items: payload.items }),
  });
}

it("retains native layout order and repeated fields without inventing positions", async () => {
  const request = response({ items: [
    { value: "summary", label: "Summary", self: "https://untrusted.invalid" },
    { value: "status", label: "" },
    { value: "summary" },
  ] });
  expect((await read("jira.system-columns", {}, request)).data).toEqual({
    outcome: "succeeded", layoutScope: "system", columnsAvailable: true,
    startAt: 0, total: 3, items: [
      { value: "summary", label: "Summary" }, { value: "status", label: "" }, { value: "summary" },
    ],
  });
  expect(request).toHaveBeenCalledExactlyOnceWith("settings/columns", "GET", undefined, "json-array");
});

it("pages a known layout locally without adding unsupported native paging parameters", async () => {
  const request = response({ items: [{ value: "summary" }, { value: "status" }, { value: "assignee" }] });
  expect((await read("jira.system-columns", { startAt: 1, maxResults: 1 }, request)).data).toMatchObject({
    startAt: 1, total: 3, nextStartAt: 2, items: [{ value: "status" }],
  });
  expect(request).toHaveBeenCalledExactlyOnceWith("settings/columns", "GET", undefined, "json-array");
});

it("keeps an explicitly selected username separate from observed resource identity", async () => {
  const request = response({ items: [{ value: "summary" }] });
  expect((await read("jira.user-columns", { username: "Case + Team" }, request)).data).toMatchObject({
    layoutScope: "named-user", selectedUsername: "Case + Team", items: [{ value: "summary" }],
  });
  expect(request).toHaveBeenCalledExactlyOnceWith(
    "user/columns?username=Case+%2B+Team", "GET", undefined, "json-array",
  );
});

it("omits the username for the connected actor's layout without inferring an account name", async () => {
  const request = response({ items: [] });
  const result = await read("jira.user-columns", {}, request);
  expect(result.data).toEqual({
    outcome: "succeeded", layoutScope: "current-user", columnsAvailable: true,
    startAt: 0, total: 0, items: [],
  });
  expect(request).toHaveBeenCalledExactlyOnceWith("user/columns", "GET", undefined, "json-array");
});

it("projects modern filter layouts without exposing navigable fields or following their URLs", async () => {
  const request = response({ body: {
    columnConfig: "EXPLICIT",
    columnLayoutItems: [
      { id: "summary", position: -1, columnHeadingKey: "", navigableField: { self: "https://untrusted.invalid" } },
      { id: "summary", position: 0 },
    ],
    self: "https://untrusted.invalid/filter/4",
  } });
  expect((await read("jira.filter-columns", { filterId: "4" }, request)).data).toEqual({
    outcome: "succeeded", layoutScope: "filter", selectedFilterId: "4", columnConfig: "EXPLICIT",
    columnsAvailable: true, startAt: 0, total: 2,
    items: [{ id: "summary", position: -1, columnHeadingKey: "" }, { id: "summary", position: 0 }],
  });
  expect(request).toHaveBeenCalledExactlyOnceWith("filter/4/columns", "GET", undefined, "json-object-or-array");
});

it("accepts the documented legacy filter array through the same single request", async () => {
  const request = response({ items: [{ value: "summary", label: "Summary" }] });
  expect((await read("jira.filter-columns", { filterId: "4" }, request)).data).toEqual({
    outcome: "succeeded", layoutScope: "filter", selectedFilterId: "4", columnsAvailable: true,
    startAt: 0, total: 1, items: [{ value: "summary", label: "Summary" }],
  });
  expect(request).toHaveBeenCalledExactlyOnceWith("filter/4/columns", "GET", undefined, "json-object-or-array");
});

it.each([
  { columnConfig: "SYSTEM" },
  { columnConfig: "NONE", columnLayoutItems: null },
  { columnLayoutItems: null },
])("keeps unavailable filter columns unknown without an empty page: %#", async (body) => {
  const result = await read("jira.filter-columns", { filterId: "4" }, response({ body }));
  expect(result.data).toMatchObject({
    outcome: "succeeded", layoutScope: "filter", selectedFilterId: "4", columnsAvailable: false,
  });
  for (const key of ["items", "total", "startAt", "nextStartAt"]) expect(result.data).not.toHaveProperty(key);
});

it("distinguishes an observed empty modern layout from unavailable columns", async () => {
  expect((await read("jira.filter-columns", { filterId: "4" }, response({
    body: { columnConfig: "EXPLICIT", columnLayoutItems: [] },
  }))).data).toEqual({
    outcome: "succeeded", layoutScope: "filter", selectedFilterId: "4", columnConfig: "EXPLICIT",
    columnsAvailable: true, startAt: 0, total: 0, items: [],
  });
});

it.each([
  {},
  { errorMessages: ["unavailable"] },
  { columnConfig: "UNRECOGNIZED", columnLayoutItems: [] },
  { columnConfig: false, columnLayoutItems: [] },
  { columnLayoutItems: {} },
  { columnLayoutItems: [{ id: "summary", position: 0.5 }] },
  { columnLayoutItems: [{ id: "summary", position: 2147483648 }] },
  { columnLayoutItems: [{ id: "summary", columnHeadingKey: false }] },
  { columnLayoutItems: [{ id: "" }] },
])("refuses malformed modern layouts without a second request: %#", async (body) => {
  const request = response({ body });
  expect((await read("jira.filter-columns", { filterId: "4" }, request)).data.reason).toBe("malformed-payload");
  expect(request).toHaveBeenCalledTimes(1);
});

it.each([
  { items: [{ value: "" }] },
  { items: [{ value: "summary", label: false }] },
  { body: { columnConfig: "SYSTEM", columnLayoutItems: [] } },
])("refuses malformed system columns without admitting a filter-only wrapper: %#", async (payload) => {
  expect((await read("jira.system-columns", {}, response(payload))).data.reason).toBe("malformed-payload");
});

it.each(["array", "wrapper"] as const)("refuses oversized %s layouts without truncating their meaning", async (shape) => {
  const values = Array.from({ length: TOOL_CATALOG_LIMITS.maxArrayItems + 1 }, () => ({ value: "summary", id: "summary" }));
  const payload = shape === "array" ? { items: values } : { body: { columnLayoutItems: values } };
  expect((await read("jira.filter-columns", { filterId: "4" }, response(payload))).data.reason).toBe("bounds-exceeded");
});

const INVALID: readonly [Parameters<typeof read>[0], CatalogJsonObject][] = [
  ["jira.system-columns", { username: "unselected" }],
  ["jira.system-columns", { maxResults: 101 }],
  ["jira.user-columns", { username: "" }],
  ["jira.user-columns", { username: null }],
  ["jira.user-columns", { url: "https://untrusted.invalid" }],
  ["jira.filter-columns", {}],
  ["jira.filter-columns", { filterId: "4/columns" }],
  ["jira.filter-columns", { filterId: "9223372036854775808" }],
  ["jira.filter-columns", { filterId: "4", startAt: -1 }],
];
it.each(INVALID)("refuses unsupported %s selectors before transport", async (name, args) => {
  const request = response({ items: [] });
  expect((await read(name, args, request)).data.reason).toBe("invalid-input");
  expect(request).not.toHaveBeenCalled();
});

it.each(["permission-denied", "not-found"] as const)("preserves native %s without trying another actor's columns", async (reason) => {
  const request = vi.fn<JiraMutationRequest>().mockResolvedValue({ ok: false, reason, httpStatus: reason === "not-found" ? 404 : 403 });
  expect((await read("jira.user-columns", { username: "selected" }, request)).data.reason).toBe(reason);
  expect(request).toHaveBeenCalledTimes(1);
});

it("recognizes only the three closed column-read identities", () => {
  expect(isJiraColumnRead("jira.filter-columns")).toBe(true);
  expect(isJiraColumnRead("constructor")).toBe(false);
  expect(isJiraColumnRead("jira.edit-columns")).toBe(false);
});
