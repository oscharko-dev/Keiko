// Drives one Reviewer run on a review instance's own orchestrator (ADR-0182 D1, Issue #4135).
//
// The run is started exactly like a Coding Workbench run, through the orchestrator of the review
// instance: the task is the rendered review task, the mode is `governed-assist`, project memory is
// off, and no agent is named (the run uses the profile's server-defined review agent). The driver
// then waits for the run's own event stream to close at its terminal state, and stops the run when
// the caller cancels. It adds no agent loop: OpenCode runs the turn, the orchestrator settles it.

import { randomUUID } from "node:crypto";

import type { CodingWorkbenchRuntimeStateName } from "@oscharko-dev/keiko-contracts";
import type { ReviewRuntimeCleanup } from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";

import type { ReviewRuntimeComposition } from "./composition.js";

export interface ReviewRunDriveInput {
  readonly modelId: string;
  readonly taskText: string;
  readonly signal?: AbortSignal | undefined;
  readonly correlationId?: string | undefined;
}

export interface ReviewRunDriveOutcome {
  /** `refused` when the orchestrator did not start the run at all. */
  readonly outcome: "completed" | "failed" | "cancelled" | "refused";
  readonly runId?: string | undefined;
  readonly failureCode?: string | undefined;
  /** The Reviewer's prompt tokens and model turns as the runtime host accounted them (#4136). */
  readonly effort?: { readonly promptTokens: number; readonly modelTurns: number } | undefined;
  /** Whether the runtime's end was proven; absent when the orchestrator never started the run. */
  readonly runtimeCleanup?: ReviewRuntimeCleanup | undefined;
}

type SettledRun = Pick<ReviewRunDriveOutcome, "outcome" | "failureCode" | "runtimeCleanup">;

/**
 * A terminal state means the runtime was stopped and its end proven (the orchestrator settles a run
 * whose stop it cannot prove `recovery-required` instead). `recovery-required` means it
 * was not: the run failed, unless the orchestrator names the one exception (#4136): the turn
 * settled `succeeded` and only the process tree's exit could not be proven (a macOS gateway-profile
 * run, ADR-0140 D3). That Reviewer's work finished, so the review settles on its coverage and
 * findings and records the unproven cleanup as a warning; the runtime stays quarantined.
 */
function settledRun(
  composition: ReviewRuntimeComposition,
  runId: string,
  state: CodingWorkbenchRuntimeStateName | undefined,
  failureCode: string | undefined,
): SettledRun {
  const failure = failureCode === undefined ? {} : { failureCode };
  if (state === "recovery-required") {
    return composition.controlPlane.orchestrator.succeededTurnReapUnproven(runId)
      ? { outcome: "completed", runtimeCleanup: "unproven" }
      : { outcome: "failed", ...failure, runtimeCleanup: "unproven" };
  }
  if (state === "succeeded") return { outcome: "completed", runtimeCleanup: "proven" };
  if (state === "cancelled" || state === "taken-over") {
    return { outcome: "cancelled", ...failure, runtimeCleanup: "proven" };
  }
  // A stream that closed before any settled state leaves the runtime's end unknown.
  return state === "failed"
    ? { outcome: "failed", ...failure, runtimeCleanup: "proven" }
    : { outcome: "failed", ...failure };
}

// The states a review run ends in: the terminal ones, and `recovery-required`, which a review
// never waits out. The run settles on the facts above; its instance keeps the run quarantined
// until the instance's own idle stop, and the next review of the repository runs on a fresh
// instance composed beside it (`instance.ts`, #4136).
const SETTLED_STATES: ReadonlySet<string> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "taken-over",
  "recovery-required",
]);

/** Resolves when the run settles: its event stream closes or reports a settled state. */
function waitForSettlement(composition: ReviewRuntimeComposition, runId: string): Promise<void> {
  return new Promise((resolve) => {
    const subscribed = composition.controlPlane.eventHub.subscribe(runId, undefined, {
      write: (event) => {
        if (SETTLED_STATES.has(event.state)) resolve();
        return true;
      },
      close: () => {
        resolve();
      },
    });
    if (!subscribed.ok) resolve();
  });
}

function stopOnAbort(
  composition: ReviewRuntimeComposition,
  runId: string,
  signal: AbortSignal | undefined,
): () => void {
  if (signal === undefined) return (): void => undefined;
  const stop = (): void => {
    void composition.controlPlane.orchestrator.stop(runId, {
      requestId: `review-stop-${randomUUID()}`,
    });
  };
  if (signal.aborted) stop();
  else signal.addEventListener("abort", stop, { once: true });
  return (): void => {
    signal.removeEventListener("abort", stop);
  };
}

export async function driveReviewRun(
  composition: ReviewRuntimeComposition,
  input: ReviewRunDriveInput,
): Promise<ReviewRunDriveOutcome> {
  const requestId = `review-${randomUUID()}`;
  composition.expectStart(requestId);
  const orchestrator = composition.controlPlane.orchestrator;
  const started = await orchestrator.start(
    {
      requestId,
      taskIntent: input.taskText,
      requestedMode: "governed-assist",
      modelId: input.modelId,
      projectMemory: { enabled: false },
    },
    input.correlationId,
  );
  if (!started.ok) {
    return { outcome: "refused", runId: started.runId, failureCode: started.failureCode };
  }
  const runId = started.snapshot.runId;
  if (runId === undefined) return { outcome: "refused" };
  const release = stopOnAbort(composition, runId, input.signal);
  try {
    await waitForSettlement(composition, runId);
  } finally {
    release();
  }
  const settled = orchestrator.getSnapshot(runId);
  const effort = composition.runEffort?.(runId);
  return {
    ...settledRun(composition, runId, settled?.state, settled?.failureCode),
    runId,
    ...(effort === undefined
      ? {}
      : { effort: { promptTokens: effort.promptTokensTotal, modelTurns: effort.modelTurnCount } }),
  };
}
