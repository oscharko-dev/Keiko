import {
  JIRA_DRAFT_PAGE_ITEMS_MAX,
  JIRA_FIELD_VALIDATION_FAILURES,
  JIRA_RESULT_GUIDANCE_MAX_CHARS,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { ManagedMcpToolDeclaration } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import {
  compileExternalCatalogSchema,
  createToolDescriptor,
  createToolRef,
} from "@oscharko-dev/keiko-tool-catalog";
import { object, text } from "./jiraManagedSchemas.js";
import {
  JIRA_DRAFT_ITEM_SCHEMA,
  JIRA_DRAFT_ID_SCHEMA,
  JIRA_FAILURE_MESSAGES_SCHEMA,
  JIRA_VIOLATIONS_SCHEMA,
  REQUIREMENT_PROBLEMS,
  REQUIREMENT_REFUSAL,
} from "./jiraManagedMutationDescriptors.js";

/** How long one draft-stage call may take; it saves a draft in Keiko and makes no Jira write. */
export const JIRA_DRAFT_STAGE_DURATION_MS = 30 * 60_000;

const DESCRIPTION =
  "Save a reviewable backlog draft in Keiko without creating Jira issues. Supports small and large drafts in pages of 1 to " +
  String(JIRA_DRAFT_PAGE_ITEMS_MAX) +
  " items in the jira.draft item form; for Knowledge requirements use jira.draft-batch. Omit draftId to start a new draft; supply the returned draftId only to append to that draft. " +
  "A page that breaks an issue template is refused whole with the violations to correct. The result returns draftId and draftDigest for jira.draft only. " +
  "Only when the user requests creation in Jira and unresolvedRefCount is 0, call jira.draft with only draftId and the last draftDigest; that tool performs Jira writes under the current write authority, and Keiko asks for any approval the Chat's access mode requires.";

function draftStageInputSchema(): ReturnType<typeof compileExternalCatalogSchema> {
  return compileExternalCatalogSchema(
    object(
      {
        draftId: JIRA_DRAFT_ID_SCHEMA,
        items: {
          type: "array",
          minItems: 1,
          maxItems: JIRA_DRAFT_PAGE_ITEMS_MAX,
          items: JIRA_DRAFT_ITEM_SCHEMA,
        },
      },
      ["items"],
    ),
  );
}
export function jiraDraftStageDeclaration(): ManagedMcpToolDeclaration {
  return Object.freeze({
    name: "jira.draft-stage",
    risk: "read",
    descriptor: createToolDescriptor({
      toolRef: createToolRef("keiko.jira.draft.stage", 1),
      description: DESCRIPTION,
      inputSchema: draftStageInputSchema(),
      resultSchema: object(
        {
          outcome: { type: "string", enum: ["succeeded", "failed", "rejected"] },
          reason: text(64),
          requirementRefusal: REQUIREMENT_REFUSAL,
          requirementProblems: REQUIREMENT_PROBLEMS,
          draftId: text(64),
          draftDigest: text(64),
          newDraft: { type: "boolean" },
          itemCount: { type: "integer", minimum: 0 },
          pageCount: { type: "integer", minimum: 0 },
          guidance: text(JIRA_RESULT_GUIDANCE_MAX_CHARS),
          unresolvedRefCount: { type: "integer", minimum: 0 },
          unresolvedRefs: { type: "array", maxItems: 32, items: text(32) },
          ref: text(32),
          violations: JIRA_VIOLATIONS_SCHEMA,
          fieldId: text(64),
          validation: { type: "string", enum: JIRA_FIELD_VALIDATION_FAILURES },
          messages: JIRA_FAILURE_MESSAGES_SCHEMA,
        },
        ["outcome"],
      ),
      effects: ["connector-access"],
      actionMapping: [{ action: "jira.draft-stage", effects: ["connector-access"] }],
      policyReferences: ["adr-0128.d4"],
      handlerRequirement: { id: "jira.draft-stage", contractVersion: 1 },
      bounds: {
        maxArgumentBytes: 262144,
        maxResultBytes: 16384,
        maxResultCount: 1,
        // Owner decision 2026-11-24: 30 minutes (was 5), room for the metadata reads a large draft's
        // field check makes against a slow Jira.
        maxDurationMs: JIRA_DRAFT_STAGE_DURATION_MS,
      },
      idempotency: "server-key-required",
      cancellation: "before-effect",
    }),
  });
}
