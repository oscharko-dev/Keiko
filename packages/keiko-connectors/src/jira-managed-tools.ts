import type { AtlassianConnectorDeployment } from "@oscharko-dev/keiko-contracts";
import type {
  CatalogJsonObject,
  ToolDescriptor,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type {
  ManagedMcpInvocationContext,
  ManagedMcpProvider,
  ManagedMcpTool,
  ManagedMcpToolResult,
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
  readonly descriptor: ToolDescriptor;
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
function failure(reason: string): ManagedMcpToolResult {
  return { data: { outcome: "failed", reason }, isError: true };
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
  const items = valid.slice(startAt, startAt + maxResults);
  const nextStartAt = startAt + items.length < valid.length ? startAt + items.length : null;
  return {
    data: {
      outcome: "succeeded",
      items,
      startAt,
      total: valid.length,
      ...(nextStartAt === null ? {} : { nextStartAt }),
    },
  };
}
async function projects<Context extends ManagedMcpInvocationContext>(
  args: CatalogJsonObject,
  context: Context,
  deps: JiraManagedProviderDeps<Context>,
): Promise<ManagedMcpToolResult> {
  const startAt = pageNumber(args.startAt, 0, 0, 1000);
  const maxResults = pageNumber(args.maxResults, 25, 1, 100);
  if (
    startAt === undefined ||
    maxResults === undefined ||
    Object.keys(args).some((key) => key !== "startAt" && key !== "maxResults")
  )
    return failure("invalid-input");
  const { deployment, baseUrl, http } = await deps.connection(context);
  if (deployment !== "data-center") return failure("unsupported-deployment");
  const url = atlassianApiUrl(atlassianApiEndpointsFor(baseUrl, "/rest/api/2/"), "project");
  const outcome = await executeAtlassianWriteRequest(
    {
      signal: context.signal,
      http: (request) => {
        if (context.signal.aborted || !context.beforeEffect())
          return Promise.resolve({ kind: "network-error" });
        return http(request);
      },
    },
    { method: "GET", url, expect: "json-array" },
  );
  if (!outcome.ok) return failure(outcome.reason);
  return outcome.items === undefined
    ? failure("malformed-payload")
    : projectPage(outcome.items, startAt, maxResults);
}

/** Private connection/context stays outside the MCP declaration and arguments. */
export function createJiraManagedProvider<Context extends ManagedMcpInvocationContext>(
  deps: JiraManagedProviderDeps<Context>,
): ManagedMcpProvider<Context> {
  const captured = Object.freeze({ connection: deps.connection, descriptor: deps.descriptor });
  const tools: readonly ManagedMcpTool<Context>[] = Object.freeze([
    Object.freeze({
      name: "jira.projects",
      risk: "read" as const,
      descriptor: captured.descriptor,
      execute: (args: CatalogJsonObject, context: Context): Promise<ManagedMcpToolResult> =>
        projects(args, context, captured),
    }),
  ]);
  return Object.freeze({ id: "jira", tools: (): readonly ManagedMcpTool<Context>[] => tools });
}
