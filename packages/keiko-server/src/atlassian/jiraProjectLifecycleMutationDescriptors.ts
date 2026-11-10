import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolDeclaration } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { object, text } from "./jiraManagedSchemas.js";
import { JIRA_PRIORITY_SCHEME_REVIEW_SCHEMA } from "./jiraOptionSchemeSchemas.js";
import { JIRA_PERMISSION_SCHEME_REVIEW_SCHEMA } from "./jiraPermissionSchemeMutationDescriptors.js";
import { JIRA_PROJECT_REVIEW_SCHEMA } from "./jiraProjectLifecycleSchemas.js";
import {
  jiraNativeIdentitySchema as ID,
  jiraNativePermissionSchemeIdentitySchema as PERMISSION_ID,
  jiraNativeDeclaration,
  jiraNativeWriteResult,
  type JiraNativeDefinition,
} from "./jiraProjectStructureDescriptors.js";

const NAME = { ...text(255), minLength: 1 };
const KEY = { ...text(128), minLength: 1 };
const COMMON_INPUT = {
  expectedActorKey: NAME,
  expectedProject: JIRA_PROJECT_REVIEW_SCHEMA,
  confirmUnverifiedConsequences: { type: "boolean", enum: [true] },
};
const COMMON_REQUIRED = ["expectedActorKey", "expectedProject", "confirmUnverifiedConsequences"];
const COMMON =
  "High-risk instance administration requiring explicit issue-tracker.admin authority and independent native Jira permissions. Bind the current actor and exact native project ID/key/name/archived flag plus every reviewed scheme fact before one native effect. Missing archived or scheme facts are unavailable, never inferred false/null/empty. A review is not atomic compare-and-swap. Every ACK remains succeeded-unconfirmed: project/issue/permission/index consequences cannot be established from one visible project or configuration read, and404 never proves global absence. Known receipts survive denied/lost readbacks; flags/type/scheme selections under uncertainty are requested targets only. No automatic retry or follow-up native effect.";
function write(
  description: string,
  input: CatalogJsonObject,
  required: readonly string[],
  receipt: CatalogJsonObject,
): JiraNativeDefinition {
  return {
    description: `${description} ${COMMON}`,
    input: object({ ...COMMON_INPUT, ...input }, [...COMMON_REQUIRED, ...required]),
    result: {
      ...jiraNativeWriteResult({ userKey: NAME, projectId: ID, projectKey: KEY, ...receipt }),
      allOf: [
        {
          not: {
            properties: { outcome: { type: "string", enum: ["succeeded"] } },
            required: ["outcome"],
          },
        },
      ],
    },
    risk: "write",
    maxResultCount: 1,
  };
}
const ASSIGNED = {
  schemeId: ID,
  previousSchemeId: ID,
  projectSchemeAssigned: { type: "boolean", enum: [true] },
};
const TYPED_PROJECT = {
  ...JIRA_PROJECT_REVIEW_SCHEMA,
  required: ["id", "key", "name", "archived", "projectTypeKey"],
};
export const JIRA_PROJECT_LIFECYCLE_WRITE_DEFINITIONS = {
  "jira.delete-project": write(
    "Delete the reviewed native project. Existing formal issue-deletion impact admission checks surviving parent/link/issue-picker rules across all projects; no visible project issue prefix can establish complete incoming-reference coverage. The deleted project's own summary/labels are not treated as surviving fields.",
    {},
    [],
    { projectPresent: { type: "boolean", enum: [false] } },
  ),
  "jira.archive-project": write(
    "Archive the reviewed project. The actual ProjectBean archived boolean is required; a current true reports unchanged without a write. This is not issue-level archive-state inference or a blanket issue-field gate.",
    {},
    [],
    { projectArchivedRequested: { type: "boolean", enum: [true] } },
  ),
  "jira.restore-project": write(
    "Restore an archived project. Native202 does not complete indexing: Jira documents a required reindex, which is not started automatically. A current false reports unchanged without a write.",
    {},
    [],
    { projectArchivedRequested: { type: "boolean", enum: [false] } },
  ),
  "jira.update-project-type": write(
    "Change project type through its dedicated native route. expectedProject must include the actually observed projectTypeKey, and the requested type must pass Jira's existing accessible-type read. Do not invent type/license availability or issue migration results.",
    { expectedProject: TYPED_PROJECT, projectTypeKey: KEY },
    ["projectTypeKey"],
    { projectTypeKey: KEY },
  ),
  "jira.set-project-permission-scheme": write(
    "Replace the project's permission-scheme association. Review complete current and destination scheme metadata/grants via existing strict scheme readers. Native body contains only the exact safe numeric target scheme ID. Config equality never proves effective permissions for any user or hidden issue.",
    {
      expectedScheme: JIRA_PERMISSION_SCHEME_REVIEW_SCHEMA,
      scheme: JIRA_PERMISSION_SCHEME_REVIEW_SCHEMA,
    },
    ["expectedScheme", "scheme"],
    { ...ASSIGNED, schemeId: PERMISSION_ID, previousSchemeId: PERMISSION_ID },
  ),
  "jira.set-project-priority-scheme": write(
    "Assign a priority scheme through the fixed native ExperimentalApi port. Review current and target full ordered option/default configuration. Jira explicitly refuses changes requiring issue-priority migration; this API does not perform or invent that migration. The JSON scheme ID must be an exact safe integer.",
    {
      expectedScheme: JIRA_PRIORITY_SCHEME_REVIEW_SCHEMA,
      scheme: JIRA_PRIORITY_SCHEME_REVIEW_SCHEMA,
    },
    ["expectedScheme", "scheme"],
    ASSIGNED,
  ),
  "jira.remove-project-priority-scheme": write(
    "Unassign the exact current nondefault priority scheme through the fixed native ExperimentalApi port. Native defaultScheme:true is refused before dispatch. Observe the current project association independently; no chosen replacement or issue population is inferred after removal.",
    { expectedScheme: JIRA_PRIORITY_SCHEME_REVIEW_SCHEMA },
    ["expectedScheme"],
    { schemeId: ID, projectSchemeAssigned: { type: "boolean", enum: [false] } },
  ),
} as const satisfies Readonly<Record<string, JiraNativeDefinition>>;
export function jiraProjectLifecycleMutationDeclarationForTool(
  name: string,
): ManagedMcpToolDeclaration | undefined {
  const definitions: Readonly<Record<string, JiraNativeDefinition>> =
    JIRA_PROJECT_LIFECYCLE_WRITE_DEFINITIONS;
  const selected = Object.hasOwn(definitions, name) ? definitions[name] : undefined;
  return selected === undefined ? undefined : jiraNativeDeclaration(name, selected);
}
