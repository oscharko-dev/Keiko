import { isSafeAtlassianIdentifier } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
  type CatalogJsonValue,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { asArray, asRecord } from "./atlassian-sync-classify.js";
import { jiraProjectionTextFits } from "./jira-managed-field-reads.js";
import { projectJiraCollection } from "./jira-managed-metadata.js";
import { jiraNativeId, jiraNativeNumericId, jiraNativeText } from "./jira-native-values.js";

export type JiraCoreMetadataKind =
  | "issue-type"
  | "priority"
  | "resolution"
  | "status"
  | "status-category"
  | "project-category"
  | "project-type"
  | "project-statuses";

const TEXT_LIMITS: Readonly<Record<string, number>> = {
  name: 255,
  description: 32768,
  statusColor: 128,
  colorName: 128,
  formattedKey: 255,
  descriptionI18nKey: 1024,
  color: 128,
};
function optionalText(
  raw: Record<string, unknown>,
  fields: readonly string[],
): CatalogJsonObject | undefined {
  const result: Record<string, CatalogJsonValue> = {};
  for (const field of fields) {
    const value = raw[field];
    if (value === undefined || value === null) continue;
    if (!jiraNativeText(value, TEXT_LIMITS[field] ?? 255, field === "description")) return undefined;
    result[field] = value;
  }
  return result;
}
function named(raw: Record<string, unknown>): CatalogJsonObject | undefined {
  return jiraNativeId(raw.id) && jiraNativeText(raw.name, 255)
    ? { id: raw.id, name: raw.name } : undefined;
}
function category(raw: Record<string, unknown>): CatalogJsonObject | undefined {
  const id = jiraNativeNumericId(raw.id);
  const text = optionalText(raw, ["name", "colorName"]);
  return id === undefined || !isSafeAtlassianIdentifier(raw.key) || text === undefined
    ? undefined
    : { id, key: raw.key, ...text };
}
function projectType(raw: Record<string, unknown>): CatalogJsonObject | undefined {
  const text = optionalText(raw, ["formattedKey", "descriptionI18nKey", "color"]);
  return !isSafeAtlassianIdentifier(raw.key) || text === undefined
    ? undefined
    : { key: raw.key, ...text };
}
function issueTypeExtras(raw: Record<string, unknown>): CatalogJsonObject | undefined {
  const result: Record<string, CatalogJsonValue> = {};
  if (raw.subtask !== undefined && raw.subtask !== null) {
    if (typeof raw.subtask !== "boolean") return undefined;
    result.subtask = raw.subtask;
  }
  if (raw.avatarId !== undefined && raw.avatarId !== null) {
    const avatarId = jiraNativeNumericId(raw.avatarId);
    if (avatarId === undefined) return undefined;
    result.avatarId = avatarId;
  }
  return result;
}
function statuses(raw: Record<string, unknown>): CatalogJsonObject | undefined {
  if (raw.statuses === undefined || raw.statuses === null) return {};
  const values = asArray(raw.statuses);
  const projected = values === undefined ? undefined : projectJiraCollection(
    values, TOOL_CATALOG_LIMITS.maxArrayItems,
    (value) => jiraCoreMetadataProjection("status", value), "id",
  );
  return projected === undefined ? undefined : { statuses: projected };
}
function extras(kind: JiraCoreMetadataKind, raw: Record<string, unknown>): CatalogJsonObject | undefined {
  if (kind === "issue-type") return issueTypeExtras(raw);
  if (kind === "project-statuses") {
    // This DTO has no avatarId; retain only its documented subtask classification.
    const classification = issueTypeExtras({ subtask: raw.subtask });
    const grouped = statuses(raw);
    return classification === undefined || grouped === undefined
      ? undefined : { ...classification, ...grouped };
  }
  if (kind !== "status" || raw.statusCategory === undefined || raw.statusCategory === null) return {};
  const value = asRecord(raw.statusCategory);
  const projected = value === undefined ? undefined : category(value);
  return projected === undefined ? undefined : { statusCategory: projected };
}

/** Closed native metadata fields only; URLs, icons and arbitrary expansions are never projected. */
export function jiraCoreMetadataProjection(
  kind: JiraCoreMetadataKind,
  value: unknown,
): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  if (raw === undefined) return undefined;
  if (kind === "status-category") return category(raw);
  if (kind === "project-type") return projectType(raw);
  const base = named(raw);
  const fields = kind === "project-statuses" ? []
    : kind === "priority" || kind === "status" ? ["description", "statusColor"]
      : ["description"];
  const text = optionalText(raw, fields);
  const extra = extras(kind, raw);
  return base === undefined || text === undefined || extra === undefined
    ? undefined : { ...base, ...text, ...extra };
}

/** Preserve budget refusal separately from malformed native field types. */
export function jiraCoreMetadataExceedsBounds(kind: JiraCoreMetadataKind, value: unknown): boolean {
  const raw = asRecord(value);
  if (raw === undefined) return false;
  for (const [field, limit] of Object.entries(TEXT_LIMITS)) {
    const text = raw[field];
    if (typeof text === "string" && (text.length > limit || !jiraProjectionTextFits(text))) return true;
  }
  if (kind === "status") return jiraCoreMetadataExceedsBounds("status-category", raw.statusCategory);
  if (kind !== "project-statuses") return false;
  const values = asArray(raw.statuses);
  return values !== undefined && (values.length > TOOL_CATALOG_LIMITS.maxArrayItems ||
    values.some((entry) => jiraCoreMetadataExceedsBounds("status", entry)));
}
