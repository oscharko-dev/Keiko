import { JIRA_SCHEMA_MUTATIONS, type JiraSchemaMutation } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { TOOL_CATALOG_LIMITS, type CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolDeclaration } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { object, text } from "./jiraManagedSchemas.js";
import { jiraIssueTypeReviewSnapshotSchema } from "./jiraCoreMetadataDescriptors.js";
import { jiraNativeDeclaration, jiraNativeIdentitySchema as ID, jiraNativeWriteResult, type JiraNativeDefinition } from "./jiraProjectStructureDescriptors.js";

const NAME = { ...text(255), minLength: 1 };
const DESCRIPTION = text(32768);
const TRUE = { type: "boolean", enum: [true] };
const FIELD_ID = { type: "string", pattern: "^customfield_[1-9][0-9]{0,18}$", minLength: 13, maxLength: 31 };
export const jiraSchemaIssueTypeSnapshotSchema = jiraIssueTypeReviewSnapshotSchema;
const LINK = object({ id: ID, name: NAME, inward: NAME, outward: NAME }, ["id", "name", "inward", "outward"]);
const FIELD = object({ id: FIELD_ID, name: NAME, custom: TRUE }, ["id", "name", "custom"]);
const TERM = { type: "string", enum: ["epic", "sprint"] };
const TERM_SNAPSHOT = object({ originalName: NAME, originalNamePlural: NAME, newName: NAME, newNamePlural: NAME, isDefault: { type: "boolean" } }, ["originalName", "originalNamePlural", "newName", "newNamePlural", "isDefault"]);
const CANONICAL_TERM = { type: "string", minLength: 1, maxLength: 100, pattern: "^[a-z0-9 ]+$" };
const MODULE = { type: "string", minLength: 3, maxLength: 1024, pattern: "^[a-zA-Z0-9_.-]+:[a-zA-Z0-9_.-]+$" };
const ids = (max: number) => ({ type: "array", minItems: 1, maxItems: max, uniqueItems: true, items: ID });
const LINKS = { type: "array", maxItems: TOOL_CATALOG_LIMITS.maxArrayItems, items: LINK };
const ACTOR = { expectedActorKey: NAME };
const USER = { userKey: NAME };
const TYPE_RECEIPT = { ...USER, issueTypeId: ID, issueTypePresent: { type: "boolean" } };
const LINK_RECEIPT = { ...USER, linkTypeId: ID, linkTypePresent: { type: "boolean" } };
const COMMON = "Explicit high-risk issue-tracker.admin authority is required; ordinary issue writes or native credential binding do not grant it. Jira separately enforces native permissions. Rebind the exact actor and reviewed native identities before one fixed HTTP effect, then use independent reads. Reviewed data is not atomic compare-and-swap. Unknown effects retain known target IDs, never guess creation IDs from names/URLs, and must not be replayed. No arbitrary routes, headers, avatar bytes or model-provided credentials. The existing 16 KiB receipt and catalog bounds apply. Flags on unconfirmed receipts describe requested targets only.";
function write(description: string, input: CatalogJsonObject, receipt: CatalogJsonObject): JiraNativeDefinition {
  return { description: `${description} ${COMMON}`, input, result: jiraNativeWriteResult(receipt), risk: "write", maxResultCount: 1 };
}
function typeReview(extra: CatalogJsonObject, required: readonly string[]): CatalogJsonObject {
  return object({ ...ACTOR, expectedIssueType: jiraSchemaIssueTypeSnapshotSchema, ...extra }, ["expectedActorKey", "expectedIssueType", ...required]);
}
function linkReview(extra: CatalogJsonObject, required: readonly string[]): CatalogJsonObject {
  return object({ ...ACTOR, expectedLinkType: LINK, ...extra }, ["expectedActorKey", "expectedLinkType", ...required]);
}
export const JIRA_SCHEMA_WRITE_DEFINITIONS = {
  "jira.create-custom-field": write("Create a native custom field in explicit nonempty project and issue-type contexts. Both projectIds and issueTypeIds contain1–50 exact IDs, independently read before dispatch. Native projectIds are JSON int64 numbers and therefore must fit the safe integer bound; no rounding. type and searcherKey are explicit native plugin module keys, not URLs. This adapter does not infer global/all-types semantics from omitted or empty arrays. A readable new customfield_ID acknowledgement is retained, followed by GET field; plugin/searcher/context and issue consequences remain unconfirmed even when the field is visible.",
    object({ ...ACTOR, name: NAME, description: DESCRIPTION, type: MODULE, searcherKey: MODULE, projectIds: ids(50), issueTypeIds: ids(50) }, ["expectedActorKey", "name", "description", "type", "searcherKey", "projectIds", "issueTypeIds"]),
    { ...USER, fieldId: FIELD_ID, fieldPresent: TRUE }),
  "jira.delete-custom-fields": write("Delete1–50 reviewed custom fields through the native repeated ids query. Expected fields bind exact id/name/custom:true, not a claim to complete configuration or issue values. Native bulk deletion permits partial success; even a200 or visible list omission never confirms all deletions, values, screens or plugin effects. Always remains unconfirmed. Existing saved formal required-field and parent-field rules are checked before dispatch; hidden affected issues cannot be validated with a JQL prefix.",
    object({ ...ACTOR, expectedFields: { type: "array", minItems: 1, maxItems: 50, items: FIELD }, confirmUnverifiedDeletion: TRUE }, ["expectedActorKey", "expectedFields", "confirmUnverifiedDeletion"]),
    { ...USER, fieldIds: { type: "array", minItems: 1, maxItems: 50, uniqueItems: true, items: FIELD_ID }, fieldPresent: { type: "boolean", enum: [false] } }),
  "jira.create-issue-type": write("Create a standard or subtask issue type with an explicit name and description. Jira also adds it to its default issue-type scheme; independently reading the created type cannot prove every default-scheme consequence, so acknowledgement remains unconfirmed. Missing201 identity is preserved as missing, without a name search or replay.",
    object({ ...ACTOR, name: NAME, description: DESCRIPTION, type: { type: "string", enum: ["standard", "subtask"] } }, ["expectedActorKey", "name", "description", "type"]), TYPE_RECEIPT),
  "jira.update-issue-type": write("Partially update reviewed issue-type name and/or description. Omitted fields remain unchanged; explicit empty description clears, native null is only a reviewed prior value. Type/subtask/avatar are not silently changed. A rename changes saved name-based formal rule selection for existing issues and is refused where affected formal rules cannot be proven for the full population. Metadata-only confirmation requires a fresh exact full snapshot including retained subtask/avatar facts.",
    { ...typeReview({ name: NAME, description: DESCRIPTION }, []), anyOf: [{ required: ["name"] }, { required: ["description"] }] }, TYPE_RECEIPT),
  "jira.delete-issue-type": write("Delete the reviewed issue type and optionally migrate associated issues to a separately reviewed native compatible alternative. expectedAlternative:null explicitly sends no alternative query; it does not prove the type is unused, and Jira may reject. Non-null alternative must occur in Jira's alternatives list and match its independently read snapshot. Saved rules for source and target types, across every activation and all project populations, are checked before the effect. Always unconfirmed: selected404 cannot prove complete migration consequences.",
    typeReview({ expectedAlternative: { anyOf: [jiraSchemaIssueTypeSnapshotSchema, { type: "null" }] }, confirmUnverifiedMigration: TRUE }, ["expectedAlternative", "confirmUnverifiedMigration"]),
    { ...TYPE_RECEIPT, replacementIssueTypeId: ID }),
  "jira.create-link-type": write("Create a native issue-link type with explicit name/inward/outward metadata. A new ID must come from the native acknowledgement and must not have existed in the bounded pre-read collection. A fresh exact-ID GET confirms only metadata, never any issue relationship or permission.",
    object({ ...ACTOR, name: NAME, inward: NAME, outward: NAME }, ["expectedActorKey", "name", "inward", "outward"]), LINK_RECEIPT),
  "jira.update-link-type": write("Replace the reviewed link-type name and both directional labels. Native links keep their type ID, but saved parent-link name requirements may be affected and are checked through the existing formal gate. Exact independent metadata readback can confirm this configuration only.",
    linkReview({ name: NAME, inward: NAME, outward: NAME }, ["name", "inward", "outward"]), LINK_RECEIPT),
  "jira.delete-link-type": write("Delete the exact reviewed link type. Existing governed parent-link/required-link rules are checked before dispatch. Complete relationship removal across hidden issues is not proven by a selected404 or a visible collection; always remains unconfirmed.",
    linkReview({ confirmUnverifiedDeletion: TRUE }, ["confirmUnverifiedDeletion"]), LINK_RECEIPT),
  "jira.reset-link-type-order": write("Request native alphabetical link-type ordering, asc or desc, against the complete bounded reviewed type sequence. Do not recreate Jira collation in JavaScript or mistake a presentation list for durable ordering proof. An independent collection read follows; the operation always remains unconfirmed.",
    object({ ...ACTOR, expectedLinkTypes: LINKS, direction: { type: "string", enum: ["asc", "desc"] } }, ["expectedActorKey", "expectedLinkTypes", "direction"]),
    { ...USER, linkTypeIds: { type: "array", maxItems: TOOL_CATALOG_LIMITS.maxArrayItems, uniqueItems: true, items: ID } }),
  "jira.move-link-type": write("Move one exact reviewed link type to a native1-based position within the full reviewed type sequence. Other positions shift natively. The target must belong to the reviewed collection; no URL/opaque index is accepted. A collection read is not an independent persistent-order guarantee; always remains unconfirmed.",
    object({ ...ACTOR, expectedLinkTypes: LINKS, linkTypeId: ID, newPosition: { type: "integer", minimum: 1, maximum: TOOL_CATALOG_LIMITS.maxArrayItems } }, ["expectedActorKey", "expectedLinkTypes", "linkTypeId", "newPosition"]),
    { ...USER, linkTypeId: ID, linkTypeIds: { type: "array", minItems: 1, maxItems: TOOL_CATALOG_LIMITS.maxArrayItems, uniqueItems: true, items: ID } }),
  "jira.set-terminology": write("Set native epic and/or sprint terminology through the documented JSON collection body. Review both current entries, including explicit default booleans, and supply1–2 distinct desired names. Desired names are already trimmed lowercase alphanumeric text/spaces of1–100 characters, matching native canonicalization; Jira decides reserved-word validity. Setting an original term restores its native default. Compare independent current entries without claiming issue migration or complete UI propagation. No formal issue-field gate is invented for terminology.",
    object({ ...ACTOR, expectedEntries: { type: "array", minItems: 2, maxItems: 2, items: TERM_SNAPSHOT }, entries: { type: "array", minItems: 1, maxItems: 2, items: object({ originalName: TERM, newName: CANONICAL_TERM, newNamePlural: CANONICAL_TERM }, ["originalName", "newName", "newNamePlural"]) } }, ["expectedActorKey", "expectedEntries", "entries"]),
    { ...USER, terminologyNames: { type: "array", minItems: 1, maxItems: 2, uniqueItems: true, items: TERM } }),
} as const satisfies Readonly<Record<JiraSchemaMutation, JiraNativeDefinition>>;
export function jiraSchemaMutationDeclarationForTool(name: string): ManagedMcpToolDeclaration | undefined {
  const operation = JIRA_SCHEMA_MUTATIONS.find((candidate) => candidate === name);
  return operation === undefined ? undefined : jiraNativeDeclaration(operation, JIRA_SCHEMA_WRITE_DEFINITIONS[operation]);
}
