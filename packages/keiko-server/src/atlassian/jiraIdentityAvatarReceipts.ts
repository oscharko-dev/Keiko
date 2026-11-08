import { jiraPropertyUserText } from "@oscharko-dev/keiko-connectors";
import {
  JIRA_ATTACHMENT_MAX_BYTES,
  isSafeAtlassianIdentifier,
  type JiraAvatarMutation,
  type JiraIdentityMutation,
  type JiraMutationOperation,
  type JiraMutationReceipt,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  receiptOwnData as data,
  receiptFields,
  receiptNativeId,
  receiptInteger,
  receiptDigest,
  receiptWithinBudget,
} from "./jiraReceiptValues.js";

const ACTOR = ["actorUserKey"] as const;
const USER = [...ACTOR, "userKey", "username"] as const;
const AVATAR = [...ACTOR, "avatarType"] as const;
const TEMPORARY = [...AVATAR, "uploadSha256", "uploadBytes", "temporaryAvatar"] as const;
const CREATE = [...AVATAR, "uploadSha256", "uploadBytes", "avatarPresent", "avatarId"] as const;
const SET = [...AVATAR, "avatarId", "avatarSelected"] as const;
const DELETE = [...AVATAR, "avatarId", "avatarPresent"] as const;
export const JIRA_IDENTITY_AVATAR_RECEIPTS = {
  "jira.create-user": [...USER, "userPresent"],
  "jira.update-user": [...USER, "userPresent"],
  "jira.delete-user": [...USER, "userPresent"],
  "jira.invalidate-user-session": [...USER, "userSessionInvalidationRequested"],
  "jira.schedule-user-anonymization": [...USER, "newOwnerUserKey", "anonymizationRequested"],
  "jira.rerun-user-anonymization": [
    ...USER,
    "newOwnerUserKey",
    "anonymizationRequested",
    "anonymizationRerunRequested",
  ],
  "jira.upload-temporary-avatar": TEMPORARY,
  "jira.crop-temporary-avatar": TEMPORARY,
  "jira.upload-issue-type-avatar": [...TEMPORARY, "issueTypeId"],
  "jira.create-issue-type-avatar": [...CREATE, "issueTypeId"],
  "jira.upload-project-avatar": [...TEMPORARY, "projectId", "projectKey"],
  "jira.create-project-avatar": [...CREATE, "projectId", "projectKey"],
  "jira.set-project-avatar": [...SET, "projectId", "projectKey"],
  "jira.delete-project-avatar": [...DELETE, "projectId", "projectKey"],
  "jira.upload-owned-avatar": TEMPORARY,
  "jira.create-owned-avatar": CREATE,
  "jira.delete-owned-avatar": DELETE,
  "jira.upload-user-avatar": [...TEMPORARY, "userKey"],
  "jira.create-user-avatar": [...CREATE, "userKey"],
  "jira.set-user-avatar": [...SET, "userKey"],
  "jira.delete-user-avatar": [...DELETE, "userKey"],
} as const satisfies Readonly<
  Record<JiraAvatarMutation | JiraIdentityMutation, readonly (keyof JiraMutationReceipt)[]>
>;
export type JiraIdentityAvatarOperation = keyof typeof JIRA_IDENTITY_AVATAR_RECEIPTS;
export function isJiraIdentityAvatarOperation(
  operation: JiraMutationOperation,
): operation is JiraIdentityAvatarOperation {
  return Object.hasOwn(JIRA_IDENTITY_AVATAR_RECEIPTS, operation);
}
function createdAvatar(operation: JiraIdentityAvatarOperation): boolean {
  return operation.startsWith("jira.create-") && operation.endsWith("-avatar");
}
function ownedAvatar(operation: JiraIdentityAvatarOperation): boolean {
  return operation.endsWith("-owned-avatar");
}
function temporary(operation: JiraIdentityAvatarOperation): boolean {
  return operation.startsWith("jira.upload-") || operation === "jira.crop-temporary-avatar";
}
function requiredFields(operation: JiraIdentityAvatarOperation): readonly PropertyKey[] {
  const keys: readonly PropertyKey[] = JIRA_IDENTITY_AVATAR_RECEIPTS[operation];
  if (createdAvatar(operation)) return keys.filter((key) => key !== "avatarId");
  return operation === "jira.create-user"
    ? keys.filter((key) => key !== "userKey" && key !== "username")
    : keys;
}
function optionalFields(operation: JiraIdentityAvatarOperation): readonly PropertyKey[] {
  const result: PropertyKey[] = [];
  if (operation === "jira.update-user") result.push("userActive");
  if (operation === "jira.create-user") result.push("userKey", "username");
  if (createdAvatar(operation)) result.push("avatarId");
  if (ownedAvatar(operation)) result.push("projectId", "projectKey", "issueTypeId");
  if (temporary(operation)) result.push("temporaryCrop", "temporaryNeedsCropping");
  return result;
}
function crop(value: unknown): boolean {
  if (!receiptFields(value, ["cropperOffsetX", "cropperOffsetY", "cropperWidth"])) return false;
  return (
    receiptInteger(data(value, "cropperOffsetX"), 0, 2147483647) &&
    receiptInteger(data(value, "cropperOffsetY"), 0, 2147483647) &&
    receiptInteger(data(value, "cropperWidth"), 1, 2147483647)
  );
}
const USER_KEYS: ReadonlySet<PropertyKey> = new Set([
  "actorUserKey",
  "userKey",
  "username",
  "newOwnerUserKey",
]);
const TRUE_KEYS: ReadonlySet<PropertyKey> = new Set([
  "temporaryAvatar",
  "avatarSelected",
  "userSessionInvalidationRequested",
  "anonymizationRequested",
  "anonymizationRerunRequested",
]);
function fieldValue(
  key: PropertyKey,
  value: unknown,
  operation: JiraIdentityAvatarOperation,
): boolean {
  if (USER_KEYS.has(key)) return jiraPropertyUserText(value);
  if (TRUE_KEYS.has(key)) return value === true;
  if (key === "projectKey") return isSafeAtlassianIdentifier(value);
  if (key === "avatarType") return value === "user" || value === "project" || value === "issuetype";
  if (key === "uploadSha256") return receiptDigest(value);
  if (key === "uploadBytes") return receiptInteger(value, 1, JIRA_ATTACHMENT_MAX_BYTES);
  if (key === "temporaryCrop") return crop(value);
  return stateValue(key, value, operation) ?? receiptNativeId(value);
}
function stateValue(
  key: PropertyKey,
  value: unknown,
  operation: JiraIdentityAvatarOperation,
): boolean | undefined {
  if (key === "temporaryNeedsCropping" || key === "userActive") return typeof value === "boolean";
  if (key === "userPresent") return value === (operation !== "jira.delete-user");
  if (key === "avatarPresent") return value === createdAvatar(operation);
  return undefined;
}
function ownerContext(receipt: object, operation: JiraIdentityAvatarOperation): boolean {
  if (!operation.endsWith("-avatar")) return true;
  const type = data(receipt, "avatarType");
  if (operation.endsWith("-temporary-avatar")) return true;
  if (ownedAvatar(operation)) return ownedContext(receipt, type);
  if (operation.includes("-project-")) return type === "project";
  if (operation.includes("-issue-type-")) return type === "issuetype";
  return type === "user";
}
function ownedContext(receipt: object, type: unknown): boolean {
  if (type === "issuetype")
    return (
      receiptNativeId(data(receipt, "issueTypeId")) &&
      !Object.hasOwn(receipt, "projectId") &&
      !Object.hasOwn(receipt, "projectKey")
    );
  return (
    type === "project" &&
    receiptNativeId(data(receipt, "projectId")) &&
    isSafeAtlassianIdentifier(data(receipt, "projectKey")) &&
    !Object.hasOwn(receipt, "issueTypeId")
  );
}
function related(receipt: object, operation: JiraIdentityAvatarOperation): boolean {
  if (!ownerContext(receipt, operation)) return false;
  if (
    operation === "jira.create-user" &&
    Object.hasOwn(receipt, "userKey") !== Object.hasOwn(receipt, "username")
  )
    return false;
  if (
    Object.hasOwn(receipt, "newOwnerUserKey") &&
    data(receipt, "newOwnerUserKey") === data(receipt, "userKey")
  )
    return false;
  return (
    Object.hasOwn(receipt, "temporaryCrop") === Object.hasOwn(receipt, "temporaryNeedsCropping")
  );
}
export function validJiraIdentityAvatarReceipt(
  receipt: JiraMutationReceipt,
  operation: JiraIdentityAvatarOperation,
): boolean {
  if (!receiptFields(receipt, requiredFields(operation), optionalFields(operation))) return false;
  return (
    Reflect.ownKeys(receipt).every((key) => fieldValue(key, data(receipt, key), operation)) &&
    related(receipt, operation) &&
    receiptWithinBudget(receipt)
  );
}
/** Only exact avatar selection and a display-name-only user update have independent confirmation. */
export function canConfirmJiraIdentityAvatar(
  operation: JiraMutationOperation,
  receipt: JiraMutationReceipt,
): boolean {
  if (!isJiraIdentityAvatarOperation(operation)) return true;
  return (
    operation === "jira.set-project-avatar" ||
    operation === "jira.set-user-avatar" ||
    (operation === "jira.update-user" && !Object.hasOwn(receipt, "userActive"))
  );
}
