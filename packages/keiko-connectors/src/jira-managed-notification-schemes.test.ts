import { expect, it, vi } from "vitest";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import {
  executeJiraNotificationSchemeRead as read,
  isJiraNotificationSchemeRead,
} from "./jira-managed-notification-schemes.js";
import { jiraNotificationScheme } from "./jira-notification-scheme-values.js";

const EXPAND = "expand=notificationSchemeEvents%2Cuser%2Cgroup%2CprojectRole%2Cfield";
const EVENT = { id: 1, name: "Issue created", description: "A new issue" };
const SCHEME = {
  id: 37,
  name: "Delivery",
  description: "Team notifications",
  self: "https://remote.invalid/never-follow",
  notificationSchemeEvents: [{ event: EVENT, notifications: [] }],
};
function response(body: Record<string, unknown>): Awaited<ReturnType<JiraMutationRequest>> {
  return { ok: true, status: 200, body };
}
function fixture(body: Record<string, unknown> = SCHEME): ReturnType<typeof vi.fn<JiraMutationRequest>> {
  return vi.fn<JiraMutationRequest>().mockResolvedValue(response(body));
}

it("requests only documented expansion tokens and preserves an explicitly empty recipient list", async () => {
  const request = fixture();
  expect((await read("jira.notification-scheme", { schemeId: "37", includeEvents: true }, request)).data)
    .toMatchObject({
      outcome: "succeeded", eventsRequested: true,
      items: [{ id: "37", name: "Delivery", eventsAvailable: true,
        events: [{ id: "1", name: "Issue created", notifications: [] }] }],
    });
  expect(request).toHaveBeenCalledExactlyOnceWith(`notificationscheme/37?${EXPAND}`);
});

it("does not present unexpanded events or recipients as a zero count", async () => {
  const result = await read("jira.notification-scheme", { schemeId: "37" }, fixture());
  expect(result.data).toMatchObject({ eventsRequested: false, items: [{ id: "37" }] });
  expect(JSON.stringify(result)).not.toContain("eventsAvailable");
  expect(JSON.stringify(result)).not.toContain("notifications");
});

it.each([undefined, null])("labels requested but unavailable event data without inventing an empty list: %s", async (events) => {
  const result = await read("jira.notification-scheme", { schemeId: "37", includeEvents: true },
    fixture({ ...SCHEME, notificationSchemeEvents: events }));
  expect(result.data).toMatchObject({ items: [{ id: "37", eventsAvailable: false }] });
  expect(JSON.stringify(result)).not.toContain('"events":[]');
});

it("retains event template identity and keeps a missing recipient list unknown", () => {
  expect(jiraNotificationScheme({ ...SCHEME, notificationSchemeEvents: [{
    event: { id: 2, name: "Custom", templateEvent: EVENT },
  }] }, true)).toMatchObject({
    events: [{ id: "2", templateEvents: [{ id: "1" }] }],
  });
  expect(JSON.stringify(jiraNotificationScheme({ ...SCHEME,
    notificationSchemeEvents: [{ event: EVENT }],
  }, true))).not.toContain("notifications");
});

it("flattens the bounded template chain in native order and refuses excess depth", () => {
  let chain: Record<string, unknown> = { id: 8, name: "Ancestor" };
  for (let id = 7; id >= 1; id -= 1) chain = { id, templateEvent: chain };
  expect(jiraNotificationScheme({ ...SCHEME,
    notificationSchemeEvents: [{ event: chain, notifications: [] }],
  }, true)).toMatchObject({ events: [{ id: "1", templateEvents: [
    { id: "2" }, { id: "3" }, { id: "4" }, { id: "5" },
    { id: "6" }, { id: "7" }, { id: "8" },
  ] }] });
  expect(jiraNotificationScheme({ ...SCHEME,
    notificationSchemeEvents: [{ event: { id: 9, templateEvent: chain }, notifications: [] }],
  }, true)).toBeUndefined();
});

it.each([
  "CurrentAssignee", "Reporter", "CurrentUser", "ProjectLead", "ComponentLead",
  "AllWatchers", "User", "Group", "EmailAddress", "UserCustomField",
  "GroupCustomField", "ProjectRole",
])("projects documented recipient type %s without interpreting it as a new execution capability", (notificationType) => {
  expect(jiraNotificationScheme({ ...SCHEME, notificationSchemeEvents: [{
    event: EVENT, notifications: [{ id: 91, notificationType, parameter: "native-value" }],
  }] }, true)).toMatchObject({ events: [{ notifications: [{ id: "91", notificationType }] }] });
});

it("whitelists recipient identity details without remote URLs, HTML or user-email leakage", () => {
  const result = jiraNotificationScheme({ ...SCHEME, notificationSchemeEvents: [{ event: EVENT,
    notifications: [
      { id: 1, notificationType: "User", user: { key: "user-key", name: "member", active: false,
        emailAddress: "private-user@example.invalid", self: "https://remote.invalid/user" } },
      { id: 2, notificationType: "ProjectRole", projectRole: { id: 7, name: "Developers",
        self: "https://remote.invalid/role", actors: [{ name: "unrequested actor" }] } },
      { id: 3, notificationType: "Group", group: { name: "delivery", self: "https://remote.invalid/group" } },
      { id: 4, notificationType: "EmailAddress", emailAddress: "recipient@example.invalid" },
      { id: 5, notificationType: "UserCustomField", field: { id: "customfield_10000", name: "Owner", html: "<script>bad</script>" } },
    ],
  }] }, true);
  expect(result).toMatchObject({ events: [{ notifications: [
    { id: "1", user: { key: "user-key", active: false } },
    { id: "2", projectRole: { id: "7", name: "Developers" } },
    { id: "3", group: { name: "delivery" } },
    { id: "4", emailAddress: "recipient@example.invalid" },
    { id: "5", field: { id: "customfield_10000" } },
  ] }] });
  expect(JSON.stringify(result)).not.toMatch(/remote\.invalid|private-user@|unrequested actor|<script>/u);
});

it("reads native pages independently without following remote continuation URLs", async () => {
  const request = vi.fn<JiraMutationRequest>()
    .mockResolvedValueOnce(response({ startAt: 0, maxResults: 1, total: 2, isLast: false,
      values: [SCHEME], nextPage: "https://remote.invalid/secret" }))
    .mockResolvedValueOnce(response({ startAt: 1, maxResults: 1, total: 2, isLast: true,
      values: [{ ...SCHEME, id: 38 }] }));
  expect((await read("jira.notification-schemes", { startAt: 0, maxResults: 1 }, request)).data)
    .toMatchObject({ startAt: 0, total: 2, isLast: false, nextStartAt: 1 });
  expect((await read("jira.notification-schemes", { startAt: 1, maxResults: 1 }, request)).data)
    .toMatchObject({ startAt: 1, total: 2, isLast: true, items: [{ id: "38" }] });
  expect(request.mock.calls.map(([path]) => path)).toEqual([
    "notificationscheme?startAt=0&maxResults=1", "notificationscheme?startAt=1&maxResults=1",
  ]);
});

it.each([undefined, null])("does not infer a missing native page total: %s", async (total) => {
  const result = await read("jira.notification-schemes", {}, fixture({
    startAt: 0, maxResults: 25, isLast: true, total, values: [SCHEME],
  }));
  expect(result.data).toMatchObject({ outcome: "succeeded", isLast: true });
  expect(result.data).not.toHaveProperty("total");
});

it("binds project selection to the observed canonical identity before reading its scheme", async () => {
  const request = vi.fn<JiraMutationRequest>()
    .mockResolvedValueOnce(response({ id: "10000", key: "SYN", name: "Delivery" }))
    .mockResolvedValueOnce(response(SCHEME));
  expect((await read("jira.project-notification-scheme", { projectIdOrKey: "syn" }, request)).data)
    .toMatchObject({ outcome: "succeeded", projectId: "10000", projectKey: "SYN" });
  expect(request.mock.calls.map(([path]) => path)).toEqual([
    "project/syn", "project/10000/notificationscheme",
  ]);
});

const INVALID_SINGLE_INPUTS: readonly CatalogJsonObject[] = [
  { schemeId: "../37" }, { schemeId: "9223372036854775808" },
  { schemeId: "37", includeEvents: "true" }, { schemeId: "37", expand: "all" },
  { schemeId: "37", startAt: 1 },
];
it.each(INVALID_SINGLE_INPUTS)("refuses unsafe or unsupported selectors before any HTTP: %#", async (args) => {
  const request = fixture();
  expect((await read("jira.notification-scheme", args, request)).data.reason).toBe("invalid-input");
  expect(request).not.toHaveBeenCalled();
});

const INVALID_LIST_INPUTS: readonly CatalogJsonObject[] = [
  { startAt: -1 }, { maxResults: 51 }, { startAt: null }, { includeEvents: null },
];
it.each(INVALID_LIST_INPUTS)("enforces the native max50 list contract before HTTP: %#", async (args) => {
  const request = fixture();
  expect((await read("jira.notification-schemes", args, request)).data.reason).toBe("invalid-input");
  expect(request).not.toHaveBeenCalled();
});

it.each([
  { ...SCHEME, id: 38 }, { ...SCHEME, id: Number.MAX_SAFE_INTEGER + 1 },
  { ...SCHEME, notificationSchemeEvents: {} },
  { ...SCHEME, notificationSchemeEvents: [{ event: EVENT, notifications: [{ id: 1, notificationType: "UnknownPlugin" }] }] },
  { ...SCHEME, notificationSchemeEvents: [{ event: EVENT, notifications: [{ id: 1, notificationType: "Group", group: {} }] }] },
])("refuses contradictory or unreadable native data: %#", async (body) => {
  const result = await read("jira.notification-scheme", { schemeId: "37", includeEvents: true }, fixture(body));
  expect(result.isError).toBe(true);
});

it("preserves an exact native string int64 identity", async () => {
  const id = "9223372036854775807";
  expect((await read("jira.notification-scheme", { schemeId: id }, fixture({ ...SCHEME, id }))).data)
    .toMatchObject({ items: [{ id }] });
});

it.each(["permission-denied", "auth-failed", "not-found", "timeout"] as const)(
  "preserves %s without retry or empty success", async (reason) => {
    const request = vi.fn<JiraMutationRequest>().mockResolvedValue({ ok: false, reason });
    expect((await read("jira.notification-scheme", { schemeId: "37" }, request)).data)
      .toMatchObject({ outcome: "failed", reason });
    expect(request).toHaveBeenCalledTimes(1);
  },
);

it("recognizes only its closed native read vocabulary", () => {
  expect(isJiraNotificationSchemeRead("jira.project-notification-scheme")).toBe(true);
  expect(isJiraNotificationSchemeRead("jira.notify")).toBe(false);
  expect(isJiraNotificationSchemeRead("constructor")).toBe(false);
});
