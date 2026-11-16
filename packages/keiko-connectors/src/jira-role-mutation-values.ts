import {
  JIRA_ROLE_MUTATIONS,
  type JiraRoleMutation,
  isSafeAtlassianIdentifier,
  type JiraMutationAttempt,
  type JiraMutationReceipt,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { asRecord } from "./atlassian-sync-classify.js";
import {
  jiraRoleReviewActors,
  jiraRoleReviewSnapshot,
  rolePrincipalText,
  type RoleActor,
  type RoleSnapshot,
} from "./jira-role-values.js";
export {
  jiraRoleReviewActors,
  jiraRoleReviewSnapshot,
  rolePrincipalText,
  type RoleActor,
  type RoleSnapshot,
} from "./jira-role-values.js";
import { jiraNativeId } from "./jira-native-values.js";
import { savedExactKeys, savedName, savedText } from "./jira-saved-configuration-values.js";

export {
  JIRA_ROLE_MUTATIONS,
  type JiraRoleMutation,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
export function isJiraRoleMutation(name: string): name is JiraRoleMutation {
  return (JIRA_ROLE_MUTATIONS as readonly string[]).includes(name);
}
export interface JiraRoleMutationReceipt extends JiraMutationReceipt {
  readonly roleId?: string;
  readonly rolePresent?: boolean;
  readonly swapRoleId?: string;
  readonly roleActorsScope?: "role-defaults" | "project-membership";
  readonly actorChange?: "add" | "replace" | "remove";
  readonly actorUserKeys?: readonly string[];
  readonly actorGroupNames?: readonly string[];
}
export type RoleFailure = Omit<Extract<JiraMutationAttempt, { ok: false }>, "receipt"> & {
  readonly receipt?: JiraRoleMutationReceipt;
};
export type RoleAttempt =
  RoleFailure | { readonly ok: true; readonly receipt: JiraRoleMutationReceipt };
export type RoleObservation<T> = RoleFailure | { readonly ok: true; readonly value: T };
export interface RoleUser {
  readonly key: string;
  readonly name: string;
}
export interface RolePrincipals {
  readonly users: readonly RoleUser[];
  readonly groups: readonly string[];
}
export interface RoleSelection {
  readonly operation: JiraRoleMutation;
  readonly actorKey: string;
  readonly role?: RoleSnapshot;
  readonly expectedActors?: readonly RoleActor[];
  readonly project?: string;
  readonly target?: { readonly name?: string; readonly description?: string };
  readonly principals?: RolePrincipals;
  readonly swap?: { readonly role: RoleSnapshot; readonly actors: readonly RoleActor[] };
}
export const ROLE_MALFORMED: RoleFailure = { ok: false, reason: "malformed-payload" };
export function roleRefusal(
  message: string,
  reason: "field-validation" | "conflict" | "unavailable" = "field-validation",
  receipt?: JiraRoleMutationReceipt,
): RoleFailure {
  return {
    ok: false,
    reason,
    detail: { messages: [message] },
    ...(receipt === undefined ? {} : { receipt }),
  };
}
const SNAPSHOT_KEYS = new Set(["id", "name", "description"]);
const ACTOR_KEYS = new Set(["id", "name", "type"]);
function snapshot(value: unknown): RoleSnapshot | undefined {
  const raw = asRecord(value);
  return raw !== undefined &&
    jiraNativeId(raw.id) &&
    Object.keys(raw).every((key) => SNAPSHOT_KEYS.has(key))
    ? jiraRoleReviewSnapshot(raw)
    : undefined;
}
function actorSnapshot(value: unknown): readonly RoleActor[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (
    !value.every((entry) => {
      const raw = asRecord(entry);
      return (
        raw !== undefined &&
        jiraNativeId(raw.id) &&
        Object.keys(raw).every((key) => ACTOR_KEYS.has(key))
      );
    })
  )
    return undefined;
  return jiraRoleReviewActors(value);
}
function users(value: unknown): readonly RoleUser[] | undefined {
  if (!Array.isArray(value) || value.length > 50) return undefined;
  const result: RoleUser[] = [];
  const keys = new Set<string>();
  const names = new Set<string>();
  for (const item of value) {
    const raw = asRecord(item);
    if (raw === undefined || !rolePrincipalText(raw.key) || !rolePrincipalText(raw.name))
      return undefined;
    if (
      Object.keys(raw).some((key) => key !== "key" && key !== "name") ||
      keys.has(raw.key) ||
      names.has(raw.name)
    )
      return undefined;
    keys.add(raw.key);
    names.add(raw.name);
    result.push({ key: raw.key, name: raw.name });
  }
  return result;
}
function groups(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) &&
    value.length <= 50 &&
    value.every((name): name is string => rolePrincipalText(name)) &&
    new Set(value).size === value.length
    ? [...value]
    : undefined;
}
function validPrincipalCount(
  selectedUsers: readonly RoleUser[],
  selectedGroups: readonly string[],
  operation: JiraRoleMutation,
): boolean {
  const count = selectedUsers.length + selectedGroups.length;
  if (count > 50) return false;
  if (operation === "jira.set-project-role-actors") return true;
  if (count === 0 || (selectedUsers.length > 0 && selectedGroups.length > 0)) return false;
  return !operation.startsWith("jira.delete-") || count === 1;
}
function principals(value: unknown, operation: JiraRoleMutation): RolePrincipals | undefined {
  const raw = asRecord(value);
  if (raw === undefined || Object.keys(raw).some((key) => key !== "users" && key !== "groups"))
    return undefined;
  const selectedUsers = users(raw.users);
  const selectedGroups = groups(raw.groups);
  if (selectedUsers === undefined || selectedGroups === undefined) return undefined;
  return validPrincipalCount(selectedUsers, selectedGroups, operation)
    ? { users: selectedUsers, groups: selectedGroups }
    : undefined;
}
const BASE = ["expectedActorKey", "expectedRole", "expectedActors"];
function inputKeys(operation: JiraRoleMutation): ReadonlySet<string> {
  if (operation === "jira.create-role") return new Set(["expectedActorKey", "name", "description"]);
  if (operation === "jira.update-role" || operation === "jira.replace-role")
    return new Set([...BASE, "name", "description"]);
  if (operation === "jira.delete-role")
    return new Set([
      ...BASE,
      "expectedSwapRole",
      "expectedSwapActors",
      "confirmUnverifiedDeletion",
    ]);
  return new Set([
    ...BASE,
    "principals",
    ...(operation.includes("project-role") ? ["projectIdOrKey"] : []),
  ]);
}
function targetFields(args: CatalogJsonObject): RoleSelection["target"] {
  if (args.name !== undefined && !savedName(args.name)) return undefined;
  if (args.description !== undefined && !savedText(args.description, 32768, true)) return undefined;
  if (args.name === undefined && args.description === undefined) return undefined;
  return {
    ...(typeof args.name === "string" ? { name: args.name } : {}),
    ...(typeof args.description === "string" ? { description: args.description } : {}),
  };
}
function target(args: CatalogJsonObject, partial: boolean): RoleSelection["target"] {
  if (!partial && (args.name === undefined || args.description === undefined)) return undefined;
  return targetFields(args);
}
function deletion(args: CatalogJsonObject, base: RoleSelection): RoleSelection | undefined {
  if (args.confirmUnverifiedDeletion !== true) return undefined;
  if (args.expectedSwapRole === undefined && args.expectedSwapActors === undefined) return base;
  const role = snapshot(args.expectedSwapRole);
  const actors = actorSnapshot(args.expectedSwapActors);
  return role === undefined || actors === undefined || role.id === base.role?.id
    ? undefined
    : { ...base, swap: { role, actors } };
}
function actorSelection(args: CatalogJsonObject, base: RoleSelection): RoleSelection | undefined {
  const selected = principals(args.principals, base.operation);
  if (selected === undefined) return undefined;
  if (!base.operation.includes("project-role")) return { ...base, principals: selected };
  if (!isSafeAtlassianIdentifier(args.projectIdOrKey)) return undefined;
  if (
    base.operation === "jira.set-project-role-actors" &&
    !Number.isSafeInteger(Number(base.role?.id))
  )
    return undefined;
  return { ...base, principals: selected, project: args.projectIdOrKey };
}
function existingSelection(
  args: CatalogJsonObject,
  common: Pick<RoleSelection, "operation" | "actorKey">,
): RoleSelection | undefined {
  const operation = common.operation;
  const role = snapshot(args.expectedRole);
  const expectedActors = actorSnapshot(args.expectedActors);
  if (role === undefined || expectedActors === undefined) return undefined;
  const base = { ...common, role, expectedActors };
  if (operation === "jira.delete-role") return deletion(args, base);
  if (operation === "jira.update-role" || operation === "jira.replace-role") {
    const desired = target(args, operation === "jira.update-role");
    return desired === undefined ? undefined : { ...base, target: desired };
  }
  return actorSelection(args, base);
}
export function parseRoleMutation(
  operation: string,
  args: CatalogJsonObject,
): RoleSelection | undefined {
  if (
    !isJiraRoleMutation(operation) ||
    !savedExactKeys(args, inputKeys(operation)) ||
    !rolePrincipalText(args.expectedActorKey)
  )
    return undefined;
  const common = { operation, actorKey: args.expectedActorKey };
  if (operation !== "jira.create-role") return existingSelection(args, common);
  const desired = target(args, false);
  return desired === undefined ? undefined : { ...common, target: desired };
}
export function sameRole(left: RoleSnapshot, right: RoleSnapshot): boolean {
  return left.id === right.id && left.name === right.name && left.description === right.description;
}
export function sameRoleActors(left: readonly RoleActor[], right: readonly RoleActor[]): boolean {
  return (
    left.length === right.length &&
    left.every((actor) =>
      right.some(
        (other) => actor.id === other.id && actor.type === other.type && actor.name === other.name,
      ),
    )
  );
}
