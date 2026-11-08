import {
  ATLASSIAN_JQL_MAX_CHARS,
  JIRA_READ_TOOL_FAMILIES,
  isSafeAtlassianIdentifier,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type {
  ManagedMcpInvocationContext,
  ManagedMcpToolResult,
} from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { asArray, asRecord } from "./atlassian-sync-classify.js";
import { agileInputId } from "./jira-agile-inputs.js";
import { agileBoard, agileDate } from "./jira-agile-projection.js";
import { jiraAgileRequest } from "./jira-agile-request.js";
import { isJiraFieldId } from "./jira-field-metadata.js";
import type { JiraManagedConnection } from "./jira-managed-connection.js";
import {
  boundJiraReadResult,
  jiraIssueReadResult,
  JIRA_MANAGED_ISSUE_FIELDS,
  JIRA_MANAGED_SEARCH_FIELDS,
} from "./jira-managed-issue-reads.js";
import {
  jiraReadFailure,
  projectJiraCollection,
  projectJiraOptionalFields,
  remoteJiraPage,
} from "./jira-managed-metadata.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import {
  executeJiraSelectedRead,
  selectJiraReadPage,
  type JiraReadPageSelection,
  type JiraReadResponse,
} from "./jira-managed-read-request.js";
import { jiraVersionSummary } from "./jira-managed-versions.js";
import { jiraNativeId, jiraNativeNumericId, jiraNativeText } from "./jira-native-values.js";

export const JIRA_AGILE_CONTEXT_READS = JIRA_READ_TOOL_FAMILIES.agileContext;
type ContextRead = (typeof JIRA_AGILE_CONTEXT_READS)[number];
type Mode = "issues" | "projects" | "versions" | "setting" | "issue" | "estimation";
interface Definition {
  readonly mode: Mode;
  readonly path: string;
  readonly parameters: readonly ("boardId" | "epicId" | "sprintId" | "issueIdOrKey")[];
}
const DEFINITIONS: Readonly<Record<ContextRead, Definition>> = {
  "jira.board-epicless-issues": {
    mode: "issues",
    path: "board/{boardId}/epic/none/issue",
    parameters: ["boardId"],
  },
  "jira.board-epic-issues": {
    mode: "issues",
    path: "board/{boardId}/epic/{epicId}/issue",
    parameters: ["boardId", "epicId"],
  },
  "jira.board-projects": {
    mode: "projects",
    path: "board/{boardId}/project",
    parameters: ["boardId"],
  },
  "jira.board-refined-velocity": {
    mode: "setting",
    path: "board/{boardId}/settings/refined-velocity",
    parameters: ["boardId"],
  },
  "jira.board-sprint-issues": {
    mode: "issues",
    path: "board/{boardId}/sprint/{sprintId}/issue",
    parameters: ["boardId", "sprintId"],
  },
  "jira.board-versions": {
    mode: "versions",
    path: "board/{boardId}/version",
    parameters: ["boardId"],
  },
  "jira.epicless-issues": { mode: "issues", path: "epic/none/issue", parameters: [] },
  "jira.agile-issue": { mode: "issue", path: "issue/{issueIdOrKey}", parameters: ["issueIdOrKey"] },
  "jira.issue-estimation": {
    mode: "estimation",
    path: "issue/{issueIdOrKey}/estimation",
    parameters: ["issueIdOrKey", "boardId"],
  },
};
interface Selection extends JiraReadPageSelection {
  readonly path: string;
  readonly mode: Mode;
  readonly context: CatalogJsonObject;
}
const PAGED: ReadonlySet<Mode> = new Set(["issues", "projects", "versions"]);
/** Context values are closed identifier strings; anything else renders as empty. */
function contextText(context: CatalogJsonObject, key: string): string {
  const value = context[key];
  return typeof value === "string" ? value : "";
}
function allowed(definition: Definition): ReadonlySet<string> {
  const result = new Set<string>(definition.parameters);
  if (PAGED.has(definition.mode)) {
    result.add("startAt");
    result.add("maxResults");
  }
  if (definition.mode === "issues") result.add("jql");
  if (definition.mode === "versions") result.add("released");
  return result;
}
function targets(
  definition: Definition,
  args: CatalogJsonObject,
): { path: string; context: CatalogJsonObject } | undefined {
  let path = definition.path;
  const context: Record<string, string> = {};
  for (const key of definition.parameters) {
    const value = args[key];
    let selected: string | undefined;
    if (key === "issueIdOrKey") {
      if (isSafeAtlassianIdentifier(value)) {
        selected = value;
      } else {
        selected = undefined;
      }
    } else {
      selected = agileInputId(value);
    }
    if (selected === undefined) return undefined;
    context[key] = selected;
    path = path.replace(`{${key}}`, encodeURIComponent(selected));
  }
  return { path, context };
}
function issueQuery(mode: Mode, args: CatalogJsonObject, query: URLSearchParams): boolean {
  if (mode === "issue") {
    query.set("fields", JIRA_MANAGED_ISSUE_FIELDS);
    query.set("updateHistory", "false");
  }
  if (mode !== "issues") return true;
  query.set("fields", JIRA_MANAGED_SEARCH_FIELDS);
  query.set("validateQuery", "true");
  if (args.jql === undefined) return true;
  if (!jiraNativeText(args.jql, ATLASSIAN_JQL_MAX_CHARS)) return false;
  query.set("jql", args.jql);
  return true;
}
function select(name: ContextRead, args: CatalogJsonObject): Selection | undefined {
  const definition = DEFINITIONS[name];
  const page = selectJiraReadPage(args, allowed(definition));
  const target = targets(definition, args);
  if (page === undefined || target === undefined) return undefined;
  const query = new URLSearchParams();
  if (PAGED.has(definition.mode)) {
    query.set("startAt", String(page.startAt));
    query.set("maxResults", String(page.maxResults));
  }
  if (!issueQuery(definition.mode, args, query)) return undefined;
  if (args.released !== undefined) {
    if (typeof args.released !== "boolean") return undefined;
    query.set("released", String(args.released));
  }
  if (definition.mode === "estimation")
    query.set("boardId", contextText(target.context, "boardId"));
  return {
    ...page,
    ...target,
    mode: definition.mode,
    path: target.path + (query.size === 0 ? "" : `?${query.toString()}`),
  };
}
function project(value: unknown): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  const id = jiraNativeNumericId(raw?.id);
  if (
    raw === undefined ||
    id === undefined ||
    !isSafeAtlassianIdentifier(raw.key) ||
    !jiraNativeText(raw.name, 255)
  )
    return undefined;
  const optional = projectJiraOptionalFields(
    raw,
    ["description", "archived"] as const,
    (value, field) => {
      const text = jiraNativeText(value, 32768, true) ? value : undefined;
      const flag = typeof value === "boolean" ? value : undefined;
      return field === "description" ? text : flag;
    },
  );
  return optional === undefined ? undefined : { id, key: raw.key, name: raw.name, ...optional };
}
function version(value: unknown): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  if (raw === undefined) return undefined;
  const normalized: Record<string, unknown> = { ...raw, id: jiraNativeNumericId(raw.id) };
  // Agile examples use ISO instants where Platform examples use calendar dates. Retain the
  // native local calendar date, without changing zones or relaxing the shared summary validator.
  for (const key of ["startDate", "releaseDate"] as const) {
    if (agileDate(raw[key])) normalized[key] = raw[key].slice(0, 10);
  }
  const item = jiraVersionSummary(normalized);
  if (item === undefined) return undefined;
  if (raw.projectId === undefined || raw.projectId === null) return { id: item.versionId, ...item };
  const projectId = jiraNativeNumericId(raw.projectId);
  return projectId === undefined ? undefined : { id: item.versionId, ...item, projectId };
}
function contextResult(
  result: ManagedMcpToolResult,
  context: CatalogJsonObject,
): ManagedMcpToolResult {
  return result.isError === true
    ? result
    : boundJiraReadResult({ ...result, data: { ...result.data, ...context } });
}
function collectionItems(
  values: readonly unknown[] | undefined,
  selected: Selection,
): readonly CatalogJsonObject[] | undefined {
  if (values === undefined) return undefined;
  return projectJiraCollection(
    values,
    selected.maxResults,
    selected.mode === "projects" ? project : version,
    "id",
  );
}
function withoutVersionIds(
  items: readonly CatalogJsonObject[] | undefined,
): readonly CatalogJsonObject[] | undefined {
  return items?.map((item) => {
    const result = { ...item };
    delete result.id;
    return result;
  });
}
function collection(response: JiraReadResponse, selected: Selection): ManagedMcpToolResult {
  const values = asArray(response.body?.values);
  if (values !== undefined && values.length > selected.maxResults)
    return jiraReadFailure("bounds-exceeded");
  const items = collectionItems(values, selected);
  const visible = selected.mode === "versions" ? withoutVersionIds(items) : items;
  const body = response.body ?? {};
  const envelope = body.total === null ? { ...body, total: undefined } : body;
  return contextResult(remoteJiraPage(envelope, visible, selected.startAt, selected.maxResults), {
    ...selected.context,
    collectionScope:
      selected.mode === "projects" ? "visible-board-projects" : "visible-board-versions",
  });
}
function issueIdentity(
  body: Record<string, unknown> | undefined,
  target: unknown,
): CatalogJsonObject | undefined {
  if (
    body === undefined ||
    !jiraNativeId(body.id) ||
    !isSafeAtlassianIdentifier(body.key) ||
    typeof target !== "string"
  )
    return undefined;
  return body.id === target || body.key.toUpperCase() === target.toUpperCase()
    ? { issueId: body.id, issueKey: body.key }
    : undefined;
}
function estimateValue(value: unknown): value is string | number {
  return (
    jiraNativeText(value, 2048, true) ||
    (typeof value === "number" &&
      Number.isFinite(value) &&
      Math.abs(value) <= Number.MAX_SAFE_INTEGER)
  );
}
function estimate(response: JiraReadResponse, selected: Selection): ManagedMcpToolResult {
  const body = response.body;
  if (body === undefined || !isJiraFieldId(body.fieldId))
    return jiraReadFailure("malformed-payload");
  const value = body.value;
  if (value !== undefined && value !== null && !estimateValue(value))
    return jiraReadFailure("malformed-payload");
  return boundJiraReadResult({
    data: {
      outcome: "succeeded",
      ...selected.context,
      fieldId: body.fieldId,
      ...(value === undefined || value === null ? {} : { value }),
    },
  });
}
function issueCollectionContext(selected: Selection): CatalogJsonObject {
  return {
    ...selected.context,
    collectionScope:
      selected.context.boardId === undefined ? "visible-epicless-issues" : "visible-board-issues",
  };
}
function projectResponse(
  response: JiraReadResponse,
  selected: Selection,
  baseUrl: string,
): ManagedMcpToolResult {
  const body = response.body;
  if (body === undefined) return jiraReadFailure("malformed-payload");
  switch (selected.mode) {
    case "projects":
    case "versions":
      return collection(response, selected);
    case "setting":
      return typeof body.value === "boolean"
        ? { data: { outcome: "succeeded", ...selected.context, value: body.value } }
        : jiraReadFailure("malformed-payload");
    case "estimation":
      return estimate(response, selected);
    case "issue":
      return issueIdentity(body, selected.context.issueIdOrKey) === undefined
        ? jiraReadFailure("malformed-payload")
        : jiraIssueReadResult("jira.issue", baseUrl, body, 0, 1);
    case "issues":
      return contextResult(
        jiraIssueReadResult("jira.search", baseUrl, body, selected.startAt, selected.maxResults),
        issueCollectionContext(selected),
      );
  }
}
async function boundBoard(
  selected: Selection,
  request: JiraMutationRequest,
): Promise<ManagedMcpToolResult | undefined> {
  if (selected.mode !== "projects" && selected.mode !== "versions") return undefined;
  const result = await executeJiraSelectedRead(
    { path: `board/${contextText(selected.context, "boardId")}` },
    request,
    "json",
    (response) => {
      const item = agileBoard(response.body);
      return item?.id === selected.context.boardId
        ? { data: { outcome: "succeeded" } }
        : jiraReadFailure("malformed-payload");
    },
  );
  return result.isError === true ? result : undefined;
}
async function bindEstimation(
  selected: Selection,
  request: JiraMutationRequest,
): Promise<Selection | ManagedMcpToolResult> {
  if (selected.mode !== "estimation") return selected;
  const target = contextText(selected.context, "issueIdOrKey");
  const query = new URLSearchParams({ fields: "summary", updateHistory: "false" });
  const result = await executeJiraSelectedRead(
    { path: `issue/${encodeURIComponent(target)}?${query.toString()}` },
    request,
    "json",
    (response) => {
      const identity = issueIdentity(response.body, target);
      return identity === undefined
        ? jiraReadFailure("malformed-payload")
        : { data: { outcome: "succeeded", ...identity } };
    },
  );
  if (result.isError === true) return result;
  const { boardId } = selected.context;
  const { issueId, issueKey } = result.data;
  if (typeof boardId !== "string" || !jiraNativeId(issueId) || !isSafeAtlassianIdentifier(issueKey))
    return jiraReadFailure("malformed-payload");
  return {
    ...selected,
    path: `issue/${issueId}/estimation?${new URLSearchParams({ boardId }).toString()}`,
    context: { boardId, issueId, issueKey },
  };
}
export function isJiraAgileContextRead(name: string): name is ContextRead {
  return (JIRA_AGILE_CONTEXT_READS as readonly string[]).includes(name);
}
/** Native Agile context reads reuse the existing selected connection and bounded request owner. */
export async function executeJiraAgileContextRead(
  name: ContextRead,
  args: CatalogJsonObject,
  context: ManagedMcpInvocationContext,
  connection: JiraManagedConnection,
): Promise<ManagedMcpToolResult> {
  const selected = select(name, args);
  if (selected === undefined) return jiraReadFailure("invalid-input");
  if (connection.deployment !== "data-center") return jiraReadFailure("unsupported-deployment");
  const request = jiraAgileRequest(connection, context);
  const refusal = await boundBoard(selected, request);
  if (refusal !== undefined) return refusal;
  const bound = await bindEstimation(selected, request);
  if (!("path" in bound)) return bound;
  return executeJiraSelectedRead(bound, request, "json", (response, selection) =>
    projectResponse(response, selection, connection.baseUrl),
  );
}
