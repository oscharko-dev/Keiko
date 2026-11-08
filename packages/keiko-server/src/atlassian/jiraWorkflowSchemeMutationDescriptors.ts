import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolDeclaration } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import type { JiraWorkflowSchemeMutation } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { object, text } from "./jiraManagedSchemas.js";
import {
  jiraNativeDeclaration,
  jiraNativeIdentitySchema as ID,
  jiraNativeWriteResult,
  type JiraNativeDefinition,
} from "./jiraProjectStructureDescriptors.js";
import {
  jiraWorkflowSchemeMappingsSchema as MAPPINGS,
  jiraWorkflowSchemeReviewFields,
  jiraWorkflowSchemeReviewRequired,
} from "./jiraWorkflowSchemeReviewSchema.js";

const NAME = { ...text(255), minLength: 1 };
const NULLABLE_WORKFLOW = { anyOf: [NAME, { type: "null" }] };
const BASE = object(
  { ...jiraWorkflowSchemeReviewFields, draft: { type: "boolean", enum: [false] } },
  jiraWorkflowSchemeReviewRequired,
);
const DRAFT = object(
  { ...jiraWorkflowSchemeReviewFields, draft: { type: "boolean", enum: [true] } },
  [...jiraWorkflowSchemeReviewRequired, "originalDefaultWorkflow", "originalMappings"],
);
const TARGET = {
  name: NAME,
  description: text(32768),
  defaultWorkflow: NULLABLE_WORKFLOW,
  mappings: MAPPINGS,
};
const COMMON =
  "High-risk issue-tracker.admin configuration action; ordinary issue write scope is insufficient. Native Jira independently checks administration/WebSudo and active-scheme constraints. Rebind the exact connected actor, complete parent snapshot and any explicitly reviewed draft. A missing description/default/mapping field is unknown, not null or empty. Configured default:null does not mean there is no effective fallback workflow. Base routes fix updateDraftIfNeeded:false and require no existing draft; no implicit target change, publication, project association or status migration occurs. Draft operations never deploy a draft. Inputs are immutable snapshots for review, not an atomic native compare-and-swap. One native write maximum, then independent same-parent reads; lost ACK or unreadable state retains only known identities and must not be replayed. Receipt target flags describe requested facts until independently confirmed. No user URL, arbitrary method, header or workflow definition is accepted.";
function receipt(draft: boolean): CatalogJsonObject {
  return {
    userKey: NAME,
    schemeId: ID,
    workflowSchemeScope: { type: "string", enum: [draft ? "draft" : "scheme"] },
    schemePresent: { type: "boolean" },
    ...(draft ? { draftSchemeId: ID } : {}),
  };
}
function reviewed(draft: boolean): CatalogJsonObject {
  return {
    expectedActorKey: NAME,
    expectedScheme: BASE,
    ...(draft ? { expectedDraft: DRAFT } : {}),
  };
}
function requiredReview(draft: boolean): string[] {
  return ["expectedActorKey", "expectedScheme", ...(draft ? ["expectedDraft"] : [])];
}
function write(
  description: string,
  input: CatalogJsonObject,
  fields: CatalogJsonObject,
  confirmable = true,
): JiraNativeDefinition {
  const result = jiraNativeWriteResult(fields, confirmable ? undefined : false);
  return {
    description: `${description} ${COMMON}`,
    input,
    result,
    risk: "write",
    maxResultCount: 1,
  };
}
function update(draft: boolean): JiraNativeDefinition {
  const fields = {
    ...receipt(draft),
    ...(!draft ? { workflowMappingChanged: { type: "boolean" } } : {}),
  };
  const definition = write(
    "Update explicitly supplied metadata/default/mappings; omitted fields remain unchanged, explicit empty description clears it, explicit empty mappings removes configured issue-type mappings, and null explicitly removes the configured default. Workflow names and issue-type IDs in supplied targets are independently bound. Complete expected metadata, mapping sets and original draft mappings must still match. Native draft PUT can create if another actor deletes the draft after admission: an independently observed different draft ID stays unconfirmed, never retargeted. Base mapping edits remain unconfirmed for aggregate project consequences; metadata-only or exact draft configuration can confirm without claiming deployment. A base-update workflowMappingChanged flag records whether defaults or mappings were explicitly supplied, even when unchanged.",
    {
      ...object({ ...reviewed(draft), ...TARGET }, requiredReview(draft)),
      anyOf: Object.keys(TARGET).map((field) => ({ required: [field] })),
    },
    fields,
  );
  return draft
    ? definition
    : {
        ...definition,
        result: jiraNativeWriteResult(fields, {
          properties: { workflowMappingChanged: { type: "boolean", enum: [false] } },
          required: ["workflowMappingChanged"],
        }),
      };
}
function remove(draft: boolean): JiraNativeDefinition {
  return write(
    draft
      ? "Delete the explicitly reviewed draft. Confirmation requires the unchanged readable parent and the documented returnDraftIfExists selection returning that exact parent. A direct404 is never sufficient. confirmUnverifiedDeletion:true explicitly reviews the destructive intent."
      : "Delete the reviewed base scheme without an existing draft. Jira forbids deletion of an active scheme. confirmUnverifiedDeletion:true acknowledges that selected404 cannot prove global deletion or all project consequences; ACK always remains unconfirmed.",
    object({ ...reviewed(draft), confirmUnverifiedDeletion: { type: "boolean", enum: [true] } }, [
      ...requiredReview(draft),
      "confirmUnverifiedDeletion",
    ]),
    { ...receipt(draft), schemePresent: { type: "boolean", enum: [false] } },
    draft,
  );
}
type MappingKind = "default" | "issue-type" | "workflow";
function mappingArguments(kind: MappingKind, remove: boolean): CatalogJsonObject {
  const needsName = kind === "workflow" || !remove;
  return {
    ...(kind === "issue-type" ? { issueTypeId: ID } : {}),
    ...(needsName ? { workflowName: NAME } : {}),
    ...(kind === "workflow" && !remove
      ? {
          issueTypeIds: {
            type: "array",
            maxItems: TOOL_CATALOG_LIMITS.maxArrayItems,
            uniqueItems: true,
            items: ID,
          },
          defaultMapping: { type: "boolean" },
        }
      : {}),
  };
}
function mappingReceipt(kind: MappingKind, draft: boolean, remove: boolean): CatalogJsonObject {
  return {
    ...receipt(draft),
    schemePresent: { type: "boolean", enum: [true] },
    mappingPresent:
      kind === "workflow" && !remove ? { type: "boolean" } : { type: "boolean", enum: [!remove] },
    ...(kind === "issue-type" ? { issueTypeId: ID } : {}),
    ...(kind === "workflow" || !remove ? { workflowName: NAME } : {}),
  };
}
function mapping(kind: MappingKind, draft: boolean, remove: boolean): JiraNativeDefinition {
  const target = mappingArguments(kind, remove);
  return write(
    `${remove ? "Remove" : "Set"} the native ${kind} mapping in the ${draft ? "explicitly reviewed draft" : "reviewed base scheme"}. Compare the complete configuration, not a selected mapping404. Workflow mapping PUT requires its complete desired issueTypeIds and explicit defaultMapping; [] is intentional. Workflow removal removes all explicit references including its configured default when matched. Native fallback behavior is not guessed. Any missing/null ambiguity or additional changed mapping leaves acknowledgement unconfirmed. Base mapping effects remain unconfirmed for aggregate consequences even if configuration matches.`,
    object({ ...reviewed(draft), ...target }, [...requiredReview(draft), ...Object.keys(target)]),
    mappingReceipt(kind, draft, remove),
    draft,
  );
}
export const JIRA_WORKFLOW_SCHEME_WRITE_DEFINITIONS = {
  "jira.create-workflow-scheme": write(
    "Create a base workflow scheme with explicit name, description, configured default and complete mapping list. Native Jira owns uniqueness. Only a fresh observed ACK ID may identify creation; never infer an ID from name, URI or later enumeration. Read that exact ID independently; configuration confirmation does not assign it to any project.",
    object({ expectedActorKey: NAME, ...TARGET }, ["expectedActorKey", ...Object.keys(TARGET)]),
    receipt(false),
  ),
  "jira.update-workflow-scheme": update(false),
  "jira.delete-workflow-scheme": remove(false),
  "jira.create-workflow-scheme-draft": write(
    "Create the native copy of an exact reviewed draftless parent. Jira requires that parent to be active/in use; draft:false alone is not evidence of activity. The documented draft-selection GET must first return the same parent. Only the new native ACK ID identifies the draft; confirm exact copied configuration/original mappings and unchanged parent using independent parent/draft reads. Nothing is deployed.",
    object(reviewed(false), requiredReview(false)),
    receipt(true),
  ),
  "jira.update-workflow-scheme-draft": update(true),
  "jira.delete-workflow-scheme-draft": remove(true),
  "jira.set-workflow-scheme-default": mapping("default", false, false),
  "jira.delete-workflow-scheme-default": mapping("default", false, true),
  "jira.set-workflow-scheme-draft-default": mapping("default", true, false),
  "jira.delete-workflow-scheme-draft-default": mapping("default", true, true),
  "jira.set-workflow-scheme-issue-type": mapping("issue-type", false, false),
  "jira.delete-workflow-scheme-issue-type": mapping("issue-type", false, true),
  "jira.set-workflow-scheme-draft-issue-type": mapping("issue-type", true, false),
  "jira.delete-workflow-scheme-draft-issue-type": mapping("issue-type", true, true),
  "jira.set-workflow-scheme-workflow": mapping("workflow", false, false),
  "jira.delete-workflow-scheme-workflow": mapping("workflow", false, true),
  "jira.set-workflow-scheme-draft-workflow": mapping("workflow", true, false),
  "jira.delete-workflow-scheme-draft-workflow": mapping("workflow", true, true),
} as const satisfies Readonly<Record<JiraWorkflowSchemeMutation, JiraNativeDefinition>>;
export function jiraWorkflowSchemeMutationDeclarationForTool(
  name: string,
): ManagedMcpToolDeclaration | undefined {
  const definitions: Readonly<Record<string, JiraNativeDefinition>> =
    JIRA_WORKFLOW_SCHEME_WRITE_DEFINITIONS;
  const definition = Object.hasOwn(definitions, name) ? definitions[name] : undefined;
  return definition === undefined ? undefined : jiraNativeDeclaration(name, definition);
}
