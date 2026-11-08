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
import {
  propertyTransportFixture,
  PROPERTY_FIXTURE_KEY,
  REVIEWED_PROPERTY_NODES,
  REQUESTED_PROPERTY_NODES,
} from "../../../../tests/support/jira-property-transport-fixture.js";
import {
  BOARD_CONFIGURATION_FIXTURE_CASES as BOARD_CONFIGURATION_CASES,
  boardConfigurationTransportFixture,
} from "../../../../tests/support/jira-board-configuration-fixture.js";
import { SPRINT_LIFECYCLE_FIXTURE_CASES as SPRINT_LIFECYCLE_CASES } from "../../../../tests/support/jira-sprint-lifecycle-fixture.js";
import { sprintLifecycleTransportFixture } from "../../../../tests/support/jira-sprint-lifecycle-transport-fixture.js";

const PAGING = { startAt: 2, maxResults: 5 };
const QUERY = { startAt: "2", maxResults: "5" };
const ISSUE_QUERY = {
  ...QUERY,
  fields: "summary,status,issuetype,project,assignee,priority,labels,created,updated",
};
const CONTEXT_ISSUE_QUERY = {
  ...ISSUE_QUERY,
  validateQuery: "true",
  jql: 'project = SYN AND summary ~ "A & B"',
};
const ISSUE_NATIVE_QUERY =
  "startAt=2&maxResults=5&fields=summary%2Cstatus%2Cissuetype%2Cproject%2Cassignee%2Cpriority%2Clabels%2Ccreated%2Cupdated";
const CONTEXT_NATIVE_QUERY = `${ISSUE_NATIVE_QUERY}&validateQuery=true&jql=project+%3D+SYN+AND+summary+%7E+%22A+%26+B%22`;
// Independent selected identities and filters: the registry supplies no fixture input or response.
const SCENARIOS: readonly Scenario[] = [
  {
    tool: "jira.epic-remove-issues",
    args: PLANNING_CASES[0].args,
    expectedReceipt: {
      userKey: "synthetic-actor",
      issueIds: ["10001"],
      issueKeys: ["SYN-1"],
      epicPresent: false,
    },
  },
  {
    tool: "jira.rank-epic",
    args: PLANNING_CASES[1].args,
    parameters: { epicIdOrKey: "10001" },
    expectedOutcome: "succeeded-unconfirmed",
    expectedReceipt: {
      userKey: "synthetic-actor",
      boardId: "7",
      fieldId: "customfield_10019",
      issueIds: ["10001"],
      issueKeys: ["SYN-1"],
      anchorIssueId: "10002",
      anchorIssueKey: "SYN-2",
      rankDirection: "before",
    },
  },
  {
    tool: "jira.rank-issues",
    args: PLANNING_CASES[2].args,
    expectedOutcome: "succeeded-unconfirmed",
    expectedReceipt: {
      userKey: "synthetic-actor",
      boardId: "7",
      fieldId: "customfield_10019",
      issueIds: ["10001"],
      issueKeys: ["SYN-1"],
      anchorIssueId: "10002",
      anchorIssueKey: "SYN-2",
      rankDirection: "before",
    },
  },
  {
    tool: "jira.set-issue-estimation",
    args: PLANNING_CASES[3].args,
    parameters: { issueIdOrKey: "10001" },
    query: { boardId: "7" },
    expectedReceipt: {
      userKey: "synthetic-actor",
      boardId: "7",
      fieldId: "customfield_10016",
      issueId: "10001",
      issueKey: "SYN-1",
      estimationValue: 5,
      estimationUnit: "board-number",
    },
  },
  {
    tool: "jira.replace-sprint",
    args: SPRINT_LIFECYCLE_CASES[0].args,
    parameters: { sprintId: "11" },
    expectedReceipt: {
      userKey: "synthetic-actor",
      sprintId: "11",
      originBoardId: "7",
      sprintPresent: true,
    },
  },
  {
    tool: "jira.delete-sprint",
    args: SPRINT_LIFECYCLE_CASES[1].args,
    parameters: { sprintId: "11" },
    expectedOutcome: "succeeded-unconfirmed",
    expectedReceipt: {
      userKey: "synthetic-actor",
      sprintId: "11",
      originBoardId: "7",
      sprintPresent: false,
    },
  },
  {
    tool: "jira.swap-sprints",
    args: SPRINT_LIFECYCLE_CASES[2].args,
    parameters: { sprintId: "11" },
    expectedOutcome: "succeeded-unconfirmed",
    expectedReceipt: {
      userKey: "synthetic-actor",
      sprintId: "11",
      originBoardId: "7",
      swapSprintId: "12",
    },
  },
  {
    tool: "jira.unmap-sprints",
    args: SPRINT_LIFECYCLE_CASES[3].args,
    expectedReceipt: { userKey: "synthetic-actor", sprintIds: ["12"], sprintSynced: false },
  },
  {
    tool: "jira.unmap-all-sprints",
    args: SPRINT_LIFECYCLE_CASES[4].args,
    expectedOutcome: "succeeded-unconfirmed",
    expectedReceipt: {
      userKey: "synthetic-actor",
      sprintIds: ["12"],
      sprintSynced: false,
      allSprints: true,
    },
  },
  {
    tool: "jira.delete-board",
    args: BOARD_CONFIGURATION_CASES[0].args,
    parameters: { boardId: "7" },
    expectedOutcome: "succeeded-unconfirmed",
    expectedReceipt: {
      boardId: "7",
      filterId: "42",
      userKey: "synthetic-actor",
      boardPresent: false,
    },
  },
  {
    tool: "jira.set-board-refined-velocity",
    args: BOARD_CONFIGURATION_CASES[1].args,
    parameters: { boardId: "7" },
    expectedReceipt: {
      boardId: "7",
      filterId: "42",
      userKey: "synthetic-actor",
      refinedVelocityEnabled: false,
    },
  },
  {
    tool: "jira.set-board-property",
    args: {
      boardId: "7",
      propertyKey: PROPERTY_FIXTURE_KEY,
      expectedValueNodes: REVIEWED_PROPERTY_NODES,
      valueNodes: REQUESTED_PROPERTY_NODES,
    },
    parameters: { boardId: "7", propertyKey: PROPERTY_FIXTURE_KEY },
    expectedPrimary: {
      method: "PUT",
      apiRoot: "/rest/agile/1.0",
      path: "board/7/properties/view%20~settings",
    },
  },
  {
    tool: "jira.delete-board-property",
    args: {
      boardId: "7",
      propertyKey: PROPERTY_FIXTURE_KEY,
      expectedValueNodes: REVIEWED_PROPERTY_NODES,
    },
    parameters: { boardId: "7", propertyKey: PROPERTY_FIXTURE_KEY },
    expectedPrimary: {
      method: "DELETE",
      apiRoot: "/rest/agile/1.0",
      path: "board/7/properties/view%20~settings",
    },
  },
  {
    tool: "jira.set-sprint-property",
    args: {
      sprintId: "9",
      propertyKey: PROPERTY_FIXTURE_KEY,
      expectedValueNodes: REVIEWED_PROPERTY_NODES,
      valueNodes: REQUESTED_PROPERTY_NODES,
    },
    parameters: { sprintId: "9", propertyKey: PROPERTY_FIXTURE_KEY },
    expectedPrimary: {
      method: "PUT",
      apiRoot: "/rest/agile/1.0",
      path: "sprint/9/properties/view%20~settings",
    },
  },
  {
    tool: "jira.delete-sprint-property",
    args: {
      sprintId: "9",
      propertyKey: PROPERTY_FIXTURE_KEY,
      expectedValueNodes: REVIEWED_PROPERTY_NODES,
    },
    parameters: { sprintId: "9", propertyKey: PROPERTY_FIXTURE_KEY },
    expectedPrimary: {
      method: "DELETE",
      apiRoot: "/rest/agile/1.0",
      path: "sprint/9/properties/view%20~settings",
    },
  },
  {
    tool: "jira.board-property-keys",
    args: { boardId: "7" },
    parameters: { boardId: "7" },
    primaryMethodIndex: 1,
    expectedPrimary: { method: "GET", apiRoot: "/rest/agile/1.0", path: "board/7/properties" },
  },
  {
    tool: "jira.board-property",
    args: { boardId: "7", propertyKey: "view ~settings" },
    parameters: { boardId: "7", propertyKey: "view ~settings" },
    primaryMethodIndex: 1,
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/agile/1.0",
      path: "board/7/properties/view%20~settings",
    },
  },
  {
    tool: "jira.sprint-property-keys",
    args: { sprintId: "9" },
    parameters: { sprintId: "9" },
    primaryMethodIndex: 1,
    expectedPrimary: { method: "GET", apiRoot: "/rest/agile/1.0", path: "sprint/9/properties" },
  },
  {
    tool: "jira.sprint-property",
    args: { sprintId: "9", propertyKey: "view ~settings" },
    parameters: { sprintId: "9", propertyKey: "view ~settings" },
    primaryMethodIndex: 1,
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/agile/1.0",
      path: "sprint/9/properties/view%20~settings",
    },
  },
  {
    tool: "jira.board-epicless-issues",
    args: { boardId: "7", ...PAGING, jql: CONTEXT_ISSUE_QUERY.jql },
    parameters: { boardId: "7" },
    query: CONTEXT_ISSUE_QUERY,
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/agile/1.0",
      path: `board/7/epic/none/issue?${CONTEXT_NATIVE_QUERY}`,
    },
  },
  {
    tool: "jira.board-epic-issues",
    args: { boardId: "7", epicId: "11", ...PAGING, jql: CONTEXT_ISSUE_QUERY.jql },
    parameters: { boardId: "7", epicId: "11" },
    query: CONTEXT_ISSUE_QUERY,
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/agile/1.0",
      path: `board/7/epic/11/issue?${CONTEXT_NATIVE_QUERY}`,
    },
  },
  {
    tool: "jira.board-sprint-issues",
    args: { boardId: "7", sprintId: "9", ...PAGING, jql: CONTEXT_ISSUE_QUERY.jql },
    parameters: { boardId: "7", sprintId: "9" },
    query: CONTEXT_ISSUE_QUERY,
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/agile/1.0",
      path: `board/7/sprint/9/issue?${CONTEXT_NATIVE_QUERY}`,
    },
  },
  {
    tool: "jira.epicless-issues",
    args: { ...PAGING, jql: CONTEXT_ISSUE_QUERY.jql },
    query: CONTEXT_ISSUE_QUERY,
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/agile/1.0",
      path: `epic/none/issue?${CONTEXT_NATIVE_QUERY}`,
    },
  },
  {
    tool: "jira.board-projects",
    args: { boardId: "7", ...PAGING },
    parameters: { boardId: "7" },
    query: QUERY,
    primaryMethodIndex: 1,
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/agile/1.0",
      path: "board/7/project?startAt=2&maxResults=5",
    },
  },
  {
    tool: "jira.board-versions",
    args: { boardId: "7", ...PAGING, released: false },
    parameters: { boardId: "7" },
    query: { ...QUERY, released: "false" },
    primaryMethodIndex: 1,
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/agile/1.0",
      path: "board/7/version?startAt=2&maxResults=5&released=false",
    },
  },
  {
    tool: "jira.board-refined-velocity",
    args: { boardId: "7" },
    parameters: { boardId: "7" },
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/agile/1.0",
      path: "board/7/settings/refined-velocity",
    },
  },
  {
    tool: "jira.agile-issue",
    args: { issueIdOrKey: "SYN-2" },
    parameters: { issueIdOrKey: "SYN-2" },
    query: {
      fields:
        "summary,description,status,issuetype,project,assignee,reporter,priority,labels,duedate,created,updated",
      updateHistory: "false",
    },
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/agile/1.0",
      path: "issue/SYN-2?fields=summary%2Cdescription%2Cstatus%2Cissuetype%2Cproject%2Cassignee%2Creporter%2Cpriority%2Clabels%2Cduedate%2Ccreated%2Cupdated&updateHistory=false",
    },
  },
  {
    tool: "jira.issue-estimation",
    args: { issueIdOrKey: "SYN-2", boardId: "7" },
    parameters: { issueIdOrKey: "10002" },
    query: { boardId: "7" },
    primaryMethodIndex: 1,
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/agile/1.0",
      path: "issue/10002/estimation?boardId=7",
    },
  },
  {
    tool: "jira.boards",
    args: { ...PAGING, name: "Team", type: "scrum", projectKeyOrId: "SYN" },
    query: { ...QUERY, name: "Team", type: "scrum", projectKeyOrId: "SYN" },
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/agile/1.0",
      path: "board?startAt=2&maxResults=5&name=Team&projectKeyOrId=SYN&type=scrum",
    },
  },
  {
    tool: "jira.board",
    args: { boardId: "7" },
    parameters: { boardId: "7" },
    expectedPrimary: { method: "GET", apiRoot: "/rest/agile/1.0", path: "board/7" },
  },
  {
    tool: "jira.board-configuration",
    args: { boardId: "7" },
    parameters: { boardId: "7" },
    expectedPrimary: { method: "GET", apiRoot: "/rest/agile/1.0", path: "board/7/configuration" },
  },
  {
    tool: "jira.board-backlog",
    args: { boardId: "7", ...PAGING },
    parameters: { boardId: "7" },
    query: ISSUE_QUERY,
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/agile/1.0",
      path: `board/7/backlog?${ISSUE_NATIVE_QUERY}`,
    },
  },
  {
    tool: "jira.board-issues",
    args: { boardId: "7", ...PAGING },
    parameters: { boardId: "7" },
    query: ISSUE_QUERY,
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/agile/1.0",
      path: `board/7/issue?${ISSUE_NATIVE_QUERY}`,
    },
  },
  {
    tool: "jira.board-epics",
    args: { boardId: "7", ...PAGING, done: false },
    parameters: { boardId: "7" },
    query: { ...QUERY, done: "false" },
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/agile/1.0",
      path: "board/7/epic?startAt=2&maxResults=5&done=false",
    },
  },
  {
    tool: "jira.epic",
    args: { epicIdOrKey: "SYN-11" },
    parameters: { epicIdOrKey: "SYN-11" },
    expectedPrimary: { method: "GET", apiRoot: "/rest/agile/1.0", path: "epic/SYN-11" },
  },
  {
    tool: "jira.epic-issues",
    args: { epicIdOrKey: "SYN-11", ...PAGING },
    parameters: { epicIdOrKey: "SYN-11" },
    query: ISSUE_QUERY,
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/agile/1.0",
      path: `epic/SYN-11/issue?${ISSUE_NATIVE_QUERY}`,
    },
  },
  {
    tool: "jira.sprints",
    args: { boardId: "7", ...PAGING, state: "active" },
    parameters: { boardId: "7" },
    query: { ...QUERY, state: "active" },
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/agile/1.0",
      path: "board/7/sprint?startAt=2&maxResults=5&state=active",
    },
  },
  {
    tool: "jira.sprint",
    args: { sprintId: "9" },
    parameters: { sprintId: "9" },
    expectedPrimary: { method: "GET", apiRoot: "/rest/agile/1.0", path: "sprint/9" },
  },
  {
    tool: "jira.sprint-issues",
    args: { sprintId: "9", ...PAGING },
    parameters: { sprintId: "9" },
    query: ISSUE_QUERY,
    expectedPrimary: {
      method: "GET",
      apiRoot: "/rest/agile/1.0",
      path: `sprint/9/issue?${ISSUE_NATIVE_QUERY}`,
    },
  },
  {
    tool: "jira.board-create",
    args: { name: "Changed", type: "scrum", filterId: "42" },
    expectedPrimary: { method: "POST", apiRoot: "/rest/agile/1.0", path: "board" },
  },
  {
    tool: "jira.sprint-create",
    args: { name: "Changed", originBoardId: "7" },
    expectedPrimary: { method: "POST", apiRoot: "/rest/agile/1.0", path: "sprint" },
  },
  {
    tool: "jira.sprint-update",
    args: { sprintId: "9", goal: "Changed" },
    parameters: { sprintId: "9" },
    expectedPrimary: { method: "POST", apiRoot: "/rest/agile/1.0", path: "sprint/9" },
  },
  {
    tool: "jira.sprint-move-issues",
    args: { sprintId: "9", issues: ["SYN-1"] },
    parameters: { sprintId: "9" },
    expectedPrimary: { method: "POST", apiRoot: "/rest/agile/1.0", path: "sprint/9/issue" },
  },
  {
    tool: "jira.backlog-move-issues",
    args: { issues: ["SYN-1"] },
    expectedPrimary: { method: "POST", apiRoot: "/rest/agile/1.0", path: "backlog/issue" },
  },
  {
    tool: "jira.epic-update",
    args: { epicIdOrKey: "SYN-11", done: true },
    parameters: { epicIdOrKey: "SYN-11" },
    expectedPrimary: { method: "POST", apiRoot: "/rest/agile/1.0", path: "epic/SYN-11" },
  },
  {
    tool: "jira.epic-move-issues",
    args: { epicIdOrKey: "SYN-11", issues: ["SYN-1"] },
    parameters: { epicIdOrKey: "SYN-11" },
    expectedPrimary: { method: "POST", apiRoot: "/rest/agile/1.0", path: "epic/SYN-11/issue" },
  },
];
function independentPrimary(scenario: Scenario): Scenario["expectedPrimary"] {
  if (scenario.expectedPrimary !== undefined) return scenario.expectedPrimary;
  const selected =
    [...PLANNING_CASES, ...SPRINT_LIFECYCLE_CASES].find((item) => item.name === scenario.tool) ??
    BOARD_CONFIGURATION_CASES.find((item) => item.tool === scenario.tool);
  return selected === undefined
    ? undefined
    : {
        method: selected.method,
        apiRoot: "/rest/agile/1.0",
        path: selected.path.replace(/^\//u, ""),
      };
}
function agileRead(path: string, state: MutationRemoteState): AtlassianHttpBodyResult {
  const page = { startAt: 2, maxResults: 5, total: 3, isLast: true };
  if (path.endsWith("/board/7/properties") || path.endsWith("/sprint/9/properties"))
    return response({
      keys: [{ key: "view ~settings", self: "https://untrusted.invalid/property" }],
    });
  if (
    path.endsWith("/board/7/properties/view%20~settings") ||
    path.endsWith("/sprint/9/properties/view%20~settings")
  )
    return response({ key: "view ~settings", value: { "a/b~c": [false, null, {}] } });
  if (path.endsWith("/board/7/project"))
    return response({
      ...page,
      values: [{ id: 10000, key: "SYN", name: "Visible project", archived: false }],
    });
  if (path.endsWith("/board/7/version"))
    return response({
      ...page,
      values: [
        {
          id: 81,
          name: "Planned release",
          released: false,
          releaseDate: "2026-11-07T23:00:00-0500",
        },
      ],
    });
  if (path.endsWith("/board/7/settings/refined-velocity")) return response({ value: false });
  if (path.endsWith("/issue/10002/estimation"))
    return response({ fieldId: "customfield_10001", value: 0 });
  if (path.endsWith("/issue/SYN-2"))
    return response({
      id: "10002",
      key: "SYN-2",
      fields: {
        summary: "Independent Agile detail",
        description: "Saved native text",
        status: { id: "1", name: "Open" },
        reporter: { name: "synthetic-reporter" },
        duedate: "2026-11-07",
      },
    });
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
  "jira.set-board-property": "board/7/properties",
  "jira.delete-board-property": "board/7/properties",
  "jira.set-sprint-property": "sprint/9/properties",
  "jira.delete-sprint-property": "sprint/9/properties",
};
function configurationRemote(tool?: string): AtlassianHttpBodyPort | undefined {
  const selectedPlanning = PLANNING_CASES.find((item) => item.name === tool);
  const selectedSprint = SPRINT_LIFECYCLE_CASES.find((item) => item.name === tool);
  const selectedBoard = BOARD_CONFIGURATION_CASES.find((item) => item.tool === tool);
  let fixture:
    | ReturnType<typeof sprintLifecycleTransportFixture>
    | ReturnType<typeof boardConfigurationTransportFixture>
    | ReturnType<typeof agilePlanningTransportFixture>
    | undefined;
  if (selectedPlanning !== undefined)
    fixture = agilePlanningTransportFixture(
      "/context/rest/api/2",
      "/context/rest/agile/1.0",
      selectedPlanning,
    );
  else if (selectedSprint !== undefined)
    fixture = sprintLifecycleTransportFixture(
      "/context/rest/api/2",
      "/context/rest/agile/1.0",
      selectedSprint,
    );
  else if (selectedBoard !== undefined)
    fixture = boardConfigurationTransportFixture(
      "/context/rest/api/2",
      "/context/rest/agile/1.0",
      selectedBoard,
    );
  if (fixture === undefined) return undefined;
  const selected = fixture;
  return async (request) => {
    expect(new URL(request.url).origin).toBe("https://jira.example.invalid");
    const result = await (request.method === "GET"
      ? selected.read(request)
      : selected.write(request));
    if (result === undefined) throw new TypeError("Unexpected reviewed Agile configuration route");
    return result;
  };
}
function remote(tool?: string): AtlassianHttpBodyPort {
  const configuration = configurationRemote(tool);
  if (configuration !== undefined) return configuration;
  const state = mutationRemoteState();
  const root = PROPERTY_WRITE_ROOTS[tool ?? ""];
  const property = propertyTransportFixture(
    root === undefined ? undefined : `/context/rest/agile/1.0/${root}`,
  );
  return (request) => {
    const path = new URL(request.url).pathname;
    return Promise.resolve(
      request.method === "GET"
        ? (property.read(request) ?? nativeRead(path, state) ?? agileRead(path, state))
        : (property.write(request) ??
            nativeWrite(path, request.bodyJson ?? "{}", state) ??
            response({}, 404)),
    );
  };
}
describe("native Agile registry and actual connector transport agreement", () => {
  it("covers every current Agile identity exactly once", () => {
    const native = jiraOperationContracts().filter(
      ({ definition }) => definition.kind === "native" && definition.apiRoot === "/rest/agile/1.0",
    );
    expect(native).toHaveLength(46);
    expect(SCENARIOS).toHaveLength(native.length);
    expect(new Set(SCENARIOS.map(({ tool }) => tool))).toEqual(
      new Set(native.map(({ definition }) => definition.tool)),
    );
    expect(SCENARIOS.filter(({ expectedPrimary }) => expectedPrimary !== undefined)).toHaveLength(
      35,
    );
    expect(SCENARIOS.filter((scenario) => independentPrimary(scenario) !== undefined)).toHaveLength(
      46,
    );
  });
  it("requires an independent primary expectation and rejects matching drift in both request and registry", async () => {
    const scenario = SCENARIOS.find(({ tool }) => tool === "jira.board");
    if (scenario === undefined) throw new TypeError("Missing literal board read fixture");
    const observed = await observeNativeJiraOperation(scenario, {
      deployment: "data-center",
      baseUrl: "https://jira.example.invalid/context",
      http: remote(),
    });
    expect(() => assertNativeJiraPrimary(observed, scenario)).not.toThrow();
    expect(() =>
      assertNativeJiraPrimary(observed, { tool: scenario.tool, args: scenario.args }),
    ).toThrow("Missing independent native primary expectation");
    for (const path of [
      "/context/rest/agile/1.0/board/8",
      "/context/rest/api/2/board/7",
      "/context/rest/agile/1.0/board/7?unreviewed=true",
    ]) {
      const drifted = {
        ...observed,
        definition: { ...observed.definition, pathTemplate: path },
        requests: observed.requests.map((request) => ({
          ...request,
          url: `https://jira.example.invalid${path}`,
        })),
      };
      expect(() => assertNativeJiraPrimary(drifted, scenario)).toThrow();
    }
    expect(() =>
      assertNativeJiraPrimary(
        { ...observed, definition: { ...observed.definition, method: "POST" } },
        scenario,
      ),
    ).toThrow();
  });
  it.each(SCENARIOS)(
    "pins $tool's method, root, path parameters and complete query on the wire",
    async (scenario) => {
      const observed = await observeNativeJiraOperation(scenario, {
        deployment: "data-center",
        baseUrl: "https://jira.example.invalid/context",
        http: remote(scenario.tool),
      });
      const expectedPrimary = independentPrimary(scenario);
      if (expectedPrimary === undefined)
        throw new TypeError("Missing independent Agile primary route");
      assertNativeJiraPrimary(observed, { ...scenario, expectedPrimary });
      expect(observed.requests.filter((request) => request.method !== "GET")).toHaveLength(
        observed.definition.method === "GET" ? 0 : 1,
      );
      if (scenario.expectedReceipt !== undefined)
        expect(observed.result.data).toMatchObject(scenario.expectedReceipt);
    },
  );
  it("does not convert acknowledged board deletion and a selected404 into confirmed absence", async () => {
    const scenario = SCENARIOS.find(({ tool }) => tool === "jira.delete-board");
    if (scenario === undefined) throw new TypeError("Missing board deletion fixture");
    const observed = await observeNativeJiraOperation(scenario, {
      deployment: "data-center",
      baseUrl: "https://jira.example.invalid/context",
      http: remote(scenario.tool),
    });
    expect(observed.result).toMatchObject({
      isError: true,
      data: {
        outcome: "succeeded-unconfirmed",
        boardId: "7",
        filterId: "42",
        userKey: "synthetic-actor",
        boardPresent: false,
      },
    });
    expect(observed.requests.map(({ method, url }) => [method, url])).toEqual([
      ["GET", "https://jira.example.invalid/context/rest/api/2/myself"],
      ["GET", "https://jira.example.invalid/context/rest/agile/1.0/board/7/configuration"],
      ["DELETE", "https://jira.example.invalid/context/rest/agile/1.0/board/7"],
      ["GET", "https://jira.example.invalid/context/rest/api/2/myself"],
      ["GET", "https://jira.example.invalid/context/rest/agile/1.0/board/7"],
    ]);
  });
  it.each(["jira.rank-epic", "jira.rank-issues"] as const)(
    "keeps %s unconfirmed after native partial acknowledgement despite readable identities",
    async (tool) => {
      const scenario = SCENARIOS.find((entry) => entry.tool === tool);
      if (scenario === undefined) throw new TypeError("Missing reviewed rank fixture");
      const native = remote(tool);
      const observed = await observeNativeJiraOperation(scenario, {
        deployment: "data-center",
        baseUrl: "https://jira.example.invalid/context",
        http: async (request) => {
          const result = await native(request);
          return request.method === "PUT" ? response({}, 207) : result;
        },
      });
      expect(observed.result).toMatchObject({
        isError: true,
        data: {
          outcome: "succeeded-unconfirmed",
          ...scenario.expectedReceipt,
        },
      });
      expect(observed.requests.filter(({ method }) => method !== "GET")).toHaveLength(1);
      expect(observed.requests.at(-1)?.method).toBe("GET");
    },
  );
  it("changes an estimate using native decimal text and separately confirms the observed numeric unit", async () => {
    const scenario = SCENARIOS.find(({ tool }) => tool === "jira.set-issue-estimation");
    if (scenario === undefined) throw new TypeError("Missing estimate fixture");
    const observed = await observeNativeJiraOperation(scenario, {
      deployment: "data-center",
      baseUrl: "https://jira.example.invalid/context",
      http: remote(scenario.tool),
    });
    const effects = observed.requests.filter(({ method }) => method !== "GET");
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({
      method: "PUT",
      bodyJson: '{"value":"5"}',
      url: "https://jira.example.invalid/context/rest/agile/1.0/issue/10001/estimation?boardId=7",
    });
    expect(observed.result.data).toMatchObject({
      outcome: "succeeded",
      estimationValue: 5,
      estimationUnit: "board-number",
    });
  });
  it.each([
    ["jira.unmap-sprints", "sprint/unmap", "succeeded", '{"sprintIds":[12]}'],
    ["jira.unmap-all-sprints", "sprint/unmap-all", "succeeded-unconfirmed", undefined],
  ] as const)(
    "keeps %s experimental opt-in fixed to one PUT and distinguishes selected proof from the instance sample",
    async (tool, path, outcome, bodyJson) => {
      const scenario = SCENARIOS.find((entry) => entry.tool === tool);
      if (scenario === undefined) throw new TypeError("Missing sprint cleanup fixture");
      const observed = await observeNativeJiraOperation(scenario, {
        deployment: "data-center",
        baseUrl: "https://jira.example.invalid/context",
        http: remote(tool),
      });
      const effects = observed.requests.filter((request) => request.method !== "GET");
      expect(effects).toHaveLength(1);
      expect(effects[0]).toMatchObject({
        method: "PUT",
        url: `https://jira.example.invalid/context/rest/agile/1.0/${path}`,
        jiraExperimental: true,
      });
      expect(effects[0]?.bodyJson).toBe(bodyJson);
      expect(
        observed.requests
          .filter((request) => request.method === "GET")
          .every((request) => request.jiraExperimental === undefined),
      ).toBe(true);
      expect(observed.requests.at(-1)?.method).toBe("GET");
      expect(observed.result.data).toMatchObject({
        outcome,
        sprintIds: ["12"],
        sprintSynced: false,
      });
      expect(observed.result.isError).toBe(tool === "jira.unmap-all-sprints" ? true : undefined);
    },
  );
  it.each([false, true])(
    "serializes and independently confirms native refined-velocity value %s",
    async (value) => {
      const selected = BOARD_CONFIGURATION_CASES[1];
      const fixture = boardConfigurationTransportFixture(
        "/context/rest/api/2",
        "/context/rest/agile/1.0",
        selected,
        value,
      );
      const observed = await observeNativeJiraOperation(
        {
          tool: selected.tool,
          args: { ...selected.args, expectedValue: !value, value },
          parameters: { boardId: "7" },
        },
        {
          deployment: "data-center",
          baseUrl: "https://jira.example.invalid/context",
          http: async (request) => {
            const result =
              request.method === "GET" ? fixture.read(request) : fixture.write(request);
            if (result === undefined) throw new TypeError("Unexpected board setting route");
            return result;
          },
        },
      );
      expect(observed.requests.find(({ method }) => method === "PUT")?.bodyJson).toBe(
        JSON.stringify({ value }),
      );
      expect(observed.result.data).toMatchObject({
        outcome: "succeeded",
        refinedVelocityEnabled: value,
      });
      expect(fixture.snapshot()).toMatchObject({
        boardPresent: true,
        refinedVelocityEnabled: value,
        writes: 1,
      });
      expect(observed.requests.at(-1)?.url).toBe(
        "https://jira.example.invalid/context/rest/agile/1.0/board/7/settings/refined-velocity",
      );
    },
  );
  it("resolves estimation identity without updating issue history before reading the exact numeric target", async () => {
    const observed = await observeNativeJiraOperation(
      {
        tool: "jira.issue-estimation",
        args: { issueIdOrKey: "SYN-2", boardId: "7" },
      },
      {
        deployment: "data-center",
        baseUrl: "https://jira.example.invalid/context",
        http: remote(),
      },
    );
    expect(observed.requests.map(({ method, url }) => [method, url])).toEqual([
      [
        "GET",
        "https://jira.example.invalid/context/rest/agile/1.0/issue/SYN-2?fields=summary&updateHistory=false",
      ],
      [
        "GET",
        "https://jira.example.invalid/context/rest/agile/1.0/issue/10002/estimation?boardId=7",
      ],
    ]);
    expect(observed.result.data).toMatchObject({
      boardId: "7",
      issueId: "10002",
      issueKey: "SYN-2",
      value: 0,
    });
  });
  it.each(["jira.set-board-property", "jira.delete-sprint-property"] as const)(
    "confirms %s on the same Agile parent without converting false to absence",
    async (tool) => {
      const scenario = SCENARIOS.find((entry) => entry.tool === tool);
      if (scenario === undefined) throw new TypeError("Missing Agile property mutation fixture");
      const observed = await observeNativeJiraOperation(scenario, {
        deployment: "data-center",
        baseUrl: "https://jira.example.invalid/context",
        http: remote(tool),
      });
      expect(observed.requests.map(({ method }) => method)).toEqual([
        "GET",
        "GET",
        "GET",
        tool === "jira.set-board-property" ? "PUT" : "DELETE",
        "GET",
        "GET",
        "GET",
      ]);
      expect(observed.requests[0]?.url).toBe(observed.requests[4]?.url);
      expect(observed.result.data).toMatchObject({
        propertyKey: PROPERTY_FIXTURE_KEY,
        propertyPresent: tool === "jira.set-board-property",
      });
      expect(observed.requests[3]?.bodyJson).toBe(
        tool === "jira.set-board-property" ? "false" : undefined,
      );
    },
  );
  it("uses the actual Agile entity lookup and fixed property route without following self URLs", async () => {
    const observed = await observeNativeJiraOperation(
      { tool: "jira.board-property", args: { boardId: "7", propertyKey: "view ~settings" } },
      {
        deployment: "data-center",
        baseUrl: "https://jira.example.invalid/context",
        http: remote(),
      },
    );
    expect(observed.requests.map(({ method, url }) => [method, url])).toEqual([
      ["GET", "https://jira.example.invalid/context/rest/agile/1.0/board/7"],
      [
        "GET",
        "https://jira.example.invalid/context/rest/agile/1.0/board/7/properties/view%20~settings",
      ],
    ]);
    expect(observed.result.data).toMatchObject({
      boardId: "7",
      propertyKey: "view ~settings",
      items: expect.arrayContaining([{ path: "/a~1b~0c/0", kind: "boolean", booleanValue: false }]),
    });
    expect(JSON.stringify(observed.result.data)).not.toContain("untrusted.invalid");
  });
});
import { AGILE_PLANNING_FIXTURE_CASES as PLANNING_CASES } from "../../../../tests/support/jira-agile-planning-fixture.js";
import { agilePlanningTransportFixture } from "../../../../tests/support/jira-agile-planning-transport-fixture.js";
