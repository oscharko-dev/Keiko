// F5 (#3873, live Gemma qualification): a run whose workspace had no connected Coding Workbench
// logged eleven `coding-runtime.edit.refused reasonCode=NO_ACTIVE_SESSION` lines under its
// correlation until the operator stopped it. The model kept resending an edit that no change of its
// own could make apply, and the run spent its envelope on the loop. The run's orchestration counts
// each active run's CONSECUTIVE refused edits per closed reason code here; at the reason's bound the
// run settles `failed` with a cause that names the refusal class instead of looping.
//
// Two classes, two bounds:
// - `unrepairable`: the environment, the run's authority or the read/write policy refused, and no
//   edit the model could write changes that — no connected Workbench editor (NO_ACTIVE_SESSION,
//   NO_ACTIVE_BRIDGE), lost workspace access, a denied path or policy (OUT_OF_SCOPE, POLICY_DENIED,
//   APPROVAL_REQUIRED), an editor buffer only the operator can save (DIRTY), an editor or transport
//   fault. The run settles `edits-blocked` at UNREPAIRABLE_EDIT_REFUSAL_BOUND consecutive refusals.
// - `repairable`: the model's own input was wrong and its next edit can fix it — an edit that does
//   not apply (INVALID_EDITS), a stale base (CONTENT_HASH_MISMATCH, VERSION_MISMATCH), a missing
//   precondition. These keep the refusal guidance they always had and are bounded the same way at
//   the higher REPAIRABLE_EDIT_REFUSAL_BOUND, after which the run settles `edit-retries-exhausted`.
//
// A streak counts refusals with the SAME reason code: a refusal with another code starts a new
// streak, and an applied edit ends it. Reads, searches and other tool calls between two refused
// edits do not interrupt it — re-reading the file before resending is exactly what the refusal
// guidance asks of the model. A human decision (a change rejected in its review, an ask nobody
// decided) is not a refusal and never counts (ADR-0124 D6). Body-free: every input and output is a
// closed code or a count.
import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import {
  activityLogEvent,
  defineActivityLogOperation,
  type ActivityLogErrorKind,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

import { correlationIdOrUnknown } from "../correlation.js";
import type { CodingToolEditOutcome } from "./codingToolFacadePorts.js";

/** Consecutive same-reason refusals the model cannot repair by changing its edit (ADR-0137 D3). */
export const UNREPAIRABLE_EDIT_REFUSAL_BOUND = 3;
/** Consecutive same-reason refusals of edits the model can repair, before the run settles. */
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

// `EDIT_PREPARE_FAILED` names several causes the facade does not tell apart, an invalid changeset
// among them, so it takes the higher bound; so does a refusal that carried no closed code at all.
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

const EDIT_REFUSAL_REASON_CODE_SET: ReadonlySet<string> = new Set(EDIT_REFUSAL_REASON_CODES);

/** A refusal's closed reason, its class and the bound its consecutive repetitions meet. */
export interface EditRefusalClassification extends EditRefusalKind {
  readonly reasonCode: EditRefusalReasonCode;
  readonly bound: number;
  readonly failureCode: EditRefusalFailureCode;
}

export function classifyEditRefusal(reasonCode: string): EditRefusalClassification {
  const code: EditRefusalReasonCode = EDIT_REFUSAL_REASON_CODE_SET.has(reasonCode)
    ? (reasonCode as EditRefusalReasonCode)
    : "UNCLASSIFIED";
  const kind = EDIT_REFUSAL_KINDS[code];
  const unrepairable = kind.refusalClass === "unrepairable";
  return {
    reasonCode: code,
    ...kind,
    bound: unrepairable ? UNREPAIRABLE_EDIT_REFUSAL_BOUND : REPAIRABLE_EDIT_REFUSAL_BOUND,
    failureCode: unrepairable ? "edits-blocked" : "edit-retries-exhausted",
  };
}

/** The bound a run's refused edits reached, and the terminal cause the run settles with. */
export interface CodingRuntimeRefusalEscalation extends EditRefusalClassification {
  readonly consecutiveCount: number;
}

interface RefusalStreak {
  readonly reasonCode: EditRefusalReasonCode;
  readonly count: number;
}

/**
 * Per-run streaks of consecutive same-reason edit refusals. One entry per run the orchestration
 * observed, removed when the run settles (`clear`), so the maps stay bounded by the live runs.
 */
export class CodingRuntimeEditRefusalStreaks {
  private readonly streaks = new Map<string, RefusalStreak>();
  private readonly escalations = new Map<string, CodingRuntimeRefusalEscalation>();

  /** Counts one answered edit of the run; returns the escalation once, when the bound is met. */
  observe(
    runId: string,
    outcome: CodingToolEditOutcome,
  ): CodingRuntimeRefusalEscalation | undefined {
    if (this.escalations.has(runId)) return undefined;
    if (outcome.kind === "applied") {
      this.streaks.delete(runId);
      return undefined;
    }
    const classification = classifyEditRefusal(outcome.reasonCode);
    const previous = this.streaks.get(runId);
    const count = previous?.reasonCode === classification.reasonCode ? previous.count + 1 : 1;
    this.streaks.set(runId, { reasonCode: classification.reasonCode, count });
    if (count < classification.bound) return undefined;
    const escalation = { ...classification, consecutiveCount: count };
    this.escalations.set(runId, escalation);
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
    reasonCode: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [...EDIT_REFUSAL_REASON_CODES],
    },
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
 * cause: the refusal's closed reason and class, how many consecutive refusals met which bound, and
 * the terminal cause. The run's `coding-runtime.run.settled` line repeats the cause.
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
      },
    ),
  );
}
