import { AsyncLocalStorage } from "node:async_hooks";
import { isAbsolute } from "node:path";
import {
  Client,
  fromJsonSchema,
  StreamableHTTPClientTransport,
  SSEClientTransport,
  type Transport,
} from "@modelcontextprotocol/client";
import {
  DEFAULT_INHERITED_ENV_VARS,
  StdioClientTransport,
} from "@modelcontextprotocol/client/stdio";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type {
  ExternalMcpConnection,
  ExternalMcpTool,
  ManagedMcpInvocationContext,
  ManagedMcpLogPort,
  ManagedMcpFailure,
} from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { deepFreeze } from "@oscharko-dev/keiko-contracts/runtime/deep-freeze";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security/hashing";
import { ManagedMcpError } from "./definitions.js";
import { recordManagedMcp } from "./activity.js";

export type ExternalMcpTransportOptions =
  | {
      readonly kind: "remote";
      readonly url: string;
      readonly transport: "streamable-http" | "sse";
      /** Server composition owns target admission, credential materialization, TLS and egress. */
      readonly fetch: (
        request: RequestInfo | URL,
        init?: RequestInit,
        context?: ManagedMcpInvocationContext,
      ) => Promise<Response>;
    }
  | {
      readonly kind: "local";
      readonly command: readonly [string, ...string[]];
      readonly cwd: string;
      /** Explicit process environment, supplied only after the server admits the launch. */
      readonly environment: Readonly<Record<string, string>>;
    };
export interface ExternalMcpClientOptions {
  readonly transport: ExternalMcpTransportOptions;
  readonly log: ManagedMcpLogPort;
  readonly correlationId: string;
  readonly signal: AbortSignal;
}
const TIMEOUT_MS = 30_000;
const MAX_BYTES = 1024 * 1024;

function captured<T>(value: T): T {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, "utf8") > MAX_BYTES) throw new ManagedMcpError("protocol-error");
  return deepFreeze(JSON.parse(text) as T);
}

function transportFor(
  options: ExternalMcpTransportOptions,
  contexts: AsyncLocalStorage<ManagedMcpInvocationContext>,
): Transport {
  if (options.kind === "remote") {
    if (!URL.canParse(options.url)) throw new ManagedMcpError("not-admitted");
    const url = new URL(options.url);
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "")
      throw new ManagedMcpError("not-admitted");
    const fetch: typeof globalThis.fetch = (request, init) =>
      options.fetch(request, init, contexts.getStore());
    if (options.transport === "sse") {
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- Explicit compatibility with existing HTTP+SSE MCP servers; new connections default to Streamable HTTP.
      return new SSEClientTransport(url, { fetch });
    }
    return new StreamableHTTPClientTransport(url, {
      fetch,
      reconnectionOptions: {
        maxRetries: 0,
        maxReconnectionDelay: 0,
        initialReconnectionDelay: 0,
        reconnectionDelayGrowFactor: 1,
      },
    });
  }
  if (!isAbsolute(options.command[0]) || !isAbsolute(options.cwd))
    throw new ManagedMcpError("not-admitted");
  // The SDK merges ambient defaults even with explicit env. Override every inherited key.
  const cleared = Object.fromEntries(DEFAULT_INHERITED_ENV_VARS.map((key) => [key, ""]));
  return new StdioClientTransport({
    command: options.command[0],
    args: options.command.slice(1),
    cwd: options.cwd,
    env: { ...cleared, HOME: options.cwd, PATH: "/usr/bin:/bin", ...options.environment },
    stderr: "ignore",
    maxBufferSize: MAX_BYTES,
  });
}

class ExternalClient implements ExternalMcpConnection {
  readonly #contexts = new AsyncLocalStorage<ManagedMcpInvocationContext>();
  readonly #client = new Client(
    { name: "keiko", version: "1" },
    {
      capabilities: {},
      versionNegotiation: { mode: "auto", probe: { maxRetries: 0 } },
      inputRequired: { autoFulfill: false },
      listMaxPages: 4,
    },
  );
  readonly #transport: Transport;
  #tools: readonly ExternalMcpTool[] = [];
  #digest = sha256Hex("[]");
  #closed = false;
  #drifted = false;
  #closing: Promise<void> | undefined;
  readonly #abort = (): void => {
    void this.close().catch(() => undefined);
  };
  constructor(private readonly options: ExternalMcpClientOptions) {
    this.#transport = transportFor(options.transport, this.#contexts);
    this.#client.setNotificationHandler("notifications/tools/list_changed", () => {
      this.#drifted = true;
    });
    const send = this.#transport.send.bind(this.#transport);
    this.#transport.send = (message, sendOptions): ReturnType<Transport["send"]> => {
      if ("method" in message && message.method === "tools/call") {
        const context = this.#contexts.getStore();
        if (
          this.#closed ||
          this.#drifted ||
          context === undefined ||
          context.signal.aborted ||
          !context.beforeEffect()
        )
          return Promise.reject(new ManagedMcpError("not-admitted"));
      }
      return send(message, sendOptions);
    };
  }
  get tools(): readonly ExternalMcpTool[] {
    return this.#tools;
  }
  async connect(): Promise<void> {
    this.options.signal.addEventListener("abort", this.#abort, { once: true });
    await this.#client.connect(this.#transport, {
      signal: this.options.signal,
      timeout: TIMEOUT_MS,
    });
    const listed = await this.#client.listTools(undefined, {
      signal: this.options.signal,
      timeout: TIMEOUT_MS,
      maxTotalTimeout: TIMEOUT_MS,
    });
    if (this.options.signal.aborted || this.#closed) throw new ManagedMcpError("aborted");
    if (
      listed.tools.length > 64 ||
      new Set(listed.tools.map((tool) => tool.name)).size !== listed.tools.length
    )
      throw new ManagedMcpError("descriptor-drift");
    this.#tools = captured(listed.tools) as readonly ExternalMcpTool[];
    this.#digest = sha256Hex(canonicalise(this.#tools));
    recordManagedMcp(
      this.options.log,
      this.options.correlationId,
      "listed",
      this.#tools.length,
      this.#digest,
    );
  }
  async call(
    name: string,
    argumentsValue: CatalogJsonObject,
    context: ManagedMcpInvocationContext,
  ): Promise<CatalogJsonObject> {
    const tool = this.#tools.find((candidate) => candidate.name === name);
    const signal = AbortSignal.any([context.signal, this.options.signal]);
    const invocation = { ...context, signal };
    if (this.#closed || tool === undefined || signal.aborted)
      throw new ManagedMcpError("not-admitted");
    if (this.#drifted) throw new ManagedMcpError("descriptor-drift");
    const args = captured(argumentsValue);
    const validation = await fromJsonSchema<CatalogJsonObject>(tool.inputSchema)[
      "~standard"
    ].validate(args);
    if (validation.issues !== undefined) throw new ManagedMcpError("invalid-arguments");
    this.record("started", context);
    try {
      const result = await this.#contexts.run(invocation, () =>
        this.#client.callTool(
          { name, arguments: args },
          {
            signal,
            timeout: TIMEOUT_MS,
            maxTotalTimeout: TIMEOUT_MS,
          },
        ),
      );
      const data = captured(result) as CatalogJsonObject;
      this.record("completed", context);
      return data;
    } catch (error) {
      const failure =
        error instanceof ManagedMcpError ? error : new ManagedMcpError("protocol-error");
      this.record("failed", context, failure.reason);
      throw failure;
    }
  }
  private record(
    phase: "started" | "completed" | "failed",
    context: ManagedMcpInvocationContext,
    reason: ManagedMcpFailure | "none" = "none",
  ): void {
    recordManagedMcp(
      this.options.log,
      context.correlationId,
      phase,
      this.#tools.length,
      this.#digest,
      reason,
      context.invocationId,
    );
  }
  async close(): Promise<void> {
    this.#closed = true;
    this.options.signal.removeEventListener("abort", this.#abort);
    this.#closing ??= this.disconnect();
    await this.#closing;
  }
  private async disconnect(): Promise<void> {
    try {
      await this.#client.close();
      recordManagedMcp(
        this.options.log,
        this.options.correlationId,
        "completed",
        this.#tools.length,
        this.#digest,
        "closed",
      );
    } catch {
      recordManagedMcp(
        this.options.log,
        this.options.correlationId,
        "failed",
        this.#tools.length,
        this.#digest,
        "closed",
      );
      throw new ManagedMcpError("closed");
    }
  }
}

/** No fallback or tool replay: the selected transport negotiates supported protocol revisions. */
export async function connectExternalMcp(
  options: ExternalMcpClientOptions,
): Promise<ExternalMcpConnection> {
  if (options.signal.aborted) throw new ManagedMcpError("aborted");
  const client = new ExternalClient(options);
  try {
    await client.connect();
    return client;
  } catch {
    await client.close();
    throw new ManagedMcpError("protocol-error");
  }
}
