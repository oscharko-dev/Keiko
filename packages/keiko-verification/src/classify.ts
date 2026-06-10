// PURE outcome classification (ADR-0007 D1). The single authority mapping a settled runCommand
// outcome — a resolved CommandResult OR a rejection — plus the orchestrator's abortReason to a
// VerificationStatus. No IO, no spawn, no clock: the orchestrator owns all effects and calls this
// once per step. The precedence is fixed and the first match wins; each branch is independently
// unit-tested so a single-line mutation is caught.

import {
  CommandCancelledError,
  CommandDeniedError,
  CommandTimeoutError,
} from "@oscharko-dev/keiko-tools";
import type { CommandResult } from "@oscharko-dev/keiko-tools";
import type { VerificationStatus } from "./types.js";

// Why distinguish abortReason from the error type: an abort fires BOTH the abort source and (a
// beat later) a CommandCancelledError. The reason carries intent (memory breach vs. harness
// cancellation) that the bare CommandCancelledError cannot, so it is checked first.
export type AbortReason = "harness" | "memory" | undefined;

export interface OutcomeInput {
  // True when the step was pre-marked skip (no detected script, ADR-0007 D4): no command ran.
  readonly skipped: boolean;
  // The resolved result, present iff runCommand resolved.
  readonly result: CommandResult | undefined;
  // The rejection, present iff runCommand rejected.
  readonly error: unknown;
  readonly abortReason: AbortReason;
}

function classifyError(error: unknown, abortReason: AbortReason): VerificationStatus {
  if (error instanceof CommandDeniedError) {
    return "denied";
  }
  if (abortReason === "memory") {
    return "resource-exceeded";
  }
  if (abortReason === "harness") {
    return "cancelled";
  }
  if (error instanceof CommandTimeoutError) {
    return "timed-out";
  }
  if (error instanceof CommandCancelledError) {
    // D1 branch 6's `memory → resource-exceeded` sub-case is handled earlier by branch 3
    // (`abortReason === "memory"` returns before we reach here), so a CommandCancelledError that
    // survives to this point is, by construction, a harness/plain cancellation.
    return "cancelled";
  }
  return "failed";
}

function classifyResult(result: CommandResult): VerificationStatus {
  if (result.timedOut) {
    return "timed-out";
  }
  if (result.truncated) {
    return "resource-exceeded";
  }
  if (result.exitCode === 0) {
    return "passed";
  }
  return "failed";
}

export function classifyOutcome(input: OutcomeInput): VerificationStatus {
  if (input.skipped) {
    return "skipped";
  }
  if (input.error !== undefined) {
    return classifyError(input.error, input.abortReason);
  }
  if (input.result !== undefined) {
    return classifyResult(input.result);
  }
  // No result and no error is not a reachable runCommand settle state; treat as failed defensively
  // at this internal boundary so the function is total over its input type.
  return "failed";
}
