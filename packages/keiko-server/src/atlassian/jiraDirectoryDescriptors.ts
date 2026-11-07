import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolDeclaration } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { object, text } from "./jiraManagedSchemas.js";
import {
  jiraNativeProjectSchema as KEY,
  jiraNativePagingSchema as PAGING,
  jiraNativeReadResult,
  jiraNativeDeclaration,
  type JiraNativeDefinition,
} from "./jiraProjectStructureDescriptors.js";

const NAME = { ...text(255), minLength: 1 };
const BOOL = { type: "boolean" };
const TOTAL = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const NATIVE_TOTAL = { type: "integer", minimum: 0, maximum: 2147483647 };
const SIGNED_METRIC = { type: "integer", minimum: -2147483648, maximum: 2147483647 };
const CURSOR = {
  ...text(20),
  minLength: 1,
  description: "Canonical signed decimal int64 cursor returned by Jira; not a user ID or numeric offset.",
};
const USER_FIELDS = { key: NAME, name: NAME, displayName: NAME, active: BOOL, deleted: BOOL };
const USER = object(USER_FIELDS, ["key", "name"]);
export { USER as jiraDirectoryUserSchema };
const ROLE_FIELDS = {
  key: KEY,
  name: NAME,
  groups: { type: "array", maxItems: TOOL_CATALOG_LIMITS.maxArrayItems, items: NAME },
  defaultGroups: { type: "array", maxItems: TOOL_CATALOG_LIMITS.maxArrayItems, items: NAME },
  defined: BOOL,
  hasUnlimitedSeats: BOOL,
  platform: BOOL,
  selectedByDefault: BOOL,
  numberOfSeats: SIGNED_METRIC,
  remainingSeats: SIGNED_METRIC,
  userCount: SIGNED_METRIC,
  userCountDescription: { ...text(1024), minLength: 1 },
};
function items(item: CatalogJsonObject, maxItems = 100): CatalogJsonObject {
  return { type: "array", maxItems, items: item };
}
function read(description: string, input: CatalogJsonObject, result: CatalogJsonObject, maxResultCount = 100): JiraNativeDefinition {
  return { description, input, result: jiraNativeReadResult(result), risk: "read", maxResultCount };
}
export const JIRA_DIRECTORY_READ_DEFINITIONS = {
  "jira.user": read(
    "Read one visible Jira user by exactly one username or exact userKey; includeDeleted is an explicit native selector. Return observed key/name and optional display name, active/deleted state. No email address, avatar, HTML or remote URL is exposed.",
    {
      ...object({ username: NAME, userKey: NAME, includeDeleted: BOOL }),
      oneOf: [{ required: ["username"] }, { required: ["userKey"] }],
    },
    USER_FIELDS,
    1,
  ),
  "jira.users": read(
    "Search visible Jira users within the native first 100 matching records. startAt+maxResults must not exceed 100; nextStartAt stays inside that window and no total is invented. Use user-directory when complete directory paging is permitted. Active/inactive flags are optional native selectors; no emails or remote URLs.",
    object({
      query: text(255), startAt: { type: "integer", minimum: 0, maximum: 99 },
      maxResults: PAGING.maxResults, includeActive: BOOL, includeInactive: BOOL,
    }),
    {
      items: items(USER), startAt: { type: "integer", minimum: 0, maximum: 99 },
      searchLimit: { type: "integer", enum: [100] },
      nextStartAt: { type: "integer", minimum: 0, maximum: 99 },
    },
  ),
  "jira.user-directory": read(
    "Read a native streaming directory page with an optional returned signed int64 cursor. Preserve the entire native page or refuse its byte bounds; never skip a truncated prefix. isLast and nextCursor are native facts, with no invented total or offset. Jira permissions remain authoritative.",
    object({ cursor: CURSOR, maxResults: PAGING.maxResults }),
    { items: items(USER), isLast: BOOL, nextCursor: CURSOR },
  ),
  "jira.user-picker": read(
    "Read native user-picker suggestions for optional query text. Return bounded user identities and total only when Jira reports it. This endpoint has no offset or invented continuation; omit remote HTML, headers and avatar URLs.",
    object({ query: text(255), maxResults: PAGING.maxResults }),
    { items: items(USER), total: NATIVE_TOTAL },
  ),
  "jira.group-members": read(
    "Read a native page of visible members of the exact named group and its subgroups, optionally including inactive users. Forward only fixed groupname/paging selectors. Preserve native paging and optional total; group visibility and Jira administration permissions remain server-enforced. No membership changes or emails.",
    object({
      groupName: NAME, startAt: PAGING.startAt,
      maxResults: { type: "integer", minimum: 1, maximum: 50 }, includeInactiveUsers: BOOL,
    }, ["groupName"]),
    { groupName: NAME, items: items(USER, 50), startAt: PAGING.startAt, total: TOTAL, nextStartAt: PAGING.startAt },
    50,
  ),
  "jira.groups": read(
    "Read native group-picker suggestions, optionally filtered by query. Return group names and total only when supplied. No native offset exists, so this tool exposes no fake paging cursor, HTML or remote URL.",
    object({ query: text(255), maxResults: PAGING.maxResults }),
    { items: items(object({ name: NAME }, ["name"])), total: NATIVE_TOTAL },
  ),
  "jira.application-roles": read(
    "Read a local page of native application-role facts under Jira's administration permission. Groups, defaults, flags and signed seat/user metrics are observed values, not new grants or inferred capacity. Missing values stay unknown; negative native sentinel metrics remain negative.",
    object(PAGING),
    { items: items(object(ROLE_FIELDS, ["key"])), startAt: PAGING.startAt, total: TOTAL, nextStartAt: PAGING.startAt },
  ),
  "jira.application-role": read(
    "Read the exact named native application role, preserving only documented optional group, default, flag and signed metric facts. Requires the native Jira administration permission; this does not assign roles, change seats or infer absent metadata.",
    object({ applicationRoleKey: KEY }, ["applicationRoleKey"]),
    ROLE_FIELDS,
    1,
  ),
} as const satisfies Readonly<Record<string, JiraNativeDefinition>>;

export function jiraDirectoryDeclarationForTool(name: string): ManagedMcpToolDeclaration | undefined {
  const definitions: Readonly<Record<string, JiraNativeDefinition>> = JIRA_DIRECTORY_READ_DEFINITIONS;
  const selected = Object.hasOwn(definitions, name) ? definitions[name] : undefined;
  return selected === undefined ? undefined : jiraNativeDeclaration(name, selected);
}
