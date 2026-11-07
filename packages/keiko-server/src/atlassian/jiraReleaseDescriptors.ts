import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolDeclaration } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { object, text } from "./jiraManagedSchemas.js";
import {
  jiraNativeIdentitySchema as ID,
  jiraNativeProjectSchema as KEY,
  jiraNativePagingSchema as PAGING,
  jiraNativeVersionFields,
  jiraNativeReadResult,
  jiraNativeDeclaration,
  type JiraNativeDefinition,
} from "./jiraProjectStructureDescriptors.js";

const COUNT = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const COUNT_SCOPE = { type: "string", enum: ["jira-response"] };
const CUSTOM_FIELD_USAGE = object({
  customFieldId: ID,
  fieldName: { ...text(255), minLength: 1 },
  issueCountWithVersionInCustomField: COUNT,
}, ["customFieldId", "fieldName"]);
const VERSION = object({ ...jiraNativeVersionFields, versionId: ID, projectId: ID }, ["versionId", "name"]);
const ORDER_BY = {
  type: "string",
  enum: [
    "sequence", "+sequence", "-sequence", "name", "+name", "-name",
    "startDate", "+startDate", "-startDate", "releaseDate", "+releaseDate", "-releaseDate",
  ],
};
function read(
  description: string,
  input: CatalogJsonObject,
  result: CatalogJsonObject,
  maxResultCount = 1,
): JiraNativeDefinition {
  return { description, input, result: jiraNativeReadResult(result), risk: "read", maxResultCount };
}

export const JIRA_RELEASE_READ_DEFINITIONS = {
  "jira.component-related-issue-counts": read(
    "Read Jira's native issue count for one exact component. countScope is jira-response: this is the endpoint's observation, not an independently reconciled JQL/report total or proof of permission. A missing count stays unknown and an observed zero is preserved; no component or issue changes.",
    object({ componentId: ID }, ["componentId"]),
    { componentId: ID, countScope: COUNT_SCOPE, issueCount: COUNT },
  ),
  "jira.version-related-issue-counts": read(
    "Read Jira's native affected/fixed/custom-field issue counts for one exact version. Keep those distinct dimensions and observed per-field usage separate; do not sum them into a unique issue total. Missing counts or custom-field usage remain unknown, with explicit zero/empty values retained. No version or issue changes.",
    object({ versionId: ID }, ["versionId"]),
    {
      versionId: ID,
      countScope: COUNT_SCOPE,
      issuesAffectedCount: COUNT,
      issuesFixedCount: COUNT,
      issueCountWithCustomFieldsShowingVersion: COUNT,
      customFieldNames: {
        type: "array",
        maxItems: TOOL_CATALOG_LIMITS.maxArrayItems,
        items: CUSTOM_FIELD_USAGE,
      },
    },
  ),
  "jira.version-unresolved-issue-count": read(
    "Read Jira's native unresolved issue count for one exact version, preserving its jira-response scope. Missing counts remain unknown; zero is an observed value. This metadata does not establish a release gate, project permission or an independently reconciled report, and does not change the version.",
    object({ versionId: ID }, ["versionId"]),
    { versionId: ID, countScope: COUNT_SCOPE, issuesUnresolvedCount: COUNT },
  ),
  "jira.project-version-page": read(
    "Resolve an existing project's canonical identity and read a native version page with an explicit bounded offset, page size and optional documented ordering. Preserve supplied version metadata and native continuation; missing totals and per-version project IDs remain unknown. The canonical project context does not manufacture missing per-item fields. No release, archive or version edits.",
    object({ projectIdOrKey: KEY, ...PAGING, orderBy: ORDER_BY }, ["projectIdOrKey"]),
    {
      projectId: ID,
      projectKey: KEY,
      items: { type: "array", maxItems: 100, items: VERSION },
      startAt: PAGING.startAt,
      total: PAGING.startAt,
      nextStartAt: PAGING.startAt,
    },
    100,
  ),
} as const satisfies Readonly<Record<string, JiraNativeDefinition>>;

export function jiraReleaseDeclarationForTool(name: string): ManagedMcpToolDeclaration | undefined {
  const definitions: Readonly<Record<string, JiraNativeDefinition>> = JIRA_RELEASE_READ_DEFINITIONS;
  const selected = Object.hasOwn(definitions, name) ? definitions[name] : undefined;
  return selected === undefined ? undefined : jiraNativeDeclaration(name, selected);
}
