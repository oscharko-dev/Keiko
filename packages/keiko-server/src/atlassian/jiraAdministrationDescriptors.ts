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

const NAME = { ...text(255), minLength: 1 };
const BOOL = { type: "boolean" };
const ISSUE_TYPE = object({ id: ID, name: NAME, description: text(32768), subtask: BOOL }, [
  "id",
  "name",
]);
const ISSUE_TYPE_SCHEME = object(
  {
    id: ID,
    name: NAME,
    description: text(32768),
    issueTypes: { type: "array", maxItems: TOOL_CATALOG_LIMITS.maxArrayItems, items: ISSUE_TYPE },
    defaultIssueType: ISSUE_TYPE,
  },
  ["id", "name"],
);
const PROJECT = object({ id: ID, key: KEY, name: NAME, description: text(32768), archived: BOOL }, [
  "id",
  "key",
  "name",
]);
const FIELD = object({ id: KEY, name: NAME, type: text(255), showWhenEmpty: BOOL }, ["id", "name"]);
const TAB = object({ id: ID, name: NAME }, ["id", "name"]);
const SCHEME_MAPPING = {
  ...object({ issueTypeId: ID, workflow: NAME, originalWorkflow: NAME }, ["issueTypeId"]),
  anyOf: [{ required: ["workflow"] }, { required: ["originalWorkflow"] }],
};
const WORKFLOW_MAPPING = object(
  {
    workflow: NAME,
    issueTypeIds: { type: "array", maxItems: TOOL_CATALOG_LIMITS.maxArrayItems, items: ID },
    defaultMapping: BOOL,
  },
  ["workflow"],
);
function page(item: CatalogJsonObject): CatalogJsonObject {
  return {
    items: { type: "array", maxItems: 100, items: item },
    startAt: PAGING.startAt,
    total: { type: "integer", minimum: 0, maximum: TOOL_CATALOG_LIMITS.maxArrayItems },
    nextStartAt: PAGING.startAt,
  };
}
export const JIRA_WORKFLOW_SCHEME_RESULT_FIELDS = {
  schemeId: ID,
  id: ID,
  name: NAME,
  description: text(32768),
  draft: BOOL,
  defaultWorkflow: NAME,
  originalDefaultWorkflow: NAME,
  lastModified: text(128),
  ...page(SCHEME_MAPPING),
};
const SCHEME_RESULT = jiraNativeReadResult(JIRA_WORKFLOW_SCHEME_RESULT_FIELDS);
const DEFAULT_RESULT = jiraNativeReadResult({ schemeId: ID, workflow: NAME });
const ISSUE_MAPPING_RESULT = jiraNativeReadResult({
  schemeId: ID,
  issueTypeId: ID,
  workflow: NAME,
});
const WORKFLOWS_RESULT = jiraNativeReadResult({ schemeId: ID, ...page(WORKFLOW_MAPPING) });
const RETURN_DRAFT = { returnDraftIfExists: BOOL };
function read(
  description: string,
  input: CatalogJsonObject,
  result: CatalogJsonObject,
  maxResultCount = 100,
): JiraNativeDefinition {
  return { description, input, result, risk: "read", maxResultCount };
}
export const JIRA_ADMINISTRATION_READ_DEFINITIONS = {
  "jira.issue-type-schemes": read(
    "Inspect visible native issue-type schemes using Jira administration permission. Optional booleans request only the documented issue-type/default-type expansions. Locally page the bounded native collection; omitted expanded metadata remains unknown. No schemes or associations change.",
    object({ ...PAGING, includeIssueTypes: BOOL, includeDefaultIssueType: BOOL }),
    jiraNativeReadResult(page(ISSUE_TYPE_SCHEME)),
  ),
  "jira.issue-type-scheme": read(
    "Inspect one exact native issue-type scheme, its available type definitions and default type. Jira administration permission is required. Missing optional metadata is not inferred, and no issue migration or scheme mutation occurs.",
    object({ schemeId: ID }, ["schemeId"]),
    jiraNativeReadResult({ schemeId: ID, ...page(ISSUE_TYPE_SCHEME) }),
    1,
  ),
  "jira.issue-type-scheme-projects": read(
    "Read and locally page the complete bounded native collection of projects associated with the selected issue-type scheme. Requires Jira administration permission. Returns observed identities and metadata without changing any association or inferring project access from the list.",
    object({ schemeId: ID, ...PAGING }, ["schemeId"]),
    jiraNativeReadResult({ schemeId: ID, ...page(PROJECT) }),
  ),
  "jira.workflow-scheme": read(
    "Inspect the requested native workflow scheme and locally page its observed current/original issue-type mappings. Optionally read its draft if Jira has one; returned id and observed draft flag are retained separately from the requested parent schemeId. Missing mappings remain unknown. No workflow changes or migration occurs.",
    object({ schemeId: ID, ...RETURN_DRAFT, ...PAGING }, ["schemeId"]),
    SCHEME_RESULT,
  ),
  "jira.workflow-scheme-draft": read(
    "Inspect the draft of the requested native workflow scheme and locally page observed mappings. The returned draft id may differ from parent schemeId. Missing mappings or draft flags remain unknown; this read never creates a draft.",
    object({ schemeId: ID, ...PAGING }, ["schemeId"]),
    SCHEME_RESULT,
  ),
  "jira.workflow-scheme-default": read(
    "Read the native default workflow name of the selected scheme, optionally using its existing draft. This does not infer a draft state or change the default workflow. Jira administration and session permissions remain authoritative.",
    object({ schemeId: ID, ...RETURN_DRAFT }, ["schemeId"]),
    DEFAULT_RESULT,
    1,
  ),
  "jira.workflow-scheme-draft-default": read(
    "Read the native default workflow name of an existing draft scheme. A missing draft is a failure, never an empty default or a request to create a draft.",
    object({ schemeId: ID }, ["schemeId"]),
    DEFAULT_RESULT,
    1,
  ),
  "jira.workflow-scheme-issue-type": read(
    "Read the workflow mapped to one exact issue type in the selected scheme, optionally using its existing draft. Both issue-type identity and returned workflow name are validated; no assignment changes.",
    object({ schemeId: ID, issueTypeId: ID, ...RETURN_DRAFT }, ["schemeId", "issueTypeId"]),
    ISSUE_MAPPING_RESULT,
    1,
  ),
  "jira.workflow-scheme-draft-issue-type": read(
    "Read the workflow mapped to one exact issue type in an existing draft scheme. No draft creation, migration or mapping update occurs.",
    object({ schemeId: ID, issueTypeId: ID }, ["schemeId", "issueTypeId"]),
    ISSUE_MAPPING_RESULT,
    1,
  ),
  "jira.workflow-scheme-workflows": read(
    "Inspect workflow mappings for the selected scheme, optionally choosing a workflow name or the existing draft. Locally page only the returned bounded native collection. Missing issue-type membership or defaultMapping stays unknown; no inferred draft state or workflow mutation.",
    object({ schemeId: ID, workflowName: NAME, ...RETURN_DRAFT, ...PAGING }, ["schemeId"]),
    WORKFLOWS_RESULT,
  ),
  "jira.workflow-scheme-draft-workflows": read(
    "Inspect workflow mappings for an existing draft scheme, optionally selecting a workflow by name. Locally page the returned bounded native collection. Does not create a draft, change workflow assignments or infer missing mapping state.",
    object({ schemeId: ID, workflowName: NAME, ...PAGING }, ["schemeId"]),
    WORKFLOWS_RESULT,
  ),
  "jira.screen-tabs": read(
    "Read and locally page the native tabs of one screen, optionally using the supplied project context for Jira permission checks. A visible tab does not establish issue editability or field requirements; no screen configuration changes.",
    object({ screenId: ID, projectKey: KEY, ...PAGING }, ["screenId"]),
    jiraNativeReadResult({ screenId: ID, projectKey: KEY, ...page(TAB) }),
  ),
  "jira.screen-tab-fields": read(
    "Read and locally page observed fields on one native screen tab, with optional project context. Preserve supplied type/showWhenEmpty facts without inferring requiredness, visibility or edit permission. No fields are moved or configured.",
    object({ screenId: ID, tabId: ID, projectKey: KEY, ...PAGING }, ["screenId", "tabId"]),
    jiraNativeReadResult({ screenId: ID, tabId: ID, projectKey: KEY, ...page(FIELD) }),
  ),
  "jira.screen-available-fields": read(
    "Read and locally page the bounded native fields available to add to one screen. This is metadata only; it neither adds a field nor proves that the current user may edit an issue through that field.",
    object({ screenId: ID, ...PAGING }, ["screenId"]),
    jiraNativeReadResult({ screenId: ID, ...page(FIELD) }),
  ),
} as const satisfies Readonly<Record<string, JiraNativeDefinition>>;
export function jiraAdministrationDeclarationForTool(
  name: string,
): ManagedMcpToolDeclaration | undefined {
  const definitions: Readonly<Record<string, JiraNativeDefinition>> =
    JIRA_ADMINISTRATION_READ_DEFINITIONS;
  const selected = Object.hasOwn(definitions, name) ? definitions[name] : undefined;
  return selected === undefined ? undefined : jiraNativeDeclaration(name, selected);
}
