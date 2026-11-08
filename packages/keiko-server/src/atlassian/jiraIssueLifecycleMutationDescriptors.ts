import { TOOL_CATALOG_LIMITS, type CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolDeclaration } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { object, text } from "./jiraManagedSchemas.js";
import { jiraNativeDeclaration, jiraNativeWriteResult, type JiraNativeDefinition } from "./jiraProjectStructureDescriptors.js";

const ID = { type: "string", minLength: 1, maxLength: 19, pattern: "^[1-9][0-9]{0,18}$" };
const KEY = { ...text(128), minLength: 1 };
const ACTOR = { ...text(255), minLength: 1 };
const POSITION = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const ISSUE = object({ id: ID, key: KEY, summary: text(32768), projectId: ID, issueTypeId: ID }, ["id", "key", "summary", "projectId", "issueTypeId"]);
const CHILD = object({ id: ID, key: KEY }, ["id", "key"]);
const COMMON_INPUT = { expectedActorKey: ACTOR, confirmUnverifiedEffect: { type: "boolean", enum: [true] } };
const COMMON_REQUIRED = ["expectedActorKey", "confirmUnverifiedEffect"];
const COMMON = "High-risk issue-tracker.write action, independently subject to native Jira permissions. Bind the exact current actor, numeric issue identity, key, summary, project and type before exactly one fixed native effect. Reviewed state is not atomic compare-and-swap. confirmUnverifiedEffect:true explicitly accepts that complete archive/deletion/notification/sequence consequences cannot be independently proved. Every acknowledged effect remains succeeded-unconfirmed; never retry a lost or uncertain response. Missing/denied issue reads or404 do not prove deletion or archiving. Receipt flags/positions describe requested targets, not observed completion. Known receipts are bounded to16KiB before requests; existing authority, one-effect journal, preflight and body-free logging apply.";
function write(description: string, input: CatalogJsonObject, required: readonly string[], receipt: CatalogJsonObject): JiraNativeDefinition {
  return { description: `${description} ${COMMON}`, input: object({ ...COMMON_INPUT, ...input }, [...COMMON_REQUIRED, ...required]),
    result: { ...jiraNativeWriteResult({ userKey: ACTOR, ...receipt }), allOf: [{ not: { properties: { outcome: { type: "string", enum: ["succeeded"] } }, required: ["outcome"] } }] },
    risk: "write", maxResultCount: 1 };
}
const SINGLE_RECEIPT = { issueId: ID, issueKey: KEY };
export const JIRA_ISSUE_LIFECYCLE_WRITE_DEFINITIONS = {
  "jira.archive-issues": write("Archive1..50 distinct reviewed issues through one native bulk request. Independently bind every selected issue; native request is the exact observed key array with notifyUsers=true fixed. The native text stream is neither parsed as completion nor exposed as a log. Partial/global effects and hidden issues are never inferred from that stream or a later JQL/list prefix.",
    { expectedIssues: { type: "array", minItems: 1, maxItems: 50, items: ISSUE } }, ["expectedIssues"],
    { issueIds: { type: "array", minItems: 1, maxItems: 50, uniqueItems: true, items: ID }, issueKeys: { type: "array", minItems: 1, maxItems: 50, uniqueItems: true, items: KEY }, issueArchivedRequested: { type: "boolean", enum: [true] } }),
  "jira.archive-issue": write("Request native archiving for the exact reviewed issue, with notifyUsers=true fixed. Do not invent an archived flag from an ordinary IssueBean or unreadable issue response.",
    { expectedIssue: ISSUE }, ["expectedIssue"], { ...SINGLE_RECEIPT, issueArchivedRequested: { type: "boolean", enum: [true] } }),
  "jira.restore-issue": write("Request native restoration for the exact reviewed issue, with notifyUsers=true fixed. If the issue cannot be independently read and bound before restoration, refuse; do not guess identity from a search result or archived flag.",
    { expectedIssue: ISSUE }, ["expectedIssue"], { ...SINGLE_RECEIPT, issueArchivedRequested: { type: "boolean", enum: [false] } }),
  "jira.delete-issue": write("Delete only a reviewed issue whose complete returned native direct-subtask list is empty. expectedSubtasks must be[]. deleteSubtasks=false is fixed: native Jira must refuse if children exist or appear concurrently. A visible empty list is not a proof of all incoming relationships. The existing formal issue-deletion impact owner must admit current parent/link/issue-reference rules before dispatch; no own deleted summary/label poststate or archive-wide rule is invented.",
    { expectedIssue: ISSUE, expectedSubtasks: { type: "array", maxItems: 0, items: CHILD } }, ["expectedIssue", "expectedSubtasks"], { ...SINGLE_RECEIPT, issuePresent: { type: "boolean", enum: [false] } }),
  "jira.move-subtask": write("Reorder subtasks within the same reviewed parent, never reparent. Review the full returned native child sequence and independently observe canMove:true. originalPosition/currentPosition are explicit distinct native sequence values sent as original/current; no zero-/one-based interpretation, array-index conversion or absolute persisted rank is invented. Native Jira validates their bounds. A matching later visible sequence does not establish every reorder consequence.",
    { expectedIssue: ISSUE, expectedSubtasks: { type: "array", minItems: 2, maxItems: TOOL_CATALOG_LIMITS.maxArrayItems, items: CHILD }, originalPosition: POSITION, currentPosition: POSITION },
    ["expectedIssue", "expectedSubtasks", "originalPosition", "currentPosition"],
    { ...SINGLE_RECEIPT, subtaskIds: { type: "array", minItems: 2, maxItems: TOOL_CATALOG_LIMITS.maxArrayItems, uniqueItems: true, items: ID }, originalPosition: POSITION, currentPosition: POSITION }),
} as const satisfies Readonly<Record<string, JiraNativeDefinition>>;
export function jiraIssueLifecycleMutationDeclarationForTool(name: string): ManagedMcpToolDeclaration | undefined {
  const definitions: Readonly<Record<string, JiraNativeDefinition>> = JIRA_ISSUE_LIFECYCLE_WRITE_DEFINITIONS;
  const selected = Object.hasOwn(definitions, name) ? definitions[name] : undefined;
  return selected === undefined ? undefined : jiraNativeDeclaration(name, selected);
}
