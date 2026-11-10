import {
  isSafeAtlassianIdentifier,
  type JiraDirectoryAccessMutation,
  type JiraMutationAttempt,
  type JiraMutationReceipt,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { asRecord } from "./atlassian-sync-classify.js";
import type { JiraApplicationRoleConfiguration } from "./jira-directory-access-request.js";
import { savedExactKeys, savedText } from "./jira-saved-configuration-values.js";

export {
  JIRA_DIRECTORY_ACCESS_MUTATIONS,
  type JiraDirectoryAccessMutation,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
export interface DirectoryAccessReceipt extends JiraMutationReceipt {
  readonly actorUserKey: string;
  readonly applicationRoleKeys?: readonly string[];
  readonly applicationAccessRequested?: boolean;
  readonly columnsResetRequested?: true;
}
export type DirectoryAccessFailure = Omit<
  Extract<JiraMutationAttempt, { ok: false }>,
  "receipt"
> & { readonly receipt?: DirectoryAccessReceipt };
export type DirectoryAccessAttempt =
  | DirectoryAccessFailure
  | { readonly ok: true; readonly receipt: DirectoryAccessReceipt | Record<string, never> };
export type DirectoryAccessObservation<T> =
  DirectoryAccessFailure | { readonly ok: true; readonly value: T };
export interface DirectoryAccessUser {
  readonly key: string;
  readonly name: string;
}
export interface DirectoryRoleChange {
  readonly expected: JiraApplicationRoleConfiguration;
  readonly value: JiraApplicationRoleConfiguration;
}
interface Common {
  readonly actor: string;
}
export type DirectoryAccessInput = Common &
  (
    | {
        readonly kind: "roles";
        readonly bulk: boolean;
        readonly roles: readonly DirectoryRoleChange[];
      }
    | {
        readonly kind: "application";
        readonly user: DirectoryAccessUser;
        readonly role: JiraApplicationRoleConfiguration;
        readonly present: boolean;
      }
    | {
        readonly kind: "columns";
        readonly user: DirectoryAccessUser;
        readonly expected: readonly string[];
        readonly columns: readonly string[];
      }
    | {
        readonly kind: "reset";
        readonly user: DirectoryAccessUser;
        readonly expected: readonly string[];
      }
  );
export const DIRECTORY_ACCESS_MALFORMED: DirectoryAccessFailure = {
  ok: false,
  reason: "malformed-payload",
};
export function directoryAccessRefusal(
  message: string,
  reason: "field-validation" | "conflict" | "unavailable" = "field-validation",
  receipt?: DirectoryAccessReceipt,
): DirectoryAccessFailure {
  return {
    ok: false,
    reason,
    detail: { messages: [message] },
    ...(receipt === undefined ? {} : { receipt }),
  };
}
export function directoryStrings(
  value: unknown,
  empty: boolean,
  unique: boolean,
): readonly string[] | undefined {
  if (
    !Array.isArray(value) ||
    (!empty && value.length === 0) ||
    value.length > TOOL_CATALOG_LIMITS.maxArrayItems ||
    !value.every((item) => savedText(item, 255)) ||
    (unique && new Set(value).size !== value.length)
  )
    return undefined;
  return Object.freeze([...value]);
}
const ROLE_KEYS = new Set(["key", "groups", "defaultGroups"]);
export function directoryRole(value: unknown): JiraApplicationRoleConfiguration | undefined {
  const raw = asRecord(value);
  if (raw === undefined || !savedExactKeys(raw, ROLE_KEYS) || !isSafeAtlassianIdentifier(raw.key))
    return undefined;
  const groups = directoryStrings(raw.groups, true, true);
  const defaultGroups = directoryStrings(raw.defaultGroups, true, true);
  return groups === undefined || !defaultGroups?.every((name) => groups.includes(name))
    ? undefined
    : Object.freeze({ key: raw.key, groups, defaultGroups });
}
function change(value: unknown): DirectoryRoleChange | undefined {
  const raw = asRecord(value);
  if (raw === undefined || !savedExactKeys(raw, new Set(["expected", "value"]))) return undefined;
  const expected = directoryRole(raw.expected);
  const desired = directoryRole(raw.value);
  return expected === undefined || desired?.key !== expected.key
    ? undefined
    : { expected, value: desired };
}
function roleInput(
  args: CatalogJsonObject,
  actor: string,
  bulk: boolean,
): DirectoryAccessInput | undefined {
  if (args.acceptGlobalPermissionChange !== true) return undefined;
  const values = bulk ? args.roles : [args.role];
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    values.length > TOOL_CATALOG_LIMITS.maxArrayItems
  )
    return undefined;
  const roles: DirectoryRoleChange[] = [];
  for (const value of values) {
    const selected = change(value);
    if (selected === undefined) return undefined;
    roles.push(selected);
  }
  return new Set(roles.map((selected) => selected.value.key)).size === roles.length
    ? { kind: "roles", actor, bulk, roles }
    : undefined;
}
function selectedUser(value: unknown): DirectoryAccessUser | undefined {
  const raw = asRecord(value);
  return raw !== undefined &&
    savedExactKeys(raw, new Set(["key", "name"])) &&
    savedText(raw.key, 255) &&
    savedText(raw.name, 255)
    ? { key: raw.key, name: raw.name }
    : undefined;
}
function userInput(
  operation: JiraDirectoryAccessMutation,
  args: CatalogJsonObject,
  actor: string,
): DirectoryAccessInput | undefined {
  const user = selectedUser(args.user);
  if (user === undefined) return undefined;
  if (operation === "jira.add-user-application" || operation === "jira.remove-user-application") {
    const role = directoryRole(args.expectedApplicationRole);
    return role === undefined || args.acceptGlobalPermissionChange !== true
      ? undefined
      : {
          kind: "application",
          actor,
          user,
          role,
          present: operation === "jira.add-user-application",
        };
  }
  const expected = directoryStrings(args.expectedColumns, false, false);
  if (expected === undefined) return undefined;
  if (operation === "jira.reset-user-columns") return { kind: "reset", actor, user, expected };
  const columns = directoryStrings(args.columns, false, false);
  return columns === undefined ? undefined : { kind: "columns", actor, user, expected, columns };
}
const FIELDS: Readonly<Record<JiraDirectoryAccessMutation, ReadonlySet<string>>> = {
  "jira.set-application-role": new Set([
    "expectedActorKey",
    "role",
    "acceptGlobalPermissionChange",
  ]),
  "jira.set-application-roles": new Set([
    "expectedActorKey",
    "roles",
    "acceptGlobalPermissionChange",
  ]),
  "jira.add-user-application": new Set([
    "expectedActorKey",
    "user",
    "expectedApplicationRole",
    "acceptGlobalPermissionChange",
  ]),
  "jira.remove-user-application": new Set([
    "expectedActorKey",
    "user",
    "expectedApplicationRole",
    "acceptGlobalPermissionChange",
  ]),
  "jira.set-user-columns": new Set(["expectedActorKey", "user", "expectedColumns", "columns"]),
  "jira.reset-user-columns": new Set(["expectedActorKey", "user", "expectedColumns"]),
};
export function isJiraDirectoryAccessMutation(name: string): name is JiraDirectoryAccessMutation {
  return Object.hasOwn(FIELDS, name);
}
export function parseDirectoryAccessInput(
  operation: JiraDirectoryAccessMutation,
  args: CatalogJsonObject,
): DirectoryAccessInput | undefined {
  if (
    !savedExactKeys(args, FIELDS[operation]) ||
    !savedText(args.expectedActorKey, 255) ||
    new TextEncoder().encode(JSON.stringify(args)).byteLength > TOOL_CATALOG_LIMITS.maxArgumentBytes
  )
    return undefined;
  if (operation === "jira.set-application-role" || operation === "jira.set-application-roles")
    return roleInput(args, args.expectedActorKey, operation === "jira.set-application-roles");
  return userInput(operation, args, args.expectedActorKey);
}
export function sameDirectoryRole(
  left: JiraApplicationRoleConfiguration,
  right: JiraApplicationRoleConfiguration,
): boolean {
  return (
    left.key === right.key &&
    sameDirectorySet(left.groups, right.groups) &&
    sameDirectorySet(left.defaultGroups, right.defaultGroups)
  );
}
function sameDirectorySet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}
export function sameDirectoryColumns(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
export function directoryAccessReceipt(input: DirectoryAccessInput): DirectoryAccessReceipt {
  const actorUserKey = input.actor;
  if (input.kind === "roles")
    return { actorUserKey, applicationRoleKeys: input.roles.map((role) => role.value.key) };
  const user = { actorUserKey, userKey: input.user.key, username: input.user.name };
  if (input.kind === "application")
    return {
      ...user,
      applicationRoleKeys: [input.role.key],
      applicationAccessRequested: input.present,
    };
  return input.kind === "columns"
    ? { ...user, columnIds: input.columns }
    : { ...user, columnsResetRequested: true };
}
