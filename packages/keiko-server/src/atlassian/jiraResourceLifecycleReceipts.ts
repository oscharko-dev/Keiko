import { jiraApplicationLinkId, jiraPropertyUserText } from "@oscharko-dev/keiko-connectors";
import { isSafeAtlassianIdentifier, type JiraIssueLifecycleMutation, type JiraProjectLifecycleMutation,
  type JiraMutationOperation, type JiraMutationReceipt } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { TOOL_CATALOG_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { receiptOwnData as data, receiptFields, receiptNativeId, receiptInteger, receiptDigest, receiptArray, receiptWithinBudget } from "./jiraReceiptValues.js";

const ISSUE = ["userKey", "issueId", "issueKey"] as const;
const PROJECT = ["userKey", "projectId", "projectKey"] as const;
const ASSIGNMENT = [...PROJECT, "schemeId", "previousSchemeId", "projectSchemeAssigned"] as const;
export const JIRA_RESOURCE_LIFECYCLE_RECEIPTS = {
  "jira.archive-issues": ["userKey", "issueIds", "issueKeys", "issueArchivedRequested"],
  "jira.delete-issue": [...ISSUE, "issuePresent"],
  "jira.archive-issue": [...ISSUE, "issueArchivedRequested"],
  "jira.restore-issue": [...ISSUE, "issueArchivedRequested"],
  "jira.move-subtask": [...ISSUE, "subtaskIds", "originalPosition", "currentPosition"],
  "jira.create-issues": ["userKey", "requestedIssueCount"],
  "jira.create-reciprocal-remote-link": [...ISSUE, "applicationLinkId", "applicationLinkDestinationDigest", "selectedRemoteIssueId", "delegatedEffectRequested"],
  "jira.delete-project": [...PROJECT, "projectPresent"],
  "jira.archive-project": [...PROJECT, "projectArchivedRequested"],
  "jira.restore-project": [...PROJECT, "projectArchivedRequested"],
  "jira.update-project-type": [...PROJECT, "projectTypeKey"],
  "jira.set-project-permission-scheme": ASSIGNMENT,
  "jira.set-project-priority-scheme": ASSIGNMENT,
  "jira.remove-project-priority-scheme": [...PROJECT, "schemeId", "projectSchemeAssigned"],
} as const satisfies Readonly<Record<JiraIssueLifecycleMutation | JiraProjectLifecycleMutation | "jira.create-issues" | "jira.create-reciprocal-remote-link", readonly (keyof JiraMutationReceipt)[]>>;
export type JiraResourceLifecycleOperation = keyof typeof JIRA_RESOURCE_LIFECYCLE_RECEIPTS;
export function isJiraResourceLifecycleOperation(operation: JiraMutationOperation): operation is JiraResourceLifecycleOperation {
  return Object.hasOwn(JIRA_RESOURCE_LIFECYCLE_RECEIPTS, operation);
}
const BULK_OPTIONAL = ["issueIds", "issueKeys", "bulkFailedElementNumbers", "bulkFailureStatuses"] as const;
function optionalFields(operation: JiraResourceLifecycleOperation): readonly PropertyKey[] {
  if (operation === "jira.create-issues") return BULK_OPTIONAL;
  return operation === "jira.create-reciprocal-remote-link" ? ["linkId"] : [];
}
function scalar(key: PropertyKey, value: unknown, operation: JiraResourceLifecycleOperation): boolean {
  if (key === "userKey") return jiraPropertyUserText(value);
  if (key === "issueKey" || key === "projectKey" || key === "projectTypeKey") return isSafeAtlassianIdentifier(value);
  if (key === "applicationLinkId") return jiraApplicationLinkId(value);
  if (key === "applicationLinkDestinationDigest") return receiptDigest(value);
  if (key === "originalPosition" || key === "currentPosition") return receiptInteger(value, 0, 2147483647);
  if (key === "requestedIssueCount") return receiptInteger(value, 1, 50);
  return target(key, value, operation) ?? receiptNativeId(value);
}
function target(key: PropertyKey, value: unknown, operation: JiraResourceLifecycleOperation): boolean | undefined {
  if (key === "issuePresent" || key === "projectPresent") return value === false;
  if (key === "issueArchivedRequested") return value === (operation !== "jira.restore-issue");
  if (key === "projectArchivedRequested") return value === (operation === "jira.archive-project");
  if (key === "projectSchemeAssigned") return value === (operation !== "jira.remove-project-priority-scheme");
  if (key === "delegatedEffectRequested") return value === true;
  return undefined;
}
function arrayField(key: PropertyKey, value: unknown): boolean | undefined {
  if (key === "issueIds") return receiptArray(value, 1, 50, receiptNativeId);
  if (key === "issueKeys") return receiptArray(value, 1, 50, isSafeAtlassianIdentifier);
  if (key === "subtaskIds") return receiptArray(value, 2, TOOL_CATALOG_LIMITS.maxArrayItems, receiptNativeId);
  if (key === "bulkFailedElementNumbers") return receiptArray(value, 1, 50, (item) => receiptInteger(item, 0, 2147483647));
  if (key === "bulkFailureStatuses") return receiptArray(value, 1, 50, (item) => receiptInteger(item, 400, 599), false);
  return undefined;
}
function pairedArrays(receipt: object, left: PropertyKey, right: PropertyKey, maximum: number): boolean {
  const a = data(receipt, left); const b = data(receipt, right);
  if (a === undefined && b === undefined) return true;
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.length <= maximum;
}
function bulkRelations(receipt: object): boolean {
  const count = data(receipt, "requestedIssueCount");
  return receiptInteger(count, 1, 50) && pairedArrays(receipt, "issueIds", "issueKeys", count) &&
    pairedArrays(receipt, "bulkFailedElementNumbers", "bulkFailureStatuses", count);
}
function relationships(receipt: object, operation: JiraResourceLifecycleOperation): boolean {
  if (operation === "jira.create-issues") return bulkRelations(receipt);
  if (operation === "jira.archive-issues") return pairedArrays(receipt, "issueIds", "issueKeys", 50);
  if (operation === "jira.move-subtask") return data(receipt, "originalPosition") !== data(receipt, "currentPosition");
  // Exact existing association is a valid pre-effect unchanged receipt, so equal IDs are retained.
  return true;
}
export function validJiraResourceLifecycleReceipt(receipt: JiraMutationReceipt, operation: JiraResourceLifecycleOperation): boolean {
  if (!receiptFields(receipt, JIRA_RESOURCE_LIFECYCLE_RECEIPTS[operation], optionalFields(operation))) return false;
  return Reflect.ownKeys(receipt).every((key) => arrayField(key, data(receipt, key)) ?? scalar(key, data(receipt, key), operation)) &&
    relationships(receipt, operation) && receiptWithinBudget(receipt);
}
export function canConfirmJiraResourceLifecycle(operation: JiraMutationOperation): boolean {
  return !isJiraResourceLifecycleOperation(operation);
}
