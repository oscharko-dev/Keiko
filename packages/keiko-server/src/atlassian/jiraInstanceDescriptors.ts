import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolDeclaration } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { JIRA_DIRECTORY_READ_DEFINITIONS } from "./jiraDirectoryDescriptors.js";
import { object, text } from "./jiraManagedSchemas.js";
import {
  jiraNativeIdentitySchema as POSITIVE_ID,
  jiraNativePagingSchema as PAGING,
  jiraNativeReadResult,
  jiraNativeDeclaration,
  type JiraNativeDefinition,
} from "./jiraProjectStructureDescriptors.js";

const NAME = { ...text(255), minLength: 1 };
const BOOL = { type: "boolean" };
const MAX = TOOL_CATALOG_LIMITS.maxArrayItems;
const BUILD_NUMBER = {
  anyOf: [{ type: "string", enum: ["0"] }, POSITIVE_ID],
  description:
    "Observed canonical decimal build number from 0 through 9223372036854775807; never rounded from an unsafe JSON number.",
};
const SERVER_FIELDS = {
  version: { ...text(128), minLength: 1 },
  versionNumbers: {
    type: "array",
    minItems: 1,
    maxItems: MAX,
    items: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  },
  serverTitle: NAME,
  buildPartnerName: NAME,
  deploymentType: NAME,
  buildNumber: BUILD_NUMBER,
  databaseBuildNumber: BUILD_NUMBER,
  configuredBaseUrlState: { type: "string", enum: ["observed", "unavailable"] },
  configuredBaseUrl: {
    ...text(2048),
    minLength: 1,
    description:
      "Comparison-only observed configuration. Never follow, render as a navigation link or use as the trusted connection URL.",
  },
};
const WORKING_TIME = { type: "number", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const CONFIGURATION_FIELDS = {
  attachmentsEnabled: BOOL,
  issueLinkingEnabled: BOOL,
  subTasksEnabled: BOOL,
  timeTrackingEnabled: BOOL,
  unassignedIssuesAllowed: BOOL,
  votingEnabled: BOOL,
  watchingEnabled: BOOL,
  timeTrackingConfiguration: object({
    workingHoursPerDay: WORKING_TIME,
    workingDaysPerWeek: WORKING_TIME,
    defaultUnit: { type: "string", enum: ["minute", "hour", "day", "week"] },
    timeFormat: { type: "string", enum: ["pretty", "days", "hours"] },
  }),
};
const PERMISSION = object(
  {
    key: NAME,
    nativeKey: NAME,
    id: NAME,
    name: NAME,
    type: { type: "string", enum: ["GLOBAL", "PROJECT"] },
    description: text(32768),
  },
  ["key"],
);
function read(
  description: string,
  input: CatalogJsonObject,
  result: CatalogJsonObject,
  maxResultCount = 1,
): JiraNativeDefinition {
  return { description, input, result: jiraNativeReadResult(result), risk: "read", maxResultCount };
}

export const JIRA_INSTANCE_READ_DEFINITIONS = {
  "jira.server-info": read(
    "Read observed Jira version, deployment and build metadata. These facts do not verify stored credentials, qualify a release, assert API availability or update compatibility state. Keep exact numeric build identities as strings. A safe configuredBaseUrl is comparison-only plain text, with configuredBaseUrlState observed/unavailable; HTTP may be native metadata behind a proxy, never a trusted request or navigation destination. Withhold URL credentials, query, fragment and malformed values. Omit health-check bodies, clocks and SCM details.",
    object({}),
    SERVER_FIELDS,
  ),
  "jira.instance-configuration": read(
    "Read supplied Jira feature flags and time-tracking configuration. Preserve observed false, zero and decimal working-time values; missing fields remain unknown. Configuration does not grant actor permissions, establish operation availability or change any setting.",
    object({}),
    CONFIGURATION_FIELDS,
  ),
  "jira.permission-definitions": read(
    "Inspect and locally page native permission definitions, explicitly not the current actor's effective permissions. Preserve dictionary key separately from an optional native alias. Plugin permission keys are permitted; supplied types remain GLOBAL or PROJECT. No havePermission flag, grant or authority is inferred.",
    object(PAGING),
    {
      permissionsScope: { type: "string", enum: ["definitions"] },
      items: { type: "array", maxItems: 100, items: PERMISSION },
      startAt: PAGING.startAt,
      total: { type: "integer", minimum: 0, maximum: MAX },
      nextStartAt: PAGING.startAt,
    },
    100,
  ),
  "jira.myself": {
    ...JIRA_DIRECTORY_READ_DEFINITIONS["jira.user"],
    description:
      "Read the current authenticated Jira actor using the fixed myself endpoint. Reuse the bounded user projection, preserving observed key/name and optional display/active/deleted facts. No alternate-user selector, email, expanded groups, verification update or permission claim is offered.",
    input: object({}),
  },
} as const satisfies Readonly<Record<string, JiraNativeDefinition>>;

export function jiraInstanceDeclarationForTool(
  name: string,
): ManagedMcpToolDeclaration | undefined {
  const definitions: Readonly<Record<string, JiraNativeDefinition>> =
    JIRA_INSTANCE_READ_DEFINITIONS;
  const selected = Object.hasOwn(definitions, name) ? definitions[name] : undefined;
  return selected === undefined ? undefined : jiraNativeDeclaration(name, selected);
}
