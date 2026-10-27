import {
  jiraAssignableUsersPath,
  jiraAssignableUsersResult,
  jiraTransitionsResult,
} from "./jira-managed-workflow-reads.js";
import {
  jiraIssueReadResult,
  JIRA_MANAGED_ISSUE_FIELDS,
  JIRA_MANAGED_SEARCH_FIELDS,
} from "./jira-managed-issue-reads.js";
import {
  ATLASSIAN_JQL_MAX_CHARS,
  isSafeAtlassianIdentifier,
  JIRA_MANAGED_READ_TOOLS,
  type AtlassianConnectorDeployment,
  type JiraManagedReadToolName,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  editMetadataItems,
  issueTypeItems,
  jiraReadFailure as failure,
  localJiraPage,
  metadataItems,
  remoteJiraPage,
} from "./jira-managed-metadata.js";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type {
  ManagedMcpInvocationContext,
  ManagedMcpProvider,
  ManagedMcpTool,
  ManagedMcpToolResult,
  ManagedMcpToolDeclaration,
} from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import type { AtlassianHttpBodyPort } from "./atlassian-http-port.js";
import { asRecord, atlassianApiEndpointsFor, atlassianApiUrl } from "./atlassian-sync-classify.js";
import { executeAtlassianWriteRequest } from "./atlassian-write-http.js";

const ARRAY_READ_NAMES: ReadonlySet<string> = new Set(["jira.projects", "jira.assignable-users"]);
const ISSUE_READ_NAMES: ReadonlySet<string> = new Set([
  "jira.search",
  "jira.issue",
  "jira.comments",
]);

export interface JiraManagedConnection {
  readonly deployment: AtlassianConnectorDeployment;
  readonly baseUrl: string;
  readonly http: AtlassianHttpBodyPort;
}
export interface JiraManagedProviderDeps<Context extends ManagedMcpInvocationContext> {
  readonly connection: (context: Context) => JiraManagedConnection | Promise<JiraManagedConnection>;
  readonly declarations: readonly ManagedMcpToolDeclaration[];
}

interface Project extends CatalogJsonObject {
  readonly id: string;
  readonly key: string;
  readonly name: string;
}
function project(value: unknown): Project | undefined {
  const raw = asRecord(value);
  if (raw === undefined || !text(raw.id, 64) || !text(raw.key, 64) || !text(raw.name, 255))
    return undefined;
  return { id: raw.id, key: raw.key, name: raw.name };
}
function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}
function pageNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined) return fallback;
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? value
    : undefined;
}
function projectPage(
  values: readonly unknown[],
  startAt: number,
  maxResults: number,
): ManagedMcpToolResult {
  if (values.length > 1000) return failure("bounds-exceeded");
  const projects = values.map(project);
  if (projects.some((item) => item === undefined)) return failure("malformed-payload");
  const valid = projects.filter((item) => item !== undefined);
  if (new Set(valid.map((item) => item.id)).size !== valid.length)
    return failure("malformed-payload");
  // The DC endpoint is an unpaginated collection. Sort and slice only after complete validation.
  valid.sort((left, right) => left.key.localeCompare(right.key, "en"));
  return localJiraPage(valid, startAt, maxResults);
}
interface ReadSelection {
  readonly path: string;
  readonly startAt: number;
  readonly maxResults: number;
}
function selection(
  name: JiraManagedReadToolName,
  args: CatalogJsonObject,
): ReadSelection | undefined {
  const startAt = pageNumber(args.startAt, 0, 0, 1000000);
  const maxResults = pageNumber(args.maxResults, 25, 1, 100);
  if (startAt === undefined || maxResults === undefined) return undefined;
  const allowed = new Set(name === "jira.issue" ? [] : ["startAt", "maxResults"]);
  const paging = `startAt=${String(startAt)}&maxResults=${String(maxResults)}`;
  const path = readPath(name, args, allowed, paging);
  return path !== undefined && Object.keys(args).every((key) => allowed.has(key))
    ? { path, startAt, maxResults }
    : undefined;
}
function readPath(
  name: JiraManagedReadToolName,
  args: CatalogJsonObject,
  allowed: Set<string>,
  paging: string,
): string | undefined {
  if (name === "jira.projects") return "project";
  if (name === "jira.assignable-users") return jiraAssignableUsersPath(args, allowed, paging);
  if (name === "jira.search") return searchPath(args, allowed, paging);
  if (name === "jira.issue-types" || name === "jira.create-fields") {
    const path = metadataPath(name, args, allowed);
    return path === undefined ? undefined : `${path}?${paging}`;
  }
  return issueReadPath(name, args, allowed, paging);
}
function issueReadPath(
  name: JiraManagedReadToolName,
  args: CatalogJsonObject,
  allowed: Set<string>,
  paging: string,
): string | undefined {
  if (!isSafeAtlassianIdentifier(args.issueKey)) return undefined;
  allowed.add("issueKey");
  const path = `issue/${encodeURIComponent(args.issueKey)}`;
  switch (name) {
    case "jira.edit-fields":
      return `${path}/editmeta`;
    case "jira.issue":
      return `${path}?fields=${JIRA_MANAGED_ISSUE_FIELDS}`;
    case "jira.comments":
      return `${path}/comment?${paging}`;
    case "jira.transitions":
      return `${path}/transitions?expand=transitions.fields`;
    default:
      return undefined;
  }
}
function searchPath(
  args: CatalogJsonObject,
  allowed: Set<string>,
  paging: string,
): string | undefined {
  if (!text(args.jql, ATLASSIAN_JQL_MAX_CHARS)) return undefined;
  allowed.add("jql");
  const query = new URLSearchParams({ jql: args.jql });
  for (const [key, value] of new URLSearchParams(paging)) query.set(key, value);
  query.set("fields", JIRA_MANAGED_SEARCH_FIELDS);
  return `search?${query.toString()}`;
}

function metadataPath(
  name: JiraManagedReadToolName,
  args: CatalogJsonObject,
  allowed: Set<string>,
): string | undefined {
  if (!isSafeAtlassianIdentifier(args.projectKey)) return undefined;
  allowed.add("projectKey");
  const path = `issue/createmeta/${encodeURIComponent(args.projectKey)}/issuetypes`;
  if (name !== "jira.create-fields") return path;
  if (typeof args.issueTypeId !== "string" || !/^\d{1,32}$/u.test(args.issueTypeId))
    return undefined;
  allowed.add("issueTypeId");
  return `${path}/${args.issueTypeId}`;
}
function metadataResult(
  name: JiraManagedReadToolName,
  body: Record<string, unknown>,
  selected: ReadSelection,
): ManagedMcpToolResult {
  const { startAt, maxResults } = selected;
  if (name === "jira.transitions") return jiraTransitionsResult(body, startAt, maxResults);
  if (name === "jira.edit-fields") {
    const items = editMetadataItems(body.fields);
    return items === undefined
      ? failure("malformed-payload")
      : localJiraPage(items, startAt, maxResults);
  }
  const items =
    name === "jira.issue-types" ? issueTypeItems(body.values) : metadataItems(body.values);
  return remoteJiraPage(body, items, startAt, maxResults);
}
function arrayResult(
  name: JiraManagedReadToolName,
  values: readonly unknown[] | undefined,
  startAt: number,
  maxResults: number,
): ManagedMcpToolResult {
  if (values === undefined) return failure("malformed-payload");
  return name === "jira.projects"
    ? projectPage(values, startAt, maxResults)
    : jiraAssignableUsersResult(values, startAt, maxResults);
}
async function read<Context extends ManagedMcpInvocationContext>(
  name: JiraManagedReadToolName,
  args: CatalogJsonObject,
  context: Context,
  connection: JiraManagedProviderDeps<Context>["connection"],
): Promise<ManagedMcpToolResult> {
  const selected = selection(name, args);
  if (selected === undefined) return failure("invalid-input");
  const { deployment, baseUrl, http } = await connection(context);
  if (deployment !== "data-center") return failure("unsupported-deployment");
  const url = atlassianApiUrl(atlassianApiEndpointsFor(baseUrl, "/rest/api/2/"), selected.path);
  const outcome = await executeAtlassianWriteRequest(
    {
      signal: context.signal,
      http: (request) =>
        context.signal.aborted || !context.beforeEffect()
          ? Promise.resolve({ kind: "network-error" })
          : http(request),
    },
    { method: "GET", url, expect: ARRAY_READ_NAMES.has(name) ? "json-array" : "json" },
  );
  if (!outcome.ok) return failure(outcome.reason);
  const { startAt, maxResults } = selected;
  if (ARRAY_READ_NAMES.has(name)) return arrayResult(name, outcome.items, startAt, maxResults);
  if (outcome.body === undefined) return failure("malformed-payload");
  return ISSUE_READ_NAMES.has(name)
    ? jiraIssueReadResult(name, outcome.body, startAt, maxResults)
    : metadataResult(name, outcome.body, selected);
}

/** Private connection/context stays outside the MCP declaration and arguments. */
export function createJiraManagedProvider<Context extends ManagedMcpInvocationContext>(
  deps: JiraManagedProviderDeps<Context>,
): ManagedMcpProvider<Context> {
  const connection = deps.connection;
  const tools: readonly ManagedMcpTool<Context>[] = Object.freeze(
    deps.declarations.map((declaration) => {
      const name = JIRA_MANAGED_READ_TOOLS.find((name) => name === declaration.name);
      if (name === undefined || declaration.risk !== "read")
        throw new TypeError("Unsupported Jira declaration");
      return Object.freeze({
        name,
        risk: "read" as const,
        descriptor: declaration.descriptor,
        execute: (args: CatalogJsonObject, context: Context): Promise<ManagedMcpToolResult> =>
          read(name, args, context, connection),
      });
    }),
  );
  return Object.freeze({ id: "jira", tools: (): readonly ManagedMcpTool<Context>[] => tools });
}
