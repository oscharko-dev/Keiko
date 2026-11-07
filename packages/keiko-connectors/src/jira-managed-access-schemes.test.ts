import { describe, expect, it, vi } from "vitest";
import { TOOL_CATALOG_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import {
  executeJiraAccessSchemeRead,
  isJiraAccessSchemeRead,
} from "./jira-managed-access-schemes.js";

const GRANT = {
  id: 19,
  permission: "BROWSE_PROJECTS",
  holder: { type: "group", parameter: "Developers" },
};
const PERMISSION = {
  id: 7,
  name: "Engineering",
  description: "Reviewed configuration",
  permissions: [GRANT],
};
const LEVEL = { id: "11", name: "Internal", description: "Selected visibility" };
const SECURITY = {
  id: 8,
  name: "Issue visibility",
  levels: [LEVEL],
  defaultSecurityLevelId: 11,
};
function requestFor(body: Record<string, unknown>): ReturnType<typeof vi.fn<JiraMutationRequest>> {
  return vi.fn<JiraMutationRequest>().mockResolvedValue({ ok: true, status: 200, body });
}

describe("closed permission and issue-security configuration reads", () => {
  it.each([
    ["jira.permission-schemes", {}, "permissionscheme", { permissionSchemes: [PERMISSION] }],
    ["jira.permission-scheme", { schemeId: "7" }, "permissionscheme/7", PERMISSION],
    ["jira.permission-grants", { schemeId: "7" }, "permissionscheme/7/permission", { permissions: [GRANT] }],
    ["jira.permission-grant", { schemeId: "7", permissionId: "19" }, "permissionscheme/7/permission/19", GRANT],
    ["jira.issue-security-schemes", {}, "issuesecurityschemes", { issueSecuritySchemes: [SECURITY] }],
    ["jira.issue-security-scheme", { schemeId: "8" }, "issuesecurityschemes/8", SECURITY],
    ["jira.security-level", { levelId: "11" }, "securitylevel/11", LEVEL],
  ] as const)("uses the fixed native object route for %s", async (name, args, path, body) => {
    const request = requestFor(body);
    expect((await executeJiraAccessSchemeRead(name, args, request)).data.outcome).toBe("succeeded");
    expect(request).toHaveBeenCalledExactlyOnceWith(path, "GET", undefined, "json");
  });
  it.each([
    ["jira.permission-schemes", { includePermissions: true }, "permissionscheme?expand=permissions", { permissionSchemes: [] }],
    ["jira.permission-scheme", { schemeId: "7", includePermissions: true }, "permissionscheme/7?expand=permissions", PERMISSION],
  ] as const)("uses only the declared permission expansion for %s", async (name, args, path, body) => {
    const request = requestFor(body);
    await executeJiraAccessSchemeRead(name, args, request);
    expect(request).toHaveBeenCalledExactlyOnceWith(path, "GET", undefined, "json");
  });
  it("pages the complete native scheme wrapper locally without remote offset parameters", async () => {
    const request = requestFor({ permissionSchemes: [PERMISSION, { id: 9, name: "Other" }] });
    const result = await executeJiraAccessSchemeRead("jira.permission-schemes", { startAt: 1, maxResults: 1 }, request);
    expect(request.mock.calls[0]?.[0]).toBe("permissionscheme");
    expect(result.data).toEqual({ outcome: "succeeded", items: [{ id: "9", name: "Other" }], startAt: 1, total: 2 });
  });
  it("keeps configured permission holders distinct from effective user access and drops expanded people/URLs", async () => {
    const request = requestFor({ ...GRANT, self: "https://untrusted.invalid/grant", holder: { ...GRANT.holder, user: { emailAddress: "synthetic@example.invalid" }, group: { self: "https://untrusted.invalid/group" }, projectRole: { actors: [{ displayName: "Ignored" }] } } });
    const result = await executeJiraAccessSchemeRead("jira.permission-grant", { schemeId: "7", permissionId: "19" }, request);
    expect(result.data).toEqual({ outcome: "succeeded", schemeId: "7", id: "19", permission: GRANT.permission, holder: GRANT.holder });
  });
  it("preserves an unparameterized holder without guessing its membership", async () => {
    const result = await executeJiraAccessSchemeRead("jira.permission-grant", { schemeId: "7", permissionId: "19" }, requestFor({ ...GRANT, holder: { type: "reporter", parameter: null } }));
    expect(result.data.holder).toEqual({ type: "reporter" });
  });
  it("preserves exact string IDs above the safe numeric limit", async () => {
    const id = "9007199254740993";
    const result = await executeJiraAccessSchemeRead("jira.issue-security-scheme", { schemeId: id }, requestFor({ ...SECURITY, id, defaultSecurityLevelId: id, levels: [{ ...LEVEL, id }] }));
    expect(result.data).toMatchObject({ id, defaultSecurityLevelId: id, levels: [{ id }] });
  });
  it("retains native default level and explicit empty levels without following self URLs", async () => {
    const result = await executeJiraAccessSchemeRead("jira.issue-security-scheme", { schemeId: "8" }, requestFor({ ...SECURITY, levels: [], self: "https://untrusted.invalid/scheme" }));
    expect(result.data).toEqual({ outcome: "succeeded", id: "8", name: SECURITY.name, defaultSecurityLevelId: "11", levels: [] });
  });
  it("keeps absent or null optional collections/defaults unknown", async () => {
    const security = await executeJiraAccessSchemeRead("jira.issue-security-scheme", { schemeId: "8" }, requestFor({ ...SECURITY, levels: null, defaultSecurityLevelId: null, description: null }));
    expect(security.data).toEqual({ outcome: "succeeded", id: "8", name: SECURITY.name });
    const permission = await executeJiraAccessSchemeRead("jira.permission-scheme", { schemeId: "7" }, requestFor({ id: 7, name: "Restricted", permissions: null }));
    expect(permission.data).toEqual({ outcome: "succeeded", id: "7", name: "Restricted" });
  });
  it("retains an empty native permission list instead of an unknown list", async () => {
    const result = await executeJiraAccessSchemeRead("jira.permission-scheme", { schemeId: "7" }, requestFor({ ...PERMISSION, permissions: [], description: "" }));
    expect(result.data).toEqual({ outcome: "succeeded", id: "7", name: PERMISSION.name, description: "", permissions: [] });
  });
  it.each([
    ["jira.permission-scheme", { schemeId: "7" }, { ...PERMISSION, id: 8 }],
    ["jira.permission-grant", { schemeId: "7", permissionId: "19" }, { ...GRANT, id: 20 }],
    ["jira.issue-security-scheme", { schemeId: "8" }, { ...SECURITY, id: 9 }],
    ["jira.security-level", { levelId: "11" }, { ...LEVEL, id: "12" }],
  ] as const)("refuses a mismatched bound identity for %s", async (name, args, body) => {
    expect((await executeJiraAccessSchemeRead(name, args, requestFor(body))).data.reason).toBe("malformed-payload");
  });
  it.each([
    { id: Number.MAX_SAFE_INTEGER + 1 },
    { id: "9223372036854775808" },
    { id: "07" },
    { name: "" },
    { permissions: [GRANT, GRANT] },
    { permissions: [{ ...GRANT, holder: {} }] },
    { permissions: [{ ...GRANT, permission: null }] },
    { permissions: {} },
  ])("refuses malformed scheme metadata: %j", async (changed) => {
    expect((await executeJiraAccessSchemeRead("jira.permission-scheme", { schemeId: "7" }, requestFor({ ...PERMISSION, ...changed }))).data.reason).toBe("malformed-payload");
  });
  it.each([
    { levels: [LEVEL, LEVEL] },
    { levels: [{ ...LEVEL, id: "0" }] },
    { defaultSecurityLevelId: 0 },
    { defaultSecurityLevelId: Number.MAX_SAFE_INTEGER + 1 },
    { levels: {} },
  ])("refuses malformed security references: %j", async (changed) => {
    expect((await executeJiraAccessSchemeRead("jira.issue-security-scheme", { schemeId: "8" }, requestFor({ ...SECURITY, ...changed }))).data.reason).toBe("malformed-payload");
  });
  it.each([
    ["jira.permission-schemes", { expand: "user" }],
    ["jira.permission-scheme", { schemeId: "7", includePermissions: null }],
    ["jira.permission-grants", { schemeId: "7", includePermissions: true }],
    ["jira.permission-grant", { schemeId: "7", permissionId: 19 }],
    ["jira.issue-security-scheme", { schemeId: "../8" }],
    ["jira.security-level", { levelId: "0" }],
    ["jira.issue-security-schemes", { maxResults: 101 }],
  ] as const)("refuses an undeclared or invalid selector for %s", async (name, args) => {
    const request = requestFor({});
    expect((await executeJiraAccessSchemeRead(name, args, request)).data.reason).toBe("invalid-input");
    expect(request).not.toHaveBeenCalled();
  });
  it("refuses oversized complete lists instead of claiming a partial native total", async () => {
    const permissionSchemes = Array.from({ length: TOOL_CATALOG_LIMITS.maxArrayItems + 1 }, (_, index) => ({ id: index + 1, name: "Scheme" }));
    expect((await executeJiraAccessSchemeRead("jira.permission-schemes", {}, requestFor({ permissionSchemes }))).data.reason).toBe("bounds-exceeded");
  });
  it.each(["x".repeat(32769), "界".repeat(26000)])("reports description character/byte limits as bounds failures", async (description) => {
    expect((await executeJiraAccessSchemeRead("jira.permission-scheme", { schemeId: "7" }, requestFor({ ...PERMISSION, description }))).data.reason).toBe("bounds-exceeded");
    expect((await executeJiraAccessSchemeRead("jira.issue-security-scheme", { schemeId: "8" }, requestFor({ ...SECURITY, levels: [{ ...LEVEL, description }] }))).data.reason).toBe("bounds-exceeded");
  });
  it("refuses an oversized nested grant collection without a truncated configuration claim", async () => {
    const permissions = Array.from({ length: TOOL_CATALOG_LIMITS.maxArrayItems + 1 }, (_, index) => ({ ...GRANT, id: index + 1 }));
    expect((await executeJiraAccessSchemeRead("jira.permission-scheme", { schemeId: "7" }, requestFor({ ...PERMISSION, permissions }))).data.reason).toBe("bounds-exceeded");
  });
  it("keeps a missing native collection distinct from an observed empty collection", async () => {
    expect((await executeJiraAccessSchemeRead("jira.permission-grants", { schemeId: "7" }, requestFor({}))).data.reason).toBe("malformed-payload");
    expect((await executeJiraAccessSchemeRead("jira.permission-grants", { schemeId: "7" }, requestFor({ permissions: [] }))).data).toEqual({ outcome: "succeeded", schemeId: "7", items: [], startAt: 0, total: 0 });
  });
  it("preserves native administrator refusal without retrying another resource", async () => {
    const request = vi.fn<JiraMutationRequest>().mockResolvedValue({ ok: false, reason: "permission-denied", httpStatus: 403 });
    expect((await executeJiraAccessSchemeRead("jira.issue-security-schemes", {}, request)).data).toEqual({ outcome: "failed", reason: "permission-denied" });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("recognizes only its seven configured reads", () => {
    expect(isJiraAccessSchemeRead("jira.permission-grants")).toBe(true);
    expect(isJiraAccessSchemeRead("jira.create-permission-scheme")).toBe(false);
  });
});
