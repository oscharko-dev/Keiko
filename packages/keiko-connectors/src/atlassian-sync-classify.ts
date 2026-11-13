// Shared Atlassian sync transport classification and URL scoping (Issues #2242/#2243, ADR-0128
// D3). Extracted from the Confluence adapter when the Jira adapter (#2243) joined the lane so the
// degradation vocabulary is identical for every provider BY CONSTRUCTION — one status→reason
// mapping, one truncation classification, one single-host URL builder. Package-internal: adapters
// consume it; it is deliberately not part of the public barrel surface.

import type { AtlassianSyncFailureReason } from "@oscharko-dev/keiko-contracts";
import { isSafeAtlassianConnectorBaseUrl } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { AtlassianCredentialCustodyError } from "./atlassian-credential-custody.js";
import type { AtlassianHttpBodyResult } from "./atlassian-http-port.js";

// ─── Hostile-JSON narrowing (no `any`) ─────────────────────────────────────────
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function asArray(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? (value as readonly unknown[]) : undefined;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function parseAtlassianJsonValue(bodyText: string): unknown {
  try {
    return JSON.parse(bodyText) as unknown;
  } catch {
    return undefined;
  }
}

export function parseJsonRecord(bodyText: string): Record<string, unknown> | undefined {
  return asRecord(parseAtlassianJsonValue(bodyText));
}

export function parseJsonArray(bodyText: string): readonly unknown[] | undefined {
  return asArray(parseAtlassianJsonValue(bodyText));
}

/** Explicit primitive mode; false, zero, empty text and null are observations, not parse failures. */
export function parseJsonScalar(bodyText: string): string | number | boolean | null | undefined {
  const value = parseAtlassianJsonValue(bodyText);
  return value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
    ? value
    : undefined;
}

/** Some native versioned resources document both a wrapper object and an older bare collection. */
export function parseJsonObjectOrArray(bodyText: string):
  | {
      readonly body: Record<string, unknown> | undefined;
      readonly items?: readonly unknown[];
    }
  | undefined {
  const value = parseAtlassianJsonValue(bodyText);
  const items = asArray(value);
  if (items !== undefined) return { body: undefined, items };
  const body = asRecord(value);
  return body === undefined ? undefined : { body };
}

// ─── Single-host, API-root-scoped URL construction (ADR-0128 D3) ──────────────
export interface AtlassianApiEndpoints {
  readonly base: URL;
  readonly apiRootPath: string;
}

export function atlassianApiEndpointsFor(baseUrl: string, apiRoot: string): AtlassianApiEndpoints {
  if (!isSafeAtlassianConnectorBaseUrl(baseUrl)) {
    throw new AtlassianCredentialCustodyError("invalid-input", [
      "baseUrl must be an https URL without credentials, query, or fragment",
    ]);
  }
  const base = new URL(baseUrl);
  const basePath = base.pathname.endsWith("/") ? base.pathname.slice(0, -1) : base.pathname;
  return { base, apiRootPath: `${basePath}${apiRoot}` };
}

// Defense in depth: the URL builder re-checks host and scheme even though the base URL was
// validated at construction time (the same check twice is intentional, ADR-0128 D3).
export function atlassianApiUrl(endpoints: AtlassianApiEndpoints, relative: string): string {
  const target = new URL(`${endpoints.base.origin}${endpoints.apiRootPath}${relative}`);
  if (target.host !== endpoints.base.host || target.protocol !== "https:") {
    throw new AtlassianCredentialCustodyError("invalid-input", [
      "request URL must stay on the connector's configured https host",
    ]);
  }
  return target.toString();
}

// ─── Transport-result classification (one closed vocabulary for every provider) ─
export type AtlassianListPageResult =
  | { readonly ok: true; readonly body: Record<string, unknown> }
  | { readonly ok: false; readonly reason: AtlassianSyncFailureReason };

export function failureReasonForStatus(status: number): AtlassianSyncFailureReason {
  if (status === 401) return "auth-failed";
  if (status === 403) return "permission-denied";
  if (status === 429) return "rate-limited";
  return "unavailable";
}

/**
 * The one status-to-reason owner for every read (#4353). A Data Center 401 carries the server's
 * identity-read decision: `confirmed` means the token is valid, so the 401 was a missing
 * permission; `unconfirmed` means nothing was settled, so the token is neither blamed nor
 * discarded. A 401 without a decision (Cloud, or an identity request itself) stays an
 * authentication failure.
 */
export function failureReasonForResponse(
  result: Pick<Extract<AtlassianHttpBodyResult, { kind: "response" }>, "status" | "authentication">,
): AtlassianSyncFailureReason {
  if (result.status === 401 && result.authentication === "confirmed") return "permission-denied";
  if (result.status === 401 && result.authentication === "unconfirmed") return "auth-unverified";
  return failureReasonForStatus(result.status);
}

export type AtlassianItemFailure =
  | { readonly kind: "missing" }
  | { readonly kind: "skipped"; readonly reason: AtlassianSyncFailureReason }
  | { readonly kind: "fatal"; readonly reason: AtlassianSyncFailureReason };

/**
 * One per-item failure classification for every sync adapter (#4353). A 401 the server's identity
 * read left unconfirmed is a fatal stop that does not blame the token; a confirmed one is this
 * item's missing permission. Cloud sync never carries a decision, so its 401 stays an
 * authentication failure. A 404 is a missing item; everything else is skipped by status.
 */
export function classifyItemFailureResponse(
  result: Extract<AtlassianHttpBodyResult, { kind: "response" }>,
): AtlassianItemFailure {
  if (result.status === 401 && result.authentication === "unconfirmed")
    return { kind: "fatal", reason: "auth-unverified" };
  if (result.status === 401 && result.authentication !== "confirmed")
    return { kind: "fatal", reason: "auth-failed" };
  if (result.status === 404) return { kind: "missing" };
  return { kind: "skipped", reason: failureReasonForResponse(result) };
}

// Truncation on a JSON/list response is a byte-coverage failure, never parseable content:
// clamped below the requested cap means the run budget ran out (`bounds-exceeded`); reaching the
// requested cap means the payload itself overflows the list cap (`malformed-payload`).
export function classifyTruncatedList(
  result: Extract<AtlassianHttpBodyResult, { kind: "response" }>,
  requestedCap: number,
): AtlassianSyncFailureReason {
  return result.bodyBytes < requestedCap ? "bounds-exceeded" : "malformed-payload";
}

export function classifyListResult(
  result: AtlassianHttpBodyResult,
  requestedCap: number,
): AtlassianListPageResult {
  if (result.kind === "timeout") return { ok: false, reason: "timeout" };
  if (result.kind === "network-error") return { ok: false, reason: "unavailable" };
  if (result.status < 200 || result.status >= 300) {
    return { ok: false, reason: failureReasonForResponse(result) };
  }
  if (result.truncated) {
    return { ok: false, reason: classifyTruncatedList(result, requestedCap) };
  }
  const body = parseJsonRecord(result.bodyText);
  if (body === undefined) return { ok: false, reason: "malformed-payload" };
  return { ok: true, body };
}
