import { expect, it, vi } from "vitest";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolResult } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { executeJiraDirectoryRead } from "./jira-managed-directory-reads.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { executeJiraUserRead } from "./jira-managed-user-reads.js";

type Read = (request: JiraMutationRequest) => Promise<ManagedMcpToolResult>;
const READS: readonly [string, Read, string, "json" | "json-array"][] = [
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
