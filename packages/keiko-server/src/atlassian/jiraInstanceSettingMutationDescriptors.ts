import { type JiraInstanceSettingMutation } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolDeclaration } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { object, text } from "./jiraManagedSchemas.js";
import {
  jiraNativeDeclaration,
  jiraNativeWriteResult,
  type JiraNativeDefinition,
} from "./jiraProjectStructureDescriptors.js";

const NAME = { ...text(255), minLength: 1 };
const BOOL = { type: "boolean" };
const ACCEPT = { type: "boolean", enum: [true] };
const DIGEST = { ...text(64), minLength: 64, pattern: "^[a-f0-9]{64}$" };
const COLUMNS = {
  type: "array",
  minItems: 1,
  maxItems: TOOL_CATALOG_LIMITS.maxArrayItems,
  items: NAME,
};
const KEYS = [
  "jira.clone.prefix",
  "jira.option.voting",
  "jira.option.watching",
  "jira.option.timetracking",
];
const COMMON =
  "High-risk issue-tracker.admin action through existing authority, approval and durable journal owners; ordinary issue write scope is insufficient. Independently rebind the exact actor and reviewed current setting before one fixed native PUT, then re-read actual configuration. Native Jira separately checks system/administration permissions. No input changes stored credentials, connection destination, compatibility or deployment ceiling. Pre-reads are not atomic compare-and-swap. Unknown/lost acknowledgement retains requested target facts only and must not be replayed. Receipt values are private bounded configuration facts, never log bodies; property values and URLs are represented only by SHA256 of their exact native string. The existing 16 KiB receipt limit is enforced before requests, including complete ordered column IDs.";
function write(
  description: string,
  input: CatalogJsonObject,
  receipt: CatalogJsonObject,
): JiraNativeDefinition {
  return {
    description: `${description} ${COMMON}`,
    input,
    result: jiraNativeWriteResult({ userKey: NAME, ...receipt }),
    risk: "write",
    maxResultCount: 1,
  };
}
function unconfirmed(definition: JiraNativeDefinition): JiraNativeDefinition {
  return {
    ...definition,
    result: {
      ...definition.result,
      allOf: [
        {
          not: {
            properties: { outcome: { type: "string", enum: ["succeeded"] } },
            required: ["outcome"],
          },
        },
      ],
    },
  };
}
export const JIRA_INSTANCE_SETTING_WRITE_DEFINITIONS = {
  "jira.set-application-property": write(
    "Set only one of the existing four nonsecret application properties. jira.clone.prefix uses literal string values (empty permitted, <=4096); voting/watching/timetracking require actual typed booleans, never truthy strings. Both expectedValue and value have the selected key's type. Native body is exactly {id:propertyKey,value:STRING}; Boolean false is sent as string false. Read the selected exact key, accepting native object or one-element array; missing/null values are unavailable. Confirmation establishes only the observed setting, not every feature behavior.",
    {
      ...object(
        {
          expectedActorKey: NAME,
          propertyKey: { type: "string", enum: KEYS },
          expectedValue: { anyOf: [text(4096), BOOL] },
          value: { anyOf: [text(4096), BOOL] },
        },
        ["expectedActorKey", "propertyKey", "expectedValue", "value"],
      ),
      anyOf: [
        {
          properties: {
            propertyKey: { type: "string", enum: ["jira.clone.prefix"] },
            expectedValue: text(4096),
            value: text(4096),
          },
        },
        {
          properties: {
            propertyKey: { type: "string", enum: KEYS.slice(1) },
            expectedValue: BOOL,
            value: BOOL,
          },
        },
      ],
    },
    { propertyKey: { type: "string", enum: KEYS }, valueDigest: DIGEST },
  ),
  "jira.set-system-columns": write(
    "Set the global default issue-navigator columns using the primary-documented JSON ColumnsBean overload. expectedColumns and columns are full nonempty sequences, with native order and repeated IDs preserved. Compare the complete settings/columns array; no local page, subset, user or filter layout may replace it. Every desired ID must appear with navigable:true in the complete native field catalog at preflight and before dispatch; unknown, missing/null or false eligibility refuses. Confirm only the independently observed exact system sequence, not every user's visible layout.",
    object({ expectedActorKey: NAME, expectedColumns: COLUMNS, columns: COLUMNS }, [
      "expectedActorKey",
      "expectedColumns",
      "columns",
    ]),
    { columnIds: COLUMNS },
  ),
  "jira.set-instance-base-url": unconfirmed(
    write(
      "Change Jira's instance-wide configured base URL with explicit confirmInstanceWide:true. Review expectedBaseUrl exactly as the native serverInfo field (or the safe comparison-only configuredBaseUrl read fact); HTTP is allowed only for that current metadata. The desired configuredBaseUrl must be HTTPS without credentials, query or fragment. Send a JSON scalar string, never an object or a new request destination. Independently read serverInfo using the unchanged trusted connection. Even a matching observed value always remains unconfirmed for global/proxy/notification consequences. A returned baseUrlDigest is the requested target only.",
      object(
        {
          expectedActorKey: NAME,
          expectedBaseUrl: { ...text(2048), minLength: 1 },
          configuredBaseUrl: { ...text(2048), minLength: 1 },
          confirmInstanceWide: ACCEPT,
        },
        ["expectedActorKey", "expectedBaseUrl", "configuredBaseUrl", "confirmInstanceWide"],
      ),
      { baseUrlDigest: DIGEST },
    ),
  ),
  "jira.set-read-only-mode": write(
    "Set only the native enabled Boolean after reviewing expectedEnabled and accepting confirmInstanceWide:true. Missing/null enabled is unavailable, never false. Body is exactly {enabled}; no banner message/endTime/timeZone edits are exposed. The published ReadOnlyModeUpdateRequest contract leaves all three banner fields unchanged when omitted; empty strings would reset/clear them and are never synthesized. Independent Boolean readback can confirm configuration only; it never guarantees that every effective write path is blocked or unblocked.",
    object(
      { expectedActorKey: NAME, expectedEnabled: BOOL, enabled: BOOL, confirmInstanceWide: ACCEPT },
      ["expectedActorKey", "expectedEnabled", "enabled", "confirmInstanceWide"],
    ),
    { readOnlyEnabled: BOOL },
  ),
} as const satisfies Readonly<Record<JiraInstanceSettingMutation, JiraNativeDefinition>>;
export function jiraInstanceSettingMutationDeclarationForTool(
  name: string,
): ManagedMcpToolDeclaration | undefined {
  const definitions: Readonly<Record<string, JiraNativeDefinition>> =
    JIRA_INSTANCE_SETTING_WRITE_DEFINITIONS;
  const definition = Object.hasOwn(definitions, name) ? definitions[name] : undefined;
  return definition === undefined ? undefined : jiraNativeDeclaration(name, definition);
}
