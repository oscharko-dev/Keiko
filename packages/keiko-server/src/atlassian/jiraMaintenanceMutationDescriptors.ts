import { TOOL_CATALOG_LIMITS, type CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { JiraMaintenanceMutation } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { ManagedMcpToolDeclaration } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { object, text } from "./jiraManagedSchemas.js";
import { jiraNativeDeclaration, jiraNativeWriteResult, type JiraNativeDefinition } from "./jiraProjectStructureDescriptors.js";

const NAME = { ...text(255), minLength: 1 };
const STATE = { ...text(128), minLength: 1 };
const ID = { type: "string", minLength: 1, maxLength: 19, pattern: "^[1-9][0-9]{0,18}$" };
const ISSUE_KEY = { ...text(128), minLength: 1 };
const BOOL = { type: "boolean" };
const INTEGER = { type: "integer", minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER };
const ACCEPT = { type: "boolean", enum: [true] };
const COMMON_INPUT = { expectedActorKey: NAME, confirmUnverifiedEffect: ACCEPT };
const COMMON_REQUIRED = ["expectedActorKey", "confirmUnverifiedEffect"];
const NODE = object({ nodeId: NAME, state: STATE, alive: BOOL, nodeBuildNumber: INTEGER, nodeVersion: NAME, lastStateChangeTimestamp: INTEGER }, ["nodeId", "state", "alive"]);
const CLUSTER = object({ state: STATE, build: object({ buildNumber: INTEGER, version: NAME }) }, ["state"]);
const FLAGS = { indexComments: BOOL, indexChangeHistory: BOOL, indexWorklogs: BOOL };
const REINDEX = { anyOf: [
  object({ taskState: { type: "string", enum: ["no-prior-task"] } }, ["taskState"]),
  object({ taskState: { type: "string", enum: ["observed"] }, type: STATE, currentProgress: INTEGER, success: BOOL,
    currentSubTask: text(4096), finishTime: STATE, startTime: STATE, submittedTime: STATE }, ["taskState", "type", "currentProgress", "success"]),
] };
const UPGRADE = { anyOf: [
  object({ upgradeState: { type: "string", enum: ["running", "no-prior-result"] } }, ["upgradeState"]),
  object({ upgradeState: { type: "string", enum: ["result"] }, upgradeOutcome: STATE,
    duration: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, message: text(TOOL_CATALOG_LIMITS.maxStringBytes), startTime: STATE }, ["upgradeState", "upgradeOutcome"]),
] };
const COMMON = "High-risk issue-tracker.admin action, separately subject to Jira's native administrator permissions. Exact actor/current-state reads precede exactly one fixed native request; they are not atomic compare-and-swap. confirmUnverifiedEffect:true explicitly accepts an operation whose complete cluster/index/job effects cannot be independently established here. All twelve actions remain succeeded-unconfirmed after ACK: never claim a completed job, usable snapshot, complete deletion, index consistency or deployed migration. No automatic retries, polling, redirect following, free URLs/headers/body, task-ID guessing or name-based recovery. A lost response retains known context only and must not be replayed. Existing authority, preflight, one-effect journal and body-free logging owners apply; complete known receipts are bounded to 16 KiB before any native request.";
function write(description: string, properties: CatalogJsonObject, required: readonly string[], receipt: CatalogJsonObject = {}): JiraNativeDefinition {
  return { description: `${description} ${COMMON}`, input: object({ ...COMMON_INPUT, ...properties }, [...COMMON_REQUIRED, ...required]),
    result: { ...jiraNativeWriteResult({ userKey: NAME, ...receipt }),
      allOf: [{ not: { properties: { outcome: { type: "string", enum: ["succeeded"] } }, required: ["outcome"] } }],
    }, risk: "write", maxResultCount: 1 };
}
function node(description: string): JiraNativeDefinition {
  return write(`${description} expectedNode is the complete projected row from the bounded native cluster/nodes array, including every observed optional build/version/timestamp field. ID, state and explicit liveness are required; missing liveness is unavailable. The selected nodeId is the route identity; slashes, percent escapes, control characters and dot segments are refused. Missing nodes after ACK do not prove deletion.`, { expectedNode: NODE }, ["expectedNode"], { nodeId: NAME });
}
function zdu(description: string): JiraNativeDefinition {
  return write(`${description} Review the exact cluster-upgrade state and all observed build facts. The documented supported pre-state is independently checked again immediately before dispatch; mismatching or unfamiliar state text refuses locally. Native Jira still enforces concurrent transitions and can return409. UriInfo is server context, not a selectable input. No issue fields or status migrations are inferred from this configuration request.`, { expectedClusterState: CLUSTER }, ["expectedClusterState"]);
}
export const JIRA_MAINTENANCE_WRITE_DEFINITIONS = {
  "jira.request-cluster-index-snapshot": node("Request the current index only from an independently observed ACTIVE node with alive:true using the native asynchronous cluster/index-snapshot route. Inactive, unreachable or unknown liveness refuses locally before dispatch. The native operation is deprecated and may be unavailable for the configured search platform or non-Data-Center deployment. No snapshot file is followed, copied or downloaded by Keiko."),
  "jira.delete-cluster-node": node("Request deletion of a cluster node only when its independently observed exact state is OFFLINE. The native delete may refuse; an absent node in a later visible list is not a proof of all cluster effects."),
  "jira.mark-cluster-node-offline": node("Request offline state only for a node independently observed as ACTIVE and alive:false. Unknown/true liveness and any other state refuse before the effect. Observing OFFLINE later still does not prove all cluster consequences."),
  "jira.approve-cluster-upgrade": zdu("Approve only the native READY_TO_RUN_UPGRADE_TASKS state, which denotes that all nodes have reached the same higher build and are ready for upgrade tasks. Earlier or mixed states refuse; ACK never establishes deployment or task completion."),
  "jira.cancel-cluster-upgrade": zdu("Request cancellation only from READY_TO_UPGRADE, before native state reports upgraded nodes. Mixed/running/failed states are outside this supported cancellation boundary; no rollback is performed or proved."),
  "jira.retry-cluster-upgrade": zdu("Request native acknowledgement/retry only from UPGRADE_TASKS_FAILED through retryUpgrade. This sends one explicit new administrative action, never a transport retry of a previous call."),
  "jira.start-cluster-upgrade": zdu("Request the native ready-to-upgrade/start transition only from STABLE through the fixed start route. It does not certify that every cluster node or upgrade task completed."),
  "jira.create-index-snapshot": write("Request one index snapshot only after observing running:false. Missing/null running refuses. The native202 is asynchronous, can clean old snapshot files and provides no completion-time guarantee. A fresh false running flag does not prove a usable snapshot exists; native absolute paths are neither followed nor included in the receipt.",
    { expectedRunning: { type: "boolean", enum: [false] } }, ["expectedRunning"]),
  "jira.start-reindex": write("Request one native system reindex with an explicit supported type and explicit flags. FOREGROUND indexes history/comments/worklogs regardless of these flags; the search platform may support only BACKGROUND. No JQL or undocumented options. expectedReindex must be the exact latest projected task with an observed finishTime, or no-prior-task only for the documented unselected GET404. A running or unavailable completion state refuses locally, even at100 percent or with success:true; state is independently rechecked before dispatch. A latest task after ACK is not correlated to this request and never proves completion. No returned URL or redirect is followed.",
    { expectedReindex: REINDEX, type: { type: "string", enum: ["FOREGROUND", "BACKGROUND", "BACKGROUND_PREFERRED"] }, ...FLAGS }, ["expectedReindex", "type", ...Object.keys(FLAGS)]),
  "jira.reindex-issues": write("Reindex only the complete reviewed list of1..50 exact native issue IDs/keys. Each issue is independently rebound before the request, and repeated issueId query values use observed numeric IDs. The native operation is synchronous but its response and later issue reads cannot prove index contents; retain IDs and remain unconfirmed. Index flags are explicit; no issue fields, membership or saved-rule state are changed by this indexing-only action.",
    { expectedIssues: { type: "array", minItems: 1, maxItems: 50, items: object({ issueId: ID, issueKey: ISSUE_KEY }, ["issueId", "issueKey"]) }, ...FLAGS }, ["expectedIssues", ...Object.keys(FLAGS)],
    { issueIds: { type: "array", minItems: 1, maxItems: 50, uniqueItems: true, items: ID } }),
  "jira.process-reindex-requests": write("Execute the native pending-reindex queue once. expectedReindex reviews only the current/latest status, not a complete pending-queue population. confirmUnverifiedEffect explicitly accepts all pending requests selected natively at dispatch; no model IDs or queue snapshot is invented. A native JSON array of exact request IDs is retained when bounded and independently queried. Empty/missing bulk progress rows do not establish absence, queue emptiness or completion.",
    { expectedReindex: REINDEX }, ["expectedReindex"], { reindexRequestIds: { type: "array", maxItems: TOOL_CATALOG_LIMITS.maxArrayItems, uniqueItems: true, items: ID } }),
  "jira.run-upgrade": write("Run pending delayed native upgrade tasks once after reviewing the exact last-result/no-prior-result observation. A running303 observation refuses before dispatch; no redirect is followed. This action may perform global data migrations; the REST interface exposes neither the pending task set nor a complete per-issue change plan. confirmUnverifiedEffect accepts that administrative maintenance scope, not a claim that saved issue fields or all migrations are verified. Native200 can also represent a scheduling-error array, so status and later last-result observations never become completed success.",
    { expectedUpgrade: UPGRADE }, ["expectedUpgrade"]),
} as const satisfies Readonly<Record<JiraMaintenanceMutation, JiraNativeDefinition>>;
export function jiraMaintenanceMutationDeclarationForTool(name: string): ManagedMcpToolDeclaration | undefined {
  const definitions: Readonly<Record<string, JiraNativeDefinition>> = JIRA_MAINTENANCE_WRITE_DEFINITIONS;
  const selected = Object.hasOwn(definitions, name) ? definitions[name] : undefined;
  return selected === undefined ? undefined : jiraNativeDeclaration(name, selected);
}
