import { TOOL_CATALOG_LIMITS, type CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolDeclaration } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { object, text } from "./jiraManagedSchemas.js";
import {
  jiraNativeIdentitySchema as ID,
  jiraNativePagingSchema as PAGING,
  jiraNativeVersionFields,
  jiraNativeComponentFields,
  jiraNativeReadResult,
  jiraNativeDeclaration,
  type JiraNativeDefinition,
} from "./jiraProjectStructureDescriptors.js";
import { jiraNativeLinkTypeFields } from "./jiraIssueCollaborationDescriptors.js";

const MAX = TOOL_CATALOG_LIMITS.maxArrayItems;
const NAME = { ...text(255), minLength: 1 };
const BOOL = { type: "boolean" };
const PAGE_INPUT = object({
  ...PAGING,
  query: text(255),
  projectIds: { type: "array", minItems: 1, maxItems: MAX, uniqueItems: true, items: ID },
});
const VERSION = object({ ...jiraNativeVersionFields, versionId: ID, projectId: ID }, ["versionId", "name"]);
const COMPONENT = object({ ...jiraNativeComponentFields, projectId: ID }, ["id", "name", "project"]);
const COLUMN = {
  anyOf: [
    object({ value: NAME, label: text(255) }, ["value"]),
    object({
      id: NAME,
      position: { type: "integer", minimum: -2147483648, maximum: 2147483647 },
      columnHeadingKey: text(1024),
    }, ["id"]),
  ],
};
function page(item: CatalogJsonObject): CatalogJsonObject {
  return {
    items: { type: "array", maxItems: 100, items: item },
    startAt: PAGING.startAt,
    total: { type: "integer", minimum: 0, maximum: 1_000_000 },
    nextStartAt: PAGING.startAt,
  };
}
function read(description: string, input: CatalogJsonObject, result: CatalogJsonObject, maxResultCount = 100): JiraNativeDefinition {
  return { description, input, result: jiraNativeReadResult(result), risk: "read", maxResultCount };
}
function layout(scope: readonly string[], context: CatalogJsonObject = {}): CatalogJsonObject {
  return {
    ...page(COLUMN),
    layoutScope: { type: "string", enum: scope },
    columnsAvailable: BOOL,
    columnConfig: { type: "string", enum: ["SYSTEM", "EXPLICIT", "FILTER", "USER", "NONE"] },
    ...context,
  };
}
export const JIRA_RESOURCE_VIEW_READ_DEFINITIONS = {
  "jira.global-version-page": read(
    "Read a native version page with optional text and exact project-ID filters. Return observed version metadata and a project ID only when supplied by Jira; a selected project filter is not proof of each row's project identity. Follow returned continuation only, and do not infer release availability, compatibility or permissions from this metadata.",
    PAGE_INPUT,
    page(VERSION),
  ),
  "jira.component-page": read(
    "Read one native component page with optional text and exact project-ID filters. Reuse the native component projection and retain its required observed project key plus an optional observed numeric project ID. Keep missing metadata unknown; this does not create, update or infer access to components or projects.",
    PAGE_INPUT,
    page(COMPONENT),
  ),
  "jira.link-type": read(
    "Inspect one exact native issue-link type and its observed name, inward wording and outward wording. Bind its returned identity to linkTypeId. No issue relationship or link-type definition is created or changed.",
    object({ linkTypeId: ID }, ["linkTypeId"]),
    jiraNativeLinkTypeFields,
    1,
  ),
  "jira.accessibility-settings": read(
    "Observe and locally page the connected Jira actor's native accessibility settings. Preserve each setting key and an enabled flag only when supplied; missing flags remain unknown. No user selector, preference change, HTML or permission inference is provided.",
    object(PAGING),
    { ...page(object({ key: NAME, enabled: BOOL }, ["key"])), settingsScope: { type: "string", enum: ["connected-user"] } },
  ),
  "jira.system-columns": read(
    "Inspect and locally page the native system-default issue-column layout. Preserve returned order, repeated fields and optional labels. This observes configuration only; it does not fetch issue data, establish field visibility or change columns.",
    object(PAGING),
    layout(["system"]),
  ),
  "jira.user-columns": read(
    "Inspect and locally page the current actor's issue-column layout, or the explicitly selected username's layout when Jira permits it. selectedUsername records the requested context, not an independently resolved user identity. Preserve native order and repeated fields without inferring field permissions or changing preferences.",
    object({ username: NAME, ...PAGING }),
    layout(["current-user", "named-user"], { selectedUsername: NAME }),
  ),
  "jira.filter-columns": read(
    "Inspect the explicitly selected filter's native column layout, preserving either published column-item form and returned order, including repeated fields. selectedFilterId records the requested context. columnsAvailable=false means Jira omitted the column items, not a known empty layout; omit invented counts or continuation in that case. Preserve a supplied columnConfig enum without inferring effective visibility, ownership or permission. No filter or column configuration is changed.",
    object({ filterId: ID, ...PAGING }, ["filterId"]),
    layout(["filter"], { selectedFilterId: ID }),
  ),
} as const satisfies Readonly<Record<string, JiraNativeDefinition>>;

export function jiraResourceViewDeclarationForTool(name: string): ManagedMcpToolDeclaration | undefined {
  const definitions: Readonly<Record<string, JiraNativeDefinition>> = JIRA_RESOURCE_VIEW_READ_DEFINITIONS;
  const selected = Object.hasOwn(definitions, name) ? definitions[name] : undefined;
  return selected === undefined ? undefined : jiraNativeDeclaration(name, selected);
}
