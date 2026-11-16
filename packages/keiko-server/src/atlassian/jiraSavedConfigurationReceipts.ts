import {
  JIRA_NONSECRET_PREFERENCE_KINDS,
  jiraPropertyUserText,
} from "@oscharko-dev/keiko-connectors";
import type {
  JiraMutationOperation,
  JiraMutationReceipt,
  JiraSavedConfigurationMutation,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";

export const JIRA_SAVED_CONFIGURATION_RECEIPTS = {
  "jira.create-filter": ["filterId", "userKey", "defaultSharingAtomic", "observedShareScope"],
  "jira.update-filter": ["filterId", "userKey"],
  "jira.delete-filter": ["filterId", "userKey"],
  "jira.set-filter-share-scope": ["userKey", "username", "observedShareScope"],
  "jira.set-filter-columns": ["filterId", "userKey"],
  "jira.reset-filter-columns": ["filterId", "userKey"],
  "jira.add-filter-permission": ["filterId", "userKey", "permissionId"],
  "jira.delete-filter-permission": ["filterId", "userKey", "permissionId"],
  "jira.set-my-preference": ["userKey", "username", "preferenceKey", "preferencePresent"],
  "jira.delete-my-preference": ["userKey", "username", "preferenceKey", "preferencePresent"],
} as const satisfies Readonly<
  Record<JiraSavedConfigurationMutation, readonly (keyof JiraMutationReceipt)[]>
>;

export function isJiraSavedConfigurationOperation(
  operation: JiraMutationOperation,
): operation is JiraSavedConfigurationMutation {
  return Object.hasOwn(JIRA_SAVED_CONFIGURATION_RECEIPTS, operation);
}
function identity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[1-9]\d{0,18}$/u.test(value) &&
    BigInt(value) <= 9223372036854775807n
  );
}
function sharingScope(value: unknown): boolean {
  return value === "PRIVATE" || value === "AUTHENTICATED" || value === "GLOBAL";
}
function filterResultUrl(value: unknown): URL | undefined {
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    /[\p{Cc}\\]/u.test(value) ||
    !URL.canParse(value)
  )
    return undefined;
  const url = new URL(value);
  return url.protocol === "https:" &&
    [url.username, url.password, url.hash].every((part) => part === "") &&
    !/%(?:2f|5c|25)/iu.test(url.pathname)
    ? url
    : undefined;
}
function filterLink(value: unknown, filterId: unknown): boolean {
  const url = filterResultUrl(value);
  return (
    identity(filterId) &&
    url !== undefined &&
    url.pathname.endsWith("/issues/") &&
    url.search === `?filter=${filterId}`
  );
}
function receiptValue(
  key: PropertyKey,
  value: unknown,
  operation: JiraSavedConfigurationMutation,
): boolean {
  switch (key) {
    case "userKey":
    case "username":
      return jiraPropertyUserText(value);
    case "filterId":
    case "permissionId":
      return identity(value);
    case "defaultSharingAtomic":
      return value === false;
    case "observedShareScope":
      return sharingScope(value);
    case "preferenceKey":
      return typeof value === "string" && Object.hasOwn(JIRA_NONSECRET_PREFERENCE_KINDS, value);
    case "preferencePresent":
      return value === (operation === "jira.set-my-preference");
    default:
      return false;
  }
}
function ownDataField(
  receipt: JiraMutationReceipt,
  key: PropertyKey,
): PropertyDescriptor | undefined {
  const field = Object.getOwnPropertyDescriptor(receipt, key);
  return field !== undefined && "value" in field && field.enumerable ? field : undefined;
}
function plainReceipt(receipt: JiraMutationReceipt): boolean {
  const prototype: unknown = Object.getPrototypeOf(receipt);
  return prototype === Object.prototype || prototype === null;
}
function validReceiptField(
  receipt: JiraMutationReceipt,
  key: PropertyKey,
  allowed: ReadonlySet<PropertyKey>,
  filterId: unknown,
  operation: JiraSavedConfigurationMutation,
): boolean {
  if (!allowed.has(key)) return false;
  const field = ownDataField(receipt, key);
  if (field === undefined) return false;
  return key === "browseUrl"
    ? filterLink(field.value, filterId)
    : receiptValue(key, field.value, operation);
}
/** Partial receipts may lack a new remote ID, but never borrow context or values from another tool. */
export function validJiraSavedConfigurationReceipt(
  receipt: JiraMutationReceipt,
  operation: JiraSavedConfigurationMutation,
): boolean {
  if (!plainReceipt(receipt)) return false;
  if (!jiraPropertyUserText(ownDataField(receipt, "userKey")?.value)) return false;
  const required: readonly PropertyKey[] = JIRA_SAVED_CONFIGURATION_RECEIPTS[operation];
  const allowed: ReadonlySet<PropertyKey> = new Set([
    ...required,
    ...(required.includes("filterId") ? ["browseUrl"] : []),
  ]);
  const filterId: unknown = ownDataField(receipt, "filterId")?.value;
  return Reflect.ownKeys(receipt).every((key) =>
    validReceiptField(receipt, key, allowed, filterId, operation),
  );
}
/** The published native API cannot independently prove these two acknowledged deletions. */
export function canConfirmJiraSavedConfiguration(operation: JiraMutationOperation): boolean {
  return operation !== "jira.delete-filter" && operation !== "jira.delete-my-preference";
}
