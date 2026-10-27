import {
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
  const allowed = new Set(["startAt", "maxResults"]);
  let path: string;
  if (name === "jira.projects") path = "project";
  else if (name === "jira.edit-fields") {
    if (!isSafeAtlassianIdentifier(args.issueKey)) return undefined;
    allowed.add("issueKey");
    path = `issue/${encodeURIComponent(args.issueKey)}/editmeta`;
  } else {
    const metadata = metadataPath(name, args, allowed);
    if (metadata === undefined) return undefined;
    path = `${metadata}?startAt=${String(startAt)}&maxResults=${String(maxResults)}`;
  }
  return Object.keys(args).every((key) => allowed.has(key))
    ? { path, startAt, maxResults }
    : undefined;
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
    { method: "GET", url, expect: name === "jira.projects" ? "json-array" : "json" },
  );
  if (!outcome.ok) return failure(outcome.reason);
  const { startAt, maxResults } = selected;
  if (name === "jira.projects")
    return outcome.items === undefined
      ? failure("malformed-payload")
      : projectPage(outcome.items, startAt, maxResults);
  if (outcome.body === undefined) return failure("malformed-payload");
  return metadataResult(name, outcome.body, selected);
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
