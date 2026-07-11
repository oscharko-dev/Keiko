// Concrete AtlassianHttpPort adapter (Issue #2241, ADR-0128 D1/D2/D3).
//
// keiko-server is the sole composition root for the Atlassian connector lane: this adapter is
// built from the shared proxy/CA-aware `gatewayFetch` transport (ADR-0038, the same
// `internal/http` subpath the Figma connector port already consumes) and closes over ONE
// connector's base URL and `authRef`.
//
// The resolved secret exists only inside this closure: it is materialised into the
// `Authorization` header by the narrow execution resolver immediately before the platform fetch
// call — it is never logged here and never re-emitted by the port (mirroring the figmaHttpPort
// comment; ADR-0128 D2 write-only rule). The port's result union carries a status code or a typed
// transport classification only — no response body, no response headers, no upstream error text —
// so nothing observed through it can leak content or a reflected credential.
//
// Egress posture (ADR-0128 D3): the connector's base-URL host is the sole allowlisted target,
// re-checked here at request-construction time (defense in depth on top of creation-time
// validation); `gatewayFetch` itself always issues `redirect: "manual"` and re-checks redirect
// targets, so a 3xx is surfaced, never followed.

import {
  ATLASSIAN_HTTP_REQUEST_BODY_MAX_BYTES,
  AtlassianCredentialCustodyError,
  atlassianAuthorizationHeaderValue,
  type AtlassianCredentialExecutionResolver,
  type AtlassianHttpBodyPort,
  type AtlassianHttpBodyRequest,
  type AtlassianHttpBodyResult,
  type AtlassianHttpPort,
  type AtlassianHttpRequest,
  type AtlassianHttpResult,
} from "@oscharko-dev/keiko-connectors";
import { isSafeAtlassianConnectorBaseUrl } from "@oscharko-dev/keiko-contracts";
import {
  gatewayFetch,
  type OutboundHttpEgressConfig,
} from "@oscharko-dev/keiko-model-gateway/internal/http";

// Hard per-request ceiling: the largest ADR-0128 D3 budget (bulk sync pagination). Requests ask
// for less (the verify probe asks for 30 000 ms); a hostile or buggy caller can never widen it.
const MAX_TIMEOUT_MS = 60_000;

export interface CreateAtlassianHttpPortOptions {
  readonly baseUrl: string;
  readonly authRef: string;
  readonly credentials: AtlassianCredentialExecutionResolver;
  // Resolved fresh per request so runtime gateway-config updates are honored immediately.
  readonly egress?: (() => OutboundHttpEgressConfig | undefined) | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}

function boundedTimeoutMs(requested: number): number {
  if (!Number.isFinite(requested) || requested < 1) return 1;
  return Math.min(Math.trunc(requested), MAX_TIMEOUT_MS);
}

// The single-host allowlist re-check (ADR-0128 D3, "enforced twice"): the request URL must be an
// https URL on exactly the connector's base host, with no embedded credentials.
function assertAllowlistedTarget(base: URL, requestUrl: string): URL {
  let target: URL;
  try {
    target = new URL(requestUrl);
  } catch (error) {
    throw new AtlassianCredentialCustodyError(
      "invalid-input",
      ["request URL must be a valid URL"],
      error,
    );
  }
  const allowed =
    target.protocol === "https:" &&
    target.host === base.host &&
    target.username.length === 0 &&
    target.password.length === 0;
  if (!allowed) {
    throw new AtlassianCredentialCustodyError("invalid-input", [
      "request URL must stay on the connector's configured https host",
    ]);
  }
  return target;
}

// AbortSignal.timeout aborts with a DOMException named TimeoutError. Everything else is a
// network-class failure (DNS, refused connection, TLS, proxy, or a blocked redirect target) and
// fails closed as such — the error text is deliberately dropped so no upstream detail can ride
// into diagnostics or wire responses. The narrow return union is assignable to both port result
// unions (body-less and bounded-body).
function classifyTransportError(error: unknown): { kind: "timeout" } | { kind: "network-error" } {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return { kind: "timeout" };
  }
  return { kind: "network-error" };
}

// Best-effort body drain: the custody lane never reads response content, but the stream must be
// released so the connection does not linger.
async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Releasing the unread stream is best-effort only.
  }
}

export function createGatewayAtlassianHttpPort(
  options: CreateAtlassianHttpPortOptions,
): AtlassianHttpPort {
  if (!isSafeAtlassianConnectorBaseUrl(options.baseUrl)) {
    throw new AtlassianCredentialCustodyError("invalid-input", [
      "baseUrl must be an https URL without credentials, query, or fragment",
    ]);
  }
  const base = new URL(options.baseUrl);
  return async (request: AtlassianHttpRequest): Promise<AtlassianHttpResult> => {
    const target = assertAllowlistedTarget(base, request.url);
    // Resolved immediately before the outbound call; never stored on the port instance.
    const credential = options.credentials.resolveForExecution(options.authRef);
    const egress = options.egress?.();
    try {
      const response = await gatewayFetch(target.toString(), {
        method: request.method,
        headers: {
          authorization: atlassianAuthorizationHeaderValue(credential),
          accept: "application/json",
        },
        signal: AbortSignal.timeout(boundedTimeoutMs(request.timeoutMs)),
        ...(egress === undefined ? {} : { egress }),
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      });
      await discardBody(response);
      return { kind: "response", status: response.status };
    } catch (error) {
      return classifyTransportError(error);
    }
  };
}

// ─── Bounded-body channel (Issues #2242/#2244, ADR-0128 D3/D5) ────────────────
// Identical trust posture to the body-less channel above (same allowlist re-check, same
// credential materialisation rule, same redirect fail-closed transport), plus a STREAMED body
// read that stops at the per-request cap — the payload is never buffered past `maxBodyBytes`,
// even transiently. The only header ever surfaced is `Retry-After`, parsed into a bounded
// millisecond number for the ADR-0128 D3 backoff; raw header text never crosses the port. A
// run-cancellation abort classifies as `timeout` here — the sync lane re-checks its own signal
// immediately afterwards, so the run still terminates as cancelled. The governed write lane
// (#2244) sends bounded JSON request bodies over POST/PUT through this same channel; the body is
// re-checked against the shared ceiling here fail-closed (the executors already enforce it with
// typed results).

interface BoundedBodyRead {
  readonly bodyText: string;
  readonly bodyBytes: number;
  readonly truncated: boolean;
}

async function readBodyBounded(response: Response, maxBodyBytes: number): Promise<BoundedBodyRead> {
  const cap = Math.max(0, Math.trunc(maxBodyBytes));
  const reader = response.body?.getReader();
  if (reader === undefined) return { bodyText: "", bodyBytes: 0, truncated: false };
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let text = "";
  let bytes = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    const remaining = cap - bytes;
    if (chunk.value.byteLength >= remaining) {
      text += decoder.decode(chunk.value.subarray(0, Math.max(0, remaining)), { stream: true });
      bytes += Math.min(chunk.value.byteLength, Math.max(0, remaining));
      await reader.cancel().catch(() => undefined);
      return { bodyText: text + decoder.decode(), bodyBytes: bytes, truncated: true };
    }
    text += decoder.decode(chunk.value, { stream: true });
    bytes += chunk.value.byteLength;
  }
  return { bodyText: text + decoder.decode(), bodyBytes: bytes, truncated: false };
}

// Parses `Retry-After` (delay-seconds or HTTP-date) into a non-negative millisecond delay. The
// sync lane caps it again at its own backoff ceiling; invalid or absent values yield undefined.
function parseRetryAfterMs(headerValue: string | null, now: number): number | undefined {
  if (headerValue === null) return undefined;
  const trimmed = headerValue.trim();
  if (/^\d+$/u.test(trimmed)) return Number.parseInt(trimmed, 10) * 1000;
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return undefined;
  return Math.max(0, dateMs - now);
}

function composeBodyRequestSignal(request: AtlassianHttpBodyRequest): AbortSignal {
  const timeout = AbortSignal.timeout(boundedTimeoutMs(request.timeoutMs));
  return request.signal === undefined ? timeout : AbortSignal.any([timeout, request.signal]);
}

// Write-channel request-body guard (Issue #2244, ADR-0128 D3): a JSON body may only accompany
// POST/PUT and never exceeds the shared ceiling. The write executors enforce both rules with
// typed results before ever calling the port; a violation reaching this adapter is a programming
// error and fails closed on the same custody failure surface as an invalid URL.
function assertValidRequestBody(request: AtlassianHttpBodyRequest): void {
  if (request.bodyJson === undefined) return;
  if (request.method === "GET") {
    throw new AtlassianCredentialCustodyError("invalid-input", [
      "a request body is not allowed on GET",
    ]);
  }
  if (Buffer.byteLength(request.bodyJson, "utf8") > ATLASSIAN_HTTP_REQUEST_BODY_MAX_BYTES) {
    throw new AtlassianCredentialCustodyError("invalid-input", [
      "request body exceeds the write-channel size ceiling",
    ]);
  }
}

export function createGatewayAtlassianHttpBodyPort(
  options: CreateAtlassianHttpPortOptions,
): AtlassianHttpBodyPort {
  if (!isSafeAtlassianConnectorBaseUrl(options.baseUrl)) {
    throw new AtlassianCredentialCustodyError("invalid-input", [
      "baseUrl must be an https URL without credentials, query, or fragment",
    ]);
  }
  const base = new URL(options.baseUrl);
  return async (request: AtlassianHttpBodyRequest): Promise<AtlassianHttpBodyResult> => {
    const target = assertAllowlistedTarget(base, request.url);
    assertValidRequestBody(request);
    // Resolved immediately before the outbound call; never stored on the port instance.
    const credential = options.credentials.resolveForExecution(options.authRef);
    const egress = options.egress?.();
    try {
      const response = await gatewayFetch(target.toString(), {
        method: request.method,
        headers: {
          authorization: atlassianAuthorizationHeaderValue(credential),
          accept: "application/json",
          ...(request.bodyJson === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(request.bodyJson === undefined ? {} : { body: request.bodyJson }),
        signal: composeBodyRequestSignal(request),
        ...(egress === undefined ? {} : { egress }),
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      });
      const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"), Date.now());
      const body = await readBodyBounded(response, request.maxBodyBytes);
      return {
        kind: "response",
        status: response.status,
        bodyText: body.bodyText,
        bodyBytes: body.bodyBytes,
        truncated: body.truncated,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      };
    } catch (error) {
      return classifyTransportError(error);
    }
  };
}
