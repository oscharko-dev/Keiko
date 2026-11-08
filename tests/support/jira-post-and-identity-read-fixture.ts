import { expect } from "vitest";
import type { AtlassianHttpBodyPort } from "@oscharko-dev/keiko-connectors";
import type { Scenario } from "./jira-operation-transport-contract.js";
import { response } from "./jira-managed-remote.js";

// Literal native inputs and replies; neither is derived from the production registry or schemas.
export const POST_AND_IDENTITY_READ_SCENARIOS: readonly Scenario[] = [
  { tool: "jira.search-post", args: { jql: "project = SYN" } },
  { tool: "jira.worklogs-by-id", args: { worklogIds: ["7", "8"] } },
  {
    tool: "jira.anonymization-validation",
    args: { userKey: "USER1" },
    query: { userKey: "USER1" },
  },
  {
    tool: "jira.anonymization-rerun-validation",
    args: { userKey: "USER1", oldUserKey: "OLD1" },
    query: { userKey: "USER1", oldUserKey: "OLD1" },
  },
  { tool: "jira.anonymization-progress", args: { taskId: "7" }, query: { taskId: "7" } },
  { tool: "jira.current-session", args: {}, primaryMethodIndex: 1 },
];
export const POST_AND_IDENTITY_READ_TOOLS: ReadonlySet<string> = new Set(
  POST_AND_IDENTITY_READ_SCENARIOS.map(({ tool }) => tool),
);

const GET_REPLIES: Readonly<Record<string, Record<string, unknown>>> = {
  "/context/rest/api/2/myself": { key: "USER1", name: "synthetic-user" },
  "/context/rest/auth/1/session": { name: "synthetic-user", loginInfo: { loginCount: 0 } },
  "/context/rest/api/2/user/anonymization": {
    userKey: "USER1",
    success: false,
    deleted: false,
    operations: [],
    errors: {},
  },
  "/context/rest/api/2/user/anonymization/rerun": { userKey: "USER1", success: true },
  "/context/rest/api/2/user/anonymization/progress": {
    userKey: "USER1",
    status: "COMPLETED",
    currentProgress: 0,
    errors: { GENERAL: { errorMessages: ["One handler failed."] } },
  },
  "/context/rest/api/2/issue/10001": {
    id: "10001",
    key: "SYN-1",
    fields: { summary: "Synthetic issue" },
  },
};

export const postAndIdentityReadTransport: AtlassianHttpBodyPort = async (request) => {
  const url = new URL(request.url);
  expect(url.origin).toBe("https://jira.example.invalid");
  if (request.method === "GET") {
    const value = Object.hasOwn(GET_REPLIES, url.pathname) ? GET_REPLIES[url.pathname] : undefined;
    if (value === undefined) throw new TypeError("Unexpected native observation route");
    expect(request.bodyJson).toBeUndefined();
    return response(value);
  }
  expect(request.method).toBe("POST");
  expect(request.upload).toBeUndefined();
  if (url.pathname === "/context/rest/api/2/search") {
    expect(JSON.parse(request.bodyJson ?? "null")).toEqual({
      jql: "project = SYN",
      startAt: 0,
      maxResults: 25,
      validateQuery: true,
      fields: [
        "summary",
        "status",
        "issuetype",
        "project",
        "assignee",
        "priority",
        "labels",
        "created",
        "updated",
      ],
    });
    return response({
      startAt: 0,
      maxResults: 25,
      total: 1,
      issues: [
        {
          id: "10001",
          key: "SYN-1",
          fields: { summary: "Synthetic issue", status: { id: "1", name: "Open" } },
        },
      ],
    });
  }
  if (url.pathname === "/context/rest/api/2/worklog/list") {
    expect(request.bodyJson).toBe('{"ids":[7,8]}');
    return response([{ id: "7", issueId: "10001", timeSpentSeconds: 0, comment: "" }]);
  }
  throw new TypeError("Unexpected method or POST observation route");
};
