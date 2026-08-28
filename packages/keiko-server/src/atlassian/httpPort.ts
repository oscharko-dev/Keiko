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
import { isSafeAtlassianConnectorBaseUrl } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  classifyOutboundHost,
  gatewayFetch,
  type OutboundHttpEgressConfig,
} from "@oscharko-dev/keiko-model-gateway/internal/http";

// Hard per-request ceiling: the largest ADR-0128 D3 budget (bulk sync pagination). Requests ask
// for less (the verify probe asks for 30 000 ms); a hostile or buggy caller can never widen it.
const MAX_TIMEOUT_MS = 60_000;

// Issue #3246: on dev run 32563378802 the oversized-body test resolved 200 in one coverage
// shard — the only way `assertValidRequestBody` below can let an oversized body through is the
// imported ceiling not being a finite number in that worker (a build/resolution defect, not a
// request-shaped input). A defect in the imported constant must surface as a load-time throw,
// never as a silently unbounded write-channel body cap, so this runs once, unconditionally, as
// soon as the module is evaluated — before any port can be constructed or any request guarded.
function assertFiniteSafeIntegerCeiling(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a finite positive safe integer`);
  }
}
assertFiniteSafeIntegerCeiling(
  ATLASSIAN_HTTP_REQUEST_BODY_MAX_BYTES,
  "ATLASSIAN_HTTP_REQUEST_BODY_MAX_BYTES",
);

// Exported so the inverted-comparison rejection (below) is unit-testable directly against a
// non-finite ceiling without reaching around the module-load assertion above, which already
// blocks a non-finite `ATLASSIAN_HTTP_REQUEST_BODY_MAX_BYTES` from ever reaching this function in
// a real process. Pure and body-free: byte counts only, never request content.
export function exceedsBodyByteCeiling(bytes: number, ceilingBytes: number): boolean {
  // A non-finite ceiling rejects explicitly: with a bare `bytes > cap`, NaN/undefined fail EVERY comparison including
  // `>`, so `bytes > cap` silently lets an oversized body through when `cap` is not a finite
  // number. The negated form rejects closed on exactly that case.
  return !Number.isFinite(ceilingBytes) || bytes > ceilingBytes;
}

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

// Connector-lane egress posture (KEIKO-0316, hardened #3156). The caller hands us the LIVE
// model-gateway egress config, whose `allowPrivateNetwork` / `allowLinkLocalAndMetadata` opt-ins
// exist for an operator's own approved, customer-hosted MODEL provider. An Atlassian base URL is
// client-supplied through the connector-management routes, so inheriting those opt-ins let a
// connector be pointed at an RFC1918 service or at 169.254.169.254 and turned the `/verify` probe
// into an internal-reconnaissance oracle. Only the transport settings (proxy, CA bundle) carry
// over; neither opt-in is inherited, so private and cloud-metadata targets are blocked for this
// lane whatever the model gateway allows.
//
// `denyLoopback` and `pinProxiedConnectTarget` (ADR-0038 D6) are now BOTH pinned on, together —
// setting either alone reopens a real gap:
//
//  - `denyLoopback` alone, without `pinProxiedConnectTarget`, makes `refuseUnpinnableResearchEgress`
//    throw for EVERY request that has a proxy configured — this is the exact regression already
//    tried and reverted once (see the KEIKO-0316 history this comment used to describe): every
//    Atlassian request failed before transport in any deployment whose proxy covers the connector
//    host, so `denyLoopback` was previously left off entirely.
//  - `pinProxiedConnectTarget` alone, without `denyLoopback`, makes `gatewayFetch` resolve and pin
//    the proxied connect to the vetted address for every OTHER blocked class (private, link-local,
//    metadata — all blocked by default, no opt-in required) but NOT for loopback specifically,
//    since `outboundAddressBlockedReason` only treats a resolved loopback address as blocked when
//    `denyLoopback === true` (egress-policy.ts). Without it, a connector host that DNS-resolves to
//    loopback through a proxy would still reach the proxy unvetted (#3156, Codex + Keiko for
//    Quality independently flagged this exact gap).
//
// Together, the two flags close the proxied-DNS-rebinding gap `isBlockedLoopbackTarget` below
// cannot: that check is a plain hostname-STRING classification (safe unconditionally, proxied or
// not, because it makes no DNS-pinning claim) and only catches a LITERALLY loopback-shaped base
// URL, never a legitimate-looking hostname that merely resolves there. `pinProxiedConnectTarget`
// makes `gatewayFetch` resolve that hostname itself and hand the proxy the vetted address instead
// of a name to re-resolve independently; `denyLoopback` is what makes the loopback CLASS
// specifically count as blocked once resolved. Neither flag does anything to the wire-level CONNECT
// authority when there is no proxy configured (`pinProxiedConnectTarget` requires a proxy to have
// any effect; the direct path already pins via AUDIT-SEC-001), so this is a strict tightening with
// no effect on unproxied deployments.
function connectorEgressConfig(
  base: OutboundHttpEgressConfig | undefined,
): OutboundHttpEgressConfig {
  return {
    ...(base?.httpProxy !== undefined ? { httpProxy: base.httpProxy } : {}),
    ...(base?.httpsProxy !== undefined ? { httpsProxy: base.httpsProxy } : {}),
    ...(base?.noProxy !== undefined ? { noProxy: base.noProxy } : {}),
    ...(base?.caBundlePath !== undefined ? { caBundlePath: base.caBundlePath } : {}),
    denyLoopback: true,
    pinProxiedConnectTarget: true,
  };
}

// KEIKO-0316: an Atlassian base URL is client-supplied through the connector-management routes
// and is not itself checked for address class (isSafeAtlassianConnectorBaseUrl only enforces
// https/no-credentials/no-query/no-fragment). Classified by hostname string only — no DNS
// resolution — so this is safe to apply whatever the egress transport (direct or proxied), unlike
// the gateway's own `denyLoopback` flag. Surfaces as the same closed `network-error` result the
// private/metadata classes already resolve to via gatewayFetch's own policy check, not a thrown
// error, so callers see one consistent "this connector is pointed somewhere it should not be"
// shape regardless of which blocked class tripped.
//
// CLOSED (#3156, was an open residual gap under KEIKO-0316): a DNS NAME that resolves to a blocked
// address (e.g. a connector host pointed at 169.254.169.254, an RFC1918 address, or a loopback
// alias) is caught on the DIRECT transport path, where gatewayFetch resolves and pins the address
// before connecting (`enforceOutboundTargetPolicy` with `resolveDns: true`), and — since
// connectorEgressConfig above now sets `pinProxiedConnectTarget` (ADR-0038 D6) — is caught the same
// way when a proxy is configured too: gatewayFetch resolves the target itself and hands the proxy
// the vetted address instead of a hostname to independently re-resolve, so there is nothing left
// for the proxy to resolve unvetted. `denyLoopback` alongside it is what makes a resolved loopback
// address specifically count as blocked (private/link-local/metadata are blocked by default with
// no opt-in needed either way). See connectorEgressConfig's comment for why both flags are required
// together and neither alone is sufficient.
//
// Residual, accepted scope: a corporate proxy that filters its own CONNECT allowlist by hostname
// rather than by resolved address could reject the IP-literal CONNECT authority this now sends —
// an operator-visible, diagnosable proxy-rejection error, not a silent gap. Weighed against a
// confirmed, silent SSRF/internal-reconnaissance path for a DNS name that only resolves internally
// after configuration (the exact scenario two independent reviewers flagged), fail-closed wins;
// this is a live-deployment compatibility question for an operator to raise if it ever surfaces,
// not a reason to leave the vetting off by default.
function isBlockedLoopbackTarget(target: URL): boolean {
  return classifyOutboundHost(target.hostname) === "loopback";
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
    if (isBlockedLoopbackTarget(target)) return { kind: "network-error" };
    // Resolved immediately before the outbound call; never stored on the port instance.
    const credential = options.credentials.resolveForExecution(options.authRef);
    const egress = connectorEgressConfig(options.egress?.());
    try {
      const response = await gatewayFetch(target.toString(), {
        method: request.method,
        headers: {
          authorization: atlassianAuthorizationHeaderValue(credential),
          accept: "application/json",
        },
        signal: AbortSignal.timeout(boundedTimeoutMs(request.timeoutMs)),
        egress,
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
  const bodyBytes = Buffer.byteLength(request.bodyJson, "utf8");
  if (exceedsBodyByteCeiling(bodyBytes, ATLASSIAN_HTTP_REQUEST_BODY_MAX_BYTES)) {
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
    if (isBlockedLoopbackTarget(target)) return { kind: "network-error" };
    assertValidRequestBody(request);
    // Resolved immediately before the outbound call; never stored on the port instance.
    const credential = options.credentials.resolveForExecution(options.authRef);
    const egress = connectorEgressConfig(options.egress?.());
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
        egress,
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
