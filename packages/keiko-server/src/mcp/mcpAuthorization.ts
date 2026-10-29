import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type {
  McpServerDefinition,
  CodingWorkbenchMcpAuthorizationStart,
} from "@oscharko-dev/keiko-contracts/runtime/mcp-servers";
import {
  createMcpOAuthClient,
  ManagedMcpError,
  type McpOAuthClient,
} from "@oscharko-dev/keiko-mcp";
import {
  gatewayFetch,
  type OutboundHttpEgressConfig,
} from "@oscharko-dev/keiko-model-gateway/internal/http";
import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import {
  createCentralMcpOAuthPersistence,
  type McpOAuthCredentialStoreInput,
} from "./mcpOAuthCredentialStore.js";
import type { McpSettingsStore } from "./mcpSettingsStore.js";
import { recordMcpAuthorization } from "./mcpAuthorizationActivity.js";
import { emitServerDiagnostic, contentFreeErrorClass } from "../diagnostics-log.js";

interface Options extends McpOAuthCredentialStoreInput {
  readonly settings: McpSettingsStore;
  readonly log: ServerLogSink;
  readonly egress: () => OutboundHttpEgressConfig | undefined;
  readonly fetch?: typeof gatewayFetch;
}
type State = "pending" | "complete" | "failed" | "expired" | "cancelled";
interface Attempt {
  readonly correlationId: string;
  readonly id: string;
  readonly stateToken: string;
  readonly server: string;
  readonly session: string;
  readonly generation: AbortSignal;
  readonly generationAbort: () => void;
  readonly controller: AbortController;
  readonly expiresAtMs: number;
  readonly current: () => boolean;
  readonly listener: Server;
  readonly client: McpOAuthClient;
  readonly commit: () => void;
  state: State;
  claimed: boolean;
  timer?: ReturnType<typeof setTimeout>;
}
export interface McpAuthorization {
  readonly credentials: (server: McpServerDefinition) => readonly string[];
  readonly authorized: (server: McpServerDefinition) => boolean;
  readonly token: (server: McpServerDefinition, correlationId: string) => Promise<string>;
  readonly start: (
    name: string,
    session: string,
    current: () => boolean,
    correlationId: string,
  ) => Promise<CodingWorkbenchMcpAuthorizationStart>;
  readonly status: (name: string, session: string, id: string) => State | "unavailable";
  readonly cancel: (name: string, session: string, id: string) => void;
  readonly revoke: (name: string, correlationId: string) => void;
  readonly close: () => Promise<void>;
}

function remote(server: McpServerDefinition): asserts server is McpServerDefinition & {
  transport: {
    kind: "remote";
    url: string;
    oauth: NonNullable<Extract<McpServerDefinition["transport"], { kind: "remote" }>["oauth"]>;
  };
} {
  if (server.transport.kind !== "remote" || server.transport.oauth === undefined)
    throw new ManagedMcpError("not-admitted");
}
function persistence(
  options: Options,
  server: McpServerDefinition,
): ReturnType<typeof createCentralMcpOAuthPersistence> {
  remote(server);
  return createCentralMcpOAuthPersistence(options, {
    server: server.name,
    url: server.transport.url,
    oauth: server.transport.oauth,
  });
}
function stagedPersistence(
  options: Options,
  server: McpServerDefinition,
): Parameters<typeof createMcpOAuthClient>[0]["persistence"] & { readonly commit: () => void } {
  const store = persistence(options, server);
  let pending: Readonly<Record<string, unknown>> | undefined;
  return {
    read: store.read,
    write: (state: Readonly<Record<string, unknown>>): void => {
      pending = state;
    },
    commit: (): void => {
      if (pending === undefined) throw new ManagedMcpError("not-admitted");
      store.write(pending);
    },
  };
}
function requireCurrent(signal: AbortSignal, current: () => boolean): void {
  if (signal.aborted || !current()) throw new ManagedMcpError("not-admitted");
}
function oauthTarget(request: Request): void {
  const target = new URL(request.url);
  if (
    target.protocol !== "https:" ||
    target.username !== "" ||
    target.password !== "" ||
    target.hash !== ""
  )
    throw new ManagedMcpError("not-admitted");
  if (request.method !== "GET" && request.method !== "POST")
    throw new ManagedMcpError("not-admitted");
}
function oauthNetwork(
  server: McpServerDefinition,
  target: string,
): {
  readonly allowPrivateNetwork: boolean;
  readonly requiredTargetClass: "private" | "public";
} {
  remote(server);
  const origin = new URL(target).origin;
  const configuredOrigin =
    origin === new URL(server.transport.url).origin ||
    origin === new URL(server.transport.oauth.issuer).origin;
  const privateNetwork = server.transport.network === "private" && configuredOrigin;
  return {
    allowPrivateNetwork: privateNetwork,
    requiredTargetClass: privateNetwork ? "private" : "public",
  };
}
/** All OAuth HTTP, including discovery/registration/refresh, uses the existing pinned egress. */
function oauthFetch(
  options: Options,
  server: McpServerDefinition,
  signal: AbortSignal,
  current: () => boolean,
): typeof fetch {
  return async (input, init): Promise<Response> => {
    requireCurrent(signal, current);
    const request = new Request(input, init);
    oauthTarget(request);
    const body = request.body === null ? undefined : new Uint8Array(await request.arrayBuffer());
    if ((body?.byteLength ?? 0) > 65536) throw new ManagedMcpError("not-admitted");
    requireCurrent(signal, current);
    const response = await (options.fetch ?? gatewayFetch)(request.url, {
      method: request.method,
      headers: request.headers,
      ...(body === undefined ? {} : { body }),
      redirect: "manual",
      timeoutMs: 10_000,
      maxResponseBytes: 65536,
      signal: AbortSignal.any([signal, request.signal]),
      egress: {
        ...options.egress(),
        denyLoopback: true,
        ...oauthNetwork(server, request.url),
        allowLinkLocalAndMetadata: false,
        pinProxiedConnectTarget: true,
      },
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new ManagedMcpError("not-admitted");
    }
    return response;
  };
}
function callbackLocation(attempt: Attempt, request: IncomingMessage): string | undefined {
  const raw = request.url ?? "";
  const address = attempt.listener.address();
  if (
    request.method !== "GET" ||
    !raw.startsWith("/callback?") ||
    raw.length > 8192 ||
    address === null ||
    typeof address === "string"
  )
    return undefined;
  return request.headers.host === `127.0.0.1:${String(address.port)}` ? raw : undefined;
}
function callbackQuery(attempt: Attempt, request: IncomingMessage): URLSearchParams | undefined {
  const location = callbackLocation(attempt, request);
  if (location === undefined) return undefined;
  const url = new URL(location, "http://127.0.0.1");
  const query = url.searchParams;
  if (
    url.pathname !== "/callback" ||
    query.getAll("state").length !== 1 ||
    query.get("state") !== attempt.stateToken ||
    query.getAll("iss").length > 1
  )
    return undefined;
  return query;
}
function authorizationCode(query: URLSearchParams): string | undefined {
  if (query.has("error") || query.getAll("code").length !== 1) return undefined;
  const code = query.get("code");
  return code === null || code === "" ? undefined : code;
}
class AuthorizationOwner implements McpAuthorization {
  readonly #attempts = new Map<string, Attempt>();
  readonly #clients = new Map<string, { signal: AbortSignal; client: McpOAuthClient }>();
  readonly #lifetime = new AbortController();
  readonly #starting = new Set<string>();
  constructor(private readonly options: Options) {}
  private server(name: string, correlationId: string): McpServerDefinition {
    const server = this.options.settings
      .read(correlationId)
      .servers.find((entry) => entry.name === name && entry.enabled);
    if (server === undefined || this.#lifetime.signal.aborted)
      throw new ManagedMcpError("not-admitted");
    remote(server);
    return server;
  }
  private client(server: McpServerDefinition, correlationId: string): McpOAuthClient {
    remote(server);
    const generation = this.options.settings.generation(server, correlationId);
    const previous = this.#clients.get(server.name);
    if (previous?.signal === generation) return previous.client;
    const signal = AbortSignal.any([generation, this.#lifetime.signal]);
    const current = (): boolean =>
      !signal.aborted && !this.options.settings.generation(server, correlationId).aborted;
    const client = createMcpOAuthClient({
      url: server.transport.url,
      oauth: server.transport.oauth,
      persistence: persistence(this.options, server),
      beforeEffect: current,
      fetch: oauthFetch(this.options, server, signal, current),
    });
    this.#clients.set(server.name, { signal: generation, client });
    return client;
  }
  authorized(server: McpServerDefinition): boolean {
    return this.client(server, "mcp-authorization").authorized();
  }
  credentials(server: McpServerDefinition): readonly string[] {
    return this.client(server, "mcp-authorization").credentials();
  }
  async token(server: McpServerDefinition, correlationId: string): Promise<string> {
    const client = this.client(server, correlationId);
    const evidenceId = `con_${randomBytes(24).toString("hex")}`;
    try {
      const token = await client.token();
      recordMcpAuthorization(this.options.log, correlationId, evidenceId, "credential-ready");
      return token;
    } catch (error) {
      recordMcpAuthorization(
        this.options.log,
        correlationId,
        evidenceId,
        client.authorized() ? "credential-unavailable" : "credential-required",
      );
      throw error;
    }
  }
  private settle(attempt: Attempt, state: State): void {
    if (attempt.state !== "pending") return;
    attempt.state = state;
    clearTimeout(attempt.timer);
    attempt.generation.removeEventListener("abort", attempt.generationAbort);
    attempt.controller.abort();
    attempt.listener.close();
    if (state !== "complete") attempt.listener.closeAllConnections();
    recordMcpAuthorization(this.options.log, attempt.correlationId, attempt.id, state);
  }
  private async callback(
    attempt: Attempt,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    response.setHeader("cache-control", "no-store");
    response.setHeader("content-type", "text/plain; charset=utf-8");
    response.setHeader("referrer-policy", "no-referrer");
    const query = callbackQuery(attempt, request);
    if (query === undefined || attempt.claimed || !this.active(attempt)) {
      response.writeHead(400).end("Authorization refused.");
      return;
    }
    const code = authorizationCode(query);
    if (code === undefined) {
      response.writeHead(400).end("Authorization failed. Return to Keiko.");
      this.settle(attempt, "failed");
      return;
    }
    attempt.claimed = true;
    try {
      await attempt.client.complete(code, query.get("iss") ?? undefined);
      if (!this.active(attempt)) throw new ManagedMcpError("not-admitted");
      this.options.settings.revoke(attempt.server, attempt.id);
      attempt.commit();
      // Reply before closing the one-use listener. No authorization data is reflected.
      response.end("Authorization complete. Return to Keiko.");
      this.settle(attempt, "complete");
    } catch (error) {
      emitServerDiagnostic(undefined, {
        correlationId: attempt.correlationId,
        timestamp: new Date().toISOString(),
        operation: "mcp.connection",
        source: "mcp.authorization.callback",
        errorClass: contentFreeErrorClass(error),
        message: "runtime-turn-failed",
        code: "stage=mcp-authorization",
      });
      response.writeHead(400).end("Authorization failed. Return to Keiko.");
      this.settle(attempt, "failed");
    }
  }
  private active(attempt: Attempt): boolean {
    return (
      attempt.state === "pending" &&
      Date.now() < attempt.expiresAtMs &&
      !attempt.generation.aborted &&
      !attempt.controller.signal.aborted &&
      attempt.current()
    );
  }
  async start(
    name: string,
    session: string,
    current: () => boolean,
    correlationId: string,
  ): Promise<CodingWorkbenchMcpAuthorizationStart> {
    const server = this.server(name, correlationId);
    this.pruneAttempts(name);
    if (!current() || this.#attempts.size >= 16) throw new ManagedMcpError("not-admitted");
    if (this.#starting.has(name)) return { outcome: "refused", reason: "unavailable" };
    this.#starting.add(name);
    let attempt: Attempt;
    try {
      attempt = await this.createAttempt(server, session, current, correlationId);
    } finally {
      this.#starting.delete(name);
    }
    this.#attempts.set(attempt.id, attempt);
    try {
      const address = attempt.listener.address();
      if (address === null || typeof address === "string")
        throw new ManagedMcpError("not-admitted");
      recordMcpAuthorization(this.options.log, correlationId, attempt.id, "pending");
      const authorizationUrl = await attempt.client.start(
        `http://127.0.0.1:${String(address.port)}/callback`,
        attempt.stateToken,
      );
      if (!this.active(attempt)) throw new ManagedMcpError("not-admitted");
      return {
        outcome: "started",
        attemptId: attempt.id,
        authorizationUrl,
        expiresAtMs: attempt.expiresAtMs,
      };
    } catch (error) {
      emitServerDiagnostic(undefined, {
        correlationId,
        timestamp: new Date().toISOString(),
        operation: "mcp.connection",
        source: "mcp.authorization.start",
        errorClass: contentFreeErrorClass(error),
        message: "runtime-turn-failed",
        code: "stage=mcp-authorization",
      });
      this.settle(attempt, "failed");
      return { outcome: "refused", reason: "failed" };
    }
  }
  private pruneAttempts(name: string): void {
    for (const attempt of this.#attempts.values()) {
      if (attempt.server === name) this.settle(attempt, "cancelled");
      if (attempt.state !== "pending") this.#attempts.delete(attempt.id);
    }
  }
  private async createAttempt(
    server: McpServerDefinition,
    session: string,
    current: () => boolean,
    correlationId: string,
  ): Promise<Attempt> {
    const generation = this.options.settings.generation(server, correlationId);
    const controller = new AbortController();
    const listener = createServer((req, res) => {
      void this.callback(attempt, req, res);
    });
    remote(server);
    const signal = AbortSignal.any([generation, controller.signal, this.#lifetime.signal]);
    const expiresAtMs = Date.now() + 300_000;
    const admitted = (): boolean => current() && !signal.aborted && Date.now() < expiresAtMs;
    const staged = stagedPersistence(this.options, server);
    const client = createMcpOAuthClient({
      url: server.transport.url,
      oauth: server.transport.oauth,
      persistence: staged,
      beforeEffect: admitted,
      fetch: oauthFetch(this.options, server, signal, admitted),
    });
    const attempt: Attempt = {
      correlationId,
      stateToken: randomBytes(32).toString("hex"),
      id: `con_${randomBytes(24).toString("hex")}`,
      server: server.name,
      session,
      current,
      controller,
      generation,
      generationAbort: (): void => {
        if (!attempt.claimed) this.settle(attempt, "cancelled");
      },
      listener,
      client,
      commit: staged.commit,
      expiresAtMs,
      state: "pending",
      claimed: false,
    };
    await this.armAttempt(attempt);
    return attempt;
  }
  private async armAttempt(attempt: Attempt): Promise<void> {
    const listener = attempt.listener;
    listener.headersTimeout = 5000;
    listener.requestTimeout = 10_000;
    listener.maxConnections = 4;
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", resolve);
    });
    attempt.timer = setTimeout(() => {
      this.settle(attempt, "expired");
    }, 300_000);
    attempt.timer.unref();
    attempt.generation.addEventListener("abort", attempt.generationAbort, { once: true });
  }
  status(name: string, session: string, id: string): State | "unavailable" {
    const attempt = this.#attempts.get(id);
    if (attempt?.server !== name || attempt.session !== session) return "unavailable";
    if (attempt.state === "pending" && Date.now() >= attempt.expiresAtMs)
      this.settle(attempt, "expired");
    else if (attempt.state === "pending" && !this.active(attempt))
      this.settle(attempt, "cancelled");
    return attempt.state;
  }
  cancel(name: string, session: string, id: string): void {
    const attempt = this.#attempts.get(id);
    if (attempt?.server === name && attempt.session === session) this.settle(attempt, "cancelled");
  }
  revoke(name: string, correlationId: string): void {
    const server = this.server(name, correlationId);
    persistence(this.options, server).clear();
    this.options.settings.revoke(name, correlationId);
    recordMcpAuthorization(this.options.log, correlationId, "mcp-credential-revocation", "revoked");
  }
  async close(): Promise<void> {
    this.#lifetime.abort();
    for (const attempt of this.#attempts.values()) this.settle(attempt, "cancelled");
    await Promise.all(
      [...this.#attempts.values()].map(
        (attempt) =>
          new Promise<void>((resolve) => {
            attempt.listener.closeAllConnections();
            attempt.listener.close(() => {
              resolve();
            });
          }),
      ),
    );
    this.#attempts.clear();
    this.#clients.clear();
  }
}
export function createMcpAuthorization(options: Options): McpAuthorization {
  return new AuthorizationOwner(options);
}
