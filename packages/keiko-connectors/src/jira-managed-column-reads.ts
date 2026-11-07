import { JIRA_READ_TOOL_FAMILIES } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolResult } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { asArray, asRecord } from "./atlassian-sync-classify.js";
import { boundJiraReadResult } from "./jira-managed-issue-reads.js";
import { jiraReadFailure, localJiraPage, projectJiraOptionalFields } from "./jira-managed-metadata.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import {
  executeJiraSelectedRead,
  selectJiraReadPage,
  type JiraReadPageSelection,
  type JiraReadResponse,
} from "./jira-managed-read-request.js";
import { jiraNativeId, jiraNativeText } from "./jira-native-values.js";

export const JIRA_COLUMN_READS = JIRA_READ_TOOL_FAMILIES.columns;
type ColumnRead = (typeof JIRA_COLUMN_READS)[number];
const FIELDS: Readonly<Record<ColumnRead, ReadonlySet<string>>> = {
  "jira.system-columns": new Set(["startAt", "maxResults"]),
  "jira.user-columns": new Set(["username", "startAt", "maxResults"]),
  "jira.filter-columns": new Set(["filterId", "startAt", "maxResults"]),
};
const CONFIGURATIONS: ReadonlySet<string> = new Set(["SYSTEM", "EXPLICIT", "FILTER", "USER", "NONE"]);
interface Selection extends JiraReadPageSelection {
  readonly path: string;
  readonly filter: boolean;
  readonly context: CatalogJsonObject;
}
function userSelection(args: CatalogJsonObject, page: JiraReadPageSelection): Selection | undefined {
  if (args.username === undefined)
    return { ...page, path: "user/columns", filter: false, context: { layoutScope: "current-user" } };
  if (!jiraNativeText(args.username, 255)) return undefined;
  return {
    ...page, path: `user/columns?${new URLSearchParams({ username: args.username }).toString()}`,
    filter: false, context: { layoutScope: "named-user", selectedUsername: args.username },
  };
}
function selection(name: ColumnRead, args: CatalogJsonObject): Selection | undefined {
  const page = selectJiraReadPage(args, FIELDS[name]);
  if (page === undefined) return undefined;
  if (name === "jira.system-columns")
    return { ...page, path: "settings/columns", filter: false, context: { layoutScope: "system" } };
  if (name === "jira.user-columns") return userSelection(args, page);
  return jiraNativeId(args.filterId) ? {
    ...page, path: `filter/${args.filterId}/columns`, filter: true,
    context: { layoutScope: "filter", selectedFilterId: args.filterId },
  } : undefined;
}
function option(value: unknown): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  if (raw === undefined || !jiraNativeText(raw.value, 255)) return undefined;
  const label = projectJiraOptionalFields(raw, ["label"],
    (entry) => jiraNativeText(entry, 255, true) ? entry : undefined);
  return label === undefined ? undefined : { value: raw.value, ...label };
}
function layoutField(value: unknown, field: "position" | "columnHeadingKey"): string | number | undefined {
  if (field === "columnHeadingKey") return jiraNativeText(value, 1024, true) ? value : undefined;
  return typeof value === "number" && Number.isInteger(value) &&
    value >= -2147483648 && value <= 2147483647 ? value : undefined;
}
function layoutItem(value: unknown): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  if (raw === undefined || !jiraNativeText(raw.id, 255)) return undefined;
  const fields = projectJiraOptionalFields(raw, ["position", "columnHeadingKey"], layoutField);
  return fields === undefined ? undefined : { id: raw.id, ...fields };
}
export function projectJiraColumnItems(values: readonly unknown[], layout: boolean): readonly CatalogJsonObject[] | undefined {
  if (values.length > TOOL_CATALOG_LIMITS.maxArrayItems) return undefined;
  const items: CatalogJsonObject[] = [];
  for (const value of values) {
    const item = layout ? layoutItem(value) : option(value);
    if (item === undefined) return undefined;
    items.push(item);
  }
  return items;
}
/** Internal complete-layout evidence for writes; selectors and read projections stay unchanged. */
export function projectJiraFilterColumnState(response: JiraReadResponse):
  | { readonly ok: true; readonly columns?: readonly string[]; readonly columnConfig?: string }
  | { readonly ok: false; readonly reason: "malformed-payload" | "bounds-exceeded" } {
  const body = response.body;
  const configuration = response.items === undefined && body !== undefined ? layoutConfiguration(body) : {};
  if (configuration === undefined) return { ok: false, reason: "malformed-payload" };
  const raw = response.items ?? body?.columnLayoutItems;
  const columnConfig = typeof configuration.columnConfig === "string" ? configuration.columnConfig : undefined;
  if (raw === undefined || raw === null) return { ok: true, ...(columnConfig === undefined ? {} : { columnConfig }) };
  if (!Array.isArray(raw)) return { ok: false, reason: "malformed-payload" };
  if (raw.length > TOOL_CATALOG_LIMITS.maxArrayItems) return { ok: false, reason: "bounds-exceeded" };
  const items = projectJiraColumnItems(raw, response.items === undefined);
  if (items === undefined) return { ok: false, reason: "malformed-payload" };
  const fields: string[] = [];
  for (const item of items) {
    const field = response.items === undefined ? item.id : item.value;
    if (typeof field !== "string") return { ok: false, reason: "malformed-payload" };
    fields.push(field);
  }
  return { ok: true, columns: fields, ...(columnConfig === undefined ? {} : { columnConfig }) };
}
function columns(
  values: readonly unknown[],
  selected: Selection,
  layout: boolean,
  configuration: CatalogJsonObject,
): ManagedMcpToolResult {
  if (values.length > TOOL_CATALOG_LIMITS.maxArrayItems) return jiraReadFailure("bounds-exceeded");
  // Keep returned order and repetitions through the same complete-layout projection used by writes.
  const items = projectJiraColumnItems(values, layout);
  if (items === undefined) return jiraReadFailure("malformed-payload");
  const page = localJiraPage(items, selected.startAt, selected.maxResults);
  return boundJiraReadResult({ data: {
    ...page.data, ...selected.context, ...configuration, columnsAvailable: true,
  } });
}
function layoutConfiguration(body: Record<string, unknown>): CatalogJsonObject | undefined {
  const native = body.columnConfig;
  if (typeof native === "string" && CONFIGURATIONS.has(native)) return { columnConfig: native };
  if (native !== undefined && native !== null) return undefined;
  return Object.hasOwn(body, "columnConfig") || Object.hasOwn(body, "columnLayoutItems") ? {} : undefined;
}
function filterLayout(body: Record<string, unknown>, selected: Selection): ManagedMcpToolResult {
  const configuration = layoutConfiguration(body);
  if (configuration === undefined) return jiraReadFailure("malformed-payload");
  if (body.columnLayoutItems === undefined || body.columnLayoutItems === null)
    return { data: {
      outcome: "succeeded", ...selected.context, ...configuration, columnsAvailable: false,
    } };
  const values = asArray(body.columnLayoutItems);
  return values === undefined ? jiraReadFailure("malformed-payload")
    : columns(values, selected, true, configuration);
}
function projectResponse(response: JiraReadResponse, selected: Selection): ManagedMcpToolResult {
  if (response.items !== undefined) return columns(response.items, selected, false, {});
  return selected.filter && response.body !== undefined
    ? filterLayout(response.body, selected) : jiraReadFailure("malformed-payload");
}
export function isJiraColumnRead(name: string): name is ColumnRead {
  return Object.hasOwn(FIELDS, name);
}
/** Read layout configuration only; it does not change visible issue data, permissions or columns. */
export function executeJiraColumnRead(
  name: ColumnRead,
  args: CatalogJsonObject,
  request: JiraMutationRequest,
): Promise<ManagedMcpToolResult> {
  const selected = selection(name, args);
  return executeJiraSelectedRead(
    selected, request, selected?.filter === true ? "json-object-or-array" : "json-array", projectResponse,
  );
}
