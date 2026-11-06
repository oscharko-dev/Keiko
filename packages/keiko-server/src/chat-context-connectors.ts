import { chatKnowledgeScopes } from "./requirement-inventory.js";
// The tool definitions a Chat's active connectors add to every tool-capable request, for the
// context meter (owner request 2026-11-02): the configured MCP servers the Chat offers and its bound
// Jira Pod. A status read is a peek. It never connects an MCP transport, awaits one, admits a host or
// runs a tool: a server that is not connected yet contributes nothing and is listed without counts.
// The definitions are the ones the production catalogs advertise (managedCatalogToolDefinitions), so
// the share cannot drift from what a turn sends.

import type { ChatContextConnectorWire, Chat } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { ContextProfile, ToolDefinition } from "@oscharko-dev/keiko-contracts";
import type { ExternalMcpTool } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import type { McpServerDefinition } from "@oscharko-dev/keiko-contracts/runtime/mcp-servers";
import { countGatewayPromptTokens } from "@oscharko-dev/keiko-model-gateway/internal/prompt-token-accounting";
import { canonicalise } from "@oscharko-dev/keiko-security";
import { findOwnedJiraPod } from "./atlassian/jiraPodAccess.js";
import { correlationIdOrUnknown } from "./correlation.js";
import type { UiHandlerDeps } from "./deps.js";
import {
  defaultServerDiagnosticSink,
  emitServerDiagnostic,
  serverDiagnosticFromError,
} from "./diagnostics-log.js";
import { mcpChatServerDeclarations, MCP_CHAT_PROFILE } from "./mcp/mcpChatCatalogRuntime.js";
import { mcpChatCatalogRoutes } from "./mcp/mcpChatCatalogConsumer.js";
import { selectedMcpServers } from "./mcp/mcpChatSelection.js";
import { managedCatalogToolDefinitions } from "./tool-catalog/managedProviderCatalog.js";

export interface ChatConnectorTools {
  /** Tokens of every known connector's definitions together, as one request carries them. */
  readonly tokens: number;
  /** Absent when the Chat has no active connector. */
  readonly connectors: readonly ChatContextConnectorWire[];
}

interface ConnectorChat {
  readonly mcpServers?: Chat["mcpServers"] | undefined;
  readonly jiraPodBinding?: Chat["jiraPodBinding"] | undefined;
  readonly localKnowledgeScope?: Chat["localKnowledgeScope"] | undefined;
  readonly localKnowledgeScopes?: Chat["localKnowledgeScopes"] | undefined;
}
type ConnectorDepsKey =
  | "mcpSettings"
  | "mcpConnections"
  | "jiraChatCatalog"
  | "knowledgeChatCatalog"
  | "atlassianConnectorCredentials"
  | "serverPrincipal"
  | "diagnostics";
/** Every dependency is optional: a graph without a connector subsystem has no connector. */
type ConnectorDeps = { readonly [Key in ConnectorDepsKey]?: UiHandlerDeps[Key] | undefined };

interface Reading {
  readonly connector: ChatContextConnectorWire;
  readonly definitions: readonly ToolDefinition[];
}

// A connected server keeps one tool array for the life of its connection, so the compiled
// definitions are remembered against it and recomputed only when the server's own definition changes.
const MCP_DEFINITIONS = new WeakMap<
  readonly ExternalMcpTool[],
  { readonly key: string; readonly definitions: readonly ToolDefinition[] }
>();

function mcpDefinitions(
  server: McpServerDefinition,
  tools: readonly ExternalMcpTool[],
): readonly ToolDefinition[] {
  const key = canonicalise({
    name: server.name,
    discovery: server.discovery,
    tools: server.tools,
  });
  const remembered = MCP_DEFINITIONS.get(tools);
  if (remembered?.key === key) return remembered.definitions;
  const declarations = mcpChatServerDeclarations(server, tools);
  const definitions = managedCatalogToolDefinitions(
    mcpChatCatalogRoutes(declarations),
    declarations,
    MCP_CHAT_PROFILE,
    Date.now(),
  );
  MCP_DEFINITIONS.set(tools, { key, definitions });
  return definitions;
}

function reportUnavailable(deps: ConnectorDeps, correlationId: string, error: unknown): void {
  emitServerDiagnostic(
    deps.diagnostics ?? defaultServerDiagnosticSink,
    serverDiagnosticFromError({
      correlationId,
      operation: "chat.context.connector-tools",
      source: "chat-context-status",
      error,
      redact: () => "server-operation-failed",
    }),
  );
}

function mcpReading(
  deps: ConnectorDeps,
  server: McpServerDefinition,
  correlationId: string,
): Reading {
  const unknown: Reading = { connector: { kind: "mcp", name: server.name }, definitions: [] };
  try {
    const tools = deps.mcpConnections?.connectedTools?.(server.name, correlationId);
    if (tools === undefined) return unknown;
    const definitions = mcpDefinitions(server, tools);
    return {
      connector: { kind: "mcp", name: server.name, toolCount: definitions.length },
      definitions,
    };
  } catch (error) {
    reportUnavailable(deps, correlationId, error);
    return unknown;
  }
}

function mcpReadings(deps: ConnectorDeps, chat: ConnectorChat, correlationId: string): Reading[] {
  if (deps.mcpSettings === undefined || deps.mcpConnections === undefined) return [];
  try {
    return selectedMcpServers(deps.mcpSettings.read(correlationId).servers, chat.mcpServers).map(
      (server) => mcpReading(deps, server, correlationId),
    );
  } catch (error) {
    reportUnavailable(deps, correlationId, error);
    return [];
  }
}

function jiraReading(
  deps: ConnectorDeps,
  chat: ConnectorChat,
  correlationId: string,
): Reading | undefined {
  const binding = chat.jiraPodBinding;
  if (binding === undefined || deps.jiraChatCatalog === undefined) return undefined;
  try {
    const pod = findOwnedJiraPod(deps, binding.podId);
    if (pod === undefined) return { connector: { kind: "jira" }, definitions: [] };
    const definitions = deps.jiraChatCatalog.toolDefinitions();
    return {
      connector: { kind: "jira", name: pod.displayName, toolCount: definitions.length },
      definitions,
    };
  } catch (error) {
    reportUnavailable(deps, correlationId, error);
    return { connector: { kind: "jira" }, definitions: [] };
  }
}

function knowledgeReading(
  deps: ConnectorDeps,
  chat: ConnectorChat,
  correlationId: string,
): Reading | undefined {
  if (
    chat.jiraPodBinding !== undefined ||
    chatKnowledgeScopes(chat).length === 0 ||
    deps.knowledgeChatCatalog === undefined
  )
    return undefined;
  try {
    const definitions = deps.knowledgeChatCatalog.toolDefinitions();
    return { connector: { kind: "knowledge", toolCount: definitions.length }, definitions };
  } catch (error) {
    reportUnavailable(deps, correlationId, error);
    return { connector: { kind: "knowledge" }, definitions: [] };
  }
}

// The accounting's fixed overhead belongs to the request, not to its tools: subtract the empty
// request, as the conversation shares do.
function definitionTokens(
  definitions: readonly ToolDefinition[],
  accounting: ContextProfile["tokenAccounting"],
): number {
  if (definitions.length === 0) return 0;
  const empty = countGatewayPromptTokens({ messages: [] }, accounting);
  return Math.max(
    0,
    countGatewayPromptTokens({ messages: [], tools: definitions }, accounting) - empty,
  );
}

export function chatConnectorTools(
  deps: ConnectorDeps,
  chat: ConnectorChat | undefined,
  accounting: ContextProfile["tokenAccounting"],
  correlationId: string | undefined,
): ChatConnectorTools {
  if (chat === undefined) return { tokens: 0, connectors: [] };
  const correlation = correlationIdOrUnknown(correlationId);
  const primary = jiraReading(deps, chat, correlation) ?? knowledgeReading(deps, chat, correlation);
  const readings = [
    ...mcpReadings(deps, chat, correlation),
    ...(primary === undefined ? [] : [primary]),
  ];
  return {
    tokens: definitionTokens(
      readings.flatMap((reading) => reading.definitions),
      accounting,
    ),
    connectors: readings.map(({ connector, definitions }) =>
      connector.toolCount === undefined
        ? connector
        : { ...connector, tokens: definitionTokens(definitions, accounting) },
    ),
  };
}
