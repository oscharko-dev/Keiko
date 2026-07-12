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
  normalizeHost,
  outboundAddressBlockedReason,
  outboundTargetBlockedReason,
} from "./egress-policy.js";
import type { OutboundHttpEgressConfig } from "./types.js";

export type { OutboundHttpEgressConfig } from "./types.js";

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
}

export type OutboundHttpEgressErrorCode =
  | "PROXY_UNREACHABLE"
  | "PROXY_AUTH_REQUIRED"
  | "PROXY_EGRESS_FAILED"
  | "PROXY_BLOCKED_BY_POLICY"
  | "TLS_CA_FAILURE";

export class OutboundHttpEgressError extends Error {
  readonly code: OutboundHttpEgressErrorCode;

  constructor(code: OutboundHttpEgressErrorCode, message: string) {
    super(message);
    this.name = "OutboundHttpEgressError";
    this.code = code;
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

function blockedTargetError(reason: string): OutboundHttpEgressError {
  return new OutboundHttpEgressError(
    "PROXY_BLOCKED_BY_POLICY",
    `Outbound target is blocked by gateway egress policy (${reason}).`,
  );
}

function redirectTarget(original: URL, response: Response): URL | undefined {
  if (response.status < 300 || response.status >= 400) return undefined;
  const location = response.headers.get("location");
  if (location === null || location.trim().length === 0) return undefined;
  try {
    return new URL(location, original);
  } catch {
    throw new OutboundHttpEgressError(
      "PROXY_BLOCKED_BY_POLICY",
      "Outbound redirect target is invalid.",
    );
  }
}

async function enforceRedirectTargetPolicy(
  original: URL,
  response: Response,
  egress: OutboundHttpEgressConfig | undefined,
  options: { readonly resolveDns: boolean },
): Promise<URL | undefined> {
  const redirected = redirectTarget(original, response);
  if (redirected === undefined) return undefined;
  await enforceOutboundTargetPolicy(redirected, egress, options);
  return redirected;
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

function openProxySocket(
  proxy: URL,
  ca: readonly string[],
  signal: AbortSignal | undefined,
): Promise<Socket> {
  const host = proxy.hostname;
  const port = proxyPort(proxy);
  return new Promise<Socket>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const onConnect = (): void => {
      settle(() => {
        resolve(socket);
      });
    };
    const onError = (error: Error): void => {
      settle(() => {
        reject(mapProxyError(error));
      });
    };
    const onAbort = (): void => {
      socket.destroy();
      settle(() => {
        reject(PROXY_UNREACHABLE_ERROR);
      });
    };
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
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const rest = buffer.subarray(headerEnd + 4);
      if (rest.length > 0) socket.unshift(rest);
      settle(() => {
        resolve(buffer.subarray(0, headerEnd).toString("latin1"));
      });
    };
    const onError = (error: Error): void => {
      settle(() => {
        reject(mapProxyError(error));
      });
    };
    const onAbort = (): void => {
      socket.destroy();
      settle(() => {
        reject(PROXY_UNREACHABLE_ERROR);
      });
    };
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
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const onError = (error: Error): void => {
      settle(() => {
        reject(mapProxyError(error));
      });
    };
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
): Promise<tls.TLSSocket> {
  const socket = await openProxySocket(proxy, ca, signal);
  const authority = `${target.hostname}:${targetPort(target)}`;
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

function httpsProxyTunnelKey(target: URL, proxy: URL, ca: readonly string[]): string {
  const caKey = ca.map((cert) => `${String(cert.length)}:${cert.slice(0, 32)}`).join("|");
  return `${proxy.protocol}//${proxy.host}|${target.protocol}//${target.host}|${caKey}`;
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

async function fetchHttpViaProxy(
  target: URL,
  init: RequestInit,
  proxy: URL,
  ca: readonly string[],
  maxResponseBytes?: number,
): Promise<Response> {
  const body = await bodyToWire(init.body);
  const headers = headersToRecord(init.headers);
  if (hasForwardedCredentialHeader(headers)) {
    throw new OutboundHttpEgressError(
      "PROXY_BLOCKED_BY_POLICY",
      "Refusing to forward credential headers to a plaintext HTTP target through the configured proxy.",
    );
  }
  // Ensure Host header omits the default port (fixes SigV4 pre-signed S3 URLs).
  if (!Object.prototype.hasOwnProperty.call(headers, "host")) {
    headers.host = hostHeader(target);
  }
  const request = proxy.protocol === "https:" ? httpsRequest : httpRequest;
  const cap = maxResponseBytes ?? MAX_RESPONSE_BYTES;
  return responseFromClientRequest((resolve, reject) => {
    const req = request(
      {
        protocol: proxy.protocol,
        hostname: proxy.hostname,
        port: proxyPort(proxy),
        method: init.method ?? "GET",
        path: target.href,
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
  maxResponseBytes?: number,
): Promise<Response> {
  const body = await bodyToWire(init.body);
  const headers = headersToRecord(init.headers);
  if (!Object.prototype.hasOwnProperty.call(headers, "connection")) {
    headers.connection = "keep-alive";
  }
  // Ensure Host header omits :443 so it matches what undici sends directly and
  // satisfies SigV4 pre-signed S3 URLs behind a proxy.
  if (!Object.prototype.hasOwnProperty.call(headers, "host")) {
    headers.host = hostHeader(target);
  }
  const tunnelKey = httpsProxyTunnelKey(target, proxy, ca);
  const socket =
    takeIdleHttpsProxyTunnel(tunnelKey) ??
    (await createTlsTunnel(target, proxy, ca, init.signal ?? undefined));
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
  proxyRaw: string,
  egress: OutboundHttpEgressConfig | undefined,
  maxResponseBytes?: number,
): Promise<Response> {
  const proxy = parseProxyUrl(proxyRaw);
  const ca = gatewayTrustedCaCertificates(egress?.caBundlePath);
  return target.protocol === "https:"
    ? fetchHttpsViaProxy(target, init, proxy, ca, maxResponseBytes)
    : fetchHttpViaProxy(target, init, proxy, ca, maxResponseBytes);
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

// Extracted from fetchDirectWithCaFallback to keep its cyclomatic complexity within the limit.
async function attemptCaBundleFallback(
  url: string,
  init: RequestInit,
  egress: OutboundHttpEgressConfig | undefined,
  maxResponseBytes: number | undefined,
  pinnedAddresses: readonly LookupAddress[] | undefined,
): Promise<Response> {
  try {
    return await fetchWithCaBundle(
      url,
      init,
      egress,
      maxResponseBytes,
      pinnedAddresses !== undefined ? pinnedLookup(pinnedAddresses) : undefined,
    );
  } catch (fallbackError) {
    if (isRecoverableTlsTrustError(fallbackError)) {
      throw tlsCaFailureError();
    }
    throw fallbackError;
  }
}

// Extracted from gatewayFetch to keep its cyclomatic complexity within the limit.
async function fetchDirectWithCaFallback(
  url: string,
  init: RequestInit,
  doFetch: typeof fetch,
  useCaFallback: boolean,
  egress: OutboundHttpEgressConfig | undefined,
  maxResponseBytes: number | undefined,
  pinnedAddresses: readonly LookupAddress[] | undefined,
): Promise<Response> {
  try {
    return await attemptPrimaryFetch(url, init, doFetch, maxResponseBytes, pinnedAddresses);
  } catch (error) {
    if (useCaFallback && usesHttps(url) && isRecoverableTlsTrustError(error)) {
      return attemptCaBundleFallback(url, init, egress, maxResponseBytes, pinnedAddresses);
    }
    if (usesHttps(url) && isRecoverableTlsTrustError(error)) {
      throw tlsCaFailureError();
    }
    throw error;
  }
}

export async function gatewayFetch(
  url: string,
  options: GatewayFetchOptions = {},
): Promise<Response> {
  const {
    fetchImpl,
    useCaFallback = fetchImpl === undefined,
    egress,
    timeoutMs,
    maxResponseBytes,
    ...rest
  } = options;
  // Compose caller signal + optional timeout into a single signal for all paths.
  const composedSignal = composeSignal(rest.signal, timeoutMs);
  const init: RequestInit =
    composedSignal !== undefined
      ? { ...rest, redirect: "manual", signal: composedSignal }
      : { ...rest, redirect: "manual" };
  const doFetch = fetchImpl ?? globalThis.fetch;
  const target = new URL(url);
  const proxy = fetchImpl === undefined ? proxyForTarget(target, egress) : undefined;
  const resolveDns = fetchImpl === undefined && proxy === undefined && doFetch === NATIVE_FETCH;
  const pinnedAddresses = await enforceOutboundTargetPolicy(target, egress, { resolveDns });
  const redirectPolicy = { resolveDns };
  if (proxy !== undefined) {
    const response = await fetchViaProxy(target, init, proxy, egress, maxResponseBytes);
    await enforceRedirectTargetPolicy(target, response, egress, redirectPolicy);
    return response;
  }
  const response = await fetchDirectWithCaFallback(
    url,
    init,
    doFetch,
    useCaFallback,
    egress,
    maxResponseBytes,
    pinnedAddresses,
  );
  await enforceRedirectTargetPolicy(target, response, egress, redirectPolicy);
  return response;
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
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
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
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
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
  for (;;) {
    const { done, value } = await readWithIdleTimeout(reader, idleTimeoutMs);
    if (done) break;
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
