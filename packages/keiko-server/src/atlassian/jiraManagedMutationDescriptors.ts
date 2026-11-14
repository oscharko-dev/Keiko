import {
  jiraAnonymizationUnlockDeclarationForTool,
  type JIRA_ANONYMIZATION_UNLOCK_DEFINITIONS,
} from "./jiraAnonymizationUnlockDescriptors.js";
import {
  jiraAvatarMutationDeclarationForTool,
  type JIRA_AVATAR_WRITE_DEFINITIONS,
} from "./jiraAvatarMutationDescriptors.js";
import {
  jiraIdentityMutationDeclarationForTool,
  type JIRA_IDENTITY_WRITE_DEFINITIONS,
} from "./jiraIdentityMutationDescriptors.js";
import {
  jiraIssueLifecycleMutationDeclarationForTool,
  type JIRA_ISSUE_LIFECYCLE_WRITE_DEFINITIONS,
} from "./jiraIssueLifecycleMutationDescriptors.js";
import {
  jiraProjectLifecycleMutationDeclarationForTool,
  type JIRA_PROJECT_LIFECYCLE_WRITE_DEFINITIONS,
} from "./jiraProjectLifecycleMutationDescriptors.js";
import {
  jiraPrivateAccountDeclarationForTool,
  type JIRA_PRIVATE_ACCOUNT_WRITE_DEFINITIONS,
} from "./jiraPrivateAccountDescriptors.js";
import { jiraReciprocalLinkDeclarationForTool } from "./jiraReciprocalLinkDescriptors.js";
import { jiraBulkCreateDeclarationForTool } from "./jiraBulkCreateDescriptors.js";
import {
  jiraDirectoryAccessMutationDeclarationForTool,
  type JIRA_DIRECTORY_ACCESS_WRITE_DEFINITIONS,
} from "./jiraDirectoryAccessMutationDescriptors.js";
import {
  jiraMaintenanceMutationDeclarationForTool,
  type JIRA_MAINTENANCE_WRITE_DEFINITIONS,
} from "./jiraMaintenanceMutationDescriptors.js";
import {
  jiraSchemaMutationDeclarationForTool,
  type JIRA_SCHEMA_WRITE_DEFINITIONS,
} from "./jiraSchemaMutationDescriptors.js";
import {
  jiraGroupMutationDeclarationForTool,
  type JIRA_GROUP_WRITE_DEFINITIONS,
} from "./jiraGroupMutationDescriptors.js";
import {
  jiraIssueActionMutationDeclarationForTool,
  type JIRA_ISSUE_ACTION_WRITE_DEFINITIONS,
} from "./jiraIssueActionMutationDescriptors.js";
import {
  jiraOptionSchemeMutationDeclarationForTool,
  type JIRA_OPTION_SCHEME_WRITE_DEFINITIONS,
} from "./jiraOptionSchemeMutationDescriptors.js";
import {
  jiraWorkflowSchemeMutationDeclarationForTool,
  type JIRA_WORKFLOW_SCHEME_WRITE_DEFINITIONS,
} from "./jiraWorkflowSchemeMutationDescriptors.js";
import {
  jiraInstanceSettingMutationDeclarationForTool,
  type JIRA_INSTANCE_SETTING_WRITE_DEFINITIONS,
} from "./jiraInstanceSettingMutationDescriptors.js";
import {
  jiraEmailTemplateDeclarationForTool,
  type JIRA_EMAIL_TEMPLATE_DEFINITIONS,
} from "./jiraEmailTemplateDescriptors.js";
import {
  jiraPermissionSchemeMutationDeclarationForTool,
  type JIRA_PERMISSION_SCHEME_WRITE_DEFINITIONS,
} from "./jiraPermissionSchemeMutationDescriptors.js";
import {
  jiraRoleMutationDeclarationForTool,
  type JIRA_ROLE_WRITE_DEFINITIONS,
} from "./jiraRoleMutationDescriptors.js";
import {
  jiraVersionLinkMutationDeclarationForTool,
  type JIRA_VERSION_LINK_WRITE_DEFINITIONS,
} from "./jiraVersionLinkMutationDescriptors.js";
import {
  jiraProjectCategoryMutationDeclarationForTool,
  type JIRA_PROJECT_CATEGORY_WRITE_DEFINITIONS,
} from "./jiraProjectCategoryMutationDescriptors.js";
import {
  jiraAgilePlanningDeclarationForTool,
  type JIRA_AGILE_PLANNING_WRITE_DEFINITIONS,
} from "./jiraAgilePlanningDescriptors.js";
import {
  jiraSprintLifecycleDeclarationForTool,
  type JIRA_SPRINT_LIFECYCLE_WRITE_DEFINITIONS,
} from "./jiraSprintLifecycleDescriptors.js";
import {
  jiraScreenConfigurationDeclarationForTool,
  type JIRA_SCREEN_CONFIGURATION_WRITE_DEFINITIONS,
} from "./jiraScreenConfigurationDescriptors.js";
import {
  jiraBoardConfigurationMutationDeclarationForTool,
  type JIRA_BOARD_CONFIGURATION_WRITE_DEFINITIONS,
} from "./jiraBoardConfigurationMutationDescriptors.js";
import {
  jiraReleaseLifecycleDeclarationForTool,
  type JIRA_RELEASE_LIFECYCLE_WRITE_DEFINITIONS,
} from "./jiraReleaseLifecycleDescriptors.js";
import {
  jiraLinkMutationDeclarationForTool,
  type JIRA_LINK_WRITE_DEFINITIONS,
} from "./jiraLinkMutationDescriptors.js";
import {
  jiraSavedConfigurationMutationDeclarationForTool,
  type JIRA_SAVED_CONFIGURATION_WRITE_DEFINITIONS,
} from "./jiraSavedConfigurationMutationDescriptors.js";
import {
  jiraEntityPropertyMutationDeclarationForTool,
  type JIRA_ENTITY_PROPERTY_WRITE_DEFINITIONS,
} from "./jiraEntityPropertyMutationDescriptors.js";
import {
  jiraMonitoringDeclarationForTool,
  type JIRA_MONITORING_WRITE_DEFINITIONS,
} from "./jiraMonitoringDescriptors.js";
import {
  jiraScreenTabDeclarationForTool,
  type JIRA_SCREEN_TAB_WRITE_DEFINITIONS,
} from "./jiraScreenTabDescriptors.js";
import {
  jiraParticipationDeclarationForTool,
  type JIRA_PARTICIPATION_WRITE_DEFINITIONS,
} from "./jiraParticipationDescriptors.js";
import {
  jiraDeletionDeclarationForTool,
  type JIRA_DELETION_DEFINITIONS,
} from "./jiraDeletionDescriptors.js";
import {
  ATLASSIAN_CONNECTOR_WRITE_FAILURE_REASONS,
  JIRA_ATTACHMENT_NAME_MAX_BYTES,
  JIRA_ATTACHMENT_SOURCE_KINDS,
  JIRA_DRAFT_DIGEST_PATTERN,
  JIRA_DRAFT_ITEM_STATES,
  JIRA_DRAFT_PAGE_ITEMS_MAX,
  JIRA_DRAFT_PROBLEMS,
  JIRA_DRAFT_REFUSALS,
  JIRA_DRAFT_RESULT_ROWS_MAX,
  JIRA_FIELD_VALIDATION_FAILURES,
  JIRA_RESULT_GUIDANCE_MAX_CHARS,
  JIRA_MUTATION_DETAIL_LIMITS,
  JIRA_MUTATION_OPERATIONS,
  JIRA_REQUIREMENT_REFERENCE_CHARS_MAX,
  JIRA_MUTATION_RESULT_STATES,
  JIRA_TEMPLATE_RULE_IDS,
  JIRA_TEMPLATE_VIOLATIONS_MAX,
  jiraTemplateGovernanceOf,
  type JiraMutationOperation,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { ATLASSIAN_ACTION_APPROVAL_TTL_MS } from "./actionApprovalLimits.js";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolDeclaration } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import {
  compileExternalCatalogSchema,
  createToolDescriptor,
  createToolRef,
} from "@oscharko-dev/keiko-tool-catalog";
import { identifier, moduleKey, object, text } from "./jiraManagedSchemas.js";
import {
  JIRA_ISSUE_LINKS_MAX,
  JIRA_METADATA_MAX_UPDATES,
  JIRA_REQUIREMENT_IDS_MAX,
  JIRA_PROJECT_LEAD_MAX_CHARS,
  JIRA_PROJECT_URL_MAX_CHARS,
} from "@oscharko-dev/keiko-connectors";
import { KEY_RANGE_ENTRY_CHARS } from "./jiraDraftKeyRanges.js";
import { jiraMutationToolId } from "./jiraMutationToolId.js";
import {
  jiraAgileDeclarationForTool,
  type JIRA_AGILE_WRITE_DEFINITIONS,
} from "./jiraAgileDescriptors.js";
import {
  jiraIssueCollaborationDeclarationForTool,
  type JIRA_ISSUE_COLLABORATION_WRITE_DEFINITIONS,
} from "./jiraIssueCollaborationDescriptors.js";
import {
  jiraProjectStructureDeclarationForTool,
  type JIRA_PROJECT_STRUCTURE_WRITE_DEFINITIONS,
} from "./jiraProjectStructureDescriptors.js";

/** Conjunction preserves the native lowercase UUID grammar within the safe schema dialect. */
export const JIRA_DRAFT_ID_SCHEMA = { ...text(36), format: "uuid", pattern: "^[0-9a-f-]{36}$" };

const ISSUE_KEY = { ...text(128), minLength: 1 };
const REQUIREMENT_IDS = {
  type: "array",
  maxItems: JIRA_REQUIREMENT_IDS_MAX,
  items: text(JIRA_REQUIREMENT_REFERENCE_CHARS_MAX),
  description:
    "IDs of the Knowledge requirements this issue implements, as knowledge.requirements returns them. Required while the Chat holds requirements; Keiko adds their source trace and acceptance criteria.",
};
const TRACE_RESULT = object({
  labelsApplied: { type: "boolean" },
  footerApplied: { type: "boolean" },
  droppedLabels: { type: "array", maxItems: 16, items: text(255) },
});
export const REQUIREMENT_PROBLEMS = {
  type: "array",
  maxItems: 32,
  items: object(
    {
      ref: text(32),
      reference: text(JIRA_REQUIREMENT_REFERENCE_CHARS_MAX),
      reason: {
        type: "string",
        enum: ["malformed", "unknown", "ambiguous", "acceptance-criteria-missing"],
      },
      candidates: { type: "array", maxItems: 8, items: text(120) },
    },
    ["reference", "reason"],
  ),
};
export const REQUIREMENT_REFUSAL = {
  type: "string",
  enum: ["no-knowledge-pod", "unavailable", "references", "untraced", "source-changed"],
};
const NUMERIC_ID = { ...text(32), pattern: "^[0-9]{1,32}$" };
export const PROJECT_ID = { ...NUMERIC_ID, description: "Numeric id from the project read." };
export const ISSUE_TYPE_ID = { ...NUMERIC_ID, description: "Numeric id from the issue-type read." };
const FIELDS = {
  ...object({}),
  additionalProperties: true,
  description: "Jira field IDs and typed values; follow shared Jira field guidance.",
};
const UPDATES = {
  type: "array",
  maxItems: JIRA_METADATA_MAX_UPDATES,
  items: object(
    {
      fieldId: { type: "string", const: "labels" },
      operation: { type: "string", enum: ["add", "remove"] },
      value: { ...text(255), minLength: 1 },
    },
    ["fieldId", "operation", "value"],
  ),
};
const LINKS = {
  type: "array",
  maxItems: JIRA_ISSUE_LINKS_MAX,
  description:
    'Links to add by Jira link type name (for example "Relates"). outward: this issue → issueKey; inward: issueKey → this issue. Existing links are kept. Each link after the first is a separate call: succeeded-unconfirmed with linksMissing means the issue exists, so add only the missing links with jira.edit and never create it again.',
  items: object(
    {
      type: { ...text(255), minLength: 1 },
      direction: { type: "string", enum: ["inward", "outward"] },
      issueKey: ISSUE_KEY,
    },
    ["type", "direction", "issueKey"],
  ),
};
const ATTACHMENT_SOURCE = {
  ...object(
    {
      kind: { type: "string", enum: JIRA_ATTACHMENT_SOURCE_KINDS },
      path: { ...text(4096), minLength: 1 },
    },
    ["kind", "path"],
  ),
};
// Equivalent to the handler patterns within their existing length bounds. Separate linear
// constraints retain the standard dialect's conservative regex admission without exceptions.
const DRAFT_REF = {
  ...text(32),
  allOf: [{ pattern: "^[A-Za-z]" }, { pattern: "^[A-Za-z0-9_-]{1,32}$" }],
};
const DRAFT_RELATION_FIELD = {
  ...text(64),
  anyOf: [
    { allOf: [{ pattern: "^[a-zA-Z]" }, { pattern: "^[a-zA-Z0-9]+$" }] },
    { pattern: String.raw`^customfield_\d{1,16}$` },
  ],
};
const DRAFT_LINKS = {
  type: "array",
  maxItems: JIRA_ISSUE_LINKS_MAX,
  description:
    "Links to add once both issues exist: the other end is a draft item (ref) or an existing issue (issueKey); outward: this item → the other.",
  items: object(
    {
      type: { ...text(255), minLength: 1 },
      direction: { type: "string", enum: ["inward", "outward"] },
      ref: DRAFT_REF,
      issueKey: ISSUE_KEY,
    },
    ["type", "direction"],
  ),
};
/** Nests a drafted item under another item of the draft (`ref`) or an existing issue (`issueKey`). */
export const JIRA_DRAFT_PARENT_SCHEMA = {
  ...object(
    {
      fieldId: DRAFT_RELATION_FIELD,
      ref: DRAFT_REF,
      issueKey: ISSUE_KEY,
    },
    ["fieldId"],
  ),
  description:
    "Nests this item. fieldId is the relation field the child's create metadata names (parent for a sub-task, the Epic Link field for an epic's issue); the target is exactly one of ref (an item of this draft, created first) or issueKey (an existing issue).",
};
export const JIRA_DRAFT_ITEM_SCHEMA = object(
  {
    ref: DRAFT_REF,
    projectId: PROJECT_ID,
    issueTypeId: ISSUE_TYPE_ID,
    fields: {
      ...FIELDS,
      properties: { summary: { type: "string", minLength: 1 } },
      required: ["summary"],
      description:
        "Create fields as for jira.create; summary is required. Omit the field the parent relation writes.",
    },
    parent: JIRA_DRAFT_PARENT_SCHEMA,
    links: DRAFT_LINKS,
    requirementIds: REQUIREMENT_IDS,
  },
  ["ref", "projectId", "issueTypeId", "fields"],
);
/** Jira's own bounded explanation of a refusal; reads and mutations share it. */
export const JIRA_FAILURE_FIELD_ERRORS_SCHEMA = {
  type: "array",
  maxItems: JIRA_MUTATION_DETAIL_LIMITS.fieldErrors,
  items: object(
    {
      fieldId: text(64),
      fieldName: text(JIRA_MUTATION_DETAIL_LIMITS.messageChars),
      message: text(JIRA_MUTATION_DETAIL_LIMITS.messageChars),
    },
    ["fieldId", "message"],
  ),
};
export const JIRA_FAILURE_MESSAGES_SCHEMA = {
  type: "array",
  maxItems: JIRA_MUTATION_DETAIL_LIMITS.messages,
  items: text(JIRA_MUTATION_DETAIL_LIMITS.messageChars),
};
const LINK_COUNT = { type: "integer", minimum: 0, maximum: JIRA_ISSUE_LINKS_MAX };
/**
 * What happened to the requested links (#4176): Jira takes one `issuelinks` operation per request,
 * so further links are separate calls and can fail alone. `linksMissing` names the requested links
 * not on the issue; `linksUnconfirmed` says the issue could not be read back to be sure.
 */
const LINK_RESULT = {
  linksRequested: LINK_COUNT,
  linksCreated: LINK_COUNT,
  linksMissing: {
    type: "array",
    maxItems: JIRA_ISSUE_LINKS_MAX,
    items: object(
      {
        type: text(255),
        direction: { type: "string", enum: ["inward", "outward"] },
        issueKey: text(128),
      },
      ["type", "direction", "issueKey"],
    ),
  },
  linksUnconfirmed: { type: "boolean" },
};
// A result bound is the worst case of what the producer can emit, in encoded bytes, never the
// ASCII one. A refusal carries up to eight field errors (id, display name, message) and three
// messages, each string bounded to JIRA_MUTATION_DETAIL_LIMITS.messageBytes of its JSON encoding by
// the sanitizer, beside the usual result (outcome, reason, guidance and receipt identities). A
// create, edit or transition can also carry the issue-template violations of the gate: a subject of
// up to 120 and a template of up to 256 UTF-16 units, where a lone surrogate is escaped to 6 JSON
// bytes, CJK text takes 3 and an emoji 4. The partial-effect result of a create or edit lists every
// requested link as missing after the issue was already created: a link type name of up to 255
// units, an issue key of up to 128 characters and the JSON around them, for each of the most links
// a request may carry. A result the catalog rejects would lose the receipt and the correction
// details exactly then.
const JSON_BYTES_PER_UNIT_MAX = 6;
const JSON_STRING_QUOTES = 2;
const JSON_OBJECT_OVERHEAD = 64;
const DETAIL_STRING_BYTES_MAX = JIRA_MUTATION_DETAIL_LIMITS.messageBytes + JSON_STRING_QUOTES;
const FIELD_ERROR_BYTES_MAX =
  64 + JSON_STRING_QUOTES + 2 * DETAIL_STRING_BYTES_MAX + JSON_OBJECT_OVERHEAD;
const DETAIL_BYTES_MAX =
  JIRA_MUTATION_DETAIL_LIMITS.fieldErrors * FIELD_ERROR_BYTES_MAX +
  JIRA_MUTATION_DETAIL_LIMITS.messages * (DETAIL_STRING_BYTES_MAX + 1) +
  JSON_OBJECT_OVERHEAD;
const VIOLATION_BYTES_MAX =
  (Math.max(...JIRA_TEMPLATE_RULE_IDS.map((id) => id.length)) + 120 + 256) *
    JSON_BYTES_PER_UNIT_MAX +
  JSON_OBJECT_OVERHEAD;
const LINK_TYPE_UNITS_MAX = 255;
const LINK_REF_BYTES_MAX = LINK_TYPE_UNITS_MAX * JSON_BYTES_PER_UNIT_MAX + 128 + 64;
// The usual result without its guidance (3584) plus the most guidance the schema allows.
const USUAL_RESULT_BYTES_MAX = 3584 + JIRA_RESULT_GUIDANCE_MAX_CHARS;
const SINGLE_RESULT_BYTES_MAX = USUAL_RESULT_BYTES_MAX + DETAIL_BYTES_MAX;
export const GATED_RESULT_BYTES_MAX =
  SINGLE_RESULT_BYTES_MAX + JIRA_TEMPLATE_VIOLATIONS_MAX * VIOLATION_BYTES_MAX;
// A write waits in place for the human's decision, so its settlement budget declares that wait on
// top of its own work (ADR-0175). Charging the decision to the work budget ended every card after
// 90 seconds, however much time the approval itself still had.
const WRITE_DURATION_MS_MAX = 90000 + ATLASSIAN_ACTION_APPROVAL_TTL_MS;
const GATED_RESULT_BOUNDS = {
  maxResultBytes: GATED_RESULT_BYTES_MAX,
  maxDurationMs: WRITE_DURATION_MS_MAX,
  maxResultCount: 1,
};
const LINKED_RESULT_BOUNDS = {
  ...GATED_RESULT_BOUNDS,
  maxResultBytes: GATED_RESULT_BYTES_MAX + JIRA_ISSUE_LINKS_MAX * LINK_REF_BYTES_MAX,
};

export const JIRA_VIOLATIONS_SCHEMA = {
  type: "array",
  maxItems: JIRA_TEMPLATE_VIOLATIONS_MAX,
  items: object(
    {
      ruleId: { type: "string", enum: JIRA_TEMPLATE_RULE_IDS },
      subject: text(120),
      template: text(256),
    },
    ["ruleId", "subject", "template"],
  ),
};
const DRAFT_COUNT = { type: "integer", minimum: 0 };
// Exact key ranges such as `PROJ-3..PROJ-40`, packed comma-separated several to an entry: what a
// large draft created or found, in a few bytes, however scattered the keys.
const KEY_RANGES = {
  type: "array",
  maxItems: JIRA_DRAFT_RESULT_ROWS_MAX,
  items: text(KEY_RANGE_ENTRY_CHARS),
};
const DRAFT_RESULT_SCHEMA = object(
  {
    outcome: { type: "string", enum: JIRA_MUTATION_RESULT_STATES },
    reason: { type: "string", enum: ATLASSIAN_CONNECTOR_WRITE_FAILURE_REASONS },
    guidance: text(JIRA_RESULT_GUIDANCE_MAX_CHARS),
    items: {
      type: "array",
      maxItems: JIRA_DRAFT_RESULT_ROWS_MAX,
      items: object(
        {
          ref: text(32),
          state: { type: "string", enum: JIRA_DRAFT_ITEM_STATES },
          issueKey: text(128),
          browseUrl: text(4096),
          reason: { type: "string", enum: ATLASSIAN_CONNECTOR_WRITE_FAILURE_REASONS },
          fieldId: text(64),
          validation: { type: "string", enum: JIRA_FIELD_VALIDATION_FAILURES },
          fieldErrors: JIRA_FAILURE_FIELD_ERRORS_SCHEMA,
          messages: JIRA_FAILURE_MESSAGES_SCHEMA,
          unchanged: { type: "boolean" },
          ...LINK_RESULT,
          violations: JIRA_VIOLATIONS_SCHEMA,
          replayed: { type: "boolean" },
          trace: TRACE_RESULT,
          // A skipped item: the refs of the items it waits for that were not created.
          blockedBy: {
            type: "array",
            // The item's parent and its links.
            maxItems: JIRA_ISSUE_LINKS_MAX + 1,
            items: text(32),
          },
        },
        ["ref", "state"],
      ),
    },
    requirementRefusal: REQUIREMENT_REFUSAL,
    requirementProblems: REQUIREMENT_PROBLEMS,
    draftRefusal: { type: "string", enum: JIRA_DRAFT_REFUSALS },
    draftProblem: { type: "string", enum: JIRA_DRAFT_PROBLEMS },
    draftItem: { type: "integer", minimum: 1 },
    createdCount: DRAFT_COUNT,
    existingCount: DRAFT_COUNT,
    failedCount: DRAFT_COUNT,
    uncertainCount: DRAFT_COUNT,
    skippedCount: DRAFT_COUNT,
    excludedCount: DRAFT_COUNT,
    pendingCount: DRAFT_COUNT,
    // A large result lists only the items that need attention; what was created or found is
    // reported as exact key ranges, and what did not fit as a count.
    compact: { type: "boolean" },
    omittedRowCount: DRAFT_COUNT,
    // The Jira browse prefix the listed keys open under (prefix plus key).
    browseUrlPrefix: text(4096),
    createdRanges: KEY_RANGES,
    existingRanges: KEY_RANGES,
    rangesTruncated: { type: "boolean" },
    // Created or found keys the lists could not carry; present only with rangesTruncated.
    unlistedKeyCount: DRAFT_COUNT,
  },
  ["outcome"],
);
const RESULT_FIELDS = {
  unchanged: { type: "boolean" },
  outcome: { type: "string", enum: JIRA_MUTATION_RESULT_STATES },
  reason: { type: "string", enum: ATLASSIAN_CONNECTOR_WRITE_FAILURE_REASONS },
  replayed: { type: "boolean" },
  guidance: text(JIRA_RESULT_GUIDANCE_MAX_CHARS),
  browseUrl: text(4096),
  issueKey: text(128),
  issueId: text(128),
  commentId: text(128),
  transitionId: text(128),
  attachmentId: text(128),
  projectId: text(64),
  projectKey: text(64),
  projectName: text(255),
  fieldId: text(64),
  validation: { type: "string", enum: JIRA_FIELD_VALIDATION_FAILURES },
  fieldErrors: JIRA_FAILURE_FIELD_ERRORS_SCHEMA,
  messages: JIRA_FAILURE_MESSAGES_SCHEMA,
  ...LINK_RESULT,
  violations: JIRA_VIOLATIONS_SCHEMA,
  // Only a success carries notices and only a refusal carries violations, so the one bound holds.
  templateNotices: JIRA_VIOLATIONS_SCHEMA,
};
const RESULT_SCHEMA = object(RESULT_FIELDS, ["outcome"]);
/** Only a create or an edit can carry requirement references, so only they declare their result. */
const TRACED_RESULT_SCHEMA = object(
  {
    ...RESULT_FIELDS,
    trace: TRACE_RESULT,
    requirementRefusal: REQUIREMENT_REFUSAL,
    requirementProblems: REQUIREMENT_PROBLEMS,
  },
  ["outcome"],
);
type CoreMutationToolName = Exclude<
  JiraMutationOperation,
  Extract<
    JiraMutationOperation,
    | keyof typeof JIRA_ANONYMIZATION_UNLOCK_DEFINITIONS
    | keyof typeof JIRA_AVATAR_WRITE_DEFINITIONS
    | keyof typeof JIRA_IDENTITY_WRITE_DEFINITIONS
    | keyof typeof JIRA_ISSUE_LIFECYCLE_WRITE_DEFINITIONS
    | keyof typeof JIRA_PROJECT_LIFECYCLE_WRITE_DEFINITIONS
    | keyof typeof JIRA_PRIVATE_ACCOUNT_WRITE_DEFINITIONS
    | "jira.create-issues"
    | "jira.create-reciprocal-remote-link"
    | keyof typeof JIRA_DIRECTORY_ACCESS_WRITE_DEFINITIONS
    | keyof typeof JIRA_MAINTENANCE_WRITE_DEFINITIONS
    | keyof typeof JIRA_SCHEMA_WRITE_DEFINITIONS
    | keyof typeof JIRA_GROUP_WRITE_DEFINITIONS
    | keyof typeof JIRA_ISSUE_ACTION_WRITE_DEFINITIONS
    | keyof typeof JIRA_OPTION_SCHEME_WRITE_DEFINITIONS
    | keyof typeof JIRA_WORKFLOW_SCHEME_WRITE_DEFINITIONS
    | keyof typeof JIRA_INSTANCE_SETTING_WRITE_DEFINITIONS
    | keyof typeof JIRA_EMAIL_TEMPLATE_DEFINITIONS
    | keyof typeof JIRA_PERMISSION_SCHEME_WRITE_DEFINITIONS
    | keyof typeof JIRA_ROLE_WRITE_DEFINITIONS
    | keyof typeof JIRA_SPRINT_LIFECYCLE_WRITE_DEFINITIONS
    | keyof typeof JIRA_VERSION_LINK_WRITE_DEFINITIONS
    | keyof typeof JIRA_PROJECT_CATEGORY_WRITE_DEFINITIONS
    | keyof typeof JIRA_AGILE_PLANNING_WRITE_DEFINITIONS
    | keyof typeof JIRA_SCREEN_CONFIGURATION_WRITE_DEFINITIONS
    | keyof typeof JIRA_BOARD_CONFIGURATION_WRITE_DEFINITIONS
    | keyof typeof JIRA_RELEASE_LIFECYCLE_WRITE_DEFINITIONS
    | keyof typeof JIRA_LINK_WRITE_DEFINITIONS
    | keyof typeof JIRA_SAVED_CONFIGURATION_WRITE_DEFINITIONS
    | keyof typeof JIRA_AGILE_WRITE_DEFINITIONS
    | keyof typeof JIRA_PROJECT_STRUCTURE_WRITE_DEFINITIONS
    | keyof typeof JIRA_ISSUE_COLLABORATION_WRITE_DEFINITIONS
    | keyof typeof JIRA_PARTICIPATION_WRITE_DEFINITIONS
    | keyof typeof JIRA_DELETION_DEFINITIONS
    | keyof typeof JIRA_SCREEN_TAB_WRITE_DEFINITIONS
    | keyof typeof JIRA_MONITORING_WRITE_DEFINITIONS
    | keyof typeof JIRA_ENTITY_PROPERTY_WRITE_DEFINITIONS
  >
>;
const DEFINITIONS: Readonly<
  Record<
    CoreMutationToolName,
    {
      readonly description: string;
      readonly input: CatalogJsonObject;
      readonly result?: CatalogJsonObject;
      readonly bounds?: {
        readonly maxResultBytes: number;
        readonly maxDurationMs: number;
        readonly maxResultCount: number;
      };
    }
  >
> = {
  "jira.create-project": {
    description:
      "Create a Jira project using native supported options. Validate its key and accessible project type first; Jira administration permission is required. Return independently verified project identity. A partial or uncertain creation must never be repeated automatically.",
    input: object(
      {
        key: identifier(64),
        name: identifier(255),
        lead: {
          ...identifier(JIRA_PROJECT_LEAD_MAX_CHARS),
          description:
            "Jira user name of the project lead. Omit it to make the connected Jira user the lead.",
        },
        projectTypeKey: identifier(64),
        projectTemplateKey: moduleKey(255),
        description: text(32768),
        url: text(JIRA_PROJECT_URL_MAX_CHARS),
        assigneeType: { type: "string", enum: ["PROJECT_LEAD", "UNASSIGNED"] },
      },
      ["key", "name", "projectTypeKey"],
    ),
  },
  "jira.update-project": {
    description:
      "Update ordinary Jira project metadata and independently read back the requested fields. Supply at least one change. Project key, project type and scheme changes are not supported by this operation.",
    input: object(
      {
        projectIdOrKey: identifier(64),
        name: identifier(255),
        lead: identifier(JIRA_PROJECT_LEAD_MAX_CHARS),
        description: text(32768),
        url: text(JIRA_PROJECT_URL_MAX_CHARS),
        assigneeType: { type: "string", enum: ["PROJECT_LEAD", "UNASSIGNED"] },
      },
      ["projectIdOrKey"],
    ),
  },
  "jira.create": {
    description:
      "Create one issue (for more, use jira.draft) with numeric project and issue-type IDs and current required fields. Fields cannot override routing identities. A child of an existing issue sets the relation field its create metadata names to that key; a parent that does not exist yet needs jira.draft.",
    input: object(
      {
        projectId: NUMERIC_ID,
        issueTypeId: NUMERIC_ID,
        fields: FIELDS,
        links: LINKS,
        requirementIds: REQUIREMENT_IDS,
      },
      ["projectId", "issueTypeId", "fields"],
    ),
    result: TRACED_RESULT_SCHEMA,
    bounds: LINKED_RESULT_BOUNDS,
  },
  "jira.edit": {
    description:
      "Edit selected issue fields using current edit metadata. Supply at least one replacement, supported label update or link; project and issue type cannot be changed.",
    input: object(
      {
        issueKey: ISSUE_KEY,
        fields: FIELDS,
        updates: UPDATES,
        links: LINKS,
        requirementIds: REQUIREMENT_IDS,
      },
      ["issueKey"],
    ),
    result: TRACED_RESULT_SCHEMA,
    bounds: LINKED_RESULT_BOUNDS,
  },
  "jira.assign": {
    description:
      "Assign one current active assignable username or clear the assignee. Supply exactly one of assigneeName or clearAssignee: true; omission does not clear.",
    input: object(
      {
        issueKey: ISSUE_KEY,
        assigneeName: { ...text(256), minLength: 1 },
        clearAssignee: { type: "boolean", const: true },
      },
      ["issueKey"],
    ),
    // The template gate also checks an assignment, so its refusal can carry the violations.
    bounds: GATED_RESULT_BOUNDS,
  },
  "jira.comment": {
    description: "Add one plain-text comment to an issue.",
    input: object({ issueKey: ISSUE_KEY, body: { ...text(32768), minLength: 1 } }, [
      "issueKey",
      "body",
    ]),
  },
  "jira.transition": {
    description:
      "Apply one currently available transition and its required screen fields together. Metadata is revalidated before dispatch.",
    input: object(
      { issueKey: ISSUE_KEY, transitionId: NUMERIC_ID, fields: FIELDS, updates: UPDATES },
      ["issueKey", "transitionId"],
    ),
    bounds: GATED_RESULT_BOUNDS,
  },
  "jira.attach": {
    description:
      "Attach a file from a connected folder. Credentials, archives, databases and executables are refused.",
    input: object(
      {
        issueKey: ISSUE_KEY,
        source: ATTACHMENT_SOURCE,
        name: {
          ...text(JIRA_ATTACHMENT_NAME_MAX_BYTES),
          minLength: 1,
        },
      },
      ["issueKey", "source"],
    ),
  },
  "jira.draft": {
    description:
      "Create related issues in Jira (epics, stories, tasks, bugs, sub-tasks) from an inline backlog or a saved Keiko draft; this tool performs Jira writes under the current write authority and required human approval. Items name each other by ref and are created in dependency order; an item whose parent or linked item was not created is skipped (blockedBy), and an existing issue is reconciled, not created again. Use it whenever more than one issue is to be created, a parent and children to any depth. Send up to " +
      String(JIRA_DRAFT_PAGE_ITEMS_MAX) +
      " items inline. For a saved draft, pass only its draftId and draftDigest from jira.draft-stage. jira.draft-stage saves drafts of any supported size in Keiko without Jira writes. Never split one backlog into several approvals. Items left pending continue with the same draftId and draftDigest, nothing created twice.",
    // The existing explicit JSON Schema dialect expresses the handler's two closed forms;
    // optional sibling properties would also advertise empty, partial and mixed arguments.
    input: {
      type: "object",
      oneOf: [
        object(
          {
            items: {
              type: "array",
              minItems: 1,
              maxItems: JIRA_DRAFT_PAGE_ITEMS_MAX,
              items: JIRA_DRAFT_ITEM_SCHEMA,
            },
          },
          ["items"],
        ),
        object(
          {
            draftId: JIRA_DRAFT_ID_SCHEMA,
            draftDigest: { ...text(64), pattern: JIRA_DRAFT_DIGEST_PATTERN },
          },
          ["draftId", "draftDigest"],
        ),
      ],
    },
    result: DRAFT_RESULT_SCHEMA,
    // Up to one result row per item, within the catalog's result ceilings; a larger result is
    // reported by counts and key ranges, never cut (#4178).
    bounds: {
      maxResultBytes: 262144,
      maxDurationMs: 3000000,
      maxResultCount: JIRA_DRAFT_RESULT_ROWS_MAX,
    },
  },
};
export function isCoreMutationTool(name: JiraMutationOperation): name is CoreMutationToolName {
  return Object.hasOwn(DEFINITIONS, name);
}
/**
 * Every write the template gate can refuse (a governed class of the inventory) answers a refusal with
 * the violations it names, so its result schema declares them and its byte bound holds the most the
 * gate can write. The family builders each declare their own result; this is the one place that makes
 * a refusal by a template a valid result for every governed tool, never a contract failure that hides
 * the reason from the model (#4354). The draft run carries its violations per item in a result of its own.
 */
const OWN_RESULT_PRODUCERS: ReadonlySet<JiraMutationOperation> = new Set(["jira.draft"]);
export function jiraGovernedResultDeclaration(
  name: JiraMutationOperation,
  declaration: ManagedMcpToolDeclaration,
): ManagedMcpToolDeclaration {
  const governed = jiraTemplateGovernanceOf(name);
  if (governed === undefined || governed.class === "not-governed" || OWN_RESULT_PRODUCERS.has(name))
    return declaration;
  const { descriptorDigest: _digest, ...declared } = declaration.descriptor;
  const schema = declared.resultSchema as {
    readonly properties?: Readonly<Record<string, unknown>>;
  };
  const declares = schema.properties !== undefined && "violations" in schema.properties;
  const maxResultBytes = Math.max(declared.bounds.maxResultBytes, GATED_RESULT_BYTES_MAX);
  if (declares && maxResultBytes === declared.bounds.maxResultBytes) return declaration;
  return Object.freeze({
    ...declaration,
    descriptor: createToolDescriptor({
      ...declared,
      resultSchema: {
        ...schema,
        properties: { ...schema.properties, violations: JIRA_VIOLATIONS_SCHEMA },
      },
      bounds: { ...declared.bounds, maxResultBytes },
    }),
  });
}
export function jiraMutationDeclaration(name: JiraMutationOperation): ManagedMcpToolDeclaration {
  return jiraGovernedResultDeclaration(name, composedMutationDeclaration(name));
}
function composedMutationDeclaration(name: JiraMutationOperation): ManagedMcpToolDeclaration {
  for (const producer of [
    jiraAnonymizationUnlockDeclarationForTool,
    jiraAvatarMutationDeclarationForTool,
    jiraIdentityMutationDeclarationForTool,
    jiraIssueLifecycleMutationDeclarationForTool,
    jiraProjectLifecycleMutationDeclarationForTool,
    jiraPrivateAccountDeclarationForTool,
    jiraReciprocalLinkDeclarationForTool,
    jiraBulkCreateDeclarationForTool,
    jiraDirectoryAccessMutationDeclarationForTool,
    jiraMaintenanceMutationDeclarationForTool,
    jiraSchemaMutationDeclarationForTool,
    jiraGroupMutationDeclarationForTool,
    jiraIssueActionMutationDeclarationForTool,
    jiraOptionSchemeMutationDeclarationForTool,
    jiraWorkflowSchemeMutationDeclarationForTool,
    jiraInstanceSettingMutationDeclarationForTool,
    jiraEmailTemplateDeclarationForTool,
    jiraPermissionSchemeMutationDeclarationForTool,
    jiraRoleMutationDeclarationForTool,
    jiraVersionLinkMutationDeclarationForTool,
    jiraProjectCategoryMutationDeclarationForTool,
    jiraAgilePlanningDeclarationForTool,
    jiraSprintLifecycleDeclarationForTool,
    jiraScreenConfigurationDeclarationForTool,
    jiraBoardConfigurationMutationDeclarationForTool,
    jiraReleaseLifecycleDeclarationForTool,
    jiraLinkMutationDeclarationForTool,
    jiraSavedConfigurationMutationDeclarationForTool,
    jiraEntityPropertyMutationDeclarationForTool,
    jiraMonitoringDeclarationForTool,
    jiraScreenTabDeclarationForTool,
    jiraAgileDeclarationForTool,
    jiraProjectStructureDeclarationForTool,
    jiraParticipationDeclarationForTool,
    jiraDeletionDeclarationForTool,
    jiraIssueCollaborationDeclarationForTool,
  ]) {
    const selected = producer(name);
    if (selected !== undefined) return selected;
  }
  if (!isCoreMutationTool(name)) throw new TypeError("Unsupported Jira mutation tool");
  return coreDeclaration(name);
}
function coreDeclaration(name: CoreMutationToolName): ManagedMcpToolDeclaration {
  const definition = DEFINITIONS[name];
  return Object.freeze({
    name,
    risk: "write",
    descriptor: createToolDescriptor({
      toolRef: createToolRef(jiraMutationToolId(name), 3),
      description: definition.description,
      inputSchema:
        name === "jira.draft" ? compileExternalCatalogSchema(definition.input) : definition.input,
      resultSchema: definition.result ?? RESULT_SCHEMA,
      effects: ["connector-access"],
      actionMapping: [{ action: name, effects: ["connector-access"] }],
      policyReferences: ["adr-0128.d4"],
      handlerRequirement: { id: name, contractVersion: 1 },
      bounds: {
        maxArgumentBytes: 262144,
        maxResultBytes: definition.bounds?.maxResultBytes ?? SINGLE_RESULT_BYTES_MAX,
        maxResultCount: definition.bounds?.maxResultCount ?? 1,
        maxDurationMs: definition.bounds?.maxDurationMs ?? WRITE_DURATION_MS_MAX,
      },
      idempotency: "server-key-required",
      cancellation: "before-effect",
    }),
  });
}
/** Explicit complete mutation inventory; module import itself compiles no declarations. */
export function jiraMutationDeclarations(): readonly ManagedMcpToolDeclaration[] {
  return Object.freeze(JIRA_MUTATION_OPERATIONS.map(jiraMutationDeclaration));
}
