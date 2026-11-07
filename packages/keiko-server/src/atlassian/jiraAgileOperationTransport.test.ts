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
import { propertyTransportFixture, PROPERTY_FIXTURE_KEY, REVIEWED_PROPERTY_NODES, REQUESTED_PROPERTY_NODES } from "../../../../tests/support/jira-property-transport-fixture.js";

const PAGING = { startAt: 2, maxResults: 5 };
const QUERY = { startAt: "2", maxResults: "5" };
const ISSUE_QUERY = {
  ...QUERY,
  fields: "summary,status,issuetype,project,assignee,priority,labels,created,updated",
};
const CONTEXT_ISSUE_QUERY = { ...ISSUE_QUERY, validateQuery: "true", jql: "project = SYN AND summary ~ \"A & B\"" };
// Independent selected identities and filters: the registry supplies no fixture input or response.
const SCENARIOS: readonly Scenario[] = [
  { tool: "jira.set-board-property", args: { boardId: "7", propertyKey: PROPERTY_FIXTURE_KEY, expectedValueNodes: REVIEWED_PROPERTY_NODES, valueNodes: REQUESTED_PROPERTY_NODES }, parameters: { boardId: "7", propertyKey: PROPERTY_FIXTURE_KEY } },
  { tool: "jira.delete-board-property", args: { boardId: "7", propertyKey: PROPERTY_FIXTURE_KEY, expectedValueNodes: REVIEWED_PROPERTY_NODES }, parameters: { boardId: "7", propertyKey: PROPERTY_FIXTURE_KEY } },
  { tool: "jira.set-sprint-property", args: { sprintId: "9", propertyKey: PROPERTY_FIXTURE_KEY, expectedValueNodes: REVIEWED_PROPERTY_NODES, valueNodes: REQUESTED_PROPERTY_NODES }, parameters: { sprintId: "9", propertyKey: PROPERTY_FIXTURE_KEY } },
  { tool: "jira.delete-sprint-property", args: { sprintId: "9", propertyKey: PROPERTY_FIXTURE_KEY, expectedValueNodes: REVIEWED_PROPERTY_NODES }, parameters: { sprintId: "9", propertyKey: PROPERTY_FIXTURE_KEY } },
  { tool: "jira.board-property-keys", args: { boardId: "7" }, parameters: { boardId: "7" }, primaryMethodIndex: 1 },
  { tool: "jira.board-property", args: { boardId: "7", propertyKey: "view ~settings" },
    parameters: { boardId: "7", propertyKey: "view ~settings" }, primaryMethodIndex: 1 },
  { tool: "jira.sprint-property-keys", args: { sprintId: "9" }, parameters: { sprintId: "9" }, primaryMethodIndex: 1 },
  { tool: "jira.sprint-property", args: { sprintId: "9", propertyKey: "view ~settings" },
    parameters: { sprintId: "9", propertyKey: "view ~settings" }, primaryMethodIndex: 1 },
  {
    tool: "jira.board-epicless-issues", args: { boardId: "7", ...PAGING, jql: CONTEXT_ISSUE_QUERY.jql },
    parameters: { boardId: "7" }, query: CONTEXT_ISSUE_QUERY,
  },
  {
    tool: "jira.board-epic-issues", args: { boardId: "7", epicId: "11", ...PAGING, jql: CONTEXT_ISSUE_QUERY.jql },
    parameters: { boardId: "7", epicId: "11" }, query: CONTEXT_ISSUE_QUERY,
  },
  {
    tool: "jira.board-sprint-issues", args: { boardId: "7", sprintId: "9", ...PAGING, jql: CONTEXT_ISSUE_QUERY.jql },
    parameters: { boardId: "7", sprintId: "9" }, query: CONTEXT_ISSUE_QUERY,
  },
  { tool: "jira.epicless-issues", args: { ...PAGING, jql: CONTEXT_ISSUE_QUERY.jql }, query: CONTEXT_ISSUE_QUERY },
  {
    tool: "jira.board-projects", args: { boardId: "7", ...PAGING }, parameters: { boardId: "7" },
    query: QUERY, primaryMethodIndex: 1,
  },
  {
    tool: "jira.board-versions", args: { boardId: "7", ...PAGING, released: false }, parameters: { boardId: "7" },
    query: { ...QUERY, released: "false" }, primaryMethodIndex: 1,
  },
  { tool: "jira.board-refined-velocity", args: { boardId: "7" }, parameters: { boardId: "7" } },
  {
    tool: "jira.agile-issue", args: { issueIdOrKey: "SYN-2" }, parameters: { issueIdOrKey: "SYN-2" },
    query: { fields: "summary,description,status,issuetype,project,assignee,reporter,priority,labels,duedate,created,updated", updateHistory: "false" },
  },
  {
    tool: "jira.issue-estimation", args: { issueIdOrKey: "SYN-2", boardId: "7" }, parameters: { issueIdOrKey: "10002" },
    query: { boardId: "7" }, primaryMethodIndex: 1,
  },
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
  if (path.endsWith("/board/7/properties") || path.endsWith("/sprint/9/properties"))
    return response({ keys: [{ key: "view ~settings", self: "https://untrusted.invalid/property" }] });
  if (path.endsWith("/board/7/properties/view%20~settings") || path.endsWith("/sprint/9/properties/view%20~settings"))
    return response({ key: "view ~settings", value: { "a/b~c": [false, null, {}] } });
  if (path.endsWith("/board/7/project"))
    return response({ ...page, values: [{ id: 10000, key: "SYN", name: "Visible project", archived: false }] });
  if (path.endsWith("/board/7/version"))
    return response({ ...page, values: [{ id: 81, name: "Planned release", released: false, releaseDate: "2026-11-07T23:00:00-0500" }] });
  if (path.endsWith("/board/7/settings/refined-velocity")) return response({ value: false });
  if (path.endsWith("/issue/10002/estimation")) return response({ fieldId: "customfield_10001", value: 0 });
  if (path.endsWith("/issue/SYN-2")) return response({ id: "10002", key: "SYN-2", fields: {
    summary: "Independent Agile detail", description: "Saved native text", status: { id: "1", name: "Open" },
    reporter: { name: "synthetic-reporter" }, duedate: "2026-11-07",
  } });
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
const PROPERTY_WRITE_ROOTS: Readonly<Record<string, string>> = {
  "jira.set-board-property": "board/7/properties", "jira.delete-board-property": "board/7/properties",
  "jira.set-sprint-property": "sprint/9/properties", "jira.delete-sprint-property": "sprint/9/properties",
};
function remote(tool?: string): AtlassianHttpBodyPort {
  const state = mutationRemoteState();
  const root = PROPERTY_WRITE_ROOTS[tool ?? ""];
  const property = propertyTransportFixture(root === undefined ? undefined : `/context/rest/agile/1.0/${root}`);
  return (request) => {
    const path = new URL(request.url).pathname;
    return Promise.resolve(
      request.method === "GET"
        ? (property.read(request) ?? nativeRead(path, state) ?? agileRead(path, state))
        : (property.write(request) ?? nativeWrite(path, request.bodyJson ?? "{}", state) ?? response({}, 404)),
    );
  };
}
describe("native Agile registry and actual connector transport agreement", () => {
  it("covers every current Agile identity exactly once", () => {
    const native = jiraOperationContracts().filter(
      ({ definition }) => definition.kind === "native" && definition.apiRoot === "/rest/agile/1.0",
    );
    expect(native).toHaveLength(35);
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
        http: remote(scenario.tool),
      });
      assertNativeJiraPrimary(observed, scenario);
      expect(observed.requests.filter((request) => request.method !== "GET")).toHaveLength(
        observed.definition.method === "GET" ? 0 : 1,
      );
    },
  );
  it("resolves estimation identity without updating issue history before reading the exact numeric target", async () => {
    const observed = await observeNativeJiraOperation({
      tool: "jira.issue-estimation", args: { issueIdOrKey: "SYN-2", boardId: "7" },
    }, { deployment: "data-center", baseUrl: "https://jira.example.invalid/context", http: remote() });
    expect(observed.requests.map(({ method, url }) => [method, url])).toEqual([
      ["GET", "https://jira.example.invalid/context/rest/agile/1.0/issue/SYN-2?fields=summary&updateHistory=false"],
      ["GET", "https://jira.example.invalid/context/rest/agile/1.0/issue/10002/estimation?boardId=7"],
    ]);
    expect(observed.result.data).toMatchObject({ boardId: "7", issueId: "10002", issueKey: "SYN-2", value: 0 });
  });
  it.each(["jira.set-board-property", "jira.delete-sprint-property"] as const)(
    "confirms %s on the same Agile parent without converting false to absence", async (tool) => {
      const scenario = SCENARIOS.find((entry) => entry.tool === tool);
      if (scenario === undefined) throw new TypeError("Missing Agile property mutation fixture");
      const observed = await observeNativeJiraOperation(scenario, { deployment: "data-center", baseUrl: "https://jira.example.invalid/context", http: remote(tool) });
      expect(observed.requests.map(({ method }) => method)).toEqual(["GET", "GET", "GET", tool === "jira.set-board-property" ? "PUT" : "DELETE", "GET", "GET", "GET"]);
      expect(observed.requests[0]?.url).toBe(observed.requests[4]?.url);
      expect(observed.result.data).toMatchObject({ propertyKey: PROPERTY_FIXTURE_KEY, propertyPresent: tool === "jira.set-board-property" });
      expect(observed.requests[3]?.bodyJson).toBe(tool === "jira.set-board-property" ? "false" : undefined);
    },
  );
  it("uses the actual Agile entity lookup and fixed property route without following self URLs", async () => {
    const observed = await observeNativeJiraOperation({ tool: "jira.board-property", args: { boardId: "7", propertyKey: "view ~settings" } }, {
      deployment: "data-center", baseUrl: "https://jira.example.invalid/context", http: remote(),
    });
    expect(observed.requests.map(({ method, url }) => [method, url])).toEqual([
      ["GET", "https://jira.example.invalid/context/rest/agile/1.0/board/7"],
      ["GET", "https://jira.example.invalid/context/rest/agile/1.0/board/7/properties/view%20~settings"],
    ]);
    expect(observed.result.data).toMatchObject({ boardId: "7", propertyKey: "view ~settings",
      items: expect.arrayContaining([{ path: "/a~1b~0c/0", kind: "boolean", booleanValue: false }]),
    });
    expect(JSON.stringify(observed.result.data)).not.toContain("untrusted.invalid");
  });
});
