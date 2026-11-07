import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolDeclaration } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { object, text } from "./jiraManagedSchemas.js";
import { JIRA_WORKFLOW_SCHEME_RESULT_FIELDS } from "./jiraAdministrationDescriptors.js";
import {
  jiraNativeIdentitySchema as ID,
  jiraNativeProjectSchema as KEY,
  jiraNativePagingSchema as PAGING,
  jiraNativeReadResult,
  jiraNativeDeclaration,
  type JiraNativeDefinition,
} from "./jiraProjectStructureDescriptors.js";

const BOOL = { type: "boolean" };
const NAME = { ...text(255), minLength: 1 };
const MAX = TOOL_CATALOG_LIMITS.maxArrayItems;
const NAMED_FIELDS = { id: ID, name: NAME, description: text(32768) };
const LEVEL = object(NAMED_FIELDS, ["id", "name"]);
const GRANT_FIELDS = {
  id: ID,
  permission: NAME,
  holder: object({ type: { ...text(128), minLength: 1 }, parameter: text(255) }, ["type"]),
};
const GRANT = object(GRANT_FIELDS, ["id", "permission", "holder"]);
function array(item: CatalogJsonObject, maxItems = MAX): CatalogJsonObject {
  return { type: "array", maxItems, items: item };
}
const PERMISSION_FIELDS = { ...NAMED_FIELDS, permissions: array(GRANT) };
const SECURITY_FIELDS = { ...NAMED_FIELDS, defaultSecurityLevelId: ID, levels: array(LEVEL) };
function localPage(item: CatalogJsonObject): CatalogJsonObject {
  return {
    items: array(item, 100),
    startAt: PAGING.startAt,
    total: { type: "integer", minimum: 0, maximum: MAX },
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

const EXPANDED_IDENTITY_FIELDS = {
  name: text(255), description: text(32768), displayName: text(255), key: text(255),
};
// Deep recipient metadata uses bounded projected strings; the native producer separately verifies
// canonical positive IDs and safe field identifiers before this result can reach the catalog.
const EXPANDED_ROLE_ID = { ...text(19), minLength: 1, pattern: "^[0-9]{1,19}$" };
const EXPANDED_FIELD_ID = {
  ...text(128),
  pattern: "^[A-Za-z0-9._~-]{1,128}$",
};
const RECIPIENT = object({
  id: ID,
  notificationType: { type: "string", enum: [
    "CurrentAssignee", "Reporter", "CurrentUser", "ProjectLead", "ComponentLead",
    "AllWatchers", "User", "Group", "EmailAddress", "UserCustomField", "GroupCustomField", "ProjectRole",
  ] },
  parameter: text(1024),
  emailAddress: text(320),
  user: object({ ...EXPANDED_IDENTITY_FIELDS, active: BOOL }),
  group: object({ ...EXPANDED_IDENTITY_FIELDS, name: NAME }, ["name"]),
  projectRole: object({ ...EXPANDED_IDENTITY_FIELDS, id: EXPANDED_ROLE_ID }, ["id"]),
  field: object({ ...EXPANDED_IDENTITY_FIELDS, id: EXPANDED_FIELD_ID }, ["id"]),
}, ["id", "notificationType"]);
const EVENT_FIELDS = { id: ID, name: text(255), description: text(32768) };
const EVENT = object({
  ...EVENT_FIELDS,
  // Ordered immediate template to ancestor; root plus seven templates is the existing eight-node bound.
  templateEvents: array(object(EVENT_FIELDS, ["id"]), 7),
  notifications: array(RECIPIENT),
}, ["id"]);
const NOTIFICATION_SCHEME = object({
  ...NAMED_FIELDS, eventsAvailable: BOOL, events: array(EVENT),
}, ["id", "name"]);
const NOTIFICATION_SINGLE = {
  eventsRequested: BOOL, items: array(NOTIFICATION_SCHEME, 1),
};
const INCLUDE_EVENTS = { includeEvents: BOOL };
const INCLUDE_PERMISSIONS = { includePermissions: BOOL };
const PROJECT_CONTEXT = { projectId: ID, projectKey: KEY };

export const JIRA_ACCESS_READ_DEFINITIONS = {
  "jira.project-permission-scheme": read(
    "Resolve an existing project's canonical identity and inspect its associated permission scheme. Return only observed native scheme/grant facts, not effective actor permissions. No expansion selector, grant mutation or association change is offered.",
    object({ projectIdOrKey: KEY }, ["projectIdOrKey"]),
    { ...PROJECT_CONTEXT, ...PERMISSION_FIELDS },
    1,
  ),
  "jira.project-issue-security-scheme": read(
    "Resolve an existing project's canonical identity and inspect its associated issue-security scheme. Preserve an observed default level and supplied level metadata; missing data remains unknown. This does not assign a level or establish access to any issue.",
    object({ projectIdOrKey: KEY }, ["projectIdOrKey"]),
    { ...PROJECT_CONTEXT, ...SECURITY_FIELDS },
    1,
  ),
  "jira.project-security-levels": read(
    "Resolve an existing project's identity and locally page security levels accessible to the current Jira actor. The accessible scope is explicit: an empty list can also reflect missing Set Issue Security permission and never proves that no levels are configured. No visibility changes.",
    object({ projectIdOrKey: KEY, ...PAGING }, ["projectIdOrKey"]),
    { ...PROJECT_CONTEXT, levelsScope: { type: "string", enum: ["accessible"] }, ...localPage(LEVEL) },
  ),
  "jira.project-workflow-scheme": read(
    "Resolve an existing project's canonical identity and inspect its associated active workflow scheme. Locally page observed current/original issue-type mappings; absent mappings remain unknown. A draft response is refused rather than presented as the active association. No migration, draft creation or association changes.",
    object({ projectIdOrKey: KEY, ...PAGING }, ["projectIdOrKey"]),
    { ...PROJECT_CONTEXT, ...JIRA_WORKFLOW_SCHEME_RESULT_FIELDS, draft: { type: "boolean", enum: [false] } },
  ),
  "jira.project-priority-scheme": read(
    "Resolve an existing project's canonical identity and inspect its associated native priority scheme. Preserve only supplied default-scheme state, default priority ID and priority membership IDs. Missing optional metadata is unknown; no priorities or project associations change.",
    object({ projectIdOrKey: KEY }, ["projectIdOrKey"]),
    { ...PROJECT_CONTEXT, ...NAMED_FIELDS, defaultScheme: BOOL, defaultOptionId: ID, optionIds: array(ID) },
    1,
  ),
  "jira.permission-schemes": read(
    "Inspect visible native permission schemes and locally page the bounded collection. includePermissions requests only the documented permissions expansion. Optional grants remain unknown when not supplied; configuration is not an effective-permission decision and grants no authority.",
    object({ ...PAGING, ...INCLUDE_PERMISSIONS }),
    localPage(object(PERMISSION_FIELDS, ["id", "name"])),
  ),
  "jira.permission-scheme": read(
    "Inspect one exact native permission scheme, optionally requesting documented grant metadata. Holder type/parameter are native configuration facts, not proof that a user can perform an operation. No grants or associations change.",
    object({ schemeId: ID, ...INCLUDE_PERMISSIONS }, ["schemeId"]),
    PERMISSION_FIELDS,
    1,
  ),
  "jira.permission-grants": read(
    "Read and locally page native grants in the selected permission scheme. Return exact grant IDs, permission names and observed holder type/parameter without expanding people or inferring effective access. Requires Jira's native viewing permission.",
    object({ schemeId: ID, ...PAGING }, ["schemeId"]),
    { schemeId: ID, ...localPage(GRANT) },
  ),
  "jira.permission-grant": read(
    "Inspect the exact grant in the selected native permission scheme. Validate the returned grant identity; missing holder metadata is a failure, never an empty or public grant. This is configuration inspection only.",
    object({ schemeId: ID, permissionId: ID }, ["schemeId", "permissionId"]),
    { schemeId: ID, ...GRANT_FIELDS },
    1,
  ),
  "jira.issue-security-schemes": read(
    "Inspect visible issue-security schemes and locally page the native collection. Preserve optional default-level and level metadata only when supplied. An absent collection is unknown; an explicit empty collection is retained. No issue visibility or scheme assignment changes.",
    object(PAGING),
    localPage(object(SECURITY_FIELDS, ["id", "name"])),
  ),
  "jira.issue-security-scheme": read(
    "Inspect one exact native issue-security scheme and its observed default level and optional level collection. Jira permissions remain authoritative; this does not prove access to issues or change their security levels.",
    object({ schemeId: ID }, ["schemeId"]),
    SECURITY_FIELDS,
    1,
  ),
  "jira.security-level": read(
    "Read the exact native security-level ID, name and optional description. No scheme, membership or effective issue access is inferred from this metadata.",
    object({ levelId: ID }, ["levelId"]),
    NAMED_FIELDS,
    1,
  ),
  "jira.notification-schemes": read(
    "Read a native page of visible notification schemes. includeEvents requests the fixed documented event/recipient expansions. Events not returned remain unavailable; an observed empty list remains empty. Preserve native paging and optional total. This reads configuration, never sends notifications or changes subscriptions.",
    object({ ...INCLUDE_EVENTS, startAt: PAGING.startAt, maxResults: { type: "integer", minimum: 1, maximum: 50 } }),
    {
      eventsRequested: BOOL, items: array(NOTIFICATION_SCHEME, 50),
      startAt: PAGING.startAt, isLast: BOOL, nextStartAt: PAGING.startAt,
      total: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    },
    50,
  ),
  "jira.notification-scheme": read(
    "Inspect one exact notification scheme, optionally expanding its documented events and recipients. Template events preserve native ancestor order within the bounded chain. Missing expansions never imply an empty scheme, disabled notifications or effective delivery.",
    object({ schemeId: ID, ...INCLUDE_EVENTS }, ["schemeId"]),
    NOTIFICATION_SINGLE,
    1,
  ),
  "jira.project-notification-scheme": read(
    "Resolve the selected project's canonical identity and inspect its associated native notification scheme, optionally expanding documented events/recipients. Return observed project and scheme identities without changing their association, emitting notifications or inferring user access.",
    object({ projectIdOrKey: KEY, ...INCLUDE_EVENTS }, ["projectIdOrKey"]),
    { ...NOTIFICATION_SINGLE, projectId: ID, projectKey: KEY },
    1,
  ),
} as const satisfies Readonly<Record<string, JiraNativeDefinition>>;

export function jiraAccessDeclarationForTool(name: string): ManagedMcpToolDeclaration | undefined {
  const definitions: Readonly<Record<string, JiraNativeDefinition>> = JIRA_ACCESS_READ_DEFINITIONS;
  const selected = Object.hasOwn(definitions, name) ? definitions[name] : undefined;
  return selected === undefined ? undefined : jiraNativeDeclaration(name, selected);
}
