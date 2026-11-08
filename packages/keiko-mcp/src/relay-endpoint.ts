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
  type ManagedMcpToolResult,
  type ManagedMcpReadCapture,
} from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { canonicalise } from "@oscharko-dev/keiko-security/hashing";
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
    ...(input.connection.localProvider === undefined ? {} : { localProvider: input.connection.localProvider }),
  });
  if (permit === undefined) throw new ManagedMcpError("not-admitted");
  return permit;
}
/** Fixed, model-readable words per closed reason; no server text, name or path. */
const FAILURE_TEXT: Readonly<Partial<Record<ManagedMcpFailure, string>>> = {
  "connector-scope-missing":
    "This task does not grant the connector access required for this operation. Review the access selection and start a new task with the required access. Full access mode alone does not grant Jira administration. Do not retry automatically.",
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
    cause: unknown,
  ) {
    super(message, { cause });
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
  observation: RelayObservation,
): { readonly beforeDispatch?: () => boolean } {
  const dispatch = permit?.dispatch;
  if (dispatch === undefined) return {};
  if (connection.dispatchGate === true) return {
    beforeDispatch: (): boolean => {
      const admitted = dispatch();
      if (admitted) observation.dispatched = true;
      return admitted;
    },
  };
  if (!dispatch()) throw noEffectError("not-admitted");
  observation.dispatched = true;
  return {};
}

interface RelayObservation {
  dispatched: boolean;
  retained?: ManagedMcpToolResult;
  localFailure?: true;
}
function resultCapture(
  permit: ManagedMcpMutationInvocation | ManagedMcpReadCapture | undefined,
  observation: RelayObservation,
): Pick<ManagedMcpInvocationContext, "retainProviderResult" | "retainLocalFailure"> {
  const retain = permit?.retainProviderResult;
  const retainLocalFailure = permit?.retainLocalFailure;
  return {
    retainLocalFailure: retainLocalFailure === undefined ? undefined : (reason) => {
      retainLocalFailure(reason);
      observation.localFailure = true;
    },
    retainProviderResult: retain === undefined ? undefined : (result) => {
      const retained = retain(result);
      observation.retained = retained;
      return retained;
    },
  };
}

/** A technical read failure is not a permission refusal and never enters mutation recovery. */
function throwRelayCallFailure(
  input: RelayCall,
  capture: ManagedMcpReadCapture | undefined,
  observation: RelayObservation,
  reason: ManagedMcpFailure,
  effect: ManagedMcpEffect,
  primaryError: unknown,
): never {
  const failure = (cause: unknown): RelayToolFailure =>
    new RelayToolFailure(failureText(reason, effect, input.mutation), reason, effect, cause);
  if (input.mutation || input.connection.localProvider !== "jira" || capture === undefined ||
      observation.retained !== undefined || observation.localFailure === true) throw failure(primaryError);
  try {
    capture.retainRelayFailure(reason);
  } catch (captureError) {
    // Preserve both original causes, while the SDK receives only the primary closed failure.
    throw failure(new AggregateError([primaryError, captureError], "Jira read result retention failed"));
  }
  throw failure(primaryError);
}

function isLocalMetadataRead(input: Pick<RelayCall, "connection" | "name" | "mutation">): boolean {
  return !input.mutation && input.connection.localProvider === "jira" &&
    (input.name === "jira.discover" || input.name === "jira.describe") &&
    input.connection.localMetadataTools?.includes(input.name) === true;
}
function beginReadCapture(input: RelayCall, context: ManagedMcpInvocationContext): ManagedMcpReadCapture | undefined {
  if (input.mutation || input.connection.localProvider !== "jira" || isLocalMetadataRead(input)) return undefined;
  const capture = context.beginReadCapture?.({
    toolName: input.name, argumentsValue: input.argumentsValue, localProvider: "jira",
    signal: AbortSignal.any([context.signal, input.signal]),
  });
  if (capture === undefined) throw new ManagedMcpError("not-admitted");
  return capture;
}
function assertRetainedResult(result: CallToolResult, observation: RelayObservation): void {
  const retained = observation.retained;
  if (retained !== undefined && (
    (result.isError === true) !== (retained.isError === true) ||
    canonicalise(result.structuredContent) !== canonicalise(retained.data)
  )) throw new ManagedMcpError("protocol-error");
}

function retainedPreflightFailure(
  observation: RelayObservation,
  permit: ManagedMcpMutationInvocation | undefined,
): CallToolResult {
  const retained = observation.retained;
  if (retained === undefined) throw new ManagedMcpError("protocol-error");
  // Only the actual private transport gate proves no dispatch. isError never proves no effect.
  if (observation.dispatched) throw new ManagedMcpError("tool-error");
  permit?.release?.();
  return {
    isError: true,
    structuredContent: retained.data,
    content: [{ type: "text", text: JSON.stringify(retained.data) }],
  };
}

async function invokeRelayTool(input: RelayCall): Promise<CallToolResult> {
  const { context } = input;
  assertCurrent(context, input.active, input.signal);
  const permit = beginMutation(input, context);
  const readCapture = beginReadCapture(input, context);
  const observation: RelayObservation = { dispatched: input.mutation && permit?.dispatch === undefined };
  try {
    const signal = AbortSignal.any([context.signal, input.signal]);
    const result = await input.connection.call(input.name, input.argumentsValue, {
      ...context,
      signal,
      invocationId: permit?.invocationId ?? readCapture?.invocationId ?? context.invocationId,
      ...dispatchAdmission(input.connection, permit, observation),
      ...resultCapture(permit ?? readCapture, observation),
    });
    if (!isCallToolResult(result)) throw new ManagedMcpError("protocol-error");
    assertRetainedResult(result, observation);
    if (input.mutation && result.isError === true) {
      assertCurrent(context, input.active, signal);
      const failure = retainedPreflightFailure(observation, permit);
      assertCurrent(context, input.active, signal);
      return failure;
    }
    permit?.acknowledge();
    assertCurrent(context, input.active, signal);
    return result;
  } catch (error) {
    const { reason, effect } = failureOf(error);
    await settleFailedCall(input, context, permit, effect);
    // The SDK delivers a thrown error's message to the model as an error result.
    throwRelayCallFailure(input, readCapture, observation, reason, effect, error);
  } finally {
    readCapture?.release();
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
  const advertised = connection.tools;
  for (const tool of advertised.filter((tool) => allowed.has(tool.name))) {
    server.registerTool(
      tool.name,
      {
        ...(tool.description === undefined
          ? {}
          : { description: boundedDescription(tool.description) }),
        inputSchema: fromJsonSchema<CatalogJsonObject>(tool.inputSchema),
      },
      async (args, sdkContext) => {
        const result = await invokeRelayTool({
          connection,
          context,
          active,
          name: tool.name,
          argumentsValue: args,
          mutation: allowed.get(tool.name) === "write",
          signal: sdkContext.mcpReq.signal,
          sessionId: sdkContext.mcpReq._meta?.["ai.opencode/sessionID"],
        });
        // Managed selection replaces the immutable list. Notify on this request's stream so the
        // native client refreshes its cached tools; no separate listener or replay is needed.
        if (connection.tools !== advertised && isLocalMetadataRead({ connection, name: tool.name,
          mutation: allowed.get(tool.name) === "write" }))
          await sdkContext.mcpReq.notify({ method: "notifications/tools/list_changed" });
        return result;
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
