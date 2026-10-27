import type {
  JiraFieldMetadata,
  JiraFieldReference,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolResult } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { asArray, asRecord } from "./atlassian-sync-classify.js";
import { parseJiraFieldMetadata } from "./jira-field-metadata.js";

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
  };
}
export function metadataItems(value: unknown): readonly CatalogJsonObject[] | undefined {
  const parsed = parseJiraFieldMetadata(value);
  return parsed.ok ? parsed.fields.map(fieldProjection) : undefined;
}
export function editMetadataItems(value: unknown): readonly CatalogJsonObject[] | undefined {
  const fields = asRecord(value);
  if (fields === undefined || Object.keys(fields).length > 500) return undefined;
  return metadataItems(
    Object.entries(fields).map(([id, value]) => ({ ...asRecord(value), fieldId: id })),
  );
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
  if (values === undefined || values.length > 100) return undefined;
  const result: CatalogJsonObject[] = [];
  const ids = new Set<unknown>();
  for (const value of values) {
    const item = issueType(value);
    if (item === undefined || ids.has(item.id)) return undefined;
    ids.add(item.id);
    result.push(item);
  }
  return result;
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
function metadataPageMatches(
  body: Record<string, unknown>,
  count: number,
  start: number,
  max: number,
): boolean {
  if (body.start !== start || !integer(body.size, count, max) || typeof body.last !== "boolean")
    return false;
  if (!body.last && count === 0) return false;
  return totalMatches(body.total, start, count, body.last);
}
/** DC createmeta uses start/size/last, unlike Cloud's startAt/maxResults/isLast. */
export function remoteJiraPage(
  body: Record<string, unknown>,
  items: readonly CatalogJsonObject[] | undefined,
  startAt: number,
  maxResults: number,
): ManagedMcpToolResult {
  if (items === undefined || !metadataPageMatches(body, items.length, startAt, maxResults))
    return jiraReadFailure("malformed-payload");
  return {
    data: {
      outcome: "succeeded",
      items,
      startAt,
      ...(typeof body.total === "number" ? { total: body.total } : {}),
      ...(body.last ? {} : { nextStartAt: startAt + items.length }),
    },
  };
}
