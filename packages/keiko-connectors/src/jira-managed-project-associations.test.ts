import { describe, expect, it, vi } from "vitest";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import {
  executeJiraProjectAssociationRead,
  isJiraProjectAssociationRead,
} from "./jira-managed-project-associations.js";

const PROJECT = { id: "10001", key: "SYN", name: "Synthetic project" };
const PERMISSION = { id: 7, name: "Permissions", permissions: [{ id: 3, permission: "BROWSE_PROJECTS", holder: { type: "group", parameter: "Developers" } }] };
const SECURITY = { id: 8, name: "Visibility", levels: [{ id: "11", name: "Internal" }], defaultSecurityLevelId: 11 };
const WORKFLOW = { id: 9, name: "Workflow", draft: false, defaultWorkflow: "Default", issueTypeMappings: { "1": "Task workflow", "2": "Bug workflow" } };
const PRIORITY = { id: 10, name: "Priority", defaultScheme: false, defaultOptionId: "2", optionIds: ["1", "2"] };
function requestFor(
  body: Record<string, unknown>,
  project: Record<string, unknown> = PROJECT,
): ReturnType<typeof vi.fn<JiraMutationRequest>> {
  return vi.fn<JiraMutationRequest>()
    .mockResolvedValueOnce({ ok: true, status: 200, body: project })
    .mockResolvedValue({ ok: true, status: 200, body });
}
describe("canonical project configuration associations", () => {
  it.each([
    ["jira.project-permission-scheme", "permissionscheme", PERMISSION],
    ["jira.project-issue-security-scheme", "issuesecuritylevelscheme", SECURITY],
    ["jira.project-security-levels", "securitylevel", { levels: SECURITY.levels }],
    ["jira.project-workflow-scheme", "workflowscheme", WORKFLOW],
    ["jira.project-priority-scheme", "priorityscheme", PRIORITY],
  ] as const)("reads %s through the independently bound numeric project", async (name, suffix, body) => {
    const request = requestFor(body);
    expect((await executeJiraProjectAssociationRead(name, { projectIdOrKey: "SYN" }, request)).data).toMatchObject({ outcome: "succeeded", projectId: PROJECT.id, projectKey: PROJECT.key });
    expect(request.mock.calls).toEqual([
      ["project/SYN"],
      [`project/${PROJECT.id}/${suffix}`, "GET", undefined, "json"],
    ]);
  });
  it.each(["syn", "10001"])("preserves canonical context for selector %s", async (projectIdOrKey) => {
    const result = await executeJiraProjectAssociationRead("jira.project-permission-scheme", { projectIdOrKey }, requestFor(PERMISSION));
    expect(result.data).toMatchObject({ projectId: PROJECT.id, projectKey: "SYN", id: "7" });
  });
  it("refuses a project mismatch before reading any association", async () => {
    const request = requestFor(PERMISSION, { ...PROJECT, id: "10002", key: "OTHER" });
    expect((await executeJiraProjectAssociationRead("jira.project-permission-scheme", { projectIdOrKey: "SYN" }, request)).data.reason).toBe("conflict");
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("retains observed permission configuration without expanded users or remote links", async () => {
    const result = await executeJiraProjectAssociationRead("jira.project-permission-scheme", { projectIdOrKey: "SYN" }, requestFor({ ...PERMISSION, self: "https://untrusted.invalid/scheme" }));
    expect(result.data).toEqual({ outcome: "succeeded", projectId: PROJECT.id, projectKey: PROJECT.key, id: "7", name: PERMISSION.name, permissions: [{ ...PERMISSION.permissions[0], id: "3" }] });
  });
  it("keeps optional security collections/defaults unknown when absent", async () => {
    const result = await executeJiraProjectAssociationRead("jira.project-issue-security-scheme", { projectIdOrKey: "SYN" }, requestFor({ id: 8, name: SECURITY.name }));
    expect(result.data).toEqual({ outcome: "succeeded", projectId: PROJECT.id, projectKey: PROJECT.key, id: "8", name: SECURITY.name });
  });
  it("labels an empty security-level response as accessible scope rather than no configured levels", async () => {
    const result = await executeJiraProjectAssociationRead("jira.project-security-levels", { projectIdOrKey: "SYN" }, requestFor({ levels: [] }));
    expect(result.data).toEqual({ outcome: "succeeded", projectId: PROJECT.id, projectKey: PROJECT.key, levelsScope: "accessible", items: [], startAt: 0, total: 0 });
  });
  it("locally pages only the native accessible security-level list", async () => {
    const request = requestFor({ levels: [...SECURITY.levels, { id: "12", name: "Other" }] });
    const result = await executeJiraProjectAssociationRead("jira.project-security-levels", { projectIdOrKey: "SYN", startAt: 1, maxResults: 1 }, request);
    expect(result.data).toMatchObject({ levelsScope: "accessible", items: [{ id: "12", name: "Other" }], startAt: 1, total: 2 });
    expect(request.mock.calls[1]?.[0]).toBe(`project/${PROJECT.id}/securitylevel`);
  });
  it("reuses existing workflow mapping pagination and preserves native draft state", async () => {
    const request = requestFor(WORKFLOW);
    const result = await executeJiraProjectAssociationRead("jira.project-workflow-scheme", { projectIdOrKey: "SYN", maxResults: 1 }, request);
    expect(result.data).toMatchObject({ projectId: PROJECT.id, projectKey: PROJECT.key, id: "9", schemeId: "9", draft: false, items: [{ issueTypeId: "1", workflow: "Task workflow" }], startAt: 0, total: 2, nextStartAt: 1 });
    expect(request.mock.calls[1]?.[0]).toBe(`project/${PROJECT.id}/workflowscheme`);
  });
  it("refuses an associated draft instead of claiming it is the active workflow scheme", async () => {
    expect((await executeJiraProjectAssociationRead("jira.project-workflow-scheme", { projectIdOrKey: "SYN" }, requestFor({ ...WORKFLOW, draft: true }))).data.reason).toBe("malformed-payload");
  });
  it("preserves original-only mappings without inventing a current workflow", async () => {
    const result = await executeJiraProjectAssociationRead("jira.project-workflow-scheme", { projectIdOrKey: "SYN" }, requestFor({ id: 9, originalIssueTypeMappings: { "1": "Prior" } }));
    expect(result.data.items).toEqual([{ issueTypeId: "1", originalWorkflow: "Prior" }]);
  });
  it("keeps native priority flags/options separate from effective issue configuration", async () => {
    const result = await executeJiraProjectAssociationRead("jira.project-priority-scheme", { projectIdOrKey: "SYN" }, requestFor({ ...PRIORITY, projectKeys: ["OTHER"], self: "https://untrusted.invalid/priority" }));
    expect(result.data).toEqual({ outcome: "succeeded", projectId: PROJECT.id, projectKey: PROJECT.key, ...PRIORITY, id: "10" });
  });
  it("does not fabricate priority defaults or option lists", async () => {
    const result = await executeJiraProjectAssociationRead("jira.project-priority-scheme", { projectIdOrKey: "SYN" }, requestFor({ id: 10, name: PRIORITY.name, optionIds: null, defaultScheme: null, defaultOptionId: null }));
    expect(result.data).toEqual({ outcome: "succeeded", projectId: PROJECT.id, projectKey: PROJECT.key, id: "10", name: PRIORITY.name });
  });
  it.each([
    { defaultScheme: "false" },
    { defaultOptionId: 2 },
    { optionIds: ["1", "1"] },
    { optionIds: ["01"] },
    { id: Number.MAX_SAFE_INTEGER + 1 },
  ])("refuses malformed priority metadata: %j", async (changed) => {
    expect((await executeJiraProjectAssociationRead("jira.project-priority-scheme", { projectIdOrKey: "SYN" }, requestFor({ ...PRIORITY, ...changed }))).data.reason).toBe("malformed-payload");
  });
  it.each([
    { projectIdOrKey: "../SYN" },
    { projectIdOrKey: "SYN", expand: "all" },
    { projectIdOrKey: "SYN", includePermissions: true },
    { projectIdOrKey: "SYN", maxResults: 1 },
  ] as readonly CatalogJsonObject[])("refuses unsupported permission-association selectors before transport: %j", async (args) => {
    const request = requestFor(PERMISSION);
    expect((await executeJiraProjectAssociationRead("jira.project-permission-scheme", args, request)).data.reason).toBe("invalid-input");
    expect(request).not.toHaveBeenCalled();
  });
  it("preserves native permission refusal without substituting a global scheme", async () => {
    const request = vi.fn<JiraMutationRequest>()
      .mockResolvedValueOnce({ ok: true, status: 200, body: PROJECT })
      .mockResolvedValue({ ok: false, reason: "permission-denied", httpStatus: 403 });
    expect((await executeJiraProjectAssociationRead("jira.project-workflow-scheme", { projectIdOrKey: "SYN" }, request)).data).toEqual({ outcome: "failed", reason: "permission-denied" });
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("recognizes only five closed project association reads", () => {
    expect(isJiraProjectAssociationRead("jira.project-priority-scheme")).toBe(true);
    expect(isJiraProjectAssociationRead("jira.project-notification-scheme")).toBe(false);
    expect(isJiraProjectAssociationRead("jira.assign-permission-scheme")).toBe(false);
  });
});
