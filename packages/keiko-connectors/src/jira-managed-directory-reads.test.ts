import { describe, expect, it, vi } from "vitest";
import { TOOL_CATALOG_LIMITS, type CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { executeJiraDirectoryRead, isJiraDirectoryRead } from "./jira-managed-directory-reads.js";

const USER = { key: "JIRAUSER10100", name: "Synthetic-User", displayName: "Synthetic User", active: false };
const ROLE = {
  key: "jira-software",
  name: "Jira Software",
  groups: ["Developers"],
  defaultGroups: [],
  defined: true,
  hasUnlimitedSeats: true,
  platform: false,
  selectedByDefault: false,
  numberOfSeats: -1,
  remainingSeats: -7,
  userCount: 12,
  userCountDescription: "12 members",
};
function object(body: Record<string, unknown>): ReturnType<typeof vi.fn<JiraMutationRequest>> {
  return vi.fn<JiraMutationRequest>().mockResolvedValue({ ok: true, status: 200, body });
}
function array(items: readonly unknown[]): ReturnType<typeof vi.fn<JiraMutationRequest>> {
  return vi.fn<JiraMutationRequest>().mockResolvedValue({ ok: true, status: 200, body: undefined, items });
}
describe("closed group and application-role reads", () => {
  it("requests the exact native group and offset without following a native nextPage URL", async () => {
    const request = object({ startAt: 2, maxResults: 1, isLast: false, total: 5, values: [{ ...USER, emailAddress: "synthetic@example.invalid", self: "https://untrusted.invalid/user" }], nextPage: "https://untrusted.invalid/next" });
    const result = await executeJiraDirectoryRead("jira.group-members", { groupName: "R&D team", startAt: 2, maxResults: 1, includeInactiveUsers: true }, request);
    expect(request).toHaveBeenCalledExactlyOnceWith("group/member?maxResults=1&groupname=R%26D+team&startAt=2&includeInactiveUsers=true", "GET", undefined, "json");
    expect(result.data).toEqual({ outcome: "succeeded", groupName: "R&D team", items: [USER], startAt: 2, total: 5, nextStartAt: 3 });
  });
  it("preserves an unknown group total and observed empty last page", async () => {
    const result = await executeJiraDirectoryRead("jira.group-members", { groupName: "Empty" }, object({ startAt: 0, maxResults: 25, isLast: true, values: [] }));
    expect(result.data).toEqual({ outcome: "succeeded", groupName: "Empty", items: [], startAt: 0 });
  });
  it.each([
    { groupName: "" },
    { groupName: "Group", maxResults: 51 },
    { groupName: "Group", startAt: -1 },
    { groupName: "Group", includeInactiveUsers: "true" },
    { groupName: "Group", nextPage: "https://untrusted.invalid" },
  ] as readonly CatalogJsonObject[])("refuses an invalid or undeclared group query: %j", async (args) => {
    const request = object({});
    expect((await executeJiraDirectoryRead("jira.group-members", args, request)).data.reason).toBe("invalid-input");
    expect(request).not.toHaveBeenCalled();
  });
  it.each([
    { startAt: 1 },
    { total: 0 },
    { isLast: true, total: 2 },
    { values: [USER, USER] },
    { values: [{ ...USER, key: null }] },
    { isLast: false, values: [] },
  ])("refuses inconsistent native group membership pages: %j", async (changed) => {
    const result = await executeJiraDirectoryRead("jira.group-members", { groupName: "Group" }, object({ startAt: 0, maxResults: 25, isLast: true, total: 1, values: [USER], ...changed }));
    expect(result.data.reason).toBe("malformed-payload");
  });
  it("projects native group suggestions without HTML, labels or invented offsets", async () => {
    const request = object({ groups: [{ name: "Developers", html: "<b>De</b>velopers", labels: [{ title: "privileged" }] }], header: "matching", total: 9 });
    const result = await executeJiraDirectoryRead("jira.groups", { query: "Dev", maxResults: 2 }, request);
    expect(request).toHaveBeenCalledExactlyOnceWith("groups/picker?maxResults=2&query=Dev", "GET", undefined, "json");
    expect(result.data).toEqual({ outcome: "succeeded", items: [{ name: "Developers" }], total: 9 });
  });
  it("keeps an omitted group-picker total unknown", async () => {
    expect((await executeJiraDirectoryRead("jira.groups", {}, object({ groups: [] }))).data).toEqual({ outcome: "succeeded", items: [] });
  });
  it.each([
    { groups: [{ name: "Same" }, { name: "Same" }] },
    { groups: [{ name: "Group" }], total: 0 },
    { groups: [{ name: "" }] },
    { groups: null },
  ])("refuses invalid group-picker data: %j", async (body) => {
    expect((await executeJiraDirectoryRead("jira.groups", {}, object(body))).data.reason).toBe("malformed-payload");
  });
  it("retains signed native seat metrics and explicitly observed booleans", async () => {
    const request = object({ ...ROLE, self: "https://untrusted.invalid/role" });
    expect((await executeJiraDirectoryRead("jira.application-role", { applicationRoleKey: ROLE.key }, request)).data).toEqual({ outcome: "succeeded", ...ROLE });
    expect(request).toHaveBeenCalledExactlyOnceWith("applicationrole/jira-software", "GET", undefined, "json");
  });
  it("keeps unprovided role fields unknown while retaining explicit empty groups", async () => {
    const result = await executeJiraDirectoryRead("jira.application-role", { applicationRoleKey: ROLE.key }, object({ key: ROLE.key, groups: [], defaultGroups: null, name: null, defined: null, remainingSeats: null }));
    expect(result.data).toEqual({ outcome: "succeeded", key: ROLE.key, groups: [] });
  });
  it("pages the complete native application-role array locally", async () => {
    const request = array([{ key: "jira-core" }, ROLE]);
    const result = await executeJiraDirectoryRead("jira.application-roles", { startAt: 1, maxResults: 1 }, request);
    expect(request).toHaveBeenCalledExactlyOnceWith("applicationrole", "GET", undefined, "json-array");
    expect(result.data).toEqual({ outcome: "succeeded", items: [ROLE], startAt: 1, total: 2 });
  });
  it("does not accept a different single role identity", async () => {
    expect((await executeJiraDirectoryRead("jira.application-role", { applicationRoleKey: "jira-core" }, object(ROLE))).data.reason).toBe("malformed-payload");
  });
  it.each([
    { numberOfSeats: 2147483648 },
    { remainingSeats: -2147483649 },
    { userCount: 0.5 },
    { platform: "false" },
    { groups: ["Same", "Same"] },
    { defaultGroups: [7] },
    { key: "../role" },
  ])("refuses malformed role values without defaulting them: %j", async (changed) => {
    expect((await executeJiraDirectoryRead("jira.application-role", { applicationRoleKey: ROLE.key }, object({ ...ROLE, ...changed }))).data.reason).toBe("malformed-payload");
  });
  it("refuses duplicate role identities and a collection beyond the existing catalog bound", async () => {
    expect((await executeJiraDirectoryRead("jira.application-roles", {}, array([ROLE, ROLE]))).data.reason).toBe("malformed-payload");
    const values = Array.from({ length: TOOL_CATALOG_LIMITS.maxArrayItems + 1 }, (_, index) => ({ key: `role-${index}` }));
    expect((await executeJiraDirectoryRead("jira.application-roles", {}, array(values))).data.reason).toBe("bounds-exceeded");
  });
  it.each([
    ["jira.application-role", { applicationRoleKey: ".." }],
    ["jira.application-role", { applicationRoleKey: "https://untrusted.invalid" }],
    ["jira.application-roles", { expand: "users" }],
    ["jira.groups", { startAt: 1 }],
    ["jira.groups", { userName: "not-declared" }],
  ] as const)("rejects an unsupported selector for %s", async (name, args) => {
    const request = object({});
    expect((await executeJiraDirectoryRead(name, args, request)).data.reason).toBe("invalid-input");
    expect(request).not.toHaveBeenCalled();
  });
  it("preserves permission failure and performs no alternate read", async () => {
    const request = vi.fn<JiraMutationRequest>().mockResolvedValue({ ok: false, reason: "permission-denied", httpStatus: 403 });
    expect((await executeJiraDirectoryRead("jira.application-roles", {}, request)).data).toEqual({ outcome: "failed", reason: "permission-denied" });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("recognizes only its four closed read operations", () => {
    expect(isJiraDirectoryRead("jira.groups")).toBe(true);
    expect(isJiraDirectoryRead("jira.create-group")).toBe(false);
    expect(isJiraDirectoryRead("jira.user")).toBe(false);
  });
});
