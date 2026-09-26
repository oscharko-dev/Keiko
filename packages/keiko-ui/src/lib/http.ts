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
 *  - On a 403 `DENIED`: a restarted BFF invalidates its in-memory app session (ADR-0141 D5), so a
 *    managed-task-workspace read was denied forever — the client never re-paired. The shared
 *    `repairLocalCodingAppSession()` runs once per denial burst, and a safe read (GET/HEAD) is
 *    replayed exactly once; a write is never replayed. `opts.repairSession: false` opts a request
 *    out (the app-session requests themselves).
 *
 * `ApiError` is imported FROM ./api (one-way): api.ts owns the canonical error class and MUST NOT
 * import this module (that would be a cycle). `repairLocalCodingAppSession` is loaded with a dynamic
 * `import()` inside the repair path below, for the same reason: `./coding-app-session-client` imports
 * `bffFetchJson` FROM this module, so a static import back here would be a cycle.
 */

import type { ActivityLogErrorKind } from "@oscharko-dev/keiko-contracts/runtime/observability";
import { ApiError } from "./api";
import { buildBffHeaders, CORRELATION_HEADER, newClientCorrelationId } from "./bff-correlation";
import {
  reportClientDiagnostic,
  type ClientDiagnosticSessionRepairReport,
} from "./client-diagnostics";
import { clientErrorSummary } from "./client-error-summary";

// Re-exported for the existing consumers that import these two from "./http"
// (SelectionAwareWorkspaceHosts.tsx, coding-app-session-channel-api.ts). The implementation lives in ./bff-correlation so this file
// and ./api can both depend on it without the module cycle documented above.
export { CORRELATION_HEADER, newClientCorrelationId };

// A successful JSON response exposed no correlation id at all — only a thrown `ApiError` did, via
// `.correlationId` above. The server stamps `X-Keiko-Correlation-Id` on every response, success
// included (server.ts), so the gap was entirely client-side: a caller holding only the parsed body
// (AddRepositoryDialog's discarded-succeeded clone/register settlement, PR #3625 review) had no way
// back to it.
//
// `api.ts` — the pinned SonarCloud/update-UI-evidence surface `check:update-ui-evidence` hashes —
// owns its OWN fetch scaffold, `fetchJson`, entirely independent of `performBffFetch` below (its own
// header comment lists the satellite modules that delegate here; `api.ts` is deliberately not one of
// them). A capture wired only through `performBffFetch` would therefore never see a single Git route
// (`cloneRepository`, `createProject`, `fetchGitStatus`, …) — every one of them is a `fetchJson` call.
// The capture below is installed on the shared `Response.prototype.json` itself instead: the one
// point every JSON parse in this application passes through regardless of which scaffold called it,
// so it works for both without duplicating either.
//
// Tagging the wrapper function (rather than a module-level boolean) makes installation idempotent
// per REALM rather than per module evaluation: a test environment that hands each file its own
// `Response` class (a fresh jsdom window) must still install its own capture even though this
// module's top-level code may already have run once in the process.
const RESPONSE_JSON_CORRELATION_CAPTURE_TAG = Symbol.for("keiko.responseJsonCorrelationCapture");

const RESPONSE_CORRELATION_IDS = new WeakMap<object, string>();

function installResponseJsonCorrelationCapture(): void {
  if (typeof Response === "undefined") return;
  const current = Response.prototype.json as Partial<
    Record<typeof RESPONSE_JSON_CORRELATION_CAPTURE_TAG, boolean>
  >;
  if (current[RESPONSE_JSON_CORRELATION_CAPTURE_TAG] === true) return;
  const originalJson = Response.prototype.json;
  async function correlatedJson(this: Response): Promise<unknown> {
    const correlationId = this.headers.get(CORRELATION_HEADER);
    const value: unknown = await originalJson.call(this);
    if (correlationId !== null && typeof value === "object" && value !== null) {
      RESPONSE_CORRELATION_IDS.set(value, correlationId);
    }
    return value;
  }
  (correlatedJson as unknown as Record<typeof RESPONSE_JSON_CORRELATION_CAPTURE_TAG, boolean>)[
    RESPONSE_JSON_CORRELATION_CAPTURE_TAG
  ] = true;
  Response.prototype.json = correlatedJson;
}

installResponseJsonCorrelationCapture();

/**
 * The server's correlation id for the response a successful JSON body was parsed from, when that
 * response carried one (every response does, server.ts) — the success-path counterpart to
 * `ApiError.correlationId`. Looked up by the exact parsed object identity the capture above records,
 * so it survives being handed back unchanged through `fetchJson`/`bffFetchJson`'s pinned call sites;
 * `undefined` for any value this process never parsed from a `Response` (a hand-built fixture, a
 * response whose body was empty, or one that carried no correlation header at all).
 */
export function responseCorrelationIdOf(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  return RESPONSE_CORRELATION_IDS.get(value);
}

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
  /**
   * `false` for the app-session requests themselves (pair, local session): their denial is final,
   * and a repair started from inside the repair would join its own attempt and never settle.
   */
  readonly repairSession?: boolean;
  /**
   * The correlation id this request carries, when the caller must name it in evidence (the session
   * repair's own request, a replay that joins the denied request's timeline). Minted otherwise.
   */
  readonly correlationId?: string;
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

interface BffErrorBody {
  readonly code: string;
  readonly message: string;
  readonly envelope: BffErrorEnvelope | undefined;
}

// The `{ error: { code, message } }` envelope of a non-2xx body, or the classified fallback when
// the body is not one. A body that is JSON but not the envelope (an empty object, a bare string) is
// a parse failure too: it must never be read as one, or the read itself throws a TypeError that
// replaces the classified error the caller is about to render. The body itself never leaves here.
async function parseBffErrorBody<T>(
  res: Response,
  opts: BffFetchOptions<T> | undefined,
): Promise<BffErrorBody> {
  const fallback: BffErrorBody = {
    code: "INTERNAL",
    message: (opts?.parseFailureMessage ?? defaultParseFailureMessage)(res.status),
    envelope: undefined,
  };
  try {
    const parsed: unknown = await res.json();
    if (!isBffErrorEnvelope(parsed)) return fallback;
    return { code: parsed.error.code, message: parsed.error.message, envelope: parsed };
  } catch {
    // parse failure — keep the (possibly friendly) fallback message, never log the body
    return fallback;
  }
}

async function performBffFetch<T>(
  path: string,
  init: RequestInit | undefined,
  opts: BffFetchOptions<T> | undefined,
): Promise<T> {
  const correlationId = opts?.correlationId ?? newClientCorrelationId();
  const res = await fetch(path, {
    ...init,
    headers: buildBffHeaders(init, correlationId),
  });

  if (!res.ok) {
    const { code, message, envelope } = await parseBffErrorBody(res, opts);
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
    } catch (hookError) {
      // The ApiError below already carries code, status and correlation id, so the request stays
      // renderable — but the CLASSIFICATION step failed, and the hook is the only place
      // `failureClass` is attached. Swallowing that silently made every refusal of a broken hook
      // degrade to an unclassified error with nothing recording why (AGENTS.md §7/§8, #3381
      // review). Body-free: the hook's error class and the failed request's correlation id.
      reportClientDiagnostic(
        `[keiko] bff error enrichment failed: ${clientErrorSummary(hookError)}`,
        {
          correlationId: error.correlationId,
        },
      );
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

// A stale app session after a BFF restart answers 403 `DENIED` (ADR-0141 D5; `resolveRequestRoot`'s
// `managed-root-session-authority-missing`), but so does a genuine refusal: an EACCES/EPERM file, a
// denied sensitive path, an unclaimed managed root. The client cannot tell them apart. Every other
// 403 code (`PATH_ESCAPE`, `HOT_EXIT_REF_MISMATCH`, …) is a refusal a session cannot change.
function isDeniedError(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 403 && error.code === "DENIED";
}

// Only a safe read may run twice. A denied write may have started before it was refused (a
// multi-file write hitting EACCES), so replaying it could apply part of it again.
function isReplayableRead(init: RequestInit | undefined): boolean {
  const method = (init?.method ?? "GET").toUpperCase();
  return method === "GET" || method === "HEAD";
}

const HTTP_STATUS_ERROR_KINDS: Readonly<Record<number, ActivityLogErrorKind>> = {
  401: "authority-denied",
  403: "authority-denied",
  408: "timeout",
  409: "conflict",
  429: "rate-limited",
  499: "cancelled",
  500: "internal",
};

/**
 * The closed error kind of a failed BFF request, for evidence (#3557 review): an HTTP refusal by its
 * status, a cancellation, a transport failure. Never the error's message.
 */
export function bffRequestErrorKind(error: unknown): ActivityLogErrorKind {
  if (error instanceof ApiError) {
    const exact = HTTP_STATUS_ERROR_KINDS[error.status];
    if (exact !== undefined) return exact;
    if (error.status >= 500) return "unavailable";
    return error.status >= 400 ? "invalid-request" : "unknown";
  }
  if (error instanceof DOMException && error.name === "AbortError") return "cancelled";
  // `fetch` rejects a transport failure (refused connection, lost network) with a TypeError.
  return error instanceof TypeError ? "unavailable" : "unknown";
}

// The denied request, the repair and the replay are three requests; this report links them on the
// denied request's timeline (the replay reuses its id), names the outcome, and classifies the step
// that failed (#3557 review).
function reportSessionRepair(
  outcome: ClientDiagnosticSessionRepairReport["outcome"],
  deniedCorrelationId: string,
  repairCorrelationId: string,
  errorKind?: ActivityLogErrorKind,
): void {
  // i18n-exempt: body-free diagnostic message for the activity log, never rendered
  reportClientDiagnostic(`[keiko] stale session repair: ${outcome}`, {
    correlationId: deniedCorrelationId,
    sessionRepairReport: {
      outcome,
      repairCorrelationId,
      ...(errorKind === undefined ? {} : { errorKind }),
    },
  });
}

async function repairAndReplay<T>(
  denied: ApiError,
  path: string,
  init: RequestInit | undefined,
  opts: BffFetchOptions<T> | undefined,
): Promise<T> {
  const { repairLocalCodingAppSessionWithEvidence } = await import("./coding-app-session-client");
  const repair = await repairLocalCodingAppSessionWithEvidence();
  const deniedCorrelationId = denied.correlationId ?? newClientCorrelationId();
  if (!repair.repaired) {
    reportSessionRepair(
      "repair-failed",
      deniedCorrelationId,
      repair.correlationId,
      repair.errorKind,
    );
    throw denied;
  }
  if (!isReplayableRead(init)) {
    // The write stays refused as it was: the original denial is the failure.
    reportSessionRepair(
      "replay-skipped",
      deniedCorrelationId,
      repair.correlationId,
      "authority-denied",
    );
    throw denied;
  }
  try {
    const value = await performBffFetch(path, init, {
      ...opts,
      correlationId: deniedCorrelationId,
    });
    reportSessionRepair("replayed", deniedCorrelationId, repair.correlationId);
    return value;
  } catch (replayError) {
    reportSessionRepair(
      "replay-failed",
      deniedCorrelationId,
      repair.correlationId,
      bffRequestErrorKind(replayError),
    );
    throw replayError;
  }
}

/**
 * `performBffFetch`, self-healing a stale app session: on a 403 `DENIED` it runs the shared
 * `repairLocalCodingAppSession` (one local-session request per denial burst, a no-op on a valid
 * cookie) and replays a safe read exactly once, under the denied request's own correlation id. A
 * write is never replayed; the repair still runs, so the user's next attempt carries the session.
 * The replay's own result is returned as-is and a failed repair returns the original error, so this
 * never loops. A genuine denial costs one repeated read. Every repair outcome is reported.
 */
export async function bffFetchJson<T>(
  path: string,
  init?: RequestInit,
  opts?: BffFetchOptions<T>,
): Promise<T> {
  try {
    return await performBffFetch(path, init, opts);
  } catch (error) {
    if (!isDeniedError(error) || opts?.repairSession === false) throw error;
    return repairAndReplay(error, path, init, opts);
  }
}
