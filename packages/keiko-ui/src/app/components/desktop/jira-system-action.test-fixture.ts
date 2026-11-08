import type {
  JiraGroupMutation,
  JiraIssueActionMutation,
  JiraMaintenanceMutation,
  JiraDirectoryAccessMutation,
  JiraSchemaMutation,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
import { configurationExchange } from "./jira-configuration-mutation.test-fixture";

type SystemOperation =
  | JiraGroupMutation
  | JiraIssueActionMutation
  | JiraMaintenanceMutation
  | JiraDirectoryAccessMutation
  | JiraSchemaMutation;
export interface SystemActionCase {
  readonly operation: SystemOperation;
  readonly args: CatalogJsonObject;
  readonly receipt: CatalogJsonObject;
  readonly confirmed?: true;
}
const ACTOR = { expectedActorKey: "actor-key" };
const RECEIPT = { userKey: "actor-key" };
const USER = { key: "target-key", name: "Target User" };
const GROUP = { ...ACTOR, groupName: "R&D team", acceptGlobalPermissionChange: true };
const GROUP_RECEIPT = { ...RECEIPT, groupName: "R&D team", groupPresent: true };
const ISSUE = { ...ACTOR, issueId: "10001", issueKey: "SYN-1" };
const ISSUE_RECEIPT = { ...RECEIPT, issueId: "10001", issueKey: "SYN-1" };
const MAINTENANCE = { ...ACTOR, confirmUnverifiedEffect: true };
const NODE = {
  nodeId: "node-a",
  state: "ACTIVE",
  alive: false,
  nodeBuildNumber: 113003,
  nodeVersion: "11.3.3",
  lastStateChangeTimestamp: 0,
};
const CLUSTER = {
  ...MAINTENANCE,
  expectedClusterState: {
    state: "READY_TO_UPGRADE",
    build: { buildNumber: 113003, version: "11.3.3" },
  },
};
const REINDEX = {
  taskState: "observed",
  type: "BACKGROUND",
  currentProgress: 0,
  success: false,
  finishTime: "native-time",
};
const FLAGS = { indexComments: false, indexChangeHistory: true, indexWorklogs: false };
export const SYSTEM_REVIEWED_ROLE = {
  key: "jira-software",
  groups: ["jira-users"],
  defaultGroups: ["jira-users"],
};
const ROLE = {
  expected: SYSTEM_REVIEWED_ROLE,
  value: { key: "jira-software", groups: [], defaultGroups: [] },
};
const DIRECTORY_ACTOR = { actorUserKey: "actor-key" };
const DIRECTORY_USER = { ...DIRECTORY_ACTOR, userKey: USER.key, username: USER.name };
const ACCESS = {
  ...ACTOR,
  user: USER,
  expectedApplicationRole: SYSTEM_REVIEWED_ROLE,
  acceptGlobalPermissionChange: true,
};
const COLUMNS = { ...ACTOR, user: USER, expectedColumns: ["summary", "status", "summary"] };
export const SYSTEM_REVIEWED_TYPE = {
  id: "1",
  name: "Task",
  description: null,
  subtask: false,
  avatarId: "10",
};
const OTHER_TYPE = { id: "2", name: "Story", description: "", subtask: false };
const LINK = { id: "7", name: "Blocks", inward: "is blocked by", outward: "blocks" };
const OTHER_LINK = { id: "8", name: "Relates", inward: "relates to", outward: "relates to" };
const LINK_VALUE = { name: "Requires", inward: "is required by", outward: "requires" };
const TERMS = [
  {
    originalName: "epic",
    originalNamePlural: "epics",
    newName: "epic",
    newNamePlural: "epics",
    isDefault: true,
  },
  {
    originalName: "sprint",
    originalNamePlural: "sprints",
    newName: "sprint",
    newNamePlural: "sprints",
    isDefault: true,
  },
];
export const SYSTEM_NOTIFICATION_DIGEST = "a".repeat(64);

/** Literal reviewed inputs and independent receipts; never generated from registry or presentation logic. */
export const SYSTEM_ACTION_CASES: readonly SystemActionCase[] = [
  {
    operation: "jira.create-group",
    args: { ...ACTOR, groupName: "New group" },
    receipt: { ...RECEIPT, groupName: "New group", groupPresent: true },
    confirmed: true,
  },
  {
    operation: "jira.delete-group",
    args: { ...GROUP, swapGroupName: "Replacement", confirmUnverifiedDeletion: true },
    receipt: { ...GROUP_RECEIPT, groupPresent: false, swapGroupName: "Replacement" },
  },
  {
    operation: "jira.add-group-user",
    args: { ...GROUP, user: USER, expectedObservedMembership: false },
    receipt: { ...GROUP_RECEIPT, targetUserKey: USER.key, requestedDirectMembership: true },
  },
  {
    operation: "jira.remove-group-user",
    args: { ...GROUP, user: USER, expectedObservedMembership: true },
    receipt: { ...GROUP_RECEIPT, targetUserKey: USER.key, requestedDirectMembership: false },
  },
  {
    operation: "jira.pin-comment",
    args: {
      ...ISSUE,
      commentId: "9007199254740993",
      expectedBody: "Reviewed comment",
      expectedVisibility: { type: "role", value: "Developers" },
    },
    receipt: { ...ISSUE_RECEIPT, commentId: "9007199254740993", commentPinned: true },
    confirmed: true,
  },
  {
    operation: "jira.notify-issue",
    args: {
      ...ISSUE,
      subject: "Delivery update",
      textBody: "Please review SYN-1.",
      users: [USER],
      confirmEmailSend: true,
    },
    receipt: {
      ...ISSUE_RECEIPT,
      notificationDigest: SYSTEM_NOTIFICATION_DIGEST,
      recipientUserKeys: [USER.key],
    },
  },
  {
    operation: "jira.request-cluster-index-snapshot",
    args: { ...MAINTENANCE, expectedNode: NODE },
    receipt: { ...RECEIPT, nodeId: "node-a" },
  },
  {
    operation: "jira.delete-cluster-node",
    args: { ...MAINTENANCE, expectedNode: { ...NODE, state: "OFFLINE" } },
    receipt: { ...RECEIPT, nodeId: "node-a" },
  },
  {
    operation: "jira.mark-cluster-node-offline",
    args: { ...MAINTENANCE, expectedNode: NODE },
    receipt: { ...RECEIPT, nodeId: "node-a" },
  },
  { operation: "jira.approve-cluster-upgrade", args: CLUSTER, receipt: RECEIPT },
  { operation: "jira.cancel-cluster-upgrade", args: CLUSTER, receipt: RECEIPT },
  { operation: "jira.retry-cluster-upgrade", args: CLUSTER, receipt: RECEIPT },
  { operation: "jira.start-cluster-upgrade", args: CLUSTER, receipt: RECEIPT },
  {
    operation: "jira.create-index-snapshot",
    args: { ...MAINTENANCE, expectedRunning: false },
    receipt: RECEIPT,
  },
  {
    operation: "jira.start-reindex",
    args: { ...MAINTENANCE, expectedReindex: REINDEX, type: "BACKGROUND_PREFERRED", ...FLAGS },
    receipt: RECEIPT,
  },
  {
    operation: "jira.reindex-issues",
    args: {
      ...MAINTENANCE,
      expectedIssues: [
        { issueId: "10001", issueKey: "SYN-1" },
        { issueId: "9223372036854775807", issueKey: "SYN-2" },
      ],
      ...FLAGS,
    },
    receipt: { ...RECEIPT, issueIds: ["10001", "9223372036854775807"] },
  },
  {
    operation: "jira.process-reindex-requests",
    args: { ...MAINTENANCE, expectedReindex: REINDEX },
    receipt: { ...RECEIPT, reindexRequestIds: ["7", "9223372036854775807"] },
  },
  {
    operation: "jira.run-upgrade",
    args: {
      ...MAINTENANCE,
      expectedUpgrade: {
        upgradeState: "result",
        upgradeOutcome: "SUCCESS",
        duration: 0,
        message: "",
      },
    },
    receipt: RECEIPT,
  },
  {
    operation: "jira.set-application-role",
    args: { ...ACTOR, role: ROLE, acceptGlobalPermissionChange: true },
    receipt: { ...DIRECTORY_ACTOR, applicationRoleKeys: ["jira-software"] },
  },
  {
    operation: "jira.set-application-roles",
    args: { ...ACTOR, roles: [ROLE], acceptGlobalPermissionChange: true },
    receipt: { ...DIRECTORY_ACTOR, applicationRoleKeys: ["jira-software"] },
  },
  {
    operation: "jira.add-user-application",
    args: ACCESS,
    receipt: {
      ...DIRECTORY_USER,
      applicationRoleKeys: ["jira-software"],
      applicationAccessRequested: true,
    },
  },
  {
    operation: "jira.remove-user-application",
    args: ACCESS,
    receipt: {
      ...DIRECTORY_USER,
      applicationRoleKeys: ["jira-software"],
      applicationAccessRequested: false,
    },
  },
  {
    operation: "jira.set-user-columns",
    args: { ...COLUMNS, columns: ["status", "summary", "status"] },
    receipt: { ...DIRECTORY_USER, columnIds: ["status", "summary", "status"] },
    confirmed: true,
  },
  {
    operation: "jira.reset-user-columns",
    args: COLUMNS,
    receipt: { ...DIRECTORY_USER, columnsResetRequested: true },
  },
  {
    operation: "jira.create-custom-field",
    args: {
      ...ACTOR,
      name: "Evidence",
      description: "",
      type: "com.atlassian.jira.plugin.system.customfieldtypes:textfield",
      searcherKey: "com.atlassian.jira.plugin.system.customfieldtypes:textsearcher",
      projectIds: ["10000"],
      issueTypeIds: ["1"],
    },
    receipt: { ...RECEIPT, fieldId: "customfield_9007199254740993", fieldPresent: true },
  },
  {
    operation: "jira.delete-custom-fields",
    args: {
      ...ACTOR,
      expectedFields: [{ id: "customfield_12", name: "Evidence", custom: true }],
      confirmUnverifiedDeletion: true,
    },
    receipt: { ...RECEIPT, fieldIds: ["customfield_12"], fieldPresent: false },
  },
  {
    operation: "jira.create-issue-type",
    args: { ...ACTOR, name: "New type", description: "", type: "standard" },
    receipt: { ...RECEIPT, issueTypeId: "9007199254740993", issueTypePresent: true },
  },
  {
    operation: "jira.update-issue-type",
    args: { ...ACTOR, expectedIssueType: SYSTEM_REVIEWED_TYPE, description: "" },
    receipt: { ...RECEIPT, issueTypeId: "1", issueTypePresent: true },
    confirmed: true,
  },
  {
    operation: "jira.delete-issue-type",
    args: {
      ...ACTOR,
      expectedIssueType: SYSTEM_REVIEWED_TYPE,
      expectedAlternative: OTHER_TYPE,
      confirmUnverifiedMigration: true,
    },
    receipt: { ...RECEIPT, issueTypeId: "1", replacementIssueTypeId: "2", issueTypePresent: false },
  },
  {
    operation: "jira.create-link-type",
    args: { ...ACTOR, ...LINK_VALUE },
    receipt: { ...RECEIPT, linkTypeId: "9007199254740993", linkTypePresent: true },
    confirmed: true,
  },
  {
    operation: "jira.update-link-type",
    args: { ...ACTOR, expectedLinkType: LINK, ...LINK_VALUE },
    receipt: { ...RECEIPT, linkTypeId: "7", linkTypePresent: true },
    confirmed: true,
  },
  {
    operation: "jira.delete-link-type",
    args: { ...ACTOR, expectedLinkType: LINK, confirmUnverifiedDeletion: true },
    receipt: { ...RECEIPT, linkTypeId: "7", linkTypePresent: false },
  },
  {
    operation: "jira.reset-link-type-order",
    args: { ...ACTOR, expectedLinkTypes: [LINK, OTHER_LINK], direction: "desc" },
    receipt: { ...RECEIPT, linkTypeIds: ["7", "8"] },
  },
  {
    operation: "jira.move-link-type",
    args: { ...ACTOR, expectedLinkTypes: [LINK, OTHER_LINK], linkTypeId: "8", newPosition: 1 },
    receipt: { ...RECEIPT, linkTypeId: "8", linkTypeIds: ["7", "8"] },
  },
  {
    operation: "jira.set-terminology",
    args: {
      ...ACTOR,
      expectedEntries: TERMS,
      entries: [{ originalName: "epic", newName: "initiative", newNamePlural: "initiatives" }],
    },
    receipt: { ...RECEIPT, terminologyNames: ["epic"] },
    confirmed: true,
  },
];
export function systemActionCase(operation: SystemOperation): SystemActionCase {
  const selected = SYSTEM_ACTION_CASES.find((entry) => entry.operation === operation);
  if (selected === undefined) throw new TypeError("Missing literal system-action UI case");
  return selected;
}
export function systemActionExchange(
  fixture: SystemActionCase,
  data?: CatalogJsonObject,
  index = 0,
  journal?: ChatToolExchange["mutationOutcome"],
): ChatToolExchange {
  const exchange = configurationExchange(
    fixture.operation.replace(/[.-]/gu, "_"),
    data ?? { ...fixture.receipt, outcome: "succeeded" },
    index,
    journal,
  );
  return { ...exchange, call: { ...exchange.call, arguments: fixture.args } };
}
