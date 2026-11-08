import { ATLASSIAN_JQL_MAX_CHARS, JIRA_READ_TOOL_FAMILIES, isSafeAtlassianIdentifier } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { TOOL_CATALOG_LIMITS, type CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolResult } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import {
  jiraIssueContextBoundsExceeded, jiraIssuePickerBoundsExceeded, jiraIssuePickerProjection,
  jiraPinnedCommentProjection, jiraRemoteIssueLinkProjection, jiraSubtaskProjection,
  jiraPinnedCommentMembership, jiraRemoteLinkMembership, jiraSubtaskMembership,
} from "./jira-issue-context-values.js";
import { boundJiraReadResult } from "./jira-managed-issue-reads.js";
import { jiraReadFailure, localJiraPage, projectJiraCollection } from "./jira-managed-metadata.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { readJiraBoundProject } from "./jira-managed-projects.js";
import { executeJiraSelectedRead, selectJiraReadPage, type JiraReadPageSelection, type JiraReadResponse } from "./jira-managed-read-request.js";
import { readJiraMutationIssue } from "./jira-mutation-confirmation.js";
import { jiraNativeId, jiraNativeText } from "./jira-native-values.js";
import { projectRemoteLinkSnapshot } from "./jira-remote-link-mutation-values.js";

export const JIRA_ISSUE_CONTEXT_READS = JIRA_READ_TOOL_FAMILIES.issueContext;
type ContextRead = (typeof JIRA_ISSUE_CONTEXT_READS)[number];
type IssueRead = Exclude<ContextRead, "jira.issue-picker">;
const READS: ReadonlySet<string> = new Set(JIRA_ISSUE_CONTEXT_READS);
const ISSUE_FIELDS: Readonly<Record<IssueRead, readonly string[]>> = {
  "jira.pinned-comments": ["issueIdOrKey", "startAt", "maxResults"],
  "jira.subtasks": ["issueIdOrKey", "startAt", "maxResults"],
  "jira.subtask-move-availability": ["issueIdOrKey"],
  "jira.remote-links": ["issueIdOrKey", "globalId", "startAt", "maxResults"],
  "jira.remote-link": ["issueIdOrKey", "linkId"],
};
const SUFFIXES: Readonly<Record<IssueRead, string>> = {
  "jira.pinned-comments": "pinned-comments",
  "jira.subtasks": "subtask",
  "jira.subtask-move-availability": "subtask/move",
  "jira.remote-links": "remotelink",
  "jira.remote-link": "remotelink",
};
interface IssueSelection extends JiraReadPageSelection {
  readonly target: string;
  readonly suffix: string;
  readonly mode: "collection" | "single" | "availability";
  readonly linkId?: string;
  readonly globalId?: string;
}
interface BoundSelection extends IssueSelection {
  readonly path: string;
  readonly context: { readonly issueId: string; readonly issueKey: string };
}
function remoteSelection(name: IssueRead, args: CatalogJsonObject, selected: IssueSelection): IssueSelection | undefined {
  if (name === "jira.remote-link") return jiraNativeId(args.linkId)
    ? { ...selected, mode: "single", suffix: `${selected.suffix}/${args.linkId}`, linkId: args.linkId }
    : undefined;
  if (args.globalId === undefined) return selected;
  if (!jiraNativeText(args.globalId, 2048) || args.startAt !== undefined || args.maxResults !== undefined) return undefined;
  return { ...selected, mode: "single", globalId: args.globalId,
    suffix: `${selected.suffix}?${new URLSearchParams({ globalId: args.globalId }).toString()}` };
}
function selection(name: IssueRead, args: CatalogJsonObject): IssueSelection | undefined {
  const page = selectJiraReadPage(args, new Set(ISSUE_FIELDS[name]));
  if (page === undefined || !isSafeAtlassianIdentifier(args.issueIdOrKey)) return undefined;
  const selected: IssueSelection = { ...page, target: args.issueIdOrKey, suffix: SUFFIXES[name],
    mode: name === "jira.subtask-move-availability" ? "availability" : "collection" };
  return remoteSelection(name, args, selected);
}
function remoteItem(value: unknown, context: BoundSelection["context"]): CatalogJsonObject | undefined {
  const item = jiraRemoteIssueLinkProjection(value);
  if (item === undefined) return undefined;
  const snapshot = projectRemoteLinkSnapshot(value, { id: context.issueId, key: context.issueKey, fields: {} });
  return snapshot === undefined ? { ...item, reviewSnapshotAvailable: false }
    : { ...item, reviewSnapshotAvailable: true, reviewSnapshot: { ...snapshot } };
}
function projection(name: IssueRead, baseUrl: string, context: BoundSelection["context"]): (value: unknown) => CatalogJsonObject | undefined {
  if (name === "jira.pinned-comments") return jiraPinnedCommentProjection;
  if (name === "jira.subtasks") return (value) => jiraSubtaskProjection(value, baseUrl);
  return (value) => remoteItem(value, context);
}
function membership(name: IssueRead, value: unknown, selected: BoundSelection, baseUrl: string): boolean {
  const binding = { ...selected.context, baseUrl };
  if (name === "jira.pinned-comments") return jiraPinnedCommentMembership(value, binding);
  if (name === "jira.subtasks") return jiraSubtaskMembership(value, binding);
  return jiraRemoteLinkMembership(value, binding);
}
function collection(name: IssueRead, response: JiraReadResponse, selected: BoundSelection, baseUrl: string): ManagedMcpToolResult {
  const values = response.items;
  if (values === undefined) return jiraReadFailure("malformed-payload");
  if (values.length > TOOL_CATALOG_LIMITS.maxArrayItems || values.some(jiraIssueContextBoundsExceeded))
    return jiraReadFailure("bounds-exceeded");
  if (values.some((value) => !membership(name, value, selected, baseUrl))) return jiraReadFailure("conflict");
  const project = projection(name, baseUrl, selected.context);
  const items = projectJiraCollection(values, TOOL_CATALOG_LIMITS.maxArrayItems, project, "id");
  if (items === undefined) return jiraReadFailure("malformed-payload");
  const page = localJiraPage(items, selected.startAt, selected.maxResults);
  return boundJiraReadResult({ ...page, data: { ...page.data, ...selected.context } });
}
function selectedLink(response: JiraReadResponse, selected: BoundSelection, baseUrl: string): ManagedMcpToolResult {
  if (jiraIssueContextBoundsExceeded(response.body)) return jiraReadFailure("bounds-exceeded");
  if (!jiraRemoteLinkMembership(response.body, { ...selected.context, baseUrl })) return jiraReadFailure("conflict");
  const item = remoteItem(response.body, selected.context);
  if (item === undefined) return jiraReadFailure("malformed-payload");
  if (selected.linkId !== undefined && item.id !== selected.linkId) return jiraReadFailure("malformed-payload");
  if (selected.globalId !== undefined && item.globalId !== selected.globalId) return jiraReadFailure("malformed-payload");
  return boundJiraReadResult({ data: { outcome: "succeeded", ...selected.context, ...item } });
}
function issueResponse(name: IssueRead, response: JiraReadResponse, selected: BoundSelection, baseUrl: string): ManagedMcpToolResult {
  if (selected.mode === "collection") return collection(name, response, selected, baseUrl);
  if (selected.mode === "single") return selectedLink(response, selected, baseUrl);
  return typeof response.scalar === "boolean"
    ? { data: { outcome: "succeeded", ...selected.context, canReorderSubtasks: response.scalar } }
    : jiraReadFailure("malformed-payload");
}
function responseMode(selected: IssueSelection): "json" | "json-array" | "json-scalar" {
  if (selected.mode === "availability") return "json-scalar";
  return selected.mode === "collection" ? "json-array" : "json";
}
async function issueRead(name: IssueRead, args: CatalogJsonObject, request: JiraMutationRequest, baseUrl: string): Promise<ManagedMcpToolResult> {
  const selected = selection(name, args);
  if (selected === undefined) return jiraReadFailure("invalid-input");
  const parent = await readJiraMutationIssue(request, selected.target, ["summary"]);
  if (!parent.ok) return jiraReadFailure(parent.reason, parent.detail);
  if (!jiraNativeId(parent.id) || !isSafeAtlassianIdentifier(parent.key)) return jiraReadFailure("malformed-payload");
  return executeJiraSelectedRead({ ...selected,
    path: `issue/${parent.id}/${selected.suffix}`, context: { issueId: parent.id, issueKey: parent.key },
  }, request, responseMode(selected), (response, bound) => issueResponse(name, response, bound, baseUrl));
}

const PICKER_FIELDS = new Set(["query", "currentJQL", "currentIssueKey", "currentProjectId", "showSubTasks", "showSubTaskParent"]);
function pickerText(args: CatalogJsonObject, query: URLSearchParams): boolean {
  for (const key of ["query", "currentJQL"] as const) {
    if (args[key] === undefined) continue;
    if (!jiraNativeText(args[key], key === "query" ? 255 : ATLASSIAN_JQL_MAX_CHARS, true)) return false;
    query.set(key, args[key]);
  }
  return true;
}
function pickerFlags(args: CatalogJsonObject, query: URLSearchParams): boolean {
  for (const key of ["showSubTasks", "showSubTaskParent"] as const) {
    if (args[key] === undefined) continue;
    if (typeof args[key] !== "boolean") return false;
    query.set(key, String(args[key]));
  }
  return true;
}
function pickerSelection(args: CatalogJsonObject): URLSearchParams | undefined {
  if (Object.keys(args).some((key) => !PICKER_FIELDS.has(key))) return undefined;
  if (args.currentIssueKey !== undefined && !isSafeAtlassianIdentifier(args.currentIssueKey)) return undefined;
  if (args.currentProjectId !== undefined && !jiraNativeId(args.currentProjectId)) return undefined;
  const query = new URLSearchParams();
  return pickerText(args, query) && pickerFlags(args, query) ? query : undefined;
}
async function bindPicker(args: CatalogJsonObject, query: URLSearchParams, request: JiraMutationRequest): Promise<ManagedMcpToolResult | undefined> {
  if (typeof args.currentIssueKey === "string") {
    const issue = await readJiraMutationIssue(request, args.currentIssueKey, ["summary"]);
    if (!issue.ok) return jiraReadFailure(issue.reason, issue.detail);
    if (!jiraNativeId(issue.id) || !isSafeAtlassianIdentifier(issue.key)) return jiraReadFailure("malformed-payload");
    query.set("currentIssueKey", issue.key);
  }
  if (typeof args.currentProjectId === "string") {
    const project = await readJiraBoundProject(request, args.currentProjectId);
    if (!project.ok) return jiraReadFailure(project.reason, project.detail);
    query.set("currentProjectId", project.project.projectId);
  }
  return undefined;
}
async function picker(args: CatalogJsonObject, request: JiraMutationRequest, baseUrl: string): Promise<ManagedMcpToolResult> {
  const query = pickerSelection(args);
  if (query === undefined) return jiraReadFailure("invalid-input");
  const refused = await bindPicker(args, query, request);
  if (refused !== undefined) return refused;
  const queryText = query.toString();
  return executeJiraSelectedRead({ path: `issue/picker${queryText.length === 0 ? "" : `?${queryText}`}` }, request, "json", (response) => {
    const native = response.body?.sections;
    if (jiraIssuePickerBoundsExceeded(native)) return jiraReadFailure("bounds-exceeded");
    const sections = jiraIssuePickerProjection(native, baseUrl);
    return sections === undefined ? jiraReadFailure("malformed-payload")
      : boundJiraReadResult({ data: { outcome: "succeeded", sections, suggestionsScope: "native-suggestions" } });
  });
}
export function isJiraIssueContextRead(name: string): name is ContextRead {
  return READS.has(name);
}
/** Read fixed issue-context resources only; native capability observations never authorize a mutation. */
export function executeJiraIssueContextRead(name: ContextRead, args: CatalogJsonObject, request: JiraMutationRequest, baseUrl: string): Promise<ManagedMcpToolResult> {
  return name === "jira.issue-picker" ? picker(args, request, baseUrl) : issueRead(name, args, request, baseUrl);
}
