import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import type { McpServerDefinition } from "@oscharko-dev/keiko-contracts";

import {
  MCP_RELAY_PATH_PREFIX,
  recordMcpRelay,
  resolveMcpSecretHeaders,
  type McpCredentialRelay,
} from "../mcp/mcpCredentialRelay.js";

import {
  mcpServersNeedingRelay,
  type OpenCodeNativeMcpRelayEndpoint,
} from "./opencodeNativeMcp.js";

/**
 * Keiko's MCP relay as a native run binds it (#3903 AC3): a remote server with credential headers
 * is reached at Keiko's attested loopback origin, which the run already reaches for the Model
 * Gateway, and Keiko adds the credentials it reads from its own environment.
 */
export interface OpenCodeMcpRelayInput {
  readonly relay: McpCredentialRelay;
  /** Keiko's attested loopback origin. */
  readonly origin: string;
  /** Keiko's own environment, where the `KEIKO_MCP_SECRET_*` values are held. */
  readonly secrets: Readonly<Record<string, string | undefined>>;
}

type BindRefusal = "secret-unavailable" | "secret-invalid" | "relay-unavailable";

function bindOne(
  relay: OpenCodeMcpRelayInput,
  runId: string,
  server: ReturnType<typeof mcpServersNeedingRelay>[number],
): OpenCodeNativeMcpRelayEndpoint | BindRefusal {
  const resolved = resolveMcpSecretHeaders(server.transport.headers, relay.secrets);
  if (!resolved.ok) return resolved.reason;
  const binding = relay.relay.bind({
    runId,
    url: server.transport.url,
    headers: resolved.headers,
    secrets: resolved.secrets,
  });
  if (binding === undefined) return "relay-unavailable";
  return {
    url: `${relay.origin}${MCP_RELAY_PATH_PREFIX}${binding.relayId}`,
    capability: binding.capability,
  };
}

/**
 * The relay endpoints of one native run's servers with credential headers, by server name. A server
 * whose credential cannot be had, or that no relay can bind, is left out; one line records the
 * counts and the first refusal.
 */
export function bindNativeMcpRelays(input: {
  readonly servers: readonly McpServerDefinition[];
  readonly mode: string | undefined;
  readonly runId: string;
  readonly relay: OpenCodeMcpRelayInput | undefined;
  readonly activityLog: ServerLogSink | undefined;
}): ReadonlyMap<string, OpenCodeNativeMcpRelayEndpoint> {
  const servers = mcpServersNeedingRelay(input.servers, input.mode);
  const endpoints = new Map<string, OpenCodeNativeMcpRelayEndpoint>();
  if (servers.length === 0) return endpoints;
  const refusals: BindRefusal[] = [];
  for (const server of servers) {
    const bound =
      input.relay === undefined ? "relay-unavailable" : bindOne(input.relay, input.runId, server);
    if (typeof bound === "string") refusals.push(bound);
    else endpoints.set(server.name, bound);
  }
  const [reason] = refusals;
  recordMcpRelay(input.activityLog, input.runId, {
    action: "bind",
    outcome: endpoints.size > 0 ? "bound" : "refused",
    relayedServerCount: endpoints.size,
    refusedServerCount: refusals.length,
    ...(reason === undefined ? {} : { reason }),
  });
  return endpoints;
}
