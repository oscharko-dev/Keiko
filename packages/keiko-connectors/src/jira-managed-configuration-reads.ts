import { JIRA_READ_TOOL_FAMILIES } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolResult } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { asArray } from "./atlassian-sync-classify.js";
import { jiraDirectoryNumber, jiraDirectoryTotal } from "./jira-directory-values.js";
import {
  jiraConfigurationExceedsBounds,
  jiraCustomFieldProjection,
  jiraReadOnlyProjection,
  jiraScreenProjection,
  jiraTerminologyName,
  jiraTerminologyProjection,
  jiraWorkflowProjection,
} from "./jira-configuration-values.js";
import { jiraCustomFieldOptionProjection } from "./jira-managed-field-directory.js";
import { boundJiraReadResult } from "./jira-managed-issue-reads.js";
import {
  jiraReadFailure,
  localJiraPage,
  projectJiraCollection,
  remoteJiraPage,
} from "./jira-managed-metadata.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import {
  executeJiraSelectedRead,
  selectJiraReadPage,
  type JiraReadPageSelection,
  type JiraReadResponse,
} from "./jira-managed-read-request.js";
import { jiraNativeId, jiraNativeText } from "./jira-native-values.js";

export const JIRA_CONFIGURATION_READS = JIRA_READ_TOOL_FAMILIES.configuration;
type ConfigurationRead = (typeof JIRA_CONFIGURATION_READS)[number];
interface Selection extends JiraReadPageSelection {
  readonly name: ConfigurationRead;
  readonly path: string;
  readonly expectedName?: string;
  readonly customFieldId?: string;
  readonly page?: number;
  readonly allContexts?: boolean;
}
const PAGE_ARGS: ReadonlySet<string> = new Set(["startAt", "maxResults", "search"]);
const OPTION_ARGS: ReadonlySet<string> = new Set([
  "customFieldId",
  "page",
  "maxResults",
  "projectIds",
  "issueTypeIds",
  "query",
  "useAllContexts",
  "sortByOptionName",
]);
function pagedSelection(name: ConfigurationRead, args: CatalogJsonObject): Selection | undefined {
  const page = selectJiraReadPage(args, PAGE_ARGS);
  if (page === undefined || (args.search !== undefined && !jiraNativeText(args.search, 255, true)))
    return undefined;
  const query = new URLSearchParams({
    startAt: String(page.startAt),
    maxResults: String(page.maxResults),
  });
  if (typeof args.search === "string") query.set("search", args.search);
  const root = name === "jira.screens" ? "screens" : "customFields";
  return { name, ...page, path: `${root}?${query.toString()}` };
}
function workflowSelection(args: CatalogJsonObject): Selection | undefined {
  const named = args.workflowName !== undefined;
  const page = selectJiraReadPage(
    args,
    new Set(named ? ["workflowName"] : ["startAt", "maxResults"]),
  );
  if (page === undefined || (named && !jiraNativeText(args.workflowName, 255))) return undefined;
  return typeof args.workflowName === "string"
    ? {
        name: "jira.workflows",
        ...page,
        path: `workflow?${new URLSearchParams({ workflowName: args.workflowName }).toString()}`,
        expectedName: args.workflowName,
      }
    : { name: "jira.workflows", ...page, path: "workflow" };
}
function contextIds(args: CatalogJsonObject, query: URLSearchParams): boolean {
  for (const key of ["projectIds", "issueTypeIds"] as const) {
    if (args[key] === undefined) continue;
    const values = asArray(args[key]);
    if (
      args.useAllContexts === true ||
      values === undefined ||
      values.length === 0 ||
      values.length > TOOL_CATALOG_LIMITS.maxArrayItems
    )
      return false;
    if (!values.every(jiraNativeId) || new Set(values).size !== values.length) return false;
    for (const id of values) query.append(key, id);
  }
  return true;
}
function optionFilters(args: CatalogJsonObject, query: URLSearchParams): boolean {
  if (args.query !== undefined) {
    if (!jiraNativeText(args.query, 255, true)) return false;
    query.set("query", args.query);
  }
  for (const key of ["useAllContexts", "sortByOptionName"] as const) {
    if (args[key] === undefined) continue;
    if (typeof args[key] !== "boolean") return false;
    query.set(key, String(args[key]));
  }
  return contextIds(args, query);
}
function optionsSelection(args: CatalogJsonObject): Selection | undefined {
  if (Object.keys(args).some((key) => !OPTION_ARGS.has(key)) || !jiraNativeId(args.customFieldId))
    return undefined;
  const page = jiraDirectoryNumber(args.page, 1, 10000, 1);
  const maxResults = jiraDirectoryNumber(args.maxResults, 25, 100, 1);
  if (page === undefined || maxResults === undefined) return undefined;
  const query = new URLSearchParams({ page: String(page), maxResults: String(maxResults) });
  if (!optionFilters(args, query)) return undefined;
  return {
    name: "jira.custom-field-options",
    path: `customFields/${args.customFieldId}/options?${query.toString()}`,
    startAt: 0,
    maxResults,
    page,
    customFieldId: args.customFieldId,
    allContexts: args.useAllContexts === true,
  };
}
function terminologySelection(
  name: ConfigurationRead,
  args: CatalogJsonObject,
): Selection | undefined {
  const list = name === "jira.terminology";
  const page = selectJiraReadPage(
    args,
    new Set(list ? ["startAt", "maxResults"] : ["originalName"]),
  );
  if (page === undefined) return undefined;
  if (list) return { name, ...page, path: "terminology/entries" };
  return jiraTerminologyName(args.originalName)
    ? {
        name,
        ...page,
        path: `terminology/entries/${args.originalName}`,
        expectedName: args.originalName,
      }
    : undefined;
}
function selection(name: ConfigurationRead, args: CatalogJsonObject): Selection | undefined {
  switch (name) {
    case "jira.screens":
    case "jira.custom-fields":
      return pagedSelection(name, args);
    case "jira.workflows":
      return workflowSelection(args);
    case "jira.custom-field-options":
      return optionsSelection(args);
    case "jira.terminology":
    case "jira.terminology-entry":
      return terminologySelection(name, args);
    case "jira.read-only-mode":
      return Object.keys(args).length === 0
        ? { name, path: "readonly-mode", startAt: 0, maxResults: 1 }
        : undefined;
  }
}
function bounded(
  values: readonly unknown[] | undefined,
  maximum: number,
): ManagedMcpToolResult | undefined {
  if (values === undefined) return jiraReadFailure("malformed-payload");
  return values.length > maximum || values.some(jiraConfigurationExceedsBounds)
    ? jiraReadFailure("bounds-exceeded")
    : undefined;
}
/** Adapt the documented screens/values envelope; absent terminal metadata remains unknown. */
function nativePage(
  body: Record<string, unknown>,
  items: readonly CatalogJsonObject[],
  selected: Selection,
): ManagedMcpToolResult {
  const total = body.total === null ? undefined : body.total;
  const size = jiraDirectoryNumber(body.maxResults, -1, selected.maxResults, items.length);
  if (body.startAt !== selected.startAt || size === undefined)
    return jiraReadFailure("malformed-payload");
  if (body.isLast === undefined && total === undefined)
    return boundJiraReadResult({
      data: { outcome: "succeeded", items, startAt: selected.startAt },
    });
  const isLast =
    body.isLast === undefined && typeof total === "number"
      ? selected.startAt + items.length >= total
      : body.isLast;
  return boundJiraReadResult(
    remoteJiraPage({ ...body, total, isLast }, items, selected.startAt, selected.maxResults),
  );
}
function metadataPage(response: JiraReadResponse, selected: Selection): ManagedMcpToolResult {
  const body = response.body;
  const values = asArray(body?.[selected.name === "jira.screens" ? "screens" : "values"]);
  const refusal = bounded(values, selected.maxResults);
  if (refusal !== undefined) return refusal;
  if (body === undefined || values === undefined) return jiraReadFailure("malformed-payload");
  const items = projectJiraCollection(
    values,
    selected.maxResults,
    selected.name === "jira.screens" ? jiraScreenProjection : jiraCustomFieldProjection,
    "id",
  );
  return items === undefined
    ? jiraReadFailure("malformed-payload")
    : nativePage(body, items, selected);
}
function workflowResult(response: JiraReadResponse, selected: Selection): ManagedMcpToolResult {
  if (selected.expectedName !== undefined) {
    const item = jiraWorkflowProjection(response.body);
    return item?.name === selected.expectedName
      ? boundJiraReadResult(localJiraPage([item], 0, 1))
      : jiraReadFailure("malformed-payload");
  }
  const values = response.items;
  const refusal = bounded(values, TOOL_CATALOG_LIMITS.maxArrayItems);
  if (refusal !== undefined) return refusal;
  const items =
    values === undefined
      ? undefined
      : projectJiraCollection(
          values,
          TOOL_CATALOG_LIMITS.maxArrayItems,
          jiraWorkflowProjection,
          "name",
        );
  return items === undefined
    ? jiraReadFailure("malformed-payload")
    : boundJiraReadResult(localJiraPage(items, selected.startAt, selected.maxResults));
}
function namedTerminology(response: JiraReadResponse, expectedName: string): ManagedMcpToolResult {
  const item = jiraTerminologyProjection(response.body);
  return typeof item?.originalName === "string" && item.originalName.toLowerCase() === expectedName
    ? boundJiraReadResult({ data: { outcome: "succeeded", ...item } })
    : jiraReadFailure("malformed-payload");
}
function terminologyResult(response: JiraReadResponse, selected: Selection): ManagedMcpToolResult {
  if (selected.expectedName !== undefined) return namedTerminology(response, selected.expectedName);
  const values = response.items;
  const refusal = bounded(values, TOOL_CATALOG_LIMITS.maxArrayItems);
  if (refusal !== undefined) return refusal;
  const items: CatalogJsonObject[] = [];
  const names = new Set<string>();
  for (const value of values ?? []) {
    const item = jiraTerminologyProjection(value);
    if (typeof item?.originalName !== "string" || names.has(item.originalName.toLowerCase()))
      return jiraReadFailure("malformed-payload");
    names.add(item.originalName.toLowerCase());
    items.push(item);
  }
  return boundJiraReadResult(localJiraPage(items, selected.startAt, selected.maxResults));
}
function optionsResult(response: JiraReadResponse, selected: Selection): ManagedMcpToolResult {
  const values = asArray(response.body?.options);
  const refusal = bounded(values, selected.maxResults);
  if (refusal !== undefined) return refusal;
  const items: CatalogJsonObject[] = [];
  const ids = new Set<string>();
  for (const value of values ?? []) {
    const projected = jiraCustomFieldOptionProjection(value);
    if (!projected.ok) return jiraReadFailure(projected.reason);
    if (typeof projected.item.id !== "string" || ids.has(projected.item.id))
      return jiraReadFailure("malformed-payload");
    ids.add(projected.item.id);
    items.push(projected.item);
  }
  return optionPage(response, selected, items);
}
function validOptionEnd(total: unknown, end: number, count: number, maximum: number): boolean {
  if (typeof total !== "number") return true;
  if (end < total && count !== maximum) return false;
  return count === 0 || end <= total;
}
function optionPageContext(
  total: unknown,
  hasNext: boolean,
  page: number,
  allContexts: boolean,
): CatalogJsonObject {
  return {
    ...(typeof total === "number" ? { total } : {}),
    ...(hasNext ? { nextPage: page + 1 } : {}),
    optionsScope: allContexts ? "all-field-contexts" : "native-context-options",
  };
}
function optionPage(
  response: JiraReadResponse,
  selected: Selection,
  items: readonly CatalogJsonObject[],
): ManagedMcpToolResult {
  const page = selected.page;
  const total = response.body?.total;
  if (
    page === undefined ||
    selected.customFieldId === undefined ||
    !jiraDirectoryTotal(total, items.length)
  )
    return jiraReadFailure("malformed-payload");
  const end = (page - 1) * selected.maxResults + items.length;
  const hasNext = typeof total === "number" && end < total;
  if (!validOptionEnd(total, end, items.length, selected.maxResults))
    return jiraReadFailure("malformed-payload");
  if (hasNext && page === 10000) return jiraReadFailure("bounds-exceeded");
  // No startAt: a byte-truncated prefix cannot be resumed using native page numbers.
  return boundJiraReadResult({
    data: {
      outcome: "succeeded",
      customFieldId: selected.customFieldId,
      items,
      page,
      maxResults: selected.maxResults,
      ...optionPageContext(total, hasNext, page, selected.allContexts === true),
    },
  });
}
function projectResponse(response: JiraReadResponse, selected: Selection): ManagedMcpToolResult {
  switch (selected.name) {
    case "jira.screens":
    case "jira.custom-fields":
      return metadataPage(response, selected);
    case "jira.workflows":
      return workflowResult(response, selected);
    case "jira.custom-field-options":
      return optionsResult(response, selected);
    case "jira.terminology":
    case "jira.terminology-entry":
      return terminologyResult(response, selected);
    case "jira.read-only-mode": {
      const item = jiraReadOnlyProjection(response.body);
      return item === undefined
        ? jiraReadFailure("malformed-payload")
        : boundJiraReadResult({ data: { outcome: "succeeded", ...item } });
    }
  }
}
export function isJiraConfigurationRead(name: string): name is ConfigurationRead {
  return (JIRA_CONFIGURATION_READS as readonly string[]).includes(name);
}
/** Observed native administration metadata does not grant write authority or alter enforcement. */
export function executeJiraConfigurationRead(
  name: ConfigurationRead,
  args: CatalogJsonObject,
  request: JiraMutationRequest,
): Promise<ManagedMcpToolResult> {
  const selected = selection(name, args);
  const array =
    name === "jira.terminology" ||
    (name === "jira.workflows" && selected?.expectedName === undefined);
  return executeJiraSelectedRead(selected, request, array ? "json-array" : "json", projectResponse);
}
