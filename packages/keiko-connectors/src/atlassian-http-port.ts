// Injectable Atlassian transport seam (Issue #2241, ADR-0128 D1/D3).
//
// `keiko-connectors` performs no network egress by construction, exactly mirroring
// `keiko-local-knowledge`'s trust-9 posture: this file declares the port ONLY. The concrete
// adapter lives in `keiko-server` (the sole composition root), is built from the shared
// proxy/CA-aware `gatewayFetch` transport (ADR-0038), closes over the resolved credential and the
// connector's single allowlisted host, and issues requests with no redirect following.
//
// The port is credential-blind: a request carries the target URL and a bounded timeout, never an
// Authorization value — the adapter materialises the header from the narrow execution resolver
// immediately before the platform fetch call (ADR-0128 D2). The result is a closed, content-free
// union: a status code or a typed transport classification. There is deliberately NO field that
// could carry a response body, response headers, or an upstream error message, so nothing read
// through this port can leak content into evidence, diagnostics, or wire responses. (#2243's sync
// adapters extend this seam with capped body reading; the custody/verify lane never reads bodies.)

export interface AtlassianHttpRequest {
  readonly method: "GET";
  // Absolute https URL on the connector's configured base URL. The adapter re-validates that the
  // URL targets the connector's sole allowlisted host before any connection is attempted
  // (ADR-0128 D3 defense in depth — the same check the URL builder already enforced).
  readonly url: string;
  // Bounded per-request budget; the adapter clamps it to a hard ceiling.
  readonly timeoutMs: number;
}

export type AtlassianHttpResult =
  | { readonly kind: "response"; readonly status: number }
  | { readonly kind: "timeout" }
  | { readonly kind: "network-error" };

export type AtlassianHttpPort = (request: AtlassianHttpRequest) => Promise<AtlassianHttpResult>;

// ─── Bounded-body channel (Issues #2242/#2244, ADR-0128 D3/D5) ────────────────
//
// Two consumers read response content through this channel, each under two independent byte
// gates: the sync lane (GET — the adapter enforces the per-response cap `maxBodyBytes`, stopping
// the stream read at the cap and never buffering past it, while the orchestration derives each
// request's cap from the run's remaining cumulative byte budget) and the governed write
// executors (#2244 — POST/PUT with a bounded JSON request body, reading back only the minimal
// created-id/version/transition-list payloads under a small response cap). The result stays
// credential-blind and header-blind: a decoded UTF-8 body (JSON from the connector's own
// allowlisted host), the byte count actually read, a truncation flag, and — for 429/5xx backoff
// only — the `Retry-After` header parsed into a non-negative millisecond number. No raw header
// text, no upstream error message.

// Hard ceiling on one serialized JSON request body (ADR-0128 D3 bounded egress). The composers
// bound their output well below this; the executors enforce it as a typed `bounds-exceeded`
// failure, and the server adapter re-checks it fail-closed (defense in depth).
export const ATLASSIAN_HTTP_REQUEST_BODY_MAX_BYTES = 1_000_000;

export interface AtlassianHttpBodyRequest {
  // GET for reads; POST/PUT for the governed write executors (#2244). The adapter refuses a
  // request body on GET.
  readonly method: "GET" | "POST" | "PUT";
  // Absolute https URL on the connector's configured base URL (same allowlist re-check as the
  // body-less channel).
  readonly url: string;
  readonly timeoutMs: number;
  // Per-response body cap in bytes. The adapter MUST stop reading at the cap (truncated: true)
  // rather than buffering the full payload and slicing afterwards.
  readonly maxBodyBytes: number;
  // Serialized JSON request body for POST/PUT, bounded by ATLASSIAN_HTTP_REQUEST_BODY_MAX_BYTES.
  // Never a credential — the Authorization header is materialised by the adapter only.
  readonly bodyJson?: string | undefined;
  // Run-level cancellation (ADR-0128 D5): the adapter composes this with its own timeout so an
  // aborted sync run tears down the in-flight request instead of waiting it out.
  readonly signal?: AbortSignal | undefined;
}

export type AtlassianHttpBodyResult =
  | {
      readonly kind: "response";
      readonly status: number;
      // Decoded UTF-8 body read up to `maxBodyBytes`. Empty for bodyless responses (e.g. 3xx —
      // which the adapter surfaces and never follows).
      readonly bodyText: string;
      // Bytes actually read from the stream (≤ maxBodyBytes).
      readonly bodyBytes: number;
      readonly truncated: boolean;
      // Parsed `Retry-After` (delay-seconds or HTTP-date) as milliseconds-from-now, when present
      // and valid. A parsed number only — the raw header value never crosses the port.
      readonly retryAfterMs?: number | undefined;
    }
  | { readonly kind: "timeout" }
  | { readonly kind: "network-error" };

export type AtlassianHttpBodyPort = (
  request: AtlassianHttpBodyRequest,
) => Promise<AtlassianHttpBodyResult>;
