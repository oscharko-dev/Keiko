import { jiraPropertyPathKey, jiraPropertyUserText, rolePrincipalText } from "@oscharko-dev/keiko-connectors";
import { isSafeAtlassianIdentifier, type JiraMutationOperation, type JiraMutationReceipt,
  type JiraRoleMutation, type JiraPermissionSchemeMutation } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { receiptArray, receiptFields, receiptNativeId, receiptOwnData, receiptWithinBudget } from "./jiraReceiptValues.js";

const ROLE = ["roleId", "userKey", "rolePresent"] as const;
const ACTORS = [...ROLE, "roleActorsScope", "actorChange", "actorUserKeys", "actorGroupNames"] as const;
const PROJECT = [...ACTORS, "projectId", "projectKey"] as const;
const SCHEME = ["schemeId", "userKey", "schemePresent"] as const;
const GRANT = ["schemeId", "userKey", "permissionId", "grantPresent"] as const;
export const JIRA_ACCESS_CONFIGURATION_RECEIPTS = {
  "jira.create-role": ROLE,
  "jira.update-role": ROLE,
  "jira.replace-role": ROLE,
  "jira.delete-role": ROLE,
  "jira.add-role-default-actors": ACTORS,
  "jira.delete-role-default-actor": ACTORS,
  "jira.add-project-role-actors": PROJECT,
  "jira.set-project-role-actors": PROJECT,
  "jira.delete-project-role-actor": PROJECT,
  "jira.create-permission-scheme": SCHEME,
  "jira.update-permission-scheme": SCHEME,
  "jira.delete-permission-scheme": SCHEME,
  "jira.add-permission-grant": GRANT,
  "jira.delete-permission-grant": GRANT,
  "jira.set-permission-scheme-attribute": ["schemeId", "userKey", "attributeKey", "attributeEnabled"],
} as const satisfies Readonly<Record<JiraRoleMutation | JiraPermissionSchemeMutation, readonly (keyof JiraMutationReceipt)[]>>;
export type JiraAccessConfigurationOperation = keyof typeof JIRA_ACCESS_CONFIGURATION_RECEIPTS;
export function isJiraAccessConfigurationOperation(operation: JiraMutationOperation): operation is JiraAccessConfigurationOperation {
  return Object.hasOwn(JIRA_ACCESS_CONFIGURATION_RECEIPTS, operation);
}
const ACTOR_OPERATIONS = {
  "jira.add-role-default-actors": { scope: "role-defaults", change: "add" },
  "jira.delete-role-default-actor": { scope: "role-defaults", change: "remove" },
  "jira.add-project-role-actors": { scope: "project-membership", change: "add" },
  "jira.set-project-role-actors": { scope: "project-membership", change: "replace" },
  "jira.delete-project-role-actor": { scope: "project-membership", change: "remove" },
} as const;
function actorOperation(operation: JiraAccessConfigurationOperation): operation is keyof typeof ACTOR_OPERATIONS {
  return Object.hasOwn(ACTOR_OPERATIONS, operation);
}
function actorValue(key: PropertyKey, value: unknown, operation: JiraAccessConfigurationOperation): boolean | undefined {
  if (key === "actorUserKeys" || key === "actorGroupNames") return receiptArray(value, 0, 50, rolePrincipalText);
  if (!actorOperation(operation)) return undefined;
  if (key === "roleActorsScope") return value === ACTOR_OPERATIONS[operation].scope;
  if (key === "actorChange") return value === ACTOR_OPERATIONS[operation].change;
  return undefined;
}
function presence(key: PropertyKey, value: unknown, operation: JiraAccessConfigurationOperation): boolean | undefined {
  if (key === "rolePresent") return value === (operation !== "jira.delete-role");
  if (key === "schemePresent") return value === (operation !== "jira.delete-permission-scheme");
  if (key === "grantPresent") return value === (operation === "jira.add-permission-grant");
  return undefined;
}
function receiptValue(key: PropertyKey, value: unknown, operation: JiraAccessConfigurationOperation): boolean {
  const target = presence(key, value, operation) ?? actorValue(key, value, operation);
  if (target !== undefined) return target;
  if (key === "userKey") return operation.includes("permission") ? jiraPropertyUserText(value) : rolePrincipalText(value);
  if (key === "projectKey") return isSafeAtlassianIdentifier(value);
  if (key === "attributeKey") return jiraPropertyPathKey(value);
  if (key === "attributeEnabled") return typeof value === "boolean";
  return receiptNativeId(value);
}
function optionalAcknowledgement(key: PropertyKey, operation: JiraAccessConfigurationOperation): boolean {
  if (operation === "jira.create-role") return key === "roleId";
  if (operation === "jira.create-permission-scheme") return key === "schemeId";
  return operation === "jira.add-permission-grant" && key === "permissionId";
}
function receiptContext(receipt: JiraMutationReceipt, operation: JiraAccessConfigurationOperation): boolean {
  const allowed: readonly PropertyKey[] = JIRA_ACCESS_CONFIGURATION_RECEIPTS[operation];
  const required = allowed.filter((key) => !optionalAcknowledgement(key, operation));
  const optional = allowed.filter((key) => optionalAcknowledgement(key, operation));
  if (operation === "jira.delete-role") optional.push("swapRoleId");
  return receiptFields(receipt, required, optional) && Reflect.ownKeys(receipt).every((key) =>
    receiptValue(key, receiptOwnData(receipt, key), operation));
}
function actorCount(receipt: JiraMutationReceipt, operation: JiraAccessConfigurationOperation): boolean {
  if (!actorOperation(operation)) return true;
  const users = receiptOwnData(receipt, "actorUserKeys"); const groups = receiptOwnData(receipt, "actorGroupNames");
  if (!Array.isArray(users) || !Array.isArray(groups)) return false;
  const count = users.length + groups.length;
  if (count > 50) return false;
  const change = ACTOR_OPERATIONS[operation].change;
  if (change === "replace") return Number.isSafeInteger(Number(receiptOwnData(receipt, "roleId")));
  if (change === "remove") return count === 1;
  return count > 0 && (users.length === 0 || groups.length === 0);
}
/** Original plain own data only, including partial receipts; never wash unsafe data via spread. */
export function validJiraAccessConfigurationReceipt(receipt: JiraMutationReceipt, operation: JiraAccessConfigurationOperation): boolean {
  if (!receiptContext(receipt, operation)) return false;
  const swap = receiptOwnData(receipt, "swapRoleId");
  if (swap !== undefined && swap === receiptOwnData(receipt, "roleId")) return false;
  return actorCount(receipt, operation) && receiptWithinBudget(receipt);
}
export function canConfirmJiraAccessConfiguration(operation: JiraMutationOperation): boolean {
  if (!isJiraAccessConfigurationOperation(operation)) return true;
  return !actorOperation(operation) && operation !== "jira.delete-role" && operation !== "jira.delete-permission-scheme";
}
