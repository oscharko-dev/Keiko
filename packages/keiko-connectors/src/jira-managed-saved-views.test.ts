import { describe, expect, it, vi } from "vitest";
import type { AtlassianWriteHttpOutcome } from "./atlassian-write-http.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { executeJiraSavedViewRead, isJiraSavedViewRead } from "./jira-managed-saved-views.js";

const DASHBOARD = {
  id: "9007199254740993",
  name: "Delivery overview",
  self: "https://untrusted.invalid/rest/dashboard",
  view: "https://untrusted.invalid/dashboard",
};
const PERMISSION = {
  id: 91,
  type: "group",
  group: { name: "Delivery group", self: "https://untrusted.invalid/group" },
  edit: false,
  view: true,
};
function requestFor(body: Record<string, unknown>): ReturnType<typeof vi.fn<JiraMutationRequest>> {
  return vi.fn<JiraMutationRequest>().mockResolvedValue({ ok: true, status: 200, body });
}
function permissions(items: readonly unknown[]): ReturnType<typeof vi.fn<JiraMutationRequest>> {
  return vi
    .fn<JiraMutationRequest>()
    .mockResolvedValue({ ok: true, status: 200, items, body: undefined });
}
describe("native saved-view reads", () => {
  it("returns a bound dashboard identity without trusting native navigation URLs", async () => {
    const request = requestFor(DASHBOARD);
    expect(
      (await executeJiraSavedViewRead("jira.dashboard", { dashboardId: DASHBOARD.id }, request))
        .data,
    ).toEqual({ outcome: "succeeded", items: [{ id: DASHBOARD.id, name: DASHBOARD.name }] });
    expect(request).toHaveBeenCalledExactlyOnceWith(
      `dashboard/${DASHBOARD.id}`,
      "GET",
      undefined,
      "json",
    );
  });
  it("reads two bounded dashboard pages using numeric continuation instead of remote next URLs", async () => {
    const request = vi.fn<JiraMutationRequest>((path) =>
      Promise.resolve({
        ok: true,
        status: 200,
        body: {
          dashboards: [{ ...DASHBOARD, id: path.includes("startAt=0") ? "11" : "12" }],
          startAt: path.includes("startAt=0") ? 0 : 1,
          maxResults: 1,
          total: 2,
          next: "https://untrusted.invalid/redirect",
          prev: "https://untrusted.invalid/previous",
        },
      }),
    );
    const first = await executeJiraSavedViewRead("jira.dashboards", { maxResults: 1 }, request);
    expect(first.data).toMatchObject({
      startAt: 0,
      total: 2,
      nextStartAt: 1,
      items: [{ id: "11" }],
    });
    const second = await executeJiraSavedViewRead(
      "jira.dashboards",
      { startAt: 1, maxResults: 1 },
      request,
    );
    expect(second.data).toEqual({
      outcome: "succeeded",
      startAt: 1,
      total: 2,
      items: [{ id: "12", name: DASHBOARD.name }],
    });
    expect(request.mock.calls.map(([path]) => path)).toEqual([
      "dashboard?startAt=0&maxResults=1",
      "dashboard?startAt=1&maxResults=1",
    ]);
  });
  it.each([
    { dashboards: [], startAt: 0, maxResults: 25 },
    { dashboards: [], startAt: 0, maxResults: 25, total: 2 },
    { dashboards: [DASHBOARD], startAt: 1, maxResults: 25, total: 2 },
    { dashboards: [DASHBOARD], startAt: 0, maxResults: 101, total: 1 },
    { dashboards: [DASHBOARD, DASHBOARD], startAt: 0, maxResults: 25, total: 2 },
  ])("refuses missing, inconsistent or duplicate dashboard page evidence", async (body) => {
    expect(
      (await executeJiraSavedViewRead("jira.dashboards", {}, requestFor(body))).data.reason,
    ).toBe("malformed-payload");
  });
  it.each(["GLOBAL", "AUTHENTICATED", "PRIVATE"])(
    "reads the observed %s default without changing it or asserting a filter is private",
    async (scope) => {
      const request = requestFor({ scope });
      expect((await executeJiraSavedViewRead("jira.filter-share-scope", {}, request)).data).toEqual(
        { outcome: "succeeded", scope },
      );
      expect(request).toHaveBeenCalledExactlyOnceWith(
        "filter/defaultShareScope",
        "GET",
        undefined,
        "json",
      );
    },
  );
  it("refuses an unrecognized default sharing scope", async () => {
    expect(
      (
        await executeJiraSavedViewRead(
          "jira.filter-share-scope",
          {},
          requestFor({ scope: "UNKNOWN" }),
        )
      ).data.reason,
    ).toBe("malformed-payload");
  });
  it("projects configured share entries without inferring effective rights or exposing upstream URLs and email", async () => {
    const request = permissions([
      PERMISSION,
      {
        id: 92,
        type: "project",
        project: { id: "10000", key: "SYN" },
        role: { id: 5, name: "Developers" },
        user: {
          name: "owner",
          displayName: "Permission owner",
          emailAddress: "private@example.invalid",
        },
      },
    ]);
    const result = await executeJiraSavedViewRead(
      "jira.filter-permissions",
      { filterId: "700", maxResults: 1 },
      request,
    );
    expect(result.data).toEqual({
      outcome: "succeeded",
      filterId: "700",
      startAt: 0,
      total: 2,
      nextStartAt: 1,
      items: [{ id: "91", type: "group", groupName: "Delivery group", edit: false, view: true }],
    });
    const second = await executeJiraSavedViewRead(
      "jira.filter-permissions",
      { filterId: "700", startAt: 1, maxResults: 1 },
      request,
    );
    expect(second.data.items).toEqual([
      {
        id: "92",
        type: "project",
        projectId: "10000",
        projectKey: "SYN",
        roleId: "5",
        roleName: "Developers",
        userName: "owner",
        userDisplayName: "Permission owner",
      },
    ]);
    expect(request.mock.calls).toEqual(
      Array.from({ length: 2 }, () => ["filter/700/permission", "GET", undefined, "json-array"]),
    );
  });
  it("keeps an unknown future permission type readable without classifying it as private", async () => {
    const result = await executeJiraSavedViewRead(
      "jira.filter-permission",
      { filterId: "700", permissionId: "91" },
      requestFor({ id: 91, type: "future-share" }),
    );
    expect(result.data).toEqual({
      outcome: "succeeded",
      filterId: "700",
      items: [{ id: "91", type: "future-share" }],
    });
  });
  it.each([
    { ...PERMISSION, id: Number.MAX_SAFE_INTEGER + 1 },
    { ...PERMISSION, id: 0 },
    { ...PERMISSION, edit: "false" },
    { ...PERMISSION, role: { id: Number.MAX_SAFE_INTEGER + 1 } },
    { ...PERMISSION, group: "hidden" },
    { ...PERMISSION, group: { name: 7 } },
  ])("refuses lossy IDs or malformed share metadata", async (item) => {
    expect(
      (
        await executeJiraSavedViewRead(
          "jira.filter-permissions",
          { filterId: "700" },
          permissions([item]),
        )
      ).data.reason,
    ).toBe("malformed-payload");
  });
  it("preserves exact string permission IDs beyond JavaScript's safe numeric range", async () => {
    const id = "9223372036854775807";
    expect(
      (
        await executeJiraSavedViewRead(
          "jira.filter-permission",
          { filterId: "700", permissionId: id },
          requestFor({ ...PERMISSION, id }),
        )
      ).data.items,
    ).toEqual([{ id, type: "group", groupName: "Delivery group", edit: false, view: true }]);
  });
  it.each(["jira.dashboard", "jira.filter-permission"] as const)(
    "refuses a different single-resource identity for %s",
    async (operation) => {
      const args =
        operation === "jira.dashboard"
          ? { dashboardId: "22" }
          : { filterId: "700", permissionId: "22" };
      const request = requestFor(operation === "jira.dashboard" ? DASHBOARD : PERMISSION);
      expect((await executeJiraSavedViewRead(operation, args, request)).data.reason).toBe(
        "malformed-payload",
      );
    },
  );
  it("refuses oversized unpaged native permission collections without silently truncating", async () => {
    expect(
      (
        await executeJiraSavedViewRead(
          "jira.filter-permissions",
          { filterId: "700" },
          permissions(Array.from({ length: 1001 }, () => PERMISSION)),
        )
      ).data.reason,
    ).toBe("bounds-exceeded");
  });
  it.each([
    ["jira.dashboards", { startAt: null }],
    ["jira.dashboards", { maxResults: 101 }],
    ["jira.dashboards", { filter: "private" }],
    ["jira.dashboard", { dashboardId: "../1" }],
    ["jira.filter-share-scope", { scope: "PRIVATE" }],
    ["jira.filter-permissions", { filterId: "1", self: "https://untrusted.invalid" }],
    ["jira.filter-permission", { filterId: "1", permissionId: "0" }],
  ] as const)("rejects unsupported %s inputs before transport", async (operation, args) => {
    const request = requestFor({});
    expect((await executeJiraSavedViewRead(operation, args, request)).data.reason).toBe(
      "invalid-input",
    );
    expect(request).not.toHaveBeenCalled();
  });
  it("retains a native read refusal rather than returning an empty success", async () => {
    const failure: AtlassianWriteHttpOutcome = {
      ok: false,
      reason: "permission-denied",
      httpStatus: 403,
    };
    const request = vi.fn<JiraMutationRequest>().mockResolvedValue(failure);
    expect(
      (await executeJiraSavedViewRead("jira.dashboard", { dashboardId: "11" }, request)).data,
    ).toEqual({ outcome: "failed", reason: "permission-denied" });
  });
  it("admits only the selected fixed read operations", () => {
    expect(isJiraSavedViewRead("jira.dashboards")).toBe(true);
    expect(isJiraSavedViewRead("jira.create-filter")).toBe(false);
    expect(isJiraSavedViewRead("jira.filter-properties")).toBe(false);
  });
});
