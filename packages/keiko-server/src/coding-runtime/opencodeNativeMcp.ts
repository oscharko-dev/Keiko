import type { McpServerDefinition } from "@oscharko-dev/keiko-contracts";
import {
  mcpToolAction,
  type McpRemoteOAuth,
  type McpRemoteSecretHeader,
  type McpRemoteTransport,
} from "@oscharko-dev/keiko-contracts/runtime/mcp-servers";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";

import type { McpOAuthIssuerValidation } from "../mcp/mcpOAuthIssuer.js";

import type { OpenCodeNativeMcpGrants } from "./opencodeNativePolicy.js";

/**
 * The MCP servers a native run admits (#3903, parity row C04), as the pinned 2.1.4 runtime reads
 * them: `mcp.servers.<name>` on the server-owned binding, which no lower configuration layer can
 * add to or replace. Proven against the original executable:
 *
 *  - A local server is a direct child of the runtime and inherits its whole environment, Keiko's
 *    gateway capability and the service password included. It therefore starts through
 *    `/usr/bin/env -i` with a fixed `PATH`, the run's private `HOME` and only the literal variables
 *    the registry names. It runs inside the run's native sandbox like every other descendant.
 *  - A remote server is internet use: it is written only for a Full access run. Without an
 *    operator-named issuer its OAuth stays off, so the runtime never starts an authorization flow
 *    of its own. With one (#3903 AC3) it is admitted only once that issuer validated
 *    (`mcpOAuthIssuer.ts`), and the runtime reads exactly the validated metadata document
 *    (`oauth.auth_server_metadata_url`) instead of following the MCP server's own
 *    protected-resource metadata; the operator's public client id and scope go with it.
 *  - A remote server with credential headers (#3903 AC3) is reached through Keiko's MCP relay
 *    (`mcpCredentialRelay.ts`): its binding names the relay's address with a capability for this
 *    run and this server, and Keiko adds the credential, which the run never holds. A server whose
 *    relay could not be bound (its secret unset or invalid) is left out with its tools.
 *  - Its tools reach the model through Code Mode (the runtime's default) and every call reaches the
 *    native policy as `<server>_<tool>`, which classifies exactly the tools the registry names.
 */
export const OPENCODE_NATIVE_MCP_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const ENV_EXECUTABLE = "/usr/bin/env";

/** Where a relayed server is reached: Keiko's relay address and the run's capability for it. */
export interface OpenCodeNativeMcpRelayEndpoint {
  readonly url: string;
  readonly capability: string;
}

/** The headers the relay authenticates; neither carries a credential of the server. */
export const OPENCODE_NATIVE_MCP_RELAY_HEADERS = {
  csrf: "X-Keiko-CSRF",
  capability: "X-Keiko-Mcp-Relay",
} as const;

/** A remote server admitted with OAuth: what its authorization and its credential are bound to. */
export interface AdmittedMcpOAuthServer {
  readonly url: string;
  readonly oauth: McpRemoteOAuth;
  readonly metadataUrl: string;
  readonly authorizationEndpoint: string;
}

export interface OpenCodeNativeMcpAdmission {
  /** The `mcp` value of the server-owned binding: always present, so no other layer adds a server. */
  readonly config: { readonly servers: Readonly<Record<string, unknown>> };
  readonly grants: OpenCodeNativeMcpGrants;
  /** The admitted servers that authorize through OAuth, by name. */
  readonly oauth: ReadonlyMap<string, AdmittedMcpOAuthServer>;
}

/** The registry's remote servers a run launched in `mode` would reach through the relay. */
export function mcpServersNeedingRelay(
  servers: readonly McpServerDefinition[],
  mode: string | undefined,
): readonly (McpServerDefinition & {
  readonly transport: McpRemoteTransport & {
    readonly headers: Readonly<Record<string, McpRemoteSecretHeader>>;
  };
})[] {
  return admittedServers(servers, mode, undefined, undefined).flatMap((server) =>
    server.transport.kind === "remote" && server.transport.headers !== undefined
      ? [{ ...server, transport: { ...server.transport, headers: server.transport.headers } }]
      : [],
  );
}

/** The registry's remote servers a run launched in `mode` would use with OAuth. */
export function mcpServersNeedingIssuerValidation(
  servers: readonly McpServerDefinition[],
  mode: string | undefined,
): readonly (McpServerDefinition & { readonly transport: { readonly oauth: McpRemoteOAuth } })[] {
  return admittedServers(servers, mode, undefined, undefined).flatMap((server) =>
    server.transport.kind === "remote" && server.transport.oauth !== undefined
      ? [{ ...server, transport: { ...server.transport, oauth: server.transport.oauth } }]
      : [],
  );
}

// A remote server with an operator-named issuer is admitted only once that issuer validated, and
// one with credential headers only once its relay is bound; absent maps select the servers to check.
function remoteAdmitted(
  server: McpServerDefinition,
  validations: ReadonlyMap<string, McpOAuthIssuerValidation> | undefined,
  relays: ReadonlyMap<string, OpenCodeNativeMcpRelayEndpoint> | undefined,
): boolean {
  const transport = server.transport;
  if (transport.kind !== "remote") return false;
  if (transport.headers !== undefined) return relays === undefined || relays.has(server.name);
  return (
    validations === undefined ||
    transport.oauth === undefined ||
    validations.get(server.name)?.ok === true
  );
}
function admittedServers(
  servers: readonly McpServerDefinition[],
  mode: string | undefined,
  validations: ReadonlyMap<string, McpOAuthIssuerValidation> | undefined,
  relays: ReadonlyMap<string, OpenCodeNativeMcpRelayEndpoint> | undefined,
  managed = false,
): readonly McpServerDefinition[] {
  return servers.filter((server) => {
    if (!server.enabled) return false;
    if (server.transport.kind === "local") return true;
    if (managed && relays?.has(server.name)) return true;
    return mode === "autonomous-delivery" && remoteAdmitted(server, validations, relays);
  });
}

function oauthServer(
  server: McpServerDefinition,
  validations: ReadonlyMap<string, McpOAuthIssuerValidation>,
): AdmittedMcpOAuthServer | undefined {
  const transport = server.transport;
  const validation = validations.get(server.name);
  if (transport.kind !== "remote" || transport.oauth === undefined || validation?.ok !== true)
    return undefined;
  return {
    url: transport.url,
    oauth: transport.oauth,
    metadataUrl: validation.metadataUrl,
    authorizationEndpoint: validation.authorizationEndpoint,
  };
}

function remoteOAuthConfig(admitted: AdmittedMcpOAuthServer | undefined): unknown {
  if (admitted === undefined) return false;
  const { oauth, metadataUrl } = admitted;
  return {
    auth_server_metadata_url: metadataUrl,
    ...(oauth.clientId === undefined ? {} : { client_id: oauth.clientId }),
    ...(oauth.scope === undefined ? {} : { scope: oauth.scope }),
  };
}

function relayedConfig(relay: OpenCodeNativeMcpRelayEndpoint): Readonly<Record<string, unknown>> {
  return {
    type: "remote",
    url: relay.url,
    oauth: false,
    headers: {
      [OPENCODE_NATIVE_MCP_RELAY_HEADERS.csrf]: "1",
      [OPENCODE_NATIVE_MCP_RELAY_HEADERS.capability]: relay.capability,
    },
  };
}

function serverConfig(
  server: McpServerDefinition,
  home: string,
  admitted: AdmittedMcpOAuthServer | undefined,
  relay: OpenCodeNativeMcpRelayEndpoint | undefined,
): Readonly<Record<string, unknown>> {
  const transport = server.transport;
  if (relay !== undefined) return relayedConfig(relay);
  if (transport.kind === "remote")
    return { type: "remote", url: transport.url, oauth: remoteOAuthConfig(admitted) };
  const environment = Object.entries(transport.environment).map(
    ([name, value]) => `${name}=${value}`,
  );
  return {
    type: "local",
    command: [
      ENV_EXECUTABLE,
      "-i",
      `PATH=${OPENCODE_NATIVE_MCP_PATH}`,
      `HOME=${home}`,
      ...environment,
      ...transport.command,
    ],
  };
}

/** The binding and the policy grants for one native run, from the operator's registry. */
export function openCodeNativeMcpAdmission(input: {
  readonly managed?: boolean | undefined;
  readonly servers: readonly McpServerDefinition[];
  readonly mode: string | undefined;
  readonly home: string;
  /** The issuer validations of the remote servers with OAuth (#3903 AC3); absent, none validated. */
  readonly validations?: ReadonlyMap<string, McpOAuthIssuerValidation> | undefined;
  /** The relays bound for the remote servers with credential headers; absent, none is bound. */
  readonly relays?: ReadonlyMap<string, OpenCodeNativeMcpRelayEndpoint> | undefined;
}): OpenCodeNativeMcpAdmission {
  const validations = input.validations ?? new Map<string, McpOAuthIssuerValidation>();
  const relays = input.relays ?? new Map<string, OpenCodeNativeMcpRelayEndpoint>();
  const candidates =
    input.managed === true
      ? input.servers.filter((server) => relays.has(server.name))
      : input.servers;
  const admitted = admittedServers(candidates, input.mode, validations, relays, input.managed);
  const oauth = new Map(
    admitted.flatMap((server) => {
      const entry = relays.has(server.name) ? undefined : oauthServer(server, validations);
      return entry === undefined ? [] : [[server.name, entry] as const];
    }),
  );
  return {
    config: {
      servers: Object.fromEntries(
        admitted.map((server) => [
          server.name,
          serverConfig(server, input.home, oauth.get(server.name), relays.get(server.name)),
        ]),
      ),
    },
    oauth,
    grants: nativeGrants(admitted, input.managed === true ? new Set(relays.keys()) : new Set()),
  };
}

function nativeGrants(
  servers: readonly McpServerDefinition[],
  managedNames: ReadonlySet<string>,
): OpenCodeNativeMcpGrants {
  const actions = new Map<
    string,
    OpenCodeNativeMcpGrants["actions"] extends ReadonlyMap<string, infer Grant> ? Grant : never
  >();
  for (const server of servers) {
    const managed = managedNames.has(server.name);
    for (const [toolName, risk] of Object.entries(server.tools)) {
      const grant = { risk, remote: server.transport.kind === "remote" };
      actions.set(
        mcpToolAction(server.name, toolName),
        managed
          ? {
              ...grant,
              remote: true,
              managed: true,
              ...(risk === "write"
                ? {
                    mutation: {
                      serverName: server.name,
                      toolName,
                      configurationDigest: sha256Hex(canonicalise(server)),
                    },
                  }
                : {}),
            }
          : grant,
      );
    }
  }
  return {
    actions,
    servers: new Map(
      servers.map((server) => [
        server.name,
        managedNames.has(server.name)
          ? { remote: true, managed: true }
          : { remote: server.transport.kind === "remote" },
      ]),
    ),
  };
}
