import { join } from "node:path";

import { causeChain, keikoStackFrames, type ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

import { correlationIdOrUnknown } from "../correlation.js";
import { processServerLogSink } from "../process-log-sink.js";
import {
  createRetainedSessionStore,
  retainedSessionKey,
  type RetainedSessionStore,
} from "./opencodeSessionRetention.js";

/**
 * Native session continuity of the Coding Workbench (S02/S03, #3904, ADR-0137 D10).
 *
 * A Coding History task is a sequence of runs, each with its own runtime process and, until now,
 * its own empty runtime session: a follow-up replayed a bounded excerpt of Coding History as hidden
 * context. When a run settles normally its runtime database is retained
 * (`opencodeSessionRetention.ts`), and the next run of the same task may resume that very session,
 * or a new task may fork it. This module is the seam between the layer that knows the request (the
 * orchestrator) and the layer that owns the runtime (the composition): the orchestrator declares
 * what a run asks for before it launches, the composition takes the declaration while it prepares
 * the run and settles what actually happened, and the orchestrator reads that to decide whether the
 * history replay is still needed. Nothing here carries authority: a continued run is minted,
 * bounded and approved exactly like a fresh one.
 */

/** Where a fork ends in its source: after its last message, or just before one of its user turns. */
export type ForkBoundary =
  | { readonly kind: "end" }
  | {
      readonly kind: "turn";
      /** Zero-based position of the user turn among the source's user turns. */
      readonly ordinal: number;
      /** How many user turns Coding History holds for the source; the runtime must agree. */
      readonly userTurnCount: number;
    };

export type ContinuityIntent =
  | { readonly kind: "resume"; readonly taskId: string }
  | { readonly kind: "fork"; readonly sourceTaskId: string; readonly boundary: ForkBoundary };

/** The closed vocabulary of why a run did not continue a session, or why retention did not act. */
export type ContinuityReason =
  | "disabled"
  | "not-native-profile"
  | "not-succeeded"
  | "no-session"
  | "no-task"
  | "no-retained-state"
  | "expired"
  | "integrity-failed"
  | "version-changed"
  | "workspace-changed"
  | "window-shrunk"
  | "schema-unknown"
  | "grant-present"
  | "credential-present"
  | "pending-input"
  | "revert-staged"
  | "session-mismatch"
  | "database-missing"
  | "database-oversized"
  | "copy-failed"
  | "agent-reset-failed"
  | "history-oversized"
  | "scratch-session-failed"
  | "fork-boundary-unresolved"
  | "fork-failed";

export type ContinuityOutcome =
  /** The run has a fresh session; the task's history context applies as before. */
  | { readonly kind: "fresh"; readonly reason: ContinuityReason }
  | { readonly kind: "resumed" }
  | { readonly kind: "forked" };

export interface CodingSessionContinuity {
  /** Absent when retention is switched off; every continuation then falls back to a fresh run. */
  readonly store: RetainedSessionStore | undefined;
  /** The Coding History task a run belongs to, once its history was begun. */
  readonly taskOfRun: (runId: string) => string | undefined;
  declare(runId: string, intent: ContinuityIntent): void;
  /** Hands the declaration to the composition once; a second take finds nothing. */
  take(runId: string): ContinuityIntent | undefined;
  settle(runId: string, outcome: ContinuityOutcome): void;
  outcome(runId: string): ContinuityOutcome | undefined;
  forget(runId: string): void;
}

export interface CodingSessionContinuityInput {
  readonly store?: RetainedSessionStore | undefined;
  readonly taskOfRun: (runId: string) => string | undefined;
}

/** Only one run is live at a time; the bound keeps a run that never launched from accumulating. */
const MAX_TRACKED_RUNS = 16;

export function createCodingSessionContinuity(
  input: CodingSessionContinuityInput,
): CodingSessionContinuity {
  const intents = new Map<string, ContinuityIntent>();
  const outcomes = new Map<string, ContinuityOutcome>();
  const bounded = <Value>(table: Map<string, Value>, runId: string, value: Value): void => {
    table.delete(runId);
    table.set(runId, value);
    for (const oldest of table.keys()) {
      if (table.size <= MAX_TRACKED_RUNS) break;
      table.delete(oldest);
    }
  };
  return {
    store: input.store,
    taskOfRun: input.taskOfRun,
    declare: (runId, intent): void => {
      bounded(intents, runId, intent);
    },
    take: (runId): ContinuityIntent | undefined => {
      const intent = intents.get(runId);
      intents.delete(runId);
      return intent;
    },
    settle: (runId, outcome): void => {
      bounded(outcomes, runId, outcome);
    },
    outcome: (runId): ContinuityOutcome | undefined => outcomes.get(runId),
    forget: (runId): void => {
      intents.delete(runId);
      outcomes.delete(runId);
    },
  };
}

/**
 * `KEIKO_CODING_SESSION_RETENTION`: `off` keeps no runtime database after a run, so no task can be
 * resumed or forked natively; absent or `on` retains. An unknown value fails closed to `off`.
 */
export function sessionRetentionEnabled(value: string | undefined): boolean {
  return value === undefined || value === "on";
}

/** The environment variable that switches retention off; see `sessionRetentionEnabled`. */
export const KEIKO_CODING_SESSION_RETENTION_ENV = "KEIKO_CODING_SESSION_RETENTION";

/** Where a state directory keeps the retained entries: server-owned, beside the runs' private state. */
export function retainedSessionRoot(stateDir: string): string {
  return join(stateDir, "coding-runtime", "retained-sessions");
}

export interface StateCodingSessionContinuityInput {
  readonly stateDir: string;
  /** The value of `KEIKO_CODING_SESSION_RETENTION`. */
  readonly retention: string | undefined;
  /** The Coding History the retained entries belong to; an entry of a task it lacks is removed. */
  readonly history:
    | {
        readonly get: (id: string) => unknown;
        readonly forRun: (runId: string) => { readonly id: string } | undefined;
      }
    | undefined;
  readonly activityLog: ServerLogSink | undefined;
}

/**
 * The server's one continuity service over its state directory. Entries of tasks that no longer
 * exist and entries past their bounds are removed once now, and again with every retention.
 */
export function createStateCodingSessionContinuity(
  input: StateCodingSessionContinuityInput,
): CodingSessionContinuity {
  const store = sessionRetentionEnabled(input.retention)
    ? createRetainedSessionStore({
        root: retainedSessionRoot(input.stateDir),
        isLiveTask: (taskId) => input.history?.get(taskId) !== undefined,
      })
    : undefined;
  const pruned = store?.prune();
  if (
    pruned !== undefined &&
    pruned.expired + pruned.orphaned + pruned.invalid + pruned.quota > 0
  ) {
    recordSessionContinuity(input.activityLog, {
      runId: "session-retention-startup",
      action: "prune",
      outcome: "pruned",
      entryCount: pruned.entryCount,
      prunedCount: pruned.expired + pruned.orphaned + pruned.invalid + pruned.quota,
    });
  }
  return createCodingSessionContinuity({
    store,
    taskOfRun: (runId) => input.history?.forRun(runId)?.id,
  });
}

const SESSION_CONTINUITY_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.session-continuity",
  category: "process",
  owner: "keiko-server",
  emitter: "coding-runtime.codingSessionContinuity.recordSessionContinuity",
  diagnosticWhen: [{ field: "outcome", values: ["refused", "failed"] }],
  fields: {
    runId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
    action: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["retain", "resume", "fork", "prune"],
    },
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["retained", "resumed", "forked", "pruned", "fresh", "skipped", "refused", "failed"],
    },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [
        "disabled",
        "not-native-profile",
        "not-succeeded",
        "no-session",
        "no-task",
        "no-retained-state",
        "expired",
        "integrity-failed",
        "version-changed",
        "workspace-changed",
        "window-shrunk",
        "schema-unknown",
        "grant-present",
        "credential-present",
        "pending-input",
        "revert-staged",
        "session-mismatch",
        "database-missing",
        "database-oversized",
        "copy-failed",
        "agent-reset-failed",
        "history-oversized",
        "scratch-session-failed",
        "fork-boundary-unresolved",
        "fork-failed",
      ],
    },
    // A digest of the Coding History task (never its id) so a retain, a resume and a fork of one
    // task read as one chain; a fork also names the task it was forked from.
    taskDigest: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    sourceTaskDigest: { type: "string", dataClass: "digest", required: false, maxLength: 64 },
    boundary: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["end", "turn"],
    },
    databaseBytes: { type: "integer", dataClass: "count", required: false },
    messageCount: { type: "integer", dataClass: "count", required: false },
    entryCount: { type: "integer", dataClass: "count", required: false },
    prunedCount: { type: "integer", dataClass: "count", required: false },
    ageMs: { type: "integer", dataClass: "duration", required: false },
    frames: {
      type: "string-array",
      dataClass: "opaque-id",
      required: false,
      maxLength: 512,
      maxItems: 8,
    },
    causeChain: {
      type: "string-array",
      dataClass: "error-kind",
      required: false,
      maxLength: 128,
      maxItems: 5,
    },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["coding-runtime-session-continuity"],
  proofIds: ["coding-runtime.session-continuity.emitted-line"],
  releaseImpact: "minor",
});

export interface SessionContinuityRecord {
  readonly runId: string;
  readonly action: "retain" | "resume" | "fork" | "prune";
  readonly outcome:
    "retained" | "resumed" | "forked" | "pruned" | "fresh" | "skipped" | "refused" | "failed";
  readonly reason?: ContinuityReason;
  /** Hashed before it is written. */
  readonly taskId?: string;
  readonly sourceTaskId?: string;
  readonly boundary?: ForkBoundary["kind"];
  readonly databaseBytes?: number;
  readonly messageCount?: number;
  readonly entryCount?: number;
  readonly prunedCount?: number;
  readonly ageMs?: number;
  /** The failure behind a `failed` outcome; only its class, frames and cause chain are written. */
  readonly error?: unknown;
}

/**
 * One body-free line per continuity decision: what was asked, what happened and why, with counts
 * and byte sizes. No task id, path, session id or message text ever enters it. A refusal is a
 * warning with its closed reason; a failure also carries the Keiko frames and cause chain.
 */
export function recordSessionContinuity(
  activityLog: ServerLogSink | undefined,
  record: SessionContinuityRecord,
): void {
  const { runId, taskId, sourceTaskId, error, ...rest } = record;
  const failed = record.outcome === "failed";
  const refused = record.outcome === "refused";
  (activityLog ?? processServerLogSink()).write(
    activityLogEvent(
      SESSION_CONTINUITY_OPERATION,
      {
        correlationId: correlationIdOrUnknown(runId),
        ...(failed || refused
          ? {
              level: "warn",
              errorKind: failed ? "internal" : "validation-failed",
            }
          : {}),
      } as const,
      {
        runId,
        ...rest,
        ...(taskId === undefined ? {} : { taskDigest: retainedSessionKey(taskId) }),
        ...(sourceTaskId === undefined
          ? {}
          : { sourceTaskDigest: retainedSessionKey(sourceTaskId) }),
        ...(error === undefined
          ? {}
          : { frames: keikoStackFrames(error), causeChain: causeChain(error) }),
      },
    ),
  );
}
