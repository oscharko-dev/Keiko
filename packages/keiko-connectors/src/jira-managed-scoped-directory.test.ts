import { describe, expect, it, vi } from "vitest";
import { TOOL_CATALOG_LIMITS, type CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { executeJiraScopedDirectoryRead, isJiraScopedDirectoryRead } from "./jira-managed-scoped-directory.js";
const USER = { key: "user-7", name: "synthetic", displayName: "Synthetic user", active: true };
function users(): ReturnType<typeof vi.fn<JiraMutationRequest>> {
  return vi.fn<JiraMutationRequest>().mockResolvedValue({ ok: true, status: 200, body: undefined, items: [USER] });
}
function object(body: Record<string, unknown>): ReturnType<typeof vi.fn<JiraMutationRequest>> {
  return vi.fn<JiraMutationRequest>().mockResolvedValue({ ok: true, status: 200, body });
}
describe("bounded scoped user and picker reads", () => {
  it.each([
    ["jira.multi-project-assignable-users", { projectKeys: ["SYN", "OTHER"], query: "syn" }, "user/assignable/multiProjectSearch?maxResults=25&username=syn&projectKeys=SYN%2COTHER"],
    ["jira.permission-users", { projectKey: "SYN", permissions: ["BROWSE_PROJECTS", "ASSIGN_ISSUES"], query: "syn" }, "user/permission/search?maxResults=25&username=syn&projectKey=SYN&permissions=BROWSE_PROJECTS%2CASSIGN_ISSUES&startAt=0"],
    ["jira.browse-permission-users", { issueKey: "SYN-1", query: "syn" }, "user/viewissue/search?maxResults=25&username=syn&issueKey=SYN-1"],
  ] as const)("uses exact published selector encoding for %s", async (name, args, path) => {
    const request = users();
    const result = await executeJiraScopedDirectoryRead(name, args, request);
    expect(result.data).toMatchObject({ outcome: "succeeded", items: [USER], searchLimit: 100 });
    expect(result.data).not.toHaveProperty("total");
    expect(request).toHaveBeenCalledExactlyOnceWith(path, "GET", undefined, "json-array");
  });
  it("only advertises an offset continuation where the native endpoint publishes startAt", async () => {
    const permission = await executeJiraScopedDirectoryRead("jira.permission-users", { issueKey: "SYN-1", permissions: ["BROWSE_PROJECTS"], startAt: 98, maxResults: 1 }, users());
    expect(permission.data).toMatchObject({ startAt: 98, nextStartAt: 99, searchLimit: 100 });
    const multi = await executeJiraScopedDirectoryRead("jira.multi-project-assignable-users", { projectKeys: ["SYN"], maxResults: 1 }, users());
    expect(multi.data).not.toHaveProperty("startAt");
    expect(multi.data).not.toHaveProperty("nextStartAt");
  });
  it("stops native first100 continuation without claiming the directory is complete", async () => {
    const result = await executeJiraScopedDirectoryRead("jira.permission-users", { projectKey: "SYN", permissions: ["BROWSE_PROJECTS"], startAt: 99, maxResults: 1 }, users());
    expect(result.data).toEqual({ outcome: "succeeded", items: [USER], searchLimit: 100, startAt: 99 });
  });
  it("retains independent picker branch counts and strips native highlight/avatar content", async () => {
    const request = object({ users: { users: [{ ...USER, html: "<b>hidden</b>", emailAddress: "ignored@example.invalid" }], total: 8, header: "ignored" }, groups: { groups: [{ name: "Team", html: "<b>Team</b>", labels: [{ type: "ADMIN" }] }], total: 3 } });
    const result = await executeJiraScopedDirectoryRead("jira.group-user-picker", { query: "syn", fieldId: "customfield_10001", projectId: "10001", issueTypeId: "1" }, request);
    expect(result.data).toEqual({ outcome: "succeeded", users: [USER], usersTotal: 8, groups: [{ name: "Team" }], groupsTotal: 3 });
    expect(request).toHaveBeenCalledExactlyOnceWith("groupuserpicker?maxResults=25&query=syn&showAvatar=false&fieldId=customfield_10001&projectId=10001&issueTypeId=1", "GET", undefined, "json");
  });
  it("keeps absent picker branches unknown instead of empty or zero", async () => {
    expect((await executeJiraScopedDirectoryRead("jira.group-user-picker", {}, object({ groups: null }))).data).toEqual({ outcome: "succeeded" });
    expect((await executeJiraScopedDirectoryRead("jira.group-user-picker", {}, object({ groups: { groups: [] }, users: { users: [], total: 0 } }))).data).toEqual({ outcome: "succeeded", users: [], usersTotal: 0, groups: [] });
  });
  it("does not apply the documented user limit to the separate native group result", async () => {
    const result = await executeJiraScopedDirectoryRead("jira.group-user-picker", { maxResults: 1 }, object({ users: { users: [USER] }, groups: { groups: [{ name: "A" }, { name: "B" }] } }));
    expect(result.data.groups).toEqual([{ name: "A" }, { name: "B" }]);
  });
  it("projects a native project picker without inventing page offsets", async () => {
    const request = object({ projects: [{ id: "10001", key: "SYN", name: "Synthetic", html: "ignored", avatar: "https://untrusted.invalid" }], total: 5, header: "ignored" });
    const result = await executeJiraScopedDirectoryRead("jira.project-picker", { query: "", allowEmptyQuery: true }, request);
    expect(result.data).toEqual({ outcome: "succeeded", items: [{ id: "10001", key: "SYN", name: "Synthetic" }], total: 5 });
    expect(request).toHaveBeenCalledExactlyOnceWith("projects/picker?maxResults=25&query=&allowEmptyQuery=true", "GET", undefined, "json");
  });
  it.each([
    ["jira.multi-project-assignable-users", { projectKeys: [] }],
    ["jira.multi-project-assignable-users", { projectKeys: ["SYN", "SYN"] }],
    ["jira.multi-project-assignable-users", { projectKeys: ["SYN,OTHER"] }],
    ["jira.multi-project-assignable-users", { projectKeys: ["SYN"], startAt: 1 }],
    ["jira.permission-users", { permissions: ["BROWSE_PROJECTS"] }],
    ["jira.permission-users", { projectKey: "SYN", issueKey: "SYN-1", permissions: ["BROWSE_PROJECTS"] }],
    ["jira.permission-users", { projectKey: "SYN", permissions: [] }],
    ["jira.permission-users", { projectKey: "SYN", permissions: ["BROWSE_PROJECTS"], startAt: 98, maxResults: 3 }],
    ["jira.browse-permission-users", { issueKey: "SYN-1", query: "" }],
    ["jira.browse-permission-users", { issueKey: "SYN-1", query: "syn", startAt: 0 }],
    ["jira.group-user-picker", { projectId: ["1", "2"] }],
    ["jira.group-user-picker", { showAvatar: true }],
    ["jira.group-user-picker", { fieldId: "../field" }],
    ["jira.project-picker", { allowEmptyQuery: "true" }],
    ["jira.project-picker", { maxResults: 101 }],
  ] as const)("refuses unsupported selectors for %s before transport", async (name, args) => {
    const request = users();
    expect((await executeJiraScopedDirectoryRead(name, args, request)).data.reason).toBe("invalid-input");
    expect(request).not.toHaveBeenCalled();
  });
  it.each([
    { users: { users: [USER], total: 0 } },
    { groups: { groups: [{ name: "Team" }, { name: "Team" }] } },
    { users: { users: [{ name: "No native key" }] } },
    { users: false },
  ])("refuses malformed picker branches %j", async (body) => {
    expect((await executeJiraScopedDirectoryRead("jira.group-user-picker", {}, object(body))).data.reason).toBe("malformed-payload");
  });
  it("retains a true group bound failure without truncation", async () => {
    const groups = Array.from({ length: TOOL_CATALOG_LIMITS.maxArrayItems + 1 }, (_, index) => ({ name: `Group-${index}` }));
    expect((await executeJiraScopedDirectoryRead("jira.group-user-picker", {}, object({ groups: { groups } }))).data.reason).toBe("bounds-exceeded");
  });
  it("preserves native permission refusal without broad directory fallback", async () => {
    const request = vi.fn<JiraMutationRequest>().mockResolvedValue({ ok: false, reason: "permission-denied", httpStatus: 403 });
    const args: CatalogJsonObject = { projectKey: "SYN", permissions: ["BROWSE_PROJECTS"] };
    expect((await executeJiraScopedDirectoryRead("jira.permission-users", args, request)).data.reason).toBe("permission-denied");
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("recognizes only this closed search family", () => {
    expect(isJiraScopedDirectoryRead("jira.group-user-picker")).toBe(true);
    expect(isJiraScopedDirectoryRead("jira.user-picker")).toBe(false);
    expect(isJiraScopedDirectoryRead("jira.users")).toBe(false);
  });
});
