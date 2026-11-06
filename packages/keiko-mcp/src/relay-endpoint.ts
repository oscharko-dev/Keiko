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
  type ManagedMcpEffect,
  type ManagedMcpFailure,
  type ManagedMcpInvocationContext,
  type ManagedMcpMutationInvocation,
} from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { boundedDescription, ManagedMcpError, noEffectError } from "./definitions.js";

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
/** Fixed, model-readable words per closed reason; no server text, name or path. */
const FAILURE_TEXT: Readonly<Partial<Record<ManagedMcpFailure, string>>> = {
  "result-too-large":
    "The tool result exceeded the size limit and was not delivered. Ask for less data: narrow the query, use filters or pagination.",
  "deadline-exceeded": "The tool did not answer in time.",
  aborted: "The tool call was cancelled before it finished.",
  closed: "The connection to the tool server closed before the call finished.",
  "descriptor-drift": "The tool server changed its tool list. Try the call again.",
  backoff: "The tool server is restarting after a failure. Try again shortly.",
  "invalid-arguments": "The tool arguments were not valid for this tool.",
};

function failureText(
  reason: ManagedMcpFailure,
  effect: ManagedMcpEffect,
  mutation: boolean,
): string {
  const base = FAILURE_TEXT[reason] ?? "The tool call failed.";
  if (!mutation) return base;
  return effect === "none"
    ? `${base} Nothing was changed.`
    : `${base} The change may or may not have been applied; check before repeating it.`;
}

/** The only error the relay hands the SDK: fixed words, with the closed facts kept for tests. */
class RelayToolFailure extends Error {
  public constructor(
    message: string,
    public readonly reason: ManagedMcpFailure,
    public readonly effect: ManagedMcpEffect,
  ) {
    super(message);
    this.name = "RelayToolFailure";
  }
}

function failureOf(error: unknown): { reason: ManagedMcpFailure; effect: ManagedMcpEffect } {
  if (error instanceof ManagedMcpError) return { reason: error.reason, effect: error.effect };
  return { reason: "tool-error", effect: "possible" };
}

async function settleFailedCall(
  input: RelayCall,
  context: ManagedMcpInvocationContext,
  permit: ManagedMcpMutationInvocation | undefined,
  effect: ManagedMcpEffect,
): Promise<void> {
  // "none" is trusted only when the durable record is still undispatched (the gate owns dispatch).
  const undispatched = effect === "none" && permit?.dispatch !== undefined;
  if (undispatched || (effect === "none" && permit === undefined)) {
    permit?.release?.();
    return;
  }
  try {
    permit?.fail();
  } finally {
    if (input.mutation) await uncertainMutation(context);
  }
}

/**
 * Where the durable record becomes dispatched. A connection with its own transport gate records it
 * there, so a failure before the frame left stays provably effect-free. Any other connection could
 * reach the server without consulting a gate, so its record is dispatched before the call starts:
 * an effect must never exist without a dispatched record behind it.
 */
function dispatchAdmission(
  connection: ExternalMcpConnection,
  permit: ManagedMcpMutationInvocation | undefined,
): { readonly beforeDispatch?: () => boolean } {
  const dispatch = permit?.dispatch;
  if (dispatch === undefined) return {};
  if (connection.dispatchGate === true) return { beforeDispatch: (): boolean => dispatch() };
  if (!dispatch()) throw noEffectError("not-admitted");
  return {};
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
      ...dispatchAdmission(input.connection, permit),
    });
    if (!isCallToolResult(result) || (input.mutation && result.isError === true))
      throw new ManagedMcpError("protocol-error");
    permit?.acknowledge();
    assertCurrent(context, input.active, signal);
    return result;
  } catch (error) {
    const { reason, effect } = failureOf(error);
    await settleFailedCall(input, context, permit, effect);
    // The SDK delivers a thrown error's message to the model as an error result.
    throw new RelayToolFailure(failureText(reason, effect, input.mutation), reason, effect);
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
        ...(tool.description === undefined
          ? {}
          : { description: boundedDescription(tool.description) }),
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
