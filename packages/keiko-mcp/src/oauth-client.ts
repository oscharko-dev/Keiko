import {
  auth,
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  refreshAuthorization,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
  type AuthorizationServerMetadata,
} from "@modelcontextprotocol/client";
import type { McpRemoteOAuth } from "@oscharko-dev/keiko-contracts/runtime/mcp-servers";
import { ManagedMcpError } from "./definitions.js";

export interface McpOAuthPersistence {
  readonly read: () => Readonly<Record<string, unknown>> | undefined;
  readonly write: (state: Readonly<Record<string, unknown>>) => void;
}
export interface McpOAuthClientOptions {
  readonly url: string;
  readonly oauth: McpRemoteOAuth;
  readonly persistence: McpOAuthPersistence;
  readonly fetch: typeof globalThis.fetch;
  readonly beforeEffect: () => boolean;
}
export interface McpOAuthClient {
  readonly credentials: () => readonly string[];
  readonly authorized: () => boolean;
  readonly start: (redirectUrl: string, state: string) => Promise<string>;
  readonly complete: (code: string, issuer: string | undefined) => Promise<void>;
  /** Refresh before dispatch; a resource response never causes an automatic tool replay. */
  readonly token: () => Promise<string>;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function secureOAuthEndpoint(url: URL): boolean {
  return url.protocol === "https:" && url.username === "" && url.password === "" && url.hash === "";
}
function metadataEndpoints(metadata: AuthorizationServerMetadata): boolean {
  return [
    metadata.authorization_endpoint,
    metadata.token_endpoint,
    metadata.registration_endpoint,
  ].every(
    (endpoint) =>
      endpoint === undefined || (URL.canParse(endpoint) && secureOAuthEndpoint(new URL(endpoint))),
  );
}
function restoredTokens(value: unknown, issuer: string): StoredOAuthTokens | undefined {
  if (
    !object(value) ||
    value.issuer !== issuer ||
    typeof value.access_token !== "string" ||
    value.access_token.length === 0 ||
    value.access_token.length > 8192 ||
    value.token_type !== "Bearer" ||
    (value.refresh_token !== undefined && typeof value.refresh_token !== "string")
  )
    return undefined;
  return value as StoredOAuthTokens;
}

function requestedScopes(scope: string | undefined): string[] {
  return scope?.split(/\s+/u) ?? [];
}
function requestedMetadata(
  metadata: AuthorizationServerMetadata,
  scope: string | undefined,
): AuthorizationServerMetadata {
  const requested = new Set(requestedScopes(scope));
  return {
    ...metadata,
    scopes_supported: (metadata.scopes_supported ?? []).filter(
      (value) => value !== "offline_access" || requested.has(value),
    ),
  };
}
class OAuthSession implements OAuthClientProvider {
  redirectUrl: string | undefined;
  #verifier: string | undefined;
  #state: string | undefined;
  #authorizationUrl: string | undefined;
  #discovery: OAuthDiscoveryState | undefined;
  #tokens: StoredOAuthTokens | undefined;
  #client: StoredOAuthClientInformation | undefined;
  #expiresAt = 0;
  #refresh: Promise<string> | undefined;
  constructor(private readonly options: McpOAuthClientOptions) {
    const saved = options.persistence.read();
    this.#tokens = restoredTokens(saved?.tokens, options.oauth.issuer);
    if (typeof saved?.expiresAt === "number" && Number.isFinite(saved.expiresAt))
      this.#expiresAt = saved.expiresAt;
    const client = saved?.client;
    if (
      object(client) &&
      client.issuer === options.oauth.issuer &&
      typeof client.client_id === "string"
    )
      this.#client = client as StoredOAuthClientInformation;
  }
  get clientMetadata(): OAuthClientProvider["clientMetadata"] {
    return {
      client_name: "Keiko",
      redirect_uris: this.redirectUrl === undefined ? [] : [this.redirectUrl],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      ...(this.options.oauth.scope === undefined ? {} : { scope: this.options.oauth.scope }),
    };
  }
  state(): string {
    if (this.#state === undefined) throw new ManagedMcpError("not-admitted");
    return this.#state;
  }
  clientInformation(): StoredOAuthClientInformation | undefined {
    return this.options.oauth.clientId === undefined
      ? this.#client
      : {
          client_id: this.options.oauth.clientId,
          issuer: this.options.oauth.issuer,
        };
  }
  saveClientInformation(client: StoredOAuthClientInformation): void {
    this.checkIssuer(client.issuer);
    if (client.client_secret !== undefined) throw new ManagedMcpError("not-admitted");
    this.#client = client;
  }
  tokens(): StoredOAuthTokens | undefined {
    return this.#tokens;
  }
  saveTokens(tokens: StoredOAuthTokens): void {
    this.checkIssuer(tokens.issuer);
    if (tokens.token_type.toLowerCase() !== "bearer") throw new ManagedMcpError("not-admitted");
    const requested = new Set(requestedScopes(this.options.oauth.scope));
    if (tokens.scope?.split(/\s+/u).some((scope) => !requested.has(scope)))
      throw new ManagedMcpError("not-admitted");
    this.requireCurrent();
    this.#tokens = { ...tokens, token_type: "Bearer" };
    this.#expiresAt = tokens.expires_in === undefined ? 0 : Date.now() + tokens.expires_in * 1000;
    this.options.persistence.write({
      tokens: this.#tokens,
      client: this.#client,
      expiresAt: this.#expiresAt,
    });
  }
  saveCodeVerifier(verifier: string): void {
    this.#verifier = verifier;
  }
  codeVerifier(): string {
    if (this.#verifier === undefined) throw new ManagedMcpError("not-admitted");
    return this.#verifier;
  }
  redirectToAuthorization(url: URL): void {
    if (this.redirectUrl === undefined) throw new ManagedMcpError("not-admitted");
    const expected = this.authorizationEndpoint();
    if (
      url.origin !== expected.origin ||
      url.pathname !== expected.pathname ||
      url.searchParams.get("state") !== this.state() ||
      url.searchParams.get("redirect_uri") !== this.redirectUrl ||
      url.searchParams.get("resource") !== this.options.url
    )
      throw new ManagedMcpError("not-admitted");
    this.#authorizationUrl = url.href;
  }
  private authorizationEndpoint(): URL {
    const endpoint = this.#discovery?.authorizationServerMetadata?.authorization_endpoint;
    if (endpoint === undefined) throw new ManagedMcpError("not-admitted");
    const expected = new URL(endpoint);
    if (!secureOAuthEndpoint(expected)) throw new ManagedMcpError("not-admitted");
    return expected;
  }
  discoveryState(): OAuthDiscoveryState | undefined {
    return this.#discovery;
  }
  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.checkIssuer(state.authorizationServerUrl);
    this.#discovery = state;
  }
  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "all" || scope === "tokens") this.#tokens = undefined;
    if (scope === "all" || scope === "client") this.#client = undefined;
    if (scope === "all" || scope === "verifier") this.#verifier = undefined;
    if (scope === "all" || scope === "discovery") this.#discovery = undefined;
  }
  authorized(): boolean {
    return this.#tokens !== undefined;
  }
  credentials(): readonly string[] {
    return [this.#tokens?.access_token, this.#tokens?.refresh_token].filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
  }
  private requireCurrent(): void {
    if (!this.options.beforeEffect()) throw new ManagedMcpError("not-admitted");
  }
  private checkIssuer(issuer: string | undefined): void {
    if (issuer !== this.options.oauth.issuer) throw new ManagedMcpError("not-admitted");
  }
  private async discover(): Promise<void> {
    if (this.#discovery !== undefined) return;
    this.requireCurrent();
    const resource = await discoverOAuthProtectedResourceMetadata(
      this.options.url,
      {},
      this.options.fetch,
    );
    if (
      resource.resource !== this.options.url ||
      !resource.authorization_servers?.includes(this.options.oauth.issuer)
    )
      throw new ManagedMcpError("not-admitted");
    const metadata = await discoverAuthorizationServerMetadata(this.options.oauth.issuer, {
      fetchFn: this.options.fetch,
    });
    if (
      metadata?.issuer !== this.options.oauth.issuer ||
      !metadata.code_challenge_methods_supported?.includes("S256")
    )
      throw new ManagedMcpError("not-admitted");
    if (!metadataEndpoints(metadata)) throw new ManagedMcpError("not-admitted");
    this.#discovery = {
      authorizationServerUrl: this.options.oauth.issuer,
      // Constrain the SDK's default scope selection to the operator's explicit grant.
      authorizationServerMetadata: requestedMetadata(metadata, this.options.oauth.scope),
      resourceMetadata: {
        ...resource,
        scopes_supported: requestedScopes(this.options.oauth.scope),
      },
    };
  }
  private async run(code?: string, issuer?: string): Promise<"AUTHORIZED" | "REDIRECT"> {
    await this.discover();
    this.requireCurrent();
    return auth(this, {
      serverUrl: this.options.url,
      fetchFn: this.options.fetch,
      ...(code === undefined ? {} : { authorizationCode: code }),
      ...(issuer === undefined ? {} : { iss: issuer }),
      ...(this.options.oauth.scope === undefined ? {} : { scope: this.options.oauth.scope }),
    });
  }
  async start(redirectUrl: string, state: string): Promise<string> {
    this.redirectUrl = redirectUrl;
    this.#state = state;
    this.#authorizationUrl = undefined;
    this.#tokens = undefined;
    if (this.options.oauth.clientId === undefined) this.#client = undefined;
    const outcome = await this.run();
    const authorizationUrl = this.authorizationUrl();
    if (outcome !== "REDIRECT") throw new ManagedMcpError("not-admitted");
    return authorizationUrl;
  }
  private authorizationUrl(): string {
    if (this.#authorizationUrl === undefined) throw new ManagedMcpError("not-admitted");
    return this.#authorizationUrl;
  }
  async complete(code: string, issuer: string | undefined): Promise<void> {
    try {
      if ((await this.run(code, issuer)) !== "AUTHORIZED")
        throw new ManagedMcpError("not-admitted");
    } finally {
      this.#verifier = undefined;
      this.#state = undefined;
      this.redirectUrl = undefined;
    }
  }
  async token(): Promise<string> {
    this.requireCurrent();
    if (this.#tokens === undefined) throw new ManagedMcpError("not-admitted");
    if (this.#expiresAt === 0 || this.#expiresAt > Date.now() + 30_000)
      return this.#tokens.access_token;
    this.#refresh ??= this.refresh().finally(() => {
      this.#refresh = undefined;
    });
    return this.#refresh;
  }
  private async refresh(): Promise<string> {
    await this.discover();
    const refreshToken = this.#tokens?.refresh_token;
    const clientInformation = this.clientInformation();
    const metadata = this.#discovery?.authorizationServerMetadata;
    if (refreshToken === undefined || clientInformation === undefined || metadata === undefined)
      throw new ManagedMcpError("not-admitted");
    this.requireCurrent();
    const tokens = await refreshAuthorization(this.options.oauth.issuer, {
      metadata,
      clientInformation,
      refreshToken,
      resource: this.options.url,
      fetchFn: this.options.fetch,
    });
    this.saveTokens({ ...tokens, issuer: this.options.oauth.issuer });
    return tokens.access_token;
  }
}

/** The SDK owns OAuth; custody, target admission and authorization stay in server composition. */
export function createMcpOAuthClient(options: McpOAuthClientOptions): McpOAuthClient {
  return new OAuthSession(options);
}
