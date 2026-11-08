import { JIRA_PRIORITY_SCHEME_REVIEW_SCHEMA } from "./jiraOptionSchemeSchemas.js";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolDeclaration } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { JIRA_PRIORITY_SCHEME_RESULT_FIELDS } from "./jiraAccessDescriptors.js";
import { object, text } from "./jiraManagedSchemas.js";
import {
  jiraNativeIdentitySchema as ID,
  jiraNativeProjectSchema as KEY,
  jiraNativePagingSchema as PAGING,
  jiraNativeReadResult,
  jiraNativeDeclaration,
  type JiraNativeDefinition,
} from "./jiraProjectStructureDescriptors.js";

const PRIORITY_SCHEME_FIELDS = { ...JIRA_PRIORITY_SCHEME_RESULT_FIELDS,
  reviewSnapshotAvailable: { type: "boolean" }, reviewSnapshot: JIRA_PRIORITY_SCHEME_REVIEW_SCHEMA };
const MAX = TOOL_CATALOG_LIMITS.maxArrayItems;
const NAME = { ...text(255), minLength: 1 };
export const jiraRoleReviewSnapshotSchema = object({ id: ID, name: NAME,
  description: { anyOf: [text(32768), { type: "null" }] } }, ["id", "name", "description"]);
const ACTOR = object({
  name: NAME,
  id: ID,
  type: { ...text(128), minLength: 1 },
  displayName: NAME,
}, ["name"]);
const ROLE_FIELDS = {
  id: ID,
  name: NAME,
  description: text(32768),
  actors: { type: "array", maxItems: MAX, items: ACTOR },
};
const ROLE = object(ROLE_FIELDS, ["id", "name"]);
const PROJECT_CONTEXT = { projectId: ID, projectKey: KEY };
const ROLE_CONFIGURATION = { type: "string", enum: ["role-configuration"] };
function page(item: CatalogJsonObject, local = true): CatalogJsonObject {
  return {
    items: { type: "array", maxItems: 100, items: item },
    startAt: PAGING.startAt,
    total: { type: "integer", minimum: 0, maximum: local ? MAX : 1_000_000 },
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

export const JIRA_ROLE_READ_DEFINITIONS = {
  "jira.roles": read(
    "Inspect a local page of native role configuration. Preserve supplied actor metadata with the explicit role-configuration scope, never as proof of effective permissions or membership in a particular project. Missing actor lists remain unknown; no role or membership changes.",
    object(PAGING),
    { actorsScope: ROLE_CONFIGURATION, ...page(ROLE) },
  ),
  "jira.role": read(
    "Read the exact native role ID and observed configuration, including actor metadata only when supplied. Optional reviewSnapshot preserves exact ID/name and an explicitly observed description, including null or empty; omission leaves the snapshot unavailable. The role-configuration scope does not establish project-specific membership or actor permissions. No role, default actor or project membership is changed.",
    object({ roleId: ID }, ["roleId"]),
    { actorsScope: ROLE_CONFIGURATION, ...ROLE_FIELDS, reviewSnapshot: jiraRoleReviewSnapshotSchema },
    1,
  ),
  "jira.role-default-actors": read(
    "Inspect and locally page the default actors of one native role. actorsScope is role-defaults, separate from any project's current membership. Missing actors remain unknown with no fabricated total; an observed empty list is retained. Optional actor IDs/type/display labels are never invented.",
    object({ roleId: ID, ...PAGING }, ["roleId"]),
    { roleId: ID, actorsScope: { type: "string", enum: ["role-defaults"] }, ...page(ACTOR) },
  ),
  "jira.project-roles": read(
    "Resolve an existing project's canonical identity and locally page the role names returned by its native role map. Native map URLs are never followed, exposed or converted into invented role IDs. This read does not establish membership, effective permissions or authority.",
    object({ projectIdOrKey: KEY, ...PAGING }, ["projectIdOrKey"]),
    { ...PROJECT_CONTEXT, ...page(object({ name: NAME }, ["name"])) },
  ),
  "jira.project-role": read(
    "Resolve an existing project's canonical identity and inspect one exact role's observed project membership. actorsScope is project-membership; missing actors remain unknown. Optional reviewSnapshot preserves exact ID/name/description with observed null or empty distinct from unavailable omission. Role membership alone is not an effective-permission decision, and no users or groups are assigned or removed.",
    object({ projectIdOrKey: KEY, roleId: ID }, ["projectIdOrKey", "roleId"]),
    { ...PROJECT_CONTEXT, actorsScope: { type: "string", enum: ["project-membership"] }, ...ROLE_FIELDS, reviewSnapshot: jiraRoleReviewSnapshotSchema },
    1,
  ),
  "jira.priority-schemes": read(
    "Read a native page of visible priority schemes. Preserve observed defaults and priority IDs using the same contract as project associations; follow native paging and reported totals. Do not infer project assignments, user permissions or available issue edits from this metadata.",
    object(PAGING),
    page(object(PRIORITY_SCHEME_FIELDS, ["id", "name"]), false),
  ),
  "jira.priority-scheme": read(
    "Inspect one exact native priority scheme. Preserve supplied default-scheme state, default priority ID and priority membership, with missing optional metadata unknown. No default, ordering, priority or project association changes. Optional reviewSnapshot preserves explicit null description/default, native false and complete ordered priority IDs; missing facts make review unavailable.",
    object({ schemeId: ID }, ["schemeId"]),
    PRIORITY_SCHEME_FIELDS,
    1,
  ),
} as const satisfies Readonly<Record<string, JiraNativeDefinition>>;

export function jiraRoleDeclarationForTool(name: string): ManagedMcpToolDeclaration | undefined {
  const definitions: Readonly<Record<string, JiraNativeDefinition>> = JIRA_ROLE_READ_DEFINITIONS;
  const selected = Object.hasOwn(definitions, name) ? definitions[name] : undefined;
  return selected === undefined ? undefined : jiraNativeDeclaration(name, selected);
}
