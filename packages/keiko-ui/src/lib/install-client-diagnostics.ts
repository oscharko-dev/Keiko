"use client";

// Where THIS application delivers client diagnostics (0.3.0 release audit, #2802; second
// transport added Wave 5 of epic #3233 / ADR-0173, g6).
//
// `client-diagnostics.ts` owns the contract — what a diagnostic is, and that it is already redacted.
// It deliberately owns no transport, so that the one place a browser console is written to is a
// module whose whole purpose is choosing the transport, rather than a line buried in the library
// every call site imports.
//
// Importing this module installs the transport as a side effect, at module scope rather than in an
// effect, so diagnostics raised during hydration or an early boot crash are delivered too. Whatever
// the sink buffered before this point is flushed by `setClientDiagnosticWriter`.
//
// FAN-OUT, NOT A REPLACEMENT: the console remains the first transport (a developer watching devtools
// still sees every diagnostic even when the network call below is slow, throttled, or fails) and a
// best-effort POST to `POST /api/diagnostics/client` (packages/keiko-server/src/
// client-diagnostics-routes.ts) is added alongside it, so the same already-redacted, already-bounded
// string and its closed body-free metadata also reach the server's activity log — the
// machine-reconstruction surface the rest of epic #3233 builds. The wire contract
// (`packages/keiko-contracts/src/diagnostics.ts`) treats the
// browser as untrusted input regardless of what this module sends; nothing here is a second place
// that does redaction, it only forwards the SAME string `reportClientDiagnostic` callers already
// bounded and redacted by convention.
//
// `correlationId` (Wave 5, wired in a follow-up to this wave): `client-error-summary.ts`'s
// `correlationIdOf(error)` recovers the originating request's id from any caught `ApiError` (the
// class `bffFetchJson`, http.ts, stamps a `.correlationId` on for every non-2xx and every contract
// validation failure — api.ts ~line 195, http.ts ~lines 126-129/148-149). Every `reportClientDiagnostic`
// call site that catches such an error passes it through `meta.correlationId`, and
// `clientDiagnosticPostBody` below puts it on the wire once it re-validates the shape client-side
// (defense in depth — the server, `client-diagnostics-routes.ts`, re-validates it again
// independently before trusting it for anything). No request id exists for the four SSE
// `onerror` call sites (sharedEventSource.ts, useSSE.ts, coding-workbench-event-retention.ts,
// useRelationshipActivityStream.ts): the native `EventSource` API exposes no response headers to
// page script — a hard platform limit. The two streams that repair a stale session
// (sharedEventSource.ts, useSSE.ts) carry their failure streak's client-minted id instead, which
// their session-repair reports share (#3557 review).

import type {
  ClientBindingIngestRequest,
  ClientBindingOutcome,
  ClientDiagnosticIngestRequest,
  ClientDiagnosticLossCounts,
  ClientDiagnosticReadyState,
  ClientSessionRepairIngestRequest,
  ClientSessionRepairOutcome,
  ClientStageIngestRequest,
} from "@oscharko-dev/keiko-contracts/runtime/diagnostics";
import {
  CLIENT_BINDING_FAILURE_OUTCOMES,
  CLIENT_BINDING_RELATED_CORRELATIONS_MAX,
  CLIENT_DIAGNOSTIC_MESSAGE_MAX_LENGTH,
  CLIENT_SESSION_REPAIR_ROUTINE_OUTCOMES,
} from "@oscharko-dev/keiko-contracts/runtime/diagnostics";
import {
  type ClientDiagnosticBindingReport,
  type ClientDiagnosticMeta,
  type ClientDiagnosticSessionRepairReport,
  type ClientDiagnosticStageReport,
  recordClientDiagnosticLoss,
  restoreClientDiagnosticLoss,
  setClientDiagnosticWriter,
  takeClientDiagnosticLoss,
} from "./client-diagnostics";
import { bffFetchJson } from "./http";

function writeToBrowserConsole(message: string): void {
  // The single sanctioned console access in keiko-ui production code. Everything above this line is
  // why it is here — in the transport, not in the sink — rather than at each call site.
  // eslint-disable-next-line no-console
  if (typeof console !== "undefined" && typeof console.warn === "function") console.warn(message);
}

// Fixed, bounded, and content-free by construction: it never repeats the original diagnostic
// message or any error detail, so it cannot itself become a place that leaks something the sink
// already redacted. Written with `writeToBrowserConsole` directly (never `reportClientDiagnostic`)
// — going back through the sink would re-enter `fanOutClientDiagnostic` and, on a persistently
// failing transport, retry the same failing POST on every diagnostic: a reporting loop.
const DIAGNOSTIC_DELIVERY_FAILURE_NOTICE =
  "[keiko] diagnostic delivery to the server failed; the diagnostic above (if any) was not recorded server-side.";
// Same reasoning as the failure notice: a throttled drop must leave a trace in the console, or the
// busiest boot — the one most likely to hold a real stall — is the one whose evidence vanishes silently.
// Written once per throttled window, never per dropped diagnostic.
const DIAGNOSTIC_DELIVERY_THROTTLED_NOTICE =
  "[keiko] diagnostic delivery to the server is throttled; further diagnostics in this window stay console-only.";

// Mirrors the server's SAFE_CORRELATION_ID predicate (packages/keiko-server/src/correlation.ts).
// keiko-ui may only depend on the server through the shared contract types (AGENTS.md §4), never on
// a server module directly, so this file re-derives the same alphabet+length shape as its own,
// client-side copy rather than importing one — the same layering `diagnostics.ts` (keiko-contracts)
// documents for its own, deliberately looser, wire-shape guard.
const CLIENT_CORRELATION_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;

// Drops silently (never throws) on a caller-supplied id that is not shape-valid: a malformed id is
// still a successful diagnostic report, just without a join key attached.
function validCorrelationId(correlationId: string | undefined): string | undefined {
  return correlationId !== undefined && CLIENT_CORRELATION_ID_PATTERN.test(correlationId)
    ? correlationId
    : undefined;
}

// The four SSE-consuming modules (sharedEventSource.ts, useSSE.ts,
// coding-workbench-event-retention.ts, useRelationshipActivityStream.ts) each format their
// `EventSource.onerror` diagnostic with this EXACT substring so this module can recover the
// structured `readyState`/`kind` wire fields from the plain string `reportClientDiagnostic` takes —
// without those four modules importing this one (which would pull its module-scope
// `setClientDiagnosticWriter` side effect into their own unit tests). The four call sites duplicate
// a four-line pure formatter rather than share this module for exactly that reason; this pattern is
// the other half of that contract and is pinned against all four by this file's own test.
const SSE_DIAGNOSTIC_MESSAGE_PATTERN =
  /kind=sse-error, readyState=([0-2]), reason=(?:connecting|closed|unknown)/;

function parsedSseReadyState(digit: string): ClientDiagnosticReadyState {
  if (digit === "0") return 0;
  if (digit === "2") return 2;
  return 1;
}

// The stage wire body carries no `message`, `clientTs`, `correlationId` or `loss`: a stage mount is
// not itself a server request (there is nothing to correlate against) and its evidence is already
// closed and bounded, never free text (KEIKO-3557).
function clientStagePostBody(
  report: ClientDiagnosticStageReport,
  correlationId: string | undefined,
): ClientStageIngestRequest {
  const id = validCorrelationId(correlationId);
  return report.phase === "started"
    ? {
        kind: "stage",
        stage: report.stage,
        phase: "started",
        ordinal: report.ordinal,
        correlationId: id,
      }
    : {
        kind: "stage",
        stage: report.stage,
        phase: "settled",
        ordinal: report.ordinal,
        durationMs: report.durationMs,
        correlationId: id,
      };
}

// A binding report (#3557) is closed values plus the correlation id of the request that decided it.
function clientBindingPostBody(
  report: ClientDiagnosticBindingReport,
  correlationId: string | undefined,
): ClientBindingIngestRequest {
  const related = (report.relatedCorrelationIds ?? [])
    .flatMap((id): string[] => {
      const valid = validCorrelationId(id);
      return valid === undefined ? [] : [valid];
    })
    .slice(0, CLIENT_BINDING_RELATED_CORRELATIONS_MAX);
  return {
    kind: "binding",
    surface: report.surface,
    outcome: report.outcome,
    referenceShape: report.referenceShape,
    heuristicFlagged: report.heuristicFlagged,
    windowRef: report.windowRef,
    correlationId: validCorrelationId(correlationId),
    ...(related.length === 0 ? {} : { relatedCorrelationIds: related }),
    // The total stays even when the named list is cut, so the server marks the line partial.
    ...(report.decidingLoadCount === undefined
      ? {}
      : { decidingLoadCount: report.decidingLoadCount }),
    ...(report.candidateCount === undefined ? {} : { candidateCount: report.candidateCount }),
    ...(report.disambiguatedCount === undefined
      ? {}
      : { disambiguatedCount: report.disambiguatedCount }),
    ...(report.targetFingerprint === undefined
      ? {}
      : { targetFingerprint: report.targetFingerprint }),
  };
}

// A session-repair report (#3557) belongs to the denied request's timeline, so it needs that id,
// and it links the repair request it describes, so it needs that one too.
function clientSessionRepairPostBody(
  report: ClientDiagnosticSessionRepairReport,
  correlationId: string | undefined,
): ClientSessionRepairIngestRequest | undefined {
  const id = validCorrelationId(correlationId);
  const repairCorrelationId = validCorrelationId(report.repairCorrelationId);
  if (id === undefined || repairCorrelationId === undefined) return undefined;
  return {
    kind: "session-repair",
    outcome: report.outcome,
    correlationId: id,
    repairCorrelationId,
    errorKind: report.errorKind,
    stream: report.stream,
  };
}

type StructuredPostBody =
  ClientStageIngestRequest | ClientBindingIngestRequest | ClientSessionRepairIngestRequest;

// The closed report the metadata names, if any. A closed report carries no loss counts.
function structuredPostBody(
  meta: ClientDiagnosticMeta | undefined,
): StructuredPostBody | undefined {
  if (meta?.stageReport !== undefined) {
    return clientStagePostBody(meta.stageReport, meta.correlationId);
  }
  if (meta?.bindingReport !== undefined) {
    return clientBindingPostBody(meta.bindingReport, meta.correlationId);
  }
  if (meta?.sessionRepairReport !== undefined) {
    return clientSessionRepairPostBody(meta.sessionRepairReport, meta.correlationId);
  }
  return undefined;
}

// Builds the wire body for one already-bounded diagnostic message. `clientTs` is stamped at send
// time (not at the original `reportClientDiagnostic` call), which is close enough for an operator
// diagnostic and avoids threading a timestamp through the sink's string-only contract.
// `exactOptionalPropertyTypes` is honoured because `ClientDiagnosticIngestRequest`'s optional fields
// are all typed `T | undefined` (keiko-contracts), so assigning `undefined` outright is legal — and
// `JSON.stringify` drops an `undefined`-valued key from the wire body regardless, so an absent
// correlation id never reaches the request at all. `loss` carries the page's counted delivery loss
// since its last delivered report (#3532).
function clientMessagePostBody(
  message: string,
  meta: ClientDiagnosticMeta,
  loss: ClientDiagnosticLossCounts | undefined,
): ClientDiagnosticIngestRequest {
  const bounded =
    message.length > CLIENT_DIAGNOSTIC_MESSAGE_MAX_LENGTH
      ? message.slice(0, CLIENT_DIAGNOSTIC_MESSAGE_MAX_LENGTH)
      : message;
  const base = {
    message: bounded,
    clientTs: new Date().toISOString(),
    correlationId: validCorrelationId(meta.correlationId),
    parentCorrelationId: validCorrelationId(meta.parentCorrelationId),
    errorKind: meta.errorKind,
    voiceDialogueStage: meta.voiceDialogueStage,
    voiceCaptureReason: meta.voiceCaptureReason,
    voiceCaptureError: meta.voiceCaptureError,
    markdownLayout: meta.markdownLayout,
    moduleLoadFailure: meta.moduleLoadFailure,
    errorEvidence: meta.errorEvidence,
    gitChangeDescription: meta.gitChangeDescription,
    workspaceTrustBinding: meta.workspaceTrustBinding,
    loss,
  };
  const readyStateDigit = SSE_DIAGNOSTIC_MESSAGE_PATTERN.exec(message)?.[1];
  if (readyStateDigit === undefined) return { ...base, kind: meta.kind };
  return { ...base, readyState: parsedSseReadyState(readyStateDigit), kind: "sse-error" };
}

// `meta.stageReport` or `meta.bindingReport`, when present, means `message` is the console text of
// a closed report: the structured report is sent instead, never folded into the message shape.
function clientDiagnosticPostBody(
  message: string,
  meta: ClientDiagnosticMeta | undefined,
  loss: ClientDiagnosticLossCounts | undefined,
): ClientDiagnosticIngestRequest | StructuredPostBody {
  return structuredPostBody(meta) ?? clientMessagePostBody(message, meta ?? {}, loss);
}

// Process-wide (module-scope), not per-diagnostic: a flapping stream or a hostile page must not be
// able to grow the activity log without bound. The server independently rate-limits the same route
// (client-diagnostics-routes.ts); this is defense in depth on the sending side, so a burst never
// leaves the tab at all.
//
// Two budgets (#3557): a page load posts about a dozen routine stage reports, and with one shared
// budget a failure raised during boot, the one most likely to hold a real stall, was dropped
// console-only. Routine evidence now spends its own budget and can never starve a failure report.
const CLIENT_DIAGNOSTIC_POST_LIMITS = { failure: 20, routine: 60 } as const;
const CLIENT_DIAGNOSTIC_POST_WINDOW_MS = 60_000;

type ClientDiagnosticPostBudget = keyof typeof CLIENT_DIAGNOSTIC_POST_LIMITS;

interface PostWindow {
  startedAtMs: number;
  count: number;
  // Drops in the CURRENT window, reset with it: the throttle notice is written on the first drop of
  // every window, so a burst in a later window leaves its own trace instead of vanishing behind a
  // process-lifetime counter (#3376 review).
  throttled: number;
}

function freshPostWindow(): PostWindow {
  return { startedAtMs: 0, count: 0, throttled: 0 };
}

const postWindows: Record<ClientDiagnosticPostBudget, PostWindow> = {
  failure: freshPostWindow(),
  routine: freshPostWindow(),
};
let postFailureCount = 0;
let postThrottledCount = 0;

function bindingPostBudget(outcome: ClientBindingOutcome): ClientDiagnosticPostBudget {
  return CLIENT_BINDING_FAILURE_OUTCOMES.has(outcome) ? "failure" : "routine";
}

function repairPostBudget(
  outcome: ClientSessionRepairOutcome | undefined,
): ClientDiagnosticPostBudget {
  return outcome !== undefined && CLIENT_SESSION_REPAIR_ROUTINE_OUTCOMES.has(outcome)
    ? "routine"
    : "failure";
}

// Routine evidence: a stage, every binding outcome but a missing target (an offer and a person's
// decision included), a session repair that recovered. Everything else is a failure report. The
// binding and repair rules are the server's own (keiko-contracts), so the two budgets never drift.
function postBudget(meta: ClientDiagnosticMeta | undefined): ClientDiagnosticPostBudget {
  if (meta === undefined) return "failure";
  if (meta.stageReport !== undefined) return "routine";
  if (meta.bindingReport !== undefined) return bindingPostBudget(meta.bindingReport.outcome);
  return repairPostBudget(meta.sessionRepairReport?.outcome);
}

function admittedByClientPostRateLimit(window: PostWindow, limit: number, nowMs: number): boolean {
  if (nowMs - window.startedAtMs >= CLIENT_DIAGNOSTIC_POST_WINDOW_MS) {
    window.startedAtMs = nowMs;
    window.count = 0;
    window.throttled = 0;
  }
  if (window.count >= limit) return false;
  window.count += 1;
  return true;
}

/** Test-only: number of best-effort diagnostic POSTs that failed (network error or non-2xx). */
export function clientDiagnosticPostFailureCount(): number {
  return postFailureCount;
}

/** Test-only: number of diagnostic POSTs dropped by the client-side rate limit. */
export function clientDiagnosticPostThrottledCount(): number {
  return postThrottledCount;
}

/** Test-only: put the POST transport's rate limiter and failure/drop counters back to a clean start. */
export function resetClientDiagnosticPostStateForTests(): void {
  postWindows.failure = freshPostWindow();
  postWindows.routine = freshPostWindow();
  postFailureCount = 0;
  postThrottledCount = 0;
}

// Best-effort POST to the server activity log. Never awaited by a call site and never lets a
// rejected fetch (or a non-2xx `ApiError` `bffFetchJson` throws) reach back into
// `reportClientDiagnostic`'s caller — the same best-effort discipline `writeToBrowserConsole`
// already has, just with a `.catch` standing in for that function's `typeof` guards. A failure is
// counted (for tests) AND surfaced to the console directly via the fixed, content-free
// `DIAGNOSTIC_DELIVERY_FAILURE_NOTICE` (AGENTS.md §7: "errors must surface with enough context to
// diagnose" — silently dropping a failed POST left a developer with no way to tell the server never
// received the diagnostic). This never calls back through `reportClientDiagnostic`, which would
// re-enter `fanOutClientDiagnostic` and risk a loop under a persistently failing transport.
// A failed delivery loses this report AND the loss counts it was carrying: the counts go back to
// the page's ledger for the next report, and the report itself is counted as a failed POST.
function recordFailedPost(loss: ClientDiagnosticLossCounts | undefined): void {
  postFailureCount += 1;
  restoreClientDiagnosticLoss(loss);
  recordClientDiagnosticLoss("postsFailed");
  writeToBrowserConsole(DIAGNOSTIC_DELIVERY_FAILURE_NOTICE);
}

function sendClientDiagnostic(
  message: string,
  meta: ClientDiagnosticMeta | undefined,
  loss: ClientDiagnosticLossCounts | undefined,
): void {
  try {
    const body = clientDiagnosticPostBody(message, meta ?? {}, loss);
    void bffFetchJson<undefined>("/api/diagnostics/client", {
      method: "POST",
      body: JSON.stringify(body),
      keepalive: true,
    }).catch(() => {
      recordFailedPost(loss);
    });
  } catch {
    recordFailedPost(loss);
  }
}

// A closed report's wire shape (stage, binding, session repair) has no `loss` field, so draining
// the ledger here would silently discard it — never taken, so it keeps
// accumulating for the next message report or the pagehide flush to carry, exactly as it already
// does today when a burst of one kind of report happens to fall between two of another.
function postClientDiagnosticToServer(message: string, meta?: ClientDiagnosticMeta): void {
  const budget = postBudget(meta);
  const window = postWindows[budget];
  if (!admittedByClientPostRateLimit(window, CLIENT_DIAGNOSTIC_POST_LIMITS[budget], Date.now())) {
    postThrottledCount += 1;
    window.throttled += 1;
    recordClientDiagnosticLoss("postsThrottled");
    if (window.throttled === 1) writeToBrowserConsole(DIAGNOSTIC_DELIVERY_THROTTLED_NOTICE);
    return;
  }
  const loss = structuredPostBody(meta) === undefined ? takeClientDiagnosticLoss() : undefined;
  sendClientDiagnostic(message, meta, loss);
}

// Loss counted after the page's last report would otherwise stay in the tab forever: a storm of
// suppressed rejections followed by silence has no "next report" to ride on. When the page is
// hidden for good, one final keepalive report carries whatever is still counted. It bypasses the
// client throttle — it is at most one report per page lifetime — and the server still rate-limits.
const LOSS_FLUSH_MESSAGE = "[keiko] client diagnostic delivery loss summary"; // i18n-exempt: developer diagnostic for the activity log, never rendered to a person

export function flushClientDiagnosticLoss(): void {
  const loss = takeClientDiagnosticLoss();
  if (loss !== undefined) sendClientDiagnostic(LOSS_FLUSH_MESSAGE, { kind: "other" }, loss);
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("pagehide", flushClientDiagnosticLoss);
}

// The fan-out composite: every diagnostic reaches both transports. Console first, so a developer
// watching devtools sees it even when the POST below is throttled or fails. `meta` only ever
// affects the POST body — the console transport stays the plain, undecorated message it always was.
function fanOutClientDiagnostic(message: string, meta?: ClientDiagnosticMeta): void {
  writeToBrowserConsole(message);
  postClientDiagnosticToServer(message, meta);
}

setClientDiagnosticWriter(fanOutClientDiagnostic);

export { writeToBrowserConsole, fanOutClientDiagnostic };
