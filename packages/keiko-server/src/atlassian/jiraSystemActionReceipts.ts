import { jiraPropertyUserText, maintenancePathNode } from "@oscharko-dev/keiko-connectors";
import {
  JIRA_MAINTENANCE_MUTATIONS,
  isSafeAtlassianIdentifier,
  type JiraMutationOperation,
  type JiraMutationReceipt,
  type JiraGroupMutation,
  type JiraIssueActionMutation,
  type JiraMaintenanceMutation,
  type JiraDirectoryAccessMutation,
  type JiraSchemaMutation,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { TOOL_CATALOG_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";

const GROUP = ["userKey", "groupName", "groupPresent"] as const;
const GROUP_USER = [...GROUP, "targetUserKey", "requestedDirectMembership"] as const;
const ISSUE = ["userKey", "issueId", "issueKey"] as const;
const USER = ["actorUserKey", "userKey", "username"] as const;
const NODE = ["userKey", "nodeId"] as const;
const ACTOR = ["userKey"] as const;
export const JIRA_SYSTEM_ACTION_RECEIPTS = {
  "jira.create-group": GROUP,
  "jira.delete-group": GROUP,
  "jira.add-group-user": GROUP_USER,
  "jira.remove-group-user": GROUP_USER,
  "jira.pin-comment": [...ISSUE, "commentId", "commentPinned"],
  "jira.notify-issue": [...ISSUE, "notificationDigest", "recipientUserKeys"],
  "jira.request-cluster-index-snapshot": NODE,
  "jira.delete-cluster-node": NODE,
  "jira.mark-cluster-node-offline": NODE,
  "jira.approve-cluster-upgrade": ACTOR,
  "jira.cancel-cluster-upgrade": ACTOR,
  "jira.retry-cluster-upgrade": ACTOR,
  "jira.start-cluster-upgrade": ACTOR,
  "jira.create-index-snapshot": ACTOR,
  "jira.start-reindex": ACTOR,
  "jira.reindex-issues": [...ACTOR, "issueIds"],
  "jira.process-reindex-requests": [...ACTOR, "reindexRequestIds"],
  "jira.run-upgrade": ACTOR,
  "jira.set-application-role": ["actorUserKey", "applicationRoleKeys"],
  "jira.set-application-roles": ["actorUserKey", "applicationRoleKeys"],
  "jira.add-user-application": [...USER, "applicationRoleKeys", "applicationAccessRequested"],
  "jira.remove-user-application": [...USER, "applicationRoleKeys", "applicationAccessRequested"],
  "jira.set-user-columns": [...USER, "columnIds"],
  "jira.reset-user-columns": [...USER, "columnsResetRequested"],
  "jira.create-custom-field": ["userKey", "fieldId", "fieldPresent"],
  "jira.delete-custom-fields": ["userKey", "fieldIds", "fieldPresent"],
  "jira.create-issue-type": ["userKey", "issueTypeId", "issueTypePresent"],
  "jira.update-issue-type": ["userKey", "issueTypeId", "issueTypePresent"],
  "jira.delete-issue-type": ["userKey", "issueTypeId", "issueTypePresent"],
  "jira.create-link-type": ["userKey", "linkTypeId", "linkTypePresent"],
  "jira.update-link-type": ["userKey", "linkTypeId", "linkTypePresent"],
  "jira.delete-link-type": ["userKey", "linkTypeId", "linkTypePresent"],
  "jira.reset-link-type-order": ["userKey", "linkTypeIds"],
  "jira.move-link-type": ["userKey", "linkTypeId", "linkTypeIds"],
  "jira.set-terminology": ["userKey", "terminologyNames"],
} as const satisfies Readonly<
  Record<
    | JiraGroupMutation
    | JiraIssueActionMutation
    | JiraMaintenanceMutation
    | JiraDirectoryAccessMutation
    | JiraSchemaMutation,
    readonly (keyof JiraMutationReceipt)[]
  >
>;
export type JiraSystemActionOperation = keyof typeof JIRA_SYSTEM_ACTION_RECEIPTS;
export function isJiraSystemActionOperation(
  operation: JiraMutationOperation,
): operation is JiraSystemActionOperation {
  return Object.hasOwn(JIRA_SYSTEM_ACTION_RECEIPTS, operation);
}
function data(value: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor?.enumerable === true && "value" in descriptor ? descriptor.value : undefined;
}
function nativeId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[1-9]\d{0,18}$/u.test(value) &&
    BigInt(value) <= 9223372036854775807n
  );
}
function customField(value: unknown): boolean {
  return typeof value === "string" && value.startsWith("customfield_") && nativeId(value.slice(12));
}
function terminologyName(value: unknown): boolean {
  return value === "epic" || value === "sprint";
}
interface ArrayRule {
  readonly minimum: number;
  readonly maximum: number;
  readonly unique: boolean;
  readonly item: (value: unknown) => boolean;
}
const ARRAYS = {
  issueIds: { minimum: 1, maximum: 50, unique: true, item: nativeId },
  recipientUserKeys: { minimum: 1, maximum: 50, unique: true, item: jiraPropertyUserText },
  reindexRequestIds: {
    minimum: 0,
    maximum: TOOL_CATALOG_LIMITS.maxArrayItems,
    unique: true,
    item: nativeId,
  },
  applicationRoleKeys: {
    minimum: 1,
    maximum: TOOL_CATALOG_LIMITS.maxArrayItems,
    unique: true,
    item: isSafeAtlassianIdentifier,
  },
  columnIds: {
    minimum: 1,
    maximum: TOOL_CATALOG_LIMITS.maxArrayItems,
    unique: false,
    item: jiraPropertyUserText,
  },
  fieldIds: { minimum: 1, maximum: 50, unique: true, item: customField },
  linkTypeIds: {
    minimum: 0,
    maximum: TOOL_CATALOG_LIMITS.maxArrayItems,
    unique: true,
    item: nativeId,
  },
  terminologyNames: { minimum: 1, maximum: 2, unique: true, item: terminologyName },
} as const satisfies Readonly<Record<string, ArrayRule>>;
function arrayKey(key: PropertyKey): key is keyof typeof ARRAYS {
  return Object.hasOwn(ARRAYS, key);
}
function arrayStructure(value: unknown, rule: ArrayRule): value is readonly unknown[] {
  return (
    Array.isArray(value) &&
    Object.getPrototypeOf(value) === Array.prototype &&
    value.length >= rule.minimum &&
    value.length <= rule.maximum &&
    Reflect.ownKeys(value).length === value.length + 1
  );
}
function arrayValue(value: unknown, rule: ArrayRule): boolean {
  if (!arrayStructure(value, rule)) return false;
  const seen = new Set<unknown>();
  for (let index = 0; index < value.length; index++) {
    const item = data(value, String(index));
    if (!rule.item(item) || (rule.unique && seen.has(item))) return false;
    seen.add(item);
  }
  return true;
}
const TEXT_KEYS: ReadonlySet<PropertyKey> = new Set([
  "userKey",
  "actorUserKey",
  "username",
  "targetUserKey",
  "groupName",
  "swapGroupName",
]);
function scalarValue(
  key: PropertyKey,
  value: unknown,
  operation: JiraSystemActionOperation,
): boolean {
  if (TEXT_KEYS.has(key)) return jiraPropertyUserText(value);
  if (key === "issueKey") return isSafeAtlassianIdentifier(value);
  if (key === "nodeId") return maintenancePathNode(value);
  if (key === "fieldId") return customField(value);
  if (key === "notificationDigest")
    return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
  if (key === "commentPinned" || key === "columnsResetRequested") return value === true;
  return targetValue(key, value, operation) ?? nativeId(value);
}
function targetValue(
  key: PropertyKey,
  value: unknown,
  operation: JiraSystemActionOperation,
): boolean | undefined {
  if (key === "groupPresent") return value === (operation !== "jira.delete-group");
  if (key === "requestedDirectMembership") return value === (operation === "jira.add-group-user");
  if (key === "applicationAccessRequested")
    return value === (operation === "jira.add-user-application");
  if (key === "fieldPresent") return value === (operation === "jira.create-custom-field");
  if (key === "issueTypePresent") return value === (operation !== "jira.delete-issue-type");
  if (key === "linkTypePresent") return value === (operation !== "jira.delete-link-type");
  return undefined;
}
function extraKey(key: PropertyKey, operation: JiraSystemActionOperation): boolean {
  return (
    (key === "swapGroupName" && operation === "jira.delete-group") ||
    (key === "replacementIssueTypeId" && operation === "jira.delete-issue-type")
  );
}
const ACK_IDS = {
  "jira.create-custom-field": "fieldId",
  "jira.create-issue-type": "issueTypeId",
  "jira.create-link-type": "linkTypeId",
  "jira.process-reindex-requests": "reindexRequestIds",
} as const;
function missingAcknowledgement(key: PropertyKey, operation: JiraSystemActionOperation): boolean {
  const fields: Readonly<Record<string, PropertyKey>> = ACK_IDS;
  return fields[operation] === key;
}
function ownFields(receipt: JiraMutationReceipt, operation: JiraSystemActionOperation): boolean {
  const keys: readonly PropertyKey[] = JIRA_SYSTEM_ACTION_RECEIPTS[operation];
  return Reflect.ownKeys(receipt).every((key) => {
    if (!keys.includes(key) && !extraKey(key, operation)) return false;
    const value = data(receipt, key);
    return arrayKey(key) ? arrayValue(value, ARRAYS[key]) : scalarValue(key, value, operation);
  });
}
function requiredFields(
  receipt: JiraMutationReceipt,
  operation: JiraSystemActionOperation,
): boolean {
  return JIRA_SYSTEM_ACTION_RECEIPTS[operation].every(
    (key) =>
      data(receipt, key) !== undefined ||
      (!Object.hasOwn(receipt, key) && missingAcknowledgement(key, operation)),
  );
}
function relatedFields(
  receipt: JiraMutationReceipt,
  operation: JiraSystemActionOperation,
): boolean {
  const swap = data(receipt, "swapGroupName");
  if (swap !== undefined && swap === data(receipt, "groupName")) return false;
  const replacement = data(receipt, "replacementIssueTypeId");
  if (replacement !== undefined && replacement === data(receipt, "issueTypeId")) return false;
  if (operation === "jira.move-link-type") {
    const ordered = data(receipt, "linkTypeIds");
    return Array.isArray(ordered) && ordered.includes(data(receipt, "linkTypeId"));
  }
  return applicationRoleCount(receipt, operation);
}
function applicationRoleCount(
  receipt: JiraMutationReceipt,
  operation: JiraSystemActionOperation,
): boolean {
  const roles = data(receipt, "applicationRoleKeys");
  if (roles === undefined || operation === "jira.set-application-roles") return true;
  return Array.isArray(roles) && roles.length === 1;
}
/** Inspect the original own enumerable data before copying; partial ACK receipts obey the same boundary. */
export function validJiraSystemActionReceipt(
  receipt: JiraMutationReceipt,
  operation: JiraSystemActionOperation,
): boolean {
  const prototype: unknown = Object.getPrototypeOf(receipt);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return (
    ownFields(receipt, operation) &&
    requiredFields(receipt, operation) &&
    relatedFields(receipt, operation) &&
    Buffer.byteLength(JSON.stringify(receipt), "utf8") <= 16384
  );
}
const UNCONFIRMED: ReadonlySet<JiraSystemActionOperation> = new Set([
  ...JIRA_MAINTENANCE_MUTATIONS,
  "jira.delete-group",
  "jira.add-group-user",
  "jira.remove-group-user",
  "jira.notify-issue",
  "jira.set-application-role",
  "jira.set-application-roles",
  "jira.add-user-application",
  "jira.remove-user-application",
  "jira.reset-user-columns",
  "jira.create-custom-field",
  "jira.delete-custom-fields",
  "jira.create-issue-type",
  "jira.delete-issue-type",
  "jira.delete-link-type",
  "jira.reset-link-type-order",
  "jira.move-link-type",
]);
export function canConfirmJiraSystemAction(operation: JiraMutationOperation): boolean {
  return !isJiraSystemActionOperation(operation) || !UNCONFIRMED.has(operation);
}
