import { describe, expect, it, vi } from "vitest";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { AtlassianHttpBodyPort } from "./atlassian-http-port.js";
import { executeJiraAgileContextRead, isJiraAgileContextRead } from "./jira-agile-context-reads.js";
import { JIRA_MANAGED_ISSUE_FIELDS, JIRA_MANAGED_SEARCH_FIELDS } from "./jira-managed-issue-reads.js";

type Operation = Parameters<typeof executeJiraAgileContextRead>[0];
interface Response { readonly body: unknown; readonly status?: number; }
function fixture(responses: readonly Response[]) {
  let index = 0;
  const http = vi.fn<AtlassianHttpBodyPort>(() => {
    const selected = responses[index++];
    if (selected === undefined) throw new Error("Unexpected native request");
    const bodyText = JSON.stringify(selected.body);
    return Promise.resolve({ kind: "response", status: selected.status ?? 200, bodyText, bodyBytes: Buffer.byteLength(bodyText), truncated: false });
  });
  const context = { invocationId: "agile-context", correlationId: "agile-context-proof", signal: new AbortController().signal, beforeEffect: (): boolean => true };
  const connection = { deployment: "data-center" as const, baseUrl: "https://jira.example.invalid/context", http };
  return { http, context, connection, read: (name: Operation, args: CatalogJsonObject) => executeJiraAgileContextRead(name, args, context, connection) };
}
const BOARD = { id: 7, name: "Team", type: "scrum" };
const ISSUE = { id: "10001", key: "SYN-1", fields: { summary: "Scoped issue", description: "Native description" } };
function page(values: readonly unknown[]) { return { startAt: 0, maxResults: 25, total: values.length, isLast: true, values }; }
function issuePage() { return { startAt: 0, maxResults: 25, total: 1, issues: [ISSUE] }; }

describe("native Agile context reads", () => {
  it.each([
    ["jira.board-epicless-issues", { boardId: "7" }, "board/7/epic/none/issue"],
    ["jira.board-epic-issues", { boardId: "7", epicId: "11" }, "board/7/epic/11/issue"],
    ["jira.board-sprint-issues", { boardId: "7", sprintId: "9" }, "board/7/sprint/9/issue"],
    ["jira.epicless-issues", {}, "epic/none/issue"],
  ] as const)("reads %s through the bound Agile root", async (name, args, path) => {
    const f = fixture([{ body: issuePage() }]);
    const result = await f.read(name, { ...args, jql: "project = SYN" });
    const query = new URLSearchParams({ startAt: "0", maxResults: "25", fields: JIRA_MANAGED_SEARCH_FIELDS, validateQuery: "true", jql: "project = SYN" });
    expect(f.http.mock.calls[0]?.[0].url).toBe(`https://jira.example.invalid/context/rest/agile/1.0/${path}?${query.toString()}`);
    expect(result.data).toMatchObject({ outcome: "succeeded", items: [{ id: "10001", key: "SYN-1" }], total: 1,
      collectionScope: name === "jira.epicless-issues" ? "visible-epicless-issues" : "visible-board-issues" });
  });
  it("reads an Agile issue with history writes explicitly disabled", async () => {
    const f = fixture([{ body: { ...ISSUE, self: "https://untrusted.invalid/issue" } }]);
    const result = await f.read("jira.agile-issue", { issueIdOrKey: "syn-1" });
    const query = new URLSearchParams({ fields: JIRA_MANAGED_ISSUE_FIELDS, updateHistory: "false" });
    expect(f.http.mock.calls[0]?.[0].url).toBe(`https://jira.example.invalid/context/rest/agile/1.0/issue/syn-1?${query.toString()}`);
    expect(result.data).toMatchObject({ items: [{ key: "SYN-1", description: "Native description", browseUrl: "https://jira.example.invalid/context/browse/SYN-1" }] });
    expect(JSON.stringify(result)).not.toContain("untrusted.invalid");
  });
  it("accepts the exact numeric issue identity without treating it as a browse key", async () => {
    const f = fixture([{ body: ISSUE }]);
    expect((await f.read("jira.agile-issue", { issueIdOrKey: "10001" })).data).toMatchObject({ items: [{ key: "SYN-1" }] });
  });
  it("refuses an unrelated issue identity", async () => {
    const f = fixture([{ body: ISSUE }]);
    expect((await f.read("jira.agile-issue", { issueIdOrKey: "SYN-2" })).data).toMatchObject({ reason: "malformed-payload" });
  });
  it("binds a readable board before returning visible project metadata", async () => {
    const f = fixture([{ body: BOARD }, { body: page([{ id: "10000", key: "SYN", name: "Scoped", archived: false, description: "", self: "https://untrusted.invalid/" }]) }]);
    const result = await f.read("jira.board-projects", { boardId: "7" });
    expect(f.http.mock.calls.map(([request]) => request.url)).toEqual([
      "https://jira.example.invalid/context/rest/agile/1.0/board/7",
      "https://jira.example.invalid/context/rest/agile/1.0/board/7/project?startAt=0&maxResults=25",
    ]);
    expect(result.data).toMatchObject({ boardId: "7", collectionScope: "visible-board-projects", items: [{ id: "10000", key: "SYN", name: "Scoped", description: "", archived: false }] });
    expect(JSON.stringify(result)).not.toContain("untrusted.invalid");
  });
  it.each(["jira.board-projects", "jira.board-versions"] as const)("keeps empty %s scoped to native visibility", async (name) => {
    const f = fixture([{ body: BOARD }, { body: page([]) }]);
    expect((await f.read(name, { boardId: "7" })).data).toMatchObject({ outcome: "succeeded", boardId: "7", total: 0, items: [], collectionScope: name === "jira.board-projects" ? "visible-board-projects" : "visible-board-versions" });
  });
  it.each(["jira.board-projects", "jira.board-versions"] as const)("does not turn an unreadable %s parent into empty evidence", async (name) => {
    const f = fixture([{ status: 404, body: {} }]);
    expect((await f.read(name, { boardId: "7" })).isError).toBe(true);
    expect(f.http).toHaveBeenCalledTimes(1);
  });
  it("refuses a mismatched board before listing", async () => {
    const f = fixture([{ body: { ...BOARD, id: 8 } }]);
    expect((await f.read("jira.board-projects", { boardId: "7" })).data).toMatchObject({ reason: "malformed-payload" });
    expect(f.http).toHaveBeenCalledTimes(1);
  });
  it("normalizes precise native version IDs and local dates using the shared version summary", async () => {
    const f = fixture([{ body: BOARD }, { body: page([{ id: 12, projectId: "9223372036854775807", name: "Release", releaseDate: "2026-01-02T00:30:00.000+10:00", released: false }]) }]);
    const result = await f.read("jira.board-versions", { boardId: "7", released: false });
    expect(result.data).toMatchObject({ items: [{ versionId: "12", projectId: "9223372036854775807", name: "Release", releaseDate: "2026-01-02", released: false }] });
    expect(f.http.mock.calls[1]?.[0].url).toContain("/board/7/version?startAt=0&maxResults=25&released=false");
    expect(asItems(result.data.items)?.[0]).not.toHaveProperty("id");
  });
  it.each([9007199254740992, "0", "01"])("refuses a lossy or invalid version ID %s", async (id) => {
    const f = fixture([{ body: BOARD }, { body: page([{ id, name: "Release" }]) }]);
    expect((await f.read("jira.board-versions", { boardId: "7" })).data).toMatchObject({ reason: "malformed-payload" });
  });
  it.each([undefined, null])("preserves missing version metadata and total %s as unknown", async (total) => {
    const f = fixture([{ body: BOARD }, { body: { startAt: 0, maxResults: 25, isLast: true, ...(total === undefined ? {} : { total }), values: [{ id: "12", name: "Release" }] } }]);
    const result = await f.read("jira.board-versions", { boardId: "7" });
    expect(result.data).not.toHaveProperty("total");
    expect(result.data.items).toEqual([{ versionId: "12", name: "Release" }]);
  });
  it.each([true, false])("preserves the observed refined velocity setting %s", async (value) => {
    const f = fixture([{ body: { value } }]);
    expect((await f.read("jira.board-refined-velocity", { boardId: "7" })).data).toEqual({ outcome: "succeeded", boardId: "7", value });
  });
  it.each([{}, { value: null }, { value: "false" }])("does not invent a refined velocity flag from %j", async (body) => {
    const f = fixture([{ body }]);
    expect((await f.read("jira.board-refined-velocity", { boardId: "7" })).isError).toBe(true);
  });
  it.each([0, 8.5, "8.0", "", undefined, null])("retains estimation value %s without assuming units", async (value) => {
    const f = fixture([{ body: ISSUE }, { body: { fieldId: "customfield_10001", ...(value === undefined ? {} : { value }) } }]);
    const result = await f.read("jira.issue-estimation", { boardId: "7", issueIdOrKey: "10001" });
    expect(result.data).toMatchObject({ outcome: "succeeded", issueId: "10001", issueKey: "SYN-1", boardId: "7", fieldId: "customfield_10001" });
    if (value === undefined || value === null) expect(result.data).not.toHaveProperty("value");
    else expect(result.data.value).toBe(value);
    expect(f.http.mock.calls.map(([request]) => request.url)).toEqual([
      "https://jira.example.invalid/context/rest/agile/1.0/issue/10001?fields=summary&updateHistory=false",
      "https://jira.example.invalid/context/rest/agile/1.0/issue/10001/estimation?boardId=7",
    ]);
  });
  it("uses the observed issue ID for estimation after resolving a caller alias", async () => {
    const f = fixture([{ body: ISSUE }, { body: { fieldId: "timeoriginalestimate", value: 3600 } }]);
    const result = await f.read("jira.issue-estimation", { boardId: "7", issueIdOrKey: "syn-1" });
    expect(result.data).toMatchObject({ issueId: "10001", issueKey: "SYN-1", value: 3600 });
    expect(f.http.mock.calls[0]?.[0].url).toContain("/issue/syn-1?fields=summary&updateHistory=false");
    expect(f.http.mock.calls[1]?.[0].url).toContain("/issue/10001/estimation?boardId=7");
  });
  it("refuses a nonnumeric native issue ID before estimation", async () => {
    const f = fixture([{ body: { ...ISSUE, id: "not-an-id" } }]);
    expect((await f.read("jira.issue-estimation", { boardId: "7", issueIdOrKey: "SYN-1" })).isError).toBe(true);
    expect(f.http).toHaveBeenCalledTimes(1);
  });
  it.each([{}, { nested: true }, true, 9007199254740992])("refuses unsupported estimation values %j", async (value) => {
    const f = fixture([{ body: ISSUE }, { body: { fieldId: "customfield_10001", value } }]);
    expect((await f.read("jira.issue-estimation", { boardId: "7", issueIdOrKey: "SYN-1" })).isError).toBe(true);
  });
  it.each([
    ["jira.issue-estimation", { issueIdOrKey: "SYN-1" }],
    ["jira.board-projects", { boardId: "7", maxResults: 101 }],
    ["jira.board-versions", { boardId: "7", released: "false" }],
    ["jira.agile-issue", { issueIdOrKey: "SYN-1", updateHistory: true }],
    ["jira.epicless-issues", { expand: "all" }],
    ["jira.board-sprint-issues", { boardId: "7", sprintId: "9007199254740992" }],
    ["jira.epicless-issues", { jql: "x".repeat(2049) }],
  ] as const)("refuses invalid %s input before transport", async (name, args) => {
    const f = fixture([]);
    expect((await f.read(name, args)).data).toMatchObject({ reason: "invalid-input" });
    expect(f.http).not.toHaveBeenCalled();
  });
  it("does not retry a denied collection after the parent read", async () => {
    const f = fixture([{ body: BOARD }, { status: 403, body: { errorMessages: ["Denied"] } }]);
    expect((await f.read("jira.board-versions", { boardId: "7" })).isError).toBe(true);
    expect(f.http).toHaveBeenCalledTimes(2);
  });
  it("names oversized native collections as bounds failures", async () => {
    const f = fixture([{ body: BOARD }, { body: { ...page([{ id: "1", key: "SYN", name: "One" }, { id: "2", key: "TWO", name: "Two" }]), maxResults: 1 } }]);
    expect((await f.read("jira.board-projects", { boardId: "7", maxResults: 1 })).data).toMatchObject({ reason: "bounds-exceeded" });
  });
  it("rejects foreign tool names in the closed guard", () => {
    expect(isJiraAgileContextRead("jira.board-projects")).toBe(true);
    expect(isJiraAgileContextRead("jira.board-project-delete")).toBe(false);
  });
});
function asItems(value: unknown): readonly Record<string, unknown>[] | undefined {
  return Array.isArray(value) ? value : undefined;
}
