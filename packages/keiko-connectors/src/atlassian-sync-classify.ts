// Shared Atlassian sync transport classification and URL scoping (Issues #2242/#2243, ADR-0128
// D3). Extracted from the Confluence adapter when the Jira adapter (#2243) joined the lane so the
// degradation vocabulary is identical for every provider BY CONSTRUCTION — one status→reason
// mapping, one truncation classification, one single-host URL builder. Package-internal: adapters
// consume it; it is deliberately not part of the public barrel surface.

import {
  isSafeAtlassianConnectorBaseUrl,
  type AtlassianSyncFailureReason,
} from "@oscharko-dev/keiko-contracts";
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

export function parseJsonRecord(bodyText: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(bodyText));
  } catch {
    return undefined;
  }
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
    return { ok: false, reason: failureReasonForStatus(result.status) };
  }
  if (result.truncated) {
    return { ok: false, reason: classifyTruncatedList(result, requestedCap) };
  }
  const body = parseJsonRecord(result.bodyText);
  if (body === undefined) return { ok: false, reason: "malformed-payload" };
  return { ok: true, body };
}
