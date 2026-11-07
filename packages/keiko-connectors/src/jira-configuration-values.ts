import { TOOL_CATALOG_LIMITS, type CatalogJsonObject, type CatalogJsonValue } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
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
  const extra = projectJiraOptionalFields(raw, ["description", "deletable"], (entry, field) =>
    field === "description" ? description(entry) : typeof entry === "boolean" ? entry : undefined);
  return extra === undefined ? undefined : { id, name: raw.name, ...extra };
}
function workflowField(value: unknown, field: string): CatalogJsonValue | undefined {
  if (field === "description") return description(value);
  if (field === "isDefault") return typeof value === "boolean" ? value : undefined;
  if (field === "steps") { const count = observedCount(value); return count !== undefined && count <= 2147483647 ? count : undefined; }
  return jiraNativeText(value, 255, true) ? value : undefined;
}
export function jiraWorkflowProjection(value: unknown): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  if (raw === undefined || !jiraNativeText(raw.name, 255)) return undefined;
  const extra = projectJiraOptionalFields(raw, ["description", "lastModifiedDate", "steps", "isDefault"], workflowField);
  return extra === undefined ? undefined : { name: raw.name, ...extra };
}
export function jiraCustomFieldId(value: unknown): value is string {
  if (jiraNativeId(value)) return true;
  return typeof value === "string" && value.startsWith("customfield_") && jiraNativeId(value.slice(12));
}
function identifiers(value: unknown): readonly string[] | undefined {
  const values = asArray(value);
  if (values === undefined || values.length > TOOL_CATALOG_LIMITS.maxArrayItems) return undefined;
  const ids = values.map(jiraNativeNumericId);
  return ids.every((id): id is string => id !== undefined) && new Set(ids).size === ids.length ? ids : undefined;
}
const CUSTOM_FLAGS: ReadonlySet<string> = new Set(["isAllProjects", "isLocked", "isManaged", "isTrusted"]);
const CUSTOM_COUNTS: ReadonlySet<string> = new Set(["issuesWithValue", "projectsCount", "screensCount"]);
const CUSTOM_FIELDS = ["description", "type", "searcherKey", "numericId", "isAllProjects", "isLocked", "isManaged", "isTrusted", "projectIds", "issueTypeIds", "issuesWithValue", "projectsCount", "screensCount", "lastValueUpdate"] as const;
const customField: OptionalProjection = (value, field) => {
  if (CUSTOM_FLAGS.has(field)) return typeof value === "boolean" ? value : undefined;
  if (CUSTOM_COUNTS.has(field)) return observedCount(value);
  if (field === "numericId") return jiraNativeNumericId(value);
  if (field === "projectIds" || field === "issueTypeIds") return identifiers(value);
  if (field === "description") return description(value);
  return jiraNativeText(value, field === "lastValueUpdate" ? 128 : 1024) ? value : undefined;
};
export function jiraCustomFieldProjection(value: unknown): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  if (raw === undefined || !jiraCustomFieldId(raw.id) || !jiraNativeText(raw.name, 255)) return undefined;
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
  if (raw === undefined || typeof raw.originalName !== "string" || !jiraTerminologyName(raw.originalName.toLowerCase())) return undefined;
  const extra = projectJiraOptionalFields(raw, ["originalNamePlural", "newName", "newNamePlural", "isDefault"], (entry, field) =>
    field === "isDefault" ? typeof entry === "boolean" ? entry : undefined : jiraNativeText(entry, 255) ? entry : undefined);
  return extra === undefined ? undefined : { originalName: raw.originalName, ...extra };
}
export function jiraReadOnlyProjection(value: unknown): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  return raw === undefined ? undefined : projectJiraOptionalFields(raw, ["enabled", "message", "endTime", "timeZone"], (entry, field) => {
    if (field === "enabled") return typeof entry === "boolean" ? entry : undefined;
    const max = field === "message" ? 32768 : field === "endTime" ? 128 : 255;
    return jiraNativeText(entry, max, true) ? entry : undefined;
  });
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
