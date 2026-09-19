// The persisted form of the process-wide loss ledger: one `activity-log.loss` summary line on each
// heartbeat whose counters changed and once at exit (#3532).
//
// The ledger itself (`recordActivityLogLoss`, keiko-contracts) is a fixed record of closed
// counters. This module turns it into a registered, body-free line and persists that line through
// the observable production append path, so a summary that cannot be written is KNOWN not to have
// been written. A failed summary write only increments the `summary-write-failed` counter and
// raises the throttled stderr notice — it never logs through the path that just failed, so a
// broken sink can never recurse into itself.

import {
  ACTIVITY_LOG_LOSS_REASONS,
  activityLogEvent,
  activityLogLossCounters,
  activityLogLossTotal,
  defineActivityLogOperation,
  recordActivityLogLoss,
  type ActivityLogFields,
  type ActivityLogLossCounters,
  type ActivityLogLossReason,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

import {
  persistActivityLogEvents,
  type ActivityLogEventPersister,
} from "./activity-log-persistence.js";
import { reportServerLogFailure, type ServerLogEvent } from "./server-log.js";
import { activityLogWriterState } from "./server-logger.js";

const ACTIVITY_LOG_LOSS_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "activity-log.loss",
  category: "diagnostic",
  owner: "keiko-server",
  emitter: "observability/activity-log-loss-summary.activityLogLossSummaryEvent",
  fields: {
    trigger: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["heartbeat", "exit"],
    },
    totalLost: { type: "integer", dataClass: "count", required: true },
    loggerWriteFailed: { type: "integer", dataClass: "count", required: false },
    loggerUnavailable: { type: "integer", dataClass: "count", required: false },
    schemaRejected: { type: "integer", dataClass: "count", required: false },
    persistenceFailed: { type: "integer", dataClass: "count", required: false },
    diagnosticSinkFailed: { type: "integer", dataClass: "count", required: false },
    portSinkFailed: { type: "integer", dataClass: "count", required: false },
    portUnwired: { type: "integer", dataClass: "count", required: false },
    clientRejected: { type: "integer", dataClass: "count", required: false },
    clientRateSuppressed: { type: "integer", dataClass: "count", required: false },
    clientBufferEvicted: { type: "integer", dataClass: "count", required: false },
    clientPostThrottled: { type: "integer", dataClass: "count", required: false },
    clientPostFailed: { type: "integer", dataClass: "count", required: false },
    clientRejectionSuppressed: { type: "integer", dataClass: "count", required: false },
    clientErrorSuppressed: { type: "integer", dataClass: "count", required: false },
    collectorDropped: { type: "integer", dataClass: "count", required: false },
    summaryWriteFailed: { type: "integer", dataClass: "count", required: false },
  },
  causal: "none",
  lifecycle: "loss",
  analyzerProjection: "process-lifecycle",
  failureClasses: ["activity-log-loss"],
  proofIds: ["activity-log.loss.heartbeat-summary", "activity-log.loss.exit-summary"],
  releaseImpact: "minor",
});

type LossSummaryFields = ActivityLogFields<typeof ACTIVITY_LOG_LOSS_OPERATION>;
export type ActivityLogLossSummaryTrigger = LossSummaryFields["trigger"];

// One closed field name per ledger reason. Keyed by the ledger's own vocabulary, so adding a reason
// without a persisted field fails to compile instead of silently never reaching the log.
const LOSS_SUMMARY_FIELDS = {
  "logger-write-failed": "loggerWriteFailed",
  "logger-unavailable": "loggerUnavailable",
  "schema-rejected": "schemaRejected",
  "persistence-failed": "persistenceFailed",
  "diagnostic-sink-failed": "diagnosticSinkFailed",
  "port-sink-failed": "portSinkFailed",
  "port-unwired": "portUnwired",
  "client-rejected": "clientRejected",
  "client-rate-suppressed": "clientRateSuppressed",
  "client-buffer-evicted": "clientBufferEvicted",
  "client-post-throttled": "clientPostThrottled",
  "client-post-failed": "clientPostFailed",
  "client-rejection-suppressed": "clientRejectionSuppressed",
  "client-error-suppressed": "clientErrorSuppressed",
  "collector-dropped": "collectorDropped",
  "summary-write-failed": "summaryWriteFailed",
} as const satisfies Readonly<Record<ActivityLogLossReason, keyof LossSummaryFields>>;

function lossSummaryCounts(counters: ActivityLogLossCounters): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const reason of ACTIVITY_LOG_LOSS_REASONS) {
    if (counters[reason] > 0) counts[LOSS_SUMMARY_FIELDS[reason]] = counters[reason];
  }
  return counts;
}

/** The registered, body-free summary of `counters`: counts per closed reason, never content. */
export function activityLogLossSummaryEvent(
  counters: ActivityLogLossCounters,
  trigger: ActivityLogLossSummaryTrigger,
): ServerLogEvent {
  const totalLost = activityLogLossTotal(counters);
  const lost = totalLost > 0;
  return activityLogEvent(
    ACTIVITY_LOG_LOSS_OPERATION,
    { level: lost ? "warn" : "info", ...(lost ? { errorKind: "unavailable" as const } : {}) },
    {
      trigger,
      totalLost,
      ...lossSummaryCounts(counters),
      completeness: lost ? "partial" : "complete",
      loss: lost ? "event-dropped" : "none",
    },
  );
}

export type ActivityLogLossSummaryOutcome = "persisted" | "unchanged" | "no-writer" | "failed";

// The counters last persisted, so an unchanged heartbeat writes nothing: the log grows only when
// something was actually lost. Before the first summary the baseline is the all-zero ledger.
const ZERO_LEDGER_KEY = JSON.stringify(
  Object.fromEntries(ACTIVITY_LOG_LOSS_REASONS.map((reason) => [reason, 0])),
);
let lastPersistedKey = ZERO_LEDGER_KEY;

export interface ActivityLogLossSummaryOptions {
  readonly persist?: ActivityLogEventPersister | undefined;
}

/**
 * Persists the loss summary for `trigger`. A heartbeat whose counters did not change writes
 * nothing; the exit summary is always written, so a clean shutdown also proves "no loss". Only the
 * production file writer persists — an explicit test writer or an unavailable writer has no log.
 */
export function persistActivityLogLossSummary(
  trigger: ActivityLogLossSummaryTrigger,
  options: ActivityLogLossSummaryOptions = {},
): ActivityLogLossSummaryOutcome {
  const counters = activityLogLossCounters();
  const key = JSON.stringify(counters);
  if (trigger === "heartbeat" && key === lastPersistedKey) return "unchanged";
  const { writer, stateDir } = activityLogWriterState();
  if (writer !== "production-file" || stateDir === undefined) return "no-writer";
  const persisted = (options.persist ?? persistActivityLogEvents)(stateDir, [
    activityLogLossSummaryEvent(counters, trigger),
  ]);
  if (persisted) {
    lastPersistedKey = key;
    return "persisted";
  }
  recordActivityLogLoss("summary-write-failed");
  reportServerLogFailure(undefined, { op: "activity-log.loss", loss: "event-dropped" });
  return "failed";
}

/** Test-only: forgets which counters were already persisted. */
export function resetActivityLogLossSummaryForTests(): void {
  lastPersistedKey = ZERO_LEDGER_KEY;
}
