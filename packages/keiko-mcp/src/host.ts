import { AsyncLocalStorage } from "node:async_hooks";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler, fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import {
  MANAGED_MCP_PROTOCOL_VERSION,
  type ManagedMcpHost,
  type ManagedMcpInvocationContext,
  type ManagedMcpLogPort,
  type ManagedMcpProvider,
  type ManagedMcpTool,
  type ManagedMcpToolResult,
  type ManagedMcpToolDeclaration,
} from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security/hashing";
import { recordManagedMcp } from "./activity.js";
import { ManagedMcpError, definitionIdentity, toolDefinition, toolsOf } from "./definitions.js";

import { deepFreeze } from "@oscharko-dev/keiko-contracts/runtime/deep-freeze";

const INTERNAL_URL = "https://keiko-managed.invalid/mcp";
const SERVER_INFO = { name: "keiko-managed", version: "1" };
const RESERVED_ARGUMENTS = new Set([
  "authRef",
  "credentialRef",
  "baseUrl",
  "destination",
  "binding",
  "consumer",
  "authority",
  "context",
  "_meta",
]);

function failure(error: unknown, signal?: AbortSignal): ManagedMcpError {
  if (signal?.aborted) return new ManagedMcpError("aborted");
  return error instanceof ManagedMcpError ? error : new ManagedMcpError("protocol-error");
}

function withSignal<Context extends ManagedMcpInvocationContext>(
  context: Context,
  ...signals: AbortSignal[]
): Context {
  const signal = AbortSignal.any([context.signal, ...signals]);
  return {
    ...context,
    signal,
    beforeEffect: () => !signal.aborted && context.beforeEffect() && !signal.aborted,
  };
}

async function capturedResult<Context extends ManagedMcpInvocationContext>(
  tool: ManagedMcpTool<Context>,
  result: ManagedMcpToolResult,
): Promise<CatalogJsonObject> {
  const encoded = JSON.stringify(result.data);
  if (Buffer.byteLength(encoded) > tool.descriptor.bounds.maxResultBytes)
    throw new ManagedMcpError("protocol-error");
  // Capture before the asynchronous validator so a provider cannot mutate an admitted result.
  const captured: unknown = JSON.parse(encoded);
  const validated = await fromJsonSchema<CatalogJsonObject>(tool.descriptor.resultSchema)[
    "~standard"
  ].validate(captured);
  if (validated.issues !== undefined) throw new ManagedMcpError("protocol-error");
  return validated.value;
}

class ManagedHost<Context extends ManagedMcpInvocationContext> implements ManagedMcpHost<Context> {
  readonly #contexts = new AsyncLocalStorage<Context>();
  readonly #requests = new WeakMap<Request, Context>();
  readonly #client: Client;
  readonly #handler: ReturnType<typeof createMcpHandler>;
  readonly #expected: string;
  readonly #declarations: string;
  readonly #registrySha256: string;
  readonly #toolCount: number;
  readonly #catalog: readonly ManagedMcpToolDeclaration[];
  readonly #tools: readonly ManagedMcpTool<Context>[];
  readonly #lifetime = new AbortController();
  #admission: Promise<void> | undefined;
  #admitted = false;
  #closed = false;

  public constructor(
    private readonly providers: readonly ManagedMcpProvider<Context>[],
    private readonly log: ManagedMcpLogPort,
  ) {
    const tools = toolsOf(providers);
    this.#tools = deepFreeze(
      tools.map(({ name, risk, descriptor, execute }) => ({
        name,
        risk,
        descriptor: structuredClone(descriptor),
        execute,
      })),
    );
    this.#catalog = deepFreeze(
      this.#tools.map(({ name, risk, descriptor }) => ({ name, risk, descriptor })),
    );
    this.#expected = definitionIdentity(tools.map(toolDefinition));
    this.#declarations = this.declarationIdentity(tools);
    this.#registrySha256 = sha256Hex(this.#declarations);
    this.#toolCount = tools.length;
    this.#handler = createMcpHandler(({ requestInfo }) => this.server(requestInfo), {
      legacy: "reject",
      responseMode: "auto",
      keepAliveMs: 0,
      maxRequestBodySize: TOOL_CATALOG_LIMITS.maxArgumentBytes + 16_384,
    });
    this.#client = new Client(SERVER_INFO, {
      capabilities: {},
      versionNegotiation: { mode: { pin: MANAGED_MCP_PROTOCOL_VERSION }, probe: { maxRetries: 0 } },
      inputRequired: { autoFulfill: false },
    });
  }

  private declarationIdentity(tools: readonly ManagedMcpTool<Context>[]): string {
    return canonicalise(
      tools.map((tool) => ({ name: tool.name, risk: tool.risk, descriptor: tool.descriptor })),
    );
  }

  private currentTools(): readonly ManagedMcpTool<Context>[] {
    const tools = toolsOf(this.providers);
    if (
      this.declarationIdentity(tools) !== this.#declarations ||
      tools.some((tool, index) => tool.execute !== this.#tools[index]?.execute)
    )
      throw new ManagedMcpError("descriptor-drift");
    return this.#tools;
  }

  private invocationContext(context: Context, signal: AbortSignal): Context {
    const scoped = withSignal(context, signal);
    return {
      ...scoped,
      beforeEffect: (): boolean => {
        this.currentTools();
        const allowed = scoped.beforeEffect();
        this.currentTools();
        return allowed;
      },
    };
  }

  private server(request?: Request): McpServer {
    const context = request === undefined ? undefined : this.#requests.get(request);
    const server = new McpServer(SERVER_INFO, {
      supportedProtocolVersions: [MANAGED_MCP_PROTOCOL_VERSION],
      maxToolInputElements: 10_000,
    });
    for (const tool of this.currentTools()) {
      const definition = toolDefinition(tool);
      server.registerTool(
        tool.name,
        {
          description: tool.descriptor.description,
          inputSchema: fromJsonSchema<CatalogJsonObject>(tool.descriptor.inputSchema),
          outputSchema: fromJsonSchema<CatalogJsonObject>(tool.descriptor.resultSchema),
          annotations: { ...definition.annotations },
        },
        async (args, sdkContext) => {
          if (context === undefined || context.signal.aborted) throw new ManagedMcpError("aborted");
          try {
            this.currentTools();
            const result = await tool.execute(
              args,
              this.invocationContext(context, sdkContext.mcpReq.signal),
            );
            const isError = result.isError === true;
            const structuredContent = await capturedResult(tool, result);
            return {
              content: [],
              structuredContent,
              isError,
            };
          } catch {
            // The SDK renders handler error messages as content; discard arbitrary provider errors.
            throw new ManagedMcpError("tool-error");
          }
        },
      );
    }
    return server;
  }

  private async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const context = this.#contexts.getStore();
    const original = new Request(input, init);
    if (original.url !== INTERNAL_URL || original.method !== "POST")
      throw new ManagedMcpError("protocol-error");
    const request =
      context === undefined
        ? original
        : new Request(original, { signal: AbortSignal.any([original.signal, context.signal]) });
    if (context !== undefined) this.#requests.set(request, withSignal(context, request.signal));
    try {
      return await this.#handler.fetch(request);
    } finally {
      this.#requests.delete(request);
    }
  }

  private async list(
    correlationId: string,
    invocationId?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    this.currentTools();
    const listed = await this.#client.listTools(undefined, {
      cacheMode: "bypass",
      timeout: 10_000,
      ...(signal === undefined ? {} : { signal }),
    });
    if (definitionIdentity(listed.tools) !== this.#expected || listed.nextCursor !== undefined)
      throw new ManagedMcpError("descriptor-drift");
    recordManagedMcp(
      this.log,
      correlationId,
      "listed",
      listed.tools.length,
      this.#registrySha256,
      "none",
      invocationId,
    );
  }

  public async admit(correlationId: string): Promise<void> {
    if (this.#closed) throw new ManagedMcpError("closed");
    this.#admission ??= this.connect(correlationId);
    return this.#admission;
  }

  private async connect(correlationId: string): Promise<void> {
    try {
      await this.#client.connect(
        new StreamableHTTPClientTransport(new URL(INTERNAL_URL), {
          fetch: (input, init): Promise<Response> => this.fetch(input, init),
          reconnectionOptions: {
            maxRetries: 0,
            initialReconnectionDelay: 1,
            maxReconnectionDelay: 1,
            reconnectionDelayGrowFactor: 1,
          },
        }),
        { timeout: 10_000 },
      );
      if (this.#client.getProtocolEra() !== "modern") throw new ManagedMcpError("protocol-error");
      await this.list(correlationId);
      recordManagedMcp(this.log, correlationId, "admitted", this.#toolCount, this.#registrySha256);
      this.#admitted = true;
    } catch (error) {
      const refused = failure(error);
      recordManagedMcp(
        this.log,
        correlationId,
        "failed",
        this.#toolCount,
        this.#registrySha256,
        refused.reason,
      );
      throw refused;
    }
  }

  public catalog(): readonly ManagedMcpToolDeclaration[] {
    if (this.#closed) throw new ManagedMcpError("closed");
    if (!this.#admitted) throw new ManagedMcpError("not-admitted");
    this.currentTools();
    return this.#catalog;
  }

  public protocolEra(): "modern" | undefined {
    return this.#admitted && !this.#closed ? "modern" : undefined;
  }

  public async call(
    name: string,
    argumentsValue: CatalogJsonObject,
    context: Context,
  ): Promise<CatalogJsonObject> {
    recordManagedMcp(
      this.log,
      context.correlationId,
      "started",
      this.#toolCount,
      this.#registrySha256,
      "none",
      context.invocationId,
    );
    try {
      if (this.#closed) throw new ManagedMcpError("closed");
      if (!this.#admitted) throw new ManagedMcpError("not-admitted");
      if (context.signal.aborted) throw new ManagedMcpError("aborted");
      if (
        Object.keys(argumentsValue).some((key) => RESERVED_ARGUMENTS.has(key)) ||
        !this.currentTools().some((tool) => tool.name === name)
      )
        throw new ManagedMcpError("invalid-arguments");
      const result = await this.invoke(name, argumentsValue, context);
      recordManagedMcp(
        this.log,
        context.correlationId,
        "completed",
        this.#toolCount,
        this.#registrySha256,
        "none",
        context.invocationId,
      );
      return result;
    } catch (error) {
      const refused = failure(error, context.signal);
      recordManagedMcp(
        this.log,
        context.correlationId,
        "failed",
        this.#toolCount,
        this.#registrySha256,
        refused.reason,
        context.invocationId,
      );
      throw refused;
    }
  }

  private async invoke(
    name: string,
    argumentsValue: CatalogJsonObject,
    context: Context,
  ): Promise<CatalogJsonObject> {
    const tool = this.currentTools().find((candidate) => candidate.name === name);
    if (tool === undefined) throw new ManagedMcpError("invalid-arguments");
    const invocation = new AbortController();
    const bound = withSignal(context, this.#lifetime.signal, invocation.signal);
    const timeout = Math.min(30_000, tool.descriptor.bounds.maxDurationMs);
    const timer = setTimeout(() => {
      invocation.abort();
    }, timeout);
    timer.unref();
    try {
      const result = await this.#contexts.run(bound, async () => {
        await this.list(bound.correlationId, bound.invocationId, bound.signal);
        if (bound.signal.aborted) throw new ManagedMcpError("aborted");
        return this.#client.callTool(
          { name, arguments: argumentsValue },
          { signal: bound.signal, timeout },
        );
      });
      if (result.isError)
        throw new ManagedMcpError(
          "tool-error",
          result.structuredContent as CatalogJsonObject | undefined,
        );
      if (result.structuredContent === undefined) throw new ManagedMcpError("protocol-error");
      return result.structuredContent as CatalogJsonObject;
    } catch (error) {
      if (invocation.signal.aborted) throw new ManagedMcpError("deadline-exceeded");
      throw failure(error, bound.signal);
    } finally {
      clearTimeout(timer);
      invocation.abort();
    }
  }

  public async close(): Promise<void> {
    this.#closed = true;
    this.#lifetime.abort();
    await Promise.all([this.#client.close(), this.#handler.close()]);
  }
}

export function createManagedMcpHost<Context extends ManagedMcpInvocationContext>(options: {
  readonly providers: readonly ManagedMcpProvider<Context>[];
  readonly log: ManagedMcpLogPort;
}): ManagedMcpHost<Context> {
  return new ManagedHost(options.providers, options.log);
}
