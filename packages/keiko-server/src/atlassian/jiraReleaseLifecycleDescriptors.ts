import { TOOL_CATALOG_LIMITS, type CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { JiraReleaseLifecycleMutation } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { ManagedMcpToolDeclaration } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { object, text } from "./jiraManagedSchemas.js";
import { jiraNativeIdentitySchema as ID, jiraNativeDeclaration, jiraNativeWriteResult, type JiraNativeDefinition } from "./jiraProjectStructureDescriptors.js";

const NAME = { ...text(255), minLength: 1 };
const BOOL = { type: "boolean" };
const NULL = { type: "null" };
const nullable = (schema: CatalogJsonObject): CatalogJsonObject => ({ anyOf: [schema, NULL] });
const DATE = { ...text(10), format: "date", description: "A real native calendar date, without timezone conversion." };
const COMPONENT_SNAPSHOT = object({ name: NAME, description: nullable(text(32768)), leadUserName: nullable(NAME),
  assigneeType: nullable({ type: "string", enum: ["PROJECT_DEFAULT", "COMPONENT_LEAD", "PROJECT_LEAD", "UNASSIGNED"] }),
  archived: nullable(BOOL), deleted: nullable(BOOL) }, ["name", "description", "leadUserName", "assigneeType", "archived", "deleted"]);
const VERSION_SNAPSHOT = object({ name: NAME, description: nullable(text(32768)), startDate: nullable(DATE), releaseDate: nullable(DATE),
  released: nullable(BOOL), archived: nullable(BOOL) }, ["name", "description", "startDate", "releaseDate", "released", "archived"]);
const CONTEXT = { expectedProjectId: ID, expectedActorKey: NAME };
const VERSION = { ...CONTEXT, versionId: ID, expectedVersionSnapshot: VERSION_SNAPSHOT };
const VERSION_REQUIRED = ["expectedProjectId", "expectedActorKey", "versionId", "expectedVersionSnapshot"];
const COMPONENT = { ...CONTEXT, componentId: ID, expectedComponentSnapshot: COMPONENT_SNAPSHOT };
const COMPONENT_REQUIRED = ["expectedProjectId", "expectedActorKey", "componentId", "expectedComponentSnapshot", "moveIssuesTo"];
const IDS = { type: "array", maxItems: TOOL_CATALOG_LIMITS.maxArrayItems, uniqueItems: true, items: ID };
const RECEIPT = { projectId: ID, projectKey: text(128), userKey: NAME };
const SHARED = "This is one high-risk governed native mutation. Match the connected actor, exact native project/entity and every reviewed snapshot before any effect. Every snapshot field is required; null records missing native metadata and is not empty text, false or zero. Unknown effects are never replayed. Jira independently enforces its native permissions. The pre-read is not an atomic compare-and-swap guarantee. Reference-rewriting bulk operations refuse BEFORE writing when edit-active formal templates govern affected fields and complete issue post-state cannot be proven. Use governed jira.edit for individual issue-reference corrections; prose skills and unaffected formal rules are not enforcement. Version ordering does not rewrite issue fields.";
function write(description: string, input: CatalogJsonObject, receipt: CatalogJsonObject): JiraNativeDefinition {
  return { description: `${description} ${SHARED}`, input, result: jiraNativeWriteResult({ ...RECEIPT, ...receipt }), risk: "write", maxResultCount: 1 };
}
export const JIRA_RELEASE_LIFECYCLE_WRITE_DEFINITIONS = {
  "jira.delete-component": write("Delete one exact component. Explicit moveIssuesTo:null removes the component from affected issues. A replacement requires a different same-project component and its complete reviewed metadata. Send one DELETE, then independently read the actor, project and complete component collection. Entity absence does NOT establish all issue-reference effects: keep the source/replacement IDs and report unconfirmed even after acknowledgement and absence.",
    { anyOf: [object({ ...COMPONENT, moveIssuesTo: NULL }, COMPONENT_REQUIRED),
      object({ ...COMPONENT, moveIssuesTo: ID, expectedReplacementSnapshot: COMPONENT_SNAPSHOT }, [...COMPONENT_REQUIRED, "expectedReplacementSnapshot"])] },
    { componentId: ID, replacementComponentId: ID }),
  "jira.merge-version": write("Merge one exact version into a different reviewed same-project version with one native PUT, deleting the source. Both complete version snapshots must match. Read the same actor/project and full version collection afterward, but keep the aggregate issue-reference result unconfirmed: source absence and surviving target metadata cannot prove all issue assignments. Never use a guessed target or repeat the merge.",
    object({ ...VERSION, moveIssuesTo: ID, expectedTargetSnapshot: VERSION_SNAPSHOT }, [...VERSION_REQUIRED, "moveIssuesTo", "expectedTargetSnapshot"]),
    { versionId: ID, targetVersionId: ID }),
  "jira.move-version": write("Reorder one version inside its existing project. expectedVersionIds is the complete ordered native project list, including source and any afterVersionId. Choose exactly one native position First/Last/Earlier/Later or afterVersionId. The URI for after is minted only from the bound connection; never pass a URL. An already matching full order is unchanged without writing. After one POST, independently require the entire desired order and all original metadata under the same actor/project. This changes version ordering only, not issues or version names.",
    { anyOf: [object({ ...VERSION, expectedVersionIds: { ...IDS, minItems: 1 }, position: { type: "string", enum: ["First", "Last", "Earlier", "Later"] } }, [...VERSION_REQUIRED, "expectedVersionIds", "position"]),
      object({ ...VERSION, expectedVersionIds: { ...IDS, minItems: 1 }, afterVersionId: ID }, [...VERSION_REQUIRED, "expectedVersionIds", "afterVersionId"])] },
    { versionId: ID }),
  "jira.remove-and-swap-version": write("Delete one version and replace or clear its fix-version, affected-version and custom version-field references with one native POST. Explicit null clears a selected field; an empty customFieldReplacementList clears the removed version from ALL custom fields. Each non-null target needs exactly one complete reviewed same-project snapshot in expectedReplacementVersions. customFieldId and replacement version IDs are exact strings that must fit safe JSON integers for native Long body fields. Every selected custom field must be independently observed as a version field. No issue-reference completeness claim is made: after acknowledgement and independent entity reads, retain source/target IDs as unconfirmed.",
    object({ ...VERSION, moveFixIssuesTo: nullable(ID), moveAffectedIssuesTo: nullable(ID),
      customFieldReplacementList: { type: "array", maxItems: TOOL_CATALOG_LIMITS.maxArrayItems, items: object({ customFieldId: ID, moveTo: nullable(ID) }, ["customFieldId", "moveTo"]) },
      expectedReplacementVersions: { type: "array", maxItems: TOOL_CATALOG_LIMITS.maxArrayItems, items: object({ versionId: ID, expectedVersionSnapshot: VERSION_SNAPSHOT }, ["versionId", "expectedVersionSnapshot"]) },
    }, [...VERSION_REQUIRED, "moveFixIssuesTo", "moveAffectedIssuesTo", "customFieldReplacementList", "expectedReplacementVersions"]),
    { versionId: ID, replacementVersionIds: IDS }),
} as const satisfies Readonly<Record<JiraReleaseLifecycleMutation, JiraNativeDefinition>>;

export function jiraReleaseLifecycleDeclarationForTool(name: string): ManagedMcpToolDeclaration | undefined {
  const definitions: Readonly<Record<string, JiraNativeDefinition>> = JIRA_RELEASE_LIFECYCLE_WRITE_DEFINITIONS;
  const definition = Object.hasOwn(definitions, name) ? definitions[name] : undefined;
  return definition === undefined ? undefined : jiraNativeDeclaration(name, definition);
}
