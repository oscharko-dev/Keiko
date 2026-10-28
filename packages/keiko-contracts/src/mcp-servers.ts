// The operator's MCP server registry (#3903, parity row C04): the one place Keiko learns which Model
// Context Protocol servers it may admit, shared by every surface that will consume MCP tools (the
// Coding Workbench now; Chat and other components later). A registry entry grants nothing on its
// own: a consumer admits a server only within its own authority and mode, and an MCP tool the
// registry does not name is never callable.
//
// The grammar is closed. A server name is a short lowercase word (no `_`, so the runtime's
// `<server>_<tool>` action name splits unambiguously); a local server is an absolute executable
// with literal arguments; a remote server is an `https` URL; every tool the server may expose is
// named with its declared risk. No credential is part of this registry: an environment value is a
// literal the operator writes, and a remote server's credential header names only the
// `KEIKO_MCP_SECRET_*` variable of Keiko's own environment that holds it (#3903 AC3), which Keiko
// adds to the requests it relays and never hands to a runtime.

export const MCP_SERVER_REGISTRY_SCHEMA_VERSION = 1;
export const MCP_SERVER_MAX = 16;
export const MCP_SERVER_TOOL_MAX = 64;
const MCP_SERVER_NAME = /^[a-z][a-z0-9_-]{0,63}$/u;
const MCP_TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u;
const MCP_ENVIRONMENT_NAME = /^[A-Z][A-Z0-9_]{0,63}$/u;
const MCP_ARGUMENT_MAX = 32;
const MCP_TEXT_MAX = 1024;
const MCP_ENVIRONMENT_MAX = 16;
const MCP_OAUTH_CLIENT_ID = /^[\x21-\x7E]{1,256}$/u;
const MCP_OAUTH_SCOPE = /^[\x21\x23-\x5B\x5D-\x7E]+(?: [\x21\x23-\x5B\x5D-\x7E]+)*$/u;
/** The only variables of Keiko's environment a registry entry may name: set aside for MCP. */
export const MCP_SECRET_ENVIRONMENT_PREFIX = "KEIKO_MCP_SECRET_";
const MCP_SECRET_ENVIRONMENT_NAME = /^KEIKO_MCP_SECRET_[A-Z0-9_]{1,96}$/u;
const MCP_HEADER_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/u;
const MCP_HEADER_PREFIX = /^[\x20-\x7E]{1,32}$/u;
const MCP_HEADER_MAX = 8;
// Headers the transport, the relay or the HTTP connection own: never a credential header.
const MCP_RESERVED_HEADERS: ReadonlySet<string> = new Set([
  "accept",
  "connection",
  "content-length",
  "content-type",
  "cookie",
  "host",
  "keep-alive",
  "last-event-id",
  "mcp-protocol-version",
  "mcp-session-id",
  "origin",
  "proxy-authorization",
  "proxy-connection",
  "referer",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-keiko-csrf",
  "x-keiko-mcp-relay",
]);

/** What a tool may do, as the operator declares it; the consumer maps it onto its own policy. */
export type McpToolRisk = "read" | "write";

export interface McpLocalTransport {
  readonly kind: "local";
  /** An absolute executable followed by its literal arguments. */
  readonly command: readonly [string, ...string[]];
  /** Literal, non-secret variables; the process starts from an empty environment plus these. */
  readonly environment: Readonly<Record<string, string>>;
  /** Sealed values, resolved only for this server's process; never placed in runtime config. */
  readonly secretEnvironment?: Readonly<Record<string, McpRemoteSecretHeader>>;
}

/**
 * OAuth for a remote server (#3903 AC3). The operator names the authorization server's issuer
 * identifier it expects (RFC 8414 §2: an https URL without query or fragment, compared exactly as
 * written); a consumer admits the server only once that issuer's own metadata names the same
 * issuer. The client is public: an id the operator registered, or none for dynamic registration.
 * No client secret or token belongs in this registry.
 */
export interface McpRemoteOAuth {
  readonly issuer: string;
  readonly clientId?: string;
  /** Space-separated scope tokens (RFC 6749 §3.3). */
  readonly scope?: string;
}

/**
 * A static credential header of a remote server (#3903 AC3): the value is read from the named
 * `KEIKO_MCP_SECRET_*` variable of Keiko's environment, after an optional literal prefix such as
 * `Bearer `. Keiko adds it to every request it relays to the server; the runtime never holds it.
 */
export interface McpRemoteSecretHeader {
  readonly secretEnv: string;
  readonly prefix?: string;
}

export interface McpRemoteTransport {
  readonly kind: "remote";
  readonly url: string;
  /** Absent: the server is used without OAuth. */
  readonly oauth?: McpRemoteOAuth;
  /** Credential headers by name; absent: the server needs none. Never together with `oauth`. */
  readonly headers?: Readonly<Record<string, McpRemoteSecretHeader>>;
}

export interface McpServerDefinition {
  readonly name: string;
  readonly description: string | undefined;
  readonly enabled: boolean;
  readonly transport: McpLocalTransport | McpRemoteTransport;
  readonly tools: Readonly<Record<string, McpToolRisk>>;
  /** Discovery is metadata only; consumers still admit every call under their own authority. */
  readonly discovery?: "automatic";
}

export type McpServerRegistryRefusal =
  "malformed" | "schema-version" | "too-many-servers" | "server-invalid" | "duplicate-server";

export type McpServerRegistryParse =
  | { readonly ok: true; readonly servers: readonly McpServerDefinition[] }
  | { readonly ok: false; readonly reason: McpServerRegistryRefusal };

type Json = Readonly<Record<string, unknown>>;

function record(value: unknown): Json | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

function boundedText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MCP_TEXT_MAX;
}

function hasOnlyKeys(value: Json, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function noControl(value: string): boolean {
  return !/\p{Cc}/u.test(value);
}

// The runtime substitutes `{env:NAME}` and `{file:path}` in a server's command, environment and URL
// from its own environment and files, which hold Keiko's capabilities: only literal text is
// admitted anywhere in a definition.
function literal(value: string): boolean {
  return noControl(value) && !value.includes("{env:") && !value.includes("{file:");
}

function localTransport(value: Json): McpLocalTransport | undefined {
  if (!hasOnlyKeys(value, ["kind", "command", "environment", "secretEnvironment"]))
    return undefined;
  const command = localCommand(value.command);
  if (command === undefined) return undefined;
  const environment = environmentOf(value.environment);
  if (environment === undefined) return undefined;
  const secretEnvironment = secretEnvironmentOf(value.secretEnvironment, environment);
  if (secretEnvironment === undefined) return undefined;
  return {
    kind: "local",
    command,
    environment,
    ...(value.secretEnvironment === undefined ? {} : { secretEnvironment }),
  };
}

function localCommand(command: unknown): readonly [string, ...string[]] | undefined {
  if (!Array.isArray(command) || command.length === 0 || command.length > MCP_ARGUMENT_MAX)
    return undefined;
  if (!command.every((part) => boundedText(part) && literal(part))) return undefined;
  const [executable, ...args] = command as string[];
  return executable?.startsWith("/") ? [executable, ...args] : undefined;
}

function secretEnvironmentOf(
  value: unknown,
  environment: Readonly<Record<string, string>>,
): Readonly<Record<string, McpRemoteSecretHeader>> | undefined {
  if (value === undefined) return {};
  const secrets = record(value);
  if (secrets === undefined || Object.keys(secrets).length > MCP_ENVIRONMENT_MAX) return undefined;
  const result: Record<string, McpRemoteSecretHeader> = {};
  for (const [name, raw] of Object.entries(secrets)) {
    const reference = secretHeaderOf("X-Mcp-Secret", raw);
    if (!MCP_ENVIRONMENT_NAME.test(name) || reference === undefined || name in environment)
      return undefined;
    result[name] = reference;
  }
  return result;
}

function environmentOf(value: unknown): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return {};
  const entries = record(value);
  if (entries === undefined || Object.keys(entries).length > MCP_ENVIRONMENT_MAX) return undefined;
  const pairs = Object.entries(entries);
  const valid = pairs.every(
    ([name, text]) =>
      MCP_ENVIRONMENT_NAME.test(name) &&
      typeof text === "string" &&
      text.length <= MCP_TEXT_MAX &&
      literal(text),
  );
  return valid ? Object.fromEntries(pairs as [string, string][]) : undefined;
}

function remoteUrl(value: unknown): string | undefined {
  if (!boundedText(value) || !literal(value)) return undefined;
  // Parsed without a catch: a malformed URL is a refused definition, not a failure.
  if (!URL.canParse(value)) return undefined;
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return undefined;
  return url.href;
}

function remoteTransport(value: Json): McpRemoteTransport | undefined {
  if (!hasOnlyKeys(value, ["kind", "url", "oauth", "headers"])) return undefined;
  const url = remoteUrl(value.url);
  if (url === undefined) return undefined;
  // A relayed server is reached at Keiko's address, which no OAuth resource binding can name.
  if (value.oauth !== undefined && value.headers !== undefined) return undefined;
  if (value.headers !== undefined) {
    const headers = secretHeadersOf(value.headers);
    return headers === undefined ? undefined : { kind: "remote", url, headers };
  }
  if (value.oauth === undefined) return { kind: "remote", url };
  const oauth = oauthOf(value.oauth);
  return oauth === undefined ? undefined : { kind: "remote", url, oauth };
}

function secretHeaderOf(name: string, value: unknown): McpRemoteSecretHeader | undefined {
  const header = record(value);
  if (header === undefined || !hasOnlyKeys(header, ["secretEnv", "prefix"])) return undefined;
  if (!MCP_HEADER_NAME.test(name) || MCP_RESERVED_HEADERS.has(name.toLowerCase())) return undefined;
  const { secretEnv, prefix } = header;
  if (typeof secretEnv !== "string" || !MCP_SECRET_ENVIRONMENT_NAME.test(secretEnv))
    return undefined;
  if (!optionalMatch(prefix, MCP_HEADER_PREFIX)) return undefined;
  return { secretEnv, ...(prefix === undefined ? {} : { prefix: prefix as string }) };
}

function secretHeadersOf(
  value: unknown,
): Readonly<Record<string, McpRemoteSecretHeader>> | undefined {
  const headers = record(value);
  if (headers === undefined) return undefined;
  const entries = Object.entries(headers);
  if (entries.length === 0 || entries.length > MCP_HEADER_MAX) return undefined;
  // HTTP header names are case-insensitive: two spellings of one name cannot both be sent.
  if (new Set(entries.map(([name]) => name.toLowerCase())).size !== entries.length)
    return undefined;
  const admitted: Record<string, McpRemoteSecretHeader> = {};
  for (const [name, entry] of entries) {
    const header = secretHeaderOf(name, entry);
    if (header === undefined) return undefined;
    admitted[name] = header;
  }
  return admitted;
}

function oauthOf(value: unknown): McpRemoteOAuth | undefined {
  const oauth = record(value);
  if (oauth === undefined || !hasOnlyKeys(oauth, ["issuer", "clientId", "scope"])) return undefined;
  const { issuer, clientId, scope } = oauth;
  if (typeof issuer !== "string" || !issuerIdentifier(issuer)) return undefined;
  if (!optionalMatch(clientId, MCP_OAUTH_CLIENT_ID) || !optionalMatch(scope, MCP_OAUTH_SCOPE))
    return undefined;
  return {
    issuer,
    ...(clientId === undefined ? {} : { clientId: clientId as string }),
    ...(scope === undefined ? {} : { scope: scope as string }),
  };
}

// Absent, or a bounded literal of the grammar.
function optionalMatch(value: unknown, grammar: RegExp): boolean {
  if (value === undefined) return true;
  return (
    typeof value === "string" &&
    value.length <= MCP_TEXT_MAX &&
    grammar.test(value) &&
    literal(value)
  );
}

// RFC 8414 §2: an https URL with no query and no fragment, kept exactly as written.
function issuerIdentifier(value: string): boolean {
  if (!boundedText(value) || !literal(value) || /[?#\s]/u.test(value) || !URL.canParse(value))
    return false;
  const url = new URL(value);
  return url.protocol === "https:" && url.username === "" && url.password === "";
}

function transportOf(value: unknown): McpLocalTransport | McpRemoteTransport | undefined {
  const transport = record(value);
  if (transport?.kind === "local") return localTransport(transport);
  if (transport?.kind === "remote") return remoteTransport(transport);
  return undefined;
}

function toolsOf(
  value: unknown,
  automatic: boolean,
): Readonly<Record<string, McpToolRisk>> | undefined {
  const tools = record(value);
  if (tools === undefined) return undefined;
  const entries = Object.entries(tools);
  if ((!automatic && entries.length === 0) || entries.length > MCP_SERVER_TOOL_MAX)
    return undefined;
  const valid = entries.every(
    ([name, risk]) => MCP_TOOL_NAME.test(name) && (risk === "read" || risk === "write"),
  );
  // Two tools the runtime would name alike (`a.b` and `a_b`) cannot carry two risks.
  const actions = new Set(entries.map(([name]) => mcpToolAction("s", name)));
  if (!valid || actions.size !== entries.length) return undefined;
  return Object.fromEntries(entries as [string, McpToolRisk][]);
}

// The name, description and switch of one entry, or undefined when any of them is malformed.
function serverHeader(
  server: Json,
): Pick<McpServerDefinition, "name" | "description" | "enabled"> | undefined {
  const { name, description, enabled } = server;
  if (typeof name !== "string" || !MCP_SERVER_NAME.test(name)) return undefined;
  if (description !== undefined && !(boundedText(description) && noControl(description)))
    return undefined;
  if (enabled !== undefined && typeof enabled !== "boolean") return undefined;
  return { name, description, enabled: enabled !== false };
}

function serverOf(value: unknown): McpServerDefinition | undefined {
  const server = record(value);
  if (server === undefined) return undefined;
  if (!hasOnlyKeys(server, ["name", "description", "enabled", "transport", "tools", "discovery"]))
    return undefined;
  const header = serverHeader(server);
  const transport = transportOf(server.transport);
  if (server.discovery !== undefined && server.discovery !== "automatic") return undefined;
  const tools = toolsOf(server.tools, server.discovery === "automatic");
  if (header === undefined || transport === undefined || tools === undefined) return undefined;
  return {
    ...header,
    transport,
    tools,
    ...(server.discovery === "automatic" ? { discovery: "automatic" as const } : {}),
  };
}

/**
 * The registry document as the operator wrote it, or the closed reason it is refused. One invalid
 * server refuses the whole registry: a partial admission would hide which entry the operator got
 * wrong.
 */
export function parseMcpServerRegistry(value: unknown): McpServerRegistryParse {
  const document = record(value);
  if (document === undefined || !hasOnlyKeys(document, ["schemaVersion", "servers"]))
    return { ok: false, reason: "malformed" };
  if (document.schemaVersion !== MCP_SERVER_REGISTRY_SCHEMA_VERSION)
    return { ok: false, reason: "schema-version" };
  const entries = document.servers;
  if (!Array.isArray(entries)) return { ok: false, reason: "malformed" };
  if (entries.length > MCP_SERVER_MAX) return { ok: false, reason: "too-many-servers" };
  const servers: McpServerDefinition[] = [];
  const actions = new Set<string>();
  for (const entry of entries) {
    const server = serverOf(entry);
    if (server === undefined) return { ok: false, reason: "server-invalid" };
    if (servers.some(({ name }) => name === server.name))
      return { ok: false, reason: "duplicate-server" };
    if (!admitUniqueActions(server, actions)) return { ok: false, reason: "server-invalid" };
    servers.push(server);
  }
  return { ok: true, servers };
}

function admitUniqueActions(server: McpServerDefinition, actions: Set<string>): boolean {
  for (const tool of Object.keys(server.tools)) {
    const action = mcpToolAction(server.name, tool);
    if (actions.has(action)) return false;
    actions.add(action);
  }
  return true;
}

/**
 * The permission action an MCP tool reaches a runtime's policy under: `<server>_<tool>`, with the
 * tool name's characters outside `[A-Za-z0-9_-]` replaced by `_`, as OpenCode 2.1.4 names it.
 */
export function mcpToolAction(server: string, tool: string): string {
  return `${server}_${tool.replaceAll(/[^A-Za-z0-9_-]/gu, "_")}`;
}

/** The admitted actions of the enabled servers, each with its declared risk and transport. */
export function mcpToolActions(
  servers: readonly McpServerDefinition[],
): ReadonlyMap<string, { readonly risk: McpToolRisk; readonly remote: boolean }> {
  const actions = new Map<string, { readonly risk: McpToolRisk; readonly remote: boolean }>();
  for (const server of servers) {
    if (!server.enabled) continue;
    for (const [tool, risk] of Object.entries(server.tools)) {
      actions.set(mcpToolAction(server.name, tool), {
        risk,
        remote: server.transport.kind === "remote",
      });
    }
  }
  return actions;
}

// ---- The Coding Workbench's view of a run's MCP servers (#3903 AC3) ----------------------------
//
// A live native run lists the servers its binding admitted, each with a closed status, and lets the
// human authorize one that uses OAuth: Keiko starts the runtime's own authorization, shows the URL
// only once it addresses the validated endpoint of the operator's expected issuer, and reports the
// attempt's state. The runtime's error text never reaches the browser.

export const CODING_WORKBENCH_MCP_SERVER_STATUSES = [
  "connected",
  "needs-authorization",
  "failed",
  "disabled",
  "pending",
] as const;
export type CodingWorkbenchMcpServerStatus = (typeof CODING_WORKBENCH_MCP_SERVER_STATUSES)[number];

export interface CodingWorkbenchMcpServer {
  readonly name: string;
  readonly status: CodingWorkbenchMcpServerStatus;
  readonly authorization: "oauth" | "none";
}

/** `GET /runs/:runId/mcp`: absent `servers` when the run offers none; unpaired, the one constant. */
export interface CodingWorkbenchRuntimeMcpChannelPayload {
  readonly session: "active" | "unpaired";
  readonly servers?: readonly CodingWorkbenchMcpServer[] | undefined;
}

export function unpairedCodingWorkbenchRuntimeMcpChannelPayload(): CodingWorkbenchRuntimeMcpChannelPayload {
  return { session: "unpaired" };
}

export const CODING_WORKBENCH_MCP_AUTHORIZATION_REFUSALS = [
  "unavailable",
  "not-oauth",
  "connected",
  "url-refused",
  "failed",
] as const;
export type CodingWorkbenchMcpAuthorizationRefusal =
  (typeof CODING_WORKBENCH_MCP_AUTHORIZATION_REFUSALS)[number];

/** `POST /runs/:runId/mcp/authorization` answer. */
export type CodingWorkbenchMcpAuthorizationStart =
  | {
      readonly outcome: "started";
      readonly attemptId: string;
      /** The validated authorization URL the human opens in their browser. */
      readonly authorizationUrl: string;
      readonly expiresAtMs: number;
    }
  | { readonly outcome: "refused"; readonly reason: CodingWorkbenchMcpAuthorizationRefusal };

export const CODING_WORKBENCH_MCP_AUTHORIZATION_STATES = [
  "pending",
  "complete",
  "failed",
  "expired",
  "cancelled",
  "unavailable",
] as const;
export type CodingWorkbenchMcpAuthorizationState =
  (typeof CODING_WORKBENCH_MCP_AUTHORIZATION_STATES)[number];

/** `POST /runs/:runId/mcp/authorization/status` and `/cancel` answer. */
export interface CodingWorkbenchMcpAuthorizationStatus {
  readonly state: CodingWorkbenchMcpAuthorizationState;
}

/** The request of every authorization route: the server, and for status and cancel its attempt. */
export interface CodingWorkbenchMcpAuthorizationRequest {
  readonly server: string;
  readonly attemptId?: string | undefined;
}

const MCP_ATTEMPT_ID = /^con_[A-Za-z0-9]{1,64}$/u;
const MCP_AUTHORIZATION_URL_MAX = 8_192;

export function isMcpServerName(value: unknown): value is string {
  return typeof value === "string" && MCP_SERVER_NAME.test(value);
}

export function isMcpAuthorizationAttemptId(value: unknown): value is string {
  return typeof value === "string" && MCP_ATTEMPT_ID.test(value);
}

function isOneOfValues<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function workbenchServer(value: unknown): CodingWorkbenchMcpServer | undefined {
  const entry = record(value);
  if (entry === undefined || !hasOnlyKeys(entry, ["name", "status", "authorization"]))
    return undefined;
  const { name, status, authorization } = entry;
  if (!isMcpServerName(name) || !isOneOfValues(status, CODING_WORKBENCH_MCP_SERVER_STATUSES))
    return undefined;
  if (authorization !== "oauth" && authorization !== "none") return undefined;
  return { name, status, authorization };
}

/** The channel payload, or undefined when it is not exactly one: the browser trusts nothing else. */
export function parseCodingWorkbenchRuntimeMcpChannelPayload(
  value: unknown,
): CodingWorkbenchRuntimeMcpChannelPayload | undefined {
  const payload = record(value);
  if (payload === undefined || !hasOnlyKeys(payload, ["session", "servers"])) return undefined;
  if (payload.session === "unpaired")
    return payload.servers === undefined ? { session: "unpaired" } : undefined;
  if (payload.session !== "active") return undefined;
  if (payload.servers === undefined) return { session: "active" };
  const servers = workbenchServers(payload.servers);
  return servers === undefined ? undefined : { session: "active", servers };
}

// A bounded list of well-formed servers with distinct names, or undefined.
function workbenchServers(value: unknown): readonly CodingWorkbenchMcpServer[] | undefined {
  if (!Array.isArray(value) || value.length > MCP_SERVER_MAX) return undefined;
  const servers: CodingWorkbenchMcpServer[] = [];
  for (const entry of value as readonly unknown[]) {
    const server = workbenchServer(entry);
    if (server === undefined || servers.some(({ name }) => name === server.name)) return undefined;
    servers.push(server);
  }
  return servers;
}

export function parseCodingWorkbenchMcpAuthorizationStart(
  value: unknown,
): CodingWorkbenchMcpAuthorizationStart | undefined {
  const answer = record(value);
  if (answer?.outcome === "refused")
    return hasOnlyKeys(answer, ["outcome", "reason"]) &&
      isOneOfValues(answer.reason, CODING_WORKBENCH_MCP_AUTHORIZATION_REFUSALS)
      ? { outcome: "refused", reason: answer.reason }
      : undefined;
  return answer?.outcome === "started" ? startedAuthorization(answer) : undefined;
}

function startedAuthorization(answer: Json): CodingWorkbenchMcpAuthorizationStart | undefined {
  if (!hasOnlyKeys(answer, ["outcome", "attemptId", "authorizationUrl", "expiresAtMs"]))
    return undefined;
  const { attemptId, authorizationUrl, expiresAtMs } = answer;
  const valid =
    isMcpAuthorizationAttemptId(attemptId) &&
    httpsAuthorizationUrl(authorizationUrl) &&
    typeof expiresAtMs === "number" &&
    Number.isSafeInteger(expiresAtMs);
  return valid ? { outcome: "started", attemptId, authorizationUrl, expiresAtMs } : undefined;
}

function httpsAuthorizationUrl(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MCP_AUTHORIZATION_URL_MAX &&
    URL.canParse(value) &&
    new URL(value).protocol === "https:"
  );
}

export function parseCodingWorkbenchMcpAuthorizationStatus(
  value: unknown,
): CodingWorkbenchMcpAuthorizationStatus | undefined {
  const answer = record(value);
  return answer !== undefined &&
    hasOnlyKeys(answer, ["state"]) &&
    isOneOfValues(answer.state, CODING_WORKBENCH_MCP_AUTHORIZATION_STATES)
    ? { state: answer.state }
    : undefined;
}

/** The server's reading of a route body; undefined refuses the request as malformed. */
export function parseCodingWorkbenchMcpAuthorizationRequest(
  value: unknown,
  requireAttempt: boolean,
): CodingWorkbenchMcpAuthorizationRequest | undefined {
  const body = record(value);
  if (body === undefined || !hasOnlyKeys(body, ["server", "attemptId"])) return undefined;
  if (!isMcpServerName(body.server)) return undefined;
  if (body.attemptId === undefined) return requireAttempt ? undefined : { server: body.server };
  return isMcpAuthorizationAttemptId(body.attemptId)
    ? { server: body.server, attemptId: body.attemptId }
    : undefined;
}

/** Shared Settings projection. Secret values are write-only and never part of this document. */
export interface McpSettingsSnapshot {
  readonly revision: string;
  readonly servers: readonly McpServerDefinition[];
  /** Committed configuration is authoritative even when encrypted orphan cleanup needs retry. */
  readonly credentialCleanup?: "pending";
}
export interface McpSettingsSecretInput {
  readonly server: string;
  readonly value: string;
}
export interface McpSettingsUpdate {
  readonly expectedRevision: string;
  readonly servers: readonly McpServerDefinition[];
  readonly secrets: Readonly<Record<string, McpSettingsSecretInput>>;
}

/** One bounded mutation; registry parsing remains the canonical definition validator. */
export function parseMcpSettingsUpdate(value: unknown): McpSettingsUpdate | undefined {
  const body = record(value);
  if (body === undefined || !hasOnlyKeys(body, ["expectedRevision", "servers", "secrets"]))
    return undefined;
  if (typeof body.expectedRevision !== "string" || !/^[a-f0-9]{64}$/u.test(body.expectedRevision))
    return undefined;
  const registry = parseMcpServerRegistry({ schemaVersion: 1, servers: body.servers });
  const secrets = body.secrets === undefined ? {} : record(body.secrets);
  if (!registry.ok || secrets === undefined || Object.keys(secrets).length > 64) return undefined;
  const admitted = settingsSecrets(secrets, registry.servers);
  if (admitted === undefined) return undefined;
  return { expectedRevision: body.expectedRevision, servers: registry.servers, secrets: admitted };
}

function settingsSecret(raw: unknown): McpSettingsSecretInput | undefined {
  const secret = record(raw);
  if (
    secret === undefined ||
    !hasOnlyKeys(secret, ["server", "value"]) ||
    typeof secret.server !== "string" ||
    typeof secret.value !== "string" ||
    secret.value.length === 0 ||
    secret.value.length > 8192 ||
    secret.value.includes("\0")
  )
    return undefined;
  return { server: secret.server, value: secret.value };
}

function settingsSecrets(
  secrets: Json,
  servers: readonly McpServerDefinition[],
): Readonly<Record<string, McpSettingsSecretInput>> | undefined {
  const admitted: Record<string, McpSettingsSecretInput> = {};
  for (const [name, raw] of Object.entries(secrets)) {
    const secret = settingsSecret(raw);
    if (!MCP_SECRET_ENVIRONMENT_NAME.test(name) || secret === undefined) return undefined;
    const owners = servers.filter((entry) => mcpServerSecretReferences(entry).includes(name));
    if (owners.length !== 1 || owners[0]?.name !== secret.server) return undefined;
    admitted[name] = secret;
  }
  return admitted;
}

export function mcpServerSecretReferences(server: McpServerDefinition): readonly string[] {
  const transport = server.transport;
  const entries = transport.kind === "local" ? transport.secretEnvironment : transport.headers;
  return [...new Set(Object.values(entries ?? {}).map((entry) => entry.secretEnv))];
}
