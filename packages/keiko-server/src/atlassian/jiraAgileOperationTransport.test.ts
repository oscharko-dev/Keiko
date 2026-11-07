import { describe, expect, it } from "vitest";
import type {
  AtlassianHttpBodyPort,
  AtlassianHttpBodyResult,
} from "@oscharko-dev/keiko-connectors";
import { jiraOperationContracts } from "./jiraManagedProvider.js";
import {
  mutationRemoteState,
  nativeRead,
  nativeWrite,
  type MutationRemoteState,
} from "../../../../tests/support/jira-managed-mutation-scenarios.js";
import { response } from "../../../../tests/support/jira-managed-remote.js";
import {
  observeNativeJiraOperation,
  assertNativeJiraPrimary,
  type Scenario,
} from "../../../../tests/support/jira-operation-transport-contract.js";

const PAGING = { startAt: 2, maxResults: 5 };
const QUERY = { startAt: "2", maxResults: "5" };
const ISSUE_QUERY = {
  ...QUERY,
  fields: "summary,status,issuetype,project,assignee,priority,labels,created,updated",
};
// Independent selected identities and filters: the registry supplies no fixture input or response.
const SCENARIOS: readonly Scenario[] = [
  {
    tool: "jira.boards",
    args: { ...PAGING, name: "Team", type: "scrum", projectKeyOrId: "SYN" },
    query: { ...QUERY, name: "Team", type: "scrum", projectKeyOrId: "SYN" },
  },
  { tool: "jira.board", args: { boardId: "7" }, parameters: { boardId: "7" } },
  { tool: "jira.board-configuration", args: { boardId: "7" }, parameters: { boardId: "7" } },
  {
    tool: "jira.board-backlog",
    args: { boardId: "7", ...PAGING },
    parameters: { boardId: "7" },
    query: ISSUE_QUERY,
  },
  {
    tool: "jira.board-issues",
    args: { boardId: "7", ...PAGING },
    parameters: { boardId: "7" },
    query: ISSUE_QUERY,
  },
  {
    tool: "jira.board-epics",
    args: { boardId: "7", ...PAGING, done: false },
    parameters: { boardId: "7" },
    query: { ...QUERY, done: "false" },
  },
  { tool: "jira.epic", args: { epicIdOrKey: "SYN-11" }, parameters: { epicIdOrKey: "SYN-11" } },
  {
    tool: "jira.epic-issues",
    args: { epicIdOrKey: "SYN-11", ...PAGING },
    parameters: { epicIdOrKey: "SYN-11" },
    query: ISSUE_QUERY,
  },
  {
    tool: "jira.sprints",
    args: { boardId: "7", ...PAGING, state: "active" },
    parameters: { boardId: "7" },
    query: { ...QUERY, state: "active" },
  },
  { tool: "jira.sprint", args: { sprintId: "9" }, parameters: { sprintId: "9" } },
  {
    tool: "jira.sprint-issues",
    args: { sprintId: "9", ...PAGING },
    parameters: { sprintId: "9" },
    query: ISSUE_QUERY,
  },
  { tool: "jira.board-create", args: { name: "Changed", type: "scrum", filterId: "42" } },
  { tool: "jira.sprint-create", args: { name: "Changed", originBoardId: "7" } },
  {
    tool: "jira.sprint-update",
    args: { sprintId: "9", goal: "Changed" },
    parameters: { sprintId: "9" },
  },
  {
    tool: "jira.sprint-move-issues",
    args: { sprintId: "9", issues: ["SYN-1"] },
    parameters: { sprintId: "9" },
  },
  { tool: "jira.backlog-move-issues", args: { issues: ["SYN-1"] } },
  {
    tool: "jira.epic-update",
    args: { epicIdOrKey: "SYN-11", done: true },
    parameters: { epicIdOrKey: "SYN-11" },
  },
  {
    tool: "jira.epic-move-issues",
    args: { epicIdOrKey: "SYN-11", issues: ["SYN-1"] },
    parameters: { epicIdOrKey: "SYN-11" },
  },
];
function agileRead(path: string, state: MutationRemoteState): AtlassianHttpBodyResult {
  const page = { startAt: 2, maxResults: 5, total: 3, isLast: true };
  if (path.endsWith("/board")) return response({ ...page, values: [state.board] });
  if (path.endsWith("/board/7/epic")) return response({ ...page, values: [state.epic] });
  if (path.endsWith("/board/7/sprint")) return response({ ...page, values: [state.sprint] });
  if (path.endsWith("/backlog") || path.endsWith("/issue"))
    return response({
      ...page,
      issues: [{ id: "10001", key: "SYN-1", fields: { summary: "Independent issue" } }],
    });
  return response({}, 404);
}
function remote(): AtlassianHttpBodyPort {
  const state = mutationRemoteState();
  return (request) => {
    const path = new URL(request.url).pathname;
    return Promise.resolve(
      request.method === "GET"
        ? (nativeRead(path, state) ?? agileRead(path, state))
        : (nativeWrite(path, request.bodyJson ?? "{}", state) ?? response({}, 404)),
    );
  };
}
describe("native Agile registry and actual connector transport agreement", () => {
  it("covers every current Agile identity exactly once", () => {
    const native = jiraOperationContracts().filter(
      ({ definition }) => definition.kind === "native" && definition.apiRoot === "/rest/agile/1.0",
    );
    expect(native).toHaveLength(18);
    expect(SCENARIOS).toHaveLength(native.length);
    expect(new Set(SCENARIOS.map(({ tool }) => tool))).toEqual(
      new Set(native.map(({ definition }) => definition.tool)),
    );
  });
  it.each(SCENARIOS)(
    "pins $tool's method, root, path parameters and complete query on the wire",
    async (scenario) => {
      const observed = await observeNativeJiraOperation(scenario, {
        deployment: "data-center",
        baseUrl: "https://jira.example.invalid/context",
        http: remote(),
      });
      assertNativeJiraPrimary(observed, scenario);
      expect(observed.requests.filter((request) => request.method !== "GET")).toHaveLength(
        observed.definition.method === "GET" ? 0 : 1,
      );
    },
  );
});
