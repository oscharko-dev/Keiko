import type { ExternalMcpTool } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import type { McpSettingsStore } from "./mcpSettingsStore.js";
import {
  parseMcpSettingsUpdate,
  type McpServerDefinition,
  type McpSettingsSnapshot,
} from "@oscharko-dev/keiko-contracts/runtime/mcp-servers";
import { readJsonRequestBodyOutcome } from "../bounded-request-body.js";
import { resolveAppSessionReadAuthority } from "../coding-app-session/appSessionReadAuthority.js";
import type { UiHandlerDeps } from "../deps.js";
import { errorBody } from "../route-error.js";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import type { RouteContext, RouteResult } from "../routes.js";

type SettingsDeps = Pick<
  UiHandlerDeps,
  "mcpSettings" | "mcpConnections" | "codingAppSessionChannel"
>;
const denied = (): RouteResult => ({
  status: 403,
  body: errorBody("DENIED", "An active app session is required."),
});
const unavailable = (): RouteResult => ({
  status: 503,
  body: errorBody("MCP_SETTINGS_UNAVAILABLE", "MCP settings are unavailable."),
});

function sameSession(
  ctx: RouteContext,
  deps: SettingsDeps,
  authority: NonNullable<ReturnType<typeof resolveAppSessionReadAuthority>>,
): boolean {
  const current = resolveAppSessionReadAuthority(deps, ctx.req);
  return (
    current?.sessionId === authority.sessionId && current.rotationCount === authority.rotationCount
  );
}

export function handleGetMcpSettings(ctx: RouteContext, deps: SettingsDeps): RouteResult {
  if (resolveAppSessionReadAuthority(deps, ctx.req) === undefined) return denied();
  if (deps.mcpSettings === undefined) return unavailable();
  return {
    status: 200,
    headers: { "cache-control": "no-store" },
    body: deps.mcpSettings.read(ctx.correlationId ?? UNKNOWN_CORRELATION_ID),
  };
}

export async function handlePutMcpSettings(
  ctx: RouteContext,
  deps: SettingsDeps,
): Promise<RouteResult> {
  const authority = resolveAppSessionReadAuthority(deps, ctx.req);
  if (authority === undefined) return denied();
  const store = deps.mcpSettings;
  if (store === undefined) return unavailable();
  const body = await readJsonRequestBodyOutcome(ctx.req, 1024 * 1024, ctx.correlationId);
  if (!sameSession(ctx, deps, authority)) return denied();
  if (body.kind === "rejected") return body.response;
  const update = parseMcpSettingsUpdate(body.value);
  if (update === undefined)
    return { status: 400, body: errorBody("BAD_REQUEST", "MCP settings are invalid.") };
  const result = store.update(update, ctx.correlationId ?? UNKNOWN_CORRELATION_ID);
  if (!result.ok)
    return {
      status: 409,
      body: errorBody("MCP_SETTINGS_CONFLICT", "MCP settings changed. Reload before saving."),
    };
  return { status: 200, headers: { "cache-control": "no-store" }, body: result.snapshot };
}

/** Explicit human connection check; discovery never dispatches a tool. */
export async function handleConnectMcpServer(
  ctx: RouteContext,
  deps: SettingsDeps,
): Promise<RouteResult> {
  const authority = resolveAppSessionReadAuthority(deps, ctx.req);
  if (authority === undefined) return denied();
  if (deps.mcpConnections === undefined || deps.mcpSettings === undefined) return unavailable();
  const correlationId = ctx.correlationId ?? UNKNOWN_CORRELATION_ID;
  const name = ctx.params.serverName;
  const snapshot = deps.mcpSettings.read(correlationId);
  const server = snapshot.servers.find((entry) => entry.name === name && entry.enabled);
  if (server === undefined)
    return { status: 404, body: errorBody("NOT_FOUND", "MCP server is unavailable.") };
  const generation = deps.mcpSettings.generation(server, correlationId);
  let tools: readonly ExternalMcpTool[];
  try {
    tools = (await deps.mcpConnections.connect(server.name, correlationId)).tools;
  } catch {
    return {
      status: 502,
      body: errorBody(
        "MCP_CONNECTION_FAILED",
        "The MCP server could not be connected. Check its configuration and credentials.",
      ),
    };
  }
  if (!sameSession(ctx, deps, authority)) return denied();
  if (generation.aborted || deps.mcpSettings.read(correlationId).revision !== snapshot.revision)
    return {
      status: 409,
      body: errorBody("MCP_SETTINGS_CONFLICT", "MCP settings changed. Reconnect after reloading."),
    };
  return saveDiscoveredTools(deps.mcpSettings, snapshot, server, tools, correlationId);
}
function saveDiscoveredTools(
  store: McpSettingsStore,
  snapshot: McpSettingsSnapshot,
  server: McpServerDefinition,
  tools: readonly ExternalMcpTool[],
  correlationId: string,
): RouteResult {
  // Provider readOnlyHint is descriptive, never an authority grant. Unknown tools require write approval.
  const admitted =
    server.discovery === "automatic"
      ? Object.fromEntries(tools.map((tool) => [tool.name, server.tools[tool.name] ?? "write"]))
      : server.tools;
  const result = store.update(
    {
      expectedRevision: snapshot.revision,
      servers: snapshot.servers.map((entry) =>
        entry.name === server.name ? { ...entry, tools: admitted } : entry,
      ),
      secrets: {},
    },
    correlationId,
  );
  if (!result.ok)
    return {
      status: 409,
      body: errorBody("MCP_SETTINGS_CONFLICT", "MCP settings changed. Reload before connecting."),
    };
  return {
    status: 200,
    headers: { "cache-control": "no-store" },
    body: { snapshot: result.snapshot, toolCount: tools.length },
  };
}
