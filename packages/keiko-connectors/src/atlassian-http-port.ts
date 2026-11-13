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

import type { JiraHumanInputHttpRequest } from "./jira-private-identity-ports.js";

export interface AtlassianHttpRequest {
  readonly method: "GET";
  // Absolute https URL on the connector's configured base URL. The adapter re-validates that the
  // URL targets the connector's sole allowlisted host before any connection is attempted
  // (ADR-0128 D3 defense in depth — the same check the URL builder already enforced).
  readonly url: string;
  // Bounded per-request budget; the adapter clamps it to a hard ceiling.
  readonly timeoutMs: number;
}

/**
 * Server-owned result of the identity read that decides a 401 (never upstream content):
 * `confirmed` means the credential is valid, so the 401 was a missing permission; `unconfirmed`
 * means the check could not settle, so the credential is kept and the 401 stays unexplained.
 */
export type AtlassianAuthenticationObservation = "confirmed" | "unconfirmed";

/**
 * Closed fact the transport derives from a 401's response headers, never the header values:
 * `jira` means Jira authored it (its request id and the anonymous user marker, no denial reason),
 * `denied` means Jira refused the login for another reason (a captcha challenge, a lock), and
 * `foreign` means something else answered (a single sign-on proxy, a gateway, a load balancer).
 * Only `jira` can show that the token itself was rejected.
 */
export type AtlassianAuthenticationFailure = "jira" | "denied" | "foreign";

export type AtlassianHttpResult =
  | {
      readonly kind: "response";
      readonly status: number;
      readonly authentication?: AtlassianAuthenticationObservation;
      readonly authenticationFailure?: AtlassianAuthenticationFailure;
    }
  | { readonly kind: "timeout" }
  | { readonly kind: "network-error"; readonly reason?: "tls" };

export type AtlassianHttpPort = (request: AtlassianHttpRequest) => Promise<AtlassianHttpResult>;

// ─── Bounded-body channel (Issues #2242/#2244, ADR-0128 D3/D5) ────────────────
//
// Two consumers read response content through this channel, each under two independent byte
// gates: the sync lane (GET — the adapter enforces the per-response cap `maxBodyBytes`, stopping
// the stream read at the cap and never buffering past it, while the orchestration derives each
// request's cap from the run's remaining cumulative byte budget) and the governed write
// executors (#2244 — POST/PUT with bounded JSON, or bodyless DELETE, reading back only the minimal
// created-id/version/transition-list payloads under a small response cap). The result stays
// credential-blind and header-blind: a decoded UTF-8 body (JSON from the connector's own
// allowlisted host), the byte count actually read, a truncation flag, and — for 429/5xx backoff
// only — the `Retry-After` header parsed into a non-negative millisecond number. The sole private
// version exception is a bounded strong applicationrole ETag under its fixed CAS request flag;
// it never enters tool results or logs. No generic response header map is exposed.

// Hard ceiling on one serialized JSON request body (ADR-0128 D3 bounded egress). The composers
// bound their output well below this; the executors enforce it as a typed `bounds-exceeded`
// failure, and the server adapter re-checks it fail-closed (defense in depth).
export const ATLASSIAN_HTTP_REQUEST_BODY_MAX_BYTES = 1_000_000;

// A governed file upload (#4176): one multipart/form-data POST whose bytes the caller already
// admitted and bounded. The adapter accepts it only on POST, only with a multipart content type, and
// adds the transport header Jira requires for it; it is mutually exclusive with `bodyJson`.
export const ATLASSIAN_HTTP_UPLOAD_MAX_BYTES = 24 * 1024 * 1024;
/** Private native collection version. Never a tool argument, receipt or diagnostic field. */
export function isAtlassianApplicationRoleVersion(value: unknown): value is string {
  return typeof value === "string" && /^"[\x21\x23-\x5b\x5d-\x7e]{1,254}"$/u.test(value);
}
export type AtlassianApplicationRoleRequest = "version" | { readonly ifMatch: string };
export interface AtlassianHttpUpload {
  readonly contentType: string;
  readonly bytes: Uint8Array<ArrayBuffer>;
}

export interface AtlassianHttpBodyRequest {
  // The fixed operation contract determines effects; POST search/worklog selection are reads.
  // GET and DELETE carry no request body.
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
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
  // Bounded multipart POST, or fixed email-template ZIP POST with its separate closed flag.
  readonly upload?: AtlassianHttpUpload | undefined;
  /** Server-owned opt-in for the two documented experimental sprint-unmap PUT identities only. */
  readonly jiraExperimental?: true | undefined;
  /** Closed native text/plain boolean PUT; never a caller-provided content type or header. */
  readonly jiraPermissionAttribute?: true | undefined;
  /** Fixed email-template ZIP GET/POST only; never an arbitrary binary response or upload. */
  readonly jiraEmailTemplateArchive?: true | undefined;
  /** Fixed applicationrole GET version / PUT native CAS only. */
  readonly jiraApplicationRole?: AtlassianApplicationRoleRequest | undefined;
  /** Fixed query-only experimental user/application POST/DELETE only. */
  readonly jiraUserApplication?: true | undefined;
  /** Fixed user/columns PUT form, with a bound username and ordered repeated columns. */
  readonly jiraUserColumns?: true | undefined;
  /** Fixed experimental UserResource POST/PUT/DELETE only. */
  readonly jiraIdentityExperimental?: true | undefined;
  /** Fixed experimental project priority GET/PUT/DELETE only. */
  readonly jiraProjectPriority?: true | undefined;
  /** Private server selection only; never serialized secret body bytes. */
  readonly jiraHumanInput?: JiraHumanInputHttpRequest | undefined;
  /** Fixed raw PNG/JPEG temporary upload; requires the private cookie-session transport. */
  readonly jiraAvatarImage?: true | undefined;
  // Run-level cancellation (ADR-0128 D5): the adapter composes this with its own timeout so an
  // aborted sync run tears down the in-flight request instead of waiting it out.
  readonly signal?: AbortSignal | undefined;
}

export type AtlassianHttpBodyResult =
  | {
      readonly kind: "response";
      readonly status: number;
      /** Server-owned identity proof for a documented ambiguous 401; never upstream content. */
      readonly authentication?: AtlassianAuthenticationObservation;
      /** Server-owned classification of a 401's origin; see `AtlassianAuthenticationFailure`. */
      readonly authenticationFailure?: AtlassianAuthenticationFailure;
      // Decoded UTF-8 body read up to `maxBodyBytes`; empty for a fixed archive download.
      // Empty for bodyless responses (e.g. 3xx —
      // which the adapter surfaces and never follows).
      readonly bodyText: string;
      /** Exact bytes only for an admitted successful email-template ZIP download. */
      readonly archiveBytes?: Uint8Array<ArrayBuffer>;
      /** Strong bounded ETag only for an explicitly admitted applicationrole collection GET. */
      readonly applicationRoleVersion?: string;
      // Bytes actually read from the stream (≤ maxBodyBytes).
      readonly bodyBytes: number;
      readonly truncated: boolean;
      // Parsed `Retry-After` (delay-seconds or HTTP-date) as milliseconds-from-now, when present
      // and valid. A parsed number only — the raw header value never crosses the port.
      readonly retryAfterMs?: number | undefined;
    }
  | { readonly kind: "timeout" }
  | { readonly kind: "network-error"; readonly reason?: "tls" };

export type AtlassianHttpBodyPort = (
  request: AtlassianHttpBodyRequest,
) => Promise<AtlassianHttpBodyResult>;
