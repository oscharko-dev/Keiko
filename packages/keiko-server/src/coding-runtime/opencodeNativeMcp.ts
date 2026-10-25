import type { McpServerDefinition } from "@oscharko-dev/keiko-contracts";
import {
  mcpToolActions,
  type McpRemoteOAuth,
} from "@oscharko-dev/keiko-contracts/runtime/mcp-servers";

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
 *  - Its tools reach the model through Code Mode (the runtime's default) and every call reaches the
 *    native policy as `<server>_<tool>`, which classifies exactly the tools the registry names.
 */
export const OPENCODE_NATIVE_MCP_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const ENV_EXECUTABLE = "/usr/bin/env";

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

/** The registry's remote servers a run launched in `mode` would use with OAuth. */
export function mcpServersNeedingIssuerValidation(
  servers: readonly McpServerDefinition[],
  mode: string | undefined,
): readonly (McpServerDefinition & { readonly transport: { readonly oauth: McpRemoteOAuth } })[] {
  return admittedServers(servers, mode, undefined).flatMap((server) =>
    server.transport.kind === "remote" && server.transport.oauth !== undefined
      ? [{ ...server, transport: { ...server.transport, oauth: server.transport.oauth } }]
      : [],
  );
}

// A remote server with an operator-named issuer is admitted only once that issuer validated;
// `validations` absent is the selection of the servers to validate.
function admittedServers(
  servers: readonly McpServerDefinition[],
  mode: string | undefined,
  validations: ReadonlyMap<string, McpOAuthIssuerValidation> | undefined,
): readonly McpServerDefinition[] {
  const fullAccess = mode === "autonomous-delivery";
  return servers.filter((server) => {
    if (!server.enabled) return false;
    if (server.transport.kind === "local") return true;
    if (!fullAccess) return false;
    return (
      validations === undefined ||
      server.transport.oauth === undefined ||
      validations.get(server.name)?.ok === true
    );
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

function serverConfig(
  server: McpServerDefinition,
  home: string,
  admitted: AdmittedMcpOAuthServer | undefined,
): Readonly<Record<string, unknown>> {
  const transport = server.transport;
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
  readonly servers: readonly McpServerDefinition[];
  readonly mode: string | undefined;
  readonly home: string;
  /** The issuer validations of the remote servers with OAuth (#3903 AC3); absent, none validated. */
  readonly validations?: ReadonlyMap<string, McpOAuthIssuerValidation> | undefined;
}): OpenCodeNativeMcpAdmission {
  const validations = input.validations ?? new Map<string, McpOAuthIssuerValidation>();
  const admitted = admittedServers(input.servers, input.mode, validations);
  const oauth = new Map(
    admitted.flatMap((server) => {
      const entry = oauthServer(server, validations);
      return entry === undefined ? [] : [[server.name, entry] as const];
    }),
  );
  return {
    config: {
      servers: Object.fromEntries(
        admitted.map((server) => [
          server.name,
          serverConfig(server, input.home, oauth.get(server.name)),
        ]),
      ),
    },
    oauth,
    grants: {
      actions: mcpToolActions(admitted),
      servers: new Map(
        admitted.map((server) => [server.name, { remote: server.transport.kind === "remote" }]),
      ),
    },
  };
}
