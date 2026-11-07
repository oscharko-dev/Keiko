import { JIRA_NONSECRET_PREFERENCE_KINDS } from "@oscharko-dev/keiko-connectors";
import type { JiraSavedConfigurationMutation } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { TOOL_CATALOG_LIMITS, type CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolDeclaration } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { object, text } from "./jiraManagedSchemas.js";
import { jiraNativeDeclaration, jiraNativeWriteResult, type JiraNativeDefinition } from "./jiraProjectStructureDescriptors.js";

const ID = { ...text(19), minLength: 1, allOf: [{ pattern: "^[1-9]" }, { pattern: "^[0-9]{1,19}$" }], description: "Exact canonical positive int64 string, at most 9223372036854775807." };
const NAME = { ...text(255), minLength: 1 };
const JQL = { ...text(2048), minLength: 1 };
const DESCRIPTION = text(32768);
const BOOL = { type: "boolean" };
const TRUE = { type: "boolean", enum: [true] };
const SCOPE = { type: "string", enum: ["PRIVATE", "AUTHENTICATED", "GLOBAL"] };
const CONFIGURATION = { anyOf: [{ type: "null" }, { type: "string", enum: ["SYSTEM", "EXPLICIT", "FILTER", "USER", "NONE"] }] };
const COLUMNS = { type: "array", maxItems: TOOL_CATALOG_LIMITS.maxArrayItems, items: NAME };
const FILTER_CONTEXT = { filterId: ID, expectedOwnerKey: NAME };
const REVIEWED_FILTER = { ...FILTER_CONTEXT, expectedName: NAME, expectedJql: JQL,
  expectedDescription: { anyOf: [DESCRIPTION, { type: "null" }] } };
const REVIEWED_FILTER_FIELDS = ["filterId", "expectedOwnerKey", "expectedName", "expectedJql", "expectedDescription"];
const PERMISSION = object({ id: ID, type: { ...text(64), minLength: 1 }, groupName: NAME,
  projectId: ID, projectKey: text(128), roleId: ID, roleName: NAME, userName: NAME, userDisplayName: NAME, edit: BOOL, view: BOOL }, ["id", "type"]);
const PERMISSIONS = { type: "array", maxItems: TOOL_CATALOG_LIMITS.maxArrayItems, items: PERMISSION,
  description: "Complete native permission list from the owned filter. Include every returned row and observed optional field; omitted rights remain unknown. Never supply a page or infer edit rights from view rights." };
const TARGET_COMMON = { view: BOOL, edit: BOOL };
const TARGET = { anyOf: [
  ...["global", "authenticated"].map((type) => object({ type: { type: "string", enum: [type] }, view: TRUE, edit: { type: "boolean", enum: [false] } }, ["type", "view", "edit"])),
  object({ type: { type: "string", enum: ["group"] }, ...TARGET_COMMON, groupName: NAME }, ["type", "view", "edit", "groupName"]),
  object({ type: { type: "string", enum: ["project"] }, ...TARGET_COMMON, projectId: ID, roleId: ID }, ["type", "view", "edit", "projectId"]),
  object({ type: { type: "string", enum: ["user"] }, ...TARGET_COMMON, userKey: NAME, expectedUsername: NAME }, ["type", "view", "edit", "userKey", "expectedUsername"]),
] };
const FILTER_RECEIPT = { filterId: ID, userKey: NAME };
const CREATED_RECEIPT = { ...FILTER_RECEIPT, defaultSharingAtomic: { type: "boolean", enum: [false] }, observedShareScope: SCOPE };
const SCOPE_RECEIPT = { userKey: NAME, username: NAME, observedShareScope: SCOPE };
const PERMISSION_RECEIPT = { ...FILTER_RECEIPT, permissionId: ID };
const PREFERENCE_RECEIPT = { userKey: NAME, username: NAME, preferenceKey: NAME, preferencePresent: BOOL };
const SHARED = "Use the existing one-use governed mutation path. Match reviewed native state before one effect and independently read the canonical parent and requested result afterward. A lost acknowledgement, access failure, incomplete collection or contradictory state never permits automatic replay. Native edit permissions remain independently enforced by Jira; authority does not grant remote privileges.";
function write(description: string, input: CatalogJsonObject, receipt: CatalogJsonObject = FILTER_RECEIPT): JiraNativeDefinition {
  return { description: `${description} ${SHARED}`, input, result: jiraNativeWriteResult(receipt), risk: "write", maxResultCount: 1 };
}
function preferenceInput(set: boolean): CatalogJsonObject {
  return { anyOf: Object.entries(JIRA_NONSECRET_PREFERENCE_KINDS).map(([key, kind]) => {
    const value = kind === "integer" ? { type: "integer", minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }
      : kind === "boolean" ? BOOL : text(4096);
    return object({ key: { type: "string", enum: [key] }, expectedActorKey: NAME, expectedValue: value,
      ...(set ? { value } : {}) }, ["key", "expectedActorKey", "expectedValue", ...(set ? ["value"] : [])]);
  }) };
}
export const JIRA_SAVED_CONFIGURATION_WRITE_DEFINITIONS = {
  "jira.create-filter": write("Create a filter with reviewed name/JQL and optional description. Requires explicit Jira administration scope. The native endpoint uses the actor's default sharing and has NO atomic private override. Explicit acceptDefaultSharing:true and expectedDefaultShareScope are mandatory; re-read the actor and default immediately before POST, then inspect actual permissions. defaultSharingAtomic:false is always retained; observedShareScope appears only after exact independent sharing confirmation. A change between pre-read and POST can publish under a different scope, so review this native limitation before approval.",
    object({ expectedActorKey: NAME, expectedDefaultShareScope: SCOPE, acceptDefaultSharing: TRUE, name: NAME, jql: JQL, description: DESCRIPTION }, ["expectedActorKey", "expectedDefaultShareScope", "acceptDefaultSharing", "name", "jql"]), CREATED_RECEIPT),
  "jira.update-filter": write("Update only name, JQL and/or description of a filter owned by the connected Jira user. Match the full reviewed metadata. No owner transfer, favourite mutation or sharing change. An equal desired state reports unchanged.",
    { ...object({ ...REVIEWED_FILTER, name: NAME, jql: JQL, description: DESCRIPTION }, REVIEWED_FILTER_FIELDS), anyOf: [{ required: ["name"] }, { required: ["jql"] }, { required: ["description"] }] }),
  "jira.delete-filter": write("Delete the exact owned filter only after matching reviewed metadata. The published API has no complete owned-filter collection: a selected 404 or absence from favourites cannot independently prove removal. After acknowledgement retain the filter ID and report unconfirmed; never fabricate a confirmed deletion.", object(REVIEWED_FILTER, REVIEWED_FILTER_FIELDS)),
  "jira.set-filter-share-scope": write("Change only the connected user's default sharing for future filters. Requires explicit Jira administration scope. Review the actor and current enum; the documented write choices are PRIVATE and AUTHENTICATED. GLOBAL can be observed as an old setting but is not admitted as a new target by this endpoint. Confirm via fresh native GET.",
    object({ expectedActorKey: NAME, expectedScope: SCOPE, scope: { type: "string", enum: ["PRIVATE", "AUTHENTICATED"] } }, ["expectedActorKey", "expectedScope", "scope"]), SCOPE_RECEIPT),
  "jira.set-filter-columns": write("Set the full ordered column layout for an owned filter. Match complete expectedColumns and expectedColumnConfig first; null means native provenance was not supplied. Do not infer uniqueness or silently reorder repeated columns. Confirm the entire ordered native layout.",
    object({ ...FILTER_CONTEXT, expectedColumns: COLUMNS, expectedColumnConfig: CONFIGURATION, columns: { ...COLUMNS, minItems: 1 } }, ["filterId", "expectedOwnerKey", "expectedColumns", "expectedColumnConfig", "columns"])),
  "jira.reset-filter-columns": write("Remove the owned filter's explicit column configuration after matching the complete reviewed layout. Independent native configuration provenance must show SYSTEM, USER or NONE to confirm reset. A legacy columns array or bare 404 alone cannot prove the filter no longer has its own configuration; retain the known filter ID as unconfirmed.",
    object({ ...FILTER_CONTEXT, expectedColumns: COLUMNS, expectedColumnConfig: CONFIGURATION }, ["filterId", "expectedOwnerKey", "expectedColumns", "expectedColumnConfig"])),
  "jira.add-filter-permission": write("Add one exact typed recipient to an owned filter after matching its complete permission list. Requires explicit Jira administration scope. Review both view and edit; unknown recipients or implicit escalation refuse. User targets bind the exact userKey and reviewed username; project roles bind their project. Global requires acceptGlobalReplacement:true because Jira removes ALL prior shares. Broad global/authenticated shares are view-only. Independently confirm recipient rights and every retained permission.",
    object({ ...FILTER_CONTEXT, expectedPermissions: PERMISSIONS, permission: TARGET, acceptGlobalReplacement: TRUE }, ["filterId", "expectedOwnerKey", "expectedPermissions", "permission"]), PERMISSION_RECEIPT),
  "jira.delete-filter-permission": write("Remove one exact permission ID from an owned filter after matching every reviewed permission row. Requires explicit Jira administration scope. Confirm absence in the complete same-parent permission collection and verify all other rows remain unchanged. A selected permission 404 is not proof of removal.",
    object({ ...FILTER_CONTEXT, expectedPermissions: PERMISSIONS, permissionId: ID }, ["filterId", "expectedOwnerKey", "expectedPermissions", "permissionId"]), PERMISSION_RECEIPT),
  "jira.set-my-preference": write("Set only one existing documented nonsecret preference key for the reviewed connected Jira user. expectedValue and value use the key's exact type: text, boolean or safe integer. Preserve false, zero and empty text. Serialize a native JSON string through the existing scalar HTTP owner; no second JSON parsing, arbitrary keys, secrets or other-user selectors. Match current native value and independently confirm the replacement.", preferenceInput(true), PREFERENCE_RECEIPT),
  "jira.delete-my-preference": write("Delete one documented nonsecret preference of the reviewed connected Jira user after matching expectedValue. The native API has no complete explicit-preference key list: a 404 or inherited default cannot prove removal. After acknowledgement preserve the key with preferencePresent:false as the REQUESTED target and report unconfirmed. Never claim that a fallback value proves deletion and never replay.", preferenceInput(false), PREFERENCE_RECEIPT),
} as const satisfies Readonly<Record<JiraSavedConfigurationMutation, JiraNativeDefinition>>;
export function jiraSavedConfigurationMutationDeclarationForTool(name: string): ManagedMcpToolDeclaration | undefined {
  const definitions: Readonly<Record<string, JiraNativeDefinition>> = JIRA_SAVED_CONFIGURATION_WRITE_DEFINITIONS;
  const definition = Object.hasOwn(definitions, name) ? definitions[name] : undefined;
  return definition === undefined ? undefined : jiraNativeDeclaration(name, definition);
}
