import {
  JIRA_MUTATION_LINKS_MAX,
  JIRA_REQUIREMENT_REFERENCE_CHARS_MAX,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { ManagedMcpToolDeclaration } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { object, text } from "./jiraManagedSchemas.js";
import {
  jiraNativeDeclaration,
  jiraNativeWriteResult,
  type JiraNativeDefinition,
} from "./jiraProjectStructureDescriptors.js";

const ID = { ...text(32), pattern: "^[0-9]{1,32}$" };
const ACK_ID = { ...text(19), pattern: String.raw`^[1-9]\d{0,18}$` };
const KEY = { ...text(128), minLength: 1 };
const LINK = object(
  {
    type: { ...text(255), minLength: 1 },
    direction: { type: "string", enum: ["inward", "outward"] },
    issueKey: KEY,
  },
  ["type", "direction", "issueKey"],
);
const ITEM = object(
  {
    projectId: ID,
    issueTypeId: ID,
    fields: { ...object({}), additionalProperties: true },
    links: { type: "array", maxItems: JIRA_MUTATION_LINKS_MAX, items: LINK },
  },
  ["projectId", "issueTypeId", "fields"],
);
export const JIRA_BULK_CREATE_DEFINITION: JiraNativeDefinition = {
  description:
    "Create1..50 reviewed issues through exactly one native POSTissue/bulk. High-risk issue-tracker.write. Every item must pass the existing single-create metadata, typed-field, description, requirement-trace, saved-rule and draft-twin admission before dispatch. Optional common requirementIds apply to every item through the existing server resolver; no per-item unresolved reference or inter-item temporary target. Inline links only: any plan requiring later issueLink writes refuses the whole batch before its one effect. Duplicate normalized payloads/draft identities refuse. Existing metadata is not a concurrency lock. confirmUnverifiedEffect:true accepts that a native bulk ACK can contain partial errors and does not prove exact item attribution or complete consequences. Only ACK IDs/keys are retained, without assuming success-array order or the base of failedElementNumber. Native failed element numbers/statuses remain paired literal observations; never claim a bulk error was atomic or replay the batch/subset. Every ACK stays succeeded-unconfirmed, followed by read-only exact-ID observations. No name/JQL recovery, raw methods/headers/URLs, or second journal. Existing authority, bounded receipt/transcript and body-free log owners apply.",
  input: object(
    {
      expectedActorKey: { ...text(255), minLength: 1 },
      confirmUnverifiedEffect: { type: "boolean", enum: [true] },
      issues: { type: "array", minItems: 1, maxItems: 50, items: ITEM },
      requirementIds: {
        type: "array",
        minItems: 1,
        maxItems: 8,
        items: { ...text(JIRA_REQUIREMENT_REFERENCE_CHARS_MAX), minLength: 1 },
      },
    },
    ["expectedActorKey", "confirmUnverifiedEffect", "issues"],
  ),
  result: {
    ...jiraNativeWriteResult({
      userKey: text(255),
      requestedIssueCount: { type: "integer", minimum: 1, maximum: 50 },
      issueIds: { type: "array", minItems: 1, maxItems: 50, uniqueItems: true, items: ACK_ID },
      issueKeys: { type: "array", minItems: 1, maxItems: 50, uniqueItems: true, items: KEY },
      bulkFailedElementNumbers: {
        type: "array",
        minItems: 1,
        maxItems: 50,
        uniqueItems: true,
        items: { type: "integer", minimum: 0, maximum: 2147483647 },
      },
      bulkFailureStatuses: {
        type: "array",
        minItems: 1,
        maxItems: 50,
        items: { type: "integer", minimum: 400, maximum: 599 },
      },
    }),
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
export function jiraBulkCreateDeclarationForTool(
  name: string,
): ManagedMcpToolDeclaration | undefined {
  return name === "jira.create-issues"
    ? jiraNativeDeclaration(name, JIRA_BULK_CREATE_DEFINITION)
    : undefined;
}
