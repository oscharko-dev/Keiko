import { partialJiraReadPage } from "./jira-result.test-fixture";
import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { ChatToolWriteApprovalView } from "@oscharko-dev/keiko-contracts";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";

export type ConfigurationOperation = Extract<
  ChatToolWriteApprovalView,
  { kind: "jira-chat-write" }
>["operation"];
interface ConfigurationCase {
  readonly operation: ConfigurationOperation;
  readonly args: CatalogJsonObject;
  readonly receipt: CatalogJsonObject;
}
const CONFIGURATION_TABS = [
  { id: "11", name: "Overview tab" },
  { id: "12", name: "Detail tab" },
];
export const CONFIGURATION_FIELDS = [
  { id: "summary", name: "Summary", type: "string", showWhenEmpty: false },
  { id: "customfield_10100", name: "Acceptance", type: null, showWhenEmpty: null },
];
const CONTEXT = {
  screenId: "9007199254740993",
  expectedScreenName: "Reviewed screen",
  tabId: "12",
  expectedTabs: CONFIGURATION_TABS,
};
const FIELDS = { ...CONTEXT, fieldId: "customfield_10100", expectedFields: CONFIGURATION_FIELDS };
const SCREEN = { screenId: CONTEXT.screenId, tabId: CONTEXT.tabId };
const BOARD = {
  boardId: "7",
  expectedActorKey: "actor-key",
  expectedBoardName: "Reviewed board",
  expectedBoardType: "scrum",
  expectedFilterId: "42",
};
export const CONFIGURATION_SPRINT = {
  id: "51",
  originBoardId: "7",
  name: "Reviewed sprint",
  state: "future",
  startDate: null,
  endDate: null,
  goal: "",
  autoStartStop: false,
  synced: false,
  incompleteIssuesDestinationId: null,
};
const OTHER_SPRINT = {
  ...CONFIGURATION_SPRINT,
  id: "52",
  name: "Reviewed other sprint",
  synced: true,
};
const SPRINT_CONTEXT = {
  expectedActorKey: "actor-key",
  sprintId: "51",
  expectedSprint: CONFIGURATION_SPRINT,
};
export const CONFIGURATION_CASES: readonly ConfigurationCase[] = [
  {
    operation: "jira.add-default-screen-field",
    args: { fieldId: "summary", expectedFieldName: "Summary", acceptUnverifiedDefault: true },
    receipt: {
      fieldId: "summary",
      fieldPresent: true,
      outcome: "succeeded-unconfirmed",
      reason: "unavailable",
    },
  },
  {
    operation: "jira.add-screen-tab-field",
    args: { ...FIELDS, fieldId: "duedate", expectedFieldName: "Due date" },
    receipt: { ...SCREEN, fieldId: "duedate", fieldPresent: true, outcome: "succeeded" },
  },
  {
    operation: "jira.remove-screen-tab-field",
    args: FIELDS,
    receipt: { ...SCREEN, fieldId: FIELDS.fieldId, fieldPresent: false, outcome: "succeeded" },
  },
  {
    operation: "jira.move-screen-tab-field",
    args: { ...FIELDS, position: "First" },
    receipt: { ...SCREEN, fieldId: FIELDS.fieldId, outcome: "succeeded" },
  },
  {
    operation: "jira.set-screen-field-show-when-empty",
    args: { ...FIELDS, showWhenEmpty: false },
    receipt: { ...SCREEN, fieldId: FIELDS.fieldId, showWhenEmpty: false, outcome: "succeeded" },
  },
  {
    operation: "jira.move-screen-tab",
    args: { ...CONTEXT, position: 0 },
    receipt: { ...SCREEN, outcome: "succeeded" },
  },
  {
    operation: "jira.delete-board",
    args: BOARD,
    receipt: {
      boardId: "7",
      filterId: "42",
      userKey: "actor-key",
      boardPresent: false,
      outcome: "succeeded-unconfirmed",
      reason: "unavailable",
    },
  },
  {
    operation: "jira.set-board-refined-velocity",
    args: { ...BOARD, expectedValue: true, value: false },
    receipt: {
      boardId: "7",
      filterId: "42",
      userKey: "actor-key",
      refinedVelocityEnabled: false,
      outcome: "succeeded",
    },
  },
  {
    operation: "jira.replace-sprint",
    args: {
      ...SPRINT_CONTEXT,
      replacement: {
        name: "New sprint name",
        state: "future",
        startDate: null,
        endDate: null,
        goal: null,
        autoStartStop: false,
        incompleteIssuesDestinationId: null,
      },
    },
    receipt: {
      sprintId: "51",
      originBoardId: "7",
      userKey: "actor-key",
      sprintPresent: true,
      outcome: "succeeded",
    },
  },
  {
    operation: "jira.delete-sprint",
    args: SPRINT_CONTEXT,
    receipt: {
      sprintId: "51",
      originBoardId: "7",
      userKey: "actor-key",
      sprintPresent: false,
      outcome: "succeeded-unconfirmed",
      reason: "unavailable",
    },
  },
  {
    operation: "jira.swap-sprints",
    args: {
      ...SPRINT_CONTEXT,
      swapSprintId: "52",
      expectedSwapSprint: OTHER_SPRINT,
      expectedVisibleSprintIds: ["51", "52"],
    },
    receipt: {
      sprintId: "51",
      originBoardId: "7",
      userKey: "actor-key",
      swapSprintId: "52",
      outcome: "succeeded-unconfirmed",
      reason: "unavailable",
    },
  },
  {
    operation: "jira.unmap-sprints",
    args: { expectedActorKey: "actor-key", expectedSprints: [OTHER_SPRINT] },
    receipt: { userKey: "actor-key", sprintIds: ["52"], sprintSynced: false, outcome: "succeeded" },
  },
  {
    operation: "jira.unmap-all-sprints",
    args: {
      expectedActorKey: "actor-key",
      expectedSprints: [OTHER_SPRINT],
      confirmInstanceWide: true,
    },
    receipt: {
      userKey: "actor-key",
      sprintIds: ["52"],
      sprintSynced: false,
      allSprints: true,
      outcome: "succeeded-unconfirmed",
      reason: "unavailable",
    },
  },
];
export function configurationExchange(
  name: string,
  data: CatalogJsonObject,
  index = 0,
  mutationOutcome?: ChatToolExchange["mutationOutcome"],
): ChatToolExchange {
  return {
    call: { id: `configuration-${index}`, name, arguments: {} },
    ...(mutationOutcome === undefined ? {} : { mutationOutcome }),
    result: {
      schemaVersion: 1,
      invocationId: `configuration-${index}`,
      toolRef: null,
      projectionDigest: null,
      effectStarted: true,
      metrics: { inputBytes: 10, outputBytes: 10, resultCount: 1, durationMs: 10 },
      status: "completed",
      reason: "none",
      page: partialJiraReadPage(name),
      data,
    },
  };
}
