import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolDeclaration } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { object, text } from "./jiraManagedSchemas.js";
import {
  jiraNativeIdentitySchema as ID,
  jiraNativePagingSchema as PAGING,
  jiraNativeReadResult,
  jiraNativeDeclaration,
  type JiraNativeDefinition,
} from "./jiraProjectStructureDescriptors.js";
import { jiraCustomFieldOptionFields } from "./jiraScopedDirectoryDescriptors.js";

const MAX = TOOL_CATALOG_LIMITS.maxArrayItems;
const NAME = { ...text(255), minLength: 1 };
const BOOL = { type: "boolean" };
const COUNT = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const INT32_COUNT = { type: "integer", minimum: 0, maximum: 2147483647 };
const PAGE = { type: "integer", minimum: 1, maximum: 10_000 };
const FIELD_ID = {
  anyOf: [
    ID,
    {
      ...text(31),
      allOf: [{ pattern: "^customfield_[1-9]" }, { pattern: String.raw`^customfield_\d+$` }],
    },
  ],
};
function array(item: CatalogJsonObject, maxItems: number = MAX): CatalogJsonObject {
  return { type: "array", maxItems, items: item };
}
const IDS = { ...array(ID), uniqueItems: true };
const INPUT_IDS = { ...IDS, minItems: 1 };
const SCREEN = object({ id: ID, name: NAME, description: text(32768), deletable: BOOL }, [
  "id",
  "name",
]);
const WORKFLOW = object(
  {
    name: NAME,
    description: text(32768),
    steps: INT32_COUNT,
    isDefault: BOOL,
    lastModifiedDate: text(255),
  },
  ["name"],
);
const FIELD = object(
  {
    id: FIELD_ID,
    name: NAME,
    description: text(32768),
    type: { ...text(1024), minLength: 1 },
    searcherKey: { ...text(1024), minLength: 1 },
    numericId: ID,
    isAllProjects: BOOL,
    isLocked: BOOL,
    isManaged: BOOL,
    isTrusted: BOOL,
    issueTypeIds: IDS,
    projectIds: IDS,
    issuesWithValue: COUNT,
    projectsCount: COUNT,
    screensCount: COUNT,
    lastValueUpdate: text(128),
  },
  ["id", "name"],
);
const TERM_FIELDS = {
  originalName: NAME,
  originalNamePlural: NAME,
  newName: NAME,
  newNamePlural: NAME,
  isDefault: BOOL,
};
function page(item: CatalogJsonObject): CatalogJsonObject {
  return {
    items: array(item, 100),
    startAt: PAGING.startAt,
    total: { type: "integer", minimum: 0, maximum: 1_000_000 },
    nextStartAt: PAGING.startAt,
  };
}
function read(
  description: string,
  input: CatalogJsonObject,
  result: CatalogJsonObject,
  maxResultCount = 100,
): JiraNativeDefinition {
  return { description, input, result: jiraNativeReadResult(result), risk: "read", maxResultCount };
}
const WORKFLOW_INPUT = {
  ...object({ workflowName: NAME, ...PAGING }),
  not: {
    required: ["workflowName"],
    anyOf: [{ required: ["startAt"] }, { required: ["maxResults"] }],
  },
};
const OPTIONS_INPUT = {
  ...object(
    {
      customFieldId: ID,
      page: PAGE,
      maxResults: PAGING.maxResults,
      projectIds: INPUT_IDS,
      issueTypeIds: INPUT_IDS,
      query: text(255),
      useAllContexts: BOOL,
      sortByOptionName: BOOL,
    },
    ["customFieldId"],
  ),
  not: {
    required: ["useAllContexts"],
    properties: { useAllContexts: { type: "boolean", enum: [true] } },
    anyOf: [{ required: ["projectIds"] }, { required: ["issueTypeIds"] }],
  },
};

export const JIRA_CONFIGURATION_READ_DEFINITIONS = {
  "jira.screens": read(
    "Read a native page of Jira administration screen metadata with optional text search. Preserve observed screen identity, name, description and deletable flag without inferring effective permissions or editable fields. Missing totals remain unknown; follow a continuation only when returned. No screen, tab or field is changed or expanded.",
    object({ ...PAGING, search: text(255) }),
    page(SCREEN),
  ),
  "jira.workflows": read(
    "Inspect a named workflow or locally page the bounded native workflow collection. A named selection must match the observed name and cannot be combined with paging. Preserve supplied step count/default flag and literal display-formatted last-modified text; do not parse it as an absolute time or infer activation, draft state, permissions or transitions. No workflow is created or changed.",
    WORKFLOW_INPUT,
    page(WORKFLOW),
  ),
  "jira.custom-fields": read(
    "Read one native page of custom-field administration metadata with optional text search. Preserve native field identity and supplied configuration flags, project/issue-type IDs, usage counts and literal update metadata. Missing data remains unknown; no writable-field applicability, authority, default or requiredness is inferred from administration metadata.",
    object({ ...PAGING, search: text(255) }),
    page(FIELD),
  ),
  "jira.custom-field-options": read(
    "Read a one-based native option page for one exact custom field, optionally narrowed by documented project/issue-type contexts and text. Explicit useAllContexts=true cannot be combined with context IDs. Preserve option IDs, native values, optional disabled/child metadata and explicit options scope. A missing total supplies no invented continuation; follow nextPage only when returned. No option or issue value is changed.",
    OPTIONS_INPUT,
    {
      customFieldId: ID,
      page: PAGE,
      maxResults: PAGING.maxResults,
      total: INT32_COUNT,
      nextPage: PAGE,
      optionsScope: { type: "string", enum: ["native-context-options", "all-field-contexts"] },
      items: array(object(jiraCustomFieldOptionFields, ["id", "value"]), 100),
    },
  ),
  "jira.terminology": read(
    "Inspect and locally page native Jira terminology entries, preserving supplied original and replacement singular/plural names and default state. Missing names or flags remain unknown. This observation does not change terminology, translate content or grant administrative permissions.",
    object(PAGING),
    page(object(TERM_FIELDS, ["originalName"])),
  ),
  "jira.terminology-entry": read(
    "Read the native terminology entry for epic or sprint. Bind the observed original name case-insensitively while retaining Jira's exact observed spelling and optional replacement/default metadata. No terminology is changed and no unlisted term can be selected.",
    object({ originalName: { type: "string", enum: ["epic", "sprint"] } }, ["originalName"]),
    TERM_FIELDS,
    1,
  ),
  "jira.read-only-mode": read(
    "Inspect the supplied native read-only-mode status and optional message, end-time and time-zone text. Preserve observed false and explicit empty text; omitted fields remain unknown. This is neither an enforcement or permission guarantee nor a change to Jira mode, custody, compatibility or Keiko authority.",
    object({}),
    { enabled: BOOL, message: text(32768), endTime: text(128), timeZone: text(255) },
    1,
  ),
} as const satisfies Readonly<Record<string, JiraNativeDefinition>>;

export function jiraConfigurationDeclarationForTool(
  name: string,
): ManagedMcpToolDeclaration | undefined {
  const definitions: Readonly<Record<string, JiraNativeDefinition>> =
    JIRA_CONFIGURATION_READ_DEFINITIONS;
  const selected = Object.hasOwn(definitions, name) ? definitions[name] : undefined;
  return selected === undefined ? undefined : jiraNativeDeclaration(name, selected);
}
