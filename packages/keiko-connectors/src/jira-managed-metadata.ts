import type {
  JiraFieldMetadata,
  JiraFieldReference,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolResult } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { asArray, asRecord } from "./atlassian-sync-classify.js";
import {
  JIRA_METADATA_MAX_FIELDS,
  parseJiraFieldMetadata,
  type JiraMetadataResult,
} from "./jira-field-metadata.js";

export function jiraReadFailure(reason: string): ManagedMcpToolResult {
  return { data: { outcome: "failed", reason }, isError: true };
}
function referenceProjection(value: JiraFieldReference): CatalogJsonObject {
  return {
    ...(value.id === undefined ? {} : { id: value.id }),
    ...(value.name === undefined ? {} : { name: value.name }),
    ...(value.accountId === undefined ? {} : { accountId: value.accountId }),
    ...(value.label === undefined ? {} : { label: value.label }),
  };
}
function fieldProjection(field: JiraFieldMetadata): CatalogJsonObject {
  return {
    id: field.id,
    name: field.name,
    required: field.required,
    hasDefaultValue: field.hasDefaultValue,
    kind: field.kind,
    richText: field.richText,
    operations: [...field.operations],
    ...(field.allowedValues === undefined
      ? {}
      : { allowedValues: field.allowedValues.map(referenceProjection) }),
    ...(field.schemaType === undefined ? {} : { schemaType: field.schemaType }),
  };
}
export function metadataItems(value: unknown): readonly CatalogJsonObject[] | undefined {
  const parsed = parseJiraFieldMetadata(value);
  return parsed.ok ? parsed.fields.map(fieldProjection) : undefined;
}
export function parseJiraFieldMap(value: unknown): JiraMetadataResult {
  const fields = asRecord(value);
  if (fields === undefined) return { ok: false, reason: "malformed-metadata" };
  if (Object.keys(fields).length > JIRA_METADATA_MAX_FIELDS)
    return { ok: false, reason: "bounds-exceeded" };
  return parseJiraFieldMetadata(
    Object.entries(fields).map(([id, value]) => ({ ...asRecord(value), fieldId: id })),
  );
}
export function editMetadataItems(value: unknown): readonly CatalogJsonObject[] | undefined {
  const parsed = parseJiraFieldMap(value);
  return parsed.ok ? parsed.fields.map(fieldProjection) : undefined;
}

function issueType(value: unknown): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  if (
    raw === undefined ||
    typeof raw.id !== "string" ||
    !/^\d{1,32}$/u.test(raw.id) ||
    typeof raw.name !== "string" ||
    raw.name.length === 0 ||
    raw.name.length > 255 ||
    typeof raw.subtask !== "boolean"
  )
    return undefined;
  return { id: raw.id, name: raw.name, subtask: raw.subtask };
}
export function issueTypeItems(value: unknown): readonly CatalogJsonObject[] | undefined {
  const values = asArray(value);
  return values === undefined ? undefined : projectJiraCollection(values, 100, issueType, "id");
}
export function localJiraPage(
  items: readonly CatalogJsonObject[],
  startAt: number,
  maxResults: number,
): ManagedMcpToolResult {
  const page = items.slice(startAt, startAt + maxResults);
  const next = startAt + page.length;
  return {
    data: {
      outcome: "succeeded",
      items: page,
      startAt,
      total: items.length,
      ...(next < items.length ? { nextStartAt: next } : {}),
    },
  };
}
function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}
function totalMatches(total: unknown, start: number, count: number, last: boolean): boolean {
  if (total === undefined) return true;
  if (!integer(total, 0, 1000000)) return false;
  const end = start + count;
  return last === end >= total && (count === 0 || end <= total);
}
/** Normalize known DC page envelopes; never combine fields from different formats. */
export function jiraMetadataPageLast(
  body: Record<string, unknown>,
  count: number,
  start: number,
  max: number,
): boolean | undefined {
  const currentKeys = ["startAt", "maxResults", "isLast"] as const;
  const legacyKeys = ["start", "size", "last"] as const;
  const current = currentKeys.some((key) => Object.hasOwn(body, key));
  if (current && legacyKeys.some((key) => Object.hasOwn(body, key))) return undefined;
  const keys = current ? currentKeys : legacyKeys;
  const [offset, size, last] = keys.map((key) => body[key]);
  if (offset !== start || !integer(size, count, max) || typeof last !== "boolean") return undefined;
  if (!last && count === 0) return undefined;
  return totalMatches(body.total, start, count, last) ? last : undefined;
}
export function remoteJiraPage(
  body: Record<string, unknown>,
  items: readonly CatalogJsonObject[] | undefined,
  startAt: number,
  maxResults: number,
): ManagedMcpToolResult {
  const last =
    items === undefined ? undefined : jiraMetadataPageLast(body, items.length, startAt, maxResults);
  if (items === undefined || last === undefined) return jiraReadFailure("malformed-payload");
  return {
    data: {
      outcome: "succeeded",
      items,
      startAt,
      ...(typeof body.total === "number" ? { total: body.total } : {}),
      ...(last ? {} : { nextStartAt: startAt + items.length }),
    },
  };
}

/** One bounded, identity-unique projection for Jira collection endpoints. */
export function projectJiraCollection(
  values: readonly unknown[],
  max: number,
  project: (value: unknown) => CatalogJsonObject | undefined,
  identity: "id" | "name",
): readonly CatalogJsonObject[] | undefined {
  if (values.length > max) return undefined;
  const projected = values.map(project);
  if (projected.includes(undefined)) return undefined;
  const valid = projected.filter((value) => value !== undefined);
  return new Set(valid.map((value) => value[identity])).size === valid.length ? valid : undefined;
}
