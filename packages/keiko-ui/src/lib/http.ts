/**
 * Shared BFF fetch scaffold for the keiko-ui `lib/*-api.ts` modules (GEN-DUP-NEAR-004).
 *
 * Every satellite API client (api.ts, memory-api.ts, local-knowledge-api.ts, browser-api.ts,
 * quality-intelligence-api.ts, figma-snapshot-api.ts, commands-api.ts, container-api.ts,
 * task-workspace-api.ts, terminal-api.ts) had copy-pasted the same request scaffold: same-origin
 * relative paths, `Accept: application/json`, the CSRF header + JSON content-type on state-changing
 * methods, a `{ error: { code, message } }` envelope parse on non-2xx, and (mostly) a 204 → undefined
 * short-circuit. This helper is the SUPERSET of all those behaviors so each satellite can delegate to
 * it without any site regressing:
 *
 *  - Headers (union of the two historical styles):
 *      * `Accept: application/json` always.
 *      * `Content-Type: application/json` on state-changing methods AND whenever a body is present
 *        (the memory-api / local-knowledge-api `buildHeaders` rule).
 *      * `X-Keiko-CSRF: 1` on state-changing methods.
 *      * caller-supplied `init.headers` win last (the api.ts / browser-api.ts spread rule), so a
 *        caller can still override Accept for a non-JSON route.
 *  - Non-2xx → `ApiError(code, message, status)` parsed from the `{ error: { code, message } }`
 *    envelope; on an unparseable body the code is `INTERNAL` and the message comes from
 *    `opts.parseFailureMessage(status)` (default the machine `HTTP <status>` string;
 *    local-knowledge-api passes its friendly message — uiux-fix F033/C064).
 *  - `opts.enrichError` runs on the thrown ApiError before it is raised, with the parsed envelope
 *    (or `undefined` on a parse failure), so task-workspace-api can attach `.failureClass`.
 *  - 204 → `undefined as T` (always; folding this into the three former non-204 modules — memory,
 *    quality-intelligence, figma — is a safe-forward improvement).
 *  - On 2xx with a body: `res.json()`, optionally routed through `opts.validator` so Git routes keep
 *    contract-validating (throwing `ApiError('CONTRACT_VALIDATION_FAILED', …, 502)`).
 *
 * `ApiError` is imported FROM ./api (one-way): api.ts owns the canonical error class and MUST NOT
 * import this module (that would be a cycle).
 */

import { ApiError } from "./api";

// The `{ error: { code, message, … } }` envelope every BFF route returns on a non-2xx. Extra
// fields (e.g. task-workspace `failureClass`) are surfaced to `opts.enrichError`.
export interface BffErrorEnvelope {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly [key: string]: unknown;
  };
}

export interface BffFetchOptions<T> {
  /**
   * Contract validator for the route's success body (Step-01 Git validators). When supplied the
   * parsed 2xx body is routed through it; a failure throws `ApiError('CONTRACT_VALIDATION_FAILED')`.
   */
  readonly validator?: (path: string, value: unknown) => T;
  /**
   * Message used when the non-2xx body is not a parseable error envelope. Defaults to the machine
   * `HTTP <status>` string. local-knowledge-api passes a friendly message (uiux-fix F033/C064).
   */
  readonly parseFailureMessage?: (status: number) => string;
  /**
   * Hook invoked on the thrown `ApiError` just before it is raised, with the parsed envelope (or
   * `undefined` when the body was not a parseable envelope). Lets a caller attach extra typed fields
   * — e.g. task-workspace-api copies `error.failureClass` off the envelope onto the ApiError.
   */
  readonly enrichError?: (error: ApiError, envelope: BffErrorEnvelope | undefined) => void;
}

function defaultParseFailureMessage(status: number): string {
  return `HTTP ${status.toString()}`;
}

// RB-6 (GEN-OBS-CORRELATION-601): a per-request correlation id sent on X-Keiko-Correlation-Id so a
// failure is traceable UI -> server with a single id (the server honours a well-formed client id and
// echoes it back). Header-safe alphabet + length, matching the server's SAFE_CORRELATION_ID predicate.
const CORRELATION_HEADER = "X-Keiko-Correlation-Id";

function newClientCorrelationId(): string {
  const cryptoRef = globalThis.crypto;
  if (cryptoRef !== undefined && typeof cryptoRef.randomUUID === "function") {
    return cryptoRef.randomUUID();
  }
  // Fallback for non-secure/legacy contexts: still a header-safe id in the [8,128] range.
  return `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

// Builds the request headers as the union of both historical styles. `init.headers` win last so a
// caller can still override any computed header (e.g. a non-JSON Accept). A correlation id is added
// unless the caller already supplied one.
function buildBffHeaders(init: RequestInit | undefined, correlationId: string): HeadersInit {
  const method = (init?.method ?? "GET").toUpperCase();
  const isStateChanging = method !== "GET" && method !== "HEAD";
  const hasBody = init?.body !== undefined && init.body !== null;
  return {
    Accept: "application/json",
    [CORRELATION_HEADER]: correlationId,
    ...(isStateChanging || hasBody ? { "Content-Type": "application/json" } : {}),
    ...(isStateChanging ? { "X-Keiko-CSRF": "1" } : {}),
    ...((init?.headers as Record<string, string> | undefined) ?? {}),
  };
}

/**
 * The shared BFF fetch scaffold. Kept as a referenceable generic function so satellite modules can
 * bind it as their `fetchImpl = bffFetchJson<T>` default-param test seam.
 */
export async function bffFetchJson<T>(
  path: string,
  init?: RequestInit,
  opts?: BffFetchOptions<T>,
): Promise<T> {
  const correlationId = newClientCorrelationId();
  const res = await fetch(path, {
    ...init,
    headers: buildBffHeaders(init, correlationId),
  });

  if (!res.ok) {
    let code = "INTERNAL";
    let message = (opts?.parseFailureMessage ?? defaultParseFailureMessage)(res.status);
    let envelope: BffErrorEnvelope | undefined;
    try {
      const parsed = (await res.json()) as BffErrorEnvelope;
      envelope = parsed;
      code = parsed.error.code;
      message = parsed.error.message;
    } catch {
      // parse failure — keep the (possibly friendly) fallback message, never log the body
    }
    const error = new ApiError(code, message, res.status);
    // RB-6: attach the correlation id the failure is traceable by — prefer the server's echoed id
    // (header or envelope), else the client id we sent (the server honours it). Surfaces as a
    // copyable support id and never regresses the { code, message } envelope contract.
    const envelopeId = envelope?.error.correlationId;
    error.correlationId =
      res.headers.get(CORRELATION_HEADER) ??
      (typeof envelopeId === "string" ? envelopeId : correlationId);
    opts?.enrichError?.(error, envelope);
    throw error;
  }

  if (res.status === 204) {
    return undefined as T;
  }

  const value = (await res.json()) as unknown;
  return opts?.validator === undefined ? (value as T) : opts.validator(path, value);
}
