import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolDeclaration } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { jiraDirectoryUserSchema as USER } from "./jiraDirectoryDescriptors.js";
import { object, text } from "./jiraManagedSchemas.js";
import {
  jiraNativeIdentitySchema as ID,
  jiraNativeProjectSchema as KEY,
  jiraNativePagingSchema as PAGING,
  jiraNativeReadResult,
  jiraNativeDeclaration,
  type JiraNativeDefinition,
} from "./jiraProjectStructureDescriptors.js";

const MAX = TOOL_CATALOG_LIMITS.maxArrayItems;
const NAME = { ...text(255), minLength: 1 };
const BOOL = { type: "boolean" };
const TOTAL = { type: "integer", minimum: 0, maximum: 2147483647 };
const SEARCH_OFFSET = { type: "integer", minimum: 0, maximum: 99 };
const SEARCH_LIMIT = { type: "integer", enum: [100] };
const TARGET = { projectKey: KEY, issueKey: KEY };
// Equivalent to the existing bounded Jira field-ID grammar, expressed with safe schema patterns.
const FIELD_ID = {
  ...text(64),
  anyOf: [
    { pattern: "^[A-Za-z]", allOf: [{ pattern: "^[A-Za-z0-9]+$" }] },
    { pattern: String.raw`^customfield_\d+$`, minLength: 13, maxLength: 28 },
  ],
};
export { FIELD_ID as jiraFieldIdSchema };
function array(item: CatalogJsonObject, maxItems: number = MAX): CatalogJsonObject {
  return { type: "array", maxItems, items: item };
}
const IDENTIFIERS = { ...array(KEY), minItems: 1, uniqueItems: true };
const FIELD_SCHEMA = object({
  type: NAME,
  items: NAME,
  system: NAME,
  custom: { ...text(1024), minLength: 1 },
  customId: ID,
});
const FIELD = object({
  id: FIELD_ID,
  name: NAME,
  custom: BOOL,
  orderable: BOOL,
  navigable: BOOL,
  searchable: BOOL,
  clauseNames: { ...array(NAME), uniqueItems: true },
  schema: FIELD_SCHEMA,
}, ["id", "name"]);
export const jiraCustomFieldOptionFields = {
  id: ID,
  value: text(32768),
  disabled: BOOL,
  childrenIds: { ...array(ID), uniqueItems: true },
};
function scopedInput(properties: CatalogJsonObject, required: readonly string[] = []): CatalogJsonObject {
  return {
    ...object({ ...TARGET, ...properties }, required),
    oneOf: [{ required: ["projectKey"] }, { required: ["issueKey"] }],
  };
}
function read(description: string, input: CatalogJsonObject, result: CatalogJsonObject, maxResultCount = 100): JiraNativeDefinition {
  return { description, input, result: jiraNativeReadResult(result), risk: "read", maxResultCount };
}

export const JIRA_SCOPED_DIRECTORY_READ_DEFINITIONS = {
  "jira.multi-project-assignable-users": read(
    "Find native assignable-user candidates for an explicit nonempty list of project keys and optional username query. The published endpoint returns only a bounded first search window: searchLimit is 100, with no fabricated offset, total or continuation. It does not assign anyone or turn observed candidates into an authority grant.",
    object({ projectKeys: IDENTIFIERS, query: text(255), maxResults: PAGING.maxResults }, ["projectKeys"]),
    { items: array(USER, 100), searchLimit: SEARCH_LIMIT },
  ),
  "jira.permission-users": read(
    "Find native users with all explicitly named permissions in exactly one project or issue context. Search only within the first 100 matches; startAt+maxResults must not exceed 100, and continuation stays within that native window. This is an observed candidate search, not a grant, permission change or replacement for execution-time authorization.",
    scopedInput({ permissions: IDENTIFIERS, query: text(255), startAt: SEARCH_OFFSET, maxResults: PAGING.maxResults }, ["permissions"]),
    { items: array(USER, 100), searchLimit: SEARCH_LIMIT, startAt: SEARCH_OFFSET, nextStartAt: SEARCH_OFFSET },
  ),
  "jira.browse-permission-users": read(
    "Find native users matching a nonempty username query with browse permission for exactly one project or issue. Preserve a bounded first search window with no invented offset, total or continuation. No membership or permissions are modified; execution authority remains independently enforced.",
    scopedInput({ query: NAME, maxResults: PAGING.maxResults }, ["query"]),
    { items: array(USER, 100), searchLimit: SEARCH_LIMIT },
  ),
  "jira.group-user-picker": read(
    "Read native user and group suggestions for optional text, one field ID and optional single project/issue-type IDs. Return each supplied branch separately with its own optional native total; missing branches remain unknown. maxResults bounds native users, while the native group branch has its own collection limit. Never merge totals, invent paging or expose HTML, avatars or labels.",
    object({ query: text(255), maxResults: PAGING.maxResults, fieldId: FIELD_ID, projectId: ID, issueTypeId: ID }),
    { users: array(USER, 100), groups: array(object({ name: NAME }, ["name"])), usersTotal: TOTAL, groupsTotal: TOTAL },
  ),
  "jira.project-picker": read(
    "Read native visible-project suggestions for optional text and an explicit empty-query preference. Return observed project IDs, keys, names and a total only when Jira supplies it. There is no offset or synthetic continuation, and project visibility is not permission to edit or administer it. Omit native headers, highlighted HTML and avatar URLs.",
    object({ query: text(255), maxResults: PAGING.maxResults, allowEmptyQuery: BOOL }),
    { items: array(object({ id: ID, key: KEY, name: NAME }, ["id", "key", "name"]), 100), total: TOTAL },
  ),
  "jira.fields": read(
    "Inspect and locally page Jira's visible system/custom field definitions. Preserve supplied custom/orderable/navigable/searchable flags, clause names and schema metadata without inferring requiredness, editability, defaults or applicability to a particular issue. Missing metadata remains unknown; this read neither changes fields nor bypasses current issue metadata admission.",
    object(PAGING),
    { items: array(FIELD, 100), startAt: PAGING.startAt, total: { type: "integer", minimum: 0, maximum: MAX }, nextStartAt: PAGING.startAt },
  ),
  "jira.custom-field-option": read(
    "Read one exact visible native custom-field option and its supplied disabled/child-ID metadata. Preserve the option value as native text, including an explicitly empty value. Missing children or disabled state remain unknown; no option, field or issue value is created or changed.",
    object({ optionId: ID }, ["optionId"]),
    jiraCustomFieldOptionFields,
    1,
  ),
} as const satisfies Readonly<Record<string, JiraNativeDefinition>>;

export function jiraScopedDirectoryDeclarationForTool(name: string): ManagedMcpToolDeclaration | undefined {
  const definitions: Readonly<Record<string, JiraNativeDefinition>> = JIRA_SCOPED_DIRECTORY_READ_DEFINITIONS;
  const selected = Object.hasOwn(definitions, name) ? definitions[name] : undefined;
  return selected === undefined ? undefined : jiraNativeDeclaration(name, selected);
}
