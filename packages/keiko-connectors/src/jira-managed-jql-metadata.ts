import { JIRA_READ_TOOL_FAMILIES } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
  type CatalogJsonValue,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolResult } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { asArray, asRecord } from "./atlassian-sync-classify.js";
import { boundJiraReadResult } from "./jira-managed-issue-reads.js";
import {
  jiraReadFailure,
  localJiraPage,
  projectJiraOptionalFields,
} from "./jira-managed-metadata.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import {
  executeJiraSelectedRead,
  selectJiraReadPage,
  type JiraReadPageSelection,
  type JiraReadResponse,
} from "./jira-managed-read-request.js";
import { jiraNativeText } from "./jira-native-values.js";

export const JIRA_JQL_METADATA_READS = JIRA_READ_TOOL_FAMILIES.jqlMetadata;
type JqlRead = (typeof JIRA_JQL_METADATA_READS)[number];
export const JIRA_JQL_METADATA_CATEGORIES = ["fields", "functions", "reserved-words"] as const;
type Category = (typeof JIRA_JQL_METADATA_CATEGORIES)[number];
const COLLECTIONS: Readonly<Record<Category, string>> = {
  fields: "visibleFieldNames",
  functions: "visibleFunctionNames",
  "reserved-words": "jqlReservedWords",
};
const SCOPES: Readonly<Record<Category, string>> = {
  fields: "visible-fields",
  functions: "visible-functions",
  "reserved-words": "reserved-words",
};
const METADATA_ARGS: ReadonlySet<string> = new Set(["category", "startAt", "maxResults"]);
const SUGGESTION_ARGS: ReadonlySet<string> = new Set([
  "fieldName",
  "fieldValue",
  "predicateName",
  "predicateValue",
  "startAt",
  "maxResults",
]);
const PREDICATES: ReadonlySet<string> = new Set(["by", "from", "to"]);
interface Selection extends JiraReadPageSelection {
  readonly path: string;
  readonly category: Category | "suggestions";
  readonly collection: string;
  readonly metadataScope: string;
  readonly context: CatalogJsonObject;
}
function category(value: unknown): value is Category {
  return typeof value === "string" && Object.hasOwn(COLLECTIONS, value);
}
function metadataSelection(args: CatalogJsonObject): Selection | undefined {
  const page = selectJiraReadPage(args, METADATA_ARGS);
  if (page === undefined || !category(args.category)) return undefined;
  return {
    ...page,
    path: "jql/autocompletedata",
    category: args.category,
    collection: COLLECTIONS[args.category],
    metadataScope: SCOPES[args.category],
    context: {},
  };
}
function predicate(args: CatalogJsonObject): CatalogJsonObject | undefined {
  const name = args.predicateName;
  const value = args.predicateValue;
  if (name === undefined) return value === undefined ? {} : undefined;
  if (
    typeof name !== "string" ||
    !PREDICATES.has(name) ||
    (value !== undefined && !jiraNativeText(value, 2048, true))
  )
    return undefined;
  return { predicateName: name, ...(typeof value === "string" ? { predicateValue: value } : {}) };
}
function suggestionSelection(args: CatalogJsonObject): Selection | undefined {
  const page = selectJiraReadPage(args, SUGGESTION_ARGS);
  const selectedPredicate = predicate(args);
  const fieldValue = args.fieldValue === undefined ? "" : args.fieldValue;
  if (
    page === undefined ||
    selectedPredicate === undefined ||
    !jiraNativeText(args.fieldName, 255) ||
    !jiraNativeText(fieldValue, 2048, true)
  )
    return undefined;
  const context = { fieldName: args.fieldName, fieldValue, ...selectedPredicate };
  const query = new URLSearchParams({ fieldName: args.fieldName, fieldValue });
  for (const key of ["predicateName", "predicateValue"] as const) {
    const value = selectedPredicate[key];
    if (typeof value === "string") query.set(key, value);
  }
  // Native suggestions have no offset. Paging only selects the returned, bounded collection.
  return {
    ...page,
    path: `jql/autocompletedata/suggestions?${query.toString()}`,
    category: "suggestions",
    collection: "results",
    metadataScope: "native-suggestions",
    context,
  };
}
function stringValues(value: unknown): readonly string[] | undefined {
  const values = asArray(value);
  return values !== undefined &&
    values.length <= TOOL_CATALOG_LIMITS.maxArrayItems &&
    values.every((item): item is string => jiraNativeText(item, 255))
    ? values
    : undefined;
}
function fieldDetails(raw: Record<string, unknown>): CatalogJsonObject | undefined {
  const flags = projectJiraOptionalFields(raw, ["auto", "orderable", "searchable"], nativeFlag);
  const cfid = projectJiraOptionalFields(raw, ["cfid"], (value) =>
    jiraNativeText(value, 128) ? value : undefined,
  );
  const operators = projectJiraOptionalFields(raw, ["operators"], stringValues);
  return flags === undefined || cfid === undefined || operators === undefined
    ? undefined
    : { ...flags, ...cfid, ...operators };
}
/** Native autocomplete DTOs encode these flags as text; admit actual boolean producers too. */
function nativeFlag(value: unknown): boolean | undefined {
  if (value !== "true" && value !== "false" && typeof value !== "boolean") return undefined;
  return value === true || value === "true";
}
function completion(value: unknown, kind: Selection["category"]): CatalogJsonObject | undefined {
  if (kind === "reserved-words") return jiraNativeText(value, 255) ? { value } : undefined;
  const raw = asRecord(value);
  if (raw === undefined || !jiraNativeText(raw.value, 2048)) return undefined;
  const result: Record<string, CatalogJsonValue> = { value: raw.value };
  // displayName contains native highlighting HTML. Exact value is the plain, usable suggestion.
  if (kind === "suggestions") return result;
  const types = projectJiraOptionalFields(raw, ["types"], stringValues);
  const fields = kind === "fields" ? fieldDetails(raw) : {};
  return types === undefined || fields === undefined
    ? undefined
    : { ...result, ...types, ...fields };
}
function exceedsBounds(value: unknown): boolean {
  const raw = asRecord(value);
  return ["types", "operators"].some((field) => {
    const values = asArray(raw?.[field]);
    return values !== undefined && values.length > TOOL_CATALOG_LIMITS.maxArrayItems;
  });
}
function projectResponse(response: JiraReadResponse, selected: Selection): ManagedMcpToolResult {
  const values = asArray(response.body?.[selected.collection]);
  if (values === undefined) return jiraReadFailure("malformed-payload");
  if (values.length > TOOL_CATALOG_LIMITS.maxArrayItems || values.some(exceedsBounds))
    return jiraReadFailure("bounds-exceeded");
  const items: CatalogJsonObject[] = [];
  for (const value of values) {
    const item = completion(value, selected.category);
    if (item === undefined) return jiraReadFailure("malformed-payload");
    items.push(item);
  }
  const page = localJiraPage(items, selected.startAt, selected.maxResults);
  return boundJiraReadResult({
    data: {
      ...page.data,
      category: selected.category,
      metadataScope: selected.metadataScope,
      ...selected.context,
    },
  });
}
export function isJiraJqlMetadataRead(name: string): name is JqlRead {
  return (JIRA_JQL_METADATA_READS as readonly string[]).includes(name);
}
/** Autocomplete is scoped discovery, not query execution, JQL validity or an authority grant. */
export function executeJiraJqlMetadataRead(
  name: JqlRead,
  args: CatalogJsonObject,
  request: JiraMutationRequest,
): Promise<ManagedMcpToolResult> {
  return executeJiraSelectedRead(
    name === "jira.jql-autocomplete" ? metadataSelection(args) : suggestionSelection(args),
    request,
    "json",
    projectResponse,
  );
}
