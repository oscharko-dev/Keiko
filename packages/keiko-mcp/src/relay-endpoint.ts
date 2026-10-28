import { AsyncLocalStorage } from "node:async_hooks";
import {
  createMcpHandler,
  fromJsonSchema,
  isCallToolResult,
  McpServer,
} from "@modelcontextprotocol/server";
import {
  MANAGED_MCP_PROTOCOL_VERSION,
  type ExternalMcpConnection,
  type ManagedMcpInvocationContext,
} from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { ManagedMcpError } from "./definitions.js";

interface RelayEndpoint {
  readonly fetch: (request: Request, context: ManagedMcpInvocationContext) => Promise<Response>;
  readonly close: () => Promise<void>;
}

function relayServer(
  connection: ExternalMcpConnection,
  allowed: ReadonlySet<string>,
  context: ManagedMcpInvocationContext | undefined,
  active: () => boolean,
): McpServer {
  const server = new McpServer(
    { name: "keiko-mcp", version: "1" },
    {
      supportedProtocolVersions: [
        MANAGED_MCP_PROTOCOL_VERSION,
        "2025-11-25",
        "2025-06-18",
        "2025-03-26",
      ],
    },
  );
  for (const tool of connection.tools.filter((tool) => allowed.has(tool.name))) {
    server.registerTool(
      tool.name,
      {
        ...(tool.description === undefined ? {} : { description: tool.description }),
        inputSchema: fromJsonSchema<CatalogJsonObject>(tool.inputSchema),
      },
      async (args, sdkContext) => {
        if (!active() || context?.beforeEffect() !== true)
          throw new ManagedMcpError("not-admitted");
        try {
          const signal = AbortSignal.any([context.signal, sdkContext.mcpReq.signal]);
          const result = await connection.call(tool.name, args, { ...context, signal });
          if (!active() || signal.aborted || !context.beforeEffect())
            throw new ManagedMcpError("not-admitted");
          if (!isCallToolResult(result)) throw new ManagedMcpError("protocol-error");
          return result;
        } catch {
          throw new ManagedMcpError("tool-error");
        }
      },
    );
  }
  return server;
}

/** Protocol boundary for the existing authenticated native relay; it opens no listener. */
export function createMcpRelayEndpoint(
  connection: ExternalMcpConnection,
  allowed: Readonly<Record<string, "read" | "write">>,
): RelayEndpoint {
  const contexts = new AsyncLocalStorage<ManagedMcpInvocationContext>();
  const admitted = new Set(Object.keys(allowed));
  let closed = false;
  const handler = createMcpHandler(
    () => relayServer(connection, admitted, contexts.getStore(), () => !closed),
    { legacy: "stateless", keepAliveMs: 0, maxRequestBodySize: 2 * 1024 * 1024 },
  );
  return {
    fetch: async (request, context): Promise<Response> => {
      if (closed || context.signal.aborted || !context.beforeEffect())
        throw new ManagedMcpError("not-admitted");
      return contexts.run(context, () => handler.fetch(request));
    },
    close: async (): Promise<void> => {
      closed = true;
      await handler.close();
    },
  };
}
