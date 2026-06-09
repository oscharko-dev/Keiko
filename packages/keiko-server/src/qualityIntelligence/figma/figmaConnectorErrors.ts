// Figma connector error shapes (Epic #750, Issues #751, #758, #760).
//
// Coded, safe errors for the server-side Figma connector. A FigmaConnectorError carries
// ONLY a stable code and a fixed, secret-free message — never the PAT, never a raw Figma
// payload, never an outbound URL or header value. Mirrors the QI connector error posture
// in ../connectorErrors.ts so the route tier can serialise it consistently.
//
// Complete coded taxonomy (#760); every code is user-actionable. Each ticket-named category maps to
// one or more codes below:
//   auth          → FIGMA_TOKEN_MISSING | FIGMA_TOKEN_INVALID | FIGMA_TOKEN_EXPIRED
//                   | FIGMA_TOKEN_REVOKED
//   consent       → FIGMA_CONSENT_REQUIRED (no recorded read-only-scope acknowledgement)
//   scope         → FIGMA_INSUFFICIENT_SCOPE
//   rate-limit    → FIGMA_RATE_LIMITED
//   not-found     → FIGMA_NOT_FOUND
//   oversized     → FIGMA_OVERSIZED_SCOPE
//   render-failed → FIGMA_RENDER_FAILED
//   proxy egress  → FIGMA_PROXY_UNREACHABLE (proxy not reachable / egress refused)
//                   | FIGMA_PROXY_EGRESS_FAILED (generic egress failure, retained for back-compat)
//   tls/ca        → FIGMA_TLS_CA_FAILURE (custom-CA / TLS verification failure on egress)
// FIGMA_MALFORMED_URL, FIGMA_UPSTREAM_UNAVAILABLE, and FIGMA_INTERNAL cover input and last-resort
// faults. The proxy-aware + custom-CA HTTP client itself is #802; this connector only SURFACES
// these proxy/TLS codes — it does not implement the proxy transport.

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
  | "FIGMA_TLS_CA_FAILURE"
  | "FIGMA_OVERSIZED_SCOPE"
  | "FIGMA_RATE_LIMITED"
  | "FIGMA_UPSTREAM_UNAVAILABLE"
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
  FIGMA_TLS_CA_FAILURE:
    "The TLS certificate for the Figma egress could not be verified. Check the configured certificate authority bundle and try again.",
  FIGMA_OVERSIZED_SCOPE:
    "The requested Figma node subtree is too large for a single scoped fetch. Connect a narrower section.",
  FIGMA_RATE_LIMITED:
    "Figma rate-limited the snapshot-build after repeated retries. Wait a moment and re-run the snapshot.",
  FIGMA_UPSTREAM_UNAVAILABLE:
    "The Figma service is currently unavailable. Try the scoped fetch again later.",
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

// Node.js / undici error codes that indicate a connectivity / DNS / timeout failure.
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
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

const TLS_MSG_RE = /cert|self.?signed|unable to (?:verify|get).*(issuer|cert)|tls/i;
const CONNECTIVITY_MSG_RE = /socket hang ?up|network|timeout|fetch failed|econn|enotfound/i;

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

/**
 * Classify a transport-level throw from `fetch` or the body read into a stable
 * {@link FigmaConnectorErrorCode}. Side-effect-free and total — any non-Error
 * throwable (string, undefined) maps to `FIGMA_PROXY_EGRESS_FAILED`.
 *
 * Inspects `err.code`, `err.cause.code`, and `err.message` in that order of
 * precedence so Node.js `TypeError: fetch failed` wrappers (undici wraps the
 * underlying `cause.code`) are classified correctly.
 */
export const classifyFigmaTransportError = (err: unknown): FigmaConnectorErrorCode => {
  const code = extractCode(err) ?? extractCauseCode(err);
  if (code !== undefined) {
    if (TLS_CODES.has(code)) return "FIGMA_TLS_CA_FAILURE";
    if (CONNECTIVITY_CODES.has(code)) return "FIGMA_PROXY_UNREACHABLE";
  }
  const msg = extractMessage(err);
  if (TLS_MSG_RE.test(msg)) return "FIGMA_TLS_CA_FAILURE";
  if (CONNECTIVITY_MSG_RE.test(msg)) return "FIGMA_PROXY_UNREACHABLE";
  return "FIGMA_PROXY_EGRESS_FAILED";
};
