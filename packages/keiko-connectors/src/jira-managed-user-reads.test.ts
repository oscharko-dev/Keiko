import { describe, expect, it, vi } from "vitest";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { executeJiraUserRead, isJiraUserRead } from "./jira-managed-user-reads.js";

const USER = {
  key: "JIRAUSER10100",
  name: "Synthetic-User",
  displayName: "Synthetic User",
  active: false,
  emailAddress: "synthetic@example.invalid",
  self: "https://untrusted.invalid/user",
  avatarUrls: { small: "https://untrusted.invalid/image" },
  html: "<strong>untrusted</strong>",
};
const PROJECTED = { key: USER.key, name: USER.name, displayName: USER.displayName, active: false };
function object(body: Record<string, unknown>): ReturnType<typeof vi.fn<JiraMutationRequest>> {
  return vi.fn<JiraMutationRequest>().mockResolvedValue({ ok: true, status: 200, body });
}
function array(items: readonly unknown[]): ReturnType<typeof vi.fn<JiraMutationRequest>> {
  return vi
    .fn<JiraMutationRequest>()
    .mockResolvedValue({ ok: true, status: 200, body: undefined, items });
}

describe("closed Data Center user reads", () => {
  it("binds a username by native comparison without changing returned spelling", async () => {
    const request = object(USER);
    expect(await executeJiraUserRead("jira.user", { username: "synthetic-user" }, request)).toEqual(
      {
        data: { outcome: "succeeded", ...PROJECTED },
      },
    );
    expect(request).toHaveBeenCalledExactlyOnceWith(
      "user?username=synthetic-user",
      "GET",
      undefined,
      "json",
    );
  });
  it("binds an exact user key and preserves observed deleted status", async () => {
    const request = object({ ...USER, deleted: true });
    const result = await executeJiraUserRead(
      "jira.user",
      { userKey: USER.key, includeDeleted: true },
      request,
    );
    expect(result.data).toEqual({ outcome: "succeeded", ...PROJECTED, deleted: true });
    expect(request).toHaveBeenCalledExactlyOnceWith(
      `user?key=${USER.key}&includeDeleted=true`,
      "GET",
      undefined,
      "json",
    );
  });
  it.each([
    {},
    { username: USER.name, userKey: USER.key },
    { username: "" },
    { userKey: 7 },
    { userKey: USER.key, includeDeleted: null },
    { userKey: USER.key, expand: "groups" },
    { userKey: USER.key, url: "https://untrusted.invalid" },
  ] as readonly CatalogJsonObject[])(
    "rejects undeclared or ambiguous user selectors before transport: %j",
    async (args) => {
      const request = object(USER);
      expect((await executeJiraUserRead("jira.user", args, request)).data.reason).toBe(
        "invalid-input",
      );
      expect(request).not.toHaveBeenCalled();
    },
  );
  it.each([{ key: "other" }, { name: "other" }])(
    "refuses a mismatched bound user %j",
    async (changed) => {
      const args: CatalogJsonObject =
        "key" in changed ? { userKey: USER.key } : { username: USER.name };
      expect(
        (await executeJiraUserRead("jira.user", args, object({ ...USER, ...changed }))).data.reason,
      ).toBe("malformed-payload");
    },
  );
  it("retains unknown optional user properties without inferred flags", async () => {
    const result = await executeJiraUserRead(
      "jira.user",
      { userKey: USER.key },
      object({ key: USER.key, name: USER.name, active: null, deleted: null, displayName: null }),
    );
    expect(result.data).toEqual({ outcome: "succeeded", key: USER.key, name: USER.name });
  });
  it("uses native search offset within the documented first hundred without a fabricated total", async () => {
    const request = array([USER]);
    const result = await executeJiraUserRead(
      "jira.users",
      {
        query: "name & context",
        startAt: 2,
        maxResults: 1,
        includeActive: false,
        includeInactive: true,
      },
      request,
    );
    expect(request).toHaveBeenCalledExactlyOnceWith(
      "user/search?maxResults=1&username=name+%26+context&includeActive=false&includeInactive=true&startAt=2",
      "GET",
      undefined,
      "json-array",
    );
    expect(result.data).toEqual({
      outcome: "succeeded",
      items: [PROJECTED],
      startAt: 2,
      searchLimit: 100,
      nextStartAt: 3,
    });
  });
  it("stops search continuation at the documented window, not an invented complete-directory boundary", async () => {
    const result = await executeJiraUserRead(
      "jira.users",
      { startAt: 99, maxResults: 1 },
      array([USER]),
    );
    expect(result.data).toEqual({
      outcome: "succeeded",
      items: [PROJECTED],
      startAt: 99,
      searchLimit: 100,
    });
  });
  it.each([
    { startAt: 99, maxResults: 2 },
    { startAt: 100, maxResults: 1 },
    { startAt: null },
    { includeActive: "true" },
    { maxResults: 101 },
  ] as readonly CatalogJsonObject[])(
    "refuses an invalid native search window: %j",
    async (args) => {
      const request = array([USER]);
      expect((await executeJiraUserRead("jira.users", args, request)).data.reason).toBe(
        "invalid-input",
      );
      expect(request).not.toHaveBeenCalled();
    },
  );
  it("retains an exact transient int64 cursor and never follows native nextPage", async () => {
    const request = object({
      values: [USER],
      isLast: false,
      maxResults: 1,
      nextCursor: "9223372036854775807",
      nextPage: "https://untrusted.invalid/next",
      total: 42,
    });
    const result = await executeJiraUserRead(
      "jira.user-directory",
      { cursor: "9007199254740993", maxResults: 1 },
      request,
    );
    expect(request).toHaveBeenCalledExactlyOnceWith(
      "user/list?maxResults=1&cursor=9007199254740993",
      "GET",
      undefined,
      "json",
    );
    expect(result.data).toEqual({
      outcome: "succeeded",
      items: [PROJECTED],
      isLast: false,
      nextCursor: "9223372036854775807",
    });
  });
  it("starts a stream without a cursor and preserves an observed empty last page", async () => {
    const request = object({ values: [], isLast: true, maxResults: 25, nextCursor: null });
    expect((await executeJiraUserRead("jira.user-directory", {}, request)).data).toEqual({
      outcome: "succeeded",
      items: [],
      isLast: true,
    });
    expect(request.mock.calls[0]?.[0]).toBe("user/list?maxResults=25");
  });
  it.each([
    "01",
    "-0",
    "9223372036854775808",
    "-9223372036854775809",
    "https://untrusted.invalid",
    42,
    null,
  ])("refuses an inexact cursor %j", async (cursor) => {
    const request = object({});
    expect(
      (await executeJiraUserRead("jira.user-directory", { cursor }, request)).data.reason,
    ).toBe("invalid-input");
    expect(request).not.toHaveBeenCalled();
  });
  it.each([
    { isLast: false },
    { isLast: false, nextCursor: "7" },
    { isLast: true, nextCursor: 8 },
    { isLast: "true" },
    { isLast: false, nextCursor: "8", maxResults: 101 },
  ])("refuses malformed/non-progressing stream metadata: %j", async (changed) => {
    const request = object({ values: [USER], maxResults: 25, ...changed });
    expect(
      (await executeJiraUserRead("jira.user-directory", { cursor: "7" }, request)).data.reason,
    ).toBe("malformed-payload");
  });
  it("retains the entire largest declared directory page with its native cursor", async () => {
    const values = Array.from({ length: 100 }, (_, index) => ({
      key: `user-${index}${"界".repeat(240)}`,
      name: "界".repeat(255),
      displayName: "界".repeat(255),
    }));
    const result = await executeJiraUserRead(
      "jira.user-directory",
      { maxResults: 100 },
      object({ values, maxResults: 100, isLast: false, nextCursor: "101" }),
    );
    expect(result.data).toEqual({
      outcome: "succeeded",
      items: values,
      isLast: false,
      nextCursor: "101",
    });
  });
  it("uses the documented picker DTO without exposing HTML or inferring pagination", async () => {
    const request = object({ users: [USER], header: "<b>matched</b>", total: 7 });
    const result = await executeJiraUserRead(
      "jira.user-picker",
      { query: "Synthetic", maxResults: 1 },
      request,
    );
    expect(request).toHaveBeenCalledExactlyOnceWith(
      "user/picker?maxResults=1&query=Synthetic&showAvatar=false",
      "GET",
      undefined,
      "json",
    );
    expect(result.data).toEqual({ outcome: "succeeded", items: [PROJECTED], total: 7 });
  });
  it("keeps an omitted picker total unknown", async () => {
    expect((await executeJiraUserRead("jira.user-picker", {}, object({ users: [] }))).data).toEqual(
      { outcome: "succeeded", items: [] },
    );
  });
  it.each([
    { users: [USER, USER] },
    { users: [{ ...USER, active: "false" }] },
    { users: [{ ...USER, key: null }] },
    { users: [USER], total: 0 },
    { users: [USER], total: -1 },
  ])("refuses malformed picker data: %j", async (body) => {
    expect((await executeJiraUserRead("jira.user-picker", {}, object(body))).data.reason).toBe(
      "malformed-payload",
    );
  });
  it("retains native permission failures without user data or an alternate request", async () => {
    const request = vi
      .fn<JiraMutationRequest>()
      .mockResolvedValue({ ok: false, reason: "permission-denied", httpStatus: 403 });
    expect((await executeJiraUserRead("jira.user-directory", {}, request)).data).toEqual({
      outcome: "failed",
      reason: "permission-denied",
    });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("recognizes only its four closed read names", () => {
    expect(isJiraUserRead("jira.user-directory")).toBe(true);
    expect(isJiraUserRead("jira.create-user")).toBe(false);
    expect(isJiraUserRead("https://untrusted.invalid")).toBe(false);
  });
});
