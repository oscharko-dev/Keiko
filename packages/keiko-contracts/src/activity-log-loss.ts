// One bounded, process-wide Activity Log loss ledger (#3532).
//
// A dropped, suppressed, evicted or rejected event must never disappear without a trace: a quiet
// log and a log that silently stopped working look identical from the outside, which is exactly the
// silence the Activity Log exists to end. Every place that loses an event therefore counts it here,
// under one closed reason, and the server persists the counters as an `activity-log.loss` summary
// on each heartbeat and at exit.
//
// WHY IT LIVES IN THE CONTRACTS LEAF
//
// The packages that own a log port (security, local knowledge, memory vault, consolidation, the
// Model Gateway) sit below the server (ADR-0019) and may depend only on this leaf. Counting a loss
// where it happens therefore needs a ledger every layer reaches without a dependency edge pointing
// the wrong way — the same reason the registry itself lives here. The ledger is a fixed record of
// closed counters: never a queue, never content, never a second evidence store. Its memory is
// bounded by construction and every counter saturates instead of overflowing.
//
// Recording a loss never throws and never logs: a counter increment cannot fail, so the ledger can
// be updated from inside a failing sink without any risk of recursion.

export const ACTIVITY_LOG_LOSS_REASONS = [
  // The server logger caught a failure while building or writing an event; the line was lost.
  "logger-write-failed",
  // No writable production logger existed for the process; the event was dropped at the logger.
  "logger-unavailable",
  // The persisted-event validation refused an event (unregistered operation or rejected fields).
  "schema-rejected",
  // A file-sink persistence attempt failed (full disk, permission change, mutated target).
  "persistence-failed",
  // A server diagnostic record could not be delivered to its sink.
  "diagnostic-sink-failed",
  // A domain package's log-port sink threw; every failure is counted, not only the first.
  "port-sink-failed",
  // A domain package's log port had no sink wired, so the event it was handed went nowhere.
  "port-unwired",
  // The BFF refused a browser diagnostic report as malformed or oversized.
  "client-rejected",
  // The BFF rate limiter dropped a browser diagnostic report.
  "client-rate-suppressed",
  // Counts the browser reported for its own side of the transport.
  "client-buffer-evicted",
  "client-post-throttled",
  "client-post-failed",
  "client-rejection-suppressed",
  "client-error-suppressed",
  // The CLI's deferred security-event collector dropped events it could not persist.
  "collector-dropped",
  // The loss summary itself could not be persisted (counted, never retried recursively).
  "summary-write-failed",
] as const;

export type ActivityLogLossReason = (typeof ACTIVITY_LOG_LOSS_REASONS)[number];

export type ActivityLogLossCounters = Readonly<Record<ActivityLogLossReason, number>>;

function zeroCounters(): Record<ActivityLogLossReason, number> {
  return Object.fromEntries(ACTIVITY_LOG_LOSS_REASONS.map((reason) => [reason, 0])) as Record<
    ActivityLogLossReason,
    number
  >;
}

let counters = zeroCounters();

const LOSS_REASON_SET: ReadonlySet<string> = new Set(ACTIVITY_LOG_LOSS_REASONS);

export function isActivityLogLossReason(value: unknown): value is ActivityLogLossReason {
  return typeof value === "string" && LOSS_REASON_SET.has(value);
}

/**
 * Counts `count` lost events under one closed reason. A non-positive, non-integer or unknown input
 * is ignored rather than thrown: this runs inside failure paths that must never gain a new one.
 */
export function recordActivityLogLoss(reason: ActivityLogLossReason, count = 1): void {
  if (!isActivityLogLossReason(reason) || !Number.isSafeInteger(count) || count <= 0) return;
  counters[reason] = Math.min(Number.MAX_SAFE_INTEGER, counters[reason] + count);
}

/** A copy of the current counters; mutating it never changes the ledger. */
export function activityLogLossCounters(): ActivityLogLossCounters {
  return { ...counters };
}

/** The saturating sum of every counter. */
export function activityLogLossTotal(
  snapshot: ActivityLogLossCounters = activityLogLossCounters(),
): number {
  let total = 0;
  for (const reason of ACTIVITY_LOG_LOSS_REASONS) {
    total = Math.min(Number.MAX_SAFE_INTEGER, total + snapshot[reason]);
  }
  return total;
}

/** Test-only: clears the process-wide ledger so one suite's losses never leak into the next. */
export function resetActivityLogLossCountersForTests(): void {
  counters = zeroCounters();
}
