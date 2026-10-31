// Bounded write-request execution over the injected transport port (Issue #2244, Epic #2238,
// ADR-0128 D3). One helper serves BOTH write executors (Jira and Confluence), so the timeout,
// retry, byte-bound, and status-classification discipline is identical by construction.
//
// Egress discipline (ADR-0128 D3):
//   - 30 000 ms per request (the D3 interactive write/read budget), clamped by the adapter.
//   - Bounded backoff reusing the sync lane's D3 constants: 500 ms base, factor 2, 8 000 ms
//     per-attempt cap, at most 5 attempts total, `Retry-After` honored and capped at the same
//     ceiling.
//   - Only GET may retry 429/5xx. POST and PUT are dispatched at most once, even
//     with Retry-After: a response can be lost or replaced after the mutation committed.
//     Replaying PUT can also overwrite a concurrent actor's intervening change.
//     Mutation outcome reconciliation and any explicit new intent belong to the caller.
//   - 4xx other than 429 never retries (D3), mapping to closed content-free reasons.
//
// Byte bounds: the serialized JSON request body is checked against
// `ATLASSIAN_HTTP_REQUEST_BODY_MAX_BYTES` here (typed `bounds-exceeded`, no port call) and again
// fail-closed inside the server adapter; write responses are read under a small cap — a
// truncated or unparseable JSON response classifies as `malformed-payload`, never as partial
// content.

import type { AtlassianConnectorWriteFailureReason } from "@oscharko-dev/keiko-contracts";
import {
  sanitizeJiraMutationFailureDetail,
  type JiraMutationFailureDetail,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  ATLASSIAN_HTTP_REQUEST_BODY_MAX_BYTES,
  ATLASSIAN_HTTP_UPLOAD_MAX_BYTES,
  type AtlassianHttpBodyPort,
  type AtlassianHttpBodyResult,
  type AtlassianHttpUpload,
} from "./atlassian-http-port.js";
import { ATLASSIAN_SYNC_RETRY_MAX_ATTEMPTS, retryDelayMs } from "./atlassian-sync-lane.js";
import { asRecord, parseJsonArray, parseJsonRecord } from "./atlassian-sync-classify.js";

// ADR-0128 D3: interactive write/read actions (issue and page CRUD, transitions, comments).
export const ATLASSIAN_WRITE_ACTION_TIMEOUT_MS = 30_000;
// A file upload moves megabytes, not a JSON body: its one request may use the transport's ceiling.
export const ATLASSIAN_UPLOAD_ACTION_TIMEOUT_MS = 60_000;
// KEIKO-0318: aggregate deadline across the entire retry loop for one write action. Sized to
// bound the loop below the 3-minute worst case (5 × 30s per-request + 4 × 8s backoff = 182s)
// that a hostile upstream could otherwise sustain by hanging every request at the per-request
// ceiling. 90 s allows a legitimate slow request plus two full retries with 8 s backoff; a
// pathological upstream is cut off well before the "minutes" symptom the finding named.
export const ATLASSIAN_WRITE_ACTION_TOTAL_TIMEOUT_MS = 90_000;
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
  // One governed multipart upload (POST only, #4176); never combined with `bodyJson`.
  readonly upload?: AtlassianHttpUpload | undefined;
  // Object/collection response shape, or status only. Both JSON shapes share the same byte cap.
  readonly expect: "json" | "json-array" | "none";
}

export interface AtlassianWriteHttpDeps {
  readonly http: AtlassianHttpBodyPort;
  // Injected backoff sleep (real timer in production, recorded no-op in tests).
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  // Injected clock for the aggregate-deadline check. Defaults to Date.now; tests inject.
  readonly now?: (() => number) | undefined;
  // Optional cancellation for the whole write action (KEIKO-0318). Not required — the aggregate
  // deadline is the load-bearing bound.
  readonly signal?: AbortSignal | undefined;
}

export type AtlassianWriteHttpOutcome =
  | {
      readonly ok: true;
      readonly status: number;
      readonly body: Record<string, unknown> | undefined;
      readonly items?: readonly unknown[];
    }
  | {
      readonly ok: false;
      readonly reason: AtlassianConnectorWriteFailureReason;
      readonly httpStatus?: number | undefined;
      /** Jira's own bounded explanation of a client error (#4176); never logged. */
      readonly remote?: JiraMutationFailureDetail;
    };

const UTF8_ENCODER = new TextEncoder();

/** Jira's `{ errorMessages, errors }` client-error body, bounded and control-free. */
function jiraRemoteErrors(bodyText: string): JiraMutationFailureDetail | undefined {
  const body = parseJsonRecord(bodyText);
  if (body === undefined) return undefined;
  const errors = asRecord(body.errors);
  const fieldErrors =
    errors === undefined
      ? []
      : Object.entries(errors).map(([fieldId, message]) => ({ fieldId, message }));
  return sanitizeJiraMutationFailureDetail({ fieldErrors, messages: body.errorMessages });
}

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

// Read retries retain D3's bounded pacing; a mutation never enters the retry loop.
function isRetryable(method: AtlassianWriteHttpMethod, result: AtlassianHttpBodyResult): boolean {
  return (
    method === "GET" &&
    result.kind === "response" &&
    (result.status === 429 || (result.status >= 500 && result.status < 600))
  );
}

function classifyTransport(
  result: Extract<AtlassianHttpBodyResult, { kind: "timeout" | "network-error" }>,
): AtlassianWriteHttpOutcome {
  return result.kind === "timeout"
    ? { ok: false, reason: "timeout" }
    : { ok: false, reason: "unavailable" };
}

function classifyFailure(
  result: Extract<AtlassianHttpBodyResult, { kind: "response" }>,
): AtlassianWriteHttpOutcome {
  const remote =
    result.status >= 400 && result.status < 500 && !result.truncated
      ? jiraRemoteErrors(result.bodyText)
      : undefined;
  return {
    ok: false,
    reason: failureReasonForWriteStatus(result.status),
    httpStatus: result.status,
    ...(remote === undefined ? {} : { remote }),
  };
}

function classifyResponse(
  result: Extract<AtlassianHttpBodyResult, { kind: "response" }>,
  expect: AtlassianWriteHttpRequest["expect"],
): AtlassianWriteHttpOutcome {
  if (result.status < 200 || result.status >= 300) return classifyFailure(result);
  if (expect === "none") return { ok: true, status: result.status, body: undefined };
  if (result.truncated) {
    return { ok: false, reason: "malformed-payload", httpStatus: result.status };
  }
  if (expect === "json-array") {
    const items = parseJsonArray(result.bodyText);
    return items === undefined
      ? { ok: false, reason: "malformed-payload", httpStatus: result.status }
      : { ok: true, status: result.status, body: undefined, items };
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
  timeoutMs: number,
): Promise<AtlassianHttpBodyResult> {
  return deps.http({
    method: request.method,
    url: request.url,
    timeoutMs,
    maxBodyBytes: ATLASSIAN_WRITE_RESPONSE_MAX_BYTES,
    ...(request.bodyJson === undefined ? {} : { bodyJson: request.bodyJson }),
    ...(request.upload === undefined ? {} : { upload: request.upload }),
    // KEIKO-0318: thread the caller's cancellation into the transport call itself so an abort
    // tears down the in-flight request (AtlassianHttpBodyRequest.signal) instead of only being
    // observed between attempts — the between-attempt checks alone only stopped a LATER retry.
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
  });
}

// KEIKO-0318: clamp the per-request timeout to whatever budget the aggregate deadline still
// permits, but never below a small floor that guarantees the request has time to arrive.
const PER_REQUEST_TIMEOUT_FLOOR_MS = 1_000;
function clampedPerRequestTimeoutMs(
  deadlineAt: number,
  now: () => number,
  ceilingMs: number = ATLASSIAN_WRITE_ACTION_TIMEOUT_MS,
): number {
  const remaining = deadlineAt - now();
  return Math.max(PER_REQUEST_TIMEOUT_FLOOR_MS, Math.min(ceilingMs, remaining));
}
function requestTimeoutCeilingMs(request: AtlassianWriteHttpRequest): number {
  return request.upload === undefined
    ? ATLASSIAN_WRITE_ACTION_TIMEOUT_MS
    : ATLASSIAN_UPLOAD_ACTION_TIMEOUT_MS;
}

// KEIKO-0318: refuse to sleep past the aggregate deadline OR while a caller-requested abort is
// pending. Returns the reason the retry loop must stop, or undefined when a next attempt is safe.
function reasonToStopRetrying(
  now: () => number,
  isAborted: () => boolean,
  deadlineAt: number,
  delay: number,
  phase: "before-sleep" | "after-sleep",
): "deadline" | "aborted" | undefined {
  if (phase === "before-sleep") {
    if (now() + delay > deadlineAt) return "deadline";
    if (isAborted()) return "aborted";
    return undefined;
  }
  if (isAborted()) return "aborted";
  if (now() >= deadlineAt) return "deadline";
  return undefined;
}

async function driveRetryLoop(
  deps: AtlassianWriteHttpDeps,
  request: AtlassianWriteHttpRequest,
  initial: AtlassianHttpBodyResult,
  deadlineAt: number,
  now: () => number,
  isAborted: () => boolean,
  sleep: (ms: number) => Promise<void>,
): Promise<AtlassianHttpBodyResult> {
  let result = initial;
  for (let attempt = 1; attempt < ATLASSIAN_SYNC_RETRY_MAX_ATTEMPTS; attempt += 1) {
    if (!isRetryable(request.method, result)) break;
    const retryAfterMs = result.kind === "response" ? result.retryAfterMs : undefined;
    const delay = retryDelayMs(attempt, retryAfterMs);
    if (reasonToStopRetrying(now, isAborted, deadlineAt, delay, "before-sleep") !== undefined) {
      break;
    }
    await sleep(delay);
    if (reasonToStopRetrying(now, isAborted, deadlineAt, delay, "after-sleep") !== undefined) {
      break;
    }
    result = await issueOnce(
      deps,
      request,
      clampedPerRequestTimeoutMs(deadlineAt, now, requestTimeoutCeilingMs(request)),
    );
  }
  return result;
}

// A body over its byte ceiling, or a body shape the method cannot carry, never reaches the port.
function requestBodyRefusal(
  request: AtlassianWriteHttpRequest,
): Extract<AtlassianWriteHttpOutcome, { ok: false }> | undefined {
  if (request.upload !== undefined) {
    if (request.method !== "POST" || request.bodyJson !== undefined)
      return { ok: false, reason: "malformed-payload" };
    return request.upload.bytes.byteLength > ATLASSIAN_HTTP_UPLOAD_MAX_BYTES
      ? { ok: false, reason: "bounds-exceeded" }
      : undefined;
  }
  return request.bodyJson !== undefined &&
    UTF8_ENCODER.encode(request.bodyJson).byteLength > ATLASSIAN_HTTP_REQUEST_BODY_MAX_BYTES
    ? { ok: false, reason: "bounds-exceeded" }
    : undefined;
}

// Execute one bounded write-lane request with the method-aware D3 retry discipline. Returns a
// typed, content-free outcome; never throws for provider or transport failures.
export async function executeAtlassianWriteRequest(
  deps: AtlassianWriteHttpDeps,
  request: AtlassianWriteHttpRequest,
): Promise<AtlassianWriteHttpOutcome> {
  const refusal = requestBodyRefusal(request);
  if (refusal !== undefined) return refusal;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? ((): number => Date.now());
  const deadlineAt = now() + ATLASSIAN_WRITE_ACTION_TOTAL_TIMEOUT_MS;
  const isAborted = (): boolean => deps.signal?.aborted === true;
  if (isAborted()) return { ok: false, reason: "timeout" };
  const initial = await issueOnce(
    deps,
    request,
    clampedPerRequestTimeoutMs(deadlineAt, now, requestTimeoutCeilingMs(request)),
  );
  const result = await driveRetryLoop(deps, request, initial, deadlineAt, now, isAborted, sleep);
  if (result.kind !== "response") return classifyTransport(result);
  return classifyResponse(result, request.expect);
}
