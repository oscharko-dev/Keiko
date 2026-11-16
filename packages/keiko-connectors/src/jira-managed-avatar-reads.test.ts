import { describe, expect, it, vi } from "vitest";
import { TOOL_CATALOG_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { executeJiraAvatarRead, isJiraAvatarRead } from "./jira-managed-avatar-reads.js";

const SYSTEM = {
  id: "10000",
  selected: true,
  owner: "",
  self: "https://untrusted.invalid/avatar",
  urls: { "48x48": "https://untrusted.invalid/image" },
};
const CUSTOM = {
  id: "9223372036854775807",
  selected: false,
  owner: "Avatar owner",
  imageUrl: "https://untrusted.invalid/custom-image",
};
function requestFor(body: Record<string, unknown>): ReturnType<typeof vi.fn<JiraMutationRequest>> {
  return vi.fn<JiraMutationRequest>().mockResolvedValue({ ok: true, status: 200, body });
}
describe("bounded native avatar metadata", () => {
  it.each([
    ["jira.system-avatars", { avatarType: "user" }, "avatar/user/system"],
    ["jira.system-avatars", { avatarType: "project" }, "avatar/project/system"],
    ["jira.system-avatars", { avatarType: "issuetype" }, "avatar/issuetype/system"],
    ["jira.project-avatars", { projectIdOrKey: "SYN" }, "project/SYN/avatars"],
    ["jira.user-avatars", {}, "user/avatars"],
    ["jira.user-avatars", { username: "User name+tag" }, "user/avatars?username=User+name%2Btag"],
    [
      "jira.avatars",
      { avatarType: "project", owningObjectId: "9007199254740993" },
      "universal_avatar/type/project/owner/9007199254740993",
    ],
    [
      "jira.avatars",
      { avatarType: "issuetype", owningObjectId: "10001" },
      "universal_avatar/type/issuetype/owner/10001",
    ],
  ] as const)("uses only the fixed %s metadata route", async (operation, args, path) => {
    const request = requestFor({ system: [SYSTEM], custom: [] });
    expect((await executeJiraAvatarRead(operation, args, request)).data).toEqual({
      outcome: "succeeded",
      items: [{ id: "10000", category: "system", selected: true }],
      startAt: 0,
      total: 1,
    });
    expect(request).toHaveBeenCalledExactlyOnceWith(path);
  });
  it("preserves native categories, exact IDs and explicit selection while dropping every image URL", async () => {
    const request = requestFor({ system: [SYSTEM], custom: [CUSTOM] });
    const result = await executeJiraAvatarRead(
      "jira.project-avatars",
      { projectIdOrKey: "SYN" },
      request,
    );
    expect(result.data.items).toEqual([
      { id: "10000", category: "system", selected: true },
      { id: CUSTOM.id, category: "custom", owner: "Avatar owner", selected: false },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/https|imageUrl|urls|self/u);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("pages the combined native list locally without remote cursor or additional image requests", async () => {
    const request = requestFor({ system: [SYSTEM], custom: [CUSTOM] });
    const first = await executeJiraAvatarRead(
      "jira.project-avatars",
      { projectIdOrKey: "SYN", maxResults: 1 },
      request,
    );
    expect(first.data).toMatchObject({
      startAt: 0,
      total: 2,
      nextStartAt: 1,
      items: [{ id: "10000" }],
    });
    const second = await executeJiraAvatarRead(
      "jira.project-avatars",
      { projectIdOrKey: "SYN", startAt: 1, maxResults: 1 },
      request,
    );
    expect(second.data).toEqual({
      outcome: "succeeded",
      startAt: 1,
      total: 2,
      items: [{ id: CUSTOM.id, category: "custom", owner: "Avatar owner", selected: false }],
    });
    expect(request.mock.calls).toEqual([["project/SYN/avatars"], ["project/SYN/avatars"]]);
  });
  it.each([undefined, null])(
    "does not manufacture false selection or ownership when omitted",
    async (selected) => {
      const request = requestFor({ system: [{ id: "10000", selected, owner: null }], custom: [] });
      expect((await executeJiraAvatarRead("jira.user-avatars", {}, request)).data.items).toEqual([
        { id: "10000", category: "system" },
      ]);
    },
  );
  it("accepts an exactly representable numeric native identity without changing its value", async () => {
    expect(
      (
        await executeJiraAvatarRead(
          "jira.system-avatars",
          { avatarType: "project" },
          requestFor({ system: [{ id: 10000 }] }),
        )
      ).data.items,
    ).toEqual([{ id: "10000", category: "system" }]);
  });
  it.each([
    { id: Number.MAX_SAFE_INTEGER + 1 },
    { id: "9223372036854775808" },
    { id: "0100" },
    { id: "10000", selected: "false" },
    { id: "10000", owner: 42 },
  ])(
    "refuses malformed identity or optional metadata instead of inventing a state",
    async (item) => {
      expect(
        (
          await executeJiraAvatarRead(
            "jira.system-avatars",
            { avatarType: "user" },
            requestFor({ system: [item] }),
          )
        ).data.reason,
      ).toBe("malformed-payload");
    },
  );
  it.each([
    {},
    { system: [SYSTEM] },
    { system: [], custom: null },
    { system: [SYSTEM], custom: [SYSTEM] },
    { system: [SYSTEM, SYSTEM], custom: [] },
  ])("refuses absent groups or duplicate identities for an owner collection", async (body) => {
    expect(
      (await executeJiraAvatarRead("jira.user-avatars", {}, requestFor(body))).data.reason,
    ).toBe("malformed-payload");
  });
  it("does not accept custom avatars from the system-only resource", async () => {
    expect(
      (
        await executeJiraAvatarRead(
          "jira.system-avatars",
          { avatarType: "project" },
          requestFor({ system: [], custom: [CUSTOM] }),
        )
      ).data.reason,
    ).toBe("malformed-payload");
  });
  it("bounds both groups before projecting or paging the native collection", async () => {
    const request = requestFor({
      system: Array.from({ length: TOOL_CATALOG_LIMITS.maxArrayItems }, () => SYSTEM),
      custom: [CUSTOM],
    });
    expect(
      (await executeJiraAvatarRead("jira.user-avatars", { maxResults: 1 }, request)).data.reason,
    ).toBe("bounds-exceeded");
  });
  it.each([
    ["jira.system-avatars", { avatarType: "plugin-custom" }],
    ["jira.avatars", { avatarType: "user", owningObjectId: "10000" }],
    ["jira.avatars", { avatarType: "project", owningObjectId: "../10000" }],
    ["jira.project-avatars", { projectIdOrKey: "../SYN" }],
    ["jira.user-avatars", { username: "" }],
    ["jira.user-avatars", { username: null }],
    ["jira.user-avatars", { username: "bad\nname" }],
    ["jira.user-avatars", { username: "a".repeat(256) }],
    ["jira.user-avatars", { startAt: -1 }],
    ["jira.user-avatars", { maxResults: 101 }],
    ["jira.user-avatars", { imageUrl: "https://untrusted.invalid" }],
  ] as const)(
    "rejects unbounded or unsupported %s arguments without dispatch",
    async (operation, args) => {
      const request = requestFor({});
      expect((await executeJiraAvatarRead(operation, args, request)).data.reason).toBe(
        "invalid-input",
      );
      expect(request).not.toHaveBeenCalled();
    },
  );
  it("retains remote permission refusal without returning an empty success", async () => {
    const request = vi
      .fn<JiraMutationRequest>()
      .mockResolvedValue({ ok: false, reason: "permission-denied", httpStatus: 403 });
    expect((await executeJiraAvatarRead("jira.user-avatars", {}, request)).data).toEqual({
      outcome: "failed",
      reason: "permission-denied",
    });
  });
  it("keeps the selection closed to the four metadata reads", () => {
    expect(isJiraAvatarRead("jira.avatars")).toBe(true);
    expect(isJiraAvatarRead("jira.avatar-image")).toBe(false);
    expect(isJiraAvatarRead("jira.upload-avatar")).toBe(false);
  });
});
