import { describe, expect, it, vi } from "vitest";
import { TOOL_CATALOG_LIMITS, type CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { jiraPropertyKey, jiraPropertyValue, JIRA_PROPERTY_VALUE_MAX_BYTES } from "./jira-entity-property-values.js";
import {
  executeJiraEntityPropertyRead as read,
  isJiraEntityPropertyRead,
  JIRA_ENTITY_PROPERTY_READS,
} from "./jira-managed-entity-properties.js";

const BASE = "https://jira.example.test/context";
const ISSUE = { id: "10002", key: "SYN-2", fields: { summary: "Synthetic issue" } };
type ReadName = Parameters<typeof read>[0];
interface Scenario {
  readonly prefix: string;
  readonly args: CatalogJsonObject;
  readonly admission: readonly Record<string, unknown>[];
  readonly admissionPaths: readonly string[];
  readonly path: string;
  readonly context: CatalogJsonObject;
  readonly agile?: boolean;
}
const CASES: readonly Scenario[] = [
  { prefix: "board", args: { boardId: "7" }, admission: [{ id: 7, name: "Board", type: "scrum" }],
    admissionPaths: ["board/7"], path: "board/7/properties", context: { boardId: "7" }, agile: true },
  { prefix: "sprint", args: { sprintId: "8" }, admission: [{ id: 8, name: "Sprint", state: "future" }],
    admissionPaths: ["sprint/8"], path: "sprint/8/properties", context: { sprintId: "8" }, agile: true },
  { prefix: "comment", args: { issueIdOrKey: "syn-2", commentId: "9" }, admission: [ISSUE,
      { id: "9", body: "Comment", self: `${BASE}/rest/api/2/issue/10002/comment/9` }],
    admissionPaths: ["issue/syn-2?fields=summary", "issue/10002/comment/9"], path: "comment/9/properties",
    context: { issueId: "10002", issueKey: "SYN-2", commentId: "9" } },
  { prefix: "dashboard-item", args: { dashboardId: "10", itemId: "20" },
    admission: [{ id: "10", name: "Dashboard", self: "https://untrusted.invalid/dashboard" }],
    admissionPaths: ["dashboard/10"], path: "dashboard/10/items/20/properties",
    context: { dashboardId: "10", selectedItemId: "20" } },
  { prefix: "issue", args: { issueIdOrKey: "syn-2" }, admission: [ISSUE],
    admissionPaths: ["issue/syn-2?fields=summary"], path: "issue/10002/properties", context: { issueId: "10002", issueKey: "SYN-2" } },
  { prefix: "issue-type", args: { issueTypeId: "11" }, admission: [{ id: "11", name: "Story" }],
    admissionPaths: ["issuetype/11"], path: "issuetype/11/properties", context: { issueTypeId: "11" } },
  { prefix: "project", args: { projectIdOrKey: "syn" }, admission: [{ id: "10000", key: "SYN", name: "Synthetic project" }],
    admissionPaths: ["project/syn"], path: "project/10000/properties", context: { projectId: "10000", projectKey: "SYN" } },
  { prefix: "user", args: { username: "Synthetic User" }, admission: [{ key: "user-key", name: "synthetic user" }],
    admissionPaths: ["user?username=Synthetic+User"], path: "user/properties?userKey=user-key",
    context: { userKey: "user-key", username: "synthetic user" } },
];
function request(bodies: readonly Record<string, unknown>[]) {
  const mock = vi.fn<JiraMutationRequest>().mockResolvedValue({ ok: false, reason: "timeout" });
  for (const body of bodies) mock.mockResolvedValueOnce({ ok: true, status: 200, body });
  return mock;
}
function fixture(scenario: Scenario, body: Record<string, unknown>) {
  const selected = request([...scenario.admission, body]);
  const unused = request([]);
  return { selected, unused, ports: {
    platform: scenario.agile ? unused : selected,
    agile: scenario.agile ? selected : unused,
    baseUrl: BASE,
  } };
}
function operation(prefix: string, keys = false): ReadName {
  const name = `jira.${prefix}-property${keys ? "-keys" : ""}`;
  if (!isJiraEntityPropertyRead(name)) throw new TypeError("Unknown fixture operation");
  return name;
}
function selectedPropertyPath(path: string, key: string): string {
  const split = path.indexOf("?");
  return split < 0 ? `${path}/${encodeURIComponent(key)}`
    : `${path.slice(0, split)}/${encodeURIComponent(key)}${path.slice(split)}`;
}

describe("bound native entity property reads", () => {
  it.each(CASES)("reads observed keys for $prefix through its fixed resource", async (scenario) => {
    const { selected, unused, ports } = fixture(scenario, { keys: [
      { key: "first", self: "https://untrusted.invalid/property" }, { key: "second" },
    ] });
    const result = await read(operation(scenario.prefix, true), { ...scenario.args, maxResults: 1 }, ports);
    expect(result.data).toEqual({ outcome: "succeeded", entityType: scenario.prefix, ...scenario.context,
      items: [{ key: "first" }], startAt: 0, total: 2, nextStartAt: 1 });
    expect(selected.mock.calls.map(([path]) => path)).toEqual([...scenario.admissionPaths, scenario.path]);
    expect(selected).toHaveBeenLastCalledWith(scenario.path, "GET", undefined, "json");
    expect(unused).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("untrusted.invalid");
  });
  it.each(CASES)("reads a selected value for $prefix without parsing text as JSON", async (scenario) => {
    const key = "display ~key";
    const { selected, unused, ports } = fixture(scenario, { key, value: '{"stored":"text"}' });
    expect((await read(operation(scenario.prefix), { ...scenario.args, propertyKey: key }, ports)).data).toEqual({
      outcome: "succeeded", entityType: scenario.prefix, ...scenario.context, propertyKey: key,
      items: [{ path: "", kind: "string", textValue: '{"stored":"text"}' }], nodeCount: 1,
    });
    expect(selected.mock.calls.map(([path]) => path)).toEqual([
      ...scenario.admissionPaths, selectedPropertyPath(scenario.path, key),
    ]);
    expect(unused).not.toHaveBeenCalled();
  });
  it("retains lossless string int64 board identities without numeric coercion", async () => {
    const id = "9223372036854775807";
    const platform = request([]);
    const agile = request([{ id }, { keys: [] }]);
    expect((await read("jira.board-property-keys", { boardId: id }, { platform, agile, baseUrl: BASE })).data.boardId).toBe(id);
    expect(agile).toHaveBeenLastCalledWith(`board/${id}/properties`, "GET", undefined, "json");
  });
  it("uses the canonical issue identity after an ID alias", async () => {
    const platform = request([ISSUE, { key: "x", value: null }]);
    expect((await read("jira.issue-property", { issueIdOrKey: "10002", propertyKey: "x" },
      { platform, agile: request([]), baseUrl: BASE })).data).toMatchObject({ issueId: "10002", issueKey: "SYN-2" });
    expect(platform).toHaveBeenLastCalledWith("issue/10002/properties/x", "GET", undefined, "json");
  });
  it("binds a user key through the user read before using the distinct native userKey property query", async () => {
    const platform = request([{ key: "key /+", name: "synthetic" }, { keys: [] }]);
    await read("jira.user-property-keys", { userKey: "key /+" }, { platform, agile: request([]), baseUrl: BASE });
    expect(platform.mock.calls.map(([path]) => path)).toEqual(["user?key=key+%2F%2B", "user/properties?userKey=key+%2F%2B"]);
  });
  it("retains only requested dashboard item context, without claiming an independent item read", async () => {
    const scenario = CASES.find(({ prefix }) => prefix === "dashboard-item");
    if (scenario === undefined) throw new TypeError("Missing dashboard fixture");
    const { selected, ports } = fixture(scenario, { keys: [] });
    const result = await read("jira.dashboard-item-property-keys", scenario.args, ports);
    expect(result.data).toMatchObject({ dashboardId: "10", selectedItemId: "20", total: 0 });
    expect(result.data).not.toHaveProperty("itemId");
    expect(selected).toHaveBeenCalledTimes(2);
  });
  it.each([
    { body: {}, reason: "malformed-payload" },
    { body: { keys: null }, reason: "malformed-payload" },
    { body: { keys: [{ key: "x" }, { key: "x" }] }, reason: "malformed-payload" },
    { body: { keys: Array.from({ length: TOOL_CATALOG_LIMITS.maxArrayItems + 1 }, (_, i) => ({ key: String(i) })) }, reason: "bounds-exceeded" },
  ])("does not invent an empty key list or truncate malformed keys", async ({ body, reason }) => {
    const platform = request([ISSUE, body]);
    expect((await read("jira.issue-property-keys", { issueIdOrKey: "SYN-2" }, { platform, agile: request([]), baseUrl: BASE })).data.reason).toBe(reason);
  });
  it.each([
    { body: { key: "x" }, reason: "malformed-payload" },
    { body: { key: "other", value: null }, reason: "conflict" },
    { body: { key: "x", value: undefined }, reason: "malformed-payload" },
    { body: Object.assign(Object.create({ value: null }) as Record<string, unknown>, { key: "x" }), reason: "malformed-payload" },
  ])("refuses missing or mismatched selected property values", async ({ body, reason }) => {
    const platform = request([ISSUE, body]);
    expect((await read("jira.issue-property", { issueIdOrKey: "SYN-2", propertyKey: "x" },
      { platform, agile: request([]), baseUrl: BASE })).data.reason).toBe(reason);
  });
  it.each(["", ".", "..", "a/b", "a\\b", "%2e", "%252f", "a\nb", "\ud800", "é".repeat(128)])("rejects an unsafe or oversized property key before requests: %j", async (propertyKey) => {
    const platform = request([]);
    const agile = request([]);
    expect((await read("jira.issue-property", { issueIdOrKey: "SYN-2", propertyKey }, { platform, agile, baseUrl: BASE })).data.reason).toBe("invalid-input");
    expect(platform).not.toHaveBeenCalled();
    expect(agile).not.toHaveBeenCalled();
  });
  it("retains observed native keys even when the transport cannot address them safely", async () => {
    const platform = request([ISSUE, { keys: [{ key: "a/b" }, { key: "%2e" }, { key: "." }] }]);
    expect((await read("jira.issue-property-keys", { issueIdOrKey: "SYN-2" },
      { platform, agile: request([]), baseUrl: BASE })).data.items).toEqual([{ key: "a/b" }, { key: "%2e" }, { key: "." }]);
  });
  const invalidArguments: readonly CatalogJsonObject[] = [
    { issueIdOrKey: "SYN-2", propertyKey: "x", method: "PUT" },
    { issueIdOrKey: "SYN-2", propertyKey: "x", url: "https://untrusted.invalid" },
    { issueIdOrKey: "SYN-2", propertyKey: "x", startAt: 0 },
  ];
  it.each(invalidArguments)("admits only the selected fixed read arguments", async (args) => {
    const platform = request([]);
    expect((await read("jira.issue-property", args, { platform, agile: request([]), baseUrl: BASE })).data.reason).toBe("invalid-input");
    expect(platform).not.toHaveBeenCalled();
  });
  it("rejects missing or ambiguous user selection before any native request", async () => {
    const selections: readonly CatalogJsonObject[] = [{}, { username: "one", userKey: "two" }];
    for (const args of selections) {
      const platform = request([]);
      expect((await read("jira.user-property-keys", args, { platform, agile: request([]), baseUrl: BASE })).data.reason).toBe("invalid-input");
      expect(platform).not.toHaveBeenCalled();
    }
  });
  it.each([{ id: 8 }, { id: Number.MAX_SAFE_INTEGER + 1 }, {}])("does not read properties after an unbound board response %j", async (body) => {
    const agile = request([body]);
    expect((await read("jira.board-property-keys", { boardId: "7" }, { platform: request([]), agile, baseUrl: BASE })).isError).toBe(true);
    expect(agile).toHaveBeenCalledTimes(1);
  });
  it("refuses a comment from another issue before reading its property route", async () => {
    const platform = request([ISSUE, { id: "9", body: "Comment", self: `${BASE}/rest/api/2/issue/10003/comment/9` }]);
    expect((await read("jira.comment-property-keys", { issueIdOrKey: "SYN-2", commentId: "9" },
      { platform, agile: request([]), baseUrl: BASE })).data.reason).toBe("conflict");
    expect(platform.mock.calls.map(([path]) => path)).toEqual(["issue/SYN-2?fields=summary", "issue/10002/comment/9"]);
  });
  it("preserves native transport refusal without following self links or retrying", async () => {
    const platform = request([ISSUE]);
    expect((await read("jira.issue-property", { issueIdOrKey: "SYN-2", propertyKey: "x" },
      { platform, agile: request([]), baseUrl: BASE })).data.reason).toBe("timeout");
    expect(platform).toHaveBeenCalledTimes(2);
  });
  it("refuses oversized expanded pointer rows instead of returning a misleading value prefix", async () => {
    const value = { ["p".repeat(10000)]: Array.from({ length: 40 }, () => null) };
    const platform = request([ISSUE, { key: "x", value }]);
    const result = await read("jira.issue-property", { issueIdOrKey: "SYN-2", propertyKey: "x" },
      { platform, agile: request([]), baseUrl: BASE });
    expect(result).toEqual({ isError: true, data: { outcome: "failed", reason: "bounds-exceeded" } });
  });
  it("has exactly the sixteen fixed GET names and no mutation or proxy alias", () => {
    expect(JIRA_ENTITY_PROPERTY_READS).toHaveLength(16);
    expect(new Set(JIRA_ENTITY_PROPERTY_READS).size).toBe(16);
    expect(isJiraEntityPropertyRead("jira.set-property")).toBe(false);
    expect(isJiraEntityPropertyRead("https://untrusted.invalid/properties")).toBe(false);
  });
});

describe("complete typed property values", () => {
  it("keeps root, empty keys, escaped pointer tokens and container kinds unambiguous", () => {
    expect(jiraPropertyValue({ "": null, "a/b~c": [false, 0, "", {}, []] })).toEqual({ ok: true, items: [
      { path: "", kind: "object", childCount: 2 },
      { path: "/", kind: "null" },
      { path: "/a~1b~0c", kind: "array", childCount: 5 },
      { path: "/a~1b~0c/0", kind: "boolean", booleanValue: false },
      { path: "/a~1b~0c/1", kind: "number", numberValue: 0 },
      { path: "/a~1b~0c/2", kind: "string", textValue: "" },
      { path: "/a~1b~0c/3", kind: "object", childCount: 0 },
      { path: "/a~1b~0c/4", kind: "array", childCount: 0 },
    ] });
  });
  it.each([null, false, 0, "", "  ", "[false]", [], {}])("accepts a supplied JSON root %j without substituting another value", (value) => {
    expect(jiraPropertyValue(value).ok).toBe(true);
  });
  it("enforces serialized native UTF-8 bytes, including JSON quotes and escaping", () => {
    expect(jiraPropertyValue("x".repeat(JIRA_PROPERTY_VALUE_MAX_BYTES - 2)).ok).toBe(true);
    expect(jiraPropertyValue("x".repeat(JIRA_PROPERTY_VALUE_MAX_BYTES - 1))).toEqual({ ok: false, reason: "bounds-exceeded" });
    expect(jiraPropertyValue("é".repeat(JIRA_PROPERTY_VALUE_MAX_BYTES / 2))).toEqual({ ok: false, reason: "bounds-exceeded" });
    expect(jiraPropertyValue("\n".repeat(JIRA_PROPERTY_VALUE_MAX_BYTES / 2))).toEqual({ ok: false, reason: "bounds-exceeded" });
    expect(jiraPropertyKey("é".repeat(127))).toBe(true);
  });
  it("refuses unpaired Unicode in values and object keys while preserving complete supplementary characters", () => {
    expect(jiraPropertyValue("\ud800")).toEqual({ ok: false, reason: "malformed-payload" });
    expect(jiraPropertyValue({ "\udfff": null })).toEqual({ ok: false, reason: "malformed-payload" });
    expect(jiraPropertyValue({ "\u{1f4dd}": "\u{1f4dd}" })).toEqual({ ok: true, items: [
      { path: "", kind: "object", childCount: 1 }, { path: "/\u{1f4dd}", kind: "string", textValue: "\u{1f4dd}" },
    ] });
  });
  it("refuses excessive node, object-key and nesting bounds without a successful prefix", () => {
    expect(jiraPropertyValue(Array.from({ length: TOOL_CATALOG_LIMITS.maxArrayItems }, () => null))).toEqual({ ok: false, reason: "bounds-exceeded" });
    expect(jiraPropertyValue(Object.fromEntries(Array.from({ length: TOOL_CATALOG_LIMITS.maxObjectKeys + 1 }, (_, i) => [String(i), 0])))).toEqual({ ok: false, reason: "bounds-exceeded" });
    let nested: unknown = null;
    for (let i = 0; i <= TOOL_CATALOG_LIMITS.maxSchemaDepth; i++) nested = [nested];
    expect(jiraPropertyValue(nested)).toEqual({ ok: false, reason: "bounds-exceeded" });
  });
  it.each([undefined, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 1n, new Date(0), "\u0000"])("refuses non-JSON or unreadable values %j", (value) => {
    expect(jiraPropertyValue(value)).toEqual({ ok: false, reason: "malformed-payload" });
  });
  it("rejects cyclic, sparse and accessor data without executing a getter", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.loop = cyclic;
    const getter = vi.fn(() => "not observed");
    const accessor = Object.defineProperty({}, "value", { enumerable: true, get: getter });
    expect(jiraPropertyValue(cyclic)).toEqual({ ok: false, reason: "malformed-payload" });
    expect(jiraPropertyValue(new Array(1))).toEqual({ ok: false, reason: "malformed-payload" });
    expect(jiraPropertyValue(accessor)).toEqual({ ok: false, reason: "malformed-payload" });
    expect(getter).not.toHaveBeenCalled();
  });
});
