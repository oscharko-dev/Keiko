import {
  JIRA_DRAFT_ID_PATTERN,
  JIRA_DRAFT_PAGE_ITEMS_MAX,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { ManagedMcpToolDeclaration } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { createToolDescriptor, createToolRef } from "@oscharko-dev/keiko-tool-catalog";
import { object, text } from "./jiraManagedSchemas.js";
import { JIRA_VIOLATIONS_SCHEMA } from "./jiraManagedMutationDescriptors.js";

const DESCRIPTION =
  "Write a backlog draft larger than jira.draft takes in pages of up to " +
  String(JIRA_DRAFT_PAGE_ITEMS_MAX) +
  " items in the jira.draft item form; pass the returned draftId to append. A page that breaks an issue template is refused whole with the violations to correct. " +
  "When unresolvedRefCount is 0, call jira.draft with only draftId and the last draftDigest: the human approves the whole draft once. Changes nothing in Jira.";

// The item form is jira.draft's, declared there once: repeating it here would spend the model's
// context on every turn. The tool checks every item against that form and names the first item
// that does not match it.
const STAGED_ITEM = {
  type: "object",
  description: "One item in the jira.draft item form.",
  properties: {},
  required: [],
  additionalProperties: true,
};

export const JIRA_DRAFT_STAGE_DECLARATION: ManagedMcpToolDeclaration = Object.freeze({
  name: "jira.draft-stage",
  risk: "read",
  descriptor: createToolDescriptor({
    toolRef: createToolRef("keiko.jira.draft.stage", 1),
    description: DESCRIPTION,
    inputSchema: object(
      {
        draftId: { ...text(36), pattern: JIRA_DRAFT_ID_PATTERN },
        items: {
          type: "array",
          minItems: 1,
          maxItems: JIRA_DRAFT_PAGE_ITEMS_MAX,
          items: STAGED_ITEM,
        },
      },
      ["items"],
    ),
    resultSchema: object(
      {
        outcome: { type: "string", enum: ["succeeded", "failed", "rejected"] },
        reason: text(64),
        draftId: text(64),
        draftDigest: text(64),
        newDraft: { type: "boolean" },
        itemCount: { type: "integer", minimum: 0 },
        pageCount: { type: "integer", minimum: 0 },
        guidance: text(1024),
        unresolvedRefCount: { type: "integer", minimum: 0 },
        unresolvedRefs: { type: "array", maxItems: 32, items: text(32) },
        ref: text(32),
        violations: JIRA_VIOLATIONS_SCHEMA,
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
      maxDurationMs: 300000,
    },
    idempotency: "server-key-required",
    cancellation: "before-effect",
  }),
});
