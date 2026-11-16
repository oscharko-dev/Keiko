import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolDeclaration } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { object } from "./jiraManagedSchemas.js";
import {
  jiraNativeDeclaration,
  jiraNativeReadResult,
  type JiraNativeDefinition,
} from "./jiraProjectStructureDescriptors.js";

const LIMIT = {
  type: "integer",
  minimum: Number.MIN_SAFE_INTEGER,
  maximum: Number.MAX_SAFE_INTEGER,
};
function read(description: string, result: CatalogJsonObject): JiraNativeDefinition {
  return {
    description,
    input: object({}),
    result: jiraNativeReadResult(result),
    risk: "read",
    maxResultCount: 1,
  };
}
export const JIRA_RUNTIME_SETTINGS_READ_DEFINITIONS = {
  "jira.jmx-metrics-exposed": read(
    "Observe the native JMX metrics exposure boolean through its fixed read endpoint. Preserve false explicitly; do not infer network reachability, metric contents, monitoring health, actor permissions or a change to configuration. No metric endpoint is followed and no monitoring is started or stopped.",
    { exposed: { type: "boolean" } },
  ),
  "jira.search-max-aggregation-buckets": read(
    "Observe Jira's current maximum search aggregation bucket setting as an exact safe signed integer. Preserve zero and negative native values without interpreting them as unlimited, available quota or authorization. This read does not execute a search or change Jira settings, Keiko budgets or request admission.",
    { limit: LIMIT },
  ),
  "jira.search-max-result-window": read(
    "Observe Jira's current maximum search result window setting as an exact safe signed integer. Preserve zero and negative native values without deriving query validity, unlimited access, available quota or effective permissions. No search executes and neither Jira settings nor Keiko search budgets change.",
    { limit: LIMIT },
  ),
} as const satisfies Readonly<Record<string, JiraNativeDefinition>>;

export function jiraRuntimeSettingsDeclarationForTool(
  name: string,
): ManagedMcpToolDeclaration | undefined {
  const definitions: Readonly<Record<string, JiraNativeDefinition>> =
    JIRA_RUNTIME_SETTINGS_READ_DEFINITIONS;
  const selected = Object.hasOwn(definitions, name) ? definitions[name] : undefined;
  return selected === undefined ? undefined : jiraNativeDeclaration(name, selected);
}
