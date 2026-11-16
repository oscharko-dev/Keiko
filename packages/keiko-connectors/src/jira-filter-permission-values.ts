import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { asRecord } from "./atlassian-sync-classify.js";
import { jiraDirectoryUser } from "./jira-directory-values.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { projectJiraFilterPermission } from "./jira-managed-saved-views.js";
import { dispatchFailure } from "./jira-mutation-failure.js";
import { jiraNativeId, jiraNativeNumericId } from "./jira-native-values.js";
import {
  savedText,
  SAVED_MALFORMED,
  type SavedObservation,
} from "./jira-saved-configuration-values.js";

const SNAPSHOT_FIELDS = new Set([
  "id",
  "type",
  "groupName",
  "projectId",
  "projectKey",
  "roleId",
  "roleName",
  "userName",
  "userDisplayName",
  "edit",
  "view",
]);
const TARGET_FIELDS = new Set([
  "type",
  "groupName",
  "projectId",
  "roleId",
  "userKey",
  "expectedUsername",
  "edit",
  "view",
]);
const SHARE_TYPES: ReadonlySet<unknown> = new Set([
  "global",
  "authenticated",
  "group",
  "project",
  "user",
]);
const TARGET_KEYS = ["groupName", "projectId", "roleId", "userKey", "expectedUsername"] as const;
const SNAPSHOT_TARGETS = [
  ["groupName", "group", "name"],
  ["projectId", "project", "id"],
  ["projectKey", "project", "key"],
  ["roleId", "role", "id"],
  ["roleName", "role", "name"],
  ["userName", "user", "name"],
  ["userDisplayName", "user", "displayName"],
] as const;
export interface FilterPermissionTarget {
  readonly type: "global" | "authenticated" | "group" | "project" | "user";
  readonly view: boolean;
  readonly edit: boolean;
  readonly groupName?: string;
  readonly projectId?: string;
  readonly roleId?: string;
  readonly userKey?: string;
  readonly expectedUsername?: string;
}
function permissionSnapshot(value: unknown): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  if (raw === undefined || Object.keys(raw).some((key) => !SNAPSHOT_FIELDS.has(key)))
    return undefined;
  const native: Record<string, unknown> = {
    id: raw.id,
    type: raw.type,
    edit: raw.edit,
    view: raw.view,
  };
  for (const [field, group, key] of SNAPSHOT_TARGETS) {
    if (raw[field] === undefined) continue;
    native[group] = { ...asRecord(native[group]), [key]: raw[field] };
  }
  const projected = projectJiraFilterPermission(native);
  return projected !== undefined && Object.keys(raw).every((key) => projected[key] === raw[key])
    ? projected
    : undefined;
}
export function filterPermissionSnapshots(
  value: unknown,
): readonly CatalogJsonObject[] | undefined {
  if (!Array.isArray(value) || value.length > TOOL_CATALOG_LIMITS.maxArrayItems) return undefined;
  const rows: CatalogJsonObject[] = [];
  const ids = new Set<string>();
  for (const entry of value) {
    const row = permissionSnapshot(entry);
    if (row === undefined || typeof row.id !== "string" || ids.has(row.id)) return undefined;
    ids.add(row.id);
    rows.push(row);
  }
  return rows;
}
export function sameFilterPermission(left: CatalogJsonObject, right: CatalogJsonObject): boolean {
  return (
    Object.keys(left).length === Object.keys(right).length &&
    Object.keys(left).every((key) => left[key] === right[key])
  );
}
export function sameFilterPermissions(
  left: readonly CatalogJsonObject[],
  right: readonly CatalogJsonObject[],
): boolean {
  const expected = new Map(right.map((permission) => [permission.id, permission]));
  return (
    left.length === right.length &&
    left.every((permission) => {
      const match = expected.get(permission.id);
      return match !== undefined && sameFilterPermission(permission, match);
    })
  );
}
function onlyTargetFields(raw: CatalogJsonObject, allowed: ReadonlySet<string>): boolean {
  return TARGET_KEYS.every((key) => raw[key] === undefined || allowed.has(key));
}
function broadTarget(raw: CatalogJsonObject): FilterPermissionTarget | undefined {
  if (raw.type !== "global" && raw.type !== "authenticated") return undefined;
  return onlyTargetFields(raw, new Set()) && raw.view === true && raw.edit === false
    ? { type: raw.type, view: true, edit: false }
    : undefined;
}
function specificTarget(
  raw: CatalogJsonObject,
  view: boolean,
  edit: boolean,
): FilterPermissionTarget | undefined {
  if (raw.type === "group")
    return onlyTargetFields(raw, new Set(["groupName"])) && savedText(raw.groupName, 255)
      ? { type: "group", view, edit, groupName: raw.groupName }
      : undefined;
  if (raw.type === "user")
    return onlyTargetFields(raw, new Set(["userKey", "expectedUsername"])) &&
      savedText(raw.userKey, 255) &&
      savedText(raw.expectedUsername, 255)
      ? { type: "user", view, edit, userKey: raw.userKey, expectedUsername: raw.expectedUsername }
      : undefined;
  return raw.type === "project" ? projectTarget(raw, view, edit) : undefined;
}
function projectTarget(
  raw: CatalogJsonObject,
  view: boolean,
  edit: boolean,
): FilterPermissionTarget | undefined {
  if (!onlyTargetFields(raw, new Set(["projectId", "roleId"])) || !jiraNativeId(raw.projectId))
    return undefined;
  if (raw.roleId !== undefined && !jiraNativeId(raw.roleId)) return undefined;
  return {
    type: "project",
    view,
    edit,
    projectId: raw.projectId,
    ...(raw.roleId === undefined ? {} : { roleId: raw.roleId }),
  };
}
function targetSelectors(raw: Record<string, unknown>): Record<string, string> | undefined {
  const fields: Record<string, string> = {};
  for (const key of TARGET_KEYS) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== "string") return undefined;
    fields[key] = raw[key];
  }
  return fields;
}
function targetRights(
  raw: Record<string, unknown>,
): { readonly view: boolean; readonly edit: boolean } | undefined {
  if (Object.keys(raw).some((key) => !TARGET_FIELDS.has(key)) || !SHARE_TYPES.has(raw.type))
    return undefined;
  const { view, edit } = raw;
  if (typeof view !== "boolean" || typeof edit !== "boolean" || (!view && !edit)) return undefined;
  return { view, edit };
}
export function filterPermissionTarget(value: unknown): FilterPermissionTarget | undefined {
  const raw = asRecord(value);
  if (raw === undefined) return undefined;
  const rights = targetRights(raw);
  if (rights === undefined) return undefined;
  // The input is a CatalogJsonValue at the dispatch boundary. Build a closed object, never cast a
  // native arbitrary object into catalog arguments or preserve extra recipient selectors.
  const selected: CatalogJsonObject = {
    type: typeof raw.type === "string" ? raw.type : "",
    view: rights.view,
    edit: rights.edit,
  };
  const fields = targetSelectors(raw);
  if (fields === undefined) return undefined;
  const input = { ...selected, ...fields };
  return input.type === "global" || input.type === "authenticated"
    ? broadTarget(input)
    : specificTarget(input, rights.view, rights.edit);
}
function recipientMatches(row: CatalogJsonObject, target: FilterPermissionTarget): boolean {
  if (target.type === "group")
    return (
      row.groupName === target.groupName &&
      recipientFieldsAbsent(row, [
        "projectId",
        "projectKey",
        "roleId",
        "roleName",
        "userName",
        "userDisplayName",
      ])
    );
  if (target.type === "user")
    return (
      row.userName === target.expectedUsername &&
      recipientFieldsAbsent(row, ["groupName", "projectId", "projectKey", "roleId", "roleName"])
    );
  if (target.type === "project") return projectRecipientMatches(row, target);
  return recipientFieldsAbsent(row, [
    "groupName",
    "projectId",
    "projectKey",
    "roleId",
    "roleName",
    "userName",
    "userDisplayName",
  ]);
}
export function filterPermissionMatches(
  row: CatalogJsonObject,
  target: FilterPermissionTarget,
  rights = true,
): boolean {
  if (row.type !== target.type) return false;
  if (rights && (row.view !== target.view || row.edit !== target.edit)) return false;
  return recipientMatches(row, target);
}
function recipientFieldsAbsent(row: CatalogJsonObject, fields: readonly string[]): boolean {
  return fields.every((field) => row[field] === undefined);
}
function projectRecipientMatches(row: CatalogJsonObject, target: FilterPermissionTarget): boolean {
  if (row.projectId !== target.projectId || row.roleId !== target.roleId) return false;
  if (target.roleId === undefined && row.roleName !== undefined) return false;
  return recipientFieldsAbsent(row, ["groupName", "userName", "userDisplayName"]);
}
/** A sharing change must not discard opaque recipients or invent their omitted view/edit rights. */
export function reviewableFilterPermission(row: CatalogJsonObject): boolean {
  if (typeof row.view !== "boolean" || typeof row.edit !== "boolean") return false;
  const rights = { view: row.view, edit: row.edit };
  switch (row.type) {
    case "global":
    case "authenticated":
      return filterPermissionMatches(row, { type: row.type, ...rights });
    case "group":
      return (
        savedText(row.groupName, 255) &&
        filterPermissionMatches(row, { type: "group", ...rights, groupName: row.groupName })
      );
    case "user":
      return (
        savedText(row.userName, 255) &&
        filterPermissionMatches(row, { type: "user", ...rights, expectedUsername: row.userName })
      );
    case "project":
      return reviewableProjectPermission(row, rights);
    default:
      return false;
  }
}
function reviewableProjectPermission(
  row: CatalogJsonObject,
  rights: { readonly view: boolean; readonly edit: boolean },
): boolean {
  if (!jiraNativeId(row.projectId)) return false;
  if (row.roleId !== undefined && !jiraNativeId(row.roleId)) return false;
  return filterPermissionMatches(row, {
    type: "project",
    ...rights,
    projectId: row.projectId,
    ...(row.roleId === undefined ? {} : { roleId: row.roleId }),
  });
}
export function filterPermissionBody(target: FilterPermissionTarget): CatalogJsonObject {
  return {
    type: target.type,
    view: target.view,
    edit: target.edit,
    ...(target.groupName === undefined ? {} : { groupname: target.groupName }),
    ...(target.projectId === undefined ? {} : { projectId: target.projectId }),
    ...(target.roleId === undefined ? {} : { projectRoleId: target.roleId }),
    ...(target.userKey === undefined ? {} : { userKey: target.userKey }),
  };
}
export async function bindFilterPermissionRecipient(
  request: JiraMutationRequest,
  target: FilterPermissionTarget,
): Promise<SavedObservation<true>> {
  if (target.type === "user" && target.userKey !== undefined) {
    const response = await request(
      `user?${new URLSearchParams({ key: target.userKey }).toString()}`,
      "GET",
      undefined,
      "json",
    );
    if (!response.ok) return dispatchFailure(response);
    const user = response.status === 200 ? jiraDirectoryUser(response.body) : undefined;
    return user?.key === target.userKey && user.name === target.expectedUsername
      ? { ok: true, value: true }
      : SAVED_MALFORMED;
  }
  if (target.type !== "project" || target.projectId === undefined) return { ok: true, value: true };
  return bindProjectRecipient(request, target.projectId, target.roleId);
}
async function bindProjectRecipient(
  request: JiraMutationRequest,
  projectId: string,
  roleId: string | undefined,
): Promise<SavedObservation<true>> {
  const project = await request(`project/${projectId}`, "GET", undefined, "json");
  if (!project.ok) return dispatchFailure(project);
  if (project.status !== 200 || jiraNativeNumericId(project.body?.id) !== projectId)
    return SAVED_MALFORMED;
  if (roleId === undefined) return { ok: true, value: true };
  const role = await request(`project/${projectId}/role/${roleId}`, "GET", undefined, "json");
  if (!role.ok) return dispatchFailure(role);
  return role.status === 200 && jiraNativeNumericId(role.body?.id) === roleId
    ? { ok: true, value: true }
    : SAVED_MALFORMED;
}
