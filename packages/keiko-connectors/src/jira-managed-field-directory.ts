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

export const JIRA_FIELD_DIRECTORY_READS = ["jira.fields", "jira.custom-field-option"] as const;
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
function field(value: unknown): CatalogJsonObject | undefined {
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
function option(body: Record<string, unknown>, selected: Selection): ManagedMcpToolResult {
  const id = jiraNativeNumericId(body.id);
  const value = body.value;
  if (typeof value === "string" && (value.length > 32768 || !jiraProjectionTextFits(value))) return jiraReadFailure("bounds-exceeded");
  if (id === undefined || id !== selected.optionId || !jiraNativeText(value, 32768, true)) return jiraReadFailure("malformed-payload");
  const result: Record<string, CatalogJsonValue> = { outcome: "succeeded", id, value };
  if (body.disabled !== undefined && body.disabled !== null) {
    if (typeof body.disabled !== "boolean") return jiraReadFailure("malformed-payload");
    result.disabled = body.disabled;
  }
  if (body.childrenIds !== undefined && body.childrenIds !== null) {
    const values = asArray(body.childrenIds);
    if (values === undefined) return jiraReadFailure("malformed-payload");
    if (values.length > TOOL_CATALOG_LIMITS.maxArrayItems) return jiraReadFailure("bounds-exceeded");
    const children = values.map(jiraNativeNumericId);
    if (!children.every((entry): entry is string => entry !== undefined) || new Set(children).size !== children.length) return jiraReadFailure("malformed-payload");
    result.childrenIds = children;
  }
  return boundJiraReadResult({ data: result });
}
function projectResponse(response: JiraReadResponse, selected: Selection): ManagedMcpToolResult {
  if (selected.optionId !== undefined) return response.body === undefined ? jiraReadFailure("malformed-payload") : option(response.body, selected);
  const values = response.items;
  if (values === undefined) return jiraReadFailure("malformed-payload");
  if (values.length > TOOL_CATALOG_LIMITS.maxArrayItems || values.some((value) => {
    const names = asArray(asRecord(value)?.clauseNames);
    return names !== undefined && names.length > TOOL_CATALOG_LIMITS.maxArrayItems;
  })) return jiraReadFailure("bounds-exceeded");
  const items = projectJiraCollection(values, TOOL_CATALOG_LIMITS.maxArrayItems, field, "id");
  return items === undefined ? jiraReadFailure("malformed-payload") : boundJiraReadResult(localJiraPage(items, selected.startAt, selected.maxResults));
}
export function isJiraFieldDirectoryRead(name: string): name is FieldRead { return READS.has(name); }
/** Native field/schema facts are observations, not writable-field admission or an invented required/default state. */
export function executeJiraFieldDirectoryRead(name: FieldRead, args: CatalogJsonObject, request: JiraMutationRequest): Promise<ManagedMcpToolResult> {
  return executeJiraSelectedRead(selection(name, args), request, name === "jira.fields" ? "json-array" : "json", projectResponse);
}
