import { emitServerDiagnostic, contentFreeErrorClass } from "../diagnostics-log.js";
import type { ExternalMcpTool } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import {
  McpSettingsInputError,
  mcpSettingsFitStorage,
  recordMcpSettingsImport,
  type McpSettingsStore,
} from "./mcpSettingsStore.js";
import { prepareMcpSettingsImport } from "./mcpSettingsImport.js";
import {
  MCP_SETTINGS_IMPORT_MAX_BYTES,
  parseMcpSettingsUpdate,
  type McpSettingsImportResponse,
  type McpSettingsUpdate,
  type McpServerDefinition,
  type McpSettingsSnapshot,
} from "@oscharko-dev/keiko-contracts/runtime/mcp-servers";
import { readJsonRequestBodyOutcome } from "../bounded-request-body.js";
import { resolveAppSessionReadAuthority } from "../coding-app-session/appSessionReadAuthority.js";
import type { UiHandlerDeps } from "../deps.js";
import { errorBody } from "../route-error.js";
import { UNKNOWN_CORRELATION_ID, correlationIdOrUnknown } from "../correlation.js";
import type { RouteContext, RouteResult } from "../routes.js";

type SettingsDeps = Pick<
  UiHandlerDeps,
  | "mcpSettings"
  | "mcpConnections"
  | "mcpAuthorization"
  | "codingAppSessionChannel"
  | "diagnostics"
  | "activityLog"
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
    body: withConnections(
      deps,
      deps.mcpSettings.read(ctx.correlationId ?? UNKNOWN_CORRELATION_ID),
      ctx.correlationId ?? UNKNOWN_CORRELATION_ID,
    ),
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
  return applySettingsUpdate(deps, store, update, correlationIdOrUnknown(ctx.correlationId));
}

function settingsConflict(): RouteResult {
  return {
    status: 409,
    body: errorBody("MCP_SETTINGS_CONFLICT", "MCP settings changed. Reload before saving."),
  };
}

function applySettingsUpdate(
  deps: SettingsDeps,
  store: McpSettingsStore,
  update: McpSettingsUpdate,
  correlationId: string,
  imported = false,
): RouteResult {
  try {
    const result = store.update(update, correlationId);
    if (!result.ok) return settingsConflict();
    const snapshot = withConnections(deps, result.snapshot, correlationId);
    return settingsResponse(imported ? { kind: "saved", snapshot } : snapshot);
  } catch (error) {
    if (!(error instanceof McpSettingsInputError)) throw error;
    emitServerDiagnostic(deps.diagnostics, {
      correlationId,
      timestamp: new Date().toISOString(),
      operation: "mcp.settings",
      source: "mcp.settings.update",
      errorClass: contentFreeErrorClass(error),
      diagnosticOutcome: "routine",
      message: "mcp-settings-update-invalid",
    });
    return { status: 400, body: errorBody("BAD_REQUEST", "MCP settings are invalid.") };
  }
}

function settingsResponse(body: McpSettingsSnapshot | McpSettingsImportResponse): RouteResult {
  return { status: 200, headers: { "cache-control": "no-store" }, body };
}

function importRequest(value: unknown): { text: string; revision?: string } | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !("text" in value) ||
    typeof value.text !== "string"
  )
    return undefined;
  if (!("revision" in value)) return { text: value.text };
  return typeof value.revision === "string" && /^[a-f0-9]{64}$/u.test(value.revision)
    ? { text: value.text, revision: value.revision }
    : undefined;
}

export async function handleImportMcpSettings(
  ctx: RouteContext,
  deps: SettingsDeps,
): Promise<RouteResult> {
  const authority = resolveAppSessionReadAuthority(deps, ctx.req);
  if (authority === undefined) return denied();
  const store = deps.mcpSettings;
  if (store === undefined) return unavailable();
  const correlationId = correlationIdOrUnknown(ctx.correlationId);
  // The surrounding JSON request can escape up to six bytes for each byte of text.
  const body = await readJsonRequestBodyOutcome(
    ctx.req,
    6 * MCP_SETTINGS_IMPORT_MAX_BYTES + 256,
    correlationId,
  );
  if (!sameSession(ctx, deps, authority)) return denied();
  if (body.kind === "rejected") return body.response;
  const request = importRequest(body.value);
  if (request === undefined)
    return { status: 400, body: errorBody("BAD_REQUEST", "An MCP import document is required.") };
  return importSettings(deps, store, request, correlationId);
}

function importSettings(
  deps: SettingsDeps,
  store: McpSettingsStore,
  request: { text: string; revision?: string },
  correlationId: string,
): RouteResult {
  const intent = request.revision === undefined ? "preview" : "save";
  const current = store.read(correlationId);
  if (request.revision !== undefined && request.revision !== current.revision) {
    recordMcpSettingsImport(deps.activityLog, correlationId, current, intent, "conflict");
    return settingsConflict();
  }
  const prepared =
    Buffer.byteLength(request.text, "utf8") > MCP_SETTINGS_IMPORT_MAX_BYTES
      ? ({ kind: "invalid", issue: "size" } as const)
      : prepareMcpSettingsImport(request.text, current);
  if (prepared.kind === "invalid") {
    recordMcpSettingsImport(deps.activityLog, correlationId, current, intent, "import-invalid");
    return settingsResponse(prepared);
  }
  const { update } = prepared;
  if (!mcpSettingsFitStorage(update.servers)) {
    recordMcpSettingsImport(deps.activityLog, correlationId, current, intent, "import-invalid");
    return settingsResponse({ kind: "invalid", issue: "size" });
  }
  const servers = update.servers
    .slice(current.servers.length)
    .map(({ name, transport }) => ({ name, kind: transport.kind }));
  recordMcpSettingsImport(
    deps.activityLog,
    correlationId,
    current,
    intent,
    "import-ready",
    servers.length,
  );
  if (intent === "preview")
    return settingsResponse({ kind: "preview", revision: current.revision, servers });
  return applySettingsUpdate(deps, store, update, correlationId, true);
}

function withConnections(
  deps: SettingsDeps,
  snapshot: McpSettingsSnapshot,
  correlationId: string,
): McpSettingsSnapshot {
  const connections =
    deps.mcpConnections?.inspect(correlationId) ??
    snapshot.servers.map((server) => ({
      name: server.name,
      state: server.enabled ? ("idle" as const) : ("disabled" as const),
      toolCount: null,
    }));
  return {
    ...snapshot,
    connections: connections.map((connection) => {
      const server = snapshot.servers.find((entry) => entry.name === connection.name);
      if (server?.transport.kind !== "remote" || server.transport.oauth === undefined)
        return connection;
      return {
        ...connection,
        authentication:
          deps.mcpAuthorization?.authorized(server, correlationId) === true
            ? ("authorized" as const)
            : ("required" as const),
      };
    }),
  };
}
const conflict = (): RouteResult => ({
  status: 409,
  body: errorBody("MCP_SETTINGS_CONFLICT", "MCP settings changed. Reconnect after reloading."),
});
/** Explicit human connection check; discovery never dispatches a tool. */
export async function handleConnectMcpServer(
  ctx: RouteContext,
  deps: SettingsDeps,
): Promise<RouteResult> {
  const authority = resolveAppSessionReadAuthority(deps, ctx.req);
  if (authority === undefined) return denied();
  if (deps.mcpConnections === undefined || deps.mcpSettings === undefined) return unavailable();
  const correlationId = ctx.correlationId ?? UNKNOWN_CORRELATION_ID;
  const snapshot = deps.mcpSettings.read(correlationId);
  const server = snapshot.servers.find(
    (entry) => entry.name === ctx.params.serverName && entry.enabled,
  );
  if (server === undefined)
    return { status: 404, body: errorBody("NOT_FOUND", "MCP server is unavailable.") };
  try {
    return await connectConfiguredServer(ctx, deps, authority, snapshot, server);
  } catch (error) {
    emitServerDiagnostic(deps.diagnostics, {
      correlationId,
      timestamp: new Date().toISOString(),
      operation: "mcp.connection",
      source: "mcp.settings.connect",
      errorClass: contentFreeErrorClass(error),
      message: "runtime-turn-failed",
      code: "stage=mcp-connect",
    });
    return {
      status: 502,
      body: errorBody(
        "MCP_CONNECTION_FAILED",
        "The MCP server could not be connected. Check its configuration and credentials.",
      ),
    };
  }
}
async function connectConfiguredServer(
  ctx: RouteContext,
  deps: SettingsDeps,
  authority: NonNullable<ReturnType<typeof resolveAppSessionReadAuthority>>,
  snapshot: McpSettingsSnapshot,
  server: McpServerDefinition,
): Promise<RouteResult> {
  const { mcpConnections, mcpSettings } = deps;
  if (mcpConnections === undefined || mcpSettings === undefined) return unavailable();
  const correlationId = correlationIdOrUnknown(ctx.correlationId);
  const generation = mcpSettings.generation(server, correlationId);
  const tools = (await mcpConnections.connect(server.name, correlationId)).tools;
  if (!sameSession(ctx, deps, authority)) return denied();
  if (generation.aborted || mcpSettings.read(correlationId).revision !== snapshot.revision)
    return conflict();
  const saved = saveDiscoveredTools(mcpSettings, snapshot, server, tools, correlationId);
  if (!saved.ok) return conflict();
  // Discovery may commit new tool metadata and revoke the first transport. Only the current
  // committed generation may be presented as connected; an unchanged save reuses its client.
  const live = await mcpConnections.connect(server.name, correlationId);
  if (!sameSession(ctx, deps, authority)) return denied();
  if (live.signal.aborted || mcpSettings.read(correlationId).revision !== saved.snapshot.revision)
    return conflict();
  return {
    status: 200,
    headers: { "cache-control": "no-store" },
    body: {
      snapshot: withConnections(deps, saved.snapshot, correlationId),
      toolCount: live.tools.length,
    },
  };
}
function saveDiscoveredTools(
  store: McpSettingsStore,
  snapshot: McpSettingsSnapshot,
  server: McpServerDefinition,
  tools: readonly ExternalMcpTool[],
  correlationId: string,
): ReturnType<McpSettingsStore["update"]> {
  // Provider readOnlyHint is descriptive, never an authority grant. Unknown tools require write approval.
  const admitted =
    server.discovery === "automatic"
      ? Object.fromEntries(
          tools.map((tool) => [
            tool.name,
            Object.hasOwn(server.tools, tool.name) ? (server.tools[tool.name] ?? "write") : "write",
          ]),
        )
      : server.tools;
  return store.update(
    {
      expectedRevision: snapshot.revision,
      servers: snapshot.servers.map((entry) =>
        entry.name === server.name ? { ...entry, tools: admitted } : entry,
      ),
      secrets: {},
    },
    correlationId,
  );
}
