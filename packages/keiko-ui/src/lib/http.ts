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
import { buildBffHeaders, CORRELATION_HEADER, newClientCorrelationId } from "./bff-correlation";

// Re-exported for the existing consumers that import these two from "./http"
// (AppShell.tsx, RepositoryFolderSwitcher.tsx, SelectionAwareWorkspaceHosts.tsx,
// coding-app-session-channel-api.ts). The implementation lives in ./bff-correlation so this file
// and ./api can both depend on it without the module cycle documented above.
export { CORRELATION_HEADER, newClientCorrelationId };

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

/**
 * The shared BFF fetch scaffold. Kept as a referenceable generic function so satellite modules can
 * bind it as their `fetchImpl = bffFetchJson<T>` default-param test seam.
 */
function isBffErrorEnvelope(value: unknown): value is BffErrorEnvelope {
  if (typeof value !== "object" || value === null || !("error" in value)) return false;
  const error: unknown = value.error;
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    "message" in error &&
    typeof error.message === "string"
  );
}

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
      const parsed: unknown = await res.json();
      // A body that is JSON but not the envelope (an empty object, a bare string) is a parse
      // failure too: it must never be read as one, or the read itself throws a TypeError that
      // replaces the classified error the caller is about to render.
      if (isBffErrorEnvelope(parsed)) {
        envelope = parsed;
        code = parsed.error.code;
        message = parsed.error.message;
      }
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
    // The hook decorates the classified error; a hook that throws on an unexpected envelope shape
    // must not replace that error with its own — the caller would then render a raw TypeError.
    try {
      opts?.enrichError?.(error, envelope);
    } catch {
      // The ApiError below already carries code, status and correlation id; the hook added nothing.
    }
    throw error;
  }

  if (res.status === 204) {
    return undefined as T;
  }

  const value = (await res.json()) as unknown;
  if (opts?.validator === undefined) return value as T;
  try {
    return opts.validator(path, value);
  } catch (error) {
    // RB-6 (#2768): a contract-validation failure is as traceable as a non-2xx — the request DID
    // reach the server and produced a server-side record under this id. Attaching it here, at the
    // layer that owns the correlation id, means every validator gets it without each one having to
    // thread the id through; a validator throwing a coded ApiError otherwise reached the surface
    // with no support id at all.
    if (error instanceof ApiError && error.correlationId === undefined) {
      error.correlationId = res.headers.get(CORRELATION_HEADER) ?? correlationId;
    }
    throw error;
  }
}
