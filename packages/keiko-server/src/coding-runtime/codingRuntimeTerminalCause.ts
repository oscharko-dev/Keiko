// F9 (#3873, live Gemma qualification): a run that ended on one of its own bounds or on a failed
// model call was shown as "The coding run ended with an internal error", although nothing internal
// failed. Run `run-65084062444586162471229658028402064666` exhausted its cumulative prompt allowance
// (`coding-sidecar.gateway.rejected reason=runtime-prompt-budget-denied`); run
// `run-272120967981827964065820685403290179367` reached its 30-minute envelope duration with a model
// call in flight (`coding-sidecar.gateway.outcome outcome=cancelled cancellationCause=run-stopped`);
// both settled `runtime-failed`. A failed task outcome carries no cause, so settlement reads the
// cause from the layers that own the facts, never from OpenCode's error text:
//
// - the runtime authority knows whether the run's most recent model-call admission was refused by
//   the cumulative prompt allowance (`CodingRuntimeAuthorityService.promptAllowanceExhausted`) and
//   whether the run's Authority Envelope ran out of time (`envelopeDurationExhausted`);
// - the event hub keeps the closed cause the coding sidecar gateway reported for the run's most
//   recent failed model call, until a later call is answered
//   (`CodingRuntimeEventHub.lastModelCallFailure`), and the gateway's own fact that the provider could
//   not serve that call (`lastModelCallProviderUnavailable`).
//
// Body-free by construction: every input and output is a closed code.
import type {
  ActivityLogErrorKind,
  CodingWorkbenchRuntimeFailureCode,
} from "@oscharko-dev/keiko-contracts";
import type { CodingWorkbenchTurnFailureCode } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-api";

export interface CodingRuntimeTerminalFacts {
  /**
   * True when the run's most recent model-call admission was refused by its prompt allowance: the
   * authority's own, or the same `maxPromptTokens` counted by the run's CI repair
   * (`prompt-budget-exhausted`). No other reason a CI-repair budget refuses for is the allowance.
   */
  readonly promptAllowanceExhausted: (runId: string) => boolean;
  /**
   * True when the run's time limit has run out: its Authority Envelope's `expiresAt` / `maxRuntimeMs`,
   * or the same `maxRuntimeMs` counted by the run's CI repair (`deadline-exhausted`) refused its most
   * recent model call.
   */
  readonly envelopeDurationExhausted: (runId: string) => boolean;
  /** The gateway's cause for the run's most recent failed model call no later answer superseded. */
  readonly lastModelCallFailure: (runId: string) => CodingWorkbenchTurnFailureCode | undefined;
  /**
   * True when the gateway found that the provider could not serve the run's most recent failed model
   * call — a retryable provider status (408, 429, 5xx), a rate limit, an open breaker — which its
   * `provider-failed` cause names the same as a rejection. Absent, no `provider-failed` call is
   * attributed to an unavailable provider.
   */
  readonly lastModelCallProviderUnavailable?: ((runId: string) => boolean) | undefined;
}

export type CodingRuntimeTerminalFailureCode = Extract<
  CodingWorkbenchRuntimeFailureCode,
  | "runtime-failed"
  | "prompt-allowance-exhausted"
  | "envelope-duration-exhausted"
  | "output-exhausted-repeated"
  | "provider-unavailable"
  | "model-turn-failed"
>;

/** Which fact named the cause; `no-model-call-failure` keeps the internal `runtime-failed`. */
export type CodingRuntimeTerminalFailureBasis =
  "prompt-allowance" | "envelope-duration" | "model-call-failure" | "no-model-call-failure";

export interface CodingRuntimeTerminalFailure {
  readonly failureCode: CodingRuntimeTerminalFailureCode;
  readonly basis: CodingRuntimeTerminalFailureBasis;
  readonly modelCallFailure?: CodingWorkbenchTurnFailureCode;
}

// The gateway reports `stream-incomplete` for an attempt that timed out, a connection that was
// refused or dropped, and a stream that broke before the answer completed: the provider could not
// be reached or stopped answering. It reports no other failure that way: a configuration or egress
// refusal, an unknown model or a refused credential is `provider-failed` on every path.
//
// A ProviderError 5xx, 408 or 429, a RateLimitError and a CircuitOpenError are `provider-failed`
// too, the same code as a 4xx rejection, but they are an outage once the gateway has retried through
// its outage window (F10), and a run that ends on one has to say so. The gateway therefore reports,
// beside the cause, the fact that the provider could not serve the call; `provider-failed` plus that
// fact is `provider-unavailable`, and `provider-failed` without it stays a failed model step.
const PROVIDER_UNAVAILABLE_FAILURES: ReadonlySet<CodingWorkbenchTurnFailureCode> = new Set([
  "stream-incomplete",
]);

/**
 * The closed cause a failed task outcome settles the run with. A refusal by one of the run's own
 * bounds comes first, because the failed model call it caused names only its symptom (a refused
 * call reads as `turn-rejected`): the prompt allowance that refused the run's most recent call, then
 * an envelope that ran out of time. Otherwise the run's last failed model call names the cause, and
 * `runtime-failed` is left for a run with no such cause on record.
 */
export function classifyTerminalFailure(
  facts: CodingRuntimeTerminalFacts,
  runId: string,
): CodingRuntimeTerminalFailure {
  const modelCallFailure = facts.lastModelCallFailure(runId);
  const evidence = modelCallFailure === undefined ? {} : { modelCallFailure };
  if (facts.promptAllowanceExhausted(runId)) {
    return { failureCode: "prompt-allowance-exhausted", basis: "prompt-allowance", ...evidence };
  }
  if (facts.envelopeDurationExhausted(runId)) {
    return { failureCode: "envelope-duration-exhausted", basis: "envelope-duration", ...evidence };
  }
  if (modelCallFailure === undefined) {
    return { failureCode: "runtime-failed", basis: "no-model-call-failure" };
  }
  return {
    failureCode: modelCallFailureCode(
      modelCallFailure,
      facts.lastModelCallProviderUnavailable?.(runId) === true,
    ),
    basis: "model-call-failure",
    modelCallFailure,
  };
}

// `output-exhausted` ends a run only once it repeated: the gateway answers a first exhaustion with
// one steered repair (F17) and the runtime retries a turn the gateway did not refuse, so the run's
// last failed call exhausted the output budget again after that repair or those retries.
function modelCallFailureCode(
  modelCallFailure: CodingWorkbenchTurnFailureCode,
  providerUnavailable: boolean,
): CodingRuntimeTerminalFailureCode {
  if (PROVIDER_UNAVAILABLE_FAILURES.has(modelCallFailure)) return "provider-unavailable";
  if (modelCallFailure === "provider-failed" && providerUnavailable) return "provider-unavailable";
  return modelCallFailure === "output-exhausted"
    ? "output-exhausted-repeated"
    : "model-turn-failed";
}

/**
 * The settlement line's error class. A cause named by a model call mirrors the gateway's own
 * turn-failed line for the same call, so both lines of one failure classify it alike.
 */
export function terminalFailureErrorKind(
  failure: CodingRuntimeTerminalFailure,
): ActivityLogErrorKind {
  if (failure.failureCode === "prompt-allowance-exhausted") return "authority-denied";
  if (failure.failureCode === "envelope-duration-exhausted") return "timeout";
  if (failure.failureCode === "provider-unavailable") return "unavailable";
  if (failure.failureCode === "runtime-failed") return "internal";
  return failure.modelCallFailure === "turn-rejected" ? "validation-failed" : "unavailable";
}
