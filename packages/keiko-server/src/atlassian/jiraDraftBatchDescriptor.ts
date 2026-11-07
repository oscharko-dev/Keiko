import type { ManagedMcpToolDeclaration } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { REQUIREMENT_DOCUMENT_SCOPE_SCHEMA } from "@oscharko-dev/keiko-quality-intelligence";
import {
  compileExternalCatalogSchema,
  createToolDescriptor,
  createToolRef,
} from "@oscharko-dev/keiko-tool-catalog";
import { object, text } from "./jiraManagedSchemas.js";
import {
  ISSUE_TYPE_ID,
  JIRA_DRAFT_ID_SCHEMA,
  JIRA_DRAFT_PARENT_SCHEMA,
  PROJECT_ID,
  REQUIREMENT_PROBLEMS,
  REQUIREMENT_REFUSAL,
} from "./jiraManagedMutationDescriptors.js";

/** The largest text a model passes as a grouping instruction or as wording guidance. */
export const JIRA_DRAFT_BATCH_GROUPING_CHARS_MAX = 500;
export const JIRA_DRAFT_BATCH_GUIDANCE_CHARS_MAX = 1000;
/** Requirement references a result names as not drafted. */
export const JIRA_DRAFT_BATCH_FAILED_REFS_MAX = 32;
/** A batch of a few hundred requirements takes tens of model calls; this is its whole deadline. */
export const JIRA_DRAFT_BATCH_DURATION_MS_MAX = 2_700_000;

const DESCRIPTION =
  "Draft Jira issues from this Chat's Knowledge requirements in ONE call; Keiko pages them itself. " +
  "per-requirement: one issue each; grouped: issues per group named by grouping. requirements only narrows to a subset. " +
  "create true only if the user asked to create now; Keiko then asks for approval, so skip jira.draft. " +
  "If failedCount is above 0, report failedRequirementRefs and offer a retry with requirements.ids and the same draftId.";

const REQUIREMENTS_SCHEMA = object({
  documents: { type: "array", maxItems: 20, items: REQUIREMENT_DOCUMENT_SCOPE_SCHEMA },
  ids: { type: "array", maxItems: 50, items: text(80) },
  priorities: { type: "array", maxItems: 10, items: text(64) },
  query: text(200),
});

const BATCH_PARENT_SCHEMA = {
  ...JIRA_DRAFT_PARENT_SCHEMA,
  description: "Parent for every issue: fieldId plus ref or issueKey.",
};

const COUNT = { type: "integer", minimum: 0 } as const;

export const JIRA_DRAFT_BATCH_DECLARATION: ManagedMcpToolDeclaration = Object.freeze({
  name: "jira.draft-batch",
  risk: "read",
  descriptor: createToolDescriptor({
    toolRef: createToolRef("keiko.jira.draft.batch", 1),
    description: DESCRIPTION,
    inputSchema: compileExternalCatalogSchema(
      object(
        {
          projectId: PROJECT_ID,
          issueTypeId: ISSUE_TYPE_ID,
          granularity: { type: "string", enum: ["per-requirement", "grouped"] },
          grouping: text(JIRA_DRAFT_BATCH_GROUPING_CHARS_MAX),
          guidance: text(JIRA_DRAFT_BATCH_GUIDANCE_CHARS_MAX),
          requirements: REQUIREMENTS_SCHEMA,
          parent: BATCH_PARENT_SCHEMA,
          draftId: JIRA_DRAFT_ID_SCHEMA,
          create: { type: "boolean" },
        },
        ["projectId", "issueTypeId", "granularity", "create"],
      ),
    ),
    resultSchema: object(
      {
        outcome: { type: "string", enum: ["succeeded", "failed", "rejected"] },
        reason: text(64),
        requirementRefusal: REQUIREMENT_REFUSAL,
        requirementProblems: REQUIREMENT_PROBLEMS,
        draftId: text(64),
        draftDigest: text(64),
        newDraft: { type: "boolean" },
        itemCount: COUNT,
        pageCount: COUNT,
        unresolvedRefCount: COUNT,
        unresolvedRefs: { type: "array", maxItems: 32, items: text(32) },
        plannedCount: COUNT,
        draftedCount: COUNT,
        failedCount: COUNT,
        requirementCount: COUNT,
        coveredRequirementCount: COUNT,
        failedRequirementRefs: {
          type: "array",
          maxItems: JIRA_DRAFT_BATCH_FAILED_REFS_MAX,
          items: text(120),
        },
        createRequested: { type: "boolean" },
        guidance: text(1024),
      },
      ["outcome"],
    ),
    effects: ["connector-access"],
    actionMapping: [{ action: "jira.draft-batch", effects: ["connector-access"] }],
    policyReferences: ["adr-0128.d4"],
    handlerRequirement: { id: "jira.draft-batch", contractVersion: 1 },
    bounds: {
      maxArgumentBytes: 16384,
      maxResultBytes: 16384,
      maxResultCount: 1,
      maxDurationMs: JIRA_DRAFT_BATCH_DURATION_MS_MAX,
    },
    idempotency: "server-key-required",
    cancellation: "before-effect",
  }),
});
