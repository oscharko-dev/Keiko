import {
  JIRA_READ_TOOL_FAMILIES,
  isSafeAtlassianIdentifier,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolResult } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { asRecord } from "./atlassian-sync-classify.js";
import { jiraNativeId, jiraNativeText } from "./jira-native-values.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { boundJiraReadResult } from "./jira-managed-issue-reads.js";
import { jiraReadFailure, localJiraPage, projectJiraCollection } from "./jira-managed-metadata.js";

export const JIRA_AVATAR_READS = JIRA_READ_TOOL_FAMILIES.avatars;
type AvatarRead = (typeof JIRA_AVATAR_READS)[number];
type Category = "system" | "custom";
const OPERATIONS: ReadonlySet<string> = new Set(JIRA_AVATAR_READS);
const TYPES: ReadonlySet<unknown> = new Set(["user", "project", "issuetype"]);
const FIELDS: Readonly<Record<AvatarRead, readonly string[]>> = {
  "jira.system-avatars": ["avatarType"],
  "jira.project-avatars": ["projectIdOrKey"],
  "jira.user-avatars": ["username"],
  "jira.avatars": ["avatarType", "owningObjectId"],
};
export function isJiraAvatarRead(name: string): name is AvatarRead {
  return OPERATIONS.has(name);
}
function avatarType(value: unknown): value is "user" | "project" | "issuetype" {
  return TYPES.has(value);
}
function userPath(value: unknown): string | undefined {
  if (value === undefined) return "user/avatars";
  if (!jiraNativeText(value, 255) || /[\r\n\t]/u.test(value)) return undefined;
  return `user/avatars?${new URLSearchParams({ username: value }).toString()}`;
}
function resource(name: AvatarRead, args: CatalogJsonObject): string | undefined {
  switch (name) {
    case "jira.system-avatars":
      return avatarType(args.avatarType) ? `avatar/${args.avatarType}/system` : undefined;
    case "jira.project-avatars":
      return isSafeAtlassianIdentifier(args.projectIdOrKey)
        ? `project/${encodeURIComponent(args.projectIdOrKey)}/avatars`
        : undefined;
    case "jira.user-avatars":
      return userPath(args.username);
    case "jira.avatars":
      return (args.avatarType === "project" || args.avatarType === "issuetype") &&
        jiraNativeId(args.owningObjectId)
        ? `universal_avatar/type/${args.avatarType}/owner/${args.owningObjectId}`
        : undefined;
  }
}
function inRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}
function selection(
  name: AvatarRead,
  args: CatalogJsonObject,
): { readonly path: string; readonly startAt: number; readonly maxResults: number } | undefined {
  const allowed = new Set([...FIELDS[name], "startAt", "maxResults"]);
  if (Object.keys(args).some((key) => !allowed.has(key))) return undefined;
  const path = resource(name, args);
  const startAt = args.startAt === undefined ? 0 : args.startAt;
  const maxResults = args.maxResults === undefined ? 25 : args.maxResults;
  if (path === undefined || !inRange(startAt, 0, 1_000_000) || !inRange(maxResults, 1, 100))
    return undefined;
  return { path, startAt, maxResults };
}
function avatarAttributes(raw: Record<string, unknown>): CatalogJsonObject | undefined {
  const result: Record<string, string | boolean> = {};
  if (raw.owner !== undefined && raw.owner !== null) {
    if (!jiraNativeText(raw.owner, 255, true)) return undefined;
    if (raw.owner.trim().length > 0) result.owner = raw.owner;
  }
  if (raw.selected !== undefined && raw.selected !== null) {
    if (typeof raw.selected !== "boolean") return undefined;
    result.selected = raw.selected;
  }
  return result;
}
function avatar(value: unknown, category: Category): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  const id = typeof raw?.id === "number" && Number.isSafeInteger(raw.id) ? String(raw.id) : raw?.id;
  if (raw === undefined || !jiraNativeId(id)) return undefined;
  const attributes = avatarAttributes(raw);
  return attributes === undefined ? undefined : { id, category, ...attributes };
}
function avatarGroups(
  body: Record<string, unknown> | undefined,
  systemOnly: boolean,
): readonly { readonly value: unknown; readonly category: Category }[] | undefined {
  if (body === undefined || !Array.isArray(body.system)) return undefined;
  const custom: unknown = systemOnly && body.custom === undefined ? [] : body.custom;
  if (!Array.isArray(custom) || (systemOnly && custom.length > 0)) return undefined;
  return [
    ...body.system.map((value: unknown) => ({ value, category: "system" as const })),
    ...custom.map((value: unknown) => ({ value, category: "custom" as const })),
  ];
}
/** Native JSON metadata only; avatar images and all server-provided URLs are deliberately unconsumed. */
export async function executeJiraAvatarRead(
  name: AvatarRead,
  args: CatalogJsonObject,
  request: JiraMutationRequest,
): Promise<ManagedMcpToolResult> {
  const selected = selection(name, args);
  if (selected === undefined) return jiraReadFailure("invalid-input");
  const response = await request(selected.path);
  if (!response.ok) return jiraReadFailure(response.reason, response.remote);
  if (response.status !== 200) return jiraReadFailure("malformed-payload");
  const count = [response.body?.system, response.body?.custom].reduce<number>(
    (total, items) => (Array.isArray(items) ? total + items.length : total),
    0,
  );
  if (count > TOOL_CATALOG_LIMITS.maxArrayItems) return jiraReadFailure("bounds-exceeded");
  const grouped = avatarGroups(response.body, name === "jira.system-avatars");
  if (grouped === undefined) return jiraReadFailure("malformed-payload");
  const items = projectJiraCollection(
    grouped,
    TOOL_CATALOG_LIMITS.maxArrayItems,
    (entry) => {
      const raw = asRecord(entry);
      return raw?.category === "system" || raw?.category === "custom"
        ? avatar(raw.value, raw.category)
        : undefined;
    },
    "id",
  );
  return items === undefined
    ? jiraReadFailure("malformed-payload")
    : boundJiraReadResult(localJiraPage(items, selected.startAt, selected.maxResults));
}
