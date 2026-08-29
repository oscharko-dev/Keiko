import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { request as httpRequest } from "node:http";
import type { IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as netConnect, isIP } from "node:net";
import type { LookupFunction, Socket } from "node:net";
import * as tls from "node:tls";
import {
  classifyOutboundHost,
  normalizeHost,
  outboundAddressBlockedReason,
  outboundTargetBlockedReason,
} from "./egress-policy.js";
import {
  logEndpointHost,
  logErrorKind,
  logLevelEnabled,
  logTimer,
  resolveLogSink,
  withCorrelationId,
  type ModelGatewayLogContext,
  type ModelGatewayLogSink,
} from "./observability.js";
import type { OutboundHttpEgressConfig } from "./types.js";

export type { OutboundHttpEgressConfig } from "./types.js";
// Re-exported so a caller can classify a target's address class (e.g. "loopback") by hostname
// string alone, with no DNS resolution and no dependency on any `OutboundHttpEgressConfig` flag —
// safe to use unconditionally, proxied or not (see keiko-server's Atlassian httpPort.ts for why
// that distinction matters: `denyLoopback` cannot be pinned on a proxied request there).
export { classifyOutboundHost } from "./egress-policy.js";

// Captured once at module load, before any test can monkey-patch `globalThis.fetch`. Used to
// detect a caller-substituted global fetch (the established test convention in this codebase,
// distinct from the explicit `fetchImpl` option) so DNS-resolution pinning (AUDIT-SEC-001) is
// skipped in that case, exactly like the pre-existing `fetchImpl !== undefined` skip — a
// substituted transport is not something we should independently DNS-resolve and pin around.
const NATIVE_FETCH = globalThis.fetch;

// Caps a single gateway response at 10 MB; real chat completions are far smaller.
export const MAX_RESPONSE_BYTES = 10_000_000;
const HTTPS_PROXY_TUNNEL_IDLE_TTL_MS = 30_000;
const MAX_IDLE_HTTPS_PROXY_TUNNELS_PER_KEY = 2;

export interface GatewayFetchOptions extends RequestInit {
  readonly fetchImpl?: typeof fetch | undefined;
  readonly useCaFallback?: boolean | undefined;
  readonly egress?: OutboundHttpEgressConfig | undefined;
  // When set, an AbortSignal.timeout(timeoutMs) is composed with any caller signal.
  // A timeout during proxy CONNECT rejects with PROXY_UNREACHABLE; after tunnel
  // establishment or on the direct path it surfaces as the standard AbortError.
  readonly timeoutMs?: number | undefined;
  // Override the default 10 MB cap for this fetch (e.g. large Figma render images).
  readonly maxResponseBytes?: number | undefined;
  // Activity-log sink (ADR-0019: a local port, see `observability.ts` — this package must not
  // import the BFF's logger). Unset means no-op.
  readonly log?: ModelGatewayLogSink | undefined;
  // The enclosing operation's correlation id. Every line this call writes carries it, which is
  // what makes one of N concurrent in-flight requests identifiable as the stuck one. Stripped
  // from the options before they reach the transport — it never becomes a RequestInit field.
  readonly logContext?: ModelGatewayLogContext | undefined;
}

export type OutboundHttpEgressErrorCode =
  | "PROXY_UNREACHABLE"
  | "PROXY_AUTH_REQUIRED"
  | "PROXY_EGRESS_FAILED"
  | "PROXY_BLOCKED_BY_POLICY"
  | "TLS_CA_FAILURE";

type OutboundHttpEgressPolicyReason = "undelegated-proxied-hostname";

export class OutboundHttpEgressError extends Error {
  readonly code: OutboundHttpEgressErrorCode;
  readonly policyReason?: OutboundHttpEgressPolicyReason | undefined;

  constructor(
    code: OutboundHttpEgressErrorCode,
    message: string,
    policyReason?: OutboundHttpEgressPolicyReason,
  ) {
    super(message);
    this.name = "OutboundHttpEgressError";
    this.code = code;
    this.policyReason = policyReason;
  }
}

const FORWARDED_CREDENTIAL_HEADERS = new Set([
  "authorization",
  "x-litellm-key",
  "x-api-key",
  "api-key",
]);

function headersFromNode(headers: Record<string, string | string[] | undefined>): Headers {
  const out = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) out.append(name, item);
    } else if (value !== undefined) {
      out.set(name, value);
    }
  }
  return out;
}

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const normalized = new Headers(headers);
  normalized.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function hasForwardedCredentialHeader(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((name) => FORWARDED_CREDENTIAL_HEADERS.has(name.toLowerCase()));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isMissingIssuerError(error: unknown): boolean {
  const cause = isRecord(error) ? error.cause : undefined;
  const candidates = [error, cause];
  return candidates.some((item) => {
    if (!isRecord(item)) return false;
    return item.code === "UNABLE_TO_GET_ISSUER_CERT_LOCALLY";
  });
}

const RECOVERABLE_TLS_TRUST_ERROR_CODES = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

export function isRecoverableTlsTrustError(error: unknown): boolean {
  const cause = isRecord(error) ? error.cause : undefined;
  const candidates = [error, cause];
  return candidates.some((item) => {
    if (!isRecord(item) || typeof item.code !== "string") return false;
    return RECOVERABLE_TLS_TRUST_ERROR_CODES.has(item.code);
  });
}

function usesHttps(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

function readCertificateFile(path: string): readonly string[] {
  try {
    return [readFileSync(path, "utf8")];
  } catch {
    return [];
  }
}

// One-time set of paths we have already warned about so the warning fires once per path.
const warnedCaBundlePaths = new Set<string>();

interface IdleHttpsProxyTunnel {
  readonly socket: tls.TLSSocket;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly onIdleError: (error: Error) => void;
}

const idleHttpsProxyTunnels = new Map<string, IdleHttpsProxyTunnel[]>();

function extraCaCertificates(caBundlePath?: string): readonly string[] {
  const paths = [process.env.NODE_EXTRA_CA_CERTS, caBundlePath].filter(
    (path): path is string => path !== undefined && path.trim().length > 0,
  );
  return paths.flatMap((path) => {
    const certs = readCertificateFile(path);
    // Warn once when a configured path yields no certificates so the operator
    // can tell the file is missing or unreadable without throwing at startup.
    if (certs.length === 0 && !warnedCaBundlePaths.has(path)) {
      warnedCaBundlePaths.add(path);
      // eslint-disable-next-line no-console
      console.warn(`[keiko-model-gateway] CA bundle at ${path} could not be read or is empty`);
    }
    return certs;
  });
}

type CaCertificateSource = "default" | "system" | "bundled" | "extra";
const trustedCaCertificateCache = new Map<string, readonly string[]>();

function nodeCaCertificates(source: CaCertificateSource): readonly string[] {
  const getter = tls.getCACertificates;
  if (typeof getter !== "function") {
    return [];
  }
  try {
    return getter(source);
  } catch {
    return [];
  }
}

export function gatewayTrustedCaCertificates(caBundlePath?: string): readonly string[] {
  const cacheKey = caBundlePath ?? "";
  const cached = trustedCaCertificateCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const certificates = Array.from(
    new Set([
      ...nodeCaCertificates("default"),
      ...tls.rootCertificates,
      ...nodeCaCertificates("system"),
      ...nodeCaCertificates("extra"),
      ...extraCaCertificates(caBundlePath),
    ]),
  );
  trustedCaCertificateCache.set(cacheKey, certificates);
  return certificates;
}

// Exposed for tests to reset the one-time warning set between runs.
export function _resetWarnedCaBundlePaths(): void {
  warnedCaBundlePaths.clear();
  trustedCaCertificateCache.clear();
  for (const entries of idleHttpsProxyTunnels.values()) {
    for (const entry of entries) {
      clearTimeout(entry.timer);
      entry.socket.off("error", entry.onIdleError);
      entry.socket.destroy();
    }
  }
  idleHttpsProxyTunnels.clear();
}

// Normalizes a request body for the Node-based egress fallbacks (proxy tunnels and the custom-CA
// path). String and URLSearchParams bodies are serialized as before; typed arrays and Blob bodies are
// forwarded as bytes so multipart `audio/transcriptions` payloads survive a corporate proxy without
// UTF-8 corruption. `ClientRequest.end()` accepts both string and `Uint8Array` chunks. FormData and
// streams remain unsupported on the fallback paths.
async function bodyToWire(
  body: BodyInit | null | undefined,
): Promise<string | Uint8Array | undefined> {
  if (body === undefined || body === null) {
    return undefined;
  }
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof URLSearchParams) {
    return body.toString();
  }
  if (body instanceof Uint8Array) {
    return body;
  }
  if (body instanceof Blob) {
    return new Uint8Array(await body.arrayBuffer());
  }
  throw new TypeError("gateway HTTP fallback supports string and byte request bodies only");
}

// Converts a Node IncomingMessage into a streaming web Response, enforcing the
// byte cap inline and destroying the request when the consumer cancels. Unlike a
// Buffer.concat-on-end approach this delivers SSE chunks incrementally (#152), so
// the CA-bundle fallback streams tokens instead of buffering the whole response.
export function streamingResponseFromNode(
  res: import("node:http").IncomingMessage,
  onCancel: () => void,
  maxBytes: number = MAX_RESPONSE_BYTES,
  onDone?: () => void,
): Response {
  let total = 0;
  let done = false;
  const finish = (): void => {
    if (done) return;
    done = true;
    onDone?.();
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller): void {
      res.on("data", (chunk: Buffer) => {
        if (done) return;
        total += chunk.length;
        if (total > maxBytes) {
          done = true;
          controller.error(new Error("gateway response exceeded the size limit"));
          onCancel();
          return;
        }
        controller.enqueue(new Uint8Array(chunk));
      });
      res.on("end", () => {
        if (done) return;
        controller.close();
        finish();
      });
      res.on("error", (error) => {
        if (done) return;
        done = true;
        controller.error(error);
        onCancel();
      });
    },
    cancel(): void {
      done = true;
      onCancel();
    },
  });
  return new Response(body, {
    status: res.statusCode ?? 500,
    statusText: res.statusMessage ?? "",
    headers: headersFromNode(res.headers),
  });
}

// Composes a caller-supplied AbortSignal with an AbortSignal.timeout so both
// cancellation and deadline are observed. Returns undefined when neither is set.
function composeSignal(
  callerSignal: AbortSignal | null | undefined,
  timeoutMs: number | undefined,
): AbortSignal | undefined {
  const timeoutSignal = timeoutMs !== undefined ? AbortSignal.timeout(timeoutMs) : undefined;
  if (callerSignal != null && timeoutSignal !== undefined) {
    return AbortSignal.any([callerSignal, timeoutSignal]);
  }
  if (callerSignal != null) return callerSignal;
  return timeoutSignal;
}

// Builds a Node dns.lookup-compatible callback that always answers with the address set
// `enforceOutboundTargetPolicy` already resolved and validated, ignoring whatever the
// runtime's own resolver would return for `hostname`. Passing this as the `lookup` option to
// `http(s).request` pins the actual TCP connect to the same address the policy checked,
// closing the resolve-then-connect DNS-rebinding gap between the policy lookup and the real
// connect (AUDIT-SEC-001): the socket can only ever reach an address this process itself
// resolved and classified as allowed, never a second, independently (and possibly
// differently) resolved address. Original hostname/Host header/SNI are untouched -- only the
// address `net.connect` dials is pinned.
function pinnedLookup(addresses: readonly LookupAddress[]): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all === true) {
      callback(
        null,
        addresses.map((address) => ({ ...address })),
      );
      return;
    }
    const first = addresses[0];
    if (first === undefined) {
      callback(new Error("gateway egress: no policy-validated address available"), "", 0);
      return;
    }
    callback(null, first.address, first.family);
  };
}

async function fetchWithCaBundle(
  url: string,
  init: RequestInit,
  egress?: OutboundHttpEgressConfig,
  maxResponseBytes?: number,
  lookup?: LookupFunction,
): Promise<Response> {
  const body = await bodyToWire(init.body);
  const headers = headersToRecord(init.headers);
  const cap = maxResponseBytes ?? MAX_RESPONSE_BYTES;
  return new Promise<Response>((resolve, reject) => {
    const req = httpsRequest(
      url,
      {
        method: init.method ?? "GET",
        headers,
        ca: [...gatewayTrustedCaCertificates(egress?.caBundlePath)],
        signal: init.signal ?? undefined,
        lookup,
      },
      (res) => {
        resolve(streamingResponseFromNode(res, () => req.destroy(), cap));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

// Primary direct-fetch transport used whenever `gatewayFetch` itself resolved the target's DNS
// (no forward proxy, no test-injected `fetchImpl`): connects via the exact address set the
// policy check already validated instead of letting a second, independent resolution decide
// where the socket lands (AUDIT-SEC-001). Mirrors `fetchWithCaBundle`'s Node-request shape but
// without an explicit `ca` override, matching the default trust store `doFetch`/global `fetch`
// would otherwise have used.
async function fetchDirectPinned(
  url: string,
  init: RequestInit,
  addresses: readonly LookupAddress[],
  maxResponseBytes?: number,
): Promise<Response> {
  const body = await bodyToWire(init.body);
  const headers = headersToRecord(init.headers);
  const request = usesHttps(url) ? httpsRequest : httpRequest;
  const cap = maxResponseBytes ?? MAX_RESPONSE_BYTES;
  return new Promise<Response>((resolve, reject) => {
    const req = request(
      url,
      {
        method: init.method ?? "GET",
        headers,
        lookup: pinnedLookup(addresses),
        signal: init.signal ?? undefined,
      },
      (res) => {
        resolve(streamingResponseFromNode(res, () => req.destroy(), cap));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

function tlsServerName(hostname: string): string | undefined {
  const normalized = normalizeHost(hostname);
  return isIP(normalized) === 0 ? normalized : undefined;
}

function defaultPort(protocol: string): string {
  return protocol === "https:" ? "443" : "80";
}

function targetPort(url: URL): string {
  return url.port.length > 0 ? url.port : defaultPort(url.protocol);
}

// Returns the Host header value for a target URL: omit the port when it is the
// default for the scheme (443 for https, 80 for http) so the value matches what
// undici sends directly and satisfies SigV4 pre-signed S3 URLs behind a proxy.
function hostHeader(url: URL): string {
  const isDefaultPort =
    (url.protocol === "https:" && (url.port === "" || url.port === "443")) ||
    (url.protocol === "http:" && (url.port === "" || url.port === "80"));
  return isDefaultPort ? url.hostname : `${url.hostname}:${url.port}`;
}

// Formats a resolved address as a bare authority host: an IPv6 literal MUST be bracketed in a URI
// authority (RFC 3986); an IPv4 literal never is. Used only for `pinProxiedConnectTarget` (ADR-0038
// D6) — the resolved address becomes the actual dial target instead of an informational value, so
// this is the one place in the file where that distinction is load-bearing rather than cosmetic.
function addressAuthorityHost(address: LookupAddress): string {
  return address.family === 6 ? `[${address.address}]` : address.address;
}

// Same bracketing rule via the URL setter. Verified empirically (not assumed): `url.hostname =
// "::1"` (unbracketed) silently leaves the URL UNCHANGED — no exception, no error — so an unwary
// caller could believe the target was pinned to the vetted address while the original hostname
// (never resolved by Keiko) actually went out on the wire. `url.hostname = "[::1]"` (bracketed) is
// the only form the WHATWG URL setter accepts for an IPv6 host.
function rewriteHostToAddress(target: URL, address: LookupAddress): URL {
  const rewritten = new URL(target.href);
  rewritten.hostname = addressAuthorityHost(address);
  return rewritten;
}

function noProxyRuleMatches(rule: string, host: string, hostPort: string): boolean {
  if (rule.length === 0) return false;
  if (rule === "*") return true;
  if (rule.includes(":") && normalizeHost(rule) === hostPort) return true;
  const domain = rule.startsWith(".") ? rule.slice(1) : rule;
  if (host === domain) return true;
  return host.endsWith(`.${domain}`);
}

function noProxyMatches(url: URL, rules: readonly string[] | undefined): boolean {
  if (rules === undefined || rules.length === 0) return false;
  const host = normalizeHost(url.hostname);
  const hostPort = `${host}:${targetPort(url)}`;
  for (const rawRule of rules) {
    const rule = rawRule.trim().toLowerCase();
    if (noProxyRuleMatches(rule, host, hostPort)) return true;
  }
  return false;
}

function parseProxyUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OutboundHttpEgressError("PROXY_EGRESS_FAILED", "Configured proxy URL is invalid.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new OutboundHttpEgressError(
      "PROXY_EGRESS_FAILED",
      "Configured proxy URL uses an unsupported scheme.",
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new OutboundHttpEgressError(
      "PROXY_AUTH_REQUIRED",
      "Proxy credentials must not be embedded in the proxy URL.",
    );
  }
  return url;
}

function proxyForTarget(
  target: URL,
  egress: OutboundHttpEgressConfig | undefined,
): string | undefined {
  if (egress === undefined || noProxyMatches(target, egress.noProxy)) return undefined;
  if (target.protocol === "https:") return egress.httpsProxy ?? egress.httpProxy;
  if (target.protocol === "http:") return egress.httpProxy;
  return undefined;
}

function blockedTargetError(
  reason: string,
  policyReason?: OutboundHttpEgressPolicyReason,
): OutboundHttpEgressError {
  return new OutboundHttpEgressError(
    "PROXY_BLOCKED_BY_POLICY",
    `Outbound target is blocked by gateway egress policy (${reason}).`,
    policyReason,
  );
}

function refuseUndelegatedProxiedHostnameEgress(
  target: URL,
  proxy: URL | undefined,
  egress: OutboundHttpEgressConfig | undefined,
): void {
  if (
    proxy !== undefined &&
    classifyOutboundHost(target.hostname) === undefined &&
    egress?.pinProxiedConnectTarget !== true &&
    egress?.acknowledgeProxiedHostnamePolicy !== true
  ) {
    throw blockedTargetError(
      "proxied hostname policy delegation is not acknowledged",
      "undelegated-proxied-hostname",
    );
  }
}

// Resolves and validates the target's DNS records, returning the vetted address set so the
// caller can pin the actual connect to it (AUDIT-SEC-001). Returns undefined when DNS
// resolution was skipped (no resolution needed/allowed) -- callers must not pin a connect in
// that case and instead fall back to the runtime's own resolution.
async function enforceOutboundTargetPolicy(
  target: URL,
  egress: OutboundHttpEgressConfig | undefined,
  options: { readonly resolveDns: boolean },
): Promise<readonly LookupAddress[] | undefined> {
  const literalReason = outboundTargetBlockedReason(target, egress);
  if (literalReason !== undefined) throw blockedTargetError(literalReason);
  if (!options.resolveDns) return undefined;
  const addresses = await dnsLookup(target.hostname, { all: true, verbatim: true });
  for (const address of addresses) {
    const reason = outboundAddressBlockedReason(address.address, egress);
    if (reason !== undefined) throw blockedTargetError(`DNS resolved to ${reason}`);
  }
  return addresses;
}

function proxyPort(proxy: URL): number {
  if (proxy.port.length > 0) return Number(proxy.port);
  return proxy.protocol === "https:" ? 443 : 80;
}

const PROXY_UNREACHABLE_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);

const ABORT_ERROR_NAMES = new Set(["AbortError", "TimeoutError"]);

function mapProxyError(error: unknown): Error {
  if (error instanceof OutboundHttpEgressError) return error;
  if (isRecoverableTlsTrustError(error)) {
    return tlsCaFailureError();
  }
  if (error instanceof Error) {
    const code = isRecord(error) ? (error as Record<string, unknown>).code : undefined;
    if (
      (typeof code === "string" && PROXY_UNREACHABLE_CODES.has(code)) ||
      ABORT_ERROR_NAMES.has(error.name)
    ) {
      return new OutboundHttpEgressError("PROXY_UNREACHABLE", "Configured proxy is unreachable.");
    }
    return error;
  }
  return new OutboundHttpEgressError("PROXY_EGRESS_FAILED", "Outbound egress failed.");
}

function tlsCaFailureError(): OutboundHttpEgressError {
  return new OutboundHttpEgressError(
    "TLS_CA_FAILURE",
    "TLS certificate verification failed for outbound egress.",
  );
}

const PROXY_UNREACHABLE_ERROR = new OutboundHttpEgressError(
  "PROXY_UNREACHABLE",
  "Configured proxy is unreachable.",
);

function attachAbortGuard(signal: AbortSignal, onAbort: () => void): () => void {
  if (signal.aborted) {
    onAbort();
    return () => undefined;
  }
  signal.addEventListener("abort", onAbort, { once: true });
  return () => {
    signal.removeEventListener("abort", onAbort);
  };
}

// Shared "settle once" guard for the proxy-socket Promise executors below. `getCleanup` is a
// lazy accessor (rather than the cleanup function itself) so callers can declare `settle` before
// their `cleanup` const is initialized — `cleanup` is only read once `settle` actually fires,
// which happens on a later socket event, never synchronously during setup.
function createSettle(getCleanup: () => () => void): (fn: () => void) => void {
  let settled = false;
  return (fn: () => void): void => {
    if (settled) return;
    settled = true;
    getCleanup()();
    fn();
  };
}

function createProxyErrorHandler(
  settle: (fn: () => void) => void,
  reject: (error: Error) => void,
): (error: Error) => void {
  return (error: Error): void => {
    settle(() => {
      reject(mapProxyError(error));
    });
  };
}

function createProxyUnreachableAbortHandler(
  getSocket: () => Socket,
  settle: (fn: () => void) => void,
  reject: (error: Error) => void,
): () => void {
  return (): void => {
    getSocket().destroy();
    settle(() => {
      reject(PROXY_UNREACHABLE_ERROR);
    });
  };
}

function openProxySocket(
  proxy: URL,
  ca: readonly string[],
  signal: AbortSignal | undefined,
): Promise<Socket> {
  const host = proxy.hostname;
  const port = proxyPort(proxy);
  return new Promise<Socket>((resolve, reject) => {
    const settle = createSettle(() => cleanup);
    const onConnect = (): void => {
      settle(() => {
        resolve(socket);
      });
    };
    const onError = createProxyErrorHandler(settle, reject);
    const onAbort = createProxyUnreachableAbortHandler(() => socket, settle, reject);
    let removeAbort = (): void => undefined;
    const cleanup = (): void => {
      socket.off("error", onError);
      removeAbort();
    };
    const socket =
      proxy.protocol === "https:"
        ? tls.connect({ host, port, servername: tlsServerName(host), ca: [...ca] }, onConnect)
        : netConnect({ host, port }, onConnect);
    socket.once("error", onError);
    if (signal !== undefined) {
      removeAbort = attachAbortGuard(signal, onAbort);
    }
  });
}

// A CONNECT response header is one status line plus a handful of headers; anything larger is a
// protocol violation from a broken or hostile proxy. The bound doubles as a second, independent
// exit for the accumulation loop in readConnectHeader: even if the terminator search is defective,
// the buffer cannot grow without limit (fail closed, bounded memory).
const MAX_CONNECT_RESPONSE_HEADER_BYTES = 16_384;

export function connectResponseHeaderExceedsLimit(bufferLength: number): boolean {
  return bufferLength > MAX_CONNECT_RESPONSE_HEADER_BYTES;
}

function connectHeaderLimitError(): OutboundHttpEgressError {
  return new OutboundHttpEgressError(
    "PROXY_EGRESS_FAILED",
    "Proxy CONNECT response header exceeded the size limit.",
  );
}

function readConnectHeader(socket: Socket, signal: AbortSignal | undefined): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;
    let removeAbort = (): void => undefined;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      socket.off("data", onData);
      socket.off("error", onError);
      removeAbort();
      fn();
    };
    const onData = (chunk: Buffer): void => {
      chunks.push(chunk);
      const buffer = Buffer.concat(chunks);
      // Bound the accumulated buffer FIRST, before any terminator-dependent branching, so no single
      // defect below can detach this bound from the loop (fail closed, bounded memory — the loop's
      // independent second exit). The bound covers the whole buffer intentionally: in the HTTPS
      // CONNECT flow the proxy sends only the response header and then the client drives the TLS
      // handshake, so no legitimate response carries bulk bytes ahead of the "\r\n\r\n" terminator;
      // a proxy that floods before terminating is exactly the abusive case this rejects. The 16 KiB
      // ceiling is far above any real CONNECT header, so well-formed responses never trip it.
      if (connectResponseHeaderExceedsLimit(buffer.length)) {
        socket.destroy();
        settle(() => {
          reject(connectHeaderLimitError());
        });
        return;
      }
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const rest = buffer.subarray(headerEnd + 4);
      if (rest.length > 0) socket.unshift(rest);
      settle(() => {
        resolve(buffer.subarray(0, headerEnd).toString("latin1"));
      });
    };
    const onError = createProxyErrorHandler(settle, reject);
    const onAbort = createProxyUnreachableAbortHandler(() => socket, settle, reject);
    socket.on("data", onData);
    socket.once("error", onError);
    if (signal !== undefined) {
      removeAbort = attachAbortGuard(signal, onAbort);
    }
  });
}

function connectStatus(header: string): number {
  const match = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/iu.exec(header);
  return match === null ? 0 : Number(match[1]);
}

function startTargetTls(
  target: URL,
  socket: Socket,
  ca: readonly string[],
  signal: AbortSignal | undefined,
): Promise<tls.TLSSocket> {
  return new Promise<tls.TLSSocket>((resolve, reject) => {
    const settle = createSettle(() => cleanup);
    const onError = createProxyErrorHandler(settle, reject);
    const onAbort = (): void => {
      tlsSocket.destroy();
      settle(() => {
        reject(new DOMException("The operation was aborted.", "AbortError"));
      });
    };
    const cleanup = (): void => {
      tlsSocket.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const tlsSocket = tls.connect(
      { socket, servername: tlsServerName(target.hostname), ca: [...ca] },
      () => {
        settle(() => {
          resolve(tlsSocket);
        });
      },
    );
    tlsSocket.once("error", onError);
    tlsSocket.resume();
    if (signal !== undefined) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

async function createTlsTunnel(
  target: URL,
  proxy: URL,
  ca: readonly string[],
  signal: AbortSignal | undefined,
  pinnedAddress: LookupAddress | undefined,
): Promise<tls.TLSSocket> {
  const socket = await openProxySocket(proxy, ca, signal);
  // pinProxiedConnectTarget (ADR-0038 D6): when set, the CONNECT authority is the address Keiko
  // itself resolved and vetted, not the hostname — the proxy dials exactly that address instead of
  // re-resolving DNS on its own, closing the DNS-rebinding TOCTOU gap a pre-proxy-only lookup
  // cannot close. TLS server-name identity is untouched below (startTargetTls still uses
  // target.hostname), so certificate validation still runs against the real hostname regardless.
  const connectHost =
    pinnedAddress === undefined ? target.hostname : addressAuthorityHost(pinnedAddress);
  const authority = `${connectHost}:${targetPort(target)}`;
  socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
  const status = connectStatus(await readConnectHeader(socket, signal));
  if (status === 407) {
    socket.destroy();
    throw new OutboundHttpEgressError(
      "PROXY_AUTH_REQUIRED",
      "The configured proxy requires authentication.",
    );
  }
  if (status < 200 || status >= 300) {
    socket.destroy();
    throw new OutboundHttpEgressError(
      status === 403 ? "PROXY_BLOCKED_BY_POLICY" : "PROXY_EGRESS_FAILED",
      "The configured proxy rejected outbound egress.",
    );
  }
  socket.resume();
  return startTargetTls(target, socket, ca, signal);
}

// Includes this call's pinning posture (#3156 pool-identity follow-up to the DNS-rebinding fix
// above), not just (proxy, target, ca): an idle tunnel is handed back to fetchHttpsViaProxy below
// verbatim, socket and all, so two calls whose keys collide are treated as fully interchangeable
// no matter how each one's actual TCP peer was chosen. Before this, an UNPINNED call (the proxy
// resolves the hostname itself, at its own discretion) and a PINNED call to the identical
// (proxy, target, ca) triple produced the SAME key, so a pinned request could silently be served
// the unpinned call's pooled tunnel: resolveGatewayDns's vetting for the pinned call would have no
// bearing on the peer the request actually rode, because that peer was chosen entirely by the
// earlier, unpinned call, before the pinned call ever ran. Folding in "unpinned" or a digest of
// the vetted address (see below for why a digest, not the address itself) makes a pinned and an
// unpinned call to the same (proxy, target, ca) triple compute DIFFERENT keys, so neither can be
// served from the other's pool entry, in either direction, and two pinned calls that happened to
// resolve to different addresses can't collide either. (The plain-HTTP absolute-URI proxy path,
// fetchHttpViaProxy, DOES reuse its connection to
// the proxy -- it passes no explicit `agent`, and on this repo's pinned Node, http.globalAgent's
// keepAlive defaults to true, unlike a freshly constructed `new Agent()`. That reuse is not the
// same defect, though: Agent.getName() keys purely on host/port, so what gets pooled is the hop to
// the proxy, never the ultimate destination -- each request's real target lives in that request's
// own absolute-URI, computed fresh per call by proxyRequestTarget below, never cached or inherited
// from an earlier call on the same socket. See ADR-0038 D6's #3156 plain-HTTP correction for the
// full reasoning, including how this was verified rather than assumed.)
//
// Both variable terms below are collision-resistant digests, not raw/summarized values (#3157,
// Codex P1 + Keiko for Quality): the CA term used to be `${cert.length}:${cert.slice(0, 32)}` per
// certificate -- for PEM input that summary is almost entirely the near-universal
// "-----BEGIN CERTIFICATE-----" header, so two DIFFERENT certificate sets sharing a byte length
// routinely produced the IDENTICAL summary. A call configured with a tightened or entirely
// different trust bundle could then be served an idle tunnel authenticated under an earlier call's
// (looser or unrelated) trust set, with its own bundle never actually applied -- the same class of
// bug as the pinning-posture gap above, one field over. Hashing the full certificate bytes (sorted
// first, with an explicit comparator so the sort is well-defined rather than relying on the
// default coercion-based ordering -- this only has to be a STABLE total order within one running
// process, not a human-meaningful one, so locale-awareness is incidental, not a requirement) makes
// the SAME set in a different array order hash identically -- order carries no trust meaning --
// while two distinct bundles produce different keys with overwhelming probability,
// and a byte-identical set collapses to the same key exactly when it should. The pin term's address
// literal is hashed for a different reason: it is an internal-network IP with no legitimate reason
// to be human-legible in a key whose only job is to differ from other keys, never to be read back
// (this key is a private, in-memory Map key -- grepped and confirmed never logged, thrown, or
// otherwise surfaced -- but a digest costs nothing and permanently forecloses that ever mattering
// if some future change adds diagnostics here).
//
// The sort's comparator is a plain UTF-16 code-unit comparison, not `localeCompare` (#3157,
// Keiko for Quality x2): an earlier version of this line used `(a, b) => a.localeCompare(b)` to
// satisfy SonarJS S2871, which requires an explicit comparator rather than default sort's
// coercion-based one. That satisfied the rule's letter while breaking the one property the sort
// exists for: `localeCompare`'s result depends on the runtime's collation (locale, ICU data
// version), which is exactly the kind of environment-dependence the previous paragraph already
// said this sort must NOT have. Two hosts -- or the same host across an ICU upgrade -- could
// order the identical CA set differently and so hash it to different keys, silently dropping the
// pool's hit rate to zero for that CA configuration (wasted reconnects under load, not a
// correctness/security break, since a MISSED pool hit only means a fresh, still-correctly-vetted
// tunnel; but a real defect, and introduced by this file's own #3157 fix). codeUnitCompare below
// is total, stable, and depends on nothing but the two strings' own UTF-16 code units -- no ICU,
// no locale, no Intl -- while still an explicit comparator function, satisfying S2871 for the
// reason it actually asks for (a well-defined order) rather than the one that happened to also
// compile (a human-friendly one). Written with if-statements rather than a nested ternary
// (`a < b ? -1 : a > b ? 1 : 0`) because SonarJS S3358 flags nested ternaries separately --
// satisfying one rule should not trip another.
function keyMaterialDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function codeUnitCompare(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function httpsProxyTunnelKey(
  target: URL,
  proxy: URL,
  ca: readonly string[],
  pinnedAddress: LookupAddress | undefined,
): string {
  const caKey = keyMaterialDigest(JSON.stringify([...ca].sort(codeUnitCompare)));
  const pinKey =
    pinnedAddress === undefined
      ? "unpinned"
      : `pinned:${keyMaterialDigest(addressAuthorityHost(pinnedAddress))}`;
  return `${proxy.protocol}//${proxy.host}|${target.protocol}//${target.host}|${caKey}|${pinKey}`;
}

function usableIdleTunnel(socket: tls.TLSSocket): boolean {
  return !socket.destroyed && socket.readable && socket.writable;
}

function takeIdleHttpsProxyTunnel(key: string): tls.TLSSocket | undefined {
  const entries = idleHttpsProxyTunnels.get(key);
  if (entries === undefined) return undefined;
  while (entries.length > 0) {
    const entry = entries.pop();
    if (entry === undefined) break;
    clearTimeout(entry.timer);
    entry.socket.off("error", entry.onIdleError);
    if (usableIdleTunnel(entry.socket)) {
      entry.socket.setTimeout(0);
      return entry.socket;
    }
    entry.socket.destroy();
  }
  if (entries.length === 0) idleHttpsProxyTunnels.delete(key);
  return undefined;
}

function releaseIdleHttpsProxyTunnel(key: string, socket: tls.TLSSocket): void {
  if (!usableIdleTunnel(socket)) {
    socket.destroy();
    return;
  }
  socket.setKeepAlive(true);
  const onIdleError = (): void => {
    socket.destroy();
  };
  socket.once("error", onIdleError);
  const timer = setTimeout(() => {
    socket.off("error", onIdleError);
    socket.destroy();
  }, HTTPS_PROXY_TUNNEL_IDLE_TTL_MS);
  timer.unref();
  const entries = idleHttpsProxyTunnels.get(key) ?? [];
  entries.push({ socket, timer, onIdleError });
  while (entries.length > MAX_IDLE_HTTPS_PROXY_TUNNELS_PER_KEY) {
    const stale = entries.shift();
    if (stale !== undefined) {
      clearTimeout(stale.timer);
      stale.socket.off("error", stale.onIdleError);
      stale.socket.destroy();
    }
  }
  idleHttpsProxyTunnels.set(key, entries);
}

function responseFromClientRequest(
  start: (resolve: (response: Response) => void, reject: (error: Error) => void) => void,
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    start(resolve, reject);
  });
}

function assertNoForwardedCredentialHeader(headers: Record<string, string>): void {
  if (hasForwardedCredentialHeader(headers)) {
    throw new OutboundHttpEgressError(
      "PROXY_BLOCKED_BY_POLICY",
      "Refusing to forward credential headers to a plaintext HTTP target through the configured proxy.",
    );
  }
}

// pinProxiedConnectTarget (ADR-0038 D6): a plain-HTTP proxy request has no CONNECT tunnel to pin
// (unlike fetchHttpsViaProxy) — the proxy forwards an absolute-URI request itself and resolves its
// host independently. Rewriting the request-target's host to the vetted address makes the proxy
// dial that address directly (nothing left to resolve); the caller's Host header still carries the
// real hostname, so the origin's virtual-hosting is unaffected.
function proxyRequestTarget(target: URL, pinnedAddress: LookupAddress | undefined): URL {
  return pinnedAddress === undefined ? target : rewriteHostToAddress(target, pinnedAddress);
}

async function fetchHttpViaProxy(
  target: URL,
  init: RequestInit,
  proxy: URL,
  ca: readonly string[],
  maxResponseBytes: number | undefined,
  pinnedAddress: LookupAddress | undefined,
): Promise<Response> {
  const body = await bodyToWire(init.body);
  const headers = headersToRecord(init.headers);
  assertNoForwardedCredentialHeader(headers);
  // Ensure Host header omits the default port (fixes SigV4 pre-signed S3 URLs). Read from the
  // ORIGINAL target even when pinned, so the origin server's virtual-hosting still sees the real
  // hostname — only the absolute-URI request line below changes.
  if (!Object.hasOwn(headers, "host")) {
    headers.host = hostHeader(target);
  }
  const requestTarget = proxyRequestTarget(target, pinnedAddress);
  const request = proxy.protocol === "https:" ? httpsRequest : httpRequest;
  const cap = maxResponseBytes ?? MAX_RESPONSE_BYTES;
  return responseFromClientRequest((resolve, reject) => {
    const req = request(
      {
        protocol: proxy.protocol,
        hostname: proxy.hostname,
        port: proxyPort(proxy),
        method: init.method ?? "GET",
        path: requestTarget.href,
        headers,
        ca: proxy.protocol === "https:" ? [...ca] : undefined,
        signal: init.signal ?? undefined,
      },
      (res: IncomingMessage) => {
        resolve(
          streamingResponseFromNode(
            res,
            () => {
              req.destroy();
            },
            cap,
          ),
        );
      },
    );
    req.on("error", (error) => {
      reject(mapProxyError(error));
    });
    req.end(body);
  });
}

// eslint-disable-next-line max-lines-per-function
async function fetchHttpsViaProxy(
  target: URL,
  init: RequestInit,
  proxy: URL,
  ca: readonly string[],
  maxResponseBytes: number | undefined,
  pinnedAddress: LookupAddress | undefined,
): Promise<Response> {
  const body = await bodyToWire(init.body);
  const headers = headersToRecord(init.headers);
  if (!Object.hasOwn(headers, "connection")) {
    headers.connection = "keep-alive";
  }
  // Ensure Host header omits :443 so it matches what undici sends directly and
  // satisfies SigV4 pre-signed S3 URLs behind a proxy.
  if (!Object.hasOwn(headers, "host")) {
    headers.host = hostHeader(target);
  }
  const tunnelKey = httpsProxyTunnelKey(target, proxy, ca, pinnedAddress);
  // The key now carries this call's pinning posture (see httpsProxyTunnelKey above), so an idle
  // pooled entry is only ever a cache hit here when it was established under the IDENTICAL
  // posture -- unpinned reusing unpinned, or pinned reusing the same vetted address -- never a
  // pinned call silently inheriting an unpinned tunnel's unvetted peer, or the reverse (#3156).
  const socket =
    takeIdleHttpsProxyTunnel(tunnelKey) ??
    (await createTlsTunnel(target, proxy, ca, init.signal ?? undefined, pinnedAddress));
  socket.setKeepAlive(true);
  const cap = maxResponseBytes ?? MAX_RESPONSE_BYTES;
  return responseFromClientRequest((resolve, reject) => {
    const req = httpRequest(
      {
        method: init.method ?? "GET",
        hostname: target.hostname,
        port: Number(targetPort(target)),
        path: `${target.pathname}${target.search}`,
        headers,
        signal: init.signal ?? undefined,
        createConnection: () => socket,
      },
      (res) => {
        const responseAllowsReuse = (res.headers.connection ?? "").toLowerCase() !== "close";
        resolve(
          streamingResponseFromNode(
            res,
            () => {
              socket.destroy();
              req.destroy();
            },
            cap,
            () => {
              if (responseAllowsReuse) releaseIdleHttpsProxyTunnel(tunnelKey, socket);
              else socket.destroy();
            },
          ),
        );
      },
    );
    req.on("error", (error) => {
      socket.destroy();
      reject(mapProxyError(error));
    });
    req.end(body);
  });
}

function fetchViaProxy(
  target: URL,
  init: RequestInit,
  proxy: URL,
  egress: OutboundHttpEgressConfig | undefined,
  maxResponseBytes: number | undefined,
  pinnedAddress: LookupAddress | undefined,
): Promise<Response> {
  const ca = gatewayTrustedCaCertificates(egress?.caBundlePath);
  return target.protocol === "https:"
    ? fetchHttpsViaProxy(target, init, proxy, ca, maxResponseBytes, pinnedAddress)
    : fetchHttpViaProxy(target, init, proxy, ca, maxResponseBytes, pinnedAddress);
}

// `pinnedAddresses` is set exactly when gatewayFetch itself resolved DNS for this target (no
// proxy, no test-injected fetchImpl); when set, the connect reuses that vetted address set
// instead of letting the transport re-resolve DNS independently (AUDIT-SEC-001).
function attemptPrimaryFetch(
  url: string,
  init: RequestInit,
  doFetch: typeof fetch,
  maxResponseBytes: number | undefined,
  pinnedAddresses: readonly LookupAddress[] | undefined,
): Promise<Response> {
  return pinnedAddresses !== undefined
    ? fetchDirectPinned(url, init, pinnedAddresses, maxResponseBytes)
    : doFetch(url, init);
}

// Everything the direct (non-proxied) transport needs for one call, grouped so the two helpers
// below stay well under the parameter budget once the log sink is threaded through them — the
// alternative was an eighth positional argument on an already seven-argument function.
interface DirectFetchPlan {
  readonly doFetch: typeof fetch;
  readonly useCaFallback: boolean;
  readonly egress: OutboundHttpEgressConfig | undefined;
  readonly maxResponseBytes: number | undefined;
  readonly pinnedAddresses: readonly LookupAddress[] | undefined;
  readonly log: ModelGatewayLogSink;
}

// Extracted from fetchDirectWithCaFallback to keep its cyclomatic complexity within the limit.
async function attemptCaBundleFallback(
  url: string,
  init: RequestInit,
  plan: DirectFetchPlan,
): Promise<Response> {
  try {
    return await fetchWithCaBundle(
      url,
      init,
      plan.egress,
      plan.maxResponseBytes,
      plan.pinnedAddresses !== undefined ? pinnedLookup(plan.pinnedAddresses) : undefined,
    );
  } catch (fallbackError) {
    if (isRecoverableTlsTrustError(fallbackError)) {
      plan.log.write({
        level: "warn",
        category: "http",
        op: "http.gateway.tls.trust-failed",
        errorKind: logErrorKind(fallbackError),
        extra: { endpoint: logEndpointHost(url), afterCaBundleFallback: true },
      });
      throw tlsCaFailureError();
    }
    throw fallbackError;
  }
}

// Extracted from gatewayFetch to keep its cyclomatic complexity within the limit.
async function fetchDirectWithCaFallback(
  url: string,
  init: RequestInit,
  plan: DirectFetchPlan,
): Promise<Response> {
  try {
    return await attemptPrimaryFetch(
      url,
      init,
      plan.doFetch,
      plan.maxResponseBytes,
      plan.pinnedAddresses,
    );
  } catch (error) {
    const recoverable = usesHttps(url) && isRecoverableTlsTrustError(error);
    if (plan.useCaFallback && recoverable) {
      // Degradation: the default trust store rejected the peer, so the call is retried against
      // Keiko's assembled CA set. Silently, this shows up only as a doubled connect latency.
      plan.log.write({
        level: "warn",
        category: "http",
        op: "http.gateway.tls.ca-bundle-fallback",
        errorKind: logErrorKind(error),
        extra: { endpoint: logEndpointHost(url) },
      });
      return attemptCaBundleFallback(url, init, plan);
    }
    if (recoverable) {
      plan.log.write({
        level: "warn",
        category: "http",
        op: "http.gateway.tls.trust-failed",
        errorKind: logErrorKind(error),
        extra: { endpoint: logEndpointHost(url), afterCaBundleFallback: false },
      });
      throw tlsCaFailureError();
    }
    throw error;
  }
}

// How DNS participates in one gatewayFetch call. `pinForConnect` means Keiko resolves the target
// itself and pins the vetted address set for the actual connect — possible only on the direct
// native-fetch path, where Keiko owns the socket. `pinForProxyConnect` is the proxied counterpart
// (ADR-0038 D6): Keiko still resolves and vets the target itself, but hands the vetted address to
// the proxy layer instead of dialing it directly, closing the same DNS-rebinding gap on the
// CONNECT/absolute-URI path — opt-in only (`egress.pinProxiedConnectTarget`), since a proxy that
// filters by hostname would see an IP-literal target instead. Neither flag ever applies to a
// test-injected `fetchImpl` or a caller-substituted `globalThis.fetch`.
interface GatewayDnsPlan {
  readonly pinForConnect: boolean;
  readonly pinForProxyConnect: boolean;
}

function planGatewayDns(
  usesRealTransport: boolean,
  proxy: URL | undefined,
  doFetch: typeof globalThis.fetch,
  egress: OutboundHttpEgressConfig | undefined,
): GatewayDnsPlan {
  return {
    pinForConnect: usesRealTransport && proxy === undefined && doFetch === NATIVE_FETCH,
    pinForProxyConnect:
      usesRealTransport && proxy !== undefined && egress?.pinProxiedConnectTarget === true,
  };
}

/**
 * `denyLoopback` is the research-egress posture (#2387): a public research fetch must never be
 * steered at a local service. Keiko can only guarantee that when it owns the connect and pins the
 * vetted addresses.
 *
 * Through a proxy it cannot, UNLESS the caller has also set `pinProxiedConnectTarget` (ADR-0038
 * D6): without it, the proxy resolves the hostname independently at connect time, so a pre-proxy
 * lookup validates an address set that is never bound to use — a hostile name can resolve publicly
 * during the policy check and rebind to loopback for the proxy's own connect. Treating that lookup
 * as rebinding protection would be a guarantee the code cannot keep, so the combination fails
 * closed instead. `pinProxiedConnectTarget` is exactly the deployment-side opt-in this docstring
 * used to describe as a future contract: it makes gatewayFetch hand the proxy a vetted address
 * instead of a hostname, so the address IS bound to use and the refusal no longer applies.
 */
function refuseUnpinnableResearchEgress(
  proxy: URL | undefined,
  egress: OutboundHttpEgressConfig | undefined,
): void {
  const stillUnpinnable = proxy !== undefined && egress?.pinProxiedConnectTarget !== true;
  if (stillUnpinnable && egress?.denyLoopback === true) {
    throw blockedTargetError("research egress cannot pin addresses through a proxy");
  }
}

// pinProxiedConnectTarget (ADR-0038 D6) resolved DNS but the resolver returned no usable address —
// the target may still be broken/unreachable, but pinning must never SILENTLY fall back to letting
// the proxy resolve it unvetted just because Keiko's own lookup came back empty. Fail closed, the
// same posture as every other rejection this function's caller (enforceOutboundTargetPolicy) makes.
function requirePinnedAddress(addresses: readonly LookupAddress[] | undefined): LookupAddress {
  const first = addresses?.[0];
  if (first === undefined) {
    throw blockedTargetError("proxied DNS resolution returned no usable address to pin");
  }
  return first;
}

interface GatewayDnsResolution {
  readonly pinnedAddresses: readonly LookupAddress[] | undefined;
  readonly proxyPinnedAddress: LookupAddress | undefined;
}

// Extracted from gatewayFetch to keep its line count and cyclomatic complexity within budget.
// Resolves and vets the target's DNS exactly once per call, per whichever plan planGatewayDns
// picked, and derives every address binding a caller of gatewayFetch needs from that single
// lookup: the direct-path pinned set (AUDIT-SEC-001) and the proxy-path pinned address
// (ADR-0038 D6).
async function resolveGatewayDns(
  plan: GatewayProxyPlan,
  egress: OutboundHttpEgressConfig | undefined,
): Promise<GatewayDnsResolution> {
  const dns = planGatewayDns(plan.usesRealTransport, plan.proxy, plan.doFetch, egress);
  const resolveDns = dns.pinForConnect || dns.pinForProxyConnect;
  const vettedAddresses = await enforceOutboundTargetPolicy(plan.target, egress, { resolveDns });
  return {
    pinnedAddresses: dns.pinForConnect ? vettedAddresses : undefined,
    proxyPinnedAddress: dns.pinForProxyConnect ? requirePinnedAddress(vettedAddresses) : undefined,
  };
}

interface GatewayProxyPlan {
  readonly doFetch: typeof globalThis.fetch;
  readonly target: URL;
  readonly usesRealTransport: boolean;
  readonly proxy: URL | undefined;
}

// Extracted from gatewayFetch to keep its line count and cyclomatic complexity within budget.
function planGatewayProxy(
  url: string,
  fetchImpl: typeof fetch | undefined,
  egress: OutboundHttpEgressConfig | undefined,
  log: ModelGatewayLogSink,
): GatewayProxyPlan {
  const doFetch = fetchImpl ?? globalThis.fetch;
  const target = new URL(url);
  const usesRealTransport = fetchImpl === undefined;
  const proxyRaw = usesRealTransport ? proxyForTarget(target, egress) : undefined;
  // Validate the configured proxy before target DNS work so malformed/credentialed proxy settings
  // fail with their deterministic policy error rather than an unrelated target lookup failure.
  const proxy = proxyRaw === undefined ? undefined : parseProxyUrl(proxyRaw);
  // WHICH ROUTE this call took is the first question asked of a stuck outbound request, and it is
  // decided entirely by configuration the operator cannot see from the failure. Both endpoints are
  // reduced to scheme://host:port — a proxy URL may carry credentials in its userinfo.
  //
  // Gated: this is a `debug` line on the hot path of every outbound call, and the two
  // `logEndpointHost` calls below each parse a URL. Asking the sink first means an operator
  // running at the default `info` threshold pays a predicate call instead of two URL parses and
  // two allocations per request.
  if (logLevelEnabled(log, "debug")) {
    log.write({
      level: "debug",
      category: "http",
      op: "http.gateway.egress.planned",
      extra: {
        endpoint: logEndpointHost(target),
        proxied: proxy !== undefined,
        proxyEndpoint: logEndpointHost(proxy),
        transport: usesRealTransport ? "native" : "injected",
      },
    });
  }
  return { doFetch, target, usesRealTransport, proxy };
}

// Compose caller signal + optional timeout into a single signal for all paths.
//
// `redirect: "manual"` is forced on every request and is the load-bearing half of the redirect
// posture: fetch itself never connects to a Location target, so a 3xx is handed back to the caller
// unvalidated. Callers MAY follow redirects manually (update-portable staging's safeRedirectUrl,
// the research egress port's redirectTarget both do) — but a follower MUST re-enter gatewayFetch
// for each hop, so the target is re-vetted by the full DNS/address-pinning egress policy on the hop
// that actually connects to it. Following a Location with a raw fetch would bypass that boundary
// entirely (#3348 audit).
function gatewayRequestInit(rest: RequestInit, timeoutMs: number | undefined): RequestInit {
  const composedSignal = composeSignal(rest.signal, timeoutMs);
  return composedSignal !== undefined
    ? { ...rest, redirect: "manual", signal: composedSignal }
    : { ...rest, redirect: "manual" };
}

// The fetch itself. Split out of `gatewayFetch` so the outcome line can wrap it without pushing
// either half past the function-length budget.
async function performGatewayFetch(url: string, options: GatewayFetchOptions): Promise<Response> {
  const {
    fetchImpl,
    useCaFallback = fetchImpl === undefined,
    egress,
    timeoutMs,
    maxResponseBytes,
    log: logOption,
    ...rest
  } = options;
  const log = resolveLogSink(logOption);
  const init = gatewayRequestInit(rest, timeoutMs);
  const plan = planGatewayProxy(url, fetchImpl, egress, log);
  refuseUndelegatedProxiedHostnameEgress(plan.target, plan.proxy, egress);
  refuseUnpinnableResearchEgress(plan.proxy, egress);
  const dns = await resolveGatewayDns(plan, egress);
  if (plan.proxy !== undefined) {
    const response = await fetchViaProxy(
      plan.target,
      init,
      plan.proxy,
      egress,
      maxResponseBytes,
      dns.proxyPinnedAddress,
    );
    return response;
  }
  const response = await fetchDirectWithCaFallback(url, init, {
    doFetch: plan.doFetch,
    useCaFallback,
    egress,
    maxResponseBytes,
    pinnedAddresses: dns.pinnedAddresses,
    log,
  });
  return response;
}

// Size of the request body for the attempt line, for the shapes this transport sends verbatim —
// a JSON string, or bytes for a multipart audio payload. Anything else reports nothing rather
// than being coerced to find out: serialising a body to measure it costs an allocation on the hot
// path, and reading a stream to count it would consume the body the call is about to send. No
// size field is worth changing what goes on the wire, and an absent field is honest.
//
// BYTES, not characters. `String.length` counts UTF-16 code units, so it under-reports every
// multi-byte character an embedding payload is full of — CJK text, accented European text and
// emoji all send roughly two to four times the bytes it claims — and the field exists to be
// compared against a gateway's request-size limit. `Buffer.byteLength` measures the UTF-8 encoding
// without allocating a copy of the body.
function requestBodyBytes(body: BodyInit | null | undefined): number | undefined {
  if (typeof body === "string") return Buffer.byteLength(body, "utf8");
  if (body instanceof Uint8Array) return body.byteLength;
  if (body instanceof Blob) return body.size;
  return undefined;
}

// THE ATTEMPT LINE — the one this whole file exists for.
//
// Every other line in this module is written when a call RETURNS. A request that never returns is
// exactly the incident being diagnosed (a wedged proxy CONNECT, a gateway that accepts the
// connection and then goes quiet), and it produces no completion, no failure, and therefore no
// evidence at all: the log stays empty for precisely the window an operator is staring at. This
// line is written BEFORE the socket work starts, so a stuck call leaves a `started` with no
// matching `completed` — which names both the endpoint and the deadline it is hanging against.
//
// `info`, not `debug`: a line only readable after an operator has already reproduced the hang
// under a raised threshold is not evidence of the hang.
function logFetchStarted(
  log: ModelGatewayLogSink,
  url: string,
  options: GatewayFetchOptions,
): void {
  if (!logLevelEnabled(log, "info")) return;
  log.write({
    level: "info",
    category: "http",
    op: "http.gateway.fetch.started",
    extra: {
      endpoint: logEndpointHost(url),
      method: options.method ?? "GET",
      requestBytes: requestBodyBytes(options.body),
      timeoutMs: options.timeoutMs,
    },
  });
}

// THE OUTCOME LINE — `info` for a successful response, `warn` for an answered error.
//
// A 2xx completion used to be `debug`, which meant that at the default `info` threshold a healthy
// outbound request produced NOTHING: the attempt line went out and the log fell silent whether the
// request came back in 40ms or never came back at all. That is precisely the distinction an
// operator staring at a frozen run needs — "requests are flowing, the gateway is just slow" versus
// "nothing is being sent" versus "one request went out and never returned" — and it is unanswerable
// from a log that only records failures. The pairing is the evidence: a `started` with a matching
// `completed` is a call that returned, and a `started` without one is the wedge.
//
// The volume is bounded by network round-trips, not by data: one line per outbound HTTP call, on a
// path that has just paid TLS and a socket. Genuinely per-item chatter stays at `debug` and behind
// `logLevelEnabled` — the route-planning line below (one per call, pure configuration echo, no
// news once the deployment is understood) and the circuit breaker's repeat refusals in
// `resilience.ts`, which multiply by caller rather than by round-trip.
function logFetchCompleted(
  log: ModelGatewayLogSink,
  url: string,
  response: Response,
  durationMs: number,
): void {
  const level = response.ok ? "info" : "warn";
  if (!logLevelEnabled(log, level)) return;
  log.write({
    level,
    category: "http",
    op: "http.gateway.fetch.completed",
    status: response.status,
    durationMs,
    extra: { endpoint: logEndpointHost(url) },
  });
}

// Outcome line for one outbound gateway call, paired with the attempt line above. `errorKind`
// carries the egress taxonomy code verbatim (`PROXY_BLOCKED_BY_POLICY`, `PROXY_UNREACHABLE`,
// `TLS_CA_FAILURE`, …), which is how every fail-closed rejection in this module — literal-address
// policy, DNS-resolved-to-blocked, unpinnable research egress, missing pinned address, oversized
// CONNECT header — becomes visible without threading a sink through each individual guard.
export async function gatewayFetch(
  url: string,
  options: GatewayFetchOptions = {},
): Promise<Response> {
  // `logContext` is separated from the transport options here, once, for two reasons: the sink
  // every line below writes through is bound to its correlation id (see `withCorrelationId`), and
  // the remaining options are the ones that may reach `RequestInit` — a correlation id must never
  // travel on the wire.
  const { logContext, ...fetchOptions } = options;
  const log = withCorrelationId(resolveLogSink(options.log), logContext?.correlationId);
  const elapsed = logTimer();
  logFetchStarted(log, url, options);
  try {
    const response = await performGatewayFetch(url, { ...fetchOptions, log });
    logFetchCompleted(log, url, response, elapsed());
    return response;
  } catch (error) {
    log.write({
      level: "warn",
      category: "http",
      op: "http.gateway.fetch.failed",
      durationMs: elapsed(),
      errorKind: logErrorKind(error),
      extra: {
        endpoint: logEndpointHost(url),
        ...(error instanceof OutboundHttpEgressError && error.policyReason !== undefined
          ? { policyReason: error.policyReason }
          : {}),
      },
    });
    throw error;
  }
}

export async function readJsonCapped(
  response: Response,
  maxBytes: number = MAX_RESPONSE_BYTES,
): Promise<unknown> {
  if (response.body === null) {
    return response.json();
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let total = 0;
  // The stream's own `done` flag terminates the loop directly, so no single defect in the body
  // can detach the loop from the source and spin it hot on an already-settled reader.
  let done = false;
  while (!done) {
    const result = await reader.read();
    done = result.done;
    const value = result.value;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("response body exceeded the size limit");
    }
    parts.push(decoder.decode(value, { stream: true }));
  }
  parts.push(decoder.decode());
  return JSON.parse(parts.join("")) as unknown;
}

// Reads a binary response body into a single `ArrayBuffer`-backed `Uint8Array`, capping the
// cumulative size exactly like `readJsonCapped`. Used by the text-to-speech adapter (Issue #1558) to
// pull synthesized audio off the provider response without buffering an unbounded payload: a provider
// that streams more than `maxBytes` is aborted and rejected rather than exhausting memory (the same
// bounded-egress guarantee every other gateway call inherits, ADR-0038/ADR-0100 D4). The returned
// array is `ArrayBuffer`-backed so it is a valid `BodyInit`/`BufferSource` for downstream consumers
// without a type assertion.
export async function readBytesCapped(
  response: Response,
  maxBytes: number = MAX_RESPONSE_BYTES,
): Promise<Uint8Array<ArrayBuffer>> {
  if (response.body === null) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) {
      throw new Error("response body exceeded the size limit");
    }
    return new Uint8Array(buffer);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  // Same loop shape as readJsonCapped: `done` drives the loop condition itself.
  let done = false;
  while (!done) {
    const result = await reader.read();
    done = result.done;
    const value = result.value;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("response body exceeded the size limit");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

// Splits an SSE buffer on newlines, keeping the trailing partial line (no newline yet)
// for the next read. Returns the complete lines and the leftover remainder so a
// `data: {...}` payload split across two reads is never parsed half-formed.
function splitSseBuffer(buffer: string): {
  readonly lines: readonly string[];
  readonly rest: string;
} {
  const segments = buffer.split("\n");
  const rest = segments.pop() ?? "";
  return { lines: segments, rest };
}

// Yields the parsed JSON payload of a single complete SSE line, or a sentinel.
// "done" → the stream's `data: [DONE]` terminator; "skip" → blank or non-data line.
type SseLineResult =
  | { readonly kind: "value"; readonly value: unknown }
  | { readonly kind: "done" }
  | { readonly kind: "skip" };

function parseSseLine(rawLine: string): SseLineResult {
  const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
  if (line.length === 0 || !line.startsWith("data:")) {
    return { kind: "skip" };
  }
  const payload = line.slice("data:".length).trimStart();
  if (payload === "[DONE]") {
    return { kind: "done" };
  }
  return { kind: "value", value: JSON.parse(payload) as unknown };
}

// Reads a Server-Sent-Events response as a stream of parsed JSON `data:` payloads.
// Incomplete lines are buffered across reads; `data: [DONE]` terminates; cumulative
// bytes are capped exactly like readJsonCapped. A null body yields nothing.
// Raised when an SSE stream produces no chunk within the idle window. Deliberately
// a plain transport-layer error: the provider adapter maps it onto the typed,
// secret-redacting TimeoutError of the gateway error taxonomy.
export class SseIdleTimeoutError extends Error {
  constructor(idleTimeoutMs: number) {
    super(`SSE stream produced no chunk for ${String(idleTimeoutMs)}ms`);
    this.name = "SseIdleTimeoutError";
  }
}

// Races one read against the idle window. On timeout the reader is CANCELLED
// first — that settles the pending read and releases the underlying body — and
// only then does the error surface, so a stalled provider stream can never leak
// its fetch body past the throw.
const IDLE_TIMEOUT_MARKER: unique symbol = Symbol("sse-idle-timeout");

async function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleTimeoutMs: number | undefined,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (idleTimeoutMs === undefined) {
    return reader.read();
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const idle = new Promise<typeof IDLE_TIMEOUT_MARKER>((resolveIdle) => {
    timer = setTimeout(() => {
      resolveIdle(IDLE_TIMEOUT_MARKER);
    }, idleTimeoutMs);
  });
  try {
    const result = await Promise.race([reader.read(), idle]);
    if (result === IDLE_TIMEOUT_MARKER) {
      // Cancelling settles the pending read and releases the underlying body,
      // so a stalled provider stream can never leak its fetch body past the throw.
      void reader.cancel().catch(() => undefined);
      throw new SseIdleTimeoutError(idleTimeoutMs);
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}

export async function* readSseStream(
  response: Response,
  maxBytes: number = MAX_RESPONSE_BYTES,
  idleTimeoutMs?: number,
): AsyncGenerator {
  if (response.body === null) {
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let total = 0;
  // Same loop shape as readJsonCapped: `done` drives the loop condition itself.
  let done = false;
  while (!done) {
    const read = await readWithIdleTimeout(reader, idleTimeoutMs);
    done = read.done;
    const value = read.value;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("response body exceeded the size limit");
    }
    buffer += decoder.decode(value, { stream: true });
    const { lines, rest } = splitSseBuffer(buffer);
    buffer = rest;
    for (const line of lines) {
      const result = parseSseLine(line);
      if (result.kind === "done") return;
      if (result.kind === "value") yield result.value;
    }
  }
  const tail = parseSseLine(buffer + decoder.decode());
  if (tail.kind === "value") yield tail.value;
}
