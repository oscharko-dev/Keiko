import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
  type CatalogJsonValue,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { asArray, asRecord } from "./atlassian-sync-classify.js";
import { jiraNativeId, jiraNativeNumericId, jiraNativeText } from "./jira-native-values.js";
import { projectJiraOptionalFields } from "./jira-managed-metadata.js";

type OptionalProjection = (value: unknown, field: string) => CatalogJsonValue | undefined;
function observedCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
function description(value: unknown): string | undefined {
  return jiraNativeText(value, 32768, true) ? value : undefined;
}
export function jiraScreenProjection(value: unknown): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  const id = jiraNativeNumericId(raw?.id);
  if (raw === undefined || id === undefined || !jiraNativeText(raw.name, 255)) return undefined;
  const extra = projectJiraOptionalFields(raw, ["description", "deletable"], (entry, field) => {
    const flag = typeof entry === "boolean" ? entry : undefined;
    return field === "description" ? description(entry) : flag;
  });
  return extra === undefined ? undefined : { id, name: raw.name, ...extra };
}
function workflowField(value: unknown, field: string): CatalogJsonValue | undefined {
  let projected: CatalogJsonValue | undefined;
  if (field === "description") projected = description(value);
  else if (field === "isDefault") projected = typeof value === "boolean" ? value : undefined;
  else if (field === "steps") {
    const count = observedCount(value);
    projected = count !== undefined && count <= 2147483647 ? count : undefined;
  } else projected = jiraNativeText(value, 255, true) ? value : undefined;
  return projected;
}
export function jiraWorkflowProjection(value: unknown): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  if (raw === undefined || !jiraNativeText(raw.name, 255)) return undefined;
  const extra = projectJiraOptionalFields(
    raw,
    ["description", "lastModifiedDate", "steps", "isDefault"],
    workflowField,
  );
  return extra === undefined ? undefined : { name: raw.name, ...extra };
}
export function jiraCustomFieldId(value: unknown): value is string {
  if (jiraNativeId(value)) return true;
  return (
    typeof value === "string" && value.startsWith("customfield_") && jiraNativeId(value.slice(12))
  );
}
function identifiers(value: unknown): readonly string[] | undefined {
  const values = asArray(value);
  if (values === undefined || values.length > TOOL_CATALOG_LIMITS.maxArrayItems) return undefined;
  const ids = values.map(jiraNativeNumericId);
  return ids.every((id): id is string => id !== undefined) && new Set(ids).size === ids.length
    ? ids
    : undefined;
}
const CUSTOM_FLAGS: ReadonlySet<string> = new Set([
  "isAllProjects",
  "isLocked",
  "isManaged",
  "isTrusted",
]);
const CUSTOM_COUNTS: ReadonlySet<string> = new Set([
  "issuesWithValue",
  "projectsCount",
  "screensCount",
]);
const CUSTOM_FIELDS = [
  "description",
  "type",
  "searcherKey",
  "numericId",
  "isAllProjects",
  "isLocked",
  "isManaged",
  "isTrusted",
  "projectIds",
  "issueTypeIds",
  "issuesWithValue",
  "projectsCount",
  "screensCount",
  "lastValueUpdate",
] as const;
/**
 * Jira Data Center 10.3 reports a field's last value update as epoch milliseconds once a value
 * changed; it is read as that exact UTC instant. Text from other releases stays as observed.
 */
function lastValueUpdate(value: unknown): string | undefined {
  if (typeof value === "string") return jiraNativeText(value, 128) ? value : undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return undefined;
  const instant = new Date(value);
  return Number.isNaN(instant.getTime()) ? undefined : instant.toISOString();
}
const customField: OptionalProjection = (value, field) => {
  let projected: CatalogJsonValue | undefined;
  if (CUSTOM_FLAGS.has(field)) projected = typeof value === "boolean" ? value : undefined;
  else if (CUSTOM_COUNTS.has(field)) projected = observedCount(value);
  else if (field === "numericId") projected = jiraNativeNumericId(value);
  else if (field === "projectIds" || field === "issueTypeIds") projected = identifiers(value);
  else if (field === "description") projected = description(value);
  else if (field === "lastValueUpdate") projected = lastValueUpdate(value);
  else projected = jiraNativeText(value, 1024) ? value : undefined;
  return projected;
};
export function jiraCustomFieldProjection(value: unknown): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  if (raw === undefined || !jiraCustomFieldId(raw.id) || !jiraNativeText(raw.name, 255))
    return undefined;
  const extra = projectJiraOptionalFields(raw, CUSTOM_FIELDS, customField);
  if (extra === undefined) return undefined;
  const identity = raw.id.startsWith("customfield_") ? raw.id.slice(12) : raw.id;
  if (extra.numericId !== undefined && extra.numericId !== identity) return undefined;
  return { id: raw.id, name: raw.name, ...extra };
}
export function jiraTerminologyName(value: unknown): value is "epic" | "sprint" {
  return value === "epic" || value === "sprint";
}
export function jiraTerminologyProjection(value: unknown): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  if (
    raw === undefined ||
    typeof raw.originalName !== "string" ||
    !jiraTerminologyName(raw.originalName.toLowerCase())
  )
    return undefined;
  const extra = projectJiraOptionalFields(
    raw,
    ["originalNamePlural", "newName", "newNamePlural", "isDefault"],
    (entry, field) => {
      const flag = typeof entry === "boolean" ? entry : undefined;
      const text = jiraNativeText(entry, 255) ? entry : undefined;
      return field === "isDefault" ? flag : text;
    },
  );
  return extra === undefined ? undefined : { originalName: raw.originalName, ...extra };
}
export function jiraReadOnlyProjection(value: unknown): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  if (raw === undefined) {
    return undefined;
  }
  return projectJiraOptionalFields(
    raw,
    ["enabled", "message", "endTime", "timeZone"],
    (entry, field) => {
      const max = { enabled: 255, message: 32768, endTime: 128, timeZone: 255 }[field];
      const flag = typeof entry === "boolean" ? entry : undefined;
      const text = jiraNativeText(entry, max, true) ? entry : undefined;
      return field === "enabled" ? flag : text;
    },
  );
}
/** Resource lists and optional nested metadata share the unchanged catalog collection bound. */
export function jiraConfigurationExceedsBounds(value: unknown): boolean {
  const raw = asRecord(value);
  if (raw === undefined) return false;
  return ["projectIds", "issueTypeIds", "childrenIds"].some((key) => {
    const entries = asArray(raw[key]);
    return entries !== undefined && entries.length > TOOL_CATALOG_LIMITS.maxArrayItems;
  });
}
