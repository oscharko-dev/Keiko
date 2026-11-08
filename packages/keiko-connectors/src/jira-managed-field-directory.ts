import { JIRA_READ_TOOL_FAMILIES } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { TOOL_CATALOG_LIMITS, type CatalogJsonObject, type CatalogJsonValue } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolResult } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { asArray, asRecord } from "./atlassian-sync-classify.js";
import { isJiraFieldId } from "./jira-field-metadata.js";
import { jiraProjectionTextFits } from "./jira-managed-field-reads.js";
import { boundJiraReadResult } from "./jira-managed-issue-reads.js";
import { jiraReadFailure, localJiraPage, projectJiraCollection } from "./jira-managed-metadata.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { executeJiraSelectedRead, selectJiraReadPage, type JiraReadResponse } from "./jira-managed-read-request.js";
import { jiraNativeId, jiraNativeNumericId, jiraNativeText } from "./jira-native-values.js";

export const JIRA_FIELD_DIRECTORY_READS = JIRA_READ_TOOL_FAMILIES.fieldDirectory;
type FieldRead = (typeof JIRA_FIELD_DIRECTORY_READS)[number];
const READS: ReadonlySet<string> = new Set(JIRA_FIELD_DIRECTORY_READS);
interface Selection { readonly path: string; readonly startAt: number; readonly maxResults: number; readonly optionId?: string; }
function selection(name: FieldRead, args: CatalogJsonObject): Selection | undefined {
  const page = selectJiraReadPage(args, new Set(name === "jira.fields" ? ["startAt", "maxResults"] : ["optionId"]));
  if (page === undefined) return undefined;
  return name === "jira.fields" ? { ...page, path: "field" }
    : jiraNativeId(args.optionId) ? { ...page, path: `customFieldOption/${args.optionId}`, optionId: args.optionId } : undefined;
}
function schema(value: unknown): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  if (raw === undefined) return undefined;
  const result: Record<string, CatalogJsonValue> = {};
  for (const key of ["type", "items", "system", "custom"] as const) {
    if (raw[key] === undefined || raw[key] === null) continue;
    if (!jiraNativeText(raw[key], key === "custom" ? 1024 : 255)) return undefined;
    result[key] = raw[key];
  }
  if (raw.customId !== undefined && raw.customId !== null) {
    const id = jiraNativeNumericId(raw.customId);
    if (id === undefined) return undefined;
    result.customId = id;
  }
  return result;
}
export function jiraFieldDirectoryProjection(value: unknown): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  if (raw === undefined || !isJiraFieldId(raw.id) || !jiraNativeText(raw.name, 255)) return undefined;
  const result: Record<string, CatalogJsonValue> = { id: raw.id, name: raw.name };
  for (const key of ["custom", "orderable", "navigable", "searchable"] as const) {
    if (raw[key] === undefined || raw[key] === null) continue;
    if (typeof raw[key] !== "boolean") return undefined;
    result[key] = raw[key];
  }
  if (raw.clauseNames !== undefined && raw.clauseNames !== null) {
    const names = asArray(raw.clauseNames);
    if (names === undefined || names.length > TOOL_CATALOG_LIMITS.maxArrayItems ||
      !names.every((name): name is string => jiraNativeText(name, 255)) || new Set(names).size !== names.length) return undefined;
    result.clauseNames = names;
  }
  if (raw.schema !== undefined && raw.schema !== null) {
    const projected = schema(raw.schema);
    if (projected === undefined) return undefined;
    result.schema = projected;
  }
  return result;
}
export type JiraCustomFieldOptionProjection =
  | { readonly ok: true; readonly item: CatalogJsonObject }
  | { readonly ok: false; readonly reason: "bounds-exceeded" | "malformed-payload" };
function optionBase(body: Record<string, unknown>, expectedId?: string): JiraCustomFieldOptionProjection {
  const id = jiraNativeNumericId(body.id);
  const value = body.value;
  if (typeof value === "string" && (value.length > 32768 || !jiraProjectionTextFits(value))) return { ok: false, reason: "bounds-exceeded" };
  if (id === undefined || (expectedId !== undefined && id !== expectedId) || !jiraNativeText(value, 32768, true)) return { ok: false, reason: "malformed-payload" };
  return { ok: true, item: { id, value } };
}
function optionChildren(value: unknown): JiraCustomFieldOptionProjection {
  if (value === undefined || value === null) return { ok: true, item: {} };
  const values = asArray(value);
  if (values === undefined) return { ok: false, reason: "malformed-payload" };
  if (values.length > TOOL_CATALOG_LIMITS.maxArrayItems) return { ok: false, reason: "bounds-exceeded" };
  const children = values.map(jiraNativeNumericId);
  if (!children.every((entry): entry is string => entry !== undefined) || new Set(children).size !== children.length) return { ok: false, reason: "malformed-payload" };
  return { ok: true, item: { childrenIds: children } };
}
function optionDetails(body: Record<string, unknown>): JiraCustomFieldOptionProjection {
  const disabled = body.disabled;
  if (disabled !== undefined && disabled !== null && typeof disabled !== "boolean") return { ok: false, reason: "malformed-payload" };
  const children = optionChildren(body.childrenIds);
  return children.ok ? { ok: true, item: { ...children.item, ...(typeof disabled === "boolean" ? { disabled } : {}) } } : children;
}
/** Shared native option DTO; a selected single resource additionally binds its expected ID. */
export function jiraCustomFieldOptionProjection(value: unknown, expectedId?: string): JiraCustomFieldOptionProjection {
  const body = asRecord(value);
  if (body === undefined) return { ok: false, reason: "malformed-payload" };
  const base = optionBase(body, expectedId);
  if (!base.ok) return base;
  const extra = optionDetails(body);
  return extra.ok ? { ok: true, item: { ...base.item, ...extra.item } } : extra;
}
function option(body: Record<string, unknown>, selected: Selection): ManagedMcpToolResult {
  const projected = jiraCustomFieldOptionProjection(body, selected.optionId);
  return projected.ok ? boundJiraReadResult({ data: { outcome: "succeeded", ...projected.item } })
    : jiraReadFailure(projected.reason);
}
function projectResponse(response: JiraReadResponse, selected: Selection): ManagedMcpToolResult {
  if (selected.optionId !== undefined) return response.body === undefined ? jiraReadFailure("malformed-payload") : option(response.body, selected);
  const values = response.items;
  if (values === undefined) return jiraReadFailure("malformed-payload");
  if (values.length > TOOL_CATALOG_LIMITS.maxArrayItems || values.some((value) => {
    const names = asArray(asRecord(value)?.clauseNames);
    return names !== undefined && names.length > TOOL_CATALOG_LIMITS.maxArrayItems;
  })) return jiraReadFailure("bounds-exceeded");
  const items = projectJiraCollection(values, TOOL_CATALOG_LIMITS.maxArrayItems, jiraFieldDirectoryProjection, "id");
  return items === undefined ? jiraReadFailure("malformed-payload") : boundJiraReadResult(localJiraPage(items, selected.startAt, selected.maxResults));
}
export function isJiraFieldDirectoryRead(name: string): name is FieldRead { return READS.has(name); }
/** Native field/schema facts are observations, not writable-field admission or an invented required/default state. */
export function executeJiraFieldDirectoryRead(name: FieldRead, args: CatalogJsonObject, request: JiraMutationRequest): Promise<ManagedMcpToolResult> {
  return executeJiraSelectedRead(selection(name, args), request, name === "jira.fields" ? "json-array" : "json", projectResponse);
}
