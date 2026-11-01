import {
  ATLASSIAN_CONNECTOR_WRITE_FAILURE_REASONS,
  JIRA_ATTACHMENT_NAME_MAX_BYTES,
  JIRA_ATTACHMENT_SOURCE_KINDS,
  JIRA_DRAFT_DIGEST_PATTERN,
  JIRA_DRAFT_ID_PATTERN,
  JIRA_DRAFT_ITEM_STATES,
  JIRA_DRAFT_PAGE_ITEMS_MAX,
  JIRA_DRAFT_REF_PATTERN,
  JIRA_DRAFT_REFUSALS,
  JIRA_DRAFT_RESULT_ROWS_MAX,
  JIRA_FIELD_ID_PATTERN,
  JIRA_FIELD_VALIDATION_FAILURES,
  JIRA_MUTATION_DETAIL_LIMITS,
  JIRA_MUTATION_OPERATIONS,
  JIRA_MUTATION_RESULT_STATES,
  JIRA_TEMPLATE_RULE_IDS,
  JIRA_TEMPLATE_VIOLATIONS_MAX,
  type JiraMutationOperation,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolDeclaration } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { createToolDescriptor, createToolRef } from "@oscharko-dev/keiko-tool-catalog";
import { object, text } from "./jiraManagedSchemas.js";
import {
  JIRA_ISSUE_LINKS_MAX,
  JIRA_METADATA_MAX_UPDATES,
  JIRA_REQUIREMENT_IDS_MAX,
} from "@oscharko-dev/keiko-connectors";
import { jiraMutationToolId } from "./jiraMutationToolId.js";

const ISSUE_KEY = { ...text(128), minLength: 1 };
const REQUIREMENT_IDS = { type: "array", maxItems: JIRA_REQUIREMENT_IDS_MAX, items: text(80) };
const TRACE_RESULT = object({
  labelsApplied: { type: "boolean" },
  footerApplied: { type: "boolean" },
  droppedLabels: { type: "array", maxItems: 16, items: text(255) },
});
const REQUIREMENT_PROBLEMS = {
  type: "array",
  maxItems: 32,
  items: object(
    {
      ref: text(32),
      reference: text(80),
      reason: { type: "string", enum: ["malformed", "unknown", "ambiguous"] },
      candidates: { type: "array", maxItems: 8, items: text(120) },
    },
    ["reference", "reason"],
  ),
};
const REQUIREMENT_REFUSAL = {
  type: "string",
  enum: ["no-knowledge-pod", "unavailable", "references"],
};
const NUMERIC_ID = { ...text(32), pattern: "^[0-9]{1,32}$" };
const PROJECT_ID = { ...NUMERIC_ID, description: "Numeric id from the project read." };
const ISSUE_TYPE_ID = { ...NUMERIC_ID, description: "Numeric id from the issue-type read." };
const FIELDS = {
  ...object({}),
  additionalProperties: true,
  description:
    "Field IDs and values validated against current Jira metadata; omitted fields stay unchanged, null clears only when permitted. An issue field takes an issue key, a user its user name, a choice its id or exact value, an opaque field a plain JSON value shaped by its schemaType. A refused write returns the field and Jira's error.",
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
    'Links to add by Jira link type name (for example "Relates"). outward: this issue → issueKey; inward: issueKey → this issue. Needs the issuelinks field in current metadata; existing links are kept. Each link after the first is a separate call: succeeded-unconfirmed with linksMissing means the issue exists, so add only the missing links with jira.edit and never create it again.',
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
const DRAFT_REF = { ...text(32), pattern: JIRA_DRAFT_REF_PATTERN };
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
const JIRA_DRAFT_ITEM_SCHEMA = object(
  {
    ref: DRAFT_REF,
    projectId: PROJECT_ID,
    issueTypeId: ISSUE_TYPE_ID,
    fields: {
      ...FIELDS,
      description:
        "Create fields as for jira.create; summary is required. Omit the field the parent relation writes.",
    },
    parent: {
      ...object(
        {
          fieldId: { ...text(64), pattern: JIRA_FIELD_ID_PATTERN },
          ref: DRAFT_REF,
          issueKey: ISSUE_KEY,
        },
        ["fieldId"],
      ),
      description:
        "Nests this item. fieldId is the relation field the child's create metadata names (parent for a sub-task, the Epic Link field for an epic's issue); the target is exactly one of ref (an item of this draft, created first) or issueKey (an existing issue).",
    },
    links: DRAFT_LINKS,
    requirementIds: REQUIREMENT_IDS,
  },
  ["ref", "projectId", "issueTypeId", "fields"],
);
const FIELD_ERRORS = {
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
const MESSAGES = {
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
// The partial-effect result of a create or edit lists every requested link as missing, after the
// issue was already created: a result the catalog rejects would lose the receipt and the repair
// details exactly then. The bound is the worst case of what the producer can emit, in encoded
// bytes: a link type name of up to 255 UTF-16 units (a lone surrogate is escaped to 6 JSON bytes,
// CJK text takes 3 and an emoji 4), an issue key of up to 128 characters and the JSON around them,
// for each of the most links a request may carry, beside the usual result.
const LINK_TYPE_UNITS_MAX = 255;
const JSON_BYTES_PER_UNIT_MAX = 6;
const LINK_REF_BYTES_MAX = LINK_TYPE_UNITS_MAX * JSON_BYTES_PER_UNIT_MAX + 128 + 64;
const USUAL_RESULT_BYTES_MAX = 12288;
const LINKED_RESULT_BOUNDS = {
  maxResultBytes: USUAL_RESULT_BYTES_MAX + JIRA_ISSUE_LINKS_MAX * LINK_REF_BYTES_MAX,
  maxDurationMs: 90000,
  maxResultCount: 1,
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
// Exact key ranges such as `PROJ-3..PROJ-40`: what a large draft created or found, in a few bytes.
const KEY_RANGES = { type: "array", maxItems: JIRA_DRAFT_RESULT_ROWS_MAX, items: text(600) };
const DRAFT_RESULT_SCHEMA = object(
  {
    outcome: { type: "string", enum: JIRA_MUTATION_RESULT_STATES },
    reason: { type: "string", enum: ATLASSIAN_CONNECTOR_WRITE_FAILURE_REASONS },
    guidance: text(512),
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
          fieldErrors: FIELD_ERRORS,
          messages: MESSAGES,
          ...LINK_RESULT,
          violations: JIRA_VIOLATIONS_SCHEMA,
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
    createdRanges: KEY_RANGES,
    existingRanges: KEY_RANGES,
    rangesTruncated: { type: "boolean" },
  },
  ["outcome"],
);
const RESULT_FIELDS = {
  outcome: { type: "string", enum: JIRA_MUTATION_RESULT_STATES },
  reason: { type: "string", enum: ATLASSIAN_CONNECTOR_WRITE_FAILURE_REASONS },
  replayed: { type: "boolean" },
  guidance: text(512),
  browseUrl: text(4096),
  issueKey: text(128),
  issueId: text(128),
  commentId: text(128),
  transitionId: text(128),
  attachmentId: text(128),
  fieldId: text(64),
  validation: { type: "string", enum: JIRA_FIELD_VALIDATION_FAILURES },
  fieldErrors: FIELD_ERRORS,
  messages: MESSAGES,
  ...LINK_RESULT,
  violations: JIRA_VIOLATIONS_SCHEMA,
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
const DEFINITIONS: Readonly<
  Record<
    JiraMutationOperation,
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
      "Propose a backlog of related issues (epics, stories, tasks, bugs, sub-tasks) as one draft the human approves once. Items name each other by ref and are created in dependency order; an item whose parent or linked item was not created is skipped (blockedBy), and an existing issue is reconciled, not created again. Use it whenever more than one issue is to be created, a parent and children to any depth. Send up to " +
      String(JIRA_DRAFT_PAGE_ITEMS_MAX) +
      " items here; stage a larger draft of any size with jira.draft-stage, then pass its draftId and draftDigest here, so it is approved once. Never split one backlog into several approvals. Items left pending continue with the same draftId and draftDigest, nothing created twice.",
    input: object(
      {
        items: {
          type: "array",
          minItems: 1,
          maxItems: JIRA_DRAFT_PAGE_ITEMS_MAX,
          items: JIRA_DRAFT_ITEM_SCHEMA,
        },
        draftId: { ...text(36), pattern: JIRA_DRAFT_ID_PATTERN },
        draftDigest: { ...text(64), pattern: JIRA_DRAFT_DIGEST_PATTERN },
      },
      [],
    ),
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
function declaration(name: JiraMutationOperation): ManagedMcpToolDeclaration {
  const definition = DEFINITIONS[name];
  return Object.freeze({
    name,
    risk: "write",
    descriptor: createToolDescriptor({
      toolRef: createToolRef(jiraMutationToolId(name), 3),
      description: definition.description,
      inputSchema: definition.input,
      resultSchema: definition.result ?? RESULT_SCHEMA,
      effects: ["connector-access"],
      actionMapping: [{ action: name, effects: ["connector-access"] }],
      policyReferences: ["adr-0128.d4"],
      handlerRequirement: { id: name, contractVersion: 1 },
      bounds: {
        maxArgumentBytes: 262144,
        maxResultBytes: definition.bounds?.maxResultBytes ?? 4096,
        maxResultCount: definition.bounds?.maxResultCount ?? 1,
        maxDurationMs: definition.bounds?.maxDurationMs ?? 90000,
      },
      idempotency: "server-key-required",
      cancellation: "before-effect",
    }),
  });
}
export const JIRA_MUTATION_DECLARATIONS = Object.freeze(JIRA_MUTATION_OPERATIONS.map(declaration));
