import { TOOL_CATALOG_LIMITS, type CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolDeclaration } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { object, text } from "./jiraManagedSchemas.js";
import { jiraNativeIdentitySchema as ID, jiraNativeDeclaration, jiraNativeWriteResult, type JiraNativeDefinition } from "./jiraProjectStructureDescriptors.js";

const NAME = { ...text(255), minLength: 1 };
const DESCRIPTION = text(32768);
const HOLDER = object({ type: { ...text(128), minLength: 1 }, parameter: text(255) }, ["type"]);
const NEW_HOLDER = { oneOf: [
  object({ type: { type: "string", enum: ["anyone", "reporter", "projectLead", "assignee", "reporterWithCreatePermission", "assigneeWithAssignablePermission"] } }, ["type"]),
  object({ type: { type: "string", enum: ["group", "user", "projectRole", "userCustomField", "groupCustomField"] }, parameter: NAME }, ["type", "parameter"]),
] };
const GRANT = object({ permission: NAME, holder: NEW_HOLDER }, ["permission", "holder"]);
const EXPECTED_GRANT = object({ id: ID, permission: NAME, holder: HOLDER }, ["id", "permission", "holder"]);
const GRANTS = { type: "array", maxItems: TOOL_CATALOG_LIMITS.maxArrayItems, items: GRANT };
export const JIRA_PERMISSION_SCHEME_REVIEW_SCHEMA = object({ id: ID, name: NAME, description: DESCRIPTION,
  permissions: { type: "array", maxItems: TOOL_CATALOG_LIMITS.maxArrayItems, items: EXPECTED_GRANT } },
  ["id", "name", "description", "permissions"]);
const ACTOR = { expectedActorKey: NAME };
const REVIEW = { ...ACTOR, expectedScheme: JIRA_PERMISSION_SCHEME_REVIEW_SCHEMA };
const BASE_RECEIPT = { userKey: NAME, schemeId: ID };
const ATTRIBUTE_KEY = { ...NAME, description: "Exact observed native attribute key; fixed-path owner refuses slash, backslash, percent, controls, lone surrogates and dot segments before lookup. At most255 UTF-8 bytes." };
const COMMON = "New anonymous anyone grants are restricted to BROWSE_PROJECTS, VIEW_DEV_TOOLS and VIEW_READONLY_WORKFLOW; existing other grants remain readable and removable. Explicit high-risk issue-tracker.admin action. Jira independently enforces native administrator rights and validates holder/permission references; configuration observations do not establish anyone's effective permissions. Bind the reviewed connected actor, exact scheme identity/name/description and complete native grant set before one effect. Missing descriptions/grants are unavailable, never empty. Holder parameters preserve exact native user/group/role/custom-field identifiers; no expanded user/group objects, model URLs or headers. Pre-reads are not atomic compare-and-swap. Retain known IDs after acknowledgement and independently rebind the parent and full result state; never retry an uncertain write. Receipt flags under unknown/unconfirmed mean requested target only. These configuration changes do not invent formal issue-template rules.";
function write(description: string, input: CatalogJsonObject, receipt: CatalogJsonObject): JiraNativeDefinition {
  return { description: `${description} ${COMMON}`, input, result: jiraNativeWriteResult({ ...BASE_RECEIPT, ...receipt }), risk: "write", maxResultCount: 1 };
}
export const JIRA_PERMISSION_SCHEME_WRITE_DEFINITIONS = {
  "jira.create-permission-scheme": write("Create a permission scheme with explicit name, description and complete desired permission grants (including an explicit empty set). Refuse an exact existing visible name. Only a native acknowledgement ID establishes the new target; independently read that exact ID and all grants before confirming. New grants support documented built-in holder kinds. Anonymous anyone grants are supported only for BROWSE_PROJECTS, VIEW_DEV_TOOLS and VIEW_READONLY_WORKFLOW; all other anonymous grants are refused before any write. Hidden reporter/assignee holder kinds require BROWSE_PROJECTS. No guessed generated ID or name-based recovery.",
    object({ ...ACTOR, name: NAME, description: DESCRIPTION, permissions: GRANTS }, ["expectedActorKey", "name", "description", "permissions"]),
    { schemePresent: { type: "boolean", enum: [true] } }),
  "jira.update-permission-scheme": write("Update at least one of name, description or permissions. An absent permissions property preserves all existing grants; an explicit [] removes ALL grants; a nonempty list replaces ALL grants, potentially assigning new native grant IDs. Review the complete prior grant set and exact holders first. Empty description explicitly clears the description. A matching desired state reports unchanged without a PUT.",
    { ...object({ ...REVIEW, name: NAME, description: DESCRIPTION, permissions: GRANTS }, ["expectedActorKey", "expectedScheme"]),
      anyOf: [{ required: ["name"] }, { required: ["description"] }, { required: ["permissions"] }] },
    { schemePresent: { type: "boolean", enum: [true] } }),
  "jira.delete-permission-scheme": write("Delete only the exact reviewed scheme after confirmUnverifiedDeletion:true. Native acknowledgement plus omission from a visible scheme list cannot independently prove all affected project associations and permission effects, so deletion always remains unconfirmed. A selected404 is not absence proof and never enables retry.",
    object({ ...REVIEW, confirmUnverifiedDeletion: { type: "boolean", enum: [true] } }, ["expectedActorKey", "expectedScheme", "confirmUnverifiedDeletion"]),
    { schemePresent: { type: "boolean", enum: [false] } }),
  "jira.add-permission-grant": write("Add exactly one reviewed permission/holder to the bound scheme. Native POST body contains only permission and holder. An existing identical grant reports unchanged. Only the native new grant ID and a fresh complete set containing exactly the retained IDs plus that grant confirm success; missing ACK identity remains unconfirmed.",
    object({ ...REVIEW, grant: GRANT }, ["expectedActorKey", "expectedScheme", "grant"]),
    { permissionId: ID, grantPresent: { type: "boolean", enum: [true] } }),
  "jira.delete-permission-grant": write("Delete one exact grant ID present in the complete reviewed scheme snapshot. Confirm only a fresh same-parent complete collection containing every retained grant unchanged and excluding that exact ID. Missing collection,403 or404 never proves absence.",
    object({ ...REVIEW, permissionId: ID }, ["expectedActorKey", "expectedScheme", "permissionId"]),
    { permissionId: ID, grantPresent: { type: "boolean", enum: [false] } }),
  "jira.set-permission-scheme-attribute": write("Set a native permission-scheme Boolean attribute through the fixed text/plain writer; bytes are exactly true or false, not a JSON-quoted string. expectedValue is the exact independently observed canonical true/false string, not inferred from unknown/null/404. This bounded surface updates a readable attribute; it cannot claim an unobserved attribute was absent. Confirm the unchanged complete parent/grants and fresh same-key Boolean value. A missing host writer refuses before reads/effects.",
    object({ ...REVIEW, attributeKey: ATTRIBUTE_KEY, expectedValue: { type: "string", enum: ["true", "false"] }, enabled: { type: "boolean" } },
      ["expectedActorKey", "expectedScheme", "attributeKey", "expectedValue", "enabled"]),
    { attributeKey: ATTRIBUTE_KEY, attributeEnabled: { type: "boolean" } }),
} as const satisfies Readonly<Record<string, JiraNativeDefinition>>;
export function jiraPermissionSchemeMutationDeclarationForTool(name: string): ManagedMcpToolDeclaration | undefined {
  const definitions: Readonly<Record<string, JiraNativeDefinition>> = JIRA_PERMISSION_SCHEME_WRITE_DEFINITIONS;
  const definition = Object.hasOwn(definitions, name) ? definitions[name] : undefined;
  return definition === undefined ? undefined : jiraNativeDeclaration(name, definition);
}
