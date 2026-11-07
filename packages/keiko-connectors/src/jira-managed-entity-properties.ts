import { isSafeAtlassianIdentifier, JIRA_READ_TOOL_FAMILIES } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { TOOL_CATALOG_LIMITS, type CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolResult } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { asRecord } from "./atlassian-sync-classify.js";
import {
  bindJiraPropertyEntity,
  type JiraEntityPropertyPorts,
  type JiraPropertyEntity,
} from "./jira-entity-property-bindings.js";
import { jiraPropertyKey, jiraPropertyPathKey, jiraPropertyValue } from "./jira-entity-property-values.js";
import { boundJiraReadResult } from "./jira-managed-issue-reads.js";
import { jiraReadFailure, localJiraPage } from "./jira-managed-metadata.js";
import { executeJiraSelectedRead, selectJiraReadPage } from "./jira-managed-read-request.js";
import { jiraNativeId, jiraNativeText } from "./jira-native-values.js";

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
interface Selection {
  readonly entity: JiraPropertyEntity;
  readonly startAt: number;
  readonly maxResults: number;
  readonly propertyKey?: string;
}
function userSelection(args: CatalogJsonObject): JiraPropertyEntity | undefined {
  const { username, userKey } = args;
  if ((username === undefined) === (userKey === undefined)) return undefined;
  if (jiraNativeText(username, 255) && !/\p{Surrogate}/u.test(username))
    return { kind: "user", user: { username } };
  return jiraNativeText(userKey, 255) && !/\p{Surrogate}/u.test(userKey)
    ? { kind: "user", user: { userKey } } : undefined;
}
function entitySelection(kind: JiraPropertyEntity["kind"], args: CatalogJsonObject): JiraPropertyEntity | undefined {
  switch (kind) {
    case "board": return jiraNativeId(args.boardId) ? { kind, id: args.boardId } : undefined;
    case "sprint": return jiraNativeId(args.sprintId) ? { kind, id: args.sprintId } : undefined;
    case "comment": return isSafeAtlassianIdentifier(args.issueIdOrKey) && jiraNativeId(args.commentId)
      ? { kind, issueIdOrKey: args.issueIdOrKey, commentId: args.commentId } : undefined;
    case "dashboard-item": return jiraNativeId(args.dashboardId) && jiraNativeId(args.itemId)
      ? { kind, dashboardId: args.dashboardId, itemId: args.itemId } : undefined;
    case "issue": return isSafeAtlassianIdentifier(args.issueIdOrKey) ? { kind, issueIdOrKey: args.issueIdOrKey } : undefined;
    case "issue-type": return jiraNativeId(args.issueTypeId) ? { kind, issueTypeId: args.issueTypeId } : undefined;
    case "project": return isSafeAtlassianIdentifier(args.projectIdOrKey) ? { kind, projectIdOrKey: args.projectIdOrKey } : undefined;
    case "user": return userSelection(args);
  }
}
function select(name: PropertyRead, args: CatalogJsonObject): Selection | undefined {
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
function keysResult(body: Record<string, unknown>, selected: Selection): ManagedMcpToolResult {
  const keys = body.keys;
  if (!Array.isArray(keys)) return jiraReadFailure("malformed-payload");
  if (keys.length > TOOL_CATALOG_LIMITS.maxArrayItems) return jiraReadFailure("bounds-exceeded");
  const items: CatalogJsonObject[] = [];
  const seen = new Set<string>();
  for (const raw of keys) {
    const key = asRecord(raw)?.key;
    if (!jiraPropertyKey(key) || seen.has(key)) return jiraReadFailure("malformed-payload");
    seen.add(key);
    items.push({ key });
  }
  return localJiraPage(items, selected.startAt, selected.maxResults);
}
function valueResult(body: Record<string, unknown>, propertyKey: string): ManagedMcpToolResult {
  if (body.key !== propertyKey) return jiraReadFailure("conflict");
  if (!Object.hasOwn(body, "value")) return jiraReadFailure("malformed-payload");
  const projected = jiraPropertyValue(body.value);
  return projected.ok ? { data: { outcome: "succeeded", propertyKey,
    items: projected.items, nodeCount: projected.items.length } } : jiraReadFailure(projected.reason);
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
  const selected = select(name, args);
  if (selected === undefined) return jiraReadFailure("invalid-input");
  const bound = await bindJiraPropertyEntity(selected.entity, ports);
  if (!bound.ok) return bound.result;
  const path = `${bound.path}${selected.propertyKey === undefined ? "" : `/${encodeURIComponent(selected.propertyKey)}`}${bound.query === undefined ? "" : `?${bound.query}`}`;
  return executeJiraSelectedRead({ path }, bound.request, "json", (response) => {
    if (response.body === undefined) return jiraReadFailure("malformed-payload");
    const result = selected.propertyKey === undefined ? keysResult(response.body, selected)
      : valueResult(response.body, selected.propertyKey);
    return result.isError ? result : boundJiraReadResult({ data: {
      ...result.data, entityType: selected.entity.kind, ...bound.context,
    } });
  });
}
