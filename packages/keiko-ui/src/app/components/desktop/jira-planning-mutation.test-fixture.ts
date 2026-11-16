import type { ChatToolWriteApprovalView } from "@oscharko-dev/keiko-contracts";
import type { JiraMutationReceipt } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
type PlanningOperation = Extract<
  ChatToolWriteApprovalView,
  { kind: "jira-chat-write" }
>["operation"];
type PlanningReceipt = CatalogJsonObject & JiraMutationReceipt;
interface PlanningCase {
  readonly operation: PlanningOperation;
  readonly args: CatalogJsonObject;
  readonly receipt: PlanningReceipt;
}
export const PLANNING_VALUE = [
  { path: "", kind: "object", childCount: 5 },
  { path: "/empty", kind: "string", textValue: "" },
  { path: "/false", kind: "boolean", booleanValue: false },
  { path: "/zero", kind: "number", numberValue: 0 },
  { path: "/null", kind: "null" },
  { path: "/a~1b", kind: "array", childCount: 0 },
];
const VERSION_CONTEXT = {
  expectedActorKey: "actor-key",
  expectedProjectId: "10000",
  versionId: "9007199254740993",
  expectedVersionSnapshot: {
    name: "Reviewed release",
    description: "",
    startDate: null,
    releaseDate: null,
    archived: false,
    released: false,
  },
  expectedLinks: [{ globalId: "reviewed-link", valueNodes: PLANNING_VALUE }],
};
const VERSION_RECEIPT = {
  versionId: VERSION_CONTEXT.versionId,
  projectId: "10000",
  projectKey: "SYN",
  userKey: "actor-key",
};
const BOARD = {
  expectedActorKey: "actor-key",
  boardId: "7",
  expectedBoardName: "Reviewed planning board",
};
const RANK = {
  ...BOARD,
  rankCustomFieldId: "10002",
  direction: "before",
  expectedAnchorRank: null,
};
const RANK_RECEIPT = {
  userKey: "actor-key",
  boardId: "7",
  fieldId: "customfield_10002",
  issueIds: ["10001"],
  issueKeys: ["SYN-1"],
  anchorIssueId: "10002",
  anchorIssueKey: "SYN-2",
  rankDirection: "before",
  outcome: "succeeded-unconfirmed",
  reason: "unavailable",
} satisfies PlanningReceipt;
const CATEGORY = { id: "9007199254740993", name: "Reviewed category", description: "" };
export const PLANNING_CASES: readonly PlanningCase[] = [
  {
    operation: "jira.upsert-version-remote-link",
    args: {
      ...VERSION_CONTEXT,
      globalId: "new-link",
      valueNodes: [
        { path: "", kind: "object", childCount: 1 },
        { path: "/globalId", kind: "string", textValue: "new-link" },
      ],
    },
    receipt: { ...VERSION_RECEIPT, globalId: "new-link", linkPresent: true, outcome: "succeeded" },
  },
  {
    operation: "jira.upsert-version-remote-link-by-global-id",
    args: {
      ...VERSION_CONTEXT,
      globalId: "reviewed-link",
      valueNodes: [{ path: "", kind: "boolean", booleanValue: false }],
    },
    receipt: {
      ...VERSION_RECEIPT,
      globalId: "reviewed-link",
      linkPresent: true,
      outcome: "succeeded",
    },
  },
  {
    operation: "jira.delete-version-remote-link",
    args: { ...VERSION_CONTEXT, globalId: "reviewed-link" },
    receipt: {
      ...VERSION_RECEIPT,
      globalId: "reviewed-link",
      linkPresent: false,
      outcome: "succeeded",
    },
  },
  {
    operation: "jira.delete-version-remote-links",
    args: { ...VERSION_CONTEXT, confirmAll: true },
    receipt: {
      ...VERSION_RECEIPT,
      globalIds: ["reviewed-link"],
      linkPresent: false,
      outcome: "succeeded",
    },
  },
  {
    operation: "jira.epic-remove-issues",
    args: {
      expectedActorKey: "actor-key",
      issues: [
        { issueIdOrKey: "SYN-1", expectedEpic: null },
        { issueIdOrKey: "SYN-2", expectedEpic: { id: "10003", key: "SYN-3" } },
      ],
    },
    receipt: {
      userKey: "actor-key",
      issueIds: ["10001", "10002"],
      issueKeys: ["SYN-1", "SYN-2"],
      epicPresent: false,
      outcome: "succeeded",
    },
  },
  {
    operation: "jira.rank-epic",
    args: {
      ...RANK,
      epicIdOrKey: "SYN-1",
      expectedRank: "opaque-rank",
      anchorEpicIdOrKey: "SYN-2",
    },
    receipt: RANK_RECEIPT,
  },
  {
    operation: "jira.rank-issues",
    args: {
      ...RANK,
      issues: [{ issueIdOrKey: "SYN-1", expectedRank: "opaque-rank" }],
      anchorIssueIdOrKey: "SYN-2",
    },
    receipt: RANK_RECEIPT,
  },
  {
    operation: "jira.set-issue-estimation",
    args: {
      ...BOARD,
      issueIdOrKey: "SYN-1",
      fieldId: "timeoriginalestimate",
      expectedValue: null,
      unit: "minutes",
      value: "0",
    },
    receipt: {
      userKey: "actor-key",
      boardId: "7",
      fieldId: "timeoriginalestimate",
      issueId: "10001",
      issueKey: "SYN-1",
      estimationValue: 0,
      estimationUnit: "seconds",
      outcome: "succeeded",
    },
  },
  {
    operation: "jira.create-project-category",
    args: { expectedActorKey: "actor-key", name: "Requested category", description: "" },
    receipt: {
      userKey: "actor-key",
      categoryId: CATEGORY.id,
      categoryPresent: true,
      outcome: "succeeded",
    },
  },
  {
    operation: "jira.update-project-category",
    args: {
      expectedActorKey: "actor-key",
      expectedCategory: CATEGORY,
      name: "Requested category",
      description: "",
    },
    receipt: {
      userKey: "actor-key",
      categoryId: CATEGORY.id,
      categoryPresent: true,
      outcome: "succeeded",
    },
  },
  {
    operation: "jira.delete-project-category",
    args: {
      expectedActorKey: "actor-key",
      expectedCategory: CATEGORY,
      confirmUnverifiedDeletion: true,
    },
    receipt: {
      userKey: "actor-key",
      categoryId: CATEGORY.id,
      categoryPresent: false,
      outcome: "succeeded-unconfirmed",
      reason: "unavailable",
    },
  },
];
