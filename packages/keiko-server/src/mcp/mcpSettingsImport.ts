import { randomUUID } from "node:crypto";
import ts from "typescript";
import {
  MCP_SECRET_ENVIRONMENT_PREFIX,
  MCP_SERVER_MAX,
  isMcpServerName,
  isMcpRemoteAddress,
  parseMcpSettingsUpdate,
  type McpRemoteSecretHeader,
  type McpSettingsImportIssue,
  type McpSettingsSnapshot,
  type McpSettingsUpdate,
} from "@oscharko-dev/keiko-contracts/runtime/mcp-servers";
import { resolveMcpSecretHeaders } from "./mcpCredentialRelay.js";

type Fields = Readonly<Record<string, unknown>>;
interface Invalid {
  readonly kind: "invalid";
  readonly issue: McpSettingsImportIssue;
  readonly entry?: number;
}
type Prepared = Invalid | { readonly kind: "ready"; readonly update: McpSettingsUpdate };
type ImportEntry = readonly [name: unknown, fields: unknown];
type Secrets = Record<string, McpSettingsUpdate["secrets"][string]>;
type TransportInput = Fields & { readonly kind: "local" | "remote" };

function invalid(issue: McpSettingsImportIssue, entry?: number): Invalid {
  return { kind: "invalid", issue, ...(entry === undefined ? {} : { entry }) };
}

function fields(value: unknown): Fields | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Fields)
    : undefined;
}

function hasUnsafeObjectKeys(node: ts.ObjectLiteralExpression): boolean {
  const names = new Set<string>();
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.name)) continue;
    const name = property.name.text;
    if (name === "__proto__" || names.has(name)) return true;
    names.add(name);
  }
  return false;
}

function hasUnsafeKeys(root: ts.JsonSourceFile): boolean {
  const pending: ts.Node[] = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) return false;
    if (ts.isObjectLiteralExpression(node) && hasUnsafeObjectKeys(node)) return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

function parseDocument(text: string): { value: unknown } | Invalid {
  // The existing compiler config parser accepts JSONC and diagnoses partial parses. Wrapping the
  // single input value also admits lists without giving arbitrary top-level data config semantics.
  try {
    const source = `{"value": ${text}\n}`;
    if (hasUnsafeKeys(ts.parseJsonText("mcp.jsonc", source))) return invalid("duplicate-key");
    const parsed = ts.parseConfigFileTextToJson("mcp.jsonc", source);
    const document: unknown = parsed.config;
    const object = fields(document);
    return parsed.error === undefined && object !== undefined && Object.keys(object).length === 1
      ? { value: object.value }
      : invalid("syntax");
  } catch (error: unknown) {
    // Excessive nesting can exhaust the compiler's parser. It is a refused input.
    if (error instanceof RangeError) return invalid("syntax");
    throw error;
  }
}

function namedEntry(value: unknown): ImportEntry {
  const { name, ...entry } = fields(value) ?? {};
  return [name, entry];
}

function wrappedEntries(section: Fields): readonly ImportEntry[] {
  const nested = fields(section.servers);
  return Object.entries(
    nested !== undefined && transportKind(nested) === undefined ? nested : section,
  );
}

function importEntries(value: unknown): readonly ImportEntry[] | undefined {
  if (Array.isArray(value)) return value.map(namedEntry);
  const object = fields(value);
  if (object === undefined) return undefined;
  if (typeof object.name === "string") return [namedEntry(object)];
  const wrappers = ["mcp", "mcpServers"].filter((key) => Object.hasOwn(object, key));
  if (wrappers.length > 1) return undefined;
  const wrapper = wrappers[0];
  if (wrapper === undefined) return Object.entries(object);
  const section = fields(object[wrapper]);
  if (section === undefined) return undefined;
  return transportKind(section) === undefined ? wrappedEntries(section) : Object.entries(object);
}

function sealedValues(
  value: unknown,
  name: string,
  secrets: Secrets,
): Readonly<Record<string, McpRemoteSecretHeader>> | undefined {
  const record = fields(value);
  if (record === undefined) return undefined;
  const references = new Map<string, McpRemoteSecretHeader>();
  for (const [key, secret] of Object.entries(record)) {
    if (typeof secret !== "string" || secret.length === 0) return undefined;
    const reference =
      MCP_SECRET_ENVIRONMENT_PREFIX + randomUUID().replaceAll("-", "").toUpperCase();
    references.set(key, { secretEnv: reference });
    secrets[reference] = { server: name, value: secret };
  }
  return Object.fromEntries(references);
}

function importedCommand(command: unknown, args: unknown): readonly unknown[] | undefined {
  if (args === undefined && Array.isArray(command)) {
    const commandParts: readonly unknown[] = command;
    return commandParts;
  }
  if (typeof command !== "string") return undefined;
  if (args === undefined) return [command];
  if (!Array.isArray(args)) return undefined;
  const argumentsList: readonly unknown[] = args;
  return [command, ...argumentsList];
}

function importLocal(entry: Fields, name: string, secrets: Secrets): TransportInput | Invalid {
  const { environment, env } = entry;
  const command = importedCommand(entry.command, entry.args);
  if (command === undefined) return invalid("local");
  if (environment !== undefined && env !== undefined) return invalid("options");
  const supplied = environment === undefined ? env : environment;
  const variables = supplied === undefined ? {} : fields(supplied);
  if (variables === undefined) return invalid("credentials");
  const values = Object.entries(variables);
  const secretEnvironment = sealedValues(
    Object.fromEntries(values.filter(([, value]) => value !== "")),
    name,
    secrets,
  );
  if (secretEnvironment === undefined) return invalid("credentials");
  return {
    kind: "local",
    command,
    environment: Object.fromEntries(values.filter(([, value]) => value === "")),
    secretEnvironment,
  };
}

function importedHeaders(
  value: unknown,
  name: string,
  secrets: Secrets,
): Readonly<Record<string, McpRemoteSecretHeader>> | undefined {
  const input = fields(value);
  if (input === undefined) return undefined;
  const headers = sealedValues(input, name, secrets);
  if (headers === undefined) return undefined;
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([key, header]) => {
      const secret = secrets[header.secretEnv];
      const prefix =
        key.toLowerCase() === "authorization" && secret !== undefined
          ? /^(?:Bearer|Basic) /iu.exec(secret.value)?.[0]
          : undefined;
      if (secret === undefined || prefix === undefined) return [key, header];
      secrets[header.secretEnv] = { ...secret, value: secret.value.slice(prefix.length) };
      return [key, { ...header, prefix }];
    }),
  );
  const values = Object.fromEntries(
    Object.entries(secrets).map(([key, secret]) => [key, secret.value]),
  );
  return resolveMcpSecretHeaders(normalized, values).ok ? normalized : undefined;
}

function importRemote(entry: Fields, name: string, secrets: Secrets): TransportInput | Invalid {
  const { url, headers, oauth, network, protocol } = entry;
  if (!isMcpRemoteAddress(url)) return invalid("remote");
  if (new URL(url).searchParams.has("access_token")) return invalid("credentials");
  const secretHeaders = headers === undefined ? {} : importedHeaders(headers, name, secrets);
  if (secretHeaders === undefined) return invalid("credentials");
  return {
    kind: "remote",
    url,
    headers: Object.keys(secretHeaders).length === 0 ? undefined : secretHeaders,
    oauth: oauth === false ? undefined : oauth,
    protocol: entry.type === "sse" ? "sse" : protocol,
    network,
  };
}

const COMMON = ["type", "enabled", "disabled", "description"];
const LOCAL = [...COMMON, "command", "args", "environment", "env"];
const REMOTE = [...COMMON, "url", "headers", "oauth", "protocol", "network"];

function inferredTransport(entry: Fields): "local" | "remote" | undefined {
  const local = typeof entry.command === "string" || Array.isArray(entry.command);
  const remote = typeof entry.url === "string";
  if (local === remote) return undefined;
  return local ? "local" : "remote";
}

function transportKind(entry: Fields): "local" | "remote" | undefined {
  switch (entry.type) {
    case "local":
    case "stdio":
      return "local";
    case "remote":
    case "http":
    case "streamable-http":
    case "sse":
      return "remote";
    case undefined:
      return inferredTransport(entry);
    default:
      return undefined;
  }
}

function validEnabledOptions(entry: Fields): boolean {
  if (entry.enabled !== undefined && typeof entry.enabled !== "boolean") return false;
  if (entry.disabled !== undefined && typeof entry.disabled !== "boolean") return false;
  return (
    entry.enabled === undefined || entry.disabled === undefined || entry.enabled !== entry.disabled
  );
}

function validProtocolOptions(entry: Fields): boolean {
  return entry.type !== "sse" || entry.protocol === undefined || entry.protocol === "sse";
}

function importOne(name: string, raw: unknown, revision: string): Prepared {
  const entry = fields(raw);
  if (entry === undefined) return invalid("shape");
  const kind = transportKind(entry);
  if (kind === undefined) return invalid("type");
  const allowed = kind === "local" ? LOCAL : REMOTE;
  if (Object.keys(entry).some((key) => !allowed.includes(key))) return invalid("options");
  if (!validEnabledOptions(entry) || !validProtocolOptions(entry)) return invalid("options");
  const secrets: Secrets = {};
  const transport =
    kind === "local" ? importLocal(entry, name, secrets) : importRemote(entry, name, secrets);
  if (transport.kind === "invalid") return transport;
  const update = parseMcpSettingsUpdate({
    expectedRevision: revision,
    servers: [
      {
        name,
        description: entry.description,
        enabled: false,
        transport,
        discovery: "automatic",
        tools: {},
      },
    ],
    secrets,
  });
  return update === undefined ? invalid(kind) : { kind: "ready", update };
}

export function prepareMcpSettingsImport(text: string, current: McpSettingsSnapshot): Prepared {
  const parsed = parseDocument(text);
  if ("kind" in parsed) return parsed;
  const entries = importEntries(parsed.value);
  if (entries === undefined) return invalid("shape");
  if (entries.length === 0) return invalid("empty");
  if (entries.length + current.servers.length > MCP_SERVER_MAX) return invalid("capacity");
  const servers = [...current.servers];
  const names = new Set(servers.map(({ name }) => name));
  const secrets: Secrets = {};
  for (const [index, [name, value]] of entries.entries()) {
    if (!isMcpServerName(name)) return invalid("name", index + 1);
    if (names.has(name)) return invalid("duplicate", index + 1);
    const candidate = importOne(name, value, current.revision);
    if (candidate.kind === "invalid") return invalid(candidate.issue, index + 1);
    names.add(name);
    servers.push(...candidate.update.servers);
    Object.assign(secrets, candidate.update.secrets);
  }
  const update = parseMcpSettingsUpdate({ expectedRevision: current.revision, servers, secrets });
  return update === undefined ? invalid("capacity") : { kind: "ready", update };
}
