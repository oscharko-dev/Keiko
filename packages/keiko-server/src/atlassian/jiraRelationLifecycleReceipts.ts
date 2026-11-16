import { jiraPropertyUserText } from "@oscharko-dev/keiko-connectors";
import {
  isSafeAtlassianIdentifier,
  type JiraLinkMutation,
  type JiraReleaseLifecycleMutation,
  type JiraMutationOperation,
  type JiraMutationReceipt,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { TOOL_CATALOG_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";

export const JIRA_RELATION_LIFECYCLE_RECEIPTS = {
  "jira.create-issue-link": [
    "issueId",
    "issueKey",
    "linkedIssueId",
    "linkedIssueKey",
    "linkTypeId",
    "userKey",
    "linkPresent",
    "linkId",
  ],
  "jira.delete-issue-link": [
    "issueId",
    "issueKey",
    "linkedIssueId",
    "linkedIssueKey",
    "linkTypeId",
    "userKey",
    "linkPresent",
    "linkId",
  ],
  "jira.upsert-remote-link": ["issueId", "issueKey", "userKey", "linkPresent", "linkId"],
  "jira.update-remote-link": ["issueId", "issueKey", "userKey", "linkPresent", "linkId"],
  "jira.delete-remote-link": ["issueId", "issueKey", "userKey", "linkPresent", "linkId"],
  "jira.delete-remote-link-by-global-id": [
    "issueId",
    "issueKey",
    "userKey",
    "linkPresent",
    "linkId",
  ],
  "jira.delete-component": ["projectId", "projectKey", "userKey", "componentId"],
  "jira.merge-version": ["projectId", "projectKey", "userKey", "versionId", "targetVersionId"],
  "jira.move-version": ["projectId", "projectKey", "userKey", "versionId"],
  "jira.remove-and-swap-version": [
    "projectId",
    "projectKey",
    "userKey",
    "versionId",
    "replacementVersionIds",
  ],
} as const satisfies Readonly<
  Record<JiraLinkMutation | JiraReleaseLifecycleMutation, readonly (keyof JiraMutationReceipt)[]>
>;
export type JiraRelationLifecycleOperation = keyof typeof JIRA_RELATION_LIFECYCLE_RECEIPTS;
export function isJiraRelationLifecycleOperation(
  operation: JiraMutationOperation,
): operation is JiraRelationLifecycleOperation {
  return Object.hasOwn(JIRA_RELATION_LIFECYCLE_RECEIPTS, operation);
}
function identity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[1-9]\d{0,18}$/u.test(value) &&
    BigInt(value) <= 9223372036854775807n
  );
}
function ownValue(receipt: object, key: PropertyKey): unknown {
  const field = Object.getOwnPropertyDescriptor(receipt, key);
  return field !== undefined && field.enumerable && "value" in field ? field.value : undefined;
}
function boundedOwnArray(value: unknown): value is readonly unknown[] {
  return (
    Array.isArray(value) &&
    Object.getPrototypeOf(value) === Array.prototype &&
    value.length <= TOOL_CATALOG_LIMITS.maxArrayItems &&
    Reflect.ownKeys(value).length === value.length + 1
  );
}
function replacements(value: unknown, source: unknown): boolean {
  if (!boundedOwnArray(value)) return false;
  const ids = new Set<string>();
  for (let index = 0; index < value.length; index++) {
    const id = ownValue(value, String(index));
    if (!identity(id) || id === source || ids.has(id)) return false;
    ids.add(id);
  }
  return true;
}
function receiptValue(
  receipt: JiraMutationReceipt,
  key: PropertyKey,
  value: unknown,
  operation: JiraRelationLifecycleOperation,
): boolean {
  if (key === "userKey") return jiraPropertyUserText(value);
  if (key === "projectKey" || key === "issueKey" || key === "linkedIssueKey")
    return isSafeAtlassianIdentifier(value);
  if (key === "linkPresent")
    return (
      value ===
      (operation === "jira.create-issue-link" ||
        operation === "jira.upsert-remote-link" ||
        operation === "jira.update-remote-link")
    );
  if (key === "replacementVersionIds") return replacements(value, ownValue(receipt, "versionId"));
  return identity(value);
}
function distinctTargets(receipt: JiraMutationReceipt): boolean {
  for (const [source, target] of [
    ["issueId", "linkedIssueId"],
    ["componentId", "replacementComponentId"],
    ["versionId", "targetVersionId"],
  ] as const) {
    const replacement = ownValue(receipt, target);
    if (replacement !== undefined && replacement === ownValue(receipt, source)) return false;
  }
  const issueKey = ownValue(receipt, "issueKey");
  const linkedKey = ownValue(receipt, "linkedIssueKey");
  return (
    typeof issueKey !== "string" ||
    typeof linkedKey !== "string" ||
    issueKey.toUpperCase() !== linkedKey.toUpperCase()
  );
}
/** Validate original own data before any spread. Unknown creates may lack only the new link ID. */
export function validJiraRelationLifecycleReceipt(
  receipt: JiraMutationReceipt,
  operation: JiraRelationLifecycleOperation,
): boolean {
  const prototype: unknown = Object.getPrototypeOf(receipt);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const required: readonly PropertyKey[] = JIRA_RELATION_LIFECYCLE_RECEIPTS[operation];
  const partialCreate =
    operation === "jira.create-issue-link" || operation === "jira.upsert-remote-link";
  if (
    !required.every(
      (key) => (partialCreate && key === "linkId") || ownValue(receipt, key) !== undefined,
    )
  )
    return false;
  const allowed: ReadonlySet<PropertyKey> = new Set([
    ...required,
    ...(operation === "jira.delete-component" ? ["replacementComponentId"] : []),
  ]);
  if (
    !Reflect.ownKeys(receipt).every(
      (key) => allowed.has(key) && receiptValue(receipt, key, ownValue(receipt, key), operation),
    )
  )
    return false;
  return distinctTargets(receipt);
}
/** Native resource absence does not prove complete reassignment/clearing of every issue reference. */
export function canConfirmJiraRelationLifecycle(operation: JiraMutationOperation): boolean {
  return (
    operation !== "jira.delete-component" &&
    operation !== "jira.merge-version" &&
    operation !== "jira.remove-and-swap-version"
  );
}
