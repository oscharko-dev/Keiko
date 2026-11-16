import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolDeclaration } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { object, text } from "./jiraManagedSchemas.js";
import {
  jiraNativeDeclaration,
  jiraNativeWriteResult,
  type JiraNativeDefinition,
} from "./jiraProjectStructureDescriptors.js";

const NAME = { ...text(255), minLength: 1 };
const TIME = { ...text(128), minLength: 1 };
const nullable = (schema: CatalogJsonObject): CatalogJsonObject => ({
  anyOf: [schema, { type: "null" }],
});
const DIAGNOSTICS = {
  type: "array",
  maxItems: TOOL_CATALOG_LIMITS.maxArrayItems,
  items: object(
    {
      operation: NAME,
      messages: { type: "array", maxItems: TOOL_CATALOG_LIMITS.maxArrayItems, items: text(4096) },
      fields: {
        type: "array",
        maxItems: TOOL_CATALOG_LIMITS.maxArrayItems,
        items: object({ field: NAME, message: text(4096) }, ["field", "message"]),
      },
    },
    ["operation"],
  ),
};
export const JIRA_ANONYMIZATION_TASK_SNAPSHOT_SCHEMA = object(
  {
    executingNode: NAME,
    userKey: NAME,
    submittedTime: TIME,
    status: TIME,
    operations: {
      type: "array",
      maxItems: TOOL_CATALOG_LIMITS.maxArrayItems,
      uniqueItems: true,
      items: { ...text(128), minLength: 1 },
    },
    isRerun: { type: "boolean" },
    currentProgress: {
      type: "integer",
      minimum: Number.MIN_SAFE_INTEGER,
      maximum: Number.MAX_SAFE_INTEGER,
    },
    userName: nullable(text(255)),
    fullName: nullable(text(255)),
    currentSubTask: nullable(text(4096)),
    startTime: nullable(TIME),
    finishTime: nullable(TIME),
    errors: nullable(DIAGNOSTICS),
    warnings: nullable(DIAGNOSTICS),
  },
  [
    "executingNode",
    "userKey",
    "submittedTime",
    "status",
    "operations",
    "isRerun",
    "currentProgress",
  ],
);
const DEFINITION: JiraNativeDefinition = {
  description:
    "Request the fixed native DELETE /user/anonymization/unlock only with explicit issue-tracker.admin authority and high-risk policy. expectedTask is the complete observed current progress reviewSnapshot, including its executingNode; no historical taskId selector or inferred task ID is accepted. Read and compare current actor/task before effect and immediately before the private callback. The human-only protected input must attest that the exact executing node's owner process has actually been shut down. This is a human statement, never an independent process-liveness proof; OFFLINE, a failed network request, or model Boolean cannot substitute. The private one-use claim is bound to exact arguments, actor, connector generation and current authority. No secret/attestation value is a tool argument. Native unlock is global and has no compare-and-swap: every 2xx remains succeeded-unconfirmed, and a 404 is not removal proof. Known identity is retained after dispatch; never replay uncertainty or claim a new anonymization was started/completed. Readonly check does not consume input or issue DELETE.",
  input: object({ expectedActorKey: NAME, expectedTask: JIRA_ANONYMIZATION_TASK_SNAPSHOT_SCHEMA }, [
    "expectedActorKey",
    "expectedTask",
  ]),
  result: {
    ...jiraNativeWriteResult({
      actorUserKey: NAME,
      userKey: NAME,
      executingNode: NAME,
      anonymizationSubmittedTime: TIME,
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
export const JIRA_ANONYMIZATION_UNLOCK_DEFINITIONS = {
  "jira.unlock-user-anonymization": DEFINITION,
} as const;
export function jiraAnonymizationUnlockDeclarationForTool(
  name: string,
): ManagedMcpToolDeclaration | undefined {
  return name === "jira.unlock-user-anonymization"
    ? jiraNativeDeclaration(name, DEFINITION)
    : undefined;
}
