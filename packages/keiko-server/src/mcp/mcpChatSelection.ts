import type { McpServerDefinition } from "@oscharko-dev/keiko-contracts/runtime/mcp-servers";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";

/**
 * The MCP servers a Chat offers to its model (owner decision 2026-11-02): the person ticks them per
 * Chat from the centrally configured servers. An absent selection keeps every enabled server; an
 * empty one offers none. A disabled server stays unavailable whatever a Chat selected.
 */
export function selectedMcpServers(
  servers: readonly McpServerDefinition[],
  selection: readonly string[] | undefined,
): readonly McpServerDefinition[] {
  const enabled = servers.filter((server) => server.enabled);
  if (selection === undefined) return enabled;
  const chosen = new Set(selection);
  return enabled.filter((server) => chosen.has(server.name));
}

/**
 * The configuration a Chat's MCP authority binds to. Without a selection it stays the registry
 * revision, so existing authorities keep their identity; a selection binds the chosen names too,
 * and changing it invalidates the read grants and write approvals of the earlier selection.
 */
export function mcpChatConfigurationDigest(
  revision: string,
  selection: readonly string[] | undefined,
): string {
  if (selection === undefined) return revision;
  return sha256Hex(canonicalise({ revision, servers: [...new Set(selection)].sort() }));
}
