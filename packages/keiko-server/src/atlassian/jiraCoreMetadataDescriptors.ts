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
  jiraNativeReadResult,
  jiraNativeDeclaration,
  type JiraNativeDefinition,
} from "./jiraProjectStructureDescriptors.js";

const MAX = TOOL_CATALOG_LIMITS.maxArrayItems;
const NAME = { ...text(255), minLength: 1 };
const BOOL = { type: "boolean" };
const DESCRIPTION = text(32768);
const COLOR = { ...text(128), minLength: 1 };
const NAMED_FIELDS = { id: ID, name: NAME, description: DESCRIPTION };
export const jiraIssueTypeReviewSnapshotSchema = object({ id: ID, name: NAME, description: { anyOf: [DESCRIPTION, { type: "null" }] }, subtask: BOOL, avatarId: ID }, ["id", "name", "description", "subtask"]);
const ISSUE_TYPE_FIELDS = { ...NAMED_FIELDS, subtask: BOOL, avatarId: ID, reviewSnapshot: jiraIssueTypeReviewSnapshotSchema };
const ISSUE_TYPE = object(ISSUE_TYPE_FIELDS, ["id", "name"]);
const PRIORITY_FIELDS = { ...NAMED_FIELDS, statusColor: COLOR };
const PRIORITY = object(PRIORITY_FIELDS, ["id", "name"]);
// The documented native identity is mandatory; never borrow it from the request selector.
const RESOLUTION = object(NAMED_FIELDS, ["id", "name"]);
const CATEGORY_FIELDS = { id: ID, key: KEY, name: NAME, colorName: COLOR };
const STATUS_CATEGORY = object(CATEGORY_FIELDS, ["id", "key"]);
const STATUS_FIELDS = { ...NAMED_FIELDS, statusColor: COLOR, statusCategory: STATUS_CATEGORY };
const STATUS = object(STATUS_FIELDS, ["id", "name"]);
const PROJECT_CATEGORY = object(NAMED_FIELDS, ["id", "name"]);
const PROJECT_TYPE_FIELDS = {
  key: KEY, formattedKey: NAME,
  descriptionI18nKey: { ...text(1024), minLength: 1 }, color: COLOR,
};
const PROJECT_TYPE = object(PROJECT_TYPE_FIELDS, ["key"]);
const PROJECT_STATUSES = object({
  id: ID, name: NAME, subtask: BOOL,
  statuses: { type: "array", maxItems: MAX, items: STATUS },
}, ["id", "name"]);
const IDS = { type: "array", uniqueItems: true, maxItems: MAX, items: ID };
const QUERY_PAGE = { ...PAGING, query: text(255) };
function page(item: CatalogJsonObject, local = false): CatalogJsonObject {
  return {
    items: { type: "array", maxItems: 100, items: item },
    startAt: PAGING.startAt,
    total: { type: "integer", minimum: 0, maximum: local ? MAX : Number.MAX_SAFE_INTEGER },
    nextStartAt: PAGING.startAt,
  };
}
function read(
  description: string,
  input: CatalogJsonObject,
  result: CatalogJsonObject,
  maxResultCount = 100,
  requiredSuccessFields: readonly string[] = [],
): JiraNativeDefinition {
  const schema = jiraNativeReadResult(result);
  return {
    description, input, risk: "read", maxResultCount,
    result: requiredSuccessFields.length === 0 ? schema : {
      ...schema,
      anyOf: [{ properties: { outcome: { enum: ["failed"] } } }, { required: requiredSuccessFields }],
    },
  };
}

export const JIRA_CORE_METADATA_READ_DEFINITIONS = {
  "jira.global-issue-types": read(
    "Inspect a local page of the bounded native issue-type collection visible to the Jira actor. Preserve supplied descriptions, subtask state and avatar IDs without following images. Global type visibility does not establish that a type is creatable in any project; use current create metadata for that decision.",
    object(PAGING),
    page(ISSUE_TYPE, true),
  ),
  "jira.issue-type": read(
    "Inspect one exact native issue type by its decimal string ID. Return observed metadata without inventing optional subtask/avatar facts or changing a type, screen, workflow or project association. Optional reviewSnapshot uses the same strict projector as mutation admission: description:null or empty is observed, omitted description means the snapshot is unavailable. Ordinary metadata remains readable.",
    object({ issueTypeId: ID }, ["issueTypeId"]),
    ISSUE_TYPE_FIELDS,
    1,
  ),
  "jira.issue-type-page": read(
    "Read a native issue-type page, optionally matching query text and filtering by exact project IDs. Project IDs remain decimal strings in repeated native query parameters. Preserve native continuation and only reported totals; this is discovery, not project create permission.",
    object({ ...QUERY_PAGE, projectIds: IDS }),
    page(ISSUE_TYPE),
  ),
  "jira.issue-type-alternatives": read(
    "Inspect and locally page the bounded native alternatives for one exact issue type. These are Jira's observed alternatives, not authorization to migrate issues or delete the source type. Return the requested issueTypeId separately from each alternative's identity.",
    object({ issueTypeId: ID, ...PAGING }, ["issueTypeId"]),
    { issueTypeId: ID, ...page(ISSUE_TYPE, true) },
  ),
  "jira.priorities": read(
    "Inspect a local page of the bounded native priority collection. Names, descriptions and colors are observed metadata; no default ordering, project membership or issue editability is inferred.",
    object(PAGING),
    page(PRIORITY, true),
  ),
  "jira.priority": read(
    "Read one exact native priority by decimal string ID, preserving supplied description and color. Does not assign a priority or modify schemes, ordering or defaults.",
    object({ priorityId: ID }, ["priorityId"]),
    PRIORITY_FIELDS,
    1,
  ),
  "jira.priority-page": read(
    "Read a native priority page, optionally matching query text and filtering exact project IDs. Follow native nextStartAt; a missing total remains unknown. Project-filtered metadata does not grant permission to edit any issue.",
    object({ ...QUERY_PAGE, projectIds: IDS }),
    page(PRIORITY),
  ),
  "jira.resolutions": read(
    "Inspect a local page of native resolutions with their exact observed IDs. Every entry must supply its documented identity; missing or contradictory identities are refused. A listed resolution does not mean an issue is resolved or allow a transition.",
    object(PAGING),
    page(RESOLUTION, true),
  ),
  "jira.resolution": read(
    "Read a resolution at the exact requested decimal resolutionId. The observed native id is required and must match that selector; never substitute the requested ID for missing response evidence. This does not resolve or reopen an issue.",
    object({ resolutionId: ID }, ["resolutionId"]),
    NAMED_FIELDS,
    1,
    ["id", "name"],
  ),
  "jira.resolution-page": read(
    "Read a native resolution page with optional query text. Every entry retains its required observed ID; native totals remain optional. No unsupported project or issue-type filter and no issue mutation.",
    object(QUERY_PAGE),
    page(RESOLUTION),
  ),
  "jira.statuses": read(
    "Inspect a local page of the native status collection, including supplied status-category facts. Missing colors or categories stay unknown; status visibility does not imply that a transition is available for an issue.",
    object(PAGING),
    page(STATUS, true),
  ),
  "jira.status": read(
    "Read one native status by exact decimal ID or status name. The selector must already be trimmed, must be one safe encoded path segment and cannot contain slashes, backslashes, control characters or dot segments. Validate returned identity/name; use issue transitions for executable workflow actions.",
    object({ statusIdOrName: NAME }, ["statusIdOrName"]),
    STATUS_FIELDS,
    1,
  ),
  "jira.status-page": read(
    "Read a native status page, optionally matching query and filtering exact project/issue-type IDs. IDs remain unique decimal strings in repeated native query parameters. Preserve observed category metadata and optional total; no transition availability or issue authority is inferred.",
    object({ ...QUERY_PAGE, projectIds: IDS, issueTypeIds: IDS }),
    page(STATUS),
  ),
  "jira.status-categories": read(
    "Inspect a local page of native status categories. Retain observed ID/key and optional name/color. Server framework request/uriInfo parameters are not user selectors and are never forwarded; no categories or workflows are changed.",
    object(PAGING),
    page(STATUS_CATEGORY, true),
  ),
  "jira.status-category": read(
    "Read a native status category by decimal ID or its safe key. Verify the observed ID/key while preserving optional display metadata; this never changes an issue's status or category.",
    object({ statusCategoryIdOrKey: KEY }, ["statusCategoryIdOrKey"]),
    CATEGORY_FIELDS,
    1,
  ),
  "jira.project-categories": read(
    "Inspect a local page of the bounded native project-category collection. Names and descriptions are metadata, not project access or actor-permission decisions. No categorization changes.",
    object(PAGING),
    page(PROJECT_CATEGORY, true),
  ),
  "jira.project-category": read(
    "Read one exact native project category by decimal string ID and preserve its supplied description. This does not assign a project or infer project membership or access.",
    object({ projectCategoryId: ID }, ["projectCategoryId"]),
    NAMED_FIELDS,
    1,
  ),
  "jira.project-statuses": read(
    "Resolve an existing project's canonical identity and locally page its native issue-type/status groups. Missing nested status lists remain unknown; explicit empty lists stay empty. These are configured metadata, not currently executable transitions or proof of issue-edit permission.",
    object({ projectIdOrKey: KEY, ...PAGING }, ["projectIdOrKey"]),
    { projectId: ID, projectKey: KEY, ...page(PROJECT_STATUSES, true) },
  ),
  "jira.project-types": read(
    "Inspect a local page of native project-type definitions, preserving keys and supplied formatted label, localization key and color. Definitions do not prove current license availability, permission or project creatability; no icons, URLs or markup are followed.",
    object(PAGING),
    page(PROJECT_TYPE, true),
  ),
  "jira.project-type-definition": read(
    "Read the exact native project-type definition by safe projectTypeKey. Preserve supplied metadata without claiming accessibility or license availability; jira.project-type is the separate existing accessible-definition check. No project creation or type changes.",
    object({ projectTypeKey: KEY }, ["projectTypeKey"]),
    PROJECT_TYPE_FIELDS,
    1,
  ),
} as const satisfies Readonly<Record<string, JiraNativeDefinition>>;

export function jiraCoreMetadataDeclarationForTool(name: string): ManagedMcpToolDeclaration | undefined {
  const definitions: Readonly<Record<string, JiraNativeDefinition>> = JIRA_CORE_METADATA_READ_DEFINITIONS;
  const selected = Object.hasOwn(definitions, name) ? definitions[name] : undefined;
  return selected === undefined ? undefined : jiraNativeDeclaration(name, selected);
}
