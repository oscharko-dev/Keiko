import { isSafeAtlassianIdentifier, JIRA_READ_TOOL_FAMILIES } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { TOOL_CATALOG_LIMITS, type CatalogJsonObject, type CatalogJsonValue } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolResult } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { asRecord } from "./atlassian-sync-classify.js";
import {
  bindJiraPropertyEntity,
  type JiraEntityPropertyPorts,
  type JiraPropertyEntity,
} from "./jira-entity-property-bindings.js";
import { jiraPropertyKey, jiraPropertyPathKey, jiraPropertyUserText, jiraPropertyValue } from "./jira-entity-property-values.js";
import { boundJiraReadResult } from "./jira-managed-issue-reads.js";
import { jiraReadFailure, localJiraPage } from "./jira-managed-metadata.js";
import { executeJiraSelectedRead, selectJiraReadPage } from "./jira-managed-read-request.js";
import { jiraNativeId } from "./jira-native-values.js";

const ENTITIES = [
  { kind: "board", keys: "jira.board-property-keys", value: "jira.board-property", fields: ["boardId"] },
  { kind: "sprint", keys: "jira.sprint-property-keys", value: "jira.sprint-property", fields: ["sprintId"] },
  { kind: "comment", keys: "jira.comment-property-keys", value: "jira.comment-property", fields: ["issueIdOrKey", "commentId"] },
  { kind: "dashboard-item", keys: "jira.dashboard-item-property-keys", value: "jira.dashboard-item-property", fields: ["dashboardId", "itemId"] },
  { kind: "issue", keys: "jira.issue-property-keys", value: "jira.issue-property", fields: ["issueIdOrKey"] },
  { kind: "issue-type", keys: "jira.issue-type-property-keys", value: "jira.issue-type-property", fields: ["issueTypeId"] },
  { kind: "project", keys: "jira.project-property-keys", value: "jira.project-property", fields: ["projectIdOrKey"] },
  { kind: "user", keys: "jira.user-property-keys", value: "jira.user-property", fields: ["username", "userKey"] },
] as const;
type PropertyRead = (typeof ENTITIES)[number]["keys" | "value"];
export const JIRA_ENTITY_PROPERTY_READS = JIRA_READ_TOOL_FAMILIES.entityProperties;
const READS: ReadonlySet<string> = new Set(JIRA_ENTITY_PROPERTY_READS);
export interface JiraPropertyReadSelection {
  readonly entity: JiraPropertyEntity;
  readonly startAt: number;
  readonly maxResults: number;
  readonly propertyKey?: string;
}
function userSelection(args: CatalogJsonObject): JiraPropertyEntity | undefined {
  const { username, userKey } = args;
  if ((username === undefined) === (userKey === undefined)) return undefined;
  if (jiraPropertyUserText(username))
    return { kind: "user", user: { username } };
  return jiraPropertyUserText(userKey)
    ? { kind: "user", user: { userKey } } : undefined;
}
type EntitySelector = (args: CatalogJsonObject) => JiraPropertyEntity | undefined;
const ENTITY_SELECTIONS: Readonly<Record<JiraPropertyEntity["kind"], EntitySelector>> = {
  board: (args) => jiraNativeId(args.boardId) ? { kind: "board", id: args.boardId } : undefined,
  sprint: (args) => jiraNativeId(args.sprintId) ? { kind: "sprint", id: args.sprintId } : undefined,
  comment: (args) => isSafeAtlassianIdentifier(args.issueIdOrKey) && jiraNativeId(args.commentId)
    ? { kind: "comment", issueIdOrKey: args.issueIdOrKey, commentId: args.commentId } : undefined,
  "dashboard-item": (args) => jiraNativeId(args.dashboardId) && jiraNativeId(args.itemId)
    ? { kind: "dashboard-item", dashboardId: args.dashboardId, itemId: args.itemId } : undefined,
  issue: (args) => isSafeAtlassianIdentifier(args.issueIdOrKey)
    ? { kind: "issue", issueIdOrKey: args.issueIdOrKey } : undefined,
  "issue-type": (args) => jiraNativeId(args.issueTypeId)
    ? { kind: "issue-type", issueTypeId: args.issueTypeId } : undefined,
  project: (args) => isSafeAtlassianIdentifier(args.projectIdOrKey)
    ? { kind: "project", projectIdOrKey: args.projectIdOrKey } : undefined,
  user: userSelection,
};
function entitySelection(kind: JiraPropertyEntity["kind"], args: CatalogJsonObject): JiraPropertyEntity | undefined {
  return ENTITY_SELECTIONS[kind](args);
}
export function jiraPropertyEntityFields(name: PropertyRead): readonly string[] | undefined {
  return ENTITIES.find(({ keys, value }) => keys === name || value === name)?.fields;
}
export function selectJiraPropertyRead(name: PropertyRead, args: CatalogJsonObject): JiraPropertyReadSelection | undefined {
  const definition = ENTITIES.find(({ keys, value }) => keys === name || value === name);
  if (definition === undefined) return undefined;
  const value = definition.value === name;
  const page = selectJiraReadPage(args, new Set<string>([
    ...definition.fields, ...(value ? ["propertyKey"] : ["startAt", "maxResults"]),
  ]));
  const entity = entitySelection(definition.kind, args);
  if (page === undefined || entity === undefined || (value && !jiraPropertyPathKey(args.propertyKey)))
    return undefined;
  return { entity, ...page, ...(value && typeof args.propertyKey === "string" ? { propertyKey: args.propertyKey } : {}) };
}
interface PropertyRefusal {
  readonly ok: false;
  readonly reason: "malformed-payload" | "bounds-exceeded" | "conflict";
}
export function projectJiraPropertyKeys(body: Record<string, unknown>): PropertyRefusal | {
  readonly ok: true; readonly items: readonly CatalogJsonObject[];
} {
  const descriptor = Object.getOwnPropertyDescriptor(body, "keys");
  const keys: unknown = descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  if (!Array.isArray(keys)) return { ok: false, reason: "malformed-payload" };
  if (keys.length > TOOL_CATALOG_LIMITS.maxArrayItems) return { ok: false, reason: "bounds-exceeded" };
  const items: CatalogJsonObject[] = [];
  const seen = new Set<string>();
  for (const raw of keys) {
    const key = asRecord(raw)?.key;
    if (!jiraPropertyKey(key) || seen.has(key)) return { ok: false, reason: "malformed-payload" };
    seen.add(key);
    items.push({ key });
  }
  return { ok: true, items };
}
function keysResult(body: Record<string, unknown>, selected: JiraPropertyReadSelection): ManagedMcpToolResult {
  const keys = projectJiraPropertyKeys(body);
  return keys.ok ? localJiraPage(keys.items, selected.startAt, selected.maxResults) : jiraReadFailure(keys.reason);
}
export function projectJiraPropertyValue(body: Record<string, unknown>, propertyKey: string): PropertyRefusal | {
  readonly ok: true; readonly value: CatalogJsonValue; readonly items: readonly CatalogJsonObject[];
} {
  const key = Object.getOwnPropertyDescriptor(body, "key");
  if (key === undefined || !("value" in key)) return { ok: false, reason: "malformed-payload" };
  if (key.value !== propertyKey) return { ok: false, reason: "conflict" };
  const descriptor = Object.getOwnPropertyDescriptor(body, "value");
  if (descriptor === undefined || !("value" in descriptor)) return { ok: false, reason: "malformed-payload" };
  const value: unknown = descriptor.value;
  const projected = jiraPropertyValue(value);
  // The existing projector has traversed every own JSON field, refused exotic/prototype/accessor
  // values and checked numbers, Unicode and all bounds before this type narrowing.
  return projected.ok ? { ok: true, value: value as CatalogJsonValue, items: projected.items } : projected;
}
function valueResult(body: Record<string, unknown>, propertyKey: string): ManagedMcpToolResult {
  const projected = projectJiraPropertyValue(body, propertyKey);
  return projected.ok ? { data: { outcome: "succeeded", propertyKey,
    items: projected.items, nodeCount: projected.items.length } } : jiraReadFailure(projected.reason);
}
export function jiraPropertyResourcePath(binding: { readonly path: string; readonly query?: string }, propertyKey?: string): string {
  return `${binding.path}${propertyKey === undefined ? "" : `/${encodeURIComponent(propertyKey)}`}${binding.query === undefined ? "" : `?${binding.query}`}`;
}
export function isJiraEntityPropertyRead(name: string): name is PropertyRead {
  return READS.has(name);
}
/** Fixed native GETs only. The caller retains custody, authority and body-free activity ownership. */
export async function executeJiraEntityPropertyRead(
  name: PropertyRead,
  args: CatalogJsonObject,
  ports: JiraEntityPropertyPorts,
): Promise<ManagedMcpToolResult> {
  const selected = selectJiraPropertyRead(name, args);
  if (selected === undefined) return jiraReadFailure("invalid-input");
  const bound = await bindJiraPropertyEntity(selected.entity, ports);
  if (!bound.ok) return bound.result;
  const path = jiraPropertyResourcePath(bound, selected.propertyKey);
  return executeJiraSelectedRead({ path }, bound.request, "json", (response) => {
    if (response.body === undefined) return jiraReadFailure("malformed-payload");
    const result = selected.propertyKey === undefined ? keysResult(response.body, selected)
      : valueResult(response.body, selected.propertyKey);
    return result.isError ? result : boundJiraReadResult({ data: {
      ...result.data, entityType: selected.entity.kind, ...bound.context,
    } });
  });
}
