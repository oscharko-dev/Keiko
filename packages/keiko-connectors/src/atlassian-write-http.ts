// Bounded write-request execution over the injected transport port (Issue #2244, Epic #2238,
// ADR-0128 D3). One helper serves BOTH write executors (Jira and Confluence), so the timeout,
// retry, byte-bound, and status-classification discipline is identical by construction.
//
// Egress discipline (ADR-0128 D3):
//   - 30 000 ms per request (the D3 interactive write/read budget), clamped by the adapter.
//   - Bounded backoff reusing the sync lane's D3 constants: 500 ms base, factor 2, 8 000 ms
//     per-attempt cap, at most 5 attempts total, `Retry-After` honored and capped at the same
//     ceiling.
//   - Retry eligibility is METHOD-AWARE. D3 fixes the backoff envelope for 429/5xx but is silent
//     on request idempotency, so this helper implements the fail-safe reading:
//       · GET and PUT are idempotent (Jira field updates replay identically; Confluence page
//         updates carry an explicit version, so a replay lands as a typed `conflict`, never a
//         double-apply) → retried on 429 and 5xx per D3.
//       · POST is NOT idempotent (create-issue, transition-issue, comments, create-page — a 5xx
//         may arrive AFTER the mutation committed upstream) → retried ONLY on 429 AND only when
//         the response carries `Retry-After` (a 429 is rejected before processing, and the
//         explicit header keeps the pacing server-directed). Every other POST failure returns
//         immediately as a typed result; there is no speculative replay of a non-idempotent
//         write.
//   - 4xx other than 429 never retries (D3), mapping to closed content-free reasons.
//
// Byte bounds: the serialized JSON request body is checked against
// `ATLASSIAN_HTTP_REQUEST_BODY_MAX_BYTES` here (typed `bounds-exceeded`, no port call) and again
// fail-closed inside the server adapter; write responses are read under a small cap — a
// truncated or unparseable JSON response classifies as `malformed-payload`, never as partial
// content.

import type { AtlassianConnectorWriteFailureReason } from "@oscharko-dev/keiko-contracts";
import {
  ATLASSIAN_HTTP_REQUEST_BODY_MAX_BYTES,
  type AtlassianHttpBodyPort,
  type AtlassianHttpBodyResult,
} from "./atlassian-http-port.js";
import {
  ATLASSIAN_SYNC_RETRY_BASE_DELAY_MS,
  ATLASSIAN_SYNC_RETRY_FACTOR,
  ATLASSIAN_SYNC_RETRY_MAX_ATTEMPTS,
  ATLASSIAN_SYNC_RETRY_MAX_DELAY_MS,
} from "./atlassian-sync-lane.js";
import { parseJsonRecord } from "./atlassian-sync-classify.js";

// ADR-0128 D3: interactive write/read actions (issue and page CRUD, transitions, comments).
export const ATLASSIAN_WRITE_ACTION_TIMEOUT_MS = 30_000;
// Write responses are minimal (created ids/keys, version numbers, transition lists); the cap is
// generous for those payloads and small enough that a hostile upstream cannot flood the lane.
export const ATLASSIAN_WRITE_RESPONSE_MAX_BYTES = 262_144;

export type AtlassianWriteHttpMethod = "GET" | "POST" | "PUT";

export interface AtlassianWriteHttpRequest {
  readonly method: AtlassianWriteHttpMethod;
  // Absolute https URL built by the executor through the shared single-host URL builder.
  readonly url: string;
  // Serialized JSON request body (POST/PUT only).
  readonly bodyJson?: string | undefined;
  // Whether the caller consumes a JSON response body ("json") or only the status ("none").
  readonly expect: "json" | "none";
}

export interface AtlassianWriteHttpDeps {
  readonly http: AtlassianHttpBodyPort;
  // Injected backoff sleep (real timer in production, recorded no-op in tests).
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

export type AtlassianWriteHttpOutcome =
  | {
      readonly ok: true;
      readonly status: number;
      readonly body: Record<string, unknown> | undefined;
    }
  | {
      readonly ok: false;
      readonly reason: AtlassianConnectorWriteFailureReason;
      readonly httpStatus?: number | undefined;
    };

const UTF8_ENCODER = new TextEncoder();

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 4xx→closed reason (D3: no retry); 5xx and everything else unclassified → unavailable.
function failureReasonForWriteStatus(status: number): AtlassianConnectorWriteFailureReason {
  if (status === 400) return "field-validation";
  if (status === 401) return "auth-failed";
  if (status === 403) return "permission-denied";
  if (status === 404) return "not-found";
  if (status === 409) return "conflict";
  if (status === 429) return "rate-limited";
  return "unavailable";
}

function retryDelayMs(attempt: number, retryAfterMs: number | undefined): number {
  if (retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
    return Math.min(Math.trunc(retryAfterMs), ATLASSIAN_SYNC_RETRY_MAX_DELAY_MS);
  }
  const exponential =
    ATLASSIAN_SYNC_RETRY_BASE_DELAY_MS * ATLASSIAN_SYNC_RETRY_FACTOR ** (attempt - 1);
  return Math.min(exponential, ATLASSIAN_SYNC_RETRY_MAX_DELAY_MS);
}

// Method-aware retry eligibility (see the header): idempotent methods follow D3's 429/5xx rule;
// POST retries only a Retry-After-bearing 429.
function isRetryable(method: AtlassianWriteHttpMethod, result: AtlassianHttpBodyResult): boolean {
  if (result.kind !== "response") return false;
  if (method === "POST") {
    return result.status === 429 && result.retryAfterMs !== undefined;
  }
  return result.status === 429 || (result.status >= 500 && result.status < 600);
}

function classifyTransport(
  result: Extract<AtlassianHttpBodyResult, { kind: "timeout" | "network-error" }>,
): AtlassianWriteHttpOutcome {
  return result.kind === "timeout"
    ? { ok: false, reason: "timeout" }
    : { ok: false, reason: "unavailable" };
}

function classifyResponse(
  result: Extract<AtlassianHttpBodyResult, { kind: "response" }>,
  expect: "json" | "none",
): AtlassianWriteHttpOutcome {
  if (result.status < 200 || result.status >= 300) {
    return {
      ok: false,
      reason: failureReasonForWriteStatus(result.status),
      httpStatus: result.status,
    };
  }
  if (expect === "none") return { ok: true, status: result.status, body: undefined };
  if (result.truncated) {
    return { ok: false, reason: "malformed-payload", httpStatus: result.status };
  }
  const body = parseJsonRecord(result.bodyText);
  if (body === undefined) {
    return { ok: false, reason: "malformed-payload", httpStatus: result.status };
  }
  return { ok: true, status: result.status, body };
}

async function issueOnce(
  deps: AtlassianWriteHttpDeps,
  request: AtlassianWriteHttpRequest,
): Promise<AtlassianHttpBodyResult> {
  return deps.http({
    method: request.method,
    url: request.url,
    timeoutMs: ATLASSIAN_WRITE_ACTION_TIMEOUT_MS,
    maxBodyBytes: ATLASSIAN_WRITE_RESPONSE_MAX_BYTES,
    ...(request.bodyJson === undefined ? {} : { bodyJson: request.bodyJson }),
  });
}

// Execute one bounded write-lane request with the method-aware D3 retry discipline. Returns a
// typed, content-free outcome; never throws for provider or transport failures.
export async function executeAtlassianWriteRequest(
  deps: AtlassianWriteHttpDeps,
  request: AtlassianWriteHttpRequest,
): Promise<AtlassianWriteHttpOutcome> {
  if (
    request.bodyJson !== undefined &&
    UTF8_ENCODER.encode(request.bodyJson).byteLength > ATLASSIAN_HTTP_REQUEST_BODY_MAX_BYTES
  ) {
    return { ok: false, reason: "bounds-exceeded" };
  }
  const sleep = deps.sleep ?? defaultSleep;
  let result = await issueOnce(deps, request);
  for (let attempt = 1; attempt < ATLASSIAN_SYNC_RETRY_MAX_ATTEMPTS; attempt += 1) {
    if (!isRetryable(request.method, result)) break;
    const retryAfterMs = result.kind === "response" ? result.retryAfterMs : undefined;
    await sleep(retryDelayMs(attempt, retryAfterMs));
    result = await issueOnce(deps, request);
  }
  if (result.kind !== "response") return classifyTransport(result);
  return classifyResponse(result, request.expect);
}
