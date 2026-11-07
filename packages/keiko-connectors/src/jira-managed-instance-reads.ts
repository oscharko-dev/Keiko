import { JIRA_READ_TOOL_FAMILIES } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
  type CatalogJsonValue,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolResult } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { asArray, asRecord } from "./atlassian-sync-classify.js";
import { jiraDirectoryNumber, jiraDirectoryUser } from "./jira-directory-values.js";
import { boundJiraReadResult } from "./jira-managed-issue-reads.js";
import { jiraReadFailure, localJiraPage } from "./jira-managed-metadata.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { executeJiraSelectedRead, type JiraReadResponse } from "./jira-managed-read-request.js";
import { jiraNativeText } from "./jira-native-values.js";

export const JIRA_INSTANCE_READS = JIRA_READ_TOOL_FAMILIES.instance;
type InstanceRead = (typeof JIRA_INSTANCE_READS)[number];
const READS: ReadonlySet<string> = new Set(JIRA_INSTANCE_READS);
const PATHS: Readonly<Record<InstanceRead, string>> = {
  "jira.server-info": "serverInfo",
  "jira.instance-configuration": "configuration",
  "jira.permission-definitions": "permissions",
  "jira.myself": "myself",
};
interface Selection {
  readonly path: string;
  readonly startAt: number;
  readonly maxResults: number;
}
function selection(name: InstanceRead, args: CatalogJsonObject): Selection | undefined {
  if (name !== "jira.permission-definitions")
    return Object.keys(args).length === 0
      ? { path: PATHS[name], startAt: 0, maxResults: 1 }
      : undefined;
  if (Object.keys(args).some((key) => key !== "startAt" && key !== "maxResults")) return undefined;
  const startAt = jiraDirectoryNumber(args.startAt, 0, 1_000_000);
  const maxResults = jiraDirectoryNumber(args.maxResults, 25, 100, 1);
  return startAt === undefined || maxResults === undefined
    ? undefined
    : { path: PATHS[name], startAt, maxResults };
}
/** Build identifiers can be native integers or decimal strings; never round a JSON number. */
function buildNumber(value: unknown): string | undefined {
  const number = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  return typeof number === "string" &&
    /^(?:0|[1-9]\d{0,18})$/u.test(number) &&
    BigInt(number) <= 9223372036854775807n
    ? number
    : undefined;
}
function releaseNumbers(value: unknown): readonly number[] | undefined {
  const parts = asArray(value);
  return parts !== undefined && parts.length > 0 &&
    parts.length <= TOOL_CATALOG_LIMITS.maxArrayItems &&
    parts.every((part): part is number =>
      typeof part === "number" && Number.isSafeInteger(part) && part >= 0)
    ? parts
    : undefined;
}
function serverInfo(body: Record<string, unknown>): CatalogJsonObject | undefined {
  if (!jiraNativeText(body.version, 128)) return undefined;
  const item: Record<string, CatalogJsonValue> = { version: body.version };
  for (const key of ["serverTitle", "buildPartnerName", "deploymentType"] as const) {
    const value = body[key];
    if (value === undefined || value === null) continue;
    if (!jiraNativeText(value, 255)) return undefined;
    item[key] = value;
  }
  for (const key of ["buildNumber", "databaseBuildNumber"] as const) {
    if (body[key] === undefined || body[key] === null) continue;
    const number = buildNumber(body[key]);
    if (number === undefined) return undefined;
    item[key] = number;
  }
  if (body.versionNumbers !== undefined && body.versionNumbers !== null) {
    const parts = releaseNumbers(body.versionNumbers);
    if (parts === undefined) return undefined;
    item.versionNumbers = parts;
  }
  // Observing this response never updates custody, supported releases or operation availability.
  // Remote base URLs, health-check bodies, clock values and SCM metadata are not projected.
  return item;
}
const FEATURES = [
  "attachmentsEnabled",
  "issueLinkingEnabled",
  "subTasksEnabled",
  "timeTrackingEnabled",
  "unassignedIssuesAllowed",
  "votingEnabled",
  "watchingEnabled",
] as const;
function timeTracking(value: unknown): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  if (raw === undefined) return undefined;
  const item: Record<string, CatalogJsonValue> = {};
  for (const key of ["workingHoursPerDay", "workingDaysPerWeek"] as const) {
    const number = raw[key];
    if (number === undefined || number === null) continue;
    if (
      typeof number !== "number" || !Number.isFinite(number) ||
      number < 0 || number > Number.MAX_SAFE_INTEGER
    )
      return undefined;
    item[key] = number;
  }
  for (const [key, allowed] of [
    ["defaultUnit", new Set(["minute", "hour", "day", "week"])],
    ["timeFormat", new Set(["pretty", "days", "hours"])],
  ] as const) {
    const value = raw[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string" || !allowed.has(value)) return undefined;
    item[key] = value;
  }
  return item;
}
function configuration(body: Record<string, unknown>): CatalogJsonObject | undefined {
  const item: Record<string, CatalogJsonValue> = {};
  for (const key of FEATURES) {
    const value = body[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== "boolean") return undefined;
    item[key] = value;
  }
  if (body.timeTrackingConfiguration !== undefined && body.timeTrackingConfiguration !== null) {
    const tracking = timeTracking(body.timeTrackingConfiguration);
    if (tracking === undefined) return undefined;
    item.timeTrackingConfiguration = tracking;
  }
  return Object.keys(item).length === 0 ? undefined : item;
}
function permissionDefinition(key: string, value: unknown): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  if (!jiraNativeText(key, 255) || raw === undefined) return undefined;
  if (raw.type !== undefined && raw.type !== null && raw.type !== "GLOBAL" && raw.type !== "PROJECT")
    return undefined;
  const item: Record<string, CatalogJsonValue> = { key };
  for (const field of ["id", "key", "name", "type", "description"] as const) {
    const fieldValue = raw[field];
    if (fieldValue === undefined || fieldValue === null) continue;
    if (!jiraNativeText(fieldValue, field === "description" ? 32768 : 255, field === "description"))
      return undefined;
    // The dictionary identity and a separately supplied native key can differ for legacy aliases.
    item[field === "key" ? "nativeKey" : field] = fieldValue;
  }
  // havePermission is deliberately absent: this endpoint describes definitions, not actor rights.
  return item;
}
function permissions(body: Record<string, unknown>, selected: Selection): ManagedMcpToolResult {
  const definitions = asRecord(body.permissions);
  if (definitions === undefined) return jiraReadFailure("malformed-payload");
  const values = Object.entries(definitions);
  if (values.length > TOOL_CATALOG_LIMITS.maxArrayItems) return jiraReadFailure("bounds-exceeded");
  const items: CatalogJsonObject[] = [];
  for (const [key, value] of values) {
    const item = permissionDefinition(key, value);
    if (item === undefined) return jiraReadFailure("malformed-payload");
    items.push(item);
  }
  const page = localJiraPage(items, selected.startAt, selected.maxResults);
  return boundJiraReadResult({ data: { ...page.data, permissionsScope: "definitions" } });
}
function projectResponse(
  name: InstanceRead,
  response: JiraReadResponse,
  selected: Selection,
): ManagedMcpToolResult {
  const body = asRecord(response.body);
  if (body === undefined) return jiraReadFailure("malformed-payload");
  if (name === "jira.permission-definitions") return permissions(body, selected);
  const item =
    name === "jira.server-info"
      ? serverInfo(body)
      : name === "jira.myself"
        ? jiraDirectoryUser(body)
        : configuration(body);
  return item === undefined
    ? jiraReadFailure("malformed-payload")
    : boundJiraReadResult({ data: { outcome: "succeeded", ...item } });
}
export function isJiraInstanceRead(name: string): name is InstanceRead {
  return READS.has(name);
}
/** Fixed observational GETs. No verification state, configuration or permission changes. */
export function executeJiraInstanceRead(
  name: InstanceRead,
  args: CatalogJsonObject,
  request: JiraMutationRequest,
): Promise<ManagedMcpToolResult> {
  return executeJiraSelectedRead(
    selection(name, args),
    request,
    "json",
    (response, selected) => projectResponse(name, response, selected),
  );
}
