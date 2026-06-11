import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import type { IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as netConnect, isIP } from "node:net";
import type { Socket } from "node:net";
import * as tls from "node:tls";
import type { OutboundHttpEgressConfig } from "./types.js";

export type { OutboundHttpEgressConfig } from "./types.js";

// Caps a single gateway response at 10 MB; real chat completions are far smaller.
export const MAX_RESPONSE_BYTES = 10_000_000;

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
  return Array.from(
    new Set([
      ...nodeCaCertificates("default"),
      ...tls.rootCertificates,
      ...nodeCaCertificates("system"),
      ...nodeCaCertificates("extra"),
      ...extraCaCertificates(caBundlePath),
    ]),
  );
}

// Exposed for tests to reset the one-time warning set between runs.
export function _resetWarnedCaBundlePaths(): void {
  warnedCaBundlePaths.clear();
}

function bodyToString(body: BodyInit | null | undefined): string | undefined {
  if (body === undefined || body === null) {
    return undefined;
  }
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof URLSearchParams) {
    return body.toString();
  }
  throw new TypeError("gateway HTTP fallback supports string request bodies only");
}

// Converts a Node IncomingMessage into a streaming web Response, enforcing the
// byte cap inline and destroying the request when the consumer cancels. Unlike a
// Buffer.concat-on-end approach this delivers SSE chunks incrementally (#152), so
// the CA-bundle fallback streams tokens instead of buffering the whole response.
export function streamingResponseFromNode(
  res: import("node:http").IncomingMessage,
  onCancel: () => void,
  maxBytes: number = MAX_RESPONSE_BYTES,
): Response {
  let total = 0;
  let done = false;
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
        done = true;
        controller.close();
      });
      res.on("error", (error) => {
        if (done) return;
        done = true;
        controller.error(error);
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

function fetchWithCaBundle(
  url: string,
  init: RequestInit,
  egress?: OutboundHttpEgressConfig,
  maxResponseBytes?: number,
): Promise<Response> {
  const body = bodyToString(init.body);
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
      },
      (res) => {
        resolve(streamingResponseFromNode(res, () => req.destroy(), cap));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

function normalizeHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[/u, "").replace(/\]$/u, "");
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
  return rule.startsWith(".") && host.endsWith(`.${domain}`);
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
    return new OutboundHttpEgressError(
      "TLS_CA_FAILURE",
      "TLS certificate verification failed for outbound egress.",
    );
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

function responseFromClientRequest(
  start: (resolve: (response: Response) => void, reject: (error: Error) => void) => void,
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    start(resolve, reject);
  });
}

function fetchHttpViaProxy(
  target: URL,
  init: RequestInit,
  proxy: URL,
  ca: readonly string[],
  maxResponseBytes?: number,
): Promise<Response> {
  const body = bodyToString(init.body);
  const headers = headersToRecord(init.headers);
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

async function fetchHttpsViaProxy(
  target: URL,
  init: RequestInit,
  proxy: URL,
  ca: readonly string[],
  maxResponseBytes?: number,
): Promise<Response> {
  const body = bodyToString(init.body);
  const headers = headersToRecord(init.headers);
  if (!Object.prototype.hasOwnProperty.call(headers, "connection")) {
    headers.connection = "close";
  }
  // Ensure Host header omits :443 so it matches what undici sends directly and
  // satisfies SigV4 pre-signed S3 URLs behind a proxy.
  if (!Object.prototype.hasOwnProperty.call(headers, "host")) {
    headers.host = hostHeader(target);
  }
  const socket = await createTlsTunnel(target, proxy, ca, init.signal ?? undefined);
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

// Extracted from gatewayFetch to keep its cyclomatic complexity within the limit.
async function fetchDirectWithCaFallback(
  url: string,
  init: RequestInit,
  doFetch: typeof fetch,
  useCaFallback: boolean,
  egress: OutboundHttpEgressConfig | undefined,
  maxResponseBytes: number | undefined,
): Promise<Response> {
  try {
    return await doFetch(url, init);
  } catch (error) {
    if (useCaFallback && usesHttps(url) && isRecoverableTlsTrustError(error)) {
      return fetchWithCaBundle(url, init, egress, maxResponseBytes);
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
    composedSignal !== undefined ? { ...rest, signal: composedSignal } : rest;
  const doFetch = fetchImpl ?? globalThis.fetch;
  const target = new URL(url);
  const proxy = fetchImpl === undefined ? proxyForTarget(target, egress) : undefined;
  if (proxy !== undefined) {
    return fetchViaProxy(target, init, proxy, egress, maxResponseBytes);
  }
  return fetchDirectWithCaFallback(url, init, doFetch, useCaFallback, egress, maxResponseBytes);
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
export async function* readSseStream(
  response: Response,
  maxBytes: number = MAX_RESPONSE_BYTES,
): AsyncGenerator {
  if (response.body === null) {
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
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
