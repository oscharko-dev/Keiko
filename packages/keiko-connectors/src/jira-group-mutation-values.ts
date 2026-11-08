import { JIRA_GROUP_MUTATIONS, type JiraGroupMutation, type JiraMutationAttempt, type JiraMutationReceipt } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { TOOL_CATALOG_LIMITS, type CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { asRecord } from "./atlassian-sync-classify.js";
import { savedExactKeys, savedText } from "./jira-saved-configuration-values.js";

/** Fixed GroupResource calls, separate from project-role defaults and application access. */
export { JIRA_GROUP_MUTATIONS, type JiraGroupMutation };
export interface JiraGroupMutationReceipt extends JiraMutationReceipt {
  readonly groupName?: string;
  readonly groupPresent?: boolean;
  readonly targetUserKey?: string;
  readonly requestedDirectMembership?: boolean;
  readonly swapGroupName?: string;
}
export type GroupMutationFailure = Omit<Extract<JiraMutationAttempt, { ok: false }>, "receipt"> & { readonly receipt?: JiraGroupMutationReceipt };
export type GroupMutationAttempt = GroupMutationFailure | { readonly ok: true; readonly receipt: JiraGroupMutationReceipt };
export type GroupObservation<T> = GroupMutationFailure | { readonly ok: true; readonly value: T };
export type GroupMutationInput = { readonly actor: string; readonly name: string } & (
  | { readonly kind: "create" }
  | { readonly kind: "delete"; readonly swap?: string }
  | { readonly kind: "membership"; readonly user: { readonly key: string; readonly name: string }; readonly expected: boolean; readonly present: boolean }
);
const FIELDS: Readonly<Record<JiraGroupMutation, ReadonlySet<string>>> = {
  "jira.create-group": new Set(["expectedActorKey", "groupName"]),
  "jira.delete-group": new Set(["expectedActorKey", "groupName", "swapGroupName", "acceptGlobalPermissionChange", "confirmUnverifiedDeletion"]),
  "jira.add-group-user": new Set(["expectedActorKey", "groupName", "user", "expectedObservedMembership", "acceptGlobalPermissionChange"]),
  "jira.remove-group-user": new Set(["expectedActorKey", "groupName", "user", "expectedObservedMembership", "acceptGlobalPermissionChange"]),
};
export const GROUP_MUTATION_MALFORMED: GroupMutationFailure = { ok: false, reason: "malformed-payload" };
export function isJiraGroupMutation(name: string): name is JiraGroupMutation { return Object.hasOwn(FIELDS, name); }
export function groupMutationRefusal(message: string, reason: "field-validation" | "conflict" | "unavailable" = "field-validation", receipt?: JiraGroupMutationReceipt): GroupMutationFailure {
  return { ok: false, reason, detail: { messages: [message] }, ...(receipt === undefined ? {} : { receipt }) };
}
function membershipInput(operation: JiraGroupMutation, args: CatalogJsonObject, actor: string, name: string): GroupMutationInput | undefined {
  const user = asRecord(args.user);
  if (args.acceptGlobalPermissionChange !== true || typeof args.expectedObservedMembership !== "boolean" || user === undefined ||
    !savedExactKeys(user, new Set(["key", "name"])) || !savedText(user.key, 255) || !savedText(user.name, 255)) return undefined;
  return { kind: "membership", actor, name, user: Object.freeze({ key: user.key, name: user.name }), expected: args.expectedObservedMembership, present: operation === "jira.add-group-user" };
}
function deleteInput(args: CatalogJsonObject, actor: string, name: string): GroupMutationInput | undefined {
  if (args.acceptGlobalPermissionChange !== true || args.confirmUnverifiedDeletion !== true) return undefined;
  const swap = args.swapGroupName;
  if (swap !== undefined && (!savedText(swap, 255) || swap === name)) return undefined;
  return { kind: "delete", actor, name, ...(typeof swap === "string" ? { swap } : {}) };
}
export function parseGroupMutationInput(operation: JiraGroupMutation, args: CatalogJsonObject): GroupMutationInput | undefined {
  if (!savedExactKeys(args, FIELDS[operation]) || !savedText(args.expectedActorKey, 255) || !savedText(args.groupName, 255) ||
    new TextEncoder().encode(JSON.stringify(args)).byteLength > TOOL_CATALOG_LIMITS.maxArgumentBytes) return undefined;
  const actor = args.expectedActorKey; const name = args.groupName;
  if (operation === "jira.create-group") return { kind: "create", actor, name };
  return operation === "jira.delete-group" ? deleteInput(args, actor, name) : membershipInput(operation, args, actor, name);
}
export function groupMutationReceipt(input: GroupMutationInput): JiraGroupMutationReceipt {
  return Object.freeze({ userKey: input.actor, groupName: input.name, groupPresent: input.kind !== "delete",
    ...(input.kind === "delete" && input.swap !== undefined ? { swapGroupName: input.swap } : {}),
    ...(input.kind === "membership" ? { targetUserKey: input.user.key, requestedDirectMembership: input.present } : {}) });
}
