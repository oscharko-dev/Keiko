import { JIRA_READ_TOOL_FAMILIES } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { TOOL_CATALOG_LIMITS, type CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolResult } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import {
  jiraMaintenanceIndex, jiraMaintenanceNode, jiraMaintenanceSnapshot, jiraMaintenanceUpgrade,
  type JiraMaintenanceProjection,
} from "./jira-maintenance-values.js";
import { boundJiraReadResult } from "./jira-managed-issue-reads.js";
import { jiraReadFailure, localJiraPage } from "./jira-managed-metadata.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { executeJiraSelectedRead, selectJiraReadPage, type JiraReadResponse } from "./jira-managed-read-request.js";

export const JIRA_MAINTENANCE_READS = JIRA_READ_TOOL_FAMILIES.maintenance;
type MaintenanceRead = (typeof JIRA_MAINTENANCE_READS)[number];
interface Definition {
  readonly path: string;
  readonly project: (value: unknown) => JiraMaintenanceProjection;
}
interface Selection extends Definition {
  readonly startAt: number;
  readonly maxResults: number;
}
const DEFINITIONS: Readonly<Record<MaintenanceRead, Definition>> = {
  "jira.cluster-nodes": { path: "cluster/nodes", project: jiraMaintenanceNode },
  "jira.cluster-upgrade-state": { path: "cluster/zdu/state", project: jiraMaintenanceUpgrade },
  "jira.index-snapshot-status": { path: "index-snapshot/isRunning", project: jiraMaintenanceSnapshot },
  "jira.index-summary": { path: "index/summary", project: jiraMaintenanceIndex },
};
function selection(name: MaintenanceRead, args: CatalogJsonObject): Selection | undefined {
  const allowed = new Set(name === "jira.cluster-nodes" ? ["startAt", "maxResults"] : []);
  const page = selectJiraReadPage(args, allowed);
  return page === undefined ? undefined : { ...page, ...DEFINITIONS[name] };
}
function nodes(response: JiraReadResponse, selected: Selection): ManagedMcpToolResult {
  const values = response.items;
  if (values === undefined) return jiraReadFailure("malformed-payload");
  if (values.length > TOOL_CATALOG_LIMITS.maxArrayItems) return jiraReadFailure("bounds-exceeded");
  const items: CatalogJsonObject[] = [];
  const identities = new Set<string>();
  for (const value of values) {
    const result = selected.project(value);
    if (!result.ok) return jiraReadFailure(result.reason);
    const nodeId = result.value.nodeId;
    if (typeof nodeId !== "string" || identities.has(nodeId)) return jiraReadFailure("malformed-payload");
    identities.add(nodeId);
    items.push(result.value);
  }
  return boundJiraReadResult(localJiraPage(items, selected.startAt, selected.maxResults));
}
function single(response: JiraReadResponse, selected: Selection): ManagedMcpToolResult {
  const result = selected.project(response.body);
  return result.ok
    ? boundJiraReadResult({ data: { outcome: "succeeded", ...result.value } })
    : jiraReadFailure(result.reason);
}
export function isJiraMaintenanceRead(name: string): name is MaintenanceRead {
  return Object.hasOwn(DEFINITIONS, name);
}
/** Read published status once on demand. No maintenance job, remote URL or stored state is touched. */
export function executeJiraMaintenanceRead(
  name: MaintenanceRead,
  args: CatalogJsonObject,
  request: JiraMutationRequest,
): Promise<ManagedMcpToolResult> {
  return executeJiraSelectedRead(selection(name, args), request,
    name === "jira.cluster-nodes" ? "json-array" : "json",
    name === "jira.cluster-nodes" ? nodes : single);
}
