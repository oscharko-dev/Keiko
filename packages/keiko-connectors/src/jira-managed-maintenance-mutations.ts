import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { AtlassianWriteHttpOutcome } from "./atlassian-write-http.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import {
  readMaintenanceMutationState,
  readMaintenanceRequests,
} from "./jira-maintenance-mutation-observations.js";
import {
  MAINTENANCE_MALFORMED,
  maintenanceReceipt,
  maintenanceReceiptFits,
  maintenanceRefusal,
  maintenanceSame,
  parseMaintenanceInput,
  type JiraMaintenanceMutation,
  type MaintenanceAttempt,
  type MaintenanceFailure,
  type MaintenanceInput,
  type MaintenanceObservation,
  type MaintenanceReceipt,
} from "./jira-maintenance-mutation-values.js";
import { dispatchFailure, JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";
import { jiraNativeNumericId } from "./jira-native-values.js";
import { readSavedActor } from "./jira-saved-configuration-values.js";
export {
  JIRA_MAINTENANCE_MUTATIONS,
  isJiraMaintenanceMutation,
  type JiraMaintenanceMutation,
} from "./jira-maintenance-mutation-values.js";

const ZDU = {
  "jira.approve-cluster-upgrade": "approve",
  "jira.cancel-cluster-upgrade": "cancel",
  "jira.retry-cluster-upgrade": "retryUpgrade",
  "jira.start-cluster-upgrade": "start",
} as const;
interface Effect {
  readonly path: string;
  readonly method: "PUT" | "POST" | "DELETE";
  readonly expect: "none" | "json-array";
}
function nodeEffect(input: Extract<MaintenanceInput, { kind: "node" }>): Effect {
  const nodeId = encodeURIComponent(input.nodeId);
  if (input.operation === "jira.request-cluster-index-snapshot")
    return { path: `cluster/index-snapshot/${nodeId}`, method: "PUT", expect: "none" };
  return input.operation === "jira.delete-cluster-node"
    ? { path: `cluster/node/${nodeId}`, method: "DELETE", expect: "none" }
    : { path: `cluster/node/${nodeId}/offline`, method: "PUT", expect: "none" };
}
function reindexEffect(input: Extract<MaintenanceInput, { kind: "reindex" | "issues" }>): Effect {
  const query = new URLSearchParams();
  if (input.kind === "reindex") query.set("type", input.type);
  else for (const issue of input.issues) query.append("issueId", issue.issueId);
  query.set("indexComments", String(input.flags.indexComments));
  query.set("indexChangeHistory", String(input.flags.indexChangeHistory));
  query.set("indexWorklogs", String(input.flags.indexWorklogs));
  return {
    path: `${input.kind === "issues" ? "reindex/issue" : "reindex"}?${query.toString()}`,
    method: "POST",
    expect: "none",
  };
}
function effectFor(input: MaintenanceInput): Effect {
  switch (input.kind) {
    case "node":
      return nodeEffect(input);
    case "cluster-upgrade": {
      const paths: Readonly<Record<string, string>> = ZDU;
      const path = paths[input.operation];
      if (path === undefined) throw new TypeError("Invalid closed cluster upgrade operation");
      return { path: `cluster/zdu/${path}`, method: "POST", expect: "none" };
    }
    case "snapshot":
      return { path: "index-snapshot", method: "POST", expect: "none" };
    case "reindex":
    case "issues":
      return reindexEffect(input);
    case "requests":
      return { path: "reindex/request", method: "POST", expect: "json-array" };
    case "upgrade":
      return { path: "upgrade", method: "POST", expect: "none" };
  }
}
function reviewedState(input: MaintenanceInput): CatalogJsonObject {
  if (input.kind === "issues") return { issues: input.issues.map((issue) => ({ ...issue })) };
  if (input.kind === "snapshot") return { running: false };
  return input.expected;
}
function nodeConstraint(
  input: Extract<MaintenanceInput, { kind: "node" }>,
): MaintenanceFailure | undefined {
  if (
    input.operation === "jira.request-cluster-index-snapshot" &&
    (input.expected.state !== "ACTIVE" || input.expected.alive !== true)
  )
    return maintenanceRefusal(
      "A cluster index snapshot requires an independently observed ACTIVE and alive node. Select and review a live active node before requesting its index.",
      "conflict",
    );
  if (input.operation === "jira.delete-cluster-node" && input.expected.state !== "OFFLINE")
    return maintenanceRefusal(
      "Native node deletion requires an observed OFFLINE node; other states are not safe deletion evidence.",
      "conflict",
    );
  if (
    input.operation === "jira.mark-cluster-node-offline" &&
    (input.expected.state !== "ACTIVE" || input.expected.alive !== false)
  )
    return maintenanceRefusal(
      "Native offline admission requires an observed ACTIVE node that is explicitly not alive. Unknown liveness is not false.",
      "conflict",
    );
  return undefined;
}
// UpgradeState (11.3) distinguishes readiness, mixed versions, running tasks and failure.
// Cancellation is deliberately limited to readiness before any node upgrade, not rollback.
const ZDU_STATES: Readonly<Partial<Record<JiraMaintenanceMutation, string>>> = {
  "jira.approve-cluster-upgrade": "READY_TO_RUN_UPGRADE_TASKS",
  "jira.cancel-cluster-upgrade": "READY_TO_UPGRADE",
  "jira.retry-cluster-upgrade": "UPGRADE_TASKS_FAILED",
  "jira.start-cluster-upgrade": "STABLE",
};
function clusterConstraint(
  input: Extract<MaintenanceInput, { kind: "cluster-upgrade" }>,
): MaintenanceFailure | undefined {
  const required = ZDU_STATES[input.operation];
  if (required === undefined)
    return maintenanceRefusal("This operation has no supported cluster transition.");
  return input.expected.state === required
    ? undefined
    : maintenanceRefusal(
        `This cluster action requires the independently observed native state ${required}. Read the current upgrade state and choose the supported next action; unfamiliar or mixed states do not authorize this transition.`,
        "conflict",
      );
}
function stateConstraint(input: MaintenanceInput): MaintenanceFailure | undefined {
  if (input.kind === "node") return nodeConstraint(input);
  if (input.kind === "cluster-upgrade") return clusterConstraint(input);
  if (
    input.kind === "reindex" &&
    input.expected.taskState !== "no-prior-task" &&
    typeof input.expected.finishTime !== "string"
  )
    return maintenanceRefusal(
      "The observed reindex has no native finishTime. Do not start another reindex while the current task is running or its completion is unavailable; progress or success alone is not a completion marker.",
      "conflict",
    );
  if (input.kind === "upgrade" && input.expected.upgradeState === "running")
    return maintenanceRefusal(
      "The independent native upgrade observation is running. Do not schedule another pending-upgrade request.",
      "conflict",
    );
  return undefined;
}
async function admit(
  request: JiraMutationRequest,
  input: MaintenanceInput,
): Promise<MaintenanceFailure | undefined> {
  const actor = await readSavedActor(request, input.actor);
  if (!actor.ok) return actor;
  const state = await readMaintenanceMutationState(request, input);
  if (!state.ok) return state;
  if (!maintenanceSame(state.value, reviewedState(input)))
    return maintenanceRefusal(
      "The independently observed maintenance context changed. Read and review the exact current state before requesting one operation.",
      "conflict",
    );
  return stateConstraint(input);
}
function acknowledgedRequests(
  response: Extract<AtlassianWriteHttpOutcome, { ok: true }>,
  receipt: MaintenanceReceipt,
): MaintenanceObservation<MaintenanceReceipt> {
  if (response.items === undefined) return MAINTENANCE_MALFORMED;
  if (response.items.length > TOOL_CATALOG_LIMITS.maxArrayItems)
    return { ok: false, reason: "bounds-exceeded" };
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of response.items) {
    const id = jiraNativeNumericId(item);
    if (id === undefined || seen.has(id)) return MAINTENANCE_MALFORMED;
    seen.add(id);
    ids.push(id);
  }
  const value = Object.freeze({ ...receipt, reindexRequestIds: Object.freeze(ids) });
  return maintenanceReceiptFits(value)
    ? { ok: true, value }
    : { ok: false, reason: "bounds-exceeded" };
}
async function observeAfter(
  request: JiraMutationRequest,
  input: MaintenanceInput,
  receipt: MaintenanceReceipt,
): Promise<MaintenanceAttempt> {
  const actor = await readSavedActor(request, input.actor);
  if (!actor.ok) return { ...actor, receipt };
  const state = await readMaintenanceMutationState(request, input);
  if (!state.ok) return { ...state, receipt };
  if (receipt.reindexRequestIds !== undefined) {
    const requests = await readMaintenanceRequests(request, receipt.reindexRequestIds);
    if (!requests.ok) return { ...requests, receipt };
  }
  return maintenanceRefusal(
    "Jira acknowledged one maintenance request and an independent current observation was read. This does not establish the request's completed index, cluster, scheduling, migration or deletion effects. Retain known IDs and do not automatically replay. A latest task may belong to another request; returned request IDs are observations, not completion proof.",
    "unavailable",
    receipt,
  );
}
async function afterAcknowledgement(
  request: JiraMutationRequest,
  input: MaintenanceInput,
  response: Extract<AtlassianWriteHttpOutcome, { ok: true }>,
  known: MaintenanceReceipt,
): Promise<MaintenanceAttempt> {
  const acknowledged =
    input.kind === "requests"
      ? acknowledgedRequests(response, known)
      : ({ ok: true, value: known } as const);
  const receipt = acknowledged.ok ? acknowledged.value : known;
  try {
    const observed = await observeAfter(request, input, receipt);
    return acknowledged.ok ? observed : { ...acknowledged, receipt };
  } catch (error) {
    throw new JiraAcknowledgedMutationError(error, receipt);
  }
}
/** Fixed administrative requests only. No job polling, redirects, retries, guessed job IDs or global success inference. */
export async function executeJiraMaintenanceMutation(
  operation: JiraMaintenanceMutation,
  args: CatalogJsonObject,
  request: JiraMutationRequest,
  check = false,
): Promise<MaintenanceAttempt> {
  const input = parseMaintenanceInput(operation, args);
  if (input === undefined)
    return maintenanceRefusal(
      "Provide the exact actor, complete typed native review, confirmUnverifiedEffect:true and only the operation's documented selectors. Node liveness must be observed; reindex flags are explicit Booleans. No raw paths, URLs, JQL, task IDs, arbitrary types or body options are accepted.",
    );
  const receipt = maintenanceReceipt(input);
  if (!maintenanceReceiptFits(receipt))
    return maintenanceRefusal(
      "The complete known context exceeds the existing 16 KiB receipt bound before any native request.",
    );
  const refusal = await admit(request, input);
  if (refusal !== undefined) return refusal;
  if (check) return { ok: true, receipt: {} };
  const currentRefusal = await admit(request, input);
  if (currentRefusal !== undefined) return currentRefusal;
  const effect = effectFor(input);
  const response = await request(effect.path, effect.method, undefined, effect.expect);
  if (!response.ok) return { ...dispatchFailure(response), receipt };
  if (response.status < 200 || response.status >= 300) return { ...MAINTENANCE_MALFORMED, receipt };
  return afterAcknowledgement(request, input, response, receipt);
}
