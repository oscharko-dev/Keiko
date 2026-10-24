import type { McpServerDefinition } from "@oscharko-dev/keiko-contracts";
import { mcpToolActions } from "@oscharko-dev/keiko-contracts/runtime/mcp-servers";

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
 *  - A remote server is internet use: it is written only for a Full access run, with OAuth off so
 *    the runtime never starts an authorization flow of its own.
 *  - Its tools reach the model through Code Mode (the runtime's default) and every call reaches the
 *    native policy as `<server>_<tool>`, which classifies exactly the tools the registry names.
 */
export const OPENCODE_NATIVE_MCP_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const ENV_EXECUTABLE = "/usr/bin/env";

export interface OpenCodeNativeMcpAdmission {
  /** The `mcp` value of the server-owned binding: always present, so no other layer adds a server. */
  readonly config: { readonly servers: Readonly<Record<string, unknown>> };
  readonly grants: OpenCodeNativeMcpGrants;
}

function admittedServers(
  servers: readonly McpServerDefinition[],
  mode: string | undefined,
): readonly McpServerDefinition[] {
  const fullAccess = mode === "autonomous-delivery";
  return servers.filter(
    (server) => server.enabled && (server.transport.kind === "local" || fullAccess),
  );
}

function serverConfig(
  server: McpServerDefinition,
  home: string,
): Readonly<Record<string, unknown>> {
  const transport = server.transport;
  if (transport.kind === "remote") return { type: "remote", url: transport.url, oauth: false };
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
}): OpenCodeNativeMcpAdmission {
  const admitted = admittedServers(input.servers, input.mode);
  return {
    config: {
      servers: Object.fromEntries(
        admitted.map((server) => [server.name, serverConfig(server, input.home)]),
      ),
    },
    grants: {
      actions: mcpToolActions(admitted),
      servers: new Map(
        admitted.map((server) => [server.name, { remote: server.transport.kind === "remote" }]),
      ),
    },
  };
}
