// The operator's MCP server registry (#3903, parity row C04): the one place Keiko learns which Model
// Context Protocol servers it may admit, shared by every surface that will consume MCP tools (the
// Coding Workbench now; Chat and other components later). A registry entry grants nothing on its
// own: a consumer admits a server only within its own authority and mode, and an MCP tool the
// registry does not name is never callable.
//
// The grammar is closed. A server name is a short lowercase word (no `_`, so the runtime's
// `<server>_<tool>` action name splits unambiguously); a local server is an absolute executable
// with literal arguments; a remote server is an `https` URL; every tool the server may expose is
// named with its declared risk. Credentials are not part of this registry: an environment value is
// a literal the operator writes, and nothing here reads Keiko's own environment.

export const MCP_SERVER_REGISTRY_SCHEMA_VERSION = 1;
export const MCP_SERVER_MAX = 16;
export const MCP_SERVER_TOOL_MAX = 64;
const MCP_SERVER_NAME = /^[a-z][a-z0-9]{0,30}$/u;
const MCP_TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u;
const MCP_ENVIRONMENT_NAME = /^[A-Z][A-Z0-9_]{0,63}$/u;
const MCP_ARGUMENT_MAX = 32;
const MCP_TEXT_MAX = 1024;
const MCP_ENVIRONMENT_MAX = 16;

/** What a tool may do, as the operator declares it; the consumer maps it onto its own policy. */
export type McpToolRisk = "read" | "write";

export interface McpLocalTransport {
  readonly kind: "local";
  /** An absolute executable followed by its literal arguments. */
  readonly command: readonly [string, ...string[]];
  /** Literal, non-secret variables; the process starts from an empty environment plus these. */
  readonly environment: Readonly<Record<string, string>>;
}

export interface McpRemoteTransport {
  readonly kind: "remote";
  readonly url: string;
}

export interface McpServerDefinition {
  readonly name: string;
  readonly description: string | undefined;
  readonly enabled: boolean;
  readonly transport: McpLocalTransport | McpRemoteTransport;
  readonly tools: Readonly<Record<string, McpToolRisk>>;
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
  if (!hasOnlyKeys(value, ["kind", "command", "environment"])) return undefined;
  const command = value.command;
  if (!Array.isArray(command) || command.length === 0 || command.length > MCP_ARGUMENT_MAX)
    return undefined;
  if (!command.every((part) => boundedText(part) && literal(part))) return undefined;
  const [executable, ...args] = command as string[];
  if (!executable?.startsWith("/")) return undefined;
  const environment = environmentOf(value.environment);
  if (environment === undefined) return undefined;
  return { kind: "local", command: [executable, ...args], environment };
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

function remoteTransport(value: Json): McpRemoteTransport | undefined {
  if (!hasOnlyKeys(value, ["kind", "url"]) || !boundedText(value.url) || !literal(value.url))
    return undefined;
  // Parsed without a catch: a malformed URL is a refused definition, not a failure.
  if (!URL.canParse(value.url)) return undefined;
  const url = new URL(value.url);
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return undefined;
  return { kind: "remote", url: url.href };
}

function transportOf(value: unknown): McpLocalTransport | McpRemoteTransport | undefined {
  const transport = record(value);
  if (transport?.kind === "local") return localTransport(transport);
  if (transport?.kind === "remote") return remoteTransport(transport);
  return undefined;
}

function toolsOf(value: unknown): Readonly<Record<string, McpToolRisk>> | undefined {
  const tools = record(value);
  if (tools === undefined) return undefined;
  const entries = Object.entries(tools);
  if (entries.length === 0 || entries.length > MCP_SERVER_TOOL_MAX) return undefined;
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
  if (!hasOnlyKeys(server, ["name", "description", "enabled", "transport", "tools"]))
    return undefined;
  const header = serverHeader(server);
  const transport = transportOf(server.transport);
  const tools = toolsOf(server.tools);
  if (header === undefined || transport === undefined || tools === undefined) return undefined;
  return { ...header, transport, tools };
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
  for (const entry of entries) {
    const server = serverOf(entry);
    if (server === undefined) return { ok: false, reason: "server-invalid" };
    if (servers.some(({ name }) => name === server.name))
      return { ok: false, reason: "duplicate-server" };
    servers.push(server);
  }
  return { ok: true, servers };
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
