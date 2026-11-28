import {
  activityLogEvent,
  defineActivityLogOperation,
  type ActivityLogErrorKind,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import { isValidCorrelationId, UNKNOWN_CORRELATION_ID } from "../correlation.js";
import { describeError } from "../diagnostics-log.js";
import type { CodingWorkbenchVerificationGap } from "@oscharko-dev/keiko-contracts";
import type { CodingVerificationFailureEvidence } from "./codingRuntimeRunEffort.js";
import {
  CODING_VERIFICATION_BLOCKED_REASONS,
  type CodingVerificationBlockedReason,
} from "./codingToolFacadePorts.js";

/**
 * At most one automatic continuation per run, and only for one fact (#4491): a check ran after the
 * run's last code change, failed, and the model ended its turn without a passing one. Verification
 * is asked for up front in the run's instructions (the launch profile's "Verify" step), so Keiko
 * never repeats a generic request at the end; every other gap is named to the person instead.
 */
export const VERIFICATION_CONTINUATION_MAX = 1;
/**
 * How a check run in the model's own shell counts as verification (`openCodeNativeVerificationKind`).
 * The runtime reports one exit status per line, so only a line whose status is the check's own
 * counts; the #4271 lab run piped `mvn test` into `tail`, passed, and was refused as unverified.
 */
export const SHELL_VERIFICATION_STATUS_RULE =
  "In your shell, run the check as its own line, or chain it with && only to cd or other checks: a pipe (such as | tail), ;, ||, & or a second line lets another command decide the exit status, and such a line does not count as verification.";

function failedStepsSentence(failedCount: number): string {
  return failedCount === 1 ? "1 step failed" : `${String(failedCount)} steps failed`;
}

/**
 * The one continuation task: it names the fact (which check, how many steps failed) and nothing
 * else of the run (never a path, a line of output or a message), and asks to repair the cause and
 * rerun that check, or to state why it cannot. A run whose tool profile hands the model no shell
 * (the mapped profiles, where `keiko_verification` is the only command runner) is told to rerun
 * with the governed verifier, not a shell it does not have.
 */
export function verificationContinuationIntent(
  failure: CodingVerificationFailureEvidence,
  hasShellTool: boolean | undefined,
): string {
  const subject = failure.check === "check" ? "A check" : `The ${failure.check} check`;
  const rerun =
    hasShellTool === false
      ? "rerun the same check with the governed verification tool"
      : `rerun the same check in your shell. ${SHELL_VERIFICATION_STATUS_RULE}`;
  return `${subject} you ran after your last change failed (${failedStepsSentence(failure.failedCount)}). That failure may have existed before your first change in this run. Continue within the original task and authority. Read the relevant source and test files first to decide whether your own changes caused the failure or the person's task asks you to fix it. Only then repair the cause of the failure without weakening assertions, ${rerun} Do not claim completion until a check passes after your last change. Otherwise the failure is pre-existing and outside the task: do not change any file to repair it, state once that it is pre-existing and unrelated to your changes, and finish. If you cannot repair a failure you caused, or the check cannot run for a reason outside the task, state the exact cause once and finish.`;
}

/**
 * Why no continuation ran for a run that ended without a passing check after its last change: the
 * one-line answer a support analysis reads (`skipped`). `docs-only`: the run changed documentation
 * alone and needs no check. `no-failed-check`: no check ran, so there is nothing to repair.
 * `blocked`: a check could not start. `budget-exhausted`: the run's budget was used up.
 * `already-continued`: the run's one continuation already ran.
 */
export const VERIFICATION_CONTINUATION_SKIP_REASONS = [
  "docs-only",
  "no-failed-check",
  "blocked",
  "budget-exhausted",
  "already-continued",
] as const;

export type VerificationContinuationSkipReason =
  (typeof VERIFICATION_CONTINUATION_SKIP_REASONS)[number];

/**
 * The contract's verification-gap vocabulary (`CODING_WORKBENCH_VERIFICATION_GAPS`), written once
 * here as a literal because the typed-registry generator reads a registration's values only from a
 * literal it can see in source, not from another package's compiled declaration. The check below
 * fails to compile when this list and the contract's type drift apart in either direction.
 */
export const VERIFICATION_GAP_WORDS = [
  "no-check-run",
  "check-failed",
  "check-not-started",
  "budget-exhausted",
] as const;
type VerificationGapWordsMatchContract = [CodingWorkbenchVerificationGap] extends [
  (typeof VERIFICATION_GAP_WORDS)[number],
]
  ? [(typeof VERIFICATION_GAP_WORDS)[number]] extends [CodingWorkbenchVerificationGap]
    ? true
    : never
  : never;
export const VERIFICATION_GAP_WORDS_MATCH_CONTRACT: VerificationGapWordsMatchContract = true;

type ContinuationState =
  | "continued"
  | "skipped"
  | "dispatch-refused"
  | "dispatch-threw"
  | "run-superseded"
  | "not-evidenced";

/** What a continuation line may add to its state; every member is a closed word or a count. */
export interface VerificationContinuationDetail {
  readonly error?: unknown;
  readonly blockedReason?: CodingVerificationBlockedReason;
  readonly skipReason?: VerificationContinuationSkipReason;
  readonly gap?: CodingWorkbenchVerificationGap;
  readonly failure?: CodingVerificationFailureEvidence;
}

const VERIFICATION_CONTINUATION_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.run.verification-continuation",
  category: "process",
  owner: "keiko-server",
  emitter: "coding-runtime.codingRuntimeVerificationContinuation.recordVerificationContinuation",
  fields: {
    runId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
    attempt: { type: "integer", dataClass: "count", required: true },
    max: { type: "integer", dataClass: "count", required: true },
    errorClass: { type: "string", dataClass: "error-kind", required: false, maxLength: 64 },
    code: { type: "string", dataClass: "opaque-id", required: false, maxLength: 256 },
    causeChain: {
      type: "string-array",
      dataClass: "error-kind",
      required: false,
      maxLength: 128,
      maxItems: 5,
    },
    frames: {
      type: "string-array",
      dataClass: "opaque-id",
      required: false,
      maxLength: 512,
      maxItems: 8,
    },
    state: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [
        "continued",
        "skipped",
        "dispatch-refused",
        "dispatch-threw",
        "run-superseded",
        "not-evidenced",
      ],
    },
    // Why no continuation ran (`skipped`): a closed word naming the one fact that ruled it out (#4491).
    skipReason: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [...VERIFICATION_CONTINUATION_SKIP_REASONS],
    },
    // The concrete gap of a run that settled without a passing check (`not-evidenced`, #4491).
    gap: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [...VERIFICATION_GAP_WORDS],
    },
    // The failed check a `continued` line names (#4491): which check and how many steps failed,
    // the only two facts the continuation task carries. Never a path or a line of output.
    check: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["test", "targeted-test", "typecheck", "lint", "build", "check"],
    },
    failedCount: { type: "integer", dataClass: "count", required: false },
    // Why no further repair continuation ran: the blocker the ledger holds for the run (#4271).
    blockedReason: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [...CODING_VERIFICATION_BLOCKED_REASONS],
    },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["coding-runtime-verification"],
  proofIds: ["coding-runtime.run.verification-continuation.emitted-line"],
  releaseImpact: "patch",
});

export function recordVerificationContinuation(
  activityLog: ServerLogSink | undefined,
  runId: string,
  attempt: number,
  state: ContinuationState,
  detail: VerificationContinuationDetail = {},
): void {
  const informational = state === "continued" || state === "skipped";
  activityLog?.write(
    activityLogEvent(
      VERIFICATION_CONTINUATION_OPERATION,
      {
        correlationId: isValidCorrelationId(runId) ? runId : UNKNOWN_CORRELATION_ID,
        level: informational ? "info" : "warn",
        ...(informational ? {} : { errorKind: continuationErrorKind(state) }),
      },
      {
        runId,
        attempt,
        max: VERIFICATION_CONTINUATION_MAX,
        state,
        ...continuationDetailFields(detail),
      },
    ),
  );
}

// Every member is a closed word or a count; the failed check names only which check and how many
// steps failed.
function continuationDetailFields(detail: VerificationContinuationDetail): Partial<
  ReturnType<typeof continuationErrorFields>
> & {
  readonly blockedReason?: CodingVerificationBlockedReason;
  readonly skipReason?: VerificationContinuationSkipReason;
  readonly gap?: CodingWorkbenchVerificationGap;
  readonly check?: CodingVerificationFailureEvidence["check"];
  readonly failedCount?: number;
} {
  return {
    ...(detail.error === undefined ? {} : continuationErrorFields(detail.error)),
    ...(detail.blockedReason === undefined ? {} : { blockedReason: detail.blockedReason }),
    ...(detail.skipReason === undefined ? {} : { skipReason: detail.skipReason }),
    ...(detail.gap === undefined ? {} : { gap: detail.gap }),
    ...(detail.failure === undefined
      ? {}
      : { check: detail.failure.check, failedCount: detail.failure.failedCount }),
  };
}

function continuationErrorFields(error: unknown): {
  readonly errorClass: string;
  readonly code?: string;
  readonly causeChain?: readonly string[];
  readonly frames?: readonly string[];
} {
  const description = describeError(error);
  return {
    errorClass: description.errorClass,
    ...(description.code === undefined ? {} : { code: description.code }),
    ...(description.causeChain === undefined ? {} : { causeChain: description.causeChain }),
    ...(description.frames === undefined ? {} : { frames: description.frames }),
  };
}

function continuationErrorKind(
  state: Exclude<ContinuationState, "continued" | "skipped">,
): ActivityLogErrorKind {
  if (state === "run-superseded") return "conflict";
  return state === "not-evidenced" ? "validation-failed" : "unavailable";
}
