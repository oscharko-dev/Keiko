// Figma token-resolution seam + token-failure taxonomy (Epic #750, Issue #758).
//
// resolveFigmaToken is the single point the connector consults for the read-only PAT. Precedence is
// vault > config > env, so the encrypted vault entry (#758) takes priority while the
// FIGMA_ACCESS_TOKEN env var (#751) stays the dev default whenever no vault entry exists. The
// resolved token is returned for use at the transport boundary only; the resolver itself never logs
// it and never echoes any candidate value in the FIGMA_TOKEN_MISSING error.
//
// classifyTokenFailure maps a failing Figma/proxy HTTP response to a coded, user-actionable error.
// It is PURE and STRUCTURAL: it keys off the HTTP status plus a small set of generic Figma reason
// keywords (expired / revoked / scope), and defaults any unrecognised 403 to the safe
// FIGMA_TOKEN_INVALID rather than guessing. No board-, file-, or message-specific tuning.

import { FigmaConnectorError, type FigmaConnectorErrorCode } from "./figmaConnectorErrors.js";

export interface FigmaTokenSources {
  // Explicit `| undefined` (not just `?`) so callers can forward a resolved-or-undefined value
  // under exactOptionalPropertyTypes without narrowing first.
  readonly vaultToken?: string | undefined;
  readonly configToken?: string | undefined;
  readonly envToken?: string | undefined;
}

const firstNonEmpty = (...candidates: readonly (string | undefined)[]): string | undefined => {
  for (const candidate of candidates) {
    const trimmed = (candidate ?? "").trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
};

export function resolveFigmaToken(sources: FigmaTokenSources): string {
  const token = firstNonEmpty(sources.vaultToken, sources.configToken, sources.envToken);
  if (token === undefined) throw new FigmaConnectorError("FIGMA_TOKEN_MISSING");
  return token;
}

const includesAny = (haystack: string, needles: readonly string[]): boolean =>
  needles.some((needle) => haystack.includes(needle));

// Structural reason buckets. Each is a small set of generic substrings that Figma uses across
// files; none is tied to a specific board, file, or customer-supplied message.
function classifyForbidden(reason: string): FigmaConnectorErrorCode {
  if (includesAny(reason, ["expired", "expire"])) return "FIGMA_TOKEN_EXPIRED";
  if (includesAny(reason, ["revoked", "revoke"])) return "FIGMA_TOKEN_REVOKED";
  if (includesAny(reason, ["scope", "permission", "not allowed", "forbidden access"])) {
    return "FIGMA_INSUFFICIENT_SCOPE";
  }
  // Unknown 403 → safe default, never a guess.
  return "FIGMA_TOKEN_INVALID";
}

function codeForStatus(status: number, reason: string): FigmaConnectorErrorCode {
  if (status === 401) return "FIGMA_TOKEN_INVALID";
  if (status === 403) return classifyForbidden(reason);
  if (status === 404) return "FIGMA_NOT_FOUND";
  // Forward-proxy egress failures (#802): 407 proxy-auth, 502/504 gateway. A plain 503 is the
  // upstream Figma service being unavailable, not a proxy fault — it stays UPSTREAM below.
  if (status === 407 || status === 502 || status === 504) return "FIGMA_PROXY_EGRESS_FAILED";
  if (status >= 500) return "FIGMA_UPSTREAM_UNAVAILABLE";
  return "FIGMA_INTERNAL";
}

export function classifyTokenFailure(status: number, reason?: string): FigmaConnectorError {
  const normalised = (reason ?? "").toLowerCase();
  return new FigmaConnectorError(codeForStatus(status, normalised));
}
