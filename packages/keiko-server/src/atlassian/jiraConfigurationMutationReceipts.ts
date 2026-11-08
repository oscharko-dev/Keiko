import { jiraPropertyUserText } from "@oscharko-dev/keiko-connectors";
import {
  isSafeAtlassianIdentifier, type JiraScreenConfigurationMutation, type JiraBoardConfigurationMutation,
  type JiraSprintLifecycleMutation, type JiraMutationOperation, type JiraMutationReceipt,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";

export const JIRA_CONFIGURATION_MUTATION_RECEIPTS = {
  "jira.add-default-screen-field": ["fieldId", "fieldPresent"],
  "jira.add-screen-tab-field": ["screenId", "tabId", "fieldId", "fieldPresent"],
  "jira.remove-screen-tab-field": ["screenId", "tabId", "fieldId", "fieldPresent"],
  "jira.move-screen-tab-field": ["screenId", "tabId", "fieldId"],
  "jira.set-screen-field-show-when-empty": ["screenId", "tabId", "fieldId", "showWhenEmpty"],
  "jira.move-screen-tab": ["screenId", "tabId"],
  "jira.delete-board": ["boardId", "filterId", "userKey", "boardPresent"],
  "jira.set-board-refined-velocity": ["boardId", "filterId", "userKey", "refinedVelocityEnabled"],
  "jira.replace-sprint": ["sprintId", "originBoardId", "userKey", "sprintPresent"],
  "jira.delete-sprint": ["sprintId", "originBoardId", "userKey", "sprintPresent"],
  "jira.swap-sprints": ["sprintId", "originBoardId", "swapSprintId", "userKey"],
  "jira.unmap-sprints": ["sprintIds", "userKey", "sprintSynced"],
  "jira.unmap-all-sprints": ["sprintIds", "userKey", "sprintSynced", "allSprints"],
} as const satisfies Readonly<Record<JiraScreenConfigurationMutation | JiraBoardConfigurationMutation | JiraSprintLifecycleMutation, readonly (keyof JiraMutationReceipt)[]>>;
export type JiraConfigurationReceiptOperation = keyof typeof JIRA_CONFIGURATION_MUTATION_RECEIPTS;
export function isJiraConfigurationReceiptOperation(operation: JiraMutationOperation): operation is JiraConfigurationReceiptOperation {
  return Object.hasOwn(JIRA_CONFIGURATION_MUTATION_RECEIPTS, operation);
}
function ownValue(value: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && descriptor.enumerable && "value" in descriptor ? descriptor.value : undefined;
}
function int64(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]{0,18}$/u.test(value) && BigInt(value) <= 9223372036854775807n;
}
function agileId(value: unknown): value is string {
  return int64(value) && Number.isSafeInteger(Number(value));
}
function boundedSprintArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype &&
    value.length > 0 && value.length <= 50 && Reflect.ownKeys(value).length === value.length + 1;
}
function sprintIds(value: unknown): boolean {
  if (!boundedSprintArray(value)) return false;
  const ids = new Set<string>();
  for (let index = 0; index < value.length; index++) {
    const id = ownValue(value, String(index));
    if (!agileId(id) || ids.has(id)) return false;
    ids.add(id);
  }
  return true;
}
function stateValue(key: PropertyKey, value: unknown, operation: JiraConfigurationReceiptOperation): boolean | undefined {
  if (key === "showWhenEmpty" || key === "refinedVelocityEnabled") return typeof value === "boolean";
  if (key === "sprintSynced" || key === "boardPresent") return value === false;
  if (key === "allSprints") return value === true;
  if (key === "sprintPresent") return value === (operation === "jira.replace-sprint");
  if (key === "fieldPresent") return value === (operation !== "jira.remove-screen-tab-field");
  return undefined;
}
function receiptValue(key: PropertyKey, value: unknown, operation: JiraConfigurationReceiptOperation): boolean {
  const state = stateValue(key, value, operation);
  if (state !== undefined) return state;
  if (key === "userKey") return jiraPropertyUserText(value);
  if (key === "fieldId") return isSafeAtlassianIdentifier(value);
  if (key === "sprintIds") return sprintIds(value);
  return key === "screenId" || key === "tabId" ? int64(value) : agileId(value);
}
/** Selected identities are known before dispatch. Validate the original own data, including arrays,
 * before copying it; an unknown outcome must not hide foreign fields or turn missing context into facts. */
export function validJiraConfigurationReceipt(receipt: JiraMutationReceipt, operation: JiraConfigurationReceiptOperation): boolean {
  const prototype: unknown = Object.getPrototypeOf(receipt);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const required: readonly PropertyKey[] = JIRA_CONFIGURATION_MUTATION_RECEIPTS[operation];
  if (Reflect.ownKeys(receipt).length !== required.length) return false;
  if (!required.every((key) => receiptValue(key, ownValue(receipt, key), operation))) return false;
  return operation !== "jira.swap-sprints" || ownValue(receipt, "sprintId") !== ownValue(receipt, "swapSprintId");
}
const UNCONFIRMABLE: ReadonlySet<JiraMutationOperation> = new Set([
  "jira.add-default-screen-field", "jira.delete-board", "jira.delete-sprint", "jira.swap-sprints", "jira.unmap-all-sprints",
]);
/** Neither a selected404 nor an actor-visible sample establishes the complete native effect. */
export function canConfirmJiraConfiguration(operation: JiraMutationOperation): boolean {
  return !UNCONFIRMABLE.has(operation);
}
