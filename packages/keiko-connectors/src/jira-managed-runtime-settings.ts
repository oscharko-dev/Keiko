import { JIRA_READ_TOOL_FAMILIES } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolResult } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { boundJiraReadResult } from "./jira-managed-issue-reads.js";
import { jiraReadFailure } from "./jira-managed-metadata.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { executeJiraSelectedRead, type JiraReadResponse } from "./jira-managed-read-request.js";

export const JIRA_RUNTIME_SETTINGS_READS = JIRA_READ_TOOL_FAMILIES.runtimeSettings;
type RuntimeRead = (typeof JIRA_RUNTIME_SETTINGS_READS)[number];
interface Selection {
  readonly path: string;
  readonly kind: "exposure" | "limit";
}
const DEFINITIONS: Readonly<Record<RuntimeRead, Selection>> = {
  "jira.jmx-metrics-exposed": { path: "monitoring/jmx/areMetricsExposed", kind: "exposure" },
  "jira.search-max-aggregation-buckets": {
    path: "searchLimits/maxAggregationBuckets",
    kind: "limit",
  },
  "jira.search-max-result-window": { path: "searchLimits/maxResultWindow", kind: "limit" },
};
function projectResponse(response: JiraReadResponse, selected: Selection): ManagedMcpToolResult {
  const value = response.scalar;
  if (selected.kind === "exposure")
    return typeof value === "boolean"
      ? { data: { outcome: "succeeded", exposed: value } }
      : jiraReadFailure("malformed-payload");
  if (typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value))
    return jiraReadFailure("bounds-exceeded");
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    return jiraReadFailure("malformed-payload");
  // Preserve the signed observation without changing Keiko's independently governed search budgets.
  return boundJiraReadResult({ data: { outcome: "succeeded", limit: value } });
}
export function isJiraRuntimeSettingsRead(name: string): name is RuntimeRead {
  return Object.hasOwn(DEFINITIONS, name);
}
/** Fixed scalar settings, observed once on demand; no monitoring, limits or stored state changes. */
export function executeJiraRuntimeSettingsRead(
  name: RuntimeRead,
  args: CatalogJsonObject,
  request: JiraMutationRequest,
): Promise<ManagedMcpToolResult> {
  return executeJiraSelectedRead(
    Object.keys(args).length === 0 ? DEFINITIONS[name] : undefined,
    request,
    "json-scalar",
    projectResponse,
  );
}
