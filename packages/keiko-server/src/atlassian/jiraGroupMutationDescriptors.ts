import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolDeclaration } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { object, text } from "./jiraManagedSchemas.js";
import {
  jiraNativeDeclaration,
  jiraNativeWriteResult,
  type JiraNativeDefinition,
} from "./jiraProjectStructureDescriptors.js";

const NAME = { ...text(255), minLength: 1 };
const ACCEPT = { type: "boolean", enum: [true] };
const USER = object({ key: NAME, name: NAME }, ["key", "name"]);
const COMMON =
  "Requires explicit issue-tracker.admin and the existing high-risk authority, mode-derived approval, durable journal and one-effect owners. Native administrator/directory permissions remain independent. Bind the exact connected actor; user keys and native usernames are distinct and must independently identify the same user. Group names are exact, never rewritten from picker labels. The native member read includes users from subgroups and cannot distinguish direct assignment. Direct group mutation is separate from that observation, role defaults, project-role assignments and effective permissions. No call proves complete application/permission consequences or uses a privileged credential fallback. Pre-reads are not atomic compare-and-swap. Unknown or acknowledged/unconfirmed outcomes must not be replayed; receipt flags are requested targets unless confirmed independently. Existing full argument/receipt byte bounds apply before effects.";
function write(
  description: string,
  input: CatalogJsonObject,
  fields: CatalogJsonObject,
  neverConfirmed = false,
): JiraNativeDefinition {
  const result = jiraNativeWriteResult({
    userKey: NAME,
    groupName: NAME,
    groupPresent: { type: "boolean" },
    ...fields,
  });
  return {
    description: `${description} ${COMMON}`,
    input,
    result: neverConfirmed
      ? {
          ...result,
          allOf: [
            {
              not: {
                properties: { outcome: { type: "string", enum: ["succeeded"] } },
                required: ["outcome"],
              },
            },
          ],
        }
      : result,
    risk: "write",
    maxResultCount: 1,
  };
}
const MEMBERSHIP = object(
  {
    expectedActorKey: NAME,
    groupName: NAME,
    user: USER,
    expectedObservedMembership: { type: "boolean" },
    acceptGlobalPermissionChange: ACCEPT,
  },
  [
    "expectedActorKey",
    "groupName",
    "user",
    "expectedObservedMembership",
    "acceptGlobalPermissionChange",
  ],
);
const MEMBERSHIP_RECEIPT = { targetUserKey: NAME, requestedDirectMembership: { type: "boolean" } };
export const JIRA_GROUP_WRITE_DEFINITIONS = {
  "jira.create-group": write(
    "Create one exact native group using POST group with {name}. Native Jira rejects existing/invalid names. A readable acknowledgement must identify that exact name, followed by an independent same-actor native group read. Success means group existence only: no empty-membership or effective-access assertion. Missing/mismatched acknowledgement identity remains unconfirmed and never triggers name search or another POST.",
    object({ expectedActorKey: NAME, groupName: NAME }, ["expectedActorKey", "groupName"]),
    {},
  ),
  "jira.delete-group": write(
    "Delete the selected exact group with acceptGlobalPermissionChange:true and confirmUnverifiedDeletion:true. Optional swapGroupName must be different and independently readable; it requests native restriction transfer, never substitutes for reassignment proof. Never infer complete global deletion/access effects from a picker, group absence or bare404. Every acknowledged deletion remains unconfirmed.",
    object(
      {
        expectedActorKey: NAME,
        groupName: NAME,
        swapGroupName: NAME,
        acceptGlobalPermissionChange: ACCEPT,
        confirmUnverifiedDeletion: ACCEPT,
      },
      [
        "expectedActorKey",
        "groupName",
        "acceptGlobalPermissionChange",
        "confirmUnverifiedDeletion",
      ],
    ),
    { swapGroupName: NAME },
    true,
  ),
  "jira.add-group-user": write(
    "Add one independently bound user using the native username body {name}, after comparing expectedObservedMembership with the complete bounded group/member read including inactive users and subgroup members. Follow at most twenty native 50-row pages with stable reported totals and unique key/name identities. Unavailable/incomplete membership never becomes false. Observed membership does not prove a direct assignment: an add is never declared a no-op on that basis. After one POST, independently read group-and-subgroup membership; even a match remains unconfirmed for global effective-access consequences.",
    MEMBERSHIP,
    MEMBERSHIP_RECEIPT,
    true,
  ),
  "jira.remove-group-user": write(
    "Remove one independently bound user using the exact native username query, after comparing expectedObservedMembership with complete bounded group-and-subgroup membership including inactive users. The native read cannot distinguish an inherited member from a direct one. A role/default/project membership or user-picker prefix is not that evidence. Missing pages, duplicate or changed principal identities refuse the effect. After one DELETE, independently read group-and-subgroup membership; even observed absence leaves aggregate permission/application consequences unconfirmed.",
    MEMBERSHIP,
    MEMBERSHIP_RECEIPT,
    true,
  ),
} as const satisfies Readonly<Record<string, JiraNativeDefinition>>;
export function jiraGroupMutationDeclarationForTool(
  name: string,
): ManagedMcpToolDeclaration | undefined {
  const definitions: Readonly<Record<string, JiraNativeDefinition>> = JIRA_GROUP_WRITE_DEFINITIONS;
  const definition = Object.hasOwn(definitions, name) ? definitions[name] : undefined;
  return definition === undefined ? undefined : jiraNativeDeclaration(name, definition);
}
