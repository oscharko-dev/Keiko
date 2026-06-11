// Figma connector error shapes (Epic #750, Issues #751, #758, #760, #884).
//
// Coded, safe errors for the server-side Figma connector. A FigmaConnectorError carries
// ONLY a stable code and a fixed, secret-free message — never the PAT, never a raw Figma
// payload, never an outbound URL or header value. Mirrors the QI connector error posture
// in ../connectorErrors.ts so the route tier can serialise it consistently.
//
// Complete coded taxonomy (#760, #884); every code is user-actionable. Each ticket-named
// category maps to one or more codes below:
//   auth          → FIGMA_TOKEN_MISSING | FIGMA_TOKEN_INVALID | FIGMA_TOKEN_EXPIRED
//                   | FIGMA_TOKEN_REVOKED
//   consent       → FIGMA_CONSENT_REQUIRED (no recorded read-only-scope acknowledgement)
//   scope         → FIGMA_INSUFFICIENT_SCOPE
//   rate-limit    → FIGMA_RATE_LIMITED
//   not-found     → FIGMA_NOT_FOUND
//   oversized     → FIGMA_OVERSIZED_SCOPE | FIGMA_RESPONSE_TOO_LARGE
//   render-failed → FIGMA_RENDER_FAILED
//   proxy egress  → FIGMA_PROXY_UNREACHABLE (proxy host unreachable)
//                   | FIGMA_PROXY_AUTH_REQUIRED (proxy requires authentication)
//                   | FIGMA_PROXY_BLOCKED_BY_POLICY (proxy denied the request by policy)
//                   | FIGMA_PROXY_EGRESS_FAILED (generic proxy egress failure, retained for back-compat)
//   direct egress → FIGMA_NETWORK_UNREACHABLE (DNS/connection/socket error, no proxy)
//                   | FIGMA_EGRESS_TIMEOUT (request timed out before completion)
//                   | FIGMA_EGRESS_FAILED (generic direct egress failure; new default)
//   tls/ca        → FIGMA_TLS_CA_FAILURE (custom-CA / TLS verification failure on egress)
// FIGMA_MALFORMED_URL, FIGMA_UPSTREAM_UNAVAILABLE, and FIGMA_INTERNAL cover input and last-resort
// faults. The proxy-aware + custom-CA HTTP client itself is #802; this connector only SURFACES
// these proxy/TLS codes — it does not implement the proxy transport.

import {
  OutboundHttpEgressError,
  type OutboundHttpEgressErrorCode,
} from "@oscharko-dev/keiko-model-gateway/internal/http";

export type FigmaConnectorErrorCode =
  | "FIGMA_MALFORMED_URL"
  | "FIGMA_TOKEN_MISSING"
  | "FIGMA_CONSENT_REQUIRED"
  | "FIGMA_TOKEN_INVALID"
  | "FIGMA_TOKEN_EXPIRED"
  | "FIGMA_TOKEN_REVOKED"
  | "FIGMA_NOT_FOUND"
  | "FIGMA_INSUFFICIENT_SCOPE"
  | "FIGMA_RENDER_FAILED"
  | "FIGMA_PROXY_EGRESS_FAILED"
  | "FIGMA_PROXY_UNREACHABLE"
  | "FIGMA_PROXY_AUTH_REQUIRED"
  | "FIGMA_PROXY_BLOCKED_BY_POLICY"
  | "FIGMA_TLS_CA_FAILURE"
  | "FIGMA_OVERSIZED_SCOPE"
  | "FIGMA_RESPONSE_TOO_LARGE"
  | "FIGMA_RATE_LIMITED"
  | "FIGMA_UPSTREAM_UNAVAILABLE"
  | "FIGMA_NETWORK_UNREACHABLE"
  | "FIGMA_EGRESS_TIMEOUT"
  | "FIGMA_EGRESS_FAILED"
  | "FIGMA_BUILD_TIMEOUT"
  | "FIGMA_INTERNAL";

const SAFE_MESSAGES: Readonly<Record<FigmaConnectorErrorCode, string>> = {
  FIGMA_MALFORMED_URL:
    "The supplied link is not a scoped Figma node link. Paste a board or section link that includes a node id.",
  FIGMA_TOKEN_MISSING:
    "The Figma connector is not configured. Set a read-only access token before fetching a board.",
  FIGMA_CONSENT_REQUIRED:
    "Acknowledge the read-only, least-privilege Figma scope before the first fetch for this board.",
  FIGMA_TOKEN_INVALID:
    "The Figma access token is invalid. Re-key the connector with a current read-only token.",
  FIGMA_TOKEN_EXPIRED:
    "The Figma access token has expired. Re-key the connector with a new read-only token.",
  FIGMA_TOKEN_REVOKED:
    "The Figma access token has been revoked. Re-key the connector with a new read-only token.",
  FIGMA_NOT_FOUND: "The requested Figma node could not be found for the supplied link.",
  FIGMA_INSUFFICIENT_SCOPE:
    "The configured Figma access token is not permitted to read the requested node. Re-key the connector with a read-only token that can read this file.",
  FIGMA_RENDER_FAILED:
    "Figma could not render the requested screens. Re-run the snapshot; if it persists, connect a narrower section.",
  FIGMA_PROXY_EGRESS_FAILED:
    "The Figma request could not be routed through the platform egress proxy. Check proxy connectivity and try again.",
  FIGMA_PROXY_UNREACHABLE:
    "The platform egress proxy is unreachable. Check the proxy host and port and try again.",
  FIGMA_PROXY_AUTH_REQUIRED:
    "The forward proxy requires authentication for the Figma egress request. Configure proxy credentials or an allow rule.",
  FIGMA_PROXY_BLOCKED_BY_POLICY:
    "The forward proxy blocked the Figma egress request by policy. Ask the proxy operator to allow api.figma.com and the Figma render hosts.",
  FIGMA_TLS_CA_FAILURE:
    "The TLS certificate for the Figma egress could not be verified. Check the configured certificate authority bundle and try again.",
  FIGMA_OVERSIZED_SCOPE:
    "The requested Figma node subtree is too large for a single scoped fetch. Connect a narrower section.",
  FIGMA_RESPONSE_TOO_LARGE:
    "The Figma API response exceeded the maximum allowed size. Connect a narrower section to reduce the response.",
  FIGMA_RATE_LIMITED:
    "Figma rate-limited the snapshot-build after repeated retries. Wait a moment and re-run the snapshot.",
  FIGMA_UPSTREAM_UNAVAILABLE:
    "The Figma service is currently unavailable. Try the scoped fetch again later.",
  FIGMA_NETWORK_UNREACHABLE:
    "The outbound network request to Figma failed (DNS, connection, or socket error). Check network connectivity and egress policy.",
  FIGMA_EGRESS_TIMEOUT:
    "The Figma request timed out before completing. Retry; if it persists, raise KEIKO_FIGMA_REQUEST_TIMEOUT_MS or check upstream latency.",
  FIGMA_EGRESS_FAILED: "The outbound request to Figma failed before a response was received.",
  FIGMA_BUILD_TIMEOUT:
    "The snapshot build exceeded the configured deadline. No partial snapshot was stored. Retry or raise KEIKO_FIGMA_BUILD_DEADLINE_MS.",
  FIGMA_INTERNAL: "The Figma connector could not service the request.",
};

export interface FigmaConnectorErrorBody {
  readonly error: { readonly code: FigmaConnectorErrorCode; readonly message: string };
}

export const figmaConnectorErrorBody = (
  code: FigmaConnectorErrorCode,
): FigmaConnectorErrorBody => ({
  error: { code, message: SAFE_MESSAGES[code] },
});

export class FigmaConnectorError extends Error {
  readonly code: FigmaConnectorErrorCode;

  constructor(code: FigmaConnectorErrorCode) {
    super(SAFE_MESSAGES[code]);
    this.name = "FigmaConnectorError";
    this.code = code;
  }
}

// Node.js / undici error codes that indicate a TLS / certificate failure.
const TLS_CODES: ReadonlySet<string> = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
]);

// Node.js / undici error codes that indicate a direct connectivity / DNS / socket failure.
// These are only reached when the error did NOT come through the OutboundHttpEgressError proxy
// path — a raw ECONNREFUSED means no proxy is involved.
const CONNECTIVITY_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "ECONNABORTED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPROTO",
  "EPERM",
  "EACCES",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

// Mapping from OutboundHttpEgressError codes (proxy path) to FigmaConnectorErrorCodes.
// FIGMA_PROXY_* codes are ONLY reachable through the OutboundHttpEgressError branch.
const OUTBOUND_CODE_TO_FIGMA: Readonly<
  Partial<Record<OutboundHttpEgressErrorCode, FigmaConnectorErrorCode>>
> = {
  TLS_CA_FAILURE: "FIGMA_TLS_CA_FAILURE",
  PROXY_UNREACHABLE: "FIGMA_PROXY_UNREACHABLE",
  PROXY_AUTH_REQUIRED: "FIGMA_PROXY_AUTH_REQUIRED",
  PROXY_BLOCKED_BY_POLICY: "FIGMA_PROXY_BLOCKED_BY_POLICY",
  PROXY_EGRESS_FAILED: "FIGMA_PROXY_EGRESS_FAILED",
};

// String set of OutboundHttpEgressError codes for cross-package-boundary instanceof fallback.
const OUTBOUND_EGRESS_CODES: ReadonlySet<string> = new Set<OutboundHttpEgressErrorCode>([
  "TLS_CA_FAILURE",
  "PROXY_UNREACHABLE",
  "PROXY_AUTH_REQUIRED",
  "PROXY_BLOCKED_BY_POLICY",
  "PROXY_EGRESS_FAILED",
]);

const TLS_MSG_RE = /cert|self.?signed|unable to (?:verify|get).*(issuer|cert)|tls/i;
// "fetch failed" is the Node.js TypeError message for generic direct-network failures (undici).
const CONNECTIVITY_MSG_RE = /socket hang ?up|network|fetch failed|econn|enotfound/i;

const extractCode = (err: unknown): string | undefined => {
  if (err !== null && typeof err === "object") {
    const code = (err as Record<string, unknown>).code;
    if (typeof code === "string") return code;
  }
  return undefined;
};

const extractCauseCode = (err: unknown): string | undefined => {
  if (err !== null && typeof err === "object") {
    return extractCode((err as Record<string, unknown>).cause);
  }
  return undefined;
};

const extractMessage = (err: unknown): string => {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "";
};

const extractName = (err: unknown): string => {
  if (err !== null && typeof err === "object") {
    const name = (err as Record<string, unknown>).name;
    if (typeof name === "string") return name;
  }
  return "";
};

const extractCause = (err: unknown): unknown =>
  err !== null && typeof err === "object" ? (err as Record<string, unknown>).cause : undefined;

/** Map an outbound egress code string to a FigmaConnectorErrorCode, or return undefined. */
const mapOutboundCode = (code: string): FigmaConnectorErrorCode | undefined => {
  if (!OUTBOUND_EGRESS_CODES.has(code)) return undefined;
  return OUTBOUND_CODE_TO_FIGMA[code as OutboundHttpEgressErrorCode] ?? "FIGMA_PROXY_EGRESS_FAILED";
};

// Cross-package-boundary fallback: plain Error with a string .code in the outbound set.
// Used when instanceof check fails because OutboundHttpEgressError came from a different
// package copy (e.g. stale dist during tests).
const mapOutboundCodeFallback = (
  topCode: string | undefined,
  causeCode: string | undefined,
): FigmaConnectorErrorCode | undefined => {
  if (topCode !== undefined && OUTBOUND_EGRESS_CODES.has(topCode)) {
    return mapOutboundCode(topCode) ?? "FIGMA_PROXY_EGRESS_FAILED";
  }
  if (causeCode !== undefined && OUTBOUND_EGRESS_CODES.has(causeCode)) {
    return mapOutboundCode(causeCode) ?? "FIGMA_PROXY_EGRESS_FAILED";
  }
  return undefined;
};

// (a) OutboundHttpEgressError path — a proxy was genuinely in play.
// FIGMA_PROXY_* codes are ONLY reachable through this function.
const classifyOutbound = (
  err: unknown,
  cause: unknown,
  topCode: string | undefined,
  causeCode: string | undefined,
): FigmaConnectorErrorCode | undefined => {
  const outbound =
    err instanceof OutboundHttpEgressError
      ? err
      : cause instanceof OutboundHttpEgressError
        ? cause
        : undefined;
  if (outbound !== undefined) return mapOutboundCode(outbound.code) ?? "FIGMA_PROXY_EGRESS_FAILED";
  return mapOutboundCodeFallback(topCode, causeCode);
};

// (b) TLS by code or message.
const classifyTls = (code: string | undefined, msg: string): FigmaConnectorErrorCode | undefined =>
  (code !== undefined && TLS_CODES.has(code)) || TLS_MSG_RE.test(msg)
    ? "FIGMA_TLS_CA_FAILURE"
    : undefined;

// (c) Timeout / abort names — check both err and its cause.
const isAbortName = (name: string): boolean => name === "TimeoutError" || name === "AbortError";
const classifyTimeout = (err: unknown, cause: unknown): FigmaConnectorErrorCode | undefined =>
  isAbortName(extractName(err)) || isAbortName(extractName(cause))
    ? "FIGMA_EGRESS_TIMEOUT"
    : undefined;

// (d) Direct connectivity codes / messages — no proxy involved.
const classifyConnectivity = (
  code: string | undefined,
  msg: string,
): FigmaConnectorErrorCode | undefined =>
  (code !== undefined && CONNECTIVITY_CODES.has(code)) || CONNECTIVITY_MSG_RE.test(msg)
    ? "FIGMA_NETWORK_UNREACHABLE"
    : undefined;

/**
 * Classify a transport-level throw from `fetch` or the body read into a stable
 * {@link FigmaConnectorErrorCode}. Side-effect-free and total — any non-Error
 * throwable (string, undefined) maps to `FIGMA_EGRESS_FAILED`.
 *
 * Precedence:
 *   (a) OutboundHttpEgressError (or plain Error with outbound code, for cross-package resilience)
 *       → proxy/TLS-via-proxy codes. FIGMA_PROXY_* codes are ONLY reachable via this branch.
 *   (b) TLS trust codes / messages → FIGMA_TLS_CA_FAILURE.
 *   (c) Timeout / abort names (DOMException AbortError, Node TimeoutError) → FIGMA_EGRESS_TIMEOUT.
 *   (d) Direct connectivity codes / messages → FIGMA_NETWORK_UNREACHABLE.
 *   (e) Default → FIGMA_EGRESS_FAILED.
 *
 * Inspects `err.code`, `err.cause.code`, and `err.message` in that order of
 * precedence so Node.js `TypeError: fetch failed` wrappers (undici wraps the
 * underlying `cause.code`) are classified correctly.
 */
export const classifyFigmaTransportError = (err: unknown): FigmaConnectorErrorCode => {
  const cause = extractCause(err);
  const topCode = extractCode(err);
  const causeCode = extractCauseCode(err);
  const code = topCode ?? causeCode;
  const msg = extractMessage(err);
  return (
    classifyOutbound(err, cause, topCode, causeCode) ??
    classifyTls(code, msg) ??
    classifyTimeout(err, cause) ??
    classifyConnectivity(code, msg) ??
    "FIGMA_EGRESS_FAILED"
  );
};
