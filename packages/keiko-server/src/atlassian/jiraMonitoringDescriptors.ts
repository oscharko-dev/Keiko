import type { ManagedMcpToolDeclaration } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { object } from "./jiraManagedSchemas.js";
import {
  jiraNativeWriteResult,
  jiraNativeDeclaration,
  type JiraNativeDefinition,
} from "./jiraProjectStructureDescriptors.js";

const BOOL = { type: "boolean" };
const STATE_CHANGE = object({ expectedEnabled: BOOL, enabled: BOOL }, [
  "expectedEnabled",
  "enabled",
]);
const EXPECTED_STATE = object({ expectedEnabled: BOOL }, ["expectedEnabled"]);
const MONITORING_RESULT = jiraNativeWriteResult({ monitoringEnabled: BOOL });
const JMX_RESULT = jiraNativeWriteResult({ jmxMetricsExposed: BOOL });

export const JIRA_MONITORING_WRITE_DEFINITIONS = {
  "jira.set-app-monitoring": {
    description:
      "Set the native application-monitoring enabled state after reading it and matching the explicitly reviewed expectedEnabled boolean. Supply the desired enabled boolean. A stale observation refuses; an already equal target reports unchanged without writing. Send at most one native POST and confirm with a fresh independent GET. monitoringEnabled in an unknown or unconfirmed receipt is the requested target, not an observed successful state. Never replay an uncertain write or infer monitoring measurements from this setting.",
    input: STATE_CHANGE,
    result: MONITORING_RESULT,
    risk: "write",
    maxResultCount: 1,
  },
  "jira.set-ipd-monitoring": {
    description:
      "Set the native in-product diagnostics monitoring enabled state after reading it and matching the explicitly reviewed expectedEnabled boolean. Supply the desired enabled boolean. A stale observation refuses; an already equal target reports unchanged without writing. Send at most one native POST and confirm with a fresh independent GET. monitoringEnabled in an unknown or unconfirmed receipt is the requested target, not an observed successful state. No diagnostic contents or measurements are retrieved and uncertain writes are never replayed.",
    input: STATE_CHANGE,
    result: MONITORING_RESULT,
    risk: "write",
    maxResultCount: 1,
  },
  "jira.start-jmx-metrics": {
    description:
      "Enable native JMX metric exposure only after reading its boolean state and matching the explicitly reviewed expectedEnabled value. This operation changes an instance-wide exposure setting. An already enabled state reports unchanged without writing. Send at most one fixed POST, then require an independent GET to confirm true. jmxMetricsExposed in an unknown or unconfirmed receipt is only the requested target; no metric contents, remote endpoint or successful exposure are inferred, and uncertain writes are never replayed.",
    input: EXPECTED_STATE,
    result: JMX_RESULT,
    risk: "write",
    maxResultCount: 1,
  },
  "jira.stop-jmx-metrics": {
    description:
      "Disable native JMX metric exposure only after reading its boolean state and matching the explicitly reviewed expectedEnabled value. An already disabled state reports unchanged without writing. Send at most one fixed POST, then require an independent GET to confirm false. jmxMetricsExposed in an unknown or unconfirmed receipt is only the requested target; it does not establish that exposure stopped. Never replay an uncertain write or infer a change to unrelated monitoring configuration.",
    input: EXPECTED_STATE,
    result: JMX_RESULT,
    risk: "write",
    maxResultCount: 1,
  },
} as const satisfies Readonly<Record<string, JiraNativeDefinition>>;

export function jiraMonitoringDeclarationForTool(
  name: string,
): ManagedMcpToolDeclaration | undefined {
  const definitions: Readonly<Record<string, JiraNativeDefinition>> =
    JIRA_MONITORING_WRITE_DEFINITIONS;
  const selected = Object.hasOwn(definitions, name) ? definitions[name] : undefined;
  return selected === undefined ? undefined : jiraNativeDeclaration(name, selected);
}
