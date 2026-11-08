import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { VERSION_LINK_MUTATION_CASES as version } from "./jira-version-link-mutation-fixture.js";
import { PROJECT_CATEGORY_FIXTURE_CASES as category } from "./jira-project-category-fixture.js";
import { AGILE_PLANNING_FIXTURE_CASES as agile } from "./jira-agile-planning-fixture.js";
import { versionLinkTransportFixture, projectCategoryTransportFixture } from "./jira-reviewed-platform-transport-fixture.js";
import { agilePlanningTransportFixture } from "./jira-agile-planning-transport-fixture.js";

type PlanningMutation = (typeof version)[number]["tool"] | (typeof category)[number]["name"] | (typeof agile)[number]["name"];
const ACTOR = "synthetic-key";
const VERSION = { versionId: "81", projectId: "10000", projectKey: "SYN", userKey: ACTOR };
const RANK = { userKey: ACTOR, boardId: "7", fieldId: "customfield_10019", issueIds: ["10001"], issueKeys: ["SYN-1"],
  anchorIssueId: "10002", anchorIssueKey: "SYN-2", rankDirection: "before" };
/** These literal fixtures are independent of production registries and adapter results. */
export const PLANNING_ARGUMENTS: Readonly<Record<PlanningMutation, CatalogJsonObject>> = {
  "jira.upsert-version-remote-link": { ...version[0].args, expectedActorKey: ACTOR },
  "jira.upsert-version-remote-link-by-global-id": { ...version[1].args, expectedActorKey: ACTOR },
  "jira.delete-version-remote-link": { ...version[2].args, expectedActorKey: ACTOR },
  "jira.delete-version-remote-links": { ...version[3].args, expectedActorKey: ACTOR },
  "jira.create-project-category": { ...category[0].args, expectedActorKey: ACTOR },
  "jira.update-project-category": { ...category[1].args, expectedActorKey: ACTOR },
  "jira.delete-project-category": { ...category[2].args, expectedActorKey: ACTOR },
  "jira.epic-remove-issues": { ...agile[0].args, expectedActorKey: ACTOR },
  "jira.rank-epic": { ...agile[1].args, expectedActorKey: ACTOR },
  "jira.rank-issues": { ...agile[2].args, expectedActorKey: ACTOR },
  "jira.set-issue-estimation": { ...agile[3].args, expectedActorKey: ACTOR },
};
export const PLANNING_RECEIPTS: Readonly<Record<PlanningMutation, CatalogJsonObject>> = {
  "jira.upsert-version-remote-link": { ...VERSION, globalId: "release:link", linkPresent: true },
  "jira.upsert-version-remote-link-by-global-id": { ...VERSION, globalId: "release:link", linkPresent: true },
  "jira.delete-version-remote-link": { ...VERSION, globalId: "release:link", linkPresent: false },
  "jira.delete-version-remote-links": { ...VERSION, globalIds: ["release:link", "other:link"], linkPresent: false },
  "jira.create-project-category": { userKey: ACTOR, categoryId: "9007199254740993", categoryPresent: true },
  "jira.update-project-category": { userKey: ACTOR, categoryId: "7", categoryPresent: true },
  "jira.delete-project-category": { userKey: ACTOR, categoryId: "7", categoryPresent: false },
  "jira.epic-remove-issues": { userKey: ACTOR, issueIds: ["10001"], issueKeys: ["SYN-1"], epicPresent: false },
  "jira.rank-epic": RANK,
  "jira.rank-issues": RANK,
  "jira.set-issue-estimation": { userKey: ACTOR, boardId: "7", fieldId: "customfield_10016", issueId: "10001", issueKey: "SYN-1", estimationValue: 5, estimationUnit: "board-number" },
};
export const PLANNING_REMOTE_STATE: Readonly<Record<PlanningMutation, object>> = {
  "jira.upsert-version-remote-link": { lifecycle: { links: [{ globalId: "release:link", value: { globalId: "release:link", flag: true } }, { globalId: "other:link", value: null }], writes: 1 } },
  "jira.upsert-version-remote-link-by-global-id": { lifecycle: { links: [{ globalId: "release:link", value: false }, { globalId: "other:link", value: null }], writes: 1 } },
  "jira.delete-version-remote-link": { lifecycle: { links: [{ globalId: "other:link", value: null }], writes: 1 } },
  "jira.delete-version-remote-links": { lifecycle: { links: [], writes: 1 } },
  "jira.create-project-category": { lifecycle: [{ id: "7", name: "Delivery", description: "Current category" }, { id: "9007199254740993", name: "Planning", description: "Created category" }] },
  "jira.update-project-category": { lifecycle: [{ id: "7", name: "Delivery revised", description: "" }] },
  "jira.delete-project-category": { lifecycle: [] },
  "jira.epic-remove-issues": { lifecycle: { issueEpic: null, issueRank: "0|first:", estimate: 3 } },
  "jira.rank-epic": { lifecycle: { issueEpic: "SYN-3", issueRank: "0|native-new:", estimate: 3 } },
  "jira.rank-issues": { lifecycle: { issueEpic: "SYN-3", issueRank: "0|native-new:", estimate: 3 } },
  "jira.set-issue-estimation": { lifecycle: { issueEpic: "SYN-3", issueRank: "0|first:", estimate: 5 } },
};
export const PLANNING_EXPECTED_OUTCOMES = {
  "jira.upsert-version-remote-link": "succeeded",
  "jira.upsert-version-remote-link-by-global-id": "succeeded",
  "jira.delete-version-remote-link": "succeeded",
  "jira.delete-version-remote-links": "succeeded",
  "jira.create-project-category": "succeeded",
  "jira.update-project-category": "succeeded",
  "jira.delete-project-category": "succeeded-unconfirmed",
  "jira.epic-remove-issues": "succeeded",
  "jira.rank-epic": "succeeded-unconfirmed",
  "jira.rank-issues": "succeeded-unconfirmed",
  "jira.set-issue-estimation": "succeeded",
} as const satisfies Readonly<Record<PlanningMutation, "succeeded" | "succeeded-unconfirmed">>;
export function expectedPlanningOutcome(operation: string): "succeeded" | "succeeded-unconfirmed" | undefined {
  const outcomes: Readonly<Record<string, "succeeded" | "succeeded-unconfirmed">> = PLANNING_EXPECTED_OUTCOMES;
  return Object.hasOwn(outcomes, operation) ? outcomes[operation] : undefined;
}
export function planningTransportController(operation: string | undefined): ReturnType<typeof versionLinkTransportFixture> | undefined {
  const selectedVersion = version.find((item) => item.tool === operation);
  if (selectedVersion !== undefined) return versionLinkTransportFixture("/context/rest/api/2", selectedVersion, ACTOR);
  const selectedCategory = category.find((item) => item.name === operation);
  if (selectedCategory !== undefined) return projectCategoryTransportFixture("/context/rest/api/2", selectedCategory, ACTOR);
  const selectedAgile = agile.find((item) => item.name === operation);
  return selectedAgile === undefined ? undefined
    : agilePlanningTransportFixture("/context/rest/api/2", "/context/rest/agile/1.0", selectedAgile, ACTOR);
}
