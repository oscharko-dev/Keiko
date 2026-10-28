import { isCodingWorkbenchMode } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";
import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import type { McpServerDefinition } from "@oscharko-dev/keiko-contracts";
import { randomUUID } from "node:crypto";
import type { ConfiguredMcpConnections } from "../mcp/mcpConfiguredConnections.js";

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
  readonly managed?: Pick<ConfiguredMcpConnections, "generation" | "serve"> | undefined;
  readonly relay: McpCredentialRelay;
  /** Keiko's attested loopback origin. */
  readonly origin: string;
  /** Keiko's own environment, where the `KEIKO_MCP_SECRET_*` values are held. */
  readonly secrets: Readonly<Record<string, string | undefined>>;
}

type BindRefusal =
  "secret-unavailable" | "secret-invalid" | "secret-too-short" | "relay-unavailable";

function bindOne(
  relay: OpenCodeMcpRelayInput,
  runId: string,
  server: McpServerDefinition,
): OpenCodeNativeMcpRelayEndpoint | BindRefusal {
  if (server.transport.kind !== "remote" || server.transport.headers === undefined)
    return "relay-unavailable";
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

function bindManaged(
  input: OpenCodeMcpRelayInput,
  runId: string,
  server: McpServerDefinition,
  log: ServerLogSink | undefined,
): OpenCodeNativeMcpRelayEndpoint | BindRefusal {
  const manager = input.managed;
  if (manager === undefined) return "relay-unavailable";
  try {
    const generation = manager.generation(server, runId);
    const binding = input.relay.bind({
      runId,
      url: "https://managed-mcp.invalid/mcp",
      headers: {},
      secrets: [],
      signal: generation,
      upstream: (_url, request) => {
        const signal = AbortSignal.any([generation, request.signal]);
        return manager.serve(
          server.name,
          new Request("https://managed-mcp.invalid/mcp", {
            method: request.method,
            headers: request.headers,
            ...(request.body === undefined ? {} : { body: request.body }),
            signal,
          }),
          {
            invocationId: randomUUID(),
            correlationId: runId,
            signal,
            beforeEffect: () => !signal.aborted,
          },
        );
      },
    });
    if (binding === undefined) return "relay-unavailable";
    return {
      url: `${input.origin}${MCP_RELAY_PATH_PREFIX}${binding.relayId}`,
      capability: binding.capability,
    };
  } catch {
    recordMcpRelay(log, runId, {
      action: "bind",
      outcome: "refused",
      reason: "relay-unavailable",
      refusedServerCount: 1,
    });
    return "relay-unavailable";
  }
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
  const servers =
    input.relay?.managed === undefined
      ? mcpServersNeedingRelay(input.servers, input.mode)
      : input.servers.filter(
          (server) =>
            isCodingWorkbenchMode(input.mode) &&
            server.enabled &&
            (server.transport.kind === "local" || server.transport.oauth === undefined),
        );
  const endpoints = new Map<string, OpenCodeNativeMcpRelayEndpoint>();
  if (servers.length === 0) return endpoints;
  const refusals: BindRefusal[] = [];
  for (const server of servers) {
    const bound =
      input.relay === undefined
        ? "relay-unavailable"
        : input.relay.managed === undefined
          ? bindOne(input.relay, input.runId, server)
          : bindManaged(input.relay, input.runId, server, input.activityLog);
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
