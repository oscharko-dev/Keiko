import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import type {
  ExternalMcpConnection,
  ExternalMcpTool,
  ManagedMcpInvocationContext,
} from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import type {
  McpServerDefinition,
  McpRemoteTransport,
  McpServerConnectionView,
} from "@oscharko-dev/keiko-contracts/runtime/mcp-servers";
import { mcpServerSecretReferences } from "@oscharko-dev/keiko-contracts/runtime/mcp-servers";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { deepRedactStrings, redactContent } from "@oscharko-dev/keiko-security";
import {
  connectExternalMcp,
  createMcpRelayEndpoint,
  ManagedMcpError,
  noEffectError,
  supportsOwnedMcpStdio,
  type McpNativeStdioOwner,
  type ExternalMcpTransportOptions,
} from "@oscharko-dev/keiko-mcp";
import {
  gatewayFetch,
  type OutboundHttpEgressConfig,
} from "@oscharko-dev/keiko-model-gateway/internal/http";
import { savePrivateJson } from "../private-json.js";
import { recordMcpRelay, resolveMcpSecretHeaders } from "./mcpCredentialRelay.js";
import { HUNG_TIMEOUTS_BEFORE_RECYCLE, McpReconnectPolicy } from "./mcpReconnectPolicy.js";
import type { McpSettingsStore } from "./mcpSettingsStore.js";
import type { McpAuthorization } from "./mcpAuthorization.js";

export interface ConfiguredMcpConnections {
  /** Current shared runtime facts only; inspection never starts a transport or executes a tool. */
  readonly inspect: (correlationId: string) => readonly McpServerConnectionView[];
  readonly connect: (name: string, correlationId: string) => Promise<ExternalMcpConnection>;
  /**
   * The tools an already connected server advertised, or undefined while it is idle, connecting,
   * failed, unsupported or revoked. A peek: it never starts a transport or awaits one. Absent on a
   * port that cannot peek, which a reader treats as "not connected".
   */
  readonly connectedTools?: (
    name: string,
    correlationId: string,
  ) => readonly ExternalMcpTool[] | undefined;
  readonly generation: (server: McpServerDefinition, correlationId: string) => AbortSignal;
  readonly serve: (
    name: string,
    request: Request,
    context: ManagedMcpInvocationContext,
  ) => Promise<Response>;
  readonly close: () => Promise<void>;
}
interface Options {
  readonly nativeOwner?: McpNativeStdioOwner | undefined;
  readonly authorization?: McpAuthorization;
  readonly settings: McpSettingsStore;
  readonly stateDir: string;
  readonly log: ServerLogSink;
  readonly egress: () => OutboundHttpEgressConfig | undefined;
  readonly connect?: typeof connectExternalMcp;
  readonly fetch?: typeof gatewayFetch;
  /** Clock for the reconnect backoff; tests inject one. */
  readonly now?: () => number;
}

/**
 * What the shared connection's callers report back: a success clears the failure history, and a
 * run of timeouts with no success in between proves the server is connected but hung, so the
 * connection is recycled instead of costing every following call a full deadline.
 */
interface ConnectionHealth {
  readonly succeeded: () => void;
  readonly timedOut: (connection: ExternalMcpConnection, correlationId: string) => void;
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
  if (server.transport.kind !== "remote") throw new ManagedMcpError("not-admitted");
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
      const headers = await authorizedHeaders(options, server, request, correlationId, invocation);
      requireRequestCurrent(options, server, correlationId, signal, invocation);
      const response = await (options.fetch ?? gatewayFetch)(request.url, {
        method: request.method,
        headers,
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

async function authorizedHeaders(
  options: Options,
  server: McpServerDefinition,
  request: Request,
  correlationId: string,
  invocation: ManagedMcpInvocationContext | undefined,
): Promise<Headers> {
  const transport = server.transport;
  if (transport.kind !== "remote") throw new ManagedMcpError("not-admitted");
  const headers = remoteHeaders(options, server, transport, request);
  if (transport.oauth !== undefined) {
    if (options.authorization === undefined) throw new ManagedMcpError("not-admitted");
    const token = await options.authorization.token(server, correlationId);
    invocation?.observeCredential?.(token);
    headers.set("Authorization", `Bearer ${token}`);
  }
  return headers;
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
  return {
    kind: "local",
    command: server.transport.command,
    cwd,
    environment,
    ...(options.nativeOwner === undefined ? {} : { nativeOwner: options.nativeOwner }),
  };
}

function oauthCredentials(options: Options, server: McpServerDefinition): readonly string[] {
  return server.transport.kind === "remote" && server.transport.oauth !== undefined
    ? (options.authorization?.credentials(server) ?? [])
    : [];
}
function projectMcpResult(
  data: CatalogJsonObject,
  credentials: readonly string[],
): CatalogJsonObject {
  const safe = deepRedactStrings(data, (text) =>
    redactContent(text, "preserve", credentials),
  ) as CatalogJsonObject;
  const serialized = JSON.stringify(safe);
  if (redactContent(serialized, "preserve", credentials) !== serialized)
    throw new ManagedMcpError("protocol-error");
  return safe;
}
/** A refusal before the call is effect-free, whether the check says no or cannot be made. */
function admittedBeforeCall(beforeEffect: () => boolean): boolean {
  try {
    return beforeEffect();
  } catch {
    return false;
  }
}
async function callObserved(
  connection: ExternalMcpConnection,
  health: ConnectionHealth,
  name: string,
  args: CatalogJsonObject,
  context: ManagedMcpInvocationContext,
): Promise<CatalogJsonObject> {
  try {
    const data = await connection.call(name, args, context);
    health.succeeded();
    return data;
  } catch (error) {
    if (error instanceof ManagedMcpError && error.reason === "deadline-exceeded")
      health.timedOut(connection, context.correlationId);
    throw error;
  }
}
function guardedConnection(
  options: Options,
  server: McpServerDefinition,
  signal: AbortSignal,
  connection: ExternalMcpConnection,
  health: ConnectionHealth,
): ExternalMcpConnection {
  const secrets = mcpServerSecretReferences(server)
    .map((reference) => options.settings.secret(reference, server))
    .filter((value): value is string => value !== undefined)
    .concat(oauthCredentials(options, server));
  // Metadata defines dispatch identities/schema: refuse credential-bearing metadata rather than rewriting it.
  const metadata = JSON.stringify(connection.tools);
  if (redactContent(metadata, "preserve", secrets) !== metadata) {
    void connection.close().catch(() => undefined);
    throw new ManagedMcpError("not-admitted");
  }
  return {
    signal: connection.signal,
    tools: connection.tools,
    close: () => connection.close(),
    call: async (name, args, context): Promise<CatalogJsonObject> => {
      const credentials = new Set(secrets);
      const beforeEffect = (): boolean => {
        currentGeneration(options, server, context.correlationId);
        return !signal.aborted && context.beforeEffect();
      };
      if (!admittedBeforeCall(beforeEffect)) throw noEffectError("not-admitted");
      const data = await callObserved(connection, health, name, args, {
        ...context,
        signal: AbortSignal.any([signal, context.signal]),
        beforeEffect,
        observeCredential: (value): void => {
          credentials.add(value);
          context.observeCredential?.(value);
        },
      });
      if (!beforeEffect()) throw new ManagedMcpError("not-admitted");
      return projectMcpResult(data, [...credentials, ...oauthCredentials(options, server)]);
    },
  };
}

/** One shared connection per current server definition; Settings commits revoke live transports. */
interface ConnectionEntry {
  readonly signal: AbortSignal;
  readonly connection: Promise<ExternalMcpConnection>;
  client?: ExternalMcpConnection;
  failed: boolean;
  /** The failure that ended this connection is already counted in the reconnect policy. */
  counted: boolean;
  endpoint?: ReturnType<typeof createMcpRelayEndpoint>;
}

function endpointFor(
  entry: ConnectionEntry | undefined,
  connection: ExternalMcpConnection,
  server: McpServerDefinition,
): ReturnType<typeof createMcpRelayEndpoint> {
  if (entry === undefined || entry.signal.aborted) throw new ManagedMcpError("not-admitted");
  if (entry.endpoint !== undefined) return entry.endpoint;
  const endpoint = createMcpRelayEndpoint(connection, server.tools);
  entry.endpoint = endpoint;
  AbortSignal.any([entry.signal, connection.signal]).addEventListener(
    "abort",
    () => {
      void endpoint.close().catch(() => undefined);
    },
    { once: true },
  );
  return endpoint;
}

function unsupportedLocalServer(options: Options, server: McpServerDefinition): boolean {
  return (
    server.transport.kind === "local" &&
    !supportsOwnedMcpStdio(process.platform, options.nativeOwner)
  );
}
function currentEntry(
  entry: ConnectionEntry | undefined,
  generation: AbortSignal,
): entry is ConnectionEntry {
  return !generation.aborted && entry !== undefined && !entry.signal.aborted;
}
function connectionView(
  options: Options,
  connections: ReadonlyMap<string, ConnectionEntry>,
  server: McpServerDefinition,
  correlationId: string,
): McpServerConnectionView {
  const idle = {
    name: server.name,
    state: server.enabled ? "idle" : "disabled",
    toolCount: null,
  } as const;
  if (!server.enabled) return idle;
  if (unsupportedLocalServer(options, server))
    return { name: server.name, state: "unsupported", toolCount: null };
  const generation = currentGeneration(options, server, correlationId);
  const entry = connections.get(server.name);
  if (!currentEntry(entry, generation)) return idle;
  if (entry.failed || entry.client?.signal.aborted === true)
    return { name: server.name, state: "failed", toolCount: null };
  return entry.client === undefined
    ? { name: server.name, state: "connecting", toolCount: null }
    : { name: server.name, state: "connected", toolCount: entry.client.tools.length };
}
function connectedToolsOf(
  options: Options,
  connections: ReadonlyMap<string, ConnectionEntry>,
  name: string,
  correlationId: string,
): readonly ExternalMcpTool[] | undefined {
  const server = options.settings.read(correlationId).servers.find((entry) => entry.name === name);
  if (server === undefined) return undefined;
  const view = connectionView(options, connections, server, correlationId);
  return view.state === "connected" ? connections.get(name)?.client?.tools : undefined;
}
async function openConnection(
  options: Options,
  server: McpServerDefinition,
  signal: AbortSignal,
  correlationId: string,
  previous: ExternalMcpConnection | undefined,
  health: ConnectionHealth,
): Promise<ExternalMcpConnection> {
  await previous?.close();
  const transport =
    server.transport.kind === "remote"
      ? remoteTransport(options, server, correlationId, signal)
      : localTransport(options, server);
  const client = await (options.connect ?? connectExternalMcp)({
    transport,
    log: options.log,
    correlationId,
    signal,
    // Automatic discovery needs the whole catalog; otherwise only the registry's tools matter.
    allowedTools: server.discovery === "automatic" ? undefined : Object.keys(server.tools),
    serverDigest: createHash("sha256").update(server.name).digest("hex"),
  });
  currentGeneration(options, server, correlationId);
  if (signal.aborted || client.signal.aborted) {
    await client.close();
    throw new ManagedMcpError("closed");
  }
  return guardedConnection(options, server, signal, client, health);
}
/** A connection that ended on its own, other than by a catalog change, counts as a failure. */
function noteEndedConnection(
  existing: ConnectionEntry | undefined,
  policy: McpReconnectPolicy,
  name: string,
): void {
  const reason: unknown = existing?.client?.signal.reason;
  if (
    existing?.client?.signal.aborted !== true ||
    existing.counted ||
    (reason instanceof ManagedMcpError && reason.reason === "descriptor-drift")
  )
    return;
  // Once per ended connection: later calls during the backoff see the same dead entry.
  existing.counted = true;
  policy.failed(name);
}
function refuseDuringBackoff(
  options: Options,
  policy: McpReconnectPolicy,
  name: string,
  correlationId: string,
): ManagedMcpError | undefined {
  try {
    policy.admit(name);
    return undefined;
  } catch (error) {
    recordMcpRelay(options.log, correlationId, {
      action: "request",
      outcome: "refused",
      reason: "reconnect-backoff",
      failureCount: policy.failures(name),
      backoffMs: policy.remainingMs(name),
    });
    return error instanceof ManagedMcpError ? error : new ManagedMcpError("backoff");
  }
}
function healthOf(
  options: Options,
  policy: McpReconnectPolicy,
  name: string,
  entry: () => ConnectionEntry,
): ConnectionHealth {
  let timeouts = 0;
  return {
    succeeded: (): void => {
      timeouts = 0;
      policy.succeeded(name);
    },
    timedOut: (connection, correlationId): void => {
      if (++timeouts < HUNG_TIMEOUTS_BEFORE_RECYCLE) return;
      timeouts = 0;
      entry().counted = true;
      const failures = policy.failed(name);
      recordMcpRelay(options.log, correlationId, {
        action: "request",
        outcome: "failed",
        reason: "server-hung-recycled",
        failureCount: failures,
        backoffMs: policy.remainingMs(name),
      });
      void connection.close().catch(() => undefined);
    },
  };
}
function connectCurrent(
  options: Options,
  lifetime: AbortSignal,
  connections: Map<string, ConnectionEntry>,
  policy: McpReconnectPolicy,
  name: string,
  correlationId: string,
): Promise<ExternalMcpConnection> {
  if (lifetime.aborted) return Promise.reject(new ManagedMcpError("closed"));
  const server = currentServer(options, name, correlationId);
  const generation = currentGeneration(options, server, correlationId);
  const existing = connections.get(name);
  if (
    existing !== undefined &&
    !existing.signal.aborted &&
    !existing.failed &&
    existing.client?.signal.aborted !== true
  )
    return existing.connection;
  noteEndedConnection(existing, policy, name);
  const refused = refuseDuringBackoff(options, policy, name, correlationId);
  if (refused !== undefined) return Promise.reject(refused);
  const signal = AbortSignal.any([lifetime, generation]);
  const health = healthOf(options, policy, name, () => entry);
  const connection = openConnection(
    options,
    server,
    signal,
    correlationId,
    existing?.client,
    health,
  ).then((client) => {
    entry.client = client;
    return client;
  });
  const entry: ConnectionEntry = { signal, connection, failed: false, counted: false };
  connections.set(name, entry);
  watchEntry(connections, policy, name, entry, generation);
  return connection;
}
function watchEntry(
  connections: Map<string, ConnectionEntry>,
  policy: McpReconnectPolicy,
  name: string,
  entry: ConnectionEntry,
  generation: AbortSignal,
): void {
  entry.signal.addEventListener(
    "abort",
    () => {
      if (connections.get(name) === entry) connections.delete(name);
      // A changed configuration or a shutdown starts from a clean slate, not from old failures.
      if (generation.aborted) policy.succeeded(name);
    },
    { once: true },
  );
  void entry.connection.catch(() => {
    entry.failed = true;
    if (!entry.signal.aborted) policy.failed(name);
  });
}
export function createConfiguredMcpConnections(options: Options): ConfiguredMcpConnections {
  const lifetime = new AbortController();
  const connections = new Map<string, ConnectionEntry>();
  const policy = new McpReconnectPolicy(options.now);
  const manager: ConfiguredMcpConnections = {
    inspect: (correlationId) =>
      options.settings
        .read(correlationId)
        .servers.map((server) => connectionView(options, connections, server, correlationId)),
    connectedTools: (name, correlationId) =>
      connectedToolsOf(options, connections, name, correlationId),
    generation: (server, correlationId) => currentGeneration(options, server, correlationId),
    serve: async (name, request, context): Promise<Response> => {
      const pending = manager.connect(name, context.correlationId);
      const entry = connections.get(name);
      const connection = await pending;
      const server = currentServer(options, name, context.correlationId);
      return endpointFor(entry, connection, server).fetch(request, context);
    },
    connect: (name, correlationId) =>
      connectCurrent(options, lifetime.signal, connections, policy, name, correlationId),
    close: async (): Promise<void> => {
      await options.authorization?.close();
      const pending = [...connections.values()];
      lifetime.abort();
      await Promise.allSettled(pending.map(async ({ connection }) => (await connection).close()));
      connections.clear();
    },
  };
  return manager;
}
