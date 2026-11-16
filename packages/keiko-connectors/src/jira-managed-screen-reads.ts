import {
  JIRA_READ_TOOL_FAMILIES,
  isSafeAtlassianIdentifier,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolResult } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { asArray, asRecord } from "./atlassian-sync-classify.js";
import { boundJiraReadResult } from "./jira-managed-issue-reads.js";
import { jiraReadFailure, localJiraPage, projectJiraCollection } from "./jira-managed-metadata.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import {
  executeJiraSelectedRead,
  selectJiraReadPage,
  type JiraReadResponse,
} from "./jira-managed-read-request.js";
import { jiraNativeId, jiraNativeText } from "./jira-native-values.js";

export const JIRA_SCREEN_READS = JIRA_READ_TOOL_FAMILIES.screens;
type ScreenRead = (typeof JIRA_SCREEN_READS)[number];
const READS: ReadonlySet<string> = new Set(JIRA_SCREEN_READS);
interface Selection {
  readonly path: string;
  readonly context: CatalogJsonObject;
  readonly startAt: number;
  readonly maxResults: number;
}
function nativeSelection(
  name: ScreenRead,
  args: CatalogJsonObject,
): Pick<Selection, "path" | "context"> | undefined {
  if (!jiraNativeId(args.screenId)) return undefined;
  const root = `screens/${args.screenId}`;
  if (name === "jira.screen-available-fields")
    return { path: `${root}/availableFields`, context: { screenId: args.screenId } };
  if (args.projectKey !== undefined && !isSafeAtlassianIdentifier(args.projectKey))
    return undefined;
  const query =
    args.projectKey === undefined
      ? ""
      : `?${new URLSearchParams({ projectKey: args.projectKey }).toString()}`;
  const context = {
    screenId: args.screenId,
    ...(args.projectKey === undefined ? {} : { projectKey: args.projectKey }),
  };
  if (name === "jira.screen-tabs") return { path: `${root}/tabs${query}`, context };
  return jiraNativeId(args.tabId)
    ? {
        path: `${root}/tabs/${args.tabId}/fields${query}`,
        context: { ...context, tabId: args.tabId },
      }
    : undefined;
}
function selection(name: ScreenRead, args: CatalogJsonObject): Selection | undefined {
  const allowed = new Set(["screenId", "startAt", "maxResults"]);
  if (name !== "jira.screen-available-fields") allowed.add("projectKey");
  if (name === "jira.screen-tab-fields") allowed.add("tabId");
  const page = selectJiraReadPage(args, allowed);
  if (page === undefined) return undefined;
  const native = nativeSelection(name, args);
  return native === undefined ? undefined : { ...native, ...page };
}
export function jiraScreenTabProjection(value: unknown): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  const id = typeof raw?.id === "number" && Number.isSafeInteger(raw.id) ? String(raw.id) : raw?.id;
  return raw !== undefined && jiraNativeId(id) && jiraNativeText(raw.name, 255)
    ? { id, name: raw.name }
    : undefined;
}
function fieldOptions(raw: Record<string, unknown>): CatalogJsonObject | undefined {
  const optional: Record<string, string | boolean> = {};
  if (raw.type !== undefined && raw.type !== null) {
    if (!jiraNativeText(raw.type, 255)) return undefined;
    optional.type = raw.type;
  }
  if (raw.showWhenEmpty !== undefined && raw.showWhenEmpty !== null) {
    if (typeof raw.showWhenEmpty !== "boolean") return undefined;
    optional.showWhenEmpty = raw.showWhenEmpty;
  }
  return optional;
}
export function jiraScreenFieldProjection(value: unknown): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  if (raw === undefined || !isSafeAtlassianIdentifier(raw.id) || !jiraNativeText(raw.name, 255))
    return undefined;
  const options = fieldOptions(raw);
  return options === undefined ? undefined : { id: raw.id, name: raw.name, ...options };
}
export function isJiraScreenRead(name: string): name is ScreenRead {
  return READS.has(name);
}
function projectResponse(
  name: ScreenRead,
  response: JiraReadResponse,
  selected: Selection,
): ManagedMcpToolResult {
  const values = asArray(response.items);
  if (values === undefined) return jiraReadFailure("malformed-payload");
  if (values.length > TOOL_CATALOG_LIMITS.maxArrayItems) return jiraReadFailure("bounds-exceeded");
  const items = projectJiraCollection(
    values,
    TOOL_CATALOG_LIMITS.maxArrayItems,
    name === "jira.screen-tabs" ? jiraScreenTabProjection : jiraScreenFieldProjection,
    "id",
  );
  if (items === undefined) return jiraReadFailure("malformed-payload");
  const page = localJiraPage(items, selected.startAt, selected.maxResults);
  return boundJiraReadResult({ data: { ...page.data, ...selected.context } });
}
/** Native screen membership only; showWhenEmpty is never evidence that a field is required or editable. */
export function executeJiraScreenRead(
  name: ScreenRead,
  args: CatalogJsonObject,
  request: JiraMutationRequest,
): Promise<ManagedMcpToolResult> {
  return executeJiraSelectedRead(
    selection(name, args),
    request,
    "json-array",
    (response, selected) => projectResponse(name, response, selected),
  );
}
