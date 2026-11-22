import type { IncomingMessage, ServerResponse } from "node:http";
import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import {
  gatewayFetch,
  type OutboundHttpEgressConfig,
} from "@oscharko-dev/keiko-model-gateway/internal/http";
import {
  RelayCapabilityStore,
  relayCredentialSpellings,
  type RelayAdmission,
  type RelayBinding,
} from "../relay/relayCapabilityStore.js";
import {
  recordRepositoryRelay,
  upstreamStatusClass,
  type RepositoryRelayLine,
  type RepositoryRelayMethod,
  type RepositoryRelayReason,
} from "./repositoryRelayActivity.js";
import { admitRepositoryPath, type RepositoryPathAdmission } from "./repositoryRelayPaths.js";
import {
  credentialByteForms,
  pipeBinaryBody,
  readBoundedBody,
  refuseCredentialEcho,
  refuseCredentialInHeader,
  RelayRefusal,
  rewritePackument,
  type ResponseBudget,
} from "./repositoryRelayResponse.js";
import {
  admitRepositoryUrl,
  isOwnServerOrigin,
  REPOSITORY_SECRET_MIN_CHARS,
  type RepositoryCredential,
  type RepositoryEcosystem,
} from "./repositoryRelayTargets.js";

/**
 * Repository credentials of a native coding run, kept out of the run (#4522). A run builds a Maven
 * or npm project whose dependencies live in an authenticated internal repository; its build
 * settings carry no `<server>` and no token, so it cannot reach that repository itself. Its binding
 * points the build tool at this relay on Keiko's attested loopback origin instead, with a
 * capability minted for the one run and the one repository. The relay authenticates the capability,
 * adds the repository credential, forwards the read through Keiko's egress and streams the answer
 * back. A leaked capability reaches only that repository for that run's lifetime, through Keiko, and
 * only for reads; the credential itself cannot leave Keiko through the run, because a response that
 * spells it is refused before the run receives the bytes that do.
 *
 * Generalised from the MCP relay (`mcp/mcpCredentialRelay.ts`, #3903 AC3); the capability store is
 * shared (`relay/relayCapabilityStore.ts`).
 */
export const REPOSITORY_RELAY_ROUTE = "/api/coding-sidecar/repository/:relayId/*path";
export const REPOSITORY_RELAY_PATH_PREFIX = "/api/coding-sidecar/repository/";
export const REPOSITORY_RELAY_CHALLENGE_REALM = "keiko-repository-relay";
/** The most one response may carry; a real Maven or npm artifact is far below it. */
export const REPOSITORY_RELAY_RESPONSE_MAX_BYTES = 1024 * 1024 * 1024;
/** A text file (a POM, metadata, a packument) is read whole before it is written. */
export const REPOSITORY_RELAY_TEXT_MAX_BYTES = 64 * 1024 * 1024;
/** Requests one binding (one run, one repository) may make: a build fetches thousands of files. */
export const REPOSITORY_RELAY_BINDING_MAX_REQUESTS = 200_000;
/** Bytes one binding may receive in total. */
export const REPOSITORY_RELAY_BINDING_MAX_BYTES = 32 * 1024 * 1024 * 1024;
export const REPOSITORY_RELAY_MAX_REDIRECTS = 3;
export const REPOSITORY_RELAY_UPSTREAM_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_BINDINGS = 256;
const BEARER_TOKEN = /^[\x21-\x7E]+$/u;
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const FORWARDED_RESPONSE_HEADERS = ["content-type", "content-length", "etag", "last-modified"];
const FORWARDED_REQUEST_HEADERS = ["accept", "if-none-match", "if-modified-since"] as const;

/** The base URL a build tool is pointed at; the run's capability is a separate credential. */
export function repositoryRelayBaseUrl(origin: string, relayId: string): string {
  return `${origin.replace(/\/+$/u, "")}${REPOSITORY_RELAY_PATH_PREFIX}${relayId}/`;
}

export interface RepositoryRelayTarget {
  readonly runId: string;
  readonly ecosystem: RepositoryEcosystem;
  readonly upstreamBaseUrl: string;
  /** Absent for an anonymous repository, which the relay still serves for the run. */
  readonly credential?: RepositoryCredential | undefined;
  /** Further secret values the relay must never let reach the run; held only by the relay. */
  readonly secrets: readonly string[];
  readonly signal?: AbortSignal | undefined;
  /** Keiko's own server origin; never a target, directly or through a redirect. */
  readonly ownOrigin?: string | undefined;
  /** A managed transport for the repository; the production egress when absent. */
  readonly upstream?: RepositoryRelayUpstream | undefined;
}

export interface RepositoryRelayBinding extends RelayBinding {
  /** Presented by the run as the Basic password, or as the Bearer token. */
  readonly capability: string;
}

interface RelayStats {
  requests: number;
  relayed: number;
  refused: number;
  failed: number;
  cancelled: number;
  clientErrors: number;
  serverErrors: number;
  redirects: number;
  responseBytes: number;
  upstreamRejectionLogged: boolean;
}

/** A target as the relay holds it: validated, with the credential material derived once. */
export interface RepositoryRelayBoundTarget extends RepositoryRelayTarget {
  /** The normalised upstream base URL with its trailing slash. */
  readonly baseUrl: string;
  readonly authorization: string | undefined;
  readonly credentialForms: readonly string[];
  readonly credentialByteForms: readonly Buffer[];
  readonly boundAtMs: number;
  readonly stats: RelayStats;
}

export type RepositoryRelayAdmission = RelayAdmission<RepositoryRelayBoundTarget>;

export interface RepositoryCredentialRelay {
  /** A capability for one run and one repository; `undefined` when the target is refused. */
  bind(target: RepositoryRelayTarget): RepositoryRelayBinding | undefined;
  authenticate(
    relayId: string,
    capability: string | undefined,
  ): RepositoryRelayAdmission | undefined;
  /** Whether this exact capability once belonged to a binding that was revoked. */
  wasRevoked(relayId: string, capability: string | undefined): boolean;
  /** Revokes every binding of the run and records one settled summary for each. */
  releaseRun(runId: string): void;
}

export interface RepositoryRelayUpstreamRequest {
  readonly method: RepositoryRelayMethod;
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  /** Loopback ports no request may reach, whatever the host name: Keiko's own. */
  readonly deniedLoopbackPorts: readonly number[];
}

export type RepositoryRelayUpstream = (
  url: string,
  request: RepositoryRelayUpstreamRequest,
) => Promise<Response>;

/**
 * The production upstream: Keiko's egress with its proxy and CA configuration. A repository is
 * configured by the person, so loopback and private-network targets are allowed (metadata and
 * link-local addresses stay refused), unlike a remote MCP server; Keiko's own port is not.
 */
export function egressRepositoryRelayUpstream(
  egress: () => OutboundHttpEgressConfig | undefined,
): RepositoryRelayUpstream {
  return (url, request) =>
    gatewayFetch(url, {
      method: request.method,
      headers: request.headers,
      egress: {
        ...egress(),
        allowPrivateNetwork: true,
        pinProxiedConnectTarget: true,
        deniedLoopbackPorts: request.deniedLoopbackPorts,
      },
      maxResponseBytes: REPOSITORY_RELAY_RESPONSE_MAX_BYTES,
      timeoutMs: REPOSITORY_RELAY_UPSTREAM_TIMEOUT_MS,
      signal: request.signal,
    });
}

// ─── binding ───────────────────────────────────────────────────────────────────────────────────

interface BindingRefusal {
  readonly refused: RepositoryRelayReason;
}

// A Basic user name has no control character and no colon, which separates it from the password.
function isBasicUsername(value: string): boolean {
  if (value.length < 1 || value.length > 256 || value.includes(":")) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

function credentialRefusal(
  credential: RepositoryCredential | undefined,
): RepositoryRelayReason | undefined {
  if (credential === undefined) return undefined;
  if (credential.kind === "bearer") {
    if (!BEARER_TOKEN.test(credential.token)) return "secret-invalid";
    return credential.token.length < REPOSITORY_SECRET_MIN_CHARS ? "secret-too-short" : undefined;
  }
  if (!isBasicUsername(credential.username)) return "secret-invalid";
  return credential.password.length < REPOSITORY_SECRET_MIN_CHARS ? "secret-too-short" : undefined;
}

function authorizationFor(credential: RepositoryCredential | undefined): string | undefined {
  if (credential === undefined) return undefined;
  if (credential.kind === "bearer") return `Bearer ${credential.token}`;
  return `Basic ${Buffer.from(`${credential.username}:${credential.password}`, "utf8").toString("base64")}`;
}

function credentialValues(target: RepositoryRelayTarget): readonly string[] {
  const credential = target.credential;
  const own =
    credential === undefined
      ? []
      : credential.kind === "bearer"
        ? [credential.token]
        : [credential.password, `${credential.username}:${credential.password}`];
  return [...own, ...target.secrets];
}

function boundTarget(
  target: RepositoryRelayTarget,
  now: number,
): RepositoryRelayBoundTarget | BindingRefusal {
  const url = admitRepositoryUrl(target.upstreamBaseUrl, target.ownOrigin);
  if (!url.ok) return { refused: url.reason };
  const refusal =
    credentialRefusal(target.credential) ??
    (target.secrets.some((secret) => secret.length < REPOSITORY_SECRET_MIN_CHARS)
      ? "secret-too-short"
      : undefined);
  if (refusal !== undefined) return { refused: refusal };
  const forms = relayCredentialSpellings(credentialValues(target));
  return {
    ...target,
    secrets: Object.freeze([...target.secrets]),
    baseUrl: url.url.href,
    authorization: authorizationFor(target.credential),
    credentialForms: forms,
    credentialByteForms: credentialByteForms(forms),
    boundAtMs: now,
    stats: {
      requests: 0,
      relayed: 0,
      refused: 0,
      failed: 0,
      cancelled: 0,
      clientErrors: 0,
      serverErrors: 0,
      redirects: 0,
      responseBytes: 0,
      upstreamRejectionLogged: false,
    },
  };
}

export interface RepositoryRelayOptions {
  /** Resolved when a line is written, so a sink installed after startup is still used. */
  readonly activityLog: () => ServerLogSink | undefined;
  readonly nowMs?: (() => number) | undefined;
}

class InMemoryRepositoryCredentialRelay implements RepositoryCredentialRelay {
  private readonly now: () => number;
  private readonly store = new RelayCapabilityStore<RepositoryRelayBoundTarget>({
    maxBindings: MAX_BINDINGS,
    freeze: (target): RepositoryRelayBoundTarget => Object.freeze({ ...target }),
    onRevoke: (target): void => {
      this.settle(target);
    },
  });

  public constructor(private readonly options: RepositoryRelayOptions) {
    this.now = options.nowMs ?? Date.now;
  }

  private record(runId: string, line: RepositoryRelayLine): void {
    recordRepositoryRelay(this.options.activityLog(), runId, line);
  }

  private settle(target: RepositoryRelayBoundTarget): void {
    const { stats } = target;
    this.record(target.runId, {
      action: "release",
      outcome: "settled",
      ecosystem: target.ecosystem,
      requestCount: stats.requests,
      relayedCount: stats.relayed,
      refusedCount: stats.refused,
      failedCount: stats.failed,
      cancelledCount: stats.cancelled,
      upstreamClientErrorCount: stats.clientErrors,
      upstreamServerErrorCount: stats.serverErrors,
      redirectCount: stats.redirects,
      responseBytes: stats.responseBytes,
      durationMs: Math.max(0, this.now() - target.boundAtMs),
    });
  }

  public bind(target: RepositoryRelayTarget): RepositoryRelayBinding | undefined {
    const bound = boundTarget(target, this.now());
    const refused = "refused" in bound ? bound.refused : undefined;
    const binding =
      refused === undefined ? this.store.bind(bound as RepositoryRelayBoundTarget) : undefined;
    const reason = refused ?? (binding === undefined ? this.unboundReason(target) : undefined);
    this.record(target.runId, {
      action: "bind",
      outcome: reason === undefined ? "bound" : "refused",
      ...(reason === undefined ? {} : { reason }),
      ecosystem: target.ecosystem,
      credentialKind: target.credential?.kind ?? "none",
    });
    return binding;
  }

  private unboundReason(target: RepositoryRelayTarget): RepositoryRelayReason {
    return target.signal?.aborted === true ? "run-aborted" : "bindings-exhausted";
  }

  public authenticate(
    relayId: string,
    capability: string | undefined,
  ): RepositoryRelayAdmission | undefined {
    return this.store.authenticate(relayId, capability);
  }

  public wasRevoked(relayId: string, capability: string | undefined): boolean {
    return this.store.wasRevoked(relayId, capability);
  }

  public releaseRun(runId: string): void {
    this.store.releaseRun(runId);
  }
}

export function createRepositoryCredentialRelay(
  options: RepositoryRelayOptions,
): RepositoryCredentialRelay {
  return new InMemoryRepositoryCredentialRelay(options);
}

// ─── the exchange ──────────────────────────────────────────────────────────────────────────────

export interface RepositoryRelayServeOptions {
  readonly relay: RepositoryCredentialRelay | undefined;
  readonly upstream: RepositoryRelayUpstream;
  readonly activityLog: ServerLogSink | undefined;
  /** The request's own correlation, for a request no run's capability accounts for. */
  readonly correlationId: string;
  readonly nowMs?: (() => number) | undefined;
  /** Narrower response bounds than the defaults; production leaves them unset. */
  readonly limits?: RepositoryRelayLimits | undefined;
}

export interface RepositoryRelayLimits {
  readonly responseMaxBytes?: number | undefined;
  readonly textMaxBytes?: number | undefined;
}

const STATUS_OF: Readonly<Record<RepositoryRelayReason, number>> = {
  "origin-not-allowed": 403,
  "capability-missing": 401,
  "capability-invalid": 401,
  "binding-revoked": 401,
  "method-not-allowed": 405,
  "query-refused": 400,
  "path-invalid": 400,
  "path-too-long": 414,
  "path-unsupported": 404,
  "budget-exhausted": 429,
  "redirect-refused": 502,
  "response-too-large": 502,
  "upstream-failed": 502,
  "upstream-rejected": 502,
  "content-encoding-refused": 502,
  "packument-invalid": 502,
  "credential-in-response": 502,
  "credential-in-response-header": 502,
  "credential-spelling-unbounded": 502,
  "url-unsupported": 400,
  "url-userinfo": 400,
  "url-own-origin": 400,
  "secret-invalid": 400,
  "secret-too-short": 400,
  "bindings-exhausted": 503,
  "run-aborted": 409,
  "relay-unavailable": 503,
};

// A credential found in a response, or one the upstream refused, is a security or setup incident,
// not an ordinary refusal: it opens a failure incident instead of a warning.
const INCIDENT_REASONS: ReadonlySet<RepositoryRelayReason> = new Set([
  "credential-in-response",
  "credential-in-response-header",
  "credential-spelling-unbounded",
  "upstream-rejected",
]);

function refusal(reason: RepositoryRelayReason): RelayRefusal {
  return new RelayRefusal(STATUS_OF[reason], reason);
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** The capability a run presents: the Basic password (Maven) or the Bearer token (npm). */
export function presentedCapability(request: IncomingMessage): string | undefined {
  const authorization = headerValue(request, "authorization");
  if (authorization === undefined) return undefined;
  if (authorization.startsWith("Bearer ")) return authorization.slice("Bearer ".length).trim();
  if (!authorization.startsWith("Basic ")) return undefined;
  const decoded = Buffer.from(authorization.slice("Basic ".length).trim(), "base64").toString(
    "utf8",
  );
  const separator = decoded.indexOf(":");
  return separator < 0 ? undefined : decoded.slice(separator + 1);
}

function admittedExchange(
  request: IncomingMessage,
  relayId: string,
  options: RepositoryRelayServeOptions,
): RepositoryRelayAdmission {
  if (request.headers.origin !== undefined) throw refusal("origin-not-allowed");
  const capability = presentedCapability(request);
  const admission = options.relay?.authenticate(relayId, capability);
  if (admission !== undefined) return admission;
  // A client that sent no credential yet is challenged, as Maven expects before it sends one.
  if (headerValue(request, "authorization") === undefined) throw refusal("capability-missing");
  throw refusal(
    options.relay?.wasRevoked(relayId, capability) === true
      ? "binding-revoked"
      : "capability-invalid",
  );
}

function requestMethod(request: IncomingMessage): RepositoryRelayMethod {
  if (request.method === "GET" || request.method === "HEAD") return request.method;
  throw refusal("method-not-allowed");
}

/** The path after this binding's prefix, exactly as sent; the query is refused, not stripped. */
function admittedPath(
  request: IncomingMessage,
  relayId: string,
  ecosystem: RepositoryEcosystem,
): RepositoryPathAdmission & { readonly ok: true } {
  const raw = request.url ?? "";
  if (raw.includes("?")) throw refusal("query-refused");
  const prefix = `${REPOSITORY_RELAY_PATH_PREFIX}${relayId}/`;
  if (!raw.startsWith(prefix)) throw refusal("path-invalid");
  const admitted = admitRepositoryPath(ecosystem, raw.slice(prefix.length));
  if (!admitted.ok) throw refusal(admitted.reason);
  return admitted;
}

function chargeBudget(stats: RelayStats): ResponseBudget["charge"] {
  return (bytes) => {
    stats.responseBytes += bytes;
    if (stats.responseBytes > REPOSITORY_RELAY_BINDING_MAX_BYTES) throw refusal("budget-exhausted");
  };
}

function upstreamHeaders(request: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {
    "accept-encoding": "identity",
    "user-agent": "keiko-repository-relay",
  };
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = headerValue(request, name);
    if (value !== undefined) headers[name] = value;
  }
  return headers;
}

function ownPorts(ownOrigin: string | undefined): readonly number[] {
  if (ownOrigin === undefined || !URL.canParse(ownOrigin)) return [];
  const port = Number(new URL(ownOrigin).port);
  return Number.isInteger(port) && port > 0 ? [port] : [];
}

// A redirect target: http(s) only, no user info, never Keiko's own server; across origins only to
// https and without the credential, so the credential never reaches a host the person did not name.
function nextHop(
  location: string | null,
  current: URL,
  target: RepositoryRelayBoundTarget,
): { readonly url: URL; readonly credential: boolean } {
  const next = redirectTarget(location, current);
  const web = next.protocol === "http:" || next.protocol === "https:";
  const forbidden =
    !web ||
    next.username !== "" ||
    next.password !== "" ||
    isOwnServerOrigin(next, target.ownOrigin);
  const sameOrigin = next.origin === new URL(target.baseUrl).origin;
  if (forbidden || (!sameOrigin && next.protocol !== "https:")) throw refusal("redirect-refused");
  return { url: next, credential: sameOrigin };
}

function redirectTarget(location: string | null, current: URL): URL {
  if (location === null) throw refusal("redirect-refused");
  try {
    return new URL(location, current);
  } catch {
    // An unparsable Location is the closed refusal `redirect-refused`, recorded by the caller.
    throw refusal("redirect-refused");
  }
}

async function fetchUpstream(
  request: IncomingMessage,
  method: RepositoryRelayMethod,
  first: URL,
  admission: RepositoryRelayAdmission,
  options: RepositoryRelayServeOptions,
  signal: AbortSignal,
): Promise<Response> {
  const { target } = admission;
  const send = target.upstream ?? options.upstream;
  const base = upstreamHeaders(request);
  let url = first;
  let credential = true;
  for (let hop = 0; ; hop += 1) {
    const headers =
      credential && target.authorization !== undefined
        ? { ...base, authorization: target.authorization }
        : base;
    const upstream = await send(url.href, {
      method,
      headers,
      signal,
      deniedLoopbackPorts: ownPorts(target.ownOrigin),
    });
    if (!REDIRECT_STATUSES.has(upstream.status)) return upstream;
    await upstream.body?.cancel();
    if (hop >= REPOSITORY_RELAY_MAX_REDIRECTS) throw refusal("redirect-refused");
    target.stats.redirects += 1;
    ({ url, credential } = nextHop(upstream.headers.get("location"), url, target));
  }
}

function forwardedHeaders(
  upstream: Response,
  target: RepositoryRelayBoundTarget,
  omit: readonly string[],
): Record<string, string> {
  const headers: Record<string, string> = {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  };
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value === null || omit.includes(name)) continue;
    refuseCredentialInHeader(value, target.credentialForms, target.credentialByteForms);
    headers[name] = value;
  }
  return headers;
}

interface ExchangeState {
  correlationId: string;
  ecosystem?: RepositoryEcosystem;
  method?: RepositoryRelayMethod;
  upstreamStatus?: number;
  signal?: AbortSignal;
  admission?: RepositoryRelayAdmission;
}

function relayBaseFor(request: IncomingMessage, relayId: string): string {
  const host = headerValue(request, "host") ?? "127.0.0.1";
  return repositoryRelayBaseUrl(`http://${host}`, relayId);
}

async function relayBody(
  upstream: Response,
  response: ServerResponse,
  context: {
    readonly request: IncomingMessage;
    readonly relayId: string;
    readonly method: RepositoryRelayMethod;
    readonly path: RepositoryPathAdmission & { readonly ok: true };
    readonly target: RepositoryRelayBoundTarget;
    readonly limits: RepositoryRelayLimits | undefined;
  },
): Promise<void> {
  const { target, path } = context;
  await refuseNonIdentityEncoding(upstream);
  const buffered = path.kind !== "maven-binary" && path.kind !== "npm-tarball";
  const headers = forwardedHeaders(upstream, target, buffered ? ["content-length"] : []);
  if (context.method === "HEAD") {
    await upstream.body?.cancel();
    response.writeHead(upstream.status, headers);
  } else if (buffered) {
    await relayText(upstream, response, context, headers);
  } else {
    response.writeHead(upstream.status, headers);
    await pipeBinaryBody(upstream, response, target.credentialByteForms, responseBudget(context));
  }
}

function responseBudget(context: {
  readonly target: RepositoryRelayBoundTarget;
  readonly limits: RepositoryRelayLimits | undefined;
}): ResponseBudget {
  return {
    responseMaxBytes: context.limits?.responseMaxBytes ?? REPOSITORY_RELAY_RESPONSE_MAX_BYTES,
    charge: chargeBudget(context.target.stats),
  };
}

// The relay scans what it forwards, which it cannot do for a compressed body.
async function refuseNonIdentityEncoding(upstream: Response): Promise<void> {
  const encoding = upstream.headers.get("content-encoding");
  if (encoding === null || encoding.toLowerCase() === "identity") return;
  await upstream.body?.cancel();
  throw refusal("content-encoding-refused");
}

// A text file is read whole, scanned for a credential, and a packument has its tarball URLs moved
// onto the relay; only then is anything written to the run.
async function relayText(
  upstream: Response,
  response: ServerResponse,
  context: Parameters<typeof relayBody>[2],
  headers: Record<string, string>,
): Promise<void> {
  const { target, path } = context;
  let body = await readBoundedBody(
    upstream,
    context.limits?.textMaxBytes ?? REPOSITORY_RELAY_TEXT_MAX_BYTES,
    responseBudget(context),
  );
  refuseCredentialEcho(body, target.credentialForms, target.credentialByteForms);
  if (path.kind === "npm-packument")
    body = rewritePackument(
      body,
      target.baseUrl,
      relayBaseFor(context.request, context.relayId),
    ).body;
  response.writeHead(upstream.status, { ...headers, "content-length": String(body.length) });
  response.write(body);
}

function emptyAnswer(response: ServerResponse, status: number, upstream: Response): void {
  const headers: Record<string, string> = { "cache-control": "no-store", "content-length": "0" };
  for (const name of ["etag", "last-modified"]) {
    const value = upstream.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  response.writeHead(status, headers);
}

function noteUpstreamStatus(status: number, stats: RelayStats): "denied" | "ok" | "unusable" {
  if (status >= 500) stats.serverErrors += 1;
  else if (status >= 400) stats.clientErrors += 1;
  if (status === 401 || status === 403) return "denied";
  return isRelayableStatus(status) ? "ok" : "unusable";
}

// A success, a not-modified, and an upstream error status the run is told as it is; a proxy
// challenge (407) or any other status is the relay's own failure to reach a repository.
function isRelayableStatus(status: number): boolean {
  return status === 304 || (status >= 200 && status < 300) || (status >= 400 && status !== 407);
}

async function exchange(
  request: IncomingMessage,
  response: ServerResponse,
  admission: RepositoryRelayAdmission,
  method: RepositoryRelayMethod,
  path: RepositoryPathAdmission & { readonly ok: true },
  relayId: string,
  options: RepositoryRelayServeOptions,
  state: ExchangeState,
): Promise<"denied" | "ok"> {
  const { target } = admission;
  const signal = state.signal ?? admission.signal;
  if (signal.aborted) throw refusal("run-aborted");
  const url = new URL(path.upstreamPath, target.baseUrl);
  if (!url.href.startsWith(target.baseUrl)) throw refusal("path-invalid");
  const upstream = await fetchUpstream(request, method, url, admission, options, signal);
  state.upstreamStatus = upstream.status;
  const verdict = noteUpstreamStatus(upstream.status, target.stats);
  if (verdict === "unusable") {
    await upstream.body?.cancel();
    throw refusal("upstream-failed");
  }
  if (upstream.status >= 200 && upstream.status < 300) {
    await relayBody(upstream, response, {
      request,
      relayId,
      method,
      path,
      target,
      limits: options.limits,
    });
  } else {
    // Only a success carries a file: an error page is the upstream's, not something the run needs.
    await upstream.body?.cancel();
    emptyAnswer(response, upstream.status, upstream);
  }
  response.end();
  return verdict === "denied" ? "denied" : "ok";
}

// The exchange ends when the run is released or the runtime closes the request.
function exchangeSignal(
  response: ServerResponse,
  admission: RepositoryRelayAdmission,
): { readonly signal: AbortSignal; readonly detach: () => void } {
  const disconnect = new AbortController();
  const onClose = (): void => {
    if (!response.writableFinished) disconnect.abort();
  };
  response.once("close", onClose);
  return {
    signal: AbortSignal.any([admission.signal, disconnect.signal]),
    detach: (): void => {
      response.removeListener("close", onClose);
    },
  };
}

const REVOKED_BODY = JSON.stringify({
  error: "binding-revoked",
  message:
    "This repository connection was ended because its coding run was stopped or its permissions changed. Start a new run to use the repository again.",
});

function sendRefusal(response: ServerResponse, error: RelayRefusal): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const headers: Record<string, string> = { "cache-control": "no-store" };
  if (error.reason === "capability-missing")
    headers["www-authenticate"] =
      `Basic realm="${REPOSITORY_RELAY_CHALLENGE_REALM}", charset="UTF-8"`;
  if (error.reason === "method-not-allowed") headers.allow = "GET, HEAD";
  if (error.reason === "binding-revoked") {
    response.writeHead(error.status, { ...headers, "content-type": "application/json" });
    response.end(REVOKED_BODY);
    return;
  }
  response.writeHead(error.status, headers).end();
}

type Settled = Pick<RepositoryRelayLine, "outcome" | "reason" | "error"> | undefined;

// What becomes of a request that threw: a cancelled one is counted and not recorded, the challenge
// of a client that sent no credential yet is the protocol and is not recorded, a refusal records a
// warning, and a failure (or any refusal after bytes were sent) records its Keiko frames.
function settledLine(error: unknown, state: ExchangeState, headersSent: boolean): Settled {
  if (state.signal?.aborted === true) return undefined;
  if (!(error instanceof RelayRefusal))
    return { outcome: "failed", reason: "upstream-failed", error };
  if (error.reason === "capability-missing") return undefined;
  return INCIDENT_REASONS.has(error.reason) || headersSent
    ? { outcome: "failed", reason: error.reason, error }
    : { outcome: "refused", reason: error.reason };
}

function countRequest(state: ExchangeState, settled: Settled, delivered: boolean): void {
  const stats = state.admission?.target.stats;
  if (stats === undefined) return;
  if (delivered) stats.relayed += 1;
  else if (state.signal?.aborted === true) stats.cancelled += 1;
  else if (settled?.outcome === "refused") stats.refused += 1;
  else stats.failed += 1;
}

interface ServedRequest {
  readonly settled: Settled;
  readonly delivered: boolean;
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  relayId: string,
  options: RepositoryRelayServeOptions,
  state: ExchangeState,
  onSignal: (detach: () => void) => void,
): Promise<ServedRequest> {
  const admission = admittedExchange(request, relayId, options);
  state.admission = admission;
  state.correlationId = admission.target.runId;
  state.ecosystem = admission.target.ecosystem;
  const bound = exchangeSignal(response, admission);
  state.signal = bound.signal;
  onSignal(bound.detach);
  const { stats } = admission.target;
  stats.requests += 1;
  if (stats.requests > REPOSITORY_RELAY_BINDING_MAX_REQUESTS) throw refusal("budget-exhausted");
  const method = requestMethod(request);
  state.method = method;
  const path = admittedPath(request, relayId, admission.target.ecosystem);
  const verdict = await exchange(
    request,
    response,
    admission,
    method,
    path,
    relayId,
    options,
    state,
  );
  // The first time a repository refuses the credential is recorded, once per binding: it is the
  // signature of a wrong or expired credential, and every following request would say the same.
  const firstRejection = verdict === "denied" && !stats.upstreamRejectionLogged;
  if (firstRejection) stats.upstreamRejectionLogged = true;
  return {
    delivered: true,
    settled: firstRejection ? { outcome: "failed", reason: "upstream-rejected" } : undefined,
  };
}

// Counts the request in its binding's summary and records a line when it was refused or failed.
function recordServedRequest(
  options: RepositoryRelayServeOptions,
  state: ExchangeState,
  served: ServedRequest,
  durationMs: number,
): void {
  countRequest(state, served.settled, served.delivered);
  if (served.settled === undefined) return;
  recordRepositoryRelay(options.activityLog, state.correlationId, {
    action: "request",
    ...served.settled,
    ...(state.ecosystem === undefined ? {} : { ecosystem: state.ecosystem }),
    ...(state.method === undefined ? {} : { method: state.method }),
    ...(state.upstreamStatus === undefined
      ? {}
      : { upstreamStatusClass: upstreamStatusClass(state.upstreamStatus) }),
    durationMs,
  });
}

/**
 * Serves one relayed read of a repository and records a line only for a refusal or a failure; a
 * request that was relayed is counted in its binding's settled summary. A refused request answers
 * its status without reaching the repository; a failed one answers 502 before any byte was sent and
 * is cut off after.
 */
export async function serveRepositoryRelayRequest(
  request: IncomingMessage,
  response: ServerResponse,
  input: { readonly relayId: string },
  options: RepositoryRelayServeOptions,
): Promise<void> {
  const now = options.nowMs ?? Date.now;
  const startedAt = now();
  const state: ExchangeState = { correlationId: options.correlationId };
  let detach = (): void => undefined;
  let served: ServedRequest;
  try {
    served = await handleRequest(request, response, input.relayId, options, state, (next) => {
      detach = next;
    });
  } catch (error) {
    const settled = settledLine(error, state, response.headersSent);
    sendRefusal(response, error instanceof RelayRefusal ? error : refusal("upstream-failed"));
    recordServedRequest(
      options,
      state,
      { delivered: false, settled },
      Math.max(0, now() - startedAt),
    );
    return;
  } finally {
    detach();
  }
  recordServedRequest(options, state, served, Math.max(0, now() - startedAt));
}
