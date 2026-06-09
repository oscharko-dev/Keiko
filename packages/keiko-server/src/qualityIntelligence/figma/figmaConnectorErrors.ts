// Figma connector error shapes (Epic #750, Issue #751).
//
// Coded, safe errors for the server-side Figma connector. A FigmaConnectorError carries
// ONLY a stable code and a fixed, secret-free message — never the PAT, never a raw Figma
// payload, never an outbound URL or header value. Mirrors the QI connector error posture
// in ../connectorErrors.ts so the route tier can serialise it consistently.

export type FigmaConnectorErrorCode =
  | "FIGMA_MALFORMED_URL"
  | "FIGMA_TOKEN_MISSING"
  | "FIGMA_TOKEN_INVALID"
  | "FIGMA_TOKEN_EXPIRED"
  | "FIGMA_TOKEN_REVOKED"
  | "FIGMA_NOT_FOUND"
  | "FIGMA_INSUFFICIENT_SCOPE"
  | "FIGMA_PROXY_EGRESS_FAILED"
  | "FIGMA_OVERSIZED_SCOPE"
  | "FIGMA_UPSTREAM_UNAVAILABLE"
  | "FIGMA_INTERNAL";

const SAFE_MESSAGES: Readonly<Record<FigmaConnectorErrorCode, string>> = {
  FIGMA_MALFORMED_URL:
    "The supplied link is not a scoped Figma node link. Paste a board or section link that includes a node id.",
  FIGMA_TOKEN_MISSING:
    "The Figma connector is not configured. Set a read-only access token before fetching a board.",
  FIGMA_TOKEN_INVALID:
    "The Figma access token is invalid. Re-key the connector with a current read-only token.",
  FIGMA_TOKEN_EXPIRED:
    "The Figma access token has expired. Re-key the connector with a new read-only token.",
  FIGMA_TOKEN_REVOKED:
    "The Figma access token has been revoked. Re-key the connector with a new read-only token.",
  FIGMA_NOT_FOUND: "The requested Figma node could not be found for the supplied link.",
  FIGMA_INSUFFICIENT_SCOPE:
    "The configured Figma access token is not permitted to read the requested node. Re-key the connector with a read-only token that can read this file.",
  FIGMA_PROXY_EGRESS_FAILED:
    "The Figma request could not be routed through the platform egress proxy. Check proxy connectivity and try again.",
  FIGMA_OVERSIZED_SCOPE:
    "The requested Figma node subtree is too large for a single scoped fetch. Connect a narrower section.",
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
