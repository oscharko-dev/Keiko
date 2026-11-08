import { isJiraFieldId, jiraPropertyUserText, jiraRemoteVersionLinkGlobalId } from "@oscharko-dev/keiko-connectors";
import { isSafeAtlassianIdentifier, type JiraAgilePlanningMutation, type JiraVersionRemoteLinkMutation,
  type JiraProjectCategoryMutation, type JiraMutationOperation, type JiraMutationReceipt } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";

const VERSION = ["versionId", "projectId", "projectKey", "userKey", "linkPresent"] as const;
const CATEGORY = ["categoryId", "userKey", "categoryPresent"] as const;
const RANK = ["userKey", "boardId", "fieldId", "issueIds", "issueKeys", "anchorIssueId", "anchorIssueKey", "rankDirection"] as const;
export const JIRA_PLANNING_LIFECYCLE_RECEIPTS = {
  "jira.epic-remove-issues": ["userKey", "issueIds", "issueKeys", "epicPresent"],
  "jira.rank-epic": RANK,
  "jira.rank-issues": RANK,
  "jira.set-issue-estimation": ["userKey", "boardId", "fieldId", "issueId", "issueKey", "estimationValue", "estimationUnit"],
  "jira.upsert-version-remote-link": [...VERSION, "globalId"],
  "jira.upsert-version-remote-link-by-global-id": [...VERSION, "globalId"],
  "jira.delete-version-remote-link": [...VERSION, "globalId"],
  "jira.delete-version-remote-links": [...VERSION, "globalIds"],
  "jira.create-project-category": CATEGORY,
  "jira.update-project-category": CATEGORY,
  "jira.delete-project-category": CATEGORY,
} as const satisfies Readonly<Record<JiraAgilePlanningMutation | JiraVersionRemoteLinkMutation | JiraProjectCategoryMutation, readonly (keyof JiraMutationReceipt)[]>>;
export type JiraPlanningLifecycleOperation = keyof typeof JIRA_PLANNING_LIFECYCLE_RECEIPTS;
export function isJiraPlanningLifecycleOperation(operation: JiraMutationOperation): operation is JiraPlanningLifecycleOperation {
  return Object.hasOwn(JIRA_PLANNING_LIFECYCLE_RECEIPTS, operation);
}
function own(value: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && descriptor.enumerable && "value" in descriptor ? descriptor.value : undefined;
}
function id(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]{0,18}$/u.test(value) && BigInt(value) <= 9223372036854775807n;
}
function arrayShape(value: unknown, min: number, max: number): value is readonly unknown[] {
  return Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype &&
    value.length >= min && value.length <= max && Reflect.ownKeys(value).length === value.length + 1;
}
function distinctArray(value: unknown, min: number, max: number, accept: (item: unknown) => item is string): boolean {
  if (!arrayShape(value, min, max)) return false;
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index++) {
    const item = own(value, String(index));
    if (!accept(item) || seen.has(item)) return false;
    seen.add(item);
  }
  return true;
}
function presence(key: PropertyKey, value: unknown, operation: JiraPlanningLifecycleOperation): boolean | undefined {
  if (key === "epicPresent") return value === false;
  if (key === "categoryPresent") return value === (operation !== "jira.delete-project-category");
  if (key === "linkPresent") return value === (operation === "jira.upsert-version-remote-link" || operation === "jira.upsert-version-remote-link-by-global-id");
  return undefined;
}
function scalar(key: PropertyKey, value: unknown, operation: JiraPlanningLifecycleOperation): boolean {
  const state = presence(key, value, operation);
  if (state !== undefined) return state;
  if (key === "userKey") return jiraPropertyUserText(value);
  if (key === "fieldId") return isJiraFieldId(value);
  if (key === "rankDirection") return value === "before" || value === "after";
  if (key === "estimationUnit") return value === "seconds" || value === "board-number";
  return identityOrEstimate(key, value);
}
function identityOrEstimate(key: PropertyKey, value: unknown): boolean {
  if (key === "estimationValue") return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
  if (key === "projectKey" || key === "issueKey" || key === "anchorIssueKey") return isSafeAtlassianIdentifier(value);
  return id(value) && (key !== "boardId" || Number.isSafeInteger(Number(value)));
}
function receiptValue(key: PropertyKey, value: unknown, operation: JiraPlanningLifecycleOperation): boolean {
  if (key === "issueIds") return distinctArray(value, 1, 50, id);
  if (key === "issueKeys") return distinctArray(value, 1, 50, isSafeAtlassianIdentifier);
  if (key === "globalIds") return distinctArray(value, 0, 1000, (item): item is string => jiraRemoteVersionLinkGlobalId(item, false));
  if (key === "globalId") return jiraRemoteVersionLinkGlobalId(value, operation !== "jira.upsert-version-remote-link");
  return scalar(key, value, operation);
}
function alignedIssues(receipt: JiraMutationReceipt, operation: JiraPlanningLifecycleOperation): boolean {
  const ids = own(receipt, "issueIds");
  if (!Array.isArray(ids)) return true;
  const keys = own(receipt, "issueKeys");
  if (!Array.isArray(keys) || keys.length !== ids.length) return false;
  if (operation === "jira.epic-remove-issues") return true;
  return (operation !== "jira.rank-epic" || ids.length === 1) &&
    !ids.includes(own(receipt, "anchorIssueId")) && !keys.includes(own(receipt, "anchorIssueKey")) &&
    rankField(own(receipt, "fieldId"));
}
function rankField(value: unknown): boolean {
  return typeof value === "string" && /^customfield_[1-9][0-9]{0,15}$/u.test(value) &&
    Number.isSafeInteger(Number(value.slice("customfield_".length)));
}
function estimationUnits(receipt: JiraMutationReceipt, operation: JiraPlanningLifecycleOperation): boolean {
  if (operation !== "jira.set-issue-estimation") return true;
  const seconds = own(receipt, "estimationUnit") === "seconds";
  return (own(receipt, "fieldId") === "timeoriginalestimate") === seconds &&
    (!seconds || Number.isSafeInteger(own(receipt, "estimationValue")));
}
/** Validate original own data before any spread, including arrays and fixed target flags. */
export function validJiraPlanningLifecycleReceipt(receipt: JiraMutationReceipt, operation: JiraPlanningLifecycleOperation): boolean {
  const prototype: unknown = Object.getPrototypeOf(receipt);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys: readonly PropertyKey[] = JIRA_PLANNING_LIFECYCLE_RECEIPTS[operation];
  if (Reflect.ownKeys(receipt).length !== keys.length) return false;
  if (!keys.every((key) => receiptValue(key, own(receipt, key), operation))) return false;
  if (!alignedIssues(receipt, operation) || !estimationUnits(receipt, operation)) return false;
  // Producer reserves half of the existing write-result cap for these known receipt facts.
  return Buffer.byteLength(JSON.stringify(receipt), "utf8") <= 16_384;
}
const UNCONFIRMED: ReadonlySet<JiraMutationOperation> = new Set(["jira.rank-epic", "jira.rank-issues", "jira.delete-project-category"]);
export function canConfirmJiraPlanningLifecycle(operation: JiraMutationOperation): boolean {
  return !UNCONFIRMED.has(operation);
}
