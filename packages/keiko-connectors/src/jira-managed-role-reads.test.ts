import { describe, expect, it, vi } from "vitest";
import { TOOL_CATALOG_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { executeJiraRoleRead, isJiraRoleRead } from "./jira-managed-role-reads.js";

const ROLE = { id: 10360, name: "Developers", description: "Project contributors" };
const ACTOR = {
  id: 10240,
  name: "jira-developers",
  displayName: "Developers",
  type: "atlassian-group-role-actor",
};
const PROJECT = { id: "10001", key: "SYN", name: "Synthetic project" };
function requestFor(body: Record<string, unknown>): ReturnType<typeof vi.fn<JiraMutationRequest>> {
  return vi.fn<JiraMutationRequest>().mockResolvedValue({ ok: true, status: 200, body });
}
describe("native role configuration and project membership", () => {
  it("locally pages the bounded global role list without sending remote page parameters", async () => {
    const request = vi.fn<JiraMutationRequest>().mockResolvedValue({
      ok: true,
      status: 200,
      body: undefined,
      items: [ROLE, { id: 10361, name: "Reviewers" }],
    });
    const result = await executeJiraRoleRead("jira.roles", { startAt: 1, maxResults: 1 }, request);
    expect(result.data).toEqual({
      outcome: "succeeded",
      items: [{ id: "10361", name: "Reviewers" }],
      startAt: 1,
      total: 2,
      actorsScope: "role-configuration",
    });
    expect(request).toHaveBeenCalledExactlyOnceWith("role", "GET", undefined, "json-array");
  });
  it("returns a bound global role with unknown actors omitted", async () => {
    const request = requestFor({ ...ROLE, actors: null, self: "https://untrusted.invalid/role" });
    const result = await executeJiraRoleRead("jira.role", { roleId: "10360" }, request);
    expect(result.data).toEqual({
      outcome: "succeeded",
      ...ROLE,
      id: "10360",
      actorsScope: "role-configuration",
      reviewSnapshot: { ...ROLE, id: "10360" },
    });
    expect(request).toHaveBeenCalledExactlyOnceWith("role/10360", "GET", undefined, "json");
  });
  it("labels default actors independently of actual project membership", async () => {
    const request = requestFor({ actors: [ACTOR] });
    const result = await executeJiraRoleRead(
      "jira.role-default-actors",
      { roleId: "10360" },
      request,
    );
    expect(result.data).toEqual({
      outcome: "succeeded",
      roleId: "10360",
      actorsScope: "role-defaults",
      items: [{ ...ACTOR, id: "10240" }],
      startAt: 0,
      total: 1,
    });
    expect(request).toHaveBeenCalledExactlyOnceWith("role/10360/actors", "GET", undefined, "json");
  });
  it.each([{}, { actors: null }])("preserves unknown default actors for %j", async (body) => {
    expect(
      (await executeJiraRoleRead("jira.role-default-actors", { roleId: "10360" }, requestFor(body)))
        .data,
    ).toEqual({ outcome: "succeeded", roleId: "10360", actorsScope: "role-defaults" });
  });
  it("retains a confirmed empty default actor list", async () => {
    expect(
      (
        await executeJiraRoleRead(
          "jira.role-default-actors",
          { roleId: "10360" },
          requestFor({ actors: [] }),
        )
      ).data,
    ).toEqual({
      outcome: "succeeded",
      roleId: "10360",
      actorsScope: "role-defaults",
      items: [],
      startAt: 0,
      total: 0,
    });
  });
  it("does not invent actor IDs or types from native names", async () => {
    const result = await executeJiraRoleRead(
      "jira.role-default-actors",
      { roleId: "10360" },
      requestFor({
        actors: [
          {
            name: "Contributor",
            avatarUrl: "https://untrusted.invalid/avatar",
            actorUser: { emailAddress: "unprojected@example.invalid" },
          },
        ],
      }),
    );
    expect(result.data.items).toEqual([{ name: "Contributor" }]);
  });
  it("retains distinct user and group actors with the same name", async () => {
    const result = await executeJiraRoleRead(
      "jira.role-default-actors",
      { roleId: "10360" },
      requestFor({ actors: [ACTOR, { ...ACTOR, id: 10241, type: "atlassian-user-role-actor" }] }),
    );
    expect(result.data.total).toBe(2);
  });
  it("retains exact int64 actor IDs beyond the safe numeric range", async () => {
    const result = await executeJiraRoleRead(
      "jira.role-default-actors",
      { roleId: "10360" },
      requestFor({ actors: [{ ...ACTOR, id: "9223372036854775807" }] }),
    );
    expect(result.data.items).toEqual([{ ...ACTOR, id: "9223372036854775807" }]);
  });
  it("keeps nullable optional actor facts absent across the shared optional-field projection", async () => {
    const result = await executeJiraRoleRead(
      "jira.role-default-actors",
      { roleId: "10360" },
      requestFor({ actors: [{ name: "Contributor", id: null, type: null, displayName: null }] }),
    );
    expect(result.data.items).toEqual([{ name: "Contributor" }]);
  });
  it.each(["type", "displayName"] as const)(
    "still refuses an explicitly empty actor %s",
    async (key) => {
      const result = await executeJiraRoleRead(
        "jira.role-default-actors",
        { roleId: "10360" },
        requestFor({ actors: [{ name: "Contributor", [key]: "" }] }),
      );
      expect(result.data.reason).toBe("malformed-payload");
    },
  );
  it("reads project role names without following or deriving IDs from remote URIs", async () => {
    const request = requestFor({
      Developers: "https://untrusted.invalid/other/role/999",
    }).mockResolvedValueOnce({ ok: true, status: 200, body: PROJECT });
    const result = await executeJiraRoleRead(
      "jira.project-roles",
      { projectIdOrKey: "syn" },
      request,
    );
    expect(result.data).toEqual({
      outcome: "succeeded",
      projectId: "10001",
      projectKey: "SYN",
      items: [{ name: "Developers" }],
      startAt: 0,
      total: 1,
    });
    expect(request.mock.calls).toEqual([
      ["project/syn"],
      ["project/10001/role", "GET", undefined, "json"],
    ]);
  });
  it("keeps exact role identity and canonical project context on project membership", async () => {
    const request = requestFor({ ...ROLE, actors: [ACTOR] }).mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: PROJECT,
    });
    const result = await executeJiraRoleRead(
      "jira.project-role",
      { projectIdOrKey: "10001", roleId: "10360" },
      request,
    );
    expect(result.data).toEqual({
      outcome: "succeeded",
      ...ROLE,
      id: "10360",
      actors: [{ ...ACTOR, id: "10240" }],
      projectId: "10001",
      projectKey: "SYN",
      actorsScope: "project-membership",
      reviewSnapshot: { ...ROLE, id: "10360" },
    });
    expect(request.mock.calls).toEqual([
      ["project/10001"],
      ["project/10001/role/10360", "GET", undefined, "json"],
    ]);
  });
  it("refuses mismatched project identity before reading role membership", async () => {
    const request = requestFor({ ...PROJECT, key: "OTHER", id: "10002" });
    expect(
      (
        await executeJiraRoleRead(
          "jira.project-role",
          { projectIdOrKey: "SYN", roleId: "10360" },
          request,
        )
      ).data.reason,
    ).toBe("conflict");
    expect(request).toHaveBeenCalledTimes(1);
  });
  it.each([null, "", "Observed description"])(
    "preserves explicit native review description %j separately from ordinary optional facts",
    async (description) => {
      const result = await executeJiraRoleRead(
        "jira.role",
        { roleId: "10360" },
        requestFor({ ...ROLE, description }),
      );
      expect(result.data.reviewSnapshot).toEqual({ id: "10360", name: "Developers", description });
      if (description === null) expect(result.data).not.toHaveProperty("description");
    },
  );
  it("does not manufacture a review snapshot when description is omitted", async () => {
    const result = await executeJiraRoleRead(
      "jira.role",
      { roleId: "10360" },
      requestFor({ id: 10360, name: "Developers", actors: [{ name: "unknown actor" }] }),
    );
    expect(result.data).not.toHaveProperty("reviewSnapshot");
    expect(result.data.actors).toEqual([{ name: "unknown actor" }]);
  });
  it("binds project review metadata to the existing canonical project and native role ID", async () => {
    const request = requestFor({ ...ROLE, description: null, actors: [] }).mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: PROJECT,
    });
    const result = await executeJiraRoleRead(
      "jira.project-role",
      { projectIdOrKey: "syn", roleId: "10360" },
      request,
    );
    expect(result.data).toMatchObject({
      projectId: "10001",
      projectKey: "SYN",
      actors: [],
      reviewSnapshot: { id: "10360", name: "Developers", description: null },
    });
  });
  it("refuses a different returned role ID", async () => {
    expect(
      (await executeJiraRoleRead("jira.role", { roleId: "10361" }, requestFor(ROLE))).data.reason,
    ).toBe("malformed-payload");
  });
  it.each([
    { actors: [ACTOR, ACTOR] },
    { actors: [{ ...ACTOR, id: Number.MAX_SAFE_INTEGER + 1 }] },
    { actors: [{ ...ACTOR, type: false }] },
    { actors: [{ displayName: "No native name" }] },
    { actors: "unreadable" },
  ])("refuses malformed default actor representation %j", async (body) => {
    expect(
      (await executeJiraRoleRead("jira.role-default-actors", { roleId: "10360" }, requestFor(body)))
        .data.reason,
    ).toBe("malformed-payload");
  });
  it("refuses oversized actor collections before returning a truncated membership claim", async () => {
    const actors = Array.from({ length: TOOL_CATALOG_LIMITS.maxArrayItems + 1 }, (_, index) => ({
      ...ACTOR,
      id: index + 1,
    }));
    expect(
      (
        await executeJiraRoleRead(
          "jira.role-default-actors",
          { roleId: "10360" },
          requestFor({ actors }),
        )
      ).data.reason,
    ).toBe("bounds-exceeded");
  });
  it("applies shared projected-description byte bounds", async () => {
    expect(
      (
        await executeJiraRoleRead(
          "jira.role",
          { roleId: "10360" },
          requestFor({ ...ROLE, description: "界".repeat(30000) }),
        )
      ).data.reason,
    ).toBe("bounds-exceeded");
  });
  it.each([
    ["jira.roles", { projectIdOrKey: "SYN" }],
    ["jira.role", { roleId: "01" }],
    ["jira.role", { roleId: "10360", maxResults: 1 }],
    ["jira.role-default-actors", { roleId: "10360", maxResults: 101 }],
    ["jira.project-roles", { projectIdOrKey: "../SYN" }],
    ["jira.project-role", { projectIdOrKey: "SYN", roleId: 10360 }],
    ["jira.project-role", { projectIdOrKey: "SYN" }],
    ["jira.project-role", { roleId: "10360" }],
    ["jira.role-default-actors", {}],
    ["jira.roles", { expand: "actors" }],
  ] as const)("refuses unsupported arguments at %s before dispatch", async (name, args) => {
    const request = requestFor({});
    expect((await executeJiraRoleRead(name, args, request)).data.reason).toBe("invalid-input");
    expect(request).not.toHaveBeenCalled();
  });
  it("preserves native permission refusal without project or global fallback", async () => {
    const request = vi
      .fn<JiraMutationRequest>()
      .mockResolvedValue({ ok: false, reason: "permission-denied", httpStatus: 403 });
    expect((await executeJiraRoleRead("jira.role", { roleId: "10360" }, request)).data.reason).toBe(
      "permission-denied",
    );
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("does not recognize role mutation or arbitrary-path names", () => {
    expect(isJiraRoleRead("jira.role-default-actors")).toBe(true);
    expect(isJiraRoleRead("jira.create-role")).toBe(false);
    expect(isJiraRoleRead("GET /rest/api/2/role")).toBe(false);
  });
});
