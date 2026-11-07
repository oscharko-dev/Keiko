import { expect, it, vi } from "vitest";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolResult } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { executeJiraDirectoryRead } from "./jira-managed-directory-reads.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { executeJiraUserRead } from "./jira-managed-user-reads.js";
import { executeJiraAccessSchemeRead } from "./jira-managed-access-schemes.js";
import { executeJiraScreenRead } from "./jira-managed-screen-reads.js";
import { executeJiraSavedViewRead } from "./jira-managed-saved-views.js";

type Read = (request: JiraMutationRequest) => Promise<ManagedMcpToolResult>;
const READS: readonly [string, Read, string, "json" | "json-array"][] = [
  ["permission scheme", (request) => executeJiraAccessSchemeRead("jira.permission-scheme", { schemeId: "7" }, request), "permissionscheme/7", "json"],
  ["screen tabs", (request) => executeJiraScreenRead("jira.screen-tabs", { screenId: "7" }, request), "screens/7/tabs", "json-array"],
  ["dashboards", (request) => executeJiraSavedViewRead("jira.dashboards", {}, request), "dashboard?startAt=0&maxResults=25", "json"],
  [
    "single user",
    (request) => executeJiraUserRead("jira.user", { userKey: "user-7" }, request),
    "user?key=user-7",
    "json",
  ],
  [
    "user search",
    (request) => executeJiraUserRead("jira.users", {}, request),
    "user/search?maxResults=25&startAt=0",
    "json-array",
  ],
  [
    "group members",
    (request) => executeJiraDirectoryRead("jira.group-members", { groupName: "Team" }, request),
    "group/member?maxResults=25&groupname=Team&startAt=0",
    "json",
  ],
  [
    "application roles",
    (request) => executeJiraDirectoryRead("jira.application-roles", {}, request),
    "applicationrole",
    "json-array",
  ],
];

it.each(READS)(
  "preserves native refusal details for %s without an alternate request",
  async (_label, read, path, expectShape) => {
    const request = vi.fn<JiraMutationRequest>().mockResolvedValue({
      ok: false,
      reason: "permission-denied",
      httpStatus: 403,
      remote: { messages: ["Directory access requires an administrator."] },
    });
    expect(await read(request)).toEqual({
      data: {
        outcome: "failed",
        reason: "permission-denied",
        messages: ["Directory access requires an administrator."],
      },
      isError: true,
    });
    expect(request).toHaveBeenCalledExactlyOnceWith(path, "GET", undefined, expectShape);
  },
);

it.each(READS)(
  "refuses an unexpected successful status for %s before interpreting metadata",
  async (_label, read) => {
    const request = vi.fn<JiraMutationRequest>().mockResolvedValue({
      ok: true,
      status: 202,
      body: { key: "user-7", name: "User", values: [], isLast: true, maxResults: 25 },
      items: [],
    });
    expect((await read(request)).data).toEqual({ outcome: "failed", reason: "malformed-payload" });
    expect(request).toHaveBeenCalledTimes(1);
  },
);

it.each([
  [
    "user",
    (args: CatalogJsonObject, request: JiraMutationRequest) =>
      executeJiraUserRead("jira.user", args, request),
  ],
  [
    "group",
    (args: CatalogJsonObject, request: JiraMutationRequest) =>
      executeJiraDirectoryRead("jira.group-members", args, request),
  ],
] as const)("refuses an invalid %s selection before transport", async (_label, read) => {
  const request = vi.fn<JiraMutationRequest>();
  expect((await read({ url: "https://untrusted.invalid" }, request)).data.reason).toBe(
    "invalid-input",
  );
  expect(request).not.toHaveBeenCalled();
});

const PAGED_READS = [
  ["permission schemes", (args: CatalogJsonObject, request: JiraMutationRequest) => executeJiraAccessSchemeRead("jira.permission-schemes", args, request)],
  ["screen tabs", (args: CatalogJsonObject, request: JiraMutationRequest) => executeJiraScreenRead("jira.screen-tabs", { screenId: "7", ...args }, request)],
  ["dashboards", (args: CatalogJsonObject, request: JiraMutationRequest) => executeJiraSavedViewRead("jira.dashboards", args, request)],
] as const;
it.each(PAGED_READS)("retains closed paging argument refusal at the %s owner", async (_name, read) => {
  for (const args of [
    { startAt: -1 }, { startAt: 1_000_001 }, { startAt: 0.5 }, { startAt: null },
    { maxResults: 0 }, { maxResults: 101 }, { maxResults: "25" }, { maxResults: null },
    { url: "https://untrusted.invalid/override" },
  ] satisfies readonly CatalogJsonObject[]) {
    const request = vi.fn<JiraMutationRequest>();
    expect((await read(args, request)).data.reason).toBe("invalid-input");
    expect(request).not.toHaveBeenCalled();
  }
});
