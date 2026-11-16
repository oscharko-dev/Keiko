import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolDeclaration } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { object, text } from "./jiraManagedSchemas.js";
import { jiraRoleReviewSnapshotSchema as ROLE } from "./jiraRoleDescriptors.js";
import {
  jiraNativeDeclaration,
  jiraNativeIdentitySchema as ID,
  jiraNativeProjectSchema as KEY,
  jiraNativeWriteResult,
  type JiraNativeDefinition,
} from "./jiraProjectStructureDescriptors.js";

const NAME = { ...text(255), minLength: 1 };
const DESCRIPTION = text(32768);
const ACTOR_TYPE = {
  type: "string",
  enum: ["atlassian-user-role-actor", "atlassian-group-role-actor"],
};
const ACTORS = {
  type: "array",
  maxItems: TOOL_CATALOG_LIMITS.maxArrayItems,
  items: object({ id: ID, type: ACTOR_TYPE, name: NAME }, ["id", "type", "name"]),
};
const USER = object({ key: NAME, name: NAME }, ["key", "name"]);
const PRINCIPALS = object(
  {
    users: { type: "array", maxItems: 50, items: USER },
    groups: { type: "array", maxItems: 50, uniqueItems: true, items: NAME },
  },
  ["users", "groups"],
);
const REVIEW = { expectedActorKey: NAME, expectedRole: ROLE, expectedActors: ACTORS };
const REVIEW_REQUIRED = ["expectedActorKey", "expectedRole", "expectedActors"];
const RECEIPT = { roleId: ID, userKey: NAME, rolePresent: { type: "boolean" } };
const ACTOR_RECEIPT = {
  ...RECEIPT,
  rolePresent: { type: "boolean", enum: [true] },
  actorUserKeys: { type: "array", maxItems: 50, uniqueItems: true, items: NAME },
  actorGroupNames: { type: "array", maxItems: 50, uniqueItems: true, items: NAME },
};
const COMMON =
  "High-risk issue-tracker.admin action through the existing authority, approval and durable journal owners; ordinary issue write scope is insufficient. Native Jira separately checks administrative/project permissions. The exact connected actor is rebound; current role ID/name/description and complete typed actor assignment snapshots must still match. Missing actor ID/type or description is unavailable review evidence, never an invented empty value. Observed description:null is reviewable but desired descriptions are explicit strings, including empty. The adapter sends one fixed native request and independently reads afterward; pre-reads are not atomic compare-and-swap. Unknown effects retain known IDs and must not be replayed. No user URL, arbitrary method, header, actor namespace or principal registry is accepted. Result receipts must fit the existing 16 KiB bound before writing.";
function write(
  description: string,
  input: CatalogJsonObject,
  receipt: CatalogJsonObject,
): JiraNativeDefinition {
  return {
    description: `${description} ${COMMON}`,
    input,
    result: jiraNativeWriteResult(receipt),
    risk: "write",
    maxResultCount: 1,
  };
}
function actorWrite(
  description: string,
  project: boolean,
  change: "add" | "replace" | "remove",
): JiraNativeDefinition {
  return write(
    `${description} User targets contain both exact key and native username; independent username and key reads must identify the same user before either username is sent. Groups use exact independently observed native names. users and groups arrays are both explicit, with at most 50 combined principals. Add accepts one nonempty namespace; delete accepts exactly one principal; project replacement accepts both namespaces and explicit empty arrays. Full native assignment IDs/types/names are compared as a set, not display-name order. Fresh matching actor configuration still leaves effective group/permission consequences unconfirmed; receipt arrays describe requested targets only.`,
    object({ ...REVIEW, principals: PRINCIPALS, ...(project ? { projectIdOrKey: KEY } : {}) }, [
      ...REVIEW_REQUIRED,
      "principals",
      ...(project ? ["projectIdOrKey"] : []),
    ]),
    {
      ...ACTOR_RECEIPT,
      roleActorsScope: { type: "string", enum: [project ? "project-membership" : "role-defaults"] },
      actorChange: { type: "string", enum: [change] },
      ...(project ? { projectId: ID, projectKey: KEY } : {}),
    },
  );
}
export const JIRA_ROLE_WRITE_DEFINITIONS = {
  "jira.create-role": write(
    "Create a native global role with explicit name and description. Read the bounded role collection first for a visible exact name conflict; native Jira decides uniqueness. New roles have no default actors. Only a fresh native ACK ID identifies the created role; read that exact ID and its full default actor envelope to confirm metadata and empty defaults. Lost ACK never permits name lookup or a second POST.",
    object({ expectedActorKey: NAME, name: NAME, description: DESCRIPTION }, [
      "expectedActorKey",
      "name",
      "description",
    ]),
    { ...RECEIPT, rolePresent: { type: "boolean", enum: [true] } },
  ),
  "jira.update-role": write(
    "Partially change the reviewed global role using native POST. Supply name and/or description; omitted fields remain unchanged, explicit empty description clears it. Native names must already be trimmed. Confirmation requires exact desired metadata and unchanged default actors.",
    {
      ...object({ ...REVIEW, name: NAME, description: DESCRIPTION }, REVIEW_REQUIRED),
      anyOf: [{ required: ["name"] }, { required: ["description"] }],
    },
    { ...RECEIPT, rolePresent: { type: "boolean", enum: [true] } },
  ),
  "jira.replace-role": write(
    "Fully update the reviewed global role using native PUT. BOTH name and description are required. No null/omitted clear is inferred. Confirm exact metadata and unchanged default actors from independent native reads.",
    object({ ...REVIEW, name: NAME, description: DESCRIPTION }, [
      ...REVIEW_REQUIRED,
      "name",
      "description",
    ]),
    { ...RECEIPT, rolePresent: { type: "boolean", enum: [true] } },
  ),
  "jira.delete-role": write(
    "Delete the exact reviewed global role. Optional expectedSwapRole AND expectedSwapActors independently bind a different replacement role and its complete defaults; native query swap replaces scheme references. confirmUnverifiedDeletion:true acknowledges that neither selected404 nor a visible role collection proves all deletion/scheme effects. Native acknowledgement always remains unconfirmed. rolePresent:false is the requested target, not proof of deletion.",
    object(
      {
        ...REVIEW,
        expectedSwapRole: ROLE,
        expectedSwapActors: ACTORS,
        confirmUnverifiedDeletion: { type: "boolean", enum: [true] },
      },
      [...REVIEW_REQUIRED, "confirmUnverifiedDeletion"],
    ),
    { ...RECEIPT, rolePresent: { type: "boolean", enum: [false] }, swapRoleId: ID },
  ),
  "jira.add-role-default-actors": actorWrite(
    "Add default user OR group actors to the reviewed global role. This changes role defaults, not a selected project's current membership.",
    false,
    "add",
  ),
  "jira.delete-role-default-actor": actorWrite(
    "Remove exactly one reviewed default user OR group actor. Native DELETE has a fixed user or group query; no arbitrary selector.",
    false,
    "remove",
  ),
  "jira.add-project-role-actors": actorWrite(
    "Add users OR groups to a role in the independently bound project. Resolve the project to its observed numeric ID; compare the exact role metadata and complete project actor set. Global defaults remain separate.",
    true,
    "add",
  ),
  "jira.set-project-role-actors": actorWrite(
    "Replace the complete reviewed project role actor configuration using native PUT with id and two fixed categorisedActors namespaces. Both explicit empty arrays clear the configuration. The native body requires a safe JSON integer role ID, so IDs above 9007199254740991 are refused before any request.",
    true,
    "replace",
  ),
  "jira.delete-project-role-actor": actorWrite(
    "Remove exactly one selected user OR group from the reviewed project role. Rebind the canonical project before readback; permission-hiding404 cannot establish absence or a no-effect refusal.",
    true,
    "remove",
  ),
} as const satisfies Readonly<Record<string, JiraNativeDefinition>>;
export function jiraRoleMutationDeclarationForTool(
  name: string,
): ManagedMcpToolDeclaration | undefined {
  const definitions: Readonly<Record<string, JiraNativeDefinition>> = JIRA_ROLE_WRITE_DEFINITIONS;
  const definition = Object.hasOwn(definitions, name) ? definitions[name] : undefined;
  return definition === undefined ? undefined : jiraNativeDeclaration(name, definition);
}
