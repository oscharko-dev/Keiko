import { mcpChatConfigurationDigest, selectedMcpServers } from "./mcpChatSelection.js";
import type {
  ExternalMcpConnection,
  ExternalMcpTool,
  ManagedMcpProvider,
  ManagedMcpTool,
  ManagedMcpToolResult,
} from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import type {
  McpServerDefinition,
  McpSettingsSnapshot,
} from "@oscharko-dev/keiko-contracts/runtime/mcp-servers";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { UiHandlerDeps } from "../deps.js";
import type { CatalogHandlerContext } from "../tool-catalog/catalogToolPorts.js";
import type { CatalogLifecycleLogPort } from "../tool-catalog/catalogToolLifecycle.js";
import {
  createManagedProviderCatalog,
  type ManagedProviderCatalog,
} from "../tool-catalog/managedProviderCatalog.js";
import { requireDispatch } from "../tool-catalog/catalogToolErrors.js";
import { emitServerDiagnostic, serverDiagnosticFromError } from "../diagnostics-log.js";
import { executeMcpChatMutation } from "./mcpChatMutation.js";
import { mcpChatDeclaration, type McpChatDeclaration } from "./mcpChatDescriptors.js";
import { mcpChatCatalogRoutes, type McpChatCatalogConsumer } from "./mcpChatCatalogConsumer.js";

type Context = CatalogHandlerContext<McpChatCatalogConsumer>;
type Deps = Pick<UiHandlerDeps, "mcpSettings" | "mcpConnections">;
export interface McpChatCatalog extends ManagedProviderCatalog<McpChatCatalogConsumer> {
  readonly configurationDigest: string;
  readonly tools: readonly McpChatDeclaration[];
  readonly signal: AbortSignal;
}
export interface McpChatCatalogRuntime {
  readonly get: (
    correlationId: string,
    selection?: readonly string[],
  ) => Promise<McpChatCatalog | undefined>;
  readonly close: () => Promise<void>;
}
export interface McpChatCatalogOptions {
  readonly deps: Deps;
  readonly log: CatalogLifecycleLogPort;
  readonly executeMutation: (
    declaration: McpChatDeclaration,
    args: CatalogJsonObject,
    context: Context,
    execute: () => Promise<CatalogJsonObject>,
  ) => Promise<ManagedMcpToolResult>;
}
interface Discovered {
  readonly connection: ExternalMcpConnection;
  readonly tools: readonly McpChatDeclaration[];
  readonly signal: AbortSignal;
}
function catalogDiagnostic(
  correlationId: string,
  error: unknown,
): ReturnType<typeof serverDiagnosticFromError> {
  return serverDiagnosticFromError({
    correlationId,
    operation: "tool-catalog.binding-failed",
    source: "mcp-chat-catalog",
    error,
    redact: () => "server-operation-failed",
  });
}
function diagnostic(options: McpChatCatalogOptions, correlationId: string, error: unknown): void {
  emitServerDiagnostic(options.log.diagnostics, catalogDiagnostic(correlationId, error));
}
export const MCP_CHAT_PROFILE = { id: "configured-mcp-chat", version: 1 } as const;
/** The tools of a connected server a Chat offers: all when discovery is automatic, else the declared. */
export function mcpChatServerDeclarations(
  server: McpServerDefinition,
  tools: readonly ExternalMcpTool[],
): readonly McpChatDeclaration[] {
  return tools
    .filter((tool) => server.discovery === "automatic" || Object.hasOwn(server.tools, tool.name))
    .map((tool) => mcpChatDeclaration(server, tool));
}
async function discover(
  options: McpChatCatalogOptions,
  server: McpServerDefinition,
  correlationId: string,
): Promise<Discovered | undefined> {
  const { mcpSettings, mcpConnections } = options.deps;
  requireDispatch(
    mcpSettings !== undefined && mcpConnections !== undefined,
    "denied",
    "authority-invalid",
  );
  try {
    const generation = mcpSettings.generation(server, correlationId);
    const connection = await mcpConnections.connect(server.name, correlationId);
    const signal = AbortSignal.any([generation, connection.signal]);
    requireDispatch(!signal.aborted, "denied", "consumer-stale");
    const tools = mcpChatServerDeclarations(server, connection.tools);
    return { connection, tools, signal };
  } catch (error) {
    emitServerDiagnostic(options.log.diagnostics, catalogDiagnostic(correlationId, error));
    return undefined;
  }
}
function providerTool(
  options: McpChatCatalogOptions,
  discovered: Discovered,
  tool: McpChatDeclaration,
): ManagedMcpTool<Context> & McpChatDeclaration {
  const { connection, signal } = discovered;
  return {
    ...tool,
    execute: async (args: CatalogJsonObject, context: Context): Promise<ManagedMcpToolResult> => {
      requireDispatch(!signal.aborted && context.beforeEffect(), "denied", "effect-denied");
      const execute = (): Promise<CatalogJsonObject> =>
        connection.call(tool.toolName, args, {
          ...context,
          signal: AbortSignal.any([signal, context.signal]),
        });
      if (tool.risk === "write") return options.executeMutation(tool, args, context, execute);
      const data = await execute();
      return { data, ...(data.isError === true ? { isError: true } : {}) };
    },
  };
}
function providerTools(
  options: McpChatCatalogOptions,
  discovered: readonly Discovered[],
): readonly (ManagedMcpTool<Context> & McpChatDeclaration)[] {
  return discovered.flatMap((entry) =>
    entry.tools.map((tool) => providerTool(options, entry, tool)),
  );
}
async function initialize(
  options: McpChatCatalogOptions,
  discovered: readonly Discovered[],
  snapshot: McpSettingsSnapshot,
  configurationDigest: string,
  correlationId: string,
): Promise<McpChatCatalog> {
  const revisionSignal = options.deps.mcpSettings?.revisionSignal(snapshot.revision, correlationId);
  requireDispatch(revisionSignal !== undefined, "denied", "authority-invalid");
  const tools = providerTools(options, discovered);
  const provider: ManagedMcpProvider<Context> = { id: "configured-mcp", tools: () => tools };
  const managed = await createManagedProviderCatalog<McpChatCatalogConsumer>({
    providers: [provider],
    routes: mcpChatCatalogRoutes(tools),
    profile: MCP_CHAT_PROFILE,
    log: options.log,
    correlationId,
    now: Date.now,
  });
  return {
    ...managed,
    configurationDigest,
    tools,
    signal: AbortSignal.any([revisionSignal, ...discovered.map((entry) => entry.signal)]),
  };
}

/** One shared catalog per live discovered generation; turns never own a protocol transport. */
class McpChatCatalogManager implements McpChatCatalogRuntime {
  private readonly catalogs = new Map<string, Promise<McpChatCatalog>>();
  private closed = false;
  constructor(private readonly options: McpChatCatalogOptions) {}
  private isOpen(): boolean {
    return !this.closed;
  }
  private remember(key: string, pending: Promise<McpChatCatalog>, correlationId: string): void {
    this.catalogs.set(key, pending);
    void pending.then(
      (catalog) => {
        const revoke = (): void => {
          if (this.catalogs.get(key) === pending) this.catalogs.delete(key);
          void catalog.close().catch((error: unknown) => {
            diagnostic(this.options, correlationId, error);
          });
        };
        if (catalog.signal.aborted) revoke();
        else catalog.signal.addEventListener("abort", revoke, { once: true });
      },
      (error: unknown) => {
        if (this.catalogs.get(key) === pending) this.catalogs.delete(key);
        diagnostic(this.options, correlationId, error);
      },
    );
  }
  async get(
    correlationId: string,
    selection?: readonly string[],
  ): Promise<McpChatCatalog | undefined> {
    requireDispatch(this.isOpen(), "failed", "handler-unavailable");
    const settings = this.options.deps.mcpSettings;
    if (settings === undefined || this.options.deps.mcpConnections === undefined) return undefined;
    const snapshot = settings.read(correlationId);
    const results = await Promise.all(
      selectedMcpServers(snapshot.servers, selection).map((server) =>
        discover(this.options, server, correlationId),
      ),
    );
    const discovered = results.filter((entry): entry is Discovered => entry !== undefined);
    requireDispatch(
      this.isOpen() && settings.read(correlationId).revision === snapshot.revision,
      "denied",
      "consumer-stale",
    );
    const tools = discovered.flatMap((entry) => entry.tools);
    if (tools.length === 0) return undefined;
    const configurationDigest = mcpChatConfigurationDigest(snapshot.revision, selection);
    const key = sha256Hex(canonicalise({ configurationDigest, tools }));
    let pending = this.catalogs.get(key);
    if (pending === undefined) {
      pending = initialize(this.options, discovered, snapshot, configurationDigest, correlationId);
      this.remember(key, pending, correlationId);
    }
    const catalog = await pending;
    requireDispatch(this.isOpen() && !catalog.signal.aborted, "denied", "consumer-stale");
    return catalog;
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled(
      [...this.catalogs.values()].map(async (pending) => (await pending).close()),
    );
    this.catalogs.clear();
  }
}
export function createMcpChatCatalogRuntime(options: McpChatCatalogOptions): McpChatCatalogRuntime {
  return new McpChatCatalogManager(options);
}

export function installMcpChatCatalogRuntime(
  deps: UiHandlerDeps,
  log: CatalogLifecycleLogPort,
): UiHandlerDeps {
  const runtime = createMcpChatCatalogRuntime({
    deps,
    log,
    executeMutation: (declaration, args, context, execute) =>
      executeMcpChatMutation(deps, declaration, args, context, execute),
  });
  const previousDispose = deps.dispose;
  return Object.assign(deps, {
    mcpChatCatalog: runtime,
    dispose: async (): Promise<void> => {
      try {
        await runtime.close();
      } finally {
        await previousDispose?.();
      }
    },
  });
}
