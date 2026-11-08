import {
  JIRA_SCHEME_OPTION_IDS_SCHEMA as IDS,
  JIRA_ISSUE_TYPE_SCHEME_REVIEW_SCHEMA as ISSUE_SNAPSHOT,
  JIRA_PRIORITY_SCHEME_REVIEW_SCHEMA as PRIORITY_SNAPSHOT,
} from "./jiraOptionSchemeSchemas.js";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolDeclaration } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { object, text } from "./jiraManagedSchemas.js";
import {
  jiraNativeIdentitySchema as ID,
  jiraNativeProjectSchema as KEY,
  jiraNativeDeclaration,
  jiraNativeWriteResult,
  type JiraNativeDefinition,
} from "./jiraProjectStructureDescriptors.js";
const NAME = { ...text(255), minLength: 1 };
const DESCRIPTION = text(32768);
const PROJECTS = {
  type: "array",
  maxItems: 50,
  items: object({ id: ID, key: KEY, name: NAME }, ["id", "key", "name"]),
};
const ACCEPT = { type: "boolean", enum: [true] };
const RECEIPT = { userKey: NAME, schemeId: ID, schemePresent: { type: "boolean" } };
const COMMON =
  "High-risk issue-tracker.admin action; Jira separately enforces native administrator permissions. Rebind the connected actor, exact scheme metadata/default and full ordered option identities before one fixed native effect. All selected IDs must exist in the native issue-type or priority catalog. No model URLs, headers, guessed names-as-IDs, hidden defaults or automatic replay. Current snapshots distinguish observed null from missing; desired name, description, nonempty ordered IDs and a member default are explicit. This bounded input does not clear an option list or infer a default. Pre-reads are not atomic CAS. Native IssueTypeSchemeResource does not support issue migrations and Priority PUT rejects changes requiring migrations; future issue writes continue using current metadata and saved formal rules. Do not claim a migration or bypass the governed issue writer. Native consequences may remain unconfirmed; receipt presence/association arrays describe requested targets until independently proven.";
function write(
  description: string,
  input: CatalogJsonObject,
  receipt: CatalogJsonObject,
  unconfirmed = false,
): JiraNativeDefinition {
  const result = jiraNativeWriteResult({ ...RECEIPT, ...receipt });
  return {
    description: `${description} ${COMMON}`,
    input,
    result: unconfirmed
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
function configuration(priority: boolean, update: boolean): JiraNativeDefinition {
  const fields = priority
    ? { optionIds: IDS, defaultOptionId: ID }
    : { issueTypeIds: IDS, defaultIssueTypeId: ID };
  return write(
    `${update ? "Replace the reviewed scheme's complete metadata, option order and default" : "Create a scheme with explicit metadata, ordered options and default"}. Empty description explicitly clears it. ${update ? "Known ID stays fixed, and every readable 2xx only starts fresh independent comparison; native ACK metadata never retargets the update." : "Only an exact new native ACK ID establishes the created target. Lost ACK never permits name lookup or another POST."} Confirm every requested fact by independently reading the same ID. ${priority ? "The native global-default flag remains observed and unchanged." : "issueTypeIds uses the published lower-case Ids property, not the legacy write-only alias."}`,
    object(
      {
        expectedActorKey: NAME,
        name: NAME,
        description: DESCRIPTION,
        ...fields,
        ...(update ? { expectedScheme: priority ? PRIORITY_SNAPSHOT : ISSUE_SNAPSHOT } : {}),
      },
      [
        "expectedActorKey",
        "name",
        "description",
        ...Object.keys(fields),
        ...(update ? ["expectedScheme"] : []),
      ],
    ),
    { schemePresent: { type: "boolean", enum: [true] } },
  );
}
function deletion(priority: boolean): JiraNativeDefinition {
  return write(
    `Delete only the exact reviewed ${priority ? "priority" : "issue-type"} scheme with explicit acceptance. Jira returns associated projects to the global default scheme. ${priority ? "The observed global default scheme cannot be deleted." : "Native Jira prohibits deleting its default/global scheme."} A 404 for the selected resource or a visible-list omission cannot prove all default-association and project-population consequences. Every acknowledged deletion remains unconfirmed and must not be repeated automatically.`,
    object(
      {
        expectedActorKey: NAME,
        expectedScheme: priority ? PRIORITY_SNAPSHOT : ISSUE_SNAPSHOT,
        confirmUnverifiedConsequences: ACCEPT,
      },
      ["expectedActorKey", "expectedScheme", "confirmUnverifiedConsequences"],
    ),
    { schemePresent: { type: "boolean", enum: [false] } },
    true,
  );
}
function association(change: "add" | "replace" | "clear" | "remove"): JiraNativeDefinition {
  const projects =
    change === "remove"
      ? { ...PROJECTS, minItems: 1, maxItems: 1 }
      : change === "clear"
        ? { ...PROJECTS, maxItems: 0 }
        : change === "add"
          ? { ...PROJECTS, minItems: 1 }
          : PROJECTS;
  return write(
    `Change issue-type scheme associations: ${change}. POST add appends, PUT replace overwrites every association (explicit [] clears), DELETE clear removes all, DELETE remove selects exactly one numeric bound project ID. Every current and selected project ID/key/name must still match independent project reads. Compare complete native scheme association configuration before and after; absent collection is unavailable, never []. Removed projects revert to the global/default scheme. These observations do not prove complete issue population or default-scheme effects, so all four association operations remain acknowledged-unconfirmed. No inferred migration, arbitrary project path or actor-visible issue search is used as population proof.`,
    object(
      {
        expectedActorKey: NAME,
        expectedScheme: ISSUE_SNAPSHOT,
        expectedProjects: PROJECTS,
        projects,
        confirmUnverifiedConsequences: ACCEPT,
      },
      [
        "expectedActorKey",
        "expectedScheme",
        "expectedProjects",
        "projects",
        "confirmUnverifiedConsequences",
      ],
    ),
    {
      schemePresent: { type: "boolean", enum: [true] },
      associationChange: { type: "string", enum: [change] },
      projectIds: { type: "array", maxItems: 50, uniqueItems: true, items: ID },
      projectKeys: { type: "array", maxItems: 50, uniqueItems: true, items: KEY },
    },
    true,
  );
}
export const JIRA_OPTION_SCHEME_WRITE_DEFINITIONS = {
  "jira.create-issue-type-scheme": configuration(false, false),
  "jira.update-issue-type-scheme": configuration(false, true),
  "jira.delete-issue-type-scheme": deletion(false),
  "jira.add-issue-type-scheme-projects": association("add"),
  "jira.set-issue-type-scheme-projects": association("replace"),
  "jira.clear-issue-type-scheme-projects": association("clear"),
  "jira.remove-issue-type-scheme-project": association("remove"),
  "jira.create-priority-scheme": configuration(true, false),
  "jira.update-priority-scheme": configuration(true, true),
  "jira.delete-priority-scheme": deletion(true),
} as const satisfies Readonly<Record<string, JiraNativeDefinition>>;
export function jiraOptionSchemeMutationDeclarationForTool(
  name: string,
): ManagedMcpToolDeclaration | undefined {
  const definitions: Readonly<Record<string, JiraNativeDefinition>> =
    JIRA_OPTION_SCHEME_WRITE_DEFINITIONS;
  const definition = Object.hasOwn(definitions, name) ? definitions[name] : undefined;
  return definition === undefined ? undefined : jiraNativeDeclaration(name, definition);
}
