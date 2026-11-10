import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import {
  jiraMaintenanceNode,
  jiraMaintenanceReindex,
  jiraMaintenanceRequest,
  jiraMaintenanceSnapshot,
  jiraMaintenanceUpgrade,
  jiraMaintenanceUpgradeResult,
} from "./jira-maintenance-values.js";
import { readJiraMutationIssue } from "./jira-mutation-confirmation.js";
import { dispatchFailure } from "./jira-mutation-failure.js";
import { jiraNativeId } from "./jira-native-values.js";
import {
  MAINTENANCE_MALFORMED,
  maintenanceClusterReview,
  maintenanceNodeReview,
  maintenanceRefusal,
  maintenanceReindexReview,
  maintenanceUpgradeReview,
  type MaintenanceInput,
  type MaintenanceObservation,
} from "./jira-maintenance-mutation-values.js";

function selectedNode(
  items: readonly unknown[],
  nodeId: string,
): MaintenanceObservation<CatalogJsonObject> {
  if (items.length > TOOL_CATALOG_LIMITS.maxArrayItems)
    return { ok: false, reason: "bounds-exceeded" };
  const ids = new Set<string>();
  let selected: CatalogJsonObject | undefined;
  for (const item of items) {
    const parsed = jiraMaintenanceNode(item);
    if (!parsed.ok) return parsed;
    const id = parsed.value.nodeId;
    if (typeof id !== "string" || ids.has(id)) return MAINTENANCE_MALFORMED;
    ids.add(id);
    if (id === nodeId) selected = maintenanceNodeReview(parsed.value);
  }
  return selected === undefined
    ? maintenanceRefusal(
        "The selected node has no complete readable state/alive evidence. Missing list entries do not prove deletion or its cluster effects.",
        "unavailable",
      )
    : { ok: true, value: selected };
}
/** Reads the entire native array before selecting a node. No visible prefix proves absence. */
async function nodeState(
  request: JiraMutationRequest,
  nodeId: string,
): Promise<MaintenanceObservation<CatalogJsonObject>> {
  const response = await request("cluster/nodes", "GET", undefined, "json-array");
  if (!response.ok) return dispatchFailure(response);
  return response.status === 200 && response.items !== undefined
    ? selectedNode(response.items, nodeId)
    : MAINTENANCE_MALFORMED;
}
async function clusterState(
  request: JiraMutationRequest,
): Promise<MaintenanceObservation<CatalogJsonObject>> {
  const response = await request("cluster/zdu/state", "GET", undefined, "json");
  if (!response.ok) return dispatchFailure(response);
  if (response.status !== 200) return MAINTENANCE_MALFORMED;
  const projected = jiraMaintenanceUpgrade(response.body);
  if (!projected.ok) return projected;
  const value = maintenanceClusterReview(projected.value);
  return value === undefined
    ? maintenanceRefusal(
        "The native cluster upgrade state is unavailable; an absent state is not stable or idle.",
        "unavailable",
      )
    : { ok: true, value };
}
async function snapshotState(
  request: JiraMutationRequest,
): Promise<MaintenanceObservation<CatalogJsonObject>> {
  const response = await request("index-snapshot/isRunning", "GET", undefined, "json");
  if (!response.ok) return dispatchFailure(response);
  if (response.status !== 200) return MAINTENANCE_MALFORMED;
  const parsed = jiraMaintenanceSnapshot(response.body);
  if (!parsed.ok) return parsed;
  return typeof parsed.value.running === "boolean"
    ? parsed
    : maintenanceRefusal("Snapshot running state is unknown; missing is not false.", "unavailable");
}
async function reindexState(
  request: JiraMutationRequest,
): Promise<MaintenanceObservation<CatalogJsonObject>> {
  const response = await request("reindex", "GET", undefined, "json");
  // This one unselected GET documents 404 as no prior task; it is not issue/resource absence.
  if (!response.ok && response.httpStatus === 404)
    return { ok: true, value: { taskState: "no-prior-task" } };
  if (!response.ok) return dispatchFailure(response);
  if (response.status !== 200) return MAINTENANCE_MALFORMED;
  const projected = jiraMaintenanceReindex(response.body);
  if (!projected.ok) return projected;
  const value = maintenanceReindexReview({ taskState: "observed", ...projected.value });
  return value === undefined
    ? maintenanceRefusal(
        "Current or latest reindex status lacks its observed type/progress/success fields. No idle or completed state is inferred.",
        "unavailable",
      )
    : { ok: true, value };
}
async function upgradeState(
  request: JiraMutationRequest,
): Promise<MaintenanceObservation<CatalogJsonObject>> {
  const response = await request("upgrade", "GET", undefined, "json");
  const status = response.ok ? response.status : response.httpStatus;
  if (status === 303) return { ok: true, value: { upgradeState: "running" } };
  if (status === 404) return { ok: true, value: { upgradeState: "no-prior-result" } };
  if (!response.ok) return dispatchFailure(response);
  if (status !== 200) return MAINTENANCE_MALFORMED;
  const projected = jiraMaintenanceUpgradeResult(response.body);
  if (!projected.ok) return projected;
  const value = maintenanceUpgradeReview({ upgradeState: "result", ...projected.value });
  return value === undefined
    ? maintenanceRefusal(
        "The last upgrade outcome is unavailable. No pending-task population or deployment status is inferred.",
        "unavailable",
      )
    : { ok: true, value };
}
async function issueState(
  request: JiraMutationRequest,
  input: Extract<MaintenanceInput, { kind: "issues" }>,
): Promise<MaintenanceObservation<CatalogJsonObject>> {
  const values: CatalogJsonObject[] = [];
  for (const selected of input.issues) {
    const result = await readJiraMutationIssue(request, selected.issueId, ["summary"]);
    if (!result.ok) return result;
    if (
      !jiraNativeId(result.id) ||
      result.id !== selected.issueId ||
      result.key !== selected.issueKey
    )
      return maintenanceRefusal(
        "An independently read issue ID/key no longer matches the complete reviewed selection.",
        "conflict",
      );
    values.push({ issueId: result.id, issueKey: result.key });
  }
  return { ok: true, value: { issues: values } };
}
export async function readMaintenanceMutationState(
  request: JiraMutationRequest,
  input: MaintenanceInput,
): Promise<MaintenanceObservation<CatalogJsonObject>> {
  switch (input.kind) {
    case "node":
      return nodeState(request, input.nodeId);
    case "cluster-upgrade":
      return clusterState(request);
    case "snapshot":
      return snapshotState(request);
    case "reindex":
    case "requests":
      return reindexState(request);
    case "upgrade":
      return upgradeState(request);
    case "issues":
      return issueState(request, input);
  }
}
/** ACK IDs are observations. Missing bulk rows stay unreturned, never non-existent or complete. */
function requestRows(
  values: readonly unknown[],
  ids: readonly string[],
): MaintenanceObservation<CatalogJsonObject> {
  if (values.length > TOOL_CATALOG_LIMITS.maxArrayItems)
    return { ok: false, reason: "bounds-exceeded" };
  const selected = new Set(ids);
  const seen = new Set<string>();
  const items: CatalogJsonObject[] = [];
  for (const raw of values) {
    const projected = jiraMaintenanceRequest(raw);
    if (!projected.ok) return projected;
    const id = projected.value.id;
    if (typeof id !== "string" || !selected.has(id) || seen.has(id)) return MAINTENANCE_MALFORMED;
    seen.add(id);
    items.push(projected.value);
  }
  return { ok: true, value: { items } };
}
export async function readMaintenanceRequests(
  request: JiraMutationRequest,
  ids: readonly string[],
): Promise<MaintenanceObservation<CatalogJsonObject>> {
  if (ids.length === 0) return { ok: true, value: { items: [] } };
  const query = new URLSearchParams();
  for (const id of ids) query.append("requestId", id);
  const response = await request(
    `reindex/request/bulk?${query.toString()}`,
    "GET",
    undefined,
    "json-array",
  );
  if (!response.ok) return dispatchFailure(response);
  return response.status === 200 && response.items !== undefined
    ? requestRows(response.items, ids)
    : MAINTENANCE_MALFORMED;
}
