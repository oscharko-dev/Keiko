import { AsyncLocalStorage } from "node:async_hooks";
import {
  createMcpHandler,
  fromJsonSchema,
  isCallToolResult,
  McpServer,
  type CallToolResult,
} from "@modelcontextprotocol/server";
import {
  MANAGED_MCP_PROTOCOL_VERSION,
  type ExternalMcpConnection,
  type ManagedMcpInvocationContext,
  type ManagedMcpMutationInvocation,
} from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { ManagedMcpError } from "./definitions.js";

interface RelayEndpoint {
  readonly fetch: (request: Request, context: ManagedMcpInvocationContext) => Promise<Response>;
  readonly close: () => Promise<void>;
}

async function uncertainMutation(context: ManagedMcpInvocationContext): Promise<void> {
  try {
    await context.onUncertainMutation?.();
  } catch {
    throw new ManagedMcpError("not-admitted");
  }
}

function assertCurrent(
  context: ManagedMcpInvocationContext | undefined,
  active: () => boolean,
  signal?: AbortSignal,
): asserts context is ManagedMcpInvocationContext {
  if (
    !active() ||
    context === undefined ||
    context.signal.aborted ||
    signal?.aborted === true ||
    !context.beforeEffect()
  )
    throw new ManagedMcpError("not-admitted");
}

interface RelayCall {
  readonly connection: ExternalMcpConnection;
  readonly context: ManagedMcpInvocationContext | undefined;
  readonly active: () => boolean;
  readonly name: string;
  readonly argumentsValue: CatalogJsonObject;
  readonly mutation: boolean;
  readonly signal: AbortSignal;
  readonly sessionId: unknown;
}
function beginMutation(
  input: RelayCall,
  context: ManagedMcpInvocationContext,
): ManagedMcpMutationInvocation | undefined {
  if (!input.mutation) return undefined;
  if (context.onUncertainMutation === undefined) throw new ManagedMcpError("not-admitted");
  const permit = context.beginMutation?.({
    sessionId: typeof input.sessionId === "string" ? input.sessionId : undefined,
    toolName: input.name,
    argumentsValue: input.argumentsValue,
  });
  if (permit === undefined) throw new ManagedMcpError("not-admitted");
  return permit;
}
async function invokeRelayTool(input: RelayCall): Promise<CallToolResult> {
  const { context } = input;
  assertCurrent(context, input.active, input.signal);
  const permit = beginMutation(input, context);
  try {
    const signal = AbortSignal.any([context.signal, input.signal]);
    const result = await input.connection.call(input.name, input.argumentsValue, {
      ...context,
      signal,
      invocationId: permit?.invocationId ?? context.invocationId,
    });
    if (!isCallToolResult(result) || (input.mutation && result.isError === true))
      throw new ManagedMcpError("protocol-error");
    permit?.acknowledge();
    assertCurrent(context, input.active, signal);
    return result;
  } catch {
    try {
      permit?.fail();
    } finally {
      if (input.mutation) await uncertainMutation(context);
    }
    throw new ManagedMcpError("tool-error");
  }
}

function relayServer(
  connection: ExternalMcpConnection,
  allowed: ReadonlyMap<string, "read" | "write">,
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
      ...(connection.instructions === undefined ? {} : { instructions: connection.instructions }),
    },
  );
  for (const tool of connection.tools.filter((tool) => allowed.has(tool.name))) {
    server.registerTool(
      tool.name,
      {
        ...(tool.description === undefined ? {} : { description: tool.description }),
        inputSchema: fromJsonSchema<CatalogJsonObject>(tool.inputSchema),
      },
      (args, sdkContext) =>
        invokeRelayTool({
          connection,
          context,
          active,
          name: tool.name,
          argumentsValue: args,
          mutation: allowed.get(tool.name) === "write",
          signal: sdkContext.mcpReq.signal,
          sessionId: sdkContext.mcpReq._meta?.["ai.opencode/sessionID"],
        }),
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
  const admitted = new Map(Object.entries(allowed));
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
