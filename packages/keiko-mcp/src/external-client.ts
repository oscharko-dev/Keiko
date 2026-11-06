import { AsyncLocalStorage } from "node:async_hooks";
import { posix, win32 } from "node:path";
import {
  Client,
  fromJsonSchema,
  StreamableHTTPClientTransport,
  SSEClientTransport, // NOSONAR typescript:S1874 -- ADR-0181 explicitly supports opt-in legacy SSE; the SDK documents coexistence during migration.
  SseError,
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
import { isMcpLocalAbsolutePath } from "@oscharko-dev/keiko-contracts/runtime/mcp-servers";
import { deepFreeze } from "@oscharko-dev/keiko-contracts/runtime/deep-freeze";
import { sha256Hex } from "@oscharko-dev/keiko-security/hashing";
import { ManagedMcpError, noEffectError } from "./definitions.js";
import { recordManagedMcp, type ManagedMcpLineDetails } from "./activity.js";
import {
  admitCatalog,
  captured,
  listingFingerprint,
  type AdmittedCatalog,
  type AdmittedTool,
} from "./external-catalog.js";
import { connectCause, failureReason } from "./external-failure.js";
import { installExternalMetadataAdmission } from "./external-metadata.js";
import {
  ownedStdioLaunch,
  isNativeMcpLocalAbsolutePath,
  type McpNativeStdioOwner,
} from "./owned-stdio.js";

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
      readonly nativeOwner?: McpNativeStdioOwner;
    };
export interface ExternalMcpClientOptions {
  readonly transport: ExternalMcpTransportOptions;
  readonly log: ManagedMcpLogPort;
  readonly correlationId: string;
  readonly signal: AbortSignal;
  /** The tool names the registry allows; a larger server catalog is narrowed to them. */
  readonly allowedTools?: readonly string[] | undefined;
  /** Digest of the server's name: a join key for the lifecycle lines that carries no name. */
  readonly serverDigest?: string | undefined;
}
const CONNECT_TIMEOUT_MS = 30_000;
/** The declaration re-check before a call has its own deadline, apart from the call's. */
const LIST_TIMEOUT_MS = 15_000;
/** A call fails after this long without an answer or a progress notification... */
const CALL_IDLE_TIMEOUT_MS = 30_000;
/** ...and never runs longer than this, whatever progress it reports. */
const CALL_MAX_MS = 300_000;
/** The largest result delivered to a model. Larger ones are refused whole, never truncated. */
const RESULT_MAX_BYTES = 1024 * 1024;
/**
 * The largest single stdio frame the transport buffers. It sits far above the result bound on
 * purpose: an oversized line makes the SDK close the shared connection for every consumer, so a
 * result between the two bounds must arrive intact and be refused by `capturedResult` instead.
 */
const STDIO_FRAME_MAX_BYTES = 16 * 1024 * 1024;

function admittedLocalPath(value: string): boolean {
  return isNativeMcpLocalAbsolutePath(value);
}

function transportFor(
  options: ExternalMcpTransportOptions,
  contexts: AsyncLocalStorage<ManagedMcpInvocationContext>,
): Transport {
  if (options.kind === "remote") {
    if (!URL.canParse(options.url)) throw new ManagedMcpError("not-admitted");
    const url = new URL(options.url);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.searchParams.has("access_token")
    )
      throw new ManagedMcpError("not-admitted");
    const fetch: typeof globalThis.fetch = (request, init) =>
      options.fetch(request, init, contexts.getStore());
    if (options.transport === "sse") {
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- Explicit compatibility with existing HTTP+SSE MCP servers; new connections default to Streamable HTTP.
      return new SSEClientTransport(url, { fetch }); // NOSONAR typescript:S1874 -- only the explicitly selected legacy transport; Streamable HTTP remains the default.
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
  if (!admittedLocalPath(options.command[0]) || !admittedLocalPath(options.cwd))
    throw new ManagedMcpError("not-admitted");
  return new StdioClientTransport({
    ...ownedStdioLaunch(
      options.command,
      mcpStdioEnvironment(options),
      options.cwd,
      options.nativeOwner,
    ),
    cwd: options.cwd,
    stderr: "ignore",
    maxBufferSize: STDIO_FRAME_MAX_BYTES,
  });
}

/** Explicit local defaults keep sibling launchers usable without inheriting ambient credentials. */
export function mcpStdioEnvironment(
  options: Extract<ExternalMcpTransportOptions, { readonly kind: "local" }>,
  platform: NodeJS.Platform = process.platform,
  systemRoot: string | undefined = process.env.SYSTEMROOT ?? process.env.SystemRoot,
): Record<string, string> {
  // The SDK merges ambient defaults even with explicit env. Override every inherited key.
  const cleared = Object.fromEntries(DEFAULT_INHERITED_ENV_VARS.map((key) => [key, ""]));
  const home = options.cwd;
  if (platform !== "win32")
    return {
      ...cleared,
      HOME: home,
      TMPDIR: home,
      PATH: [posix.dirname(options.command[0]), "/usr/bin", "/bin"].join(":"),
      ...options.environment,
    };
  if (!isMcpLocalAbsolutePath(systemRoot) || !/^[A-Za-z]:/u.test(systemRoot))
    throw new ManagedMcpError("not-admitted");
  const entries = Object.entries(options.environment);
  const explicit = Object.fromEntries(entries.map(([key, value]) => [key.toUpperCase(), value]));
  if (Object.keys(explicit).length !== entries.length) throw new ManagedMcpError("not-admitted");
  const system32 = win32.join(systemRoot, "System32");
  return {
    ...cleared,
    HOME: home,
    USERPROFILE: home,
    APPDATA: home,
    LOCALAPPDATA: home,
    TEMP: home,
    TMP: home,
    SYSTEMROOT: systemRoot,
    WINDIR: systemRoot,
    COMSPEC: win32.join(system32, "cmd.exe"),
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    PATH: [win32.dirname(options.command[0]), system32, systemRoot].join(";"),
    ...explicit,
  };
}

/** One in-flight call's bookkeeping: whether its `tools/call` frame passed the dispatch gate. */
interface Flight {
  dispatched: boolean;
}

function validatorFor(schema: CatalogJsonObject): ToolValidator {
  return fromJsonSchema<CatalogJsonObject>(schema)["~standard"];
}
type ToolValidator = ReturnType<typeof fromJsonSchema<CatalogJsonObject>>["~standard"];

/** Reject when `signal` aborts first; the wait itself never outlives the call it belongs to. */
async function abortable<T>(wait: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw noEffectError("aborted");
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = (): void => {
      reject(noEffectError(failureReason(undefined, signal)));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([wait, aborted]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
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
  readonly #allowed: ReadonlySet<string> | undefined;
  readonly #validators = new Map<string, ToolValidator>();
  #tools: readonly AdmittedTool[] = [];
  #digest = sha256Hex("[]");
  #fingerprint = "";
  /** Aborts only when the connection is closed: it is what in-flight calls are bound to. */
  readonly #lifetime = new AbortController();
  /** Aborts as soon as consumers must stop using the connection, including on descriptor drift. */
  readonly #retired = new AbortController();
  #closed = false;
  #drifted = false;
  #inflight = 0;
  #drainWaiters: (() => void)[] = [];
  #closing: Promise<void> | undefined;
  #metadataTail: Promise<void> = Promise.resolve();
  readonly #abort = (): void => {
    void this.close().catch(() => undefined);
  };
  constructor(private readonly options: ExternalMcpClientOptions) {
    this.#transport = transportFor(options.transport, this.#contexts);
    this.#allowed = options.allowedTools === undefined ? undefined : new Set(options.allowedTools);
    installExternalMetadataAdmission(this.#transport, (error) => {
      this.#abortAll(error);
      void this.close().catch(() => undefined);
    });
    this.#client.onerror = (error): void => {
      // The legacy EventSource otherwise reconnects with stale session/catalog state.
      // A POST rejection is not a stream loss and must not close other consumers.
      if (!(error instanceof SseError) || this.#closed) return;
      this.line("failed", "closed");
      this.#abortAll(new ManagedMcpError("closed"));
      void this.close().catch(() => undefined);
    };
    this.#client.onclose = (): void => {
      this.#closed = true;
      this.#abortAll(new ManagedMcpError("closed"));
    };
    this.#client.setNotificationHandler("notifications/tools/list_changed", () => {
      this.#retire();
    });
    this.#installDispatchGate();
  }
  get signal(): AbortSignal {
    return this.#retired.signal;
  }
  get tools(): readonly ExternalMcpTool[] {
    return this.#tools;
  }
  /** Every cause that can end an attempt, for classifying a failed connect. */
  get attemptSignal(): AbortSignal {
    return AbortSignal.any([this.options.signal, this.#lifetime.signal]);
  }
  #abortAll(reason: ManagedMcpError): void {
    this.#lifetime.abort(reason);
    this.#retired.abort(reason);
  }
  /**
   * The catalog moved: consumers stop using this connection and no new call is dispatched, but a
   * call whose frame already left the process keeps its transport until it settles, so a write in
   * flight is not cancelled into an unknown state. The connection then closes.
   */
  #retire(): void {
    if (this.#drifted) return;
    this.#drifted = true;
    this.#retired.abort(new ManagedMcpError("descriptor-drift"));
    void this.close().catch(() => undefined);
  }
  #installDispatchGate(): void {
    const send = this.#transport.send.bind(this.#transport);
    this.#transport.send = (message, sendOptions): ReturnType<Transport["send"]> => {
      if ("method" in message && message.method === "tools/call") {
        const context = this.#contexts.getStore();
        if (
          this.#closed ||
          this.#drifted ||
          context === undefined ||
          context.signal.aborted ||
          !context.beforeEffect() ||
          context.beforeDispatch?.() === false
        )
          return Promise.reject(noEffectError("not-admitted"));
      }
      return send(message, sendOptions);
    };
  }
  /** One lifecycle line; the digests are join keys and carry no server or tool name. */
  private line(
    phase: "listed" | "started" | "completed" | "failed",
    reason: ManagedMcpFailure | "none" = "none",
    details: ManagedMcpLineDetails = {},
    correlationId: string = this.options.correlationId,
  ): void {
    recordManagedMcp(
      this.options.log,
      correlationId,
      phase,
      this.#tools.length,
      this.#digest,
      reason,
      {
        ...(this.options.serverDigest === undefined
          ? {}
          : { serverDigest: this.options.serverDigest }),
        ...details,
      },
    );
  }
  async connect(): Promise<void> {
    this.options.signal.addEventListener("abort", this.#abort, { once: true });
    const signal = AbortSignal.any([this.options.signal, this.#lifetime.signal]);
    // The SDK can miss an abort that lands before its first request is dispatched (it then sends
    // into a transport that is already closing); the wait itself must still end with the abort.
    await abortable(
      this.#client.connect(this.#transport, { signal, timeout: CONNECT_TIMEOUT_MS }),
      signal,
    );
    const listed = await abortable(
      this.#client.listTools(undefined, {
        signal,
        timeout: CONNECT_TIMEOUT_MS,
        maxTotalTimeout: CONNECT_TIMEOUT_MS,
      }),
      signal,
    );
    if (this.options.signal.aborted || this.#closed) throw new ManagedMcpError("aborted");
    const catalog = admitCatalog(listed.tools, this.#allowed);
    this.#install(catalog, listingFingerprint(listed.tools));
    const processOwner = process.platform === "win32" ? "windows-job" : "posix-process-group";
    this.line("listed", "none", {
      ...(this.options.transport.kind === "local" ? { processOwner } : {}),
      omittedToolCount: catalog.omitted,
      truncatedDescriptionCount: catalog.truncated,
    });
  }
  /** Validators are built once per catalog, not once per call. */
  #install(catalog: AdmittedCatalog, fingerprint: string): void {
    this.#tools = catalog.tools;
    this.#digest = catalog.digest;
    this.#fingerprint = fingerprint;
    this.#validators.clear();
    for (const tool of catalog.tools) {
      const inputSchema: CatalogJsonObject = tool.inputSchema;
      this.#validators.set(tool.name, validatorFor(inputSchema));
    }
  }
  async call(
    name: string,
    argumentsValue: CatalogJsonObject,
    context: ManagedMcpInvocationContext,
  ): Promise<CatalogJsonObject> {
    const tool = this.#tools.find((candidate) => candidate.name === name);
    // No deadline is shared with the declaration check: the SDK enforces one per request below.
    const signal = AbortSignal.any([context.signal, this.options.signal, this.#lifetime.signal]);
    if (this.#drifted) throw noEffectError("descriptor-drift");
    const validator = this.#validators.get(name);
    if (
      this.#closed ||
      tool === undefined ||
      validator === undefined ||
      signal.aborted ||
      !context.beforeEffect()
    )
      throw noEffectError("not-admitted");
    const args = captured(argumentsValue, RESULT_MAX_BYTES);
    const validation = await validator.validate(args);
    if (validation.issues !== undefined) throw noEffectError("invalid-arguments");
    return this.#dispatch(tool, args, context, signal);
  }
  async #dispatch(
    tool: AdmittedTool,
    args: CatalogJsonObject,
    context: ManagedMcpInvocationContext,
    signal: AbortSignal,
  ): Promise<CatalogJsonObject> {
    const flight: Flight = { dispatched: false };
    const invocation: ManagedMcpInvocationContext = {
      ...context,
      signal,
      beforeDispatch: () => {
        const admitted = context.beforeDispatch?.() !== false;
        flight.dispatched ||= admitted;
        return admitted;
      },
    };
    const details = {
      toolDigest: sha256Hex(tool.name),
      requestBytes: Buffer.byteLength(JSON.stringify(args), "utf8"),
      invocationId: context.invocationId,
    };
    const started = Date.now();
    this.line("started", "none", details, context.correlationId);
    this.#inflight++;
    try {
      const data = await this.#exchange(tool, args, invocation, signal);
      this.line(
        "completed",
        "none",
        { ...details, durationMs: Date.now() - started, dispatched: true, resultBytes: data.bytes },
        context.correlationId,
      );
      return data.value;
    } catch (error) {
      const reason = failureReason(error, signal);
      const effect = flight.dispatched ? "possible" : "none";
      this.line(
        "failed",
        reason,
        { ...details, durationMs: Date.now() - started, dispatched: flight.dispatched, effect },
        context.correlationId,
      );
      throw new ManagedMcpError(reason, undefined, effect);
    } finally {
      this.#leave();
    }
  }
  async #exchange(
    tool: AdmittedTool,
    args: CatalogJsonObject,
    invocation: ManagedMcpInvocationContext,
    signal: AbortSignal,
  ): Promise<{ readonly value: CatalogJsonObject; readonly bytes: number }> {
    await this.#contexts.run(invocation, () => this.verifyDeclarations(signal));
    const result = await this.#contexts.run(invocation, () =>
      this.#client.callTool(
        { name: tool.name, arguments: args },
        {
          // Pin the admitted definition: SDK HEADER_MISMATCH recovery must never replay effects.
          toolDefinition: tool,
          signal,
          // The call has its own budget; progress from the server extends it up to the hard cap.
          timeout: CALL_IDLE_TIMEOUT_MS,
          resetTimeoutOnProgress: true,
          onprogress: noProgress,
          maxTotalTimeout: CALL_MAX_MS,
        },
      ),
    );
    return capturedResult(result);
  }
  #leave(): void {
    this.#inflight--;
    if (this.#inflight > 0) return;
    for (const wake of this.#drainWaiters.splice(0)) wake();
  }
  /** Resolves when no call is in flight, or after the longest a call can last. */
  async #drain(): Promise<void> {
    if (this.#inflight === 0) return;
    let timer: NodeJS.Timeout | undefined;
    const idle = new Promise<void>((resolve) => {
      this.#drainWaiters.push(resolve);
      timer = setTimeout(resolve, CALL_MAX_MS);
    });
    try {
      await idle;
    } finally {
      clearTimeout(timer);
    }
  }
  private async verifyDeclarations(signal: AbortSignal): Promise<void> {
    const previous = this.#metadataTail;
    let release: () => void = (): void => undefined;
    this.#metadataTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await abortable(previous, signal);
      await this.readDeclarations(signal);
    } finally {
      release();
    }
  }
  private async readDeclarations(signal: AbortSignal): Promise<void> {
    const listed = await this.#client.listTools(undefined, {
      cacheMode: "bypass",
      signal,
      timeout: LIST_TIMEOUT_MS,
      maxTotalTimeout: LIST_TIMEOUT_MS,
    });
    if (listingFingerprint(listed.tools) === this.#fingerprint) return;
    // A reordered but equal catalog must not retire the connection: compare the admitted digest.
    if (admitCatalog(listed.tools, this.#allowed).digest !== this.#digest) {
      this.#retire();
      throw noEffectError("descriptor-drift");
    }
    this.#fingerprint = listingFingerprint(listed.tools);
  }
  async close(): Promise<void> {
    this.#closing ??= this.#shutdown();
    await this.#closing;
  }
  async #shutdown(): Promise<void> {
    // After drift, calls already dispatched finish first; every other close is immediate.
    if (this.#drifted && !this.#closed) await this.#drain();
    this.#closed = true;
    this.#abortAll(new ManagedMcpError("closed"));
    this.options.signal.removeEventListener("abort", this.#abort);
    await this.disconnect();
  }
  private async disconnect(): Promise<void> {
    try {
      await this.#client.close();
      this.line("completed", "closed");
    } catch {
      this.line("failed", "closed");
      throw new ManagedMcpError("closed");
    }
  }
}

function noProgress(): void {
  /* progress only extends the call's idle deadline */
}

/** The result is bounded after the frame was read, so an oversized one never closes the stream. */
function capturedResult(result: unknown): {
  readonly value: CatalogJsonObject;
  readonly bytes: number;
} {
  const text = JSON.stringify(result);
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > RESULT_MAX_BYTES) throw new ManagedMcpError("result-too-large");
  return { value: deepFreeze(JSON.parse(text) as CatalogJsonObject), bytes };
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
  } catch (error) {
    const cause = connectCause(error, client.attemptSignal);
    const reason = failureReason(error, client.attemptSignal);
    recordManagedMcp(
      options.log,
      options.correlationId,
      "failed",
      0,
      sha256Hex("[]"),
      reason === "deadline-exceeded" || reason === "aborted" ? reason : "protocol-error",
      {
        connectCause: cause,
        ...(options.serverDigest === undefined ? {} : { serverDigest: options.serverDigest }),
      },
    );
    await client.close();
    throw new ManagedMcpError(
      reason === "deadline-exceeded" || reason === "aborted" ? reason : "protocol-error",
    );
  }
}
