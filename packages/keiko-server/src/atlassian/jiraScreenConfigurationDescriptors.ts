import { TOOL_CATALOG_LIMITS, type CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolDeclaration } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { object, text } from "./jiraManagedSchemas.js";
import {
  jiraNativeIdentitySchema as ID, jiraNativeProjectSchema as FIELD_ID,
  jiraNativeDeclaration, jiraNativeWriteResult, type JiraNativeDefinition,
} from "./jiraProjectStructureDescriptors.js";

const NAME = { ...text(255), minLength: 1 };
const BOOL = { type: "boolean" };
const TAB = object({ id: ID, name: NAME }, ["id", "name"]);
const FIELD = object({ id: FIELD_ID, name: NAME,
  type: { anyOf: [NAME, { type: "null" }] },
  showWhenEmpty: { anyOf: [BOOL, { type: "null" }] },
}, ["id", "name", "type", "showWhenEmpty"]);
const CONTEXT = { screenId: ID, expectedScreenName: NAME, tabId: ID,
  expectedTabs: { type: "array", minItems: 1, maxItems: TOOL_CATALOG_LIMITS.maxArrayItems, uniqueItems: true, items: TAB } };
const REQUIRED_CONTEXT = ["screenId", "expectedScreenName", "tabId", "expectedTabs"];
const FIELD_CONTEXT = { ...CONTEXT, fieldId: FIELD_ID,
  expectedFields: { type: "array", maxItems: TOOL_CATALOG_LIMITS.maxArrayItems, uniqueItems: true, items: FIELD } };
const REQUIRED_FIELD = [...REQUIRED_CONTEXT, "fieldId", "expectedFields"];
const PARENT_RECEIPT = { screenId: ID, tabId: ID };
const FIELD_RECEIPT = { ...PARENT_RECEIPT, fieldId: FIELD_ID };
const SHARED = "This is an explicit high-risk Jira-instance administration operation. Existing authority and native Jira permissions both apply. The exact reviewed names and complete ordered native snapshots must still match before any effect; null means metadata was not supplied, not false or empty. Pre-reads are not atomic compare-and-swap. Dispatch exactly once, then independently bind the same screen/tab and read the complete layout. Acknowledgement alone never confirms success; unknown results must not be replayed. Screen presentation metadata is not required-field or issue-edit permission evidence.";
function write(description: string, input: CatalogJsonObject, receipt: CatalogJsonObject): JiraNativeDefinition {
  return { description: `${description} ${SHARED}`, input, result: jiraNativeWriteResult(receipt), risk: "write", maxResultCount: 1 };
}
export const JIRA_SCREEN_CONFIGURATION_WRITE_DEFINITIONS = {
  "jira.add-default-screen-field": write(
    "Add an exact observed field to Jira's server-selected default screen/tab. Review the field name and set acceptUnverifiedDefault:true explicitly. The fixed native endpoint chooses its own default; there is no reviewed screen ID and no independent default-layout proof. Even a successful acknowledgement remains unconfirmed, with only the known field ID and requested presence. Never invent a default screen ID or automatically repeat the write.",
    object({ fieldId: FIELD_ID, expectedFieldName: NAME, acceptUnverifiedDefault: { type: "boolean", enum: [true] } }, ["fieldId", "expectedFieldName", "acceptUnverifiedDefault"]),
    { fieldId: FIELD_ID, fieldPresent: { type: "boolean", enum: [true] } }),
  "jira.add-screen-tab-field": write(
    "Add one field to the exact selected tab. Its field ID/name must independently occur in that screen's complete availableFields collection and must be absent from the reviewed tab fields. No insertion position is promised. Confirm the added identity/name and unchanged relative order/metadata of all prior fields; use a separate governed move for placement.",
    object({ ...FIELD_CONTEXT, expectedFieldName: NAME }, [...REQUIRED_FIELD, "expectedFieldName"]),
    { ...FIELD_RECEIPT, fieldPresent: { type: "boolean", enum: [true] } }),
  "jira.remove-screen-tab-field": write(
    "Remove one exact existing field from the reviewed screen/tab layout with one DELETE. Require complete ordered field snapshots before writing and the exact remaining order/metadata afterward. A bare 404 or inaccessible parent is not absence evidence. This removes screen membership, not the field definition or existing issue values.",
    object(FIELD_CONTEXT, REQUIRED_FIELD),
    { ...FIELD_RECEIPT, fieldPresent: { type: "boolean", enum: [false] } }),
  "jira.move-screen-tab-field": write(
    "Reorder one existing field in the same tab using one documented native position First/Last/Earlier/Later. Never pass a URL. after and afterFieldId are unavailable until a primary source establishes the exact native anchor URI contract; no URI is inferred from another resource family. Confirm the complete desired order and unchanged field metadata; an already correct order is unchanged without a write.",
    object({ ...FIELD_CONTEXT, position: { type: "string", enum: ["First", "Last", "Earlier", "Later"] } }, [...REQUIRED_FIELD, "position"]), FIELD_RECEIPT),
  "jira.set-screen-field-show-when-empty": write(
    "Set the existing field's showWhenEmpty Boolean on the exact screen/tab. Supply the complete reviewed layout, including the old observed Boolean or explicit unknown null. Confirm the new native Boolean independently and preserve every other field/layout fact. A missing readback Boolean is unknown, never false. This Data Center display feature does not make a field required, editable or permitted.",
    object({ ...FIELD_CONTEXT, showWhenEmpty: BOOL }, [...REQUIRED_FIELD, "showWhenEmpty"]),
    { ...FIELD_RECEIPT, showWhenEmpty: BOOL }),
  "jira.move-screen-tab": write(
    "Move an existing tab to a native zero-based position: 0 is first, and the position must be below the complete reviewed tab count. Match the screen name and every ordered tab ID/name first. Independently confirm the entire desired tab order and unchanged names afterward; no tab or field is created or renamed. An already correct order is unchanged without writing.",
    object({ ...CONTEXT, position: { type: "integer", minimum: 0, maximum: TOOL_CATALOG_LIMITS.maxArrayItems - 1 } }, [...REQUIRED_CONTEXT, "position"]), PARENT_RECEIPT),
} as const satisfies Readonly<Record<string, JiraNativeDefinition>>;

export function jiraScreenConfigurationDeclarationForTool(name: string): ManagedMcpToolDeclaration | undefined {
  const definitions: Readonly<Record<string, JiraNativeDefinition>> = JIRA_SCREEN_CONFIGURATION_WRITE_DEFINITIONS;
  const definition = Object.hasOwn(definitions, name) ? definitions[name] : undefined;
  return definition === undefined ? undefined : jiraNativeDeclaration(name, definition);
}
