import { jiraManagedScenarios, type JiraManagedScenario } from "./jira-managed-scenario.js";
import { VERSION_LINK_MUTATION_CASES as version } from "./jira-version-link-mutation-fixture.js";
import { PROJECT_CATEGORY_FIXTURE_CASES as category } from "./jira-project-category-fixture.js";
import { AGILE_PLANNING_FIXTURE_CASES as agile } from "./jira-agile-planning-fixture.js";
import {
  versionLinkTransportFixture,
  projectCategoryTransportFixture,
} from "./jira-reviewed-platform-transport-fixture.js";
import { agilePlanningTransportFixture } from "./jira-agile-planning-transport-fixture.js";

type PlanningMutation =
  | (typeof version)[number]["tool"]
  | (typeof category)[number]["name"]
  | (typeof agile)[number]["name"];
const ACTOR = "synthetic-key";
const VERSION = { versionId: "81", projectId: "10000", projectKey: "SYN", userKey: ACTOR };
const RANK = {
  userKey: ACTOR,
  boardId: "7",
  fieldId: "customfield_10019",
  issueIds: ["10001"],
  issueKeys: ["SYN-1"],
  anchorIssueId: "10002",
  anchorIssueKey: "SYN-2",
  rankDirection: "before",
};
/** These literal fixtures are independent of production registries and adapter results. */
const SCENARIOS = {
  "jira.upsert-version-remote-link": {
    args: version[0].args,
    receipt: { ...VERSION, globalId: "release:link", linkPresent: true },
    remoteState: {
      lifecycle: {
        links: [
          { globalId: "release:link", value: { globalId: "release:link", flag: true } },
          { globalId: "other:link", value: null },
        ],
        writes: 1,
      },
    },
    outcome: "succeeded",
  },
  "jira.upsert-version-remote-link-by-global-id": {
    args: version[1].args,
    receipt: { ...VERSION, globalId: "release:link", linkPresent: true },
    remoteState: {
      lifecycle: {
        links: [
          { globalId: "release:link", value: false },
          { globalId: "other:link", value: null },
        ],
        writes: 1,
      },
    },
    outcome: "succeeded",
  },
  "jira.delete-version-remote-link": {
    args: version[2].args,
    receipt: { ...VERSION, globalId: "release:link", linkPresent: false },
    remoteState: { lifecycle: { links: [{ globalId: "other:link", value: null }], writes: 1 } },
    outcome: "succeeded",
  },
  "jira.delete-version-remote-links": {
    args: version[3].args,
    receipt: { ...VERSION, globalIds: ["release:link", "other:link"], linkPresent: false },
    remoteState: { lifecycle: { links: [], writes: 1 } },
    outcome: "succeeded",
  },
  "jira.create-project-category": {
    args: category[0].args,
    receipt: { userKey: ACTOR, categoryId: "9007199254740993", categoryPresent: true },
    remoteState: {
      lifecycle: [
        { id: "7", name: "Delivery", description: "Current category" },
        { id: "9007199254740993", name: "Planning", description: "Created category" },
      ],
    },
    outcome: "succeeded",
  },
  "jira.update-project-category": {
    args: category[1].args,
    receipt: { userKey: ACTOR, categoryId: "7", categoryPresent: true },
    remoteState: { lifecycle: [{ id: "7", name: "Delivery revised", description: "" }] },
    outcome: "succeeded",
  },
  "jira.delete-project-category": {
    args: category[2].args,
    receipt: { userKey: ACTOR, categoryId: "7", categoryPresent: false },
    remoteState: { lifecycle: [] },
    outcome: "succeeded-unconfirmed",
  },
  "jira.epic-remove-issues": {
    args: agile[0].args,
    receipt: { userKey: ACTOR, issueIds: ["10001"], issueKeys: ["SYN-1"], epicPresent: false },
    remoteState: { lifecycle: { issueEpic: null, issueRank: "0|first:", estimate: 3 } },
    outcome: "succeeded",
  },
  "jira.rank-epic": {
    args: agile[1].args,
    receipt: RANK,
    remoteState: { lifecycle: { issueEpic: "SYN-3", issueRank: "0|native-new:", estimate: 3 } },
    outcome: "succeeded-unconfirmed",
  },
  "jira.rank-issues": {
    args: agile[2].args,
    receipt: RANK,
    remoteState: { lifecycle: { issueEpic: "SYN-3", issueRank: "0|native-new:", estimate: 3 } },
    outcome: "succeeded-unconfirmed",
  },
  "jira.set-issue-estimation": {
    args: agile[3].args,
    receipt: {
      userKey: ACTOR,
      boardId: "7",
      fieldId: "customfield_10016",
      issueId: "10001",
      issueKey: "SYN-1",
      estimationValue: 5,
      estimationUnit: "board-number",
    },
    remoteState: { lifecycle: { issueEpic: "SYN-3", issueRank: "0|first:", estimate: 5 } },
    outcome: "succeeded",
  },
} satisfies Readonly<Record<PlanningMutation, JiraManagedScenario>>;
export const {
  arguments: PLANNING_ARGUMENTS,
  receipts: PLANNING_RECEIPTS,
  remoteState: PLANNING_REMOTE_STATE,
  outcomes: PLANNING_EXPECTED_OUTCOMES,
  expectedOutcome: expectedPlanningOutcome,
} = jiraManagedScenarios(SCENARIOS, ACTOR);

export function planningTransportController(
  operation: string | undefined,
): ReturnType<typeof versionLinkTransportFixture> | undefined {
  const selectedVersion = version.find((item) => item.tool === operation);
  if (selectedVersion !== undefined)
    return versionLinkTransportFixture("/context/rest/api/2", selectedVersion, ACTOR);
  const selectedCategory = category.find((item) => item.name === operation);
  if (selectedCategory !== undefined)
    return projectCategoryTransportFixture("/context/rest/api/2", selectedCategory, ACTOR);
  const selectedAgile = agile.find((item) => item.name === operation);
  return selectedAgile === undefined
    ? undefined
    : agilePlanningTransportFixture(
        "/context/rest/api/2",
        "/context/rest/agile/1.0",
        selectedAgile,
        ACTOR,
      );
}
