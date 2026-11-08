import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
  type CatalogJsonValue,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { asArray, asRecord } from "./atlassian-sync-classify.js";
import { jiraSecurityLevelProjection } from "./jira-managed-access-schemes.js";
import { projectJiraOptionalFields } from "./jira-managed-metadata.js";
import { jiraNativeId, jiraNativeNumericId, jiraNativeText } from "./jira-native-values.js";
import { savedName, savedText } from "./jira-saved-configuration-values.js";

export interface RoleSnapshot {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
}
export interface RoleActor {
  readonly id: string;
  readonly type: "atlassian-user-role-actor" | "atlassian-group-role-actor";
  readonly name: string;
}
export function rolePrincipalText(value: unknown): value is string {
  return savedText(value, 255) && !/\p{Cc}/u.test(value);
}
function actorDetail(
  value: unknown,
  key: "id" | "type" | "displayName",
): CatalogJsonValue | undefined {
  const max = key === "type" ? 128 : 255;
  const text = jiraNativeText(value, max) ? value : undefined;
  return key === "id" ? jiraNativeNumericId(value) : text;
}
function actor(value: unknown): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  if (raw === undefined || !jiraNativeText(raw.name, 255)) return undefined;
  const details = projectJiraOptionalFields(raw, ["id", "type", "displayName"], actorDetail);
  return details === undefined ? undefined : { name: raw.name, ...details };
}
export function jiraRoleActors(value: unknown): readonly CatalogJsonObject[] | undefined {
  const values = asArray(value);
  if (values === undefined || values.length > TOOL_CATALOG_LIMITS.maxArrayItems) return undefined;
  const items: CatalogJsonObject[] = [];
  const observedIds = new Set<string>();
  for (const value of values) {
    const item = actor(value);
    if (item === undefined) return undefined;
    // A user and group can share a name. Only an actual actor ID establishes identity uniqueness.
    if (typeof item.id === "string") {
      if (observedIds.has(item.id)) return undefined;
      observedIds.add(item.id);
    }
    items.push(item);
  }
  return items;
}
export function jiraRoleSummary(value: unknown): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  const metadata = jiraSecurityLevelProjection(value);
  if (raw === undefined || metadata === undefined) return undefined;
  if (raw.actors === undefined || raw.actors === null) return metadata;
  const items = jiraRoleActors(raw.actors);
  return items === undefined ? undefined : { ...metadata, actors: items };
}
/** The existing read projector preserves missing facts. Write review requires the native facts. */
export function jiraRoleReviewSnapshot(value: unknown): RoleSnapshot | undefined {
  const raw = asRecord(value);
  const projected = jiraRoleSummary(value);
  if (
    raw === undefined ||
    projected === undefined ||
    !jiraNativeId(projected.id) ||
    !savedName(projected.name)
  )
    return undefined;
  if (!Object.hasOwn(raw, "description")) return undefined;
  const description = raw.description;
  return description === null || savedText(description, 32768, true)
    ? { id: projected.id, name: projected.name, description }
    : undefined;
}
function roleActor(value: CatalogJsonObject): RoleActor | undefined {
  if (!jiraNativeId(value.id) || !rolePrincipalText(value.name)) return undefined;
  return value.type === "atlassian-user-role-actor" || value.type === "atlassian-group-role-actor"
    ? { id: value.id, name: value.name, type: value.type }
    : undefined;
}
export function jiraRoleReviewActors(value: unknown): readonly RoleActor[] | undefined {
  const projected = jiraRoleActors(value);
  if (projected === undefined) return undefined;
  const result: RoleActor[] = [];
  const names = new Set<string>();
  for (const item of projected) {
    const actor = roleActor(item);
    if (actor === undefined) return undefined;
    const key = JSON.stringify([actor.type, actor.name]);
    if (names.has(key)) return undefined;
    names.add(key);
    result.push(actor);
  }
  return result;
}
