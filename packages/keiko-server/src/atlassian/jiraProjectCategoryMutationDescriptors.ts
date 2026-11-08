import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolDeclaration } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { object, text } from "./jiraManagedSchemas.js";
import {
  jiraNativeIdentitySchema as ID, jiraNativeDeclaration, jiraNativeWriteResult,
  type JiraNativeDefinition,
} from "./jiraProjectStructureDescriptors.js";

const NAME = { ...text(255), minLength: 1 };
const DESCRIPTION = text(32768);
const SNAPSHOT = object({ id: ID, name: NAME, description: DESCRIPTION }, ["id", "name", "description"]);
const ACTOR = { expectedActorKey: NAME };
const TARGET = { name: NAME, description: DESCRIPTION };
const RECEIPT = { categoryId: ID, userKey: NAME, categoryPresent: { type: "boolean" } };
const SHARED = "An explicit high-risk issue-tracker.admin action in the existing approval and durable journal. Native Jira independently requires global administration; the local grant or credential cannot supply it. Review the exact actor and complete native category metadata. Descriptions must be observed strings, including an actual empty string; absent/null is unavailable review evidence and never a default. The native category GETs supply review facts, not project or issue permissions. Pre-reads are not atomic compare-and-swap. Send one effect; independently rebind the actor before readback, retain known IDs after failure, and never replay uncertain writes. Category metadata does not invent or activate issue-template rules.";
function write(description: string, input: CatalogJsonObject, present: boolean): JiraNativeDefinition {
  return { description: `${description} ${SHARED}`, input,
    result: jiraNativeWriteResult({ ...RECEIPT, categoryPresent: { type: "boolean", enum: [present] } }),
    risk: "write", maxResultCount: 1 };
}
export const JIRA_PROJECT_CATEGORY_WRITE_DEFINITIONS = {
  "jira.create-project-category": write("Create a native project category with an explicit name and description. First inspect the complete bounded native category collection; an exact existing name refuses creation. Jira remains authoritative for native name conflicts. Only the native201 acknowledgement supplies the new category ID. Independently read that ID to confirm the desired name/description. Lost acknowledgement supplies no invented ID and permits no second POST.",
    object({ ...ACTOR, ...TARGET }, ["expectedActorKey", "name", "description"]), true),
  "jira.update-project-category": write("Update only the exact reviewed category name and description using native PUT. Both provided fields override their previous values; an empty description is an explicit clear. The complete expectedCategory ID/name/description must still match before writing. Equal desired metadata reports unchanged without a PUT. Confirm the exact desired metadata by an independent same-ID GET.",
    object({ ...ACTOR, ...TARGET, expectedCategory: SNAPSHOT }, ["expectedActorKey", "expectedCategory", "name", "description"]), true),
  "jira.delete-project-category": write("Delete one exact reviewed native project category. confirmUnverifiedDeletion:true explicitly accepts that a successful native204 and visible-list omission cannot independently prove every deletion or project-association effect. Selected404 also means permission loss. Retain the known ID and requested categoryPresent:false, but always report acknowledgement as unconfirmed and never replay DELETE.",
    object({ ...ACTOR, expectedCategory: SNAPSHOT, confirmUnverifiedDeletion: { type: "boolean", enum: [true] } },
      ["expectedActorKey", "expectedCategory", "confirmUnverifiedDeletion"]), false),
} as const satisfies Readonly<Record<string, JiraNativeDefinition>>;
export function jiraProjectCategoryMutationDeclarationForTool(name: string): ManagedMcpToolDeclaration | undefined {
  const definitions: Readonly<Record<string, JiraNativeDefinition>> = JIRA_PROJECT_CATEGORY_WRITE_DEFINITIONS;
  const definition = Object.hasOwn(definitions, name) ? definitions[name] : undefined;
  return definition === undefined ? undefined : jiraNativeDeclaration(name, definition);
}
