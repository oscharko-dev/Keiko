import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import type {
  ExternalMcpConnection,
  ManagedMcpInvocationContext,
} from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import type {
  McpServerDefinition,
  McpRemoteTransport,
} from "@oscharko-dev/keiko-contracts/runtime/mcp-servers";
import { mcpServerSecretReferences } from "@oscharko-dev/keiko-contracts/runtime/mcp-servers";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { deepRedactStrings, redactContent } from "@oscharko-dev/keiko-security";
import {
  connectExternalMcp,
  createMcpRelayEndpoint,
  ManagedMcpError,
  type ExternalMcpTransportOptions,
} from "@oscharko-dev/keiko-mcp";
import {
  gatewayFetch,
  type OutboundHttpEgressConfig,
} from "@oscharko-dev/keiko-model-gateway/internal/http";
import { savePrivateJson } from "../private-json.js";
import { resolveMcpSecretHeaders } from "./mcpCredentialRelay.js";
import type { McpSettingsStore } from "./mcpSettingsStore.js";

export interface ConfiguredMcpConnections {
  readonly connect: (name: string, correlationId: string) => Promise<ExternalMcpConnection>;
  readonly generation: (server: McpServerDefinition, correlationId: string) => AbortSignal;
  readonly serve: (
    name: string,
    request: Request,
    context: ManagedMcpInvocationContext,
  ) => Promise<Response>;
  readonly close: () => Promise<void>;
}
interface Options {
  readonly settings: McpSettingsStore;
  readonly stateDir: string;
  readonly log: ServerLogSink;
  readonly egress: () => OutboundHttpEgressConfig | undefined;
  readonly connect?: typeof connectExternalMcp;
  readonly fetch?: typeof gatewayFetch;
}

function currentServer(options: Options, name: string, correlationId: string): McpServerDefinition {
  const server = options.settings.read(correlationId).servers.find((entry) => entry.name === name);
  if (server?.enabled !== true) throw new ManagedMcpError("not-admitted");
  return server;
}

function currentGeneration(
  options: Options,
  server: McpServerDefinition,
  correlationId: string,
): AbortSignal {
  try {
    return options.settings.generation(server, correlationId);
  } catch {
    throw new ManagedMcpError("not-admitted");
  }
}

/** SDK routing is never permitted to change the credential's configured origin or resource tree. */
function targetAllowed(server: McpServerDefinition, target: URL): boolean {
  if (server.transport.kind !== "remote") return false;
  const base = new URL(server.transport.url);
  if (
    target.origin !== base.origin ||
    target.username !== "" ||
    target.password !== "" ||
    target.hash !== ""
  )
    return false;
  return server.transport.protocol === "sse"
    ? target.pathname.startsWith(base.pathname.slice(0, base.pathname.lastIndexOf("/") + 1))
    : target.href === base.href;
}

function remoteHeaders(
  options: Options,
  server: McpServerDefinition,
  transport: McpRemoteTransport,
  request: Request,
): Headers {
  const environment = Object.fromEntries(
    Object.values(transport.headers ?? {}).map((header) => [
      header.secretEnv,
      options.settings.secret(header.secretEnv, server),
    ]),
  );
  const credentials = resolveMcpSecretHeaders(transport.headers ?? {}, environment);
  if (!credentials.ok) throw new ManagedMcpError("not-admitted");
  const headers = new Headers(request.headers);
  for (const [name, value] of Object.entries(credentials.headers)) headers.set(name, value);
  return headers;
}
async function requestPayload(request: Request): Promise<Uint8Array<ArrayBuffer> | undefined> {
  if (request.body === null) return undefined;
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength > 2 * 1024 * 1024) throw new ManagedMcpError("invalid-arguments");
  return body;
}
function requireRequestCurrent(
  options: Options,
  server: McpServerDefinition,
  correlationId: string,
  signal: AbortSignal,
  invocation?: ManagedMcpInvocationContext,
): void {
  currentGeneration(options, server, correlationId);
  if (signal.aborted || (invocation !== undefined && !invocation.beforeEffect()))
    throw new ManagedMcpError("not-admitted");
}
function remoteTransport(
  options: Options,
  server: McpServerDefinition,
  correlationId: string,
  signal: AbortSignal,
): ExternalMcpTransportOptions {
  if (server.transport.kind !== "remote" || server.transport.oauth !== undefined)
    throw new ManagedMcpError("not-admitted");
  const transport = server.transport;
  return {
    kind: "remote",
    url: transport.url,
    transport: transport.protocol ?? "streamable-http",
    fetch: async (input, init, invocation): Promise<Response> => {
      requireRequestCurrent(options, server, correlationId, signal, invocation);
      const request = new Request(input, init);
      if (
        !targetAllowed(server, new URL(request.url)) ||
        !new Set(["GET", "POST", "DELETE"]).has(request.method)
      )
        throw new ManagedMcpError("not-admitted");
      const body = await requestPayload(request);
      requireRequestCurrent(options, server, correlationId, signal, invocation);
      const response = await (options.fetch ?? gatewayFetch)(request.url, {
        method: request.method,
        headers: remoteHeaders(options, server, transport, request),
        ...(body === undefined ? {} : { body }),
        redirect: "manual",
        signal: AbortSignal.any([signal, request.signal]),
        maxResponseBytes: 2 * 1024 * 1024,
        egress: {
          ...options.egress(),
          allowPrivateNetwork: transport.network === "private",
          requiredTargetClass: transport.network ?? "public",
          allowLinkLocalAndMetadata: false,
          denyLoopback: true,
          pinProxiedConnectTarget: true,
        },
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new ManagedMcpError("not-admitted");
      }
      return response;
    },
  };
}

function localTransport(
  options: Options,
  server: McpServerDefinition,
): ExternalMcpTransportOptions {
  if (server.transport.kind !== "local") throw new ManagedMcpError("not-admitted");
  const environment = { ...server.transport.environment };
  for (const [name, reference] of Object.entries(server.transport.secretEnvironment ?? {})) {
    const value = options.settings.secret(reference.secretEnv, server);
    if (value === undefined) throw new ManagedMcpError("not-admitted");
    environment[name] = `${reference.prefix ?? ""}${value}`;
  }
  const identity = createHash("sha256").update(server.name).digest("hex");
  const cwd = join(options.stateDir, "mcp-runtime", identity);
  savePrivateJson(join(cwd, "owner.json"), { schemaVersion: 1 });
  return { kind: "local", command: server.transport.command, cwd, environment };
}

function guardedConnection(
  options: Options,
  server: McpServerDefinition,
  signal: AbortSignal,
  connection: ExternalMcpConnection,
): ExternalMcpConnection {
  const secrets = mcpServerSecretReferences(server)
    .map((reference) => options.settings.secret(reference, server))
    .filter((value): value is string => value !== undefined);
  const project = (value: unknown): unknown =>
    deepRedactStrings(value, (text) => redactContent(text, "preserve", secrets));
  // Metadata defines dispatch identities/schema: refuse credential-bearing metadata rather than rewriting it.
  const metadata = JSON.stringify(connection.tools);
  if (redactContent(metadata, "preserve", secrets) !== metadata) {
    void connection.close().catch(() => undefined);
    throw new ManagedMcpError("not-admitted");
  }
  return {
    tools: connection.tools,
    close: () => connection.close(),
    call: async (name, args, context): Promise<CatalogJsonObject> => {
      const beforeEffect = (): boolean => {
        currentGeneration(options, server, context.correlationId);
        return !signal.aborted && context.beforeEffect();
      };
      if (!beforeEffect()) throw new ManagedMcpError("not-admitted");
      const data = await connection.call(name, args, {
        ...context,
        signal: AbortSignal.any([signal, context.signal]),
        beforeEffect,
      });
      if (!beforeEffect()) throw new ManagedMcpError("not-admitted");
      const safe = project(data) as CatalogJsonObject;
      const serialized = JSON.stringify(safe);
      if (redactContent(serialized, "preserve", secrets) !== serialized)
        throw new ManagedMcpError("protocol-error");
      return safe;
    },
  };
}

/** One shared connection per current server definition; Settings commits revoke live transports. */
interface ConnectionEntry {
  readonly signal: AbortSignal;
  readonly connection: Promise<ExternalMcpConnection>;
  endpoint?: ReturnType<typeof createMcpRelayEndpoint>;
}

function endpointFor(
  entry: ConnectionEntry | undefined,
  connection: ExternalMcpConnection,
  server: McpServerDefinition,
): ReturnType<typeof createMcpRelayEndpoint> {
  if (entry === undefined || entry.signal.aborted) throw new ManagedMcpError("not-admitted");
  if (entry.endpoint !== undefined) return entry.endpoint;
  const endpoint = createMcpRelayEndpoint(connection, Object.keys(server.tools));
  entry.endpoint = endpoint;
  entry.signal.addEventListener(
    "abort",
    () => {
      void endpoint.close().catch(() => undefined);
    },
    { once: true },
  );
  return endpoint;
}

export function createConfiguredMcpConnections(options: Options): ConfiguredMcpConnections {
  const lifetime = new AbortController();
  const connections = new Map<string, ConnectionEntry>();
  const manager: ConfiguredMcpConnections = {
    generation: (server, correlationId) => currentGeneration(options, server, correlationId),
    serve: async (name, request, context): Promise<Response> => {
      const pending = manager.connect(name, context.correlationId);
      // Keep the endpoint with the generation that owns this pending connection.
      const entry = connections.get(name);
      const connection = await pending;
      const server = currentServer(options, name, context.correlationId);
      return endpointFor(entry, connection, server).fetch(request, context);
    },
    connect: (name, correlationId): Promise<ExternalMcpConnection> => {
      if (lifetime.signal.aborted) return Promise.reject(new ManagedMcpError("closed"));
      const server = currentServer(options, name, correlationId);
      const generation = currentGeneration(options, server, correlationId);
      const existing = connections.get(name);
      if (existing !== undefined && !existing.signal.aborted) return existing.connection;
      const signal = AbortSignal.any([lifetime.signal, generation]);
      const transport =
        server.transport.kind === "remote"
          ? remoteTransport(options, server, correlationId, signal)
          : localTransport(options, server);
      const connection = (options.connect ?? connectExternalMcp)({
        transport,
        log: options.log,
        correlationId,
        signal,
      }).then((client) => {
        currentGeneration(options, server, correlationId);
        return guardedConnection(options, server, signal, client);
      });
      const entry = { signal, connection };
      connections.set(name, entry);
      void connection.catch(() => {
        if (connections.get(name) === entry) connections.delete(name);
      });
      return connection;
    },
    close: async (): Promise<void> => {
      lifetime.abort();
      await Promise.allSettled(
        [...connections.values()].map(async ({ connection }) => (await connection).close()),
      );
      connections.clear();
    },
  };
  return manager;
}
