import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { SCREEN_CONFIGURATION_FIXTURE_CASES as screen, screenConfigurationTransportFixture } from "./jira-screen-configuration-fixture.js";
import { BOARD_CONFIGURATION_FIXTURE_CASES as board, boardConfigurationTransportFixture } from "./jira-board-configuration-fixture.js";
import { SPRINT_LIFECYCLE_FIXTURE_CASES as sprint } from "./jira-sprint-lifecycle-fixture.js";
import { sprintLifecycleTransportFixture } from "./jira-sprint-lifecycle-transport-fixture.js";

type ConfigurationMutation = (typeof screen)[number]["tool"] | (typeof board)[number]["tool"] | (typeof sprint)[number]["name"];
/** Gateway verification observes this independent actor; native-wire fixtures use their own actor. */
const ACTOR = "synthetic-key";
export const CONFIGURATION_ARGUMENTS: Readonly<Record<ConfigurationMutation, CatalogJsonObject>> = {
  "jira.replace-sprint": { ...sprint[0].args, expectedActorKey: ACTOR },
  "jira.delete-sprint": { ...sprint[1].args, expectedActorKey: ACTOR },
  "jira.swap-sprints": { ...sprint[2].args, expectedActorKey: ACTOR },
  "jira.unmap-sprints": { ...sprint[3].args, expectedActorKey: ACTOR },
  "jira.unmap-all-sprints": { ...sprint[4].args, expectedActorKey: ACTOR },
  "jira.add-default-screen-field": screen[0].args,
  "jira.add-screen-tab-field": screen[1].args,
  "jira.remove-screen-tab-field": screen[2].args,
  "jira.move-screen-tab-field": screen[3].args,
  "jira.set-screen-field-show-when-empty": screen[4].args,
  "jira.move-screen-tab": screen[5].args,
  "jira.delete-board": { ...board[0].args, expectedActorKey: ACTOR },
  "jira.set-board-refined-velocity": { ...board[1].args, expectedActorKey: ACTOR },
};
export const CONFIGURATION_RECEIPTS: Readonly<Record<ConfigurationMutation, CatalogJsonObject>> = {
  "jira.replace-sprint": { userKey: ACTOR, sprintId: "11", originBoardId: "7", sprintPresent: true },
  "jira.delete-sprint": { userKey: ACTOR, sprintId: "11", originBoardId: "7", sprintPresent: false },
  "jira.swap-sprints": { userKey: ACTOR, sprintId: "11", originBoardId: "7", swapSprintId: "12" },
  "jira.unmap-sprints": { userKey: ACTOR, sprintIds: ["12"], sprintSynced: false },
  "jira.unmap-all-sprints": { userKey: ACTOR, sprintIds: ["12"], sprintSynced: false, allSprints: true },
  "jira.add-default-screen-field": { fieldId: "customfield_10001", fieldPresent: true },
  "jira.add-screen-tab-field": { screenId: "11", tabId: "21", fieldId: "customfield_10001", fieldPresent: true },
  "jira.remove-screen-tab-field": { screenId: "11", tabId: "21", fieldId: "description", fieldPresent: false },
  "jira.move-screen-tab-field": { screenId: "11", tabId: "21", fieldId: "summary" },
  "jira.set-screen-field-show-when-empty": { screenId: "11", tabId: "21", fieldId: "summary", showWhenEmpty: true },
  "jira.move-screen-tab": { screenId: "11", tabId: "21" },
  "jira.delete-board": { boardId: "7", filterId: "42", userKey: ACTOR, boardPresent: false },
  "jira.set-board-refined-velocity": { boardId: "7", filterId: "42", userKey: ACTOR, refinedVelocityEnabled: false },
};
export const CONFIGURATION_REMOTE_STATE: Readonly<Record<ConfigurationMutation, object>> = {
  "jira.replace-sprint": { lifecycle: { visibleSprintIds: ["11", "12"], sprints: [{ id: "11", synced: false }, { id: "12", synced: true }] } },
  "jira.delete-sprint": { lifecycle: { visibleSprintIds: ["12"], sprints: [{ id: "12", synced: true }] } },
  "jira.swap-sprints": { lifecycle: { visibleSprintIds: ["12", "11"], sprints: [{ id: "11", synced: false }, { id: "12", synced: true }] } },
  "jira.unmap-sprints": { lifecycle: { visibleSprintIds: ["11", "12"], sprints: [{ id: "11", synced: false }, { id: "12", synced: false }] } },
  "jira.unmap-all-sprints": { lifecycle: { visibleSprintIds: ["11", "12"], sprints: [{ id: "11", synced: false }, { id: "12", synced: false }] } },
  "jira.add-default-screen-field": { lifecycle: { fieldIds: ["summary", "description"], tabIds: ["21", "22"], writes: 1 } },
  "jira.add-screen-tab-field": { lifecycle: { fieldIds: ["summary", "description", "customfield_10001"], tabIds: ["21", "22"], writes: 1 } },
  "jira.remove-screen-tab-field": { lifecycle: { fieldIds: ["summary"], tabIds: ["21", "22"], writes: 1 } },
  "jira.move-screen-tab-field": { lifecycle: { fieldIds: ["description", "summary"], tabIds: ["21", "22"], writes: 1 } },
  "jira.set-screen-field-show-when-empty": { lifecycle: { fieldIds: ["summary", "description"], tabIds: ["21", "22"], writes: 1 } },
  "jira.move-screen-tab": { lifecycle: { fieldIds: ["summary", "description"], tabIds: ["22", "21"], writes: 1 } },
  "jira.delete-board": { lifecycle: { boardPresent: false, refinedVelocityEnabled: true, writes: 1 } },
  "jira.set-board-refined-velocity": { lifecycle: { boardPresent: true, refinedVelocityEnabled: false, writes: 1 } },
};
export const CONFIGURATION_EXPECTED_OUTCOMES = {
  "jira.replace-sprint": "succeeded",
  "jira.delete-sprint": "succeeded-unconfirmed",
  "jira.swap-sprints": "succeeded-unconfirmed",
  "jira.unmap-sprints": "succeeded",
  "jira.unmap-all-sprints": "succeeded-unconfirmed",
  "jira.add-default-screen-field": "succeeded-unconfirmed",
  "jira.add-screen-tab-field": "succeeded",
  "jira.remove-screen-tab-field": "succeeded",
  "jira.move-screen-tab-field": "succeeded",
  "jira.set-screen-field-show-when-empty": "succeeded",
  "jira.move-screen-tab": "succeeded",
  "jira.delete-board": "succeeded-unconfirmed",
  "jira.set-board-refined-velocity": "succeeded",
} as const satisfies Readonly<Record<ConfigurationMutation, "succeeded" | "succeeded-unconfirmed">>;
export function expectedConfigurationOutcome(operation: string): "succeeded" | "succeeded-unconfirmed" | undefined {
  const outcomes: Readonly<Record<string, "succeeded" | "succeeded-unconfirmed">> = CONFIGURATION_EXPECTED_OUTCOMES;
  return Object.hasOwn(outcomes, operation) ? outcomes[operation] : undefined;
}
/** Adds these sources to the existing test-only lifecycle controller, not a second runtime. */
export function configurationTransportController(operation: string | undefined): ReturnType<typeof screenConfigurationTransportFixture> | ReturnType<typeof boardConfigurationTransportFixture> | ReturnType<typeof sprintLifecycleTransportFixture> | undefined {
  const selectedSprint = sprint.find((item) => item.name === operation);
  if (selectedSprint !== undefined) return sprintLifecycleTransportFixture("/context/rest/api/2", "/context/rest/agile/1.0", selectedSprint, ACTOR);
  const selectedScreen = screen.find((item) => item.tool === operation);
  if (selectedScreen !== undefined) return screenConfigurationTransportFixture("/context/rest/api/2", selectedScreen);
  const selectedBoard = board.find((item) => item.tool === operation);
  return selectedBoard === undefined ? undefined
    : boardConfigurationTransportFixture("/context/rest/api/2", "/context/rest/agile/1.0", selectedBoard);
}
