// F5 (#3873, live Gemma qualification): a run whose workspace had no connected Coding Workbench
// logged eleven `coding-runtime.edit.refused reasonCode=NO_ACTIVE_SESSION` lines under its
// correlation until the operator stopped it. The model kept resending an edit that no change of its
// own could make apply, and the run spent its envelope on the loop. The run's orchestration counts
// each active run's refused edits here and, at a bound, settles the run `failed` with a cause that
// names the refusal class instead of looping.
//
// Two classes, two bounds:
// - `unrepairable`: the environment, the run's authority or the read/write policy refused, and no
//   edit the model could write changes that — no connected Workbench editor (NO_ACTIVE_SESSION,
//   NO_ACTIVE_BRIDGE), lost workspace access, a denied path or policy (OUT_OF_SCOPE, POLICY_DENIED,
//   APPROVAL_REQUIRED), an editor buffer only the operator can save (DIRTY), an editor or transport
//   fault, and an edit the port refused while preparing it for a cause the model cannot change: a
//   denied or lost workspace, a guard or binding that no longer holds, a governed read of a file that
//   is not text, too large or refused. The run settles `edits-blocked` once it has met
//   UNREPAIRABLE_EDIT_REFUSAL_BOUND of them since its last applied edit.
// - `repairable`: the model's own input was wrong and its next edit can fix it — an edit that does
//   not apply (INVALID_EDITS), a stale base (CONTENT_HASH_MISMATCH, VERSION_MISMATCH), a missing
//   precondition, an invalid changeset. These keep the refusal guidance they always had. A run that
//   has met REPAIRABLE_EDIT_REFUSAL_BOUND refusals of ANY kind since its last applied edit settles
//   `edit-retries-exhausted`.
//
// Both counts run over the refusals since the run's last applied edit, whatever their reason codes
// (#3873 review): a model that alternates two refusals — an edit that does not match, a stale re-read,
// an edit that does not match again — never repeats one code, yet spends the whole prompt allowance
// on a loop exactly as one that repeats it. An applied edit ends the streak; reads, searches and
// other tool calls between two refused edits do not interrupt it — re-reading the file before
// resending is exactly what the refusal guidance asks of the model. A human decision (a change
// rejected in its review, an ask nobody decided) is not a refusal and never counts (ADR-0124 D6),
// and neither is an edit whose preparation was cancelled: the run, not the edit, was stopped.
// Body-free: every input and output is a closed code or a count.
import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import {
  activityLogEvent,
  defineActivityLogOperation,
  type ActivityLogErrorKind,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

import { correlationIdOrUnknown } from "../correlation.js";
import {
  EDIT_PREPARE_CAUSES,
  EDIT_PREPARE_ERROR_KINDS,
  EDIT_READ_REASONS,
  type CodingToolEditOutcome,
  type EditPrepareCause,
  type EditReadReason,
} from "./codingToolFacadePorts.js";

/** Unrepairable refusals since a run's last applied edit that settle it `edits-blocked` (ADR-0137 D3). */
export const UNREPAIRABLE_EDIT_REFUSAL_BOUND = 3;
/** Refusals of any kind since a run's last applied edit that settle it `edit-retries-exhausted`. */
export const REPAIRABLE_EDIT_REFUSAL_BOUND = 6;

/**
 * Every closed reason a governed edit refusal can reach the model with — the editor-agent conflict
 * and failure codes, the edit port's own refusals and the HTTP client's transport markers, exactly as
 * `codingToolFacade.ts` forwards them — plus `UNCLASSIFIED` for a refusal it forwarded without one. A
 * test pins that every code the facade forwards is listed here.
 */
export const EDIT_REFUSAL_REASON_CODES = [
  "NO_ACTIVE_SESSION",
  "NO_ACTIVE_BRIDGE",
  "WORKSPACE_ACCESS_LOST",
  "OUT_OF_SCOPE",
  "POLICY_DENIED",
  "APPROVAL_REQUIRED",
  "DIRTY",
  "PROVIDER_UNAVAILABLE",
  "QUEUE_FULL",
  "TIMED_OUT",
  "CANCELLED",
  "EDIT_MUTATION_FAILED",
  "RESPONSE_TOO_LARGE",
  "TRANSPORT_FAILURE",
  "REDIRECT_BLOCKED",
  "EDIT_TRANSPORT_ERROR",
  "INVALID_EDITS",
  "CONTENT_HASH_MISMATCH",
  "VERSION_MISMATCH",
  "PRECONDITION_REQUIRED",
  "DECOMPOSE_PER_ROOT",
  "UNSUPPORTED_OPERATION",
  "LIMIT_EXCEEDED",
  "DUPLICATE_ACTION",
  "MUTATION_IN_FLIGHT",
  "EDIT_PREPARE_FAILED",
  "ci-observation-required",
  "UNCLASSIFIED",
] as const;
export type EditRefusalReasonCode = (typeof EDIT_REFUSAL_REASON_CODES)[number];

export const EDIT_REFUSAL_CLASSES = ["unrepairable", "repairable"] as const;
export type EditRefusalClass = (typeof EDIT_REFUSAL_CLASSES)[number];

/** The terminal cause each class settles a run with. */
export const EDIT_REFUSAL_FAILURE_CODES = ["edits-blocked", "edit-retries-exhausted"] as const;
export type EditRefusalFailureCode = (typeof EDIT_REFUSAL_FAILURE_CODES)[number];

interface EditRefusalKind {
  readonly refusalClass: EditRefusalClass;
  // The error class the edit's own `coding-runtime.edit.refused` line records for the same code, so
  // the refusal lines, the escalation and the settlement classify one failure alike.
  readonly errorKind: ActivityLogErrorKind;
}

const UNREPAIRABLE = (errorKind: ActivityLogErrorKind): EditRefusalKind => ({
  refusalClass: "unrepairable",
  errorKind,
});
const REPAIRABLE = (errorKind: ActivityLogErrorKind): EditRefusalKind => ({
  refusalClass: "repairable",
  errorKind,
});

// `EDIT_PREPARE_FAILED` names several causes: the entry here is the class of a refusal that carried
// no (known) cause, which keeps the higher bound as it always did; `classifyEditRefusal` reads the
// cause when there is one. A refusal that carried no closed code at all takes the higher bound too.
const EDIT_REFUSAL_KINDS: Readonly<Record<EditRefusalReasonCode, EditRefusalKind>> = {
  NO_ACTIVE_SESSION: UNREPAIRABLE("unavailable"),
  NO_ACTIVE_BRIDGE: UNREPAIRABLE("unavailable"),
  WORKSPACE_ACCESS_LOST: UNREPAIRABLE("authority-denied"),
  OUT_OF_SCOPE: UNREPAIRABLE("authority-denied"),
  POLICY_DENIED: UNREPAIRABLE("authority-denied"),
  APPROVAL_REQUIRED: UNREPAIRABLE("authority-denied"),
  DIRTY: UNREPAIRABLE("conflict"),
  PROVIDER_UNAVAILABLE: UNREPAIRABLE("unavailable"),
  QUEUE_FULL: UNREPAIRABLE("unavailable"),
  TIMED_OUT: UNREPAIRABLE("timeout"),
  CANCELLED: UNREPAIRABLE("cancelled"),
  EDIT_MUTATION_FAILED: UNREPAIRABLE("internal"),
  RESPONSE_TOO_LARGE: UNREPAIRABLE("unavailable"),
  TRANSPORT_FAILURE: UNREPAIRABLE("unavailable"),
  REDIRECT_BLOCKED: UNREPAIRABLE("unavailable"),
  EDIT_TRANSPORT_ERROR: UNREPAIRABLE("unavailable"),
  INVALID_EDITS: REPAIRABLE("validation-failed"),
  CONTENT_HASH_MISMATCH: REPAIRABLE("conflict"),
  VERSION_MISMATCH: REPAIRABLE("conflict"),
  PRECONDITION_REQUIRED: REPAIRABLE("validation-failed"),
  DECOMPOSE_PER_ROOT: REPAIRABLE("validation-failed"),
  UNSUPPORTED_OPERATION: REPAIRABLE("validation-failed"),
  LIMIT_EXCEEDED: REPAIRABLE("validation-failed"),
  DUPLICATE_ACTION: REPAIRABLE("conflict"),
  MUTATION_IN_FLIGHT: REPAIRABLE("conflict"),
  EDIT_PREPARE_FAILED: REPAIRABLE("validation-failed"),
  "ci-observation-required": REPAIRABLE("validation-failed"),
  UNCLASSIFIED: REPAIRABLE("unknown"),
};

type PrepareCauseCounting = EditRefusalClass | "uncounted";

// How each cause an `EDIT_PREPARE_FAILED` refusal can carry counts (#3873 review). Only an invalid
// changeset is the model's own input. A workspace that was lost, a guard or a producer binding that
// no longer holds, an editor context or mutation lease that could not be had, and a governed read of
// a file the edit names that did not answer (not text, too large, denied, a workspace or process
// that failed) are conditions no edit the model writes changes. A cancelled preparation says nothing
// about the edit. A cause added to the edit port fails the build until it is classified here.
const PREPARE_CAUSE_COUNTING: Readonly<Record<EditPrepareCause, PrepareCauseCounting>> = {
  "workspace-access-lost": "unrepairable",
  cancelled: "uncounted",
  "guard-denied": "unrepairable",
  "changeset-invalid": "repairable",
  "binding-unavailable": "unrepairable",
  "editor-context-unavailable": "unrepairable",
  "lease-unavailable": "unrepairable",
  "replacement-read-failed": "unrepairable",
};

const EDIT_REFUSAL_REASON_CODE_SET: ReadonlySet<string> = new Set(EDIT_REFUSAL_REASON_CODES);

/** The closed words an `EDIT_PREPARE_FAILED` refusal carries beside its code. */
export interface EditRefusalCause {
  readonly prepareCause?: EditPrepareCause | undefined;
  readonly readReason?: EditReadReason | undefined;
}

/** A refusal's closed reason, its class and the bound its class settles a run at. */
export interface EditRefusalClassification extends EditRefusalKind {
  readonly reasonCode: EditRefusalReasonCode;
  readonly bound: number;
  readonly failureCode: EditRefusalFailureCode;
}

/**
 * Whether a refusal says nothing about the model's edit and so counts for nothing: the preparation of
 * the edit, or the governed read it waited on, was cancelled.
 */
export function isUncountedEditRefusal(cause: EditRefusalCause): boolean {
  return (
    cause.readReason === "cancelled" ||
    (cause.prepareCause !== undefined && PREPARE_CAUSE_COUNTING[cause.prepareCause] === "uncounted")
  );
}

// An `EDIT_PREPARE_FAILED` refusal is classified by the cause the edit port gave it; one that carried
// no (known) cause keeps the class its code alone names.
function refusalKind(code: EditRefusalReasonCode, cause: EditRefusalCause): EditRefusalKind {
  const { prepareCause } = cause;
  if (code !== "EDIT_PREPARE_FAILED" || prepareCause === undefined) return EDIT_REFUSAL_KINDS[code];
  const errorKind = EDIT_PREPARE_ERROR_KINDS[prepareCause];
  return PREPARE_CAUSE_COUNTING[prepareCause] === "repairable"
    ? REPAIRABLE(errorKind)
    : UNREPAIRABLE(errorKind);
}

export function classifyEditRefusal(
  reasonCode: string,
  cause: EditRefusalCause = {},
): EditRefusalClassification {
  const code: EditRefusalReasonCode = EDIT_REFUSAL_REASON_CODE_SET.has(reasonCode)
    ? (reasonCode as EditRefusalReasonCode)
    : "UNCLASSIFIED";
  const kind = refusalKind(code, cause);
  const unrepairable = kind.refusalClass === "unrepairable";
  return {
    reasonCode: code,
    ...kind,
    bound: unrepairable ? UNREPAIRABLE_EDIT_REFUSAL_BOUND : REPAIRABLE_EDIT_REFUSAL_BOUND,
    failureCode: unrepairable ? "edits-blocked" : "edit-retries-exhausted",
  };
}

/**
 * The bound a run's refused edits reached, and the terminal cause the run settles with. `reasonCode`
 * and `errorKind` are the latest refusal's: the one that met the bound. `refusalClass`, `bound` and
 * `consecutiveCount` describe the count that met it — the unrepairable refusals for `edits-blocked`,
 * every refusal for `edit-retries-exhausted` — and the other count rides beside it, so a run that
 * mixed refusals says how.
 */
export interface CodingRuntimeRefusalEscalation extends EditRefusalClassification {
  readonly consecutiveCount: number;
  readonly refusalCount: number;
  readonly unrepairableCount: number;
  /** The latest refusal's closed words, when it was a preparation refusal. */
  readonly prepareCause?: EditPrepareCause | undefined;
  readonly readReason?: EditReadReason | undefined;
}

interface RefusalStreak {
  readonly refusals: number;
  readonly unrepairable: number;
}

type ReachedBound = Pick<
  CodingRuntimeRefusalEscalation,
  "refusalClass" | "bound" | "failureCode" | "consecutiveCount"
>;

// The bound a streak has met, the unrepairable one first: three refusals the environment dictated
// name the operator's condition more precisely than six refusals of any kind do.
function reachedBound(streak: RefusalStreak): ReachedBound | undefined {
  if (streak.unrepairable >= UNREPAIRABLE_EDIT_REFUSAL_BOUND) {
    return {
      refusalClass: "unrepairable",
      bound: UNREPAIRABLE_EDIT_REFUSAL_BOUND,
      failureCode: "edits-blocked",
      consecutiveCount: streak.unrepairable,
    };
  }
  if (streak.refusals >= REPAIRABLE_EDIT_REFUSAL_BOUND) {
    return {
      refusalClass: "repairable",
      bound: REPAIRABLE_EDIT_REFUSAL_BOUND,
      failureCode: "edit-retries-exhausted",
      consecutiveCount: streak.refusals,
    };
  }
  return undefined;
}

const NO_REFUSALS: RefusalStreak = { refusals: 0, unrepairable: 0 };

// The run's streak with one more refusal: every refusal counts, whatever its code, and the
// unrepairable ones count again on their own.
function extendStreak(
  previous: RefusalStreak | undefined,
  latest: EditRefusalClassification,
): RefusalStreak {
  const { refusals, unrepairable } = previous ?? NO_REFUSALS;
  return {
    refusals: refusals + 1,
    unrepairable: latest.refusalClass === "unrepairable" ? unrepairable + 1 : unrepairable,
  };
}

// The escalation a streak earns when its latest refusal meets a bound: that refusal's own code and
// error class, the bound's class, count and cause, and both counts beside them.
function escalationFor(
  latest: EditRefusalClassification,
  streak: RefusalStreak,
  cause: EditRefusalCause,
): CodingRuntimeRefusalEscalation | undefined {
  const reached = reachedBound(streak);
  if (reached === undefined) return undefined;
  return {
    ...latest,
    ...reached,
    refusalCount: streak.refusals,
    unrepairableCount: streak.unrepairable,
    ...(cause.prepareCause === undefined ? {} : { prepareCause: cause.prepareCause }),
    ...(cause.readReason === undefined ? {} : { readReason: cause.readReason }),
  };
}

/**
 * Per-run streaks of the refused edits since the run's last applied edit. One entry per run the
 * orchestration observed, removed when the run settles (`clear`), so the maps stay bounded by the
 * live runs.
 */
export class CodingRuntimeEditRefusalStreaks {
  private readonly streaks = new Map<string, RefusalStreak>();
  private readonly escalations = new Map<string, CodingRuntimeRefusalEscalation>();

  /** Counts one answered edit of the run; returns the escalation once, when a bound is met. */
  observe(
    runId: string,
    outcome: CodingToolEditOutcome,
  ): CodingRuntimeRefusalEscalation | undefined {
    if (this.escalations.has(runId)) return undefined;
    if (outcome.kind === "applied") {
      this.streaks.delete(runId);
      return undefined;
    }
    const cause: EditRefusalCause = {
      prepareCause: outcome.prepareCause,
      readReason: outcome.readReason,
    };
    if (isUncountedEditRefusal(cause)) return undefined;
    const latest = classifyEditRefusal(outcome.reasonCode, cause);
    const streak = extendStreak(this.streaks.get(runId), latest);
    this.streaks.set(runId, streak);
    const escalation = escalationFor(latest, streak, cause);
    if (escalation !== undefined) this.escalations.set(runId, escalation);
    return escalation;
  }

  /** The escalation that ended the run's turn, while the run has not settled yet. */
  escalation(runId: string): CodingRuntimeRefusalEscalation | undefined {
    return this.escalations.get(runId);
  }

  clear(runId: string): void {
    this.streaks.delete(runId);
    this.escalations.delete(runId);
  }
}

const CODING_RUNTIME_RUN_REFUSAL_ESCALATED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.run.refusal-escalated",
  category: "process",
  owner: "keiko-server",
  emitter: "coding-runtime.codingRuntimeRefusalEscalation.recordRefusalEscalated",
  fields: {
    runId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
    // The latest refusal's closed code: the one that met the bound.
    reasonCode: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [...EDIT_REFUSAL_REASON_CODES],
    },
    // The class of the bound that was met: `unrepairable` for `edits-blocked`, `repairable` for
    // `edit-retries-exhausted`. Not necessarily the class of `reasonCode`: a run that mixed refusals
    // meets the higher bound on whichever refusal came sixth.
    refusalClass: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [...EDIT_REFUSAL_CLASSES],
    },
    consecutiveCount: { type: "integer", dataClass: "count", required: true },
    bound: { type: "integer", dataClass: "count", required: true },
    failureCode: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [...EDIT_REFUSAL_FAILURE_CODES],
    },
    // Both counts of the run's streak since its last applied edit, beside the one that met its bound
    // (`consecutiveCount`). `required: false` only because a line written before these fields
    // existed lacks them; every line written since carries both.
    refusalCount: { type: "integer", dataClass: "count", required: false },
    unrepairableCount: { type: "integer", dataClass: "count", required: false },
    // The latest refusal's closed words when it was an `EDIT_PREPARE_FAILED` refusal: what decided
    // whether the model could repair it (`coding-runtime.edit.refused` records the same words).
    prepareCause: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [...EDIT_PREPARE_CAUSES],
    },
    readReason: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [...EDIT_READ_REASONS],
    },
  },
  causal: "correlation",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["coding-runtime-run-settlement"],
  proofIds: ["coding-runtime.run.refusal-escalated.emitted-line"],
  releaseImpact: "patch",
});

/**
 * The one line an escalation writes, under the run's correlation, before the run settles with its
 * cause: the latest refusal's closed reason, the class and count of the bound that was met, both
 * counts of the streak, the refusal's closed preparation words when it had them, and the terminal
 * cause. The run's `coding-runtime.run.settled` line repeats the cause.
 */
export function recordRefusalEscalated(
  activityLog: ServerLogSink | undefined,
  runId: string,
  escalation: CodingRuntimeRefusalEscalation,
): void {
  activityLog?.write(
    activityLogEvent(
      CODING_RUNTIME_RUN_REFUSAL_ESCALATED_OPERATION,
      {
        level: "warn",
        correlationId: correlationIdOrUnknown(runId),
        errorKind: escalation.errorKind,
      },
      {
        runId,
        reasonCode: escalation.reasonCode,
        refusalClass: escalation.refusalClass,
        consecutiveCount: escalation.consecutiveCount,
        bound: escalation.bound,
        failureCode: escalation.failureCode,
        refusalCount: escalation.refusalCount,
        unrepairableCount: escalation.unrepairableCount,
        ...(escalation.prepareCause === undefined ? {} : { prepareCause: escalation.prepareCause }),
        ...(escalation.readReason === undefined ? {} : { readReason: escalation.readReason }),
      },
    ),
  );
}
