import { JIRA_READ_TOOL_FAMILIES } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolResult } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { asArray } from "./atlassian-sync-classify.js";
import {
  jiraMaintenanceMetricDescription,
  jiraMaintenanceMonitoring,
  jiraMaintenanceReindex,
  jiraMaintenanceRequest,
  jiraMaintenanceSnapshotEntry,
  jiraMaintenanceUpgradeResult,
  type JiraMaintenanceProjection,
} from "./jira-maintenance-values.js";
import { boundJiraReadResult } from "./jira-managed-issue-reads.js";
import { jiraReadFailure, localJiraPage } from "./jira-managed-metadata.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import {
  selectJiraReadPage,
  type JiraReadPageSelection,
  type JiraReadResponse,
} from "./jira-managed-read-request.js";
import type { AtlassianWriteHttpOutcome } from "./atlassian-write-http.js";
import { jiraNativeId } from "./jira-native-values.js";

export const JIRA_JOB_OBSERVATION_READS = JIRA_READ_TOOL_FAMILIES.jobObservations;
type JobRead = (typeof JIRA_JOB_OBSERVATION_READS)[number];
interface Definition {
  readonly path: string;
  readonly mode: "single" | "requests" | "snapshots" | "scalar";
  readonly project: (value: unknown) => JiraMaintenanceProjection;
}
interface Selection extends Definition, JiraReadPageSelection {
  readonly context: CatalogJsonObject;
  readonly requestIds?: readonly string[];
}
const DEFINITIONS: Readonly<Record<JobRead, Definition>> = {
  "jira.reindex-status": { path: "reindex", mode: "single", project: jiraMaintenanceReindex },
  "jira.reindex-progress": {
    path: "reindex/progress",
    mode: "single",
    project: jiraMaintenanceReindex,
  },
  "jira.reindex-request": {
    path: "reindex/request",
    mode: "single",
    project: jiraMaintenanceRequest,
  },
  "jira.reindex-requests": {
    path: "reindex/request/bulk",
    mode: "requests",
    project: jiraMaintenanceRequest,
  },
  "jira.upgrade-result": { path: "upgrade", mode: "single", project: jiraMaintenanceUpgradeResult },
  "jira.index-snapshots": {
    path: "index-snapshot",
    mode: "snapshots",
    project: jiraMaintenanceSnapshotEntry,
  },
  "jira.app-monitoring": {
    path: "monitoring/app",
    mode: "single",
    project: jiraMaintenanceMonitoring,
  },
  "jira.ipd-monitoring": {
    path: "monitoring/ipd",
    mode: "single",
    project: jiraMaintenanceMonitoring,
  },
  "jira.jmx-metrics": {
    path: "monitoring/jmx/getAvailableMetrics",
    mode: "scalar",
    project: jiraMaintenanceMetricDescription,
  },
};
const NO_ARGS = new Set<string>();
const LOCAL_PAGE = new Set(["startAt", "maxResults"]);
const TASK_ARGS = new Set(["taskId"]);
const REQUEST_ARGS = new Set(["requestId"]);
const REQUESTS_ARGS = new Set(["requestIds", "startAt", "maxResults"]);

function taskSelection(definition: Definition, args: CatalogJsonObject): Selection | undefined {
  const page = selectJiraReadPage(args, TASK_ARGS);
  if (page === undefined) return undefined;
  if (args.taskId === undefined)
    return { ...definition, ...page, context: { taskSelection: "active-or-latest" } };
  return jiraNativeId(args.taskId)
    ? {
        ...definition,
        ...page,
        path: `${definition.path}?${new URLSearchParams({ taskId: args.taskId }).toString()}`,
        context: { taskSelection: "selected-task", selectedTaskId: args.taskId },
      }
    : undefined;
}
function requestSelection(definition: Definition, args: CatalogJsonObject): Selection | undefined {
  const page = selectJiraReadPage(args, REQUEST_ARGS);
  return page !== undefined && jiraNativeId(args.requestId)
    ? {
        ...definition,
        ...page,
        path: `${definition.path}/${args.requestId}`,
        context: {},
        requestIds: [args.requestId],
      }
    : undefined;
}
function requestsSelection(definition: Definition, args: CatalogJsonObject): Selection | undefined {
  const page = selectJiraReadPage(args, REQUESTS_ARGS);
  const ids = asArray(args.requestIds);
  if (
    page === undefined ||
    ids === undefined ||
    ids.length === 0 ||
    ids.length > TOOL_CATALOG_LIMITS.maxArrayItems
  )
    return undefined;
  if (!ids.every(jiraNativeId) || new Set(ids).size !== ids.length) return undefined;
  const query = new URLSearchParams();
  // The native Set<Long> parameter uses repeated requestId values, not a CSV or JSON string.
  for (const id of ids) query.append("requestId", id);
  return {
    ...definition,
    ...page,
    path: `${definition.path}?${query.toString()}`,
    context: { requestScope: "selected-requests" },
    requestIds: ids,
  };
}
function selection(name: JobRead, args: CatalogJsonObject): Selection | undefined {
  const definition = DEFINITIONS[name];
  if (name === "jira.reindex-status" || name === "jira.reindex-progress")
    return taskSelection(definition, args);
  if (name === "jira.reindex-request") return requestSelection(definition, args);
  if (name === "jira.reindex-requests") return requestsSelection(definition, args);
  const page = selectJiraReadPage(args, name === "jira.index-snapshots" ? LOCAL_PAGE : NO_ARGS);
  return page === undefined
    ? undefined
    : {
        ...definition,
        ...page,
        context: name === "jira.upgrade-result" ? { upgradeState: "result" } : {},
      };
}
type CollectionRows =
  | {
      readonly ok: true;
      readonly items: readonly CatalogJsonObject[];
      readonly identities: ReadonlySet<string>;
    }
  | { readonly ok: false; readonly reason: "malformed-payload" | "bounds-exceeded" };
function collectionRows(values: readonly unknown[], selected: Selection): CollectionRows {
  if (values.length > TOOL_CATALOG_LIMITS.maxArrayItems)
    return { ok: false, reason: "bounds-exceeded" };
  const items: CatalogJsonObject[] = [];
  const identities = new Set<string>();
  const requested = selected.requestIds === undefined ? undefined : new Set(selected.requestIds);
  const field = selected.mode === "requests" ? "id" : "absolutePath";
  for (const value of values) {
    const result = selected.project(value);
    if (!result.ok) return result;
    const id = result.value[field];
    if (typeof id !== "string" || identities.has(id))
      return { ok: false, reason: "malformed-payload" };
    if (requested !== undefined && !requested.has(id))
      return { ok: false, reason: "malformed-payload" };
    identities.add(id);
    items.push(result.value);
  }
  return { ok: true, items, identities };
}
function collection(response: JiraReadResponse, selected: Selection): ManagedMcpToolResult {
  if (response.items === undefined) return jiraReadFailure("malformed-payload");
  const rows = collectionRows(response.items, selected);
  if (!rows.ok) return jiraReadFailure(rows.reason);
  const page = localJiraPage(rows.items, selected.startAt, selected.maxResults);
  const missing =
    selected.requestIds === undefined
      ? {}
      : {
          requestedRequestIds: selected.requestIds,
          unreturnedRequestIds: selected.requestIds.filter((id) => !rows.identities.has(id)),
        };
  return boundJiraReadResult({ data: { ...page.data, ...selected.context, ...missing } });
}
function single(response: JiraReadResponse, selected: Selection): ManagedMcpToolResult {
  const result = selected.project(selected.mode === "scalar" ? response.scalar : response.body);
  if (!result.ok) return jiraReadFailure(result.reason);
  if (selected.requestIds !== undefined && result.value.id !== selected.requestIds[0])
    return jiraReadFailure("malformed-payload");
  return boundJiraReadResult({
    data: { outcome: "succeeded", ...selected.context, ...result.value },
  });
}
export function isJiraJobObservationRead(name: string): name is JobRead {
  return Object.hasOwn(DEFINITIONS, name);
}
function responseMode(selected: Selection): "json" | "json-array" | "text-scalar" {
  if (selected.mode === "scalar") return "text-scalar";
  return selected.mode === "single" ? "json" : "json-array";
}
function failedResponse(
  name: JobRead,
  selected: Selection,
  response: Extract<AtlassianWriteHttpOutcome, { readonly ok: false }>,
): ManagedMcpToolResult {
  if (
    name === "jira.reindex-status" &&
    selected.path === "reindex" &&
    response.reason === "not-found" &&
    response.httpStatus === 404
  )
    return {
      data: { outcome: "succeeded", taskSelection: "active-or-latest", taskState: "no-prior-task" },
    };
  if (name === "jira.upgrade-result") {
    if (response.httpStatus === 303)
      return { data: { outcome: "succeeded", upgradeState: "running" } };
    if (response.httpStatus === 404)
      return { data: { outcome: "succeeded", upgradeState: "no-prior-result" } };
  }
  return jiraReadFailure(response.reason, response.remote);
}
/** On-demand observations only: never start, poll, resume or alter a maintenance job. */
export async function executeJiraJobObservationRead(
  name: JobRead,
  args: CatalogJsonObject,
  request: JiraMutationRequest,
): Promise<ManagedMcpToolResult> {
  const selected = selection(name, args);
  if (selected === undefined) return jiraReadFailure("invalid-input");
  const response = await request(selected.path, "GET", undefined, responseMode(selected));
  if (!response.ok) return failedResponse(name, selected, response);
  if (response.status !== 200) return jiraReadFailure("malformed-payload");
  return selected.mode === "requests" || selected.mode === "snapshots"
    ? collection(response, selected)
    : single(response, selected);
}
