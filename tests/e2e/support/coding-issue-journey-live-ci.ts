// #3390 — waits for the real model's own CI-observation/repair tool calls
// (`keiko_ci_status` plus its edit/verify/commit/push tools) to move the observed readiness to a
// terminal state on the live lane. There is no fixture "observe-ci" control here (unlike
// `coding-issue-ci.spec.ts`'s scripted server) -- the run's own task instructions
// (`issueResolutionTaskInstructions`) already asked the model to observe and repair CI, so this
// module only watches the outcome the model produces and keeps answering approvals meanwhile.

import type { Page } from "@playwright/test";
import type { ReadinessSnapshot } from "@oscharko-dev/keiko-contracts/runtime/git-delivery-provider";
import { runtimeSnapshot, waitWhileAnsweringApprovals } from "./coding-issue-journey-live.js";

const TERMINAL_CI_STATES = new Set<ReadinessSnapshot["state"]>(["technical-ready", "blocked"]);

export interface CiRepairOutcome {
  readonly finalState: ReadinessSnapshot["state"];
  readonly observedFailureBeforeReady: boolean;
  readonly requiredChecks: ReadinessSnapshot["requiredChecks"];
  /** The exact head observed at the moment a `failed` readiness was first recorded; `undefined`
   * when no failure was ever observed. */
  readonly failureHeadSha: string | undefined;
  /** The exact head bound to the terminal readiness snapshot this outcome resolved on. */
  readonly finalHeadSha: string;
}

export async function waitForCiRepairOutcome(page: Page): Promise<CiRepairOutcome> {
  let observedFailure = false;
  let failureHeadSha: string | undefined;
  const snapshot = await waitWhileAnsweringApprovals(
    page,
    async () => {
      const value = await runtimeSnapshot(page);
      if (value.ciReadiness?.state === "failed") {
        observedFailure = true;
        failureHeadSha ??= value.ciReadiness.headSha;
      }
      return value;
    },
    (value) => value.ciReadiness !== undefined && TERMINAL_CI_STATES.has(value.ciReadiness.state),
    {
      timeoutMs: 20 * 60_000,
      message: "expected the real model to drive CI readiness to a terminal state",
    },
  );
  const readiness = snapshot.ciReadiness;
  if (readiness === undefined) throw new Error("expected a recorded CI readiness observation");
  return {
    finalState: readiness.state,
    observedFailureBeforeReady: observedFailure,
    requiredChecks: readiness.requiredChecks,
    failureHeadSha,
    finalHeadSha: readiness.headSha,
  };
}

export type CiRepairLoopResult = "passed" | "failed" | "blocked";

export interface CiRepairLoopEvidence {
  readonly result: CiRepairLoopResult;
  readonly reason: string;
}

/**
 * Review 3941793538: `waitForCiRepairOutcome` alone returns for both `technical-ready` and
 * `blocked`, and can report `observedFailureBeforeReady=false` (an already-green PR that never
 * needed repair) -- neither may be reported as a passing `ci-repair-loop` receipt, since #3390
 * requires an OBSERVED CI failure, a subsequent model repair, and fresh exact-head readiness, all
 * three, before this scenario may qualify. This is the one place that decision is made, kept pure
 * (no Page/network) so it is unit-testable red-then-green independent of the live harness.
 *
 *   - No failure was ever observed: the repair mechanism was never exercised -- `blocked` (a
 *     missing precondition, not a defect this run produced).
 *   - A failure was observed but readiness never followed: the repair did not succeed -- `failed`.
 *   - Readiness followed, but on the SAME head the failure was observed on: no repair actually
 *     landed (e.g. a flaky re-run went green) -- `failed`.
 *   - A failure was observed, followed by readiness on a DIFFERENT (repaired) head -- `passed`.
 */
export function evaluateCiRepairLoopOutcome(outcome: CiRepairOutcome): CiRepairLoopEvidence {
  if (!outcome.observedFailureBeforeReady) {
    return { result: "blocked", reason: "ci-never-failed" };
  }
  if (outcome.finalState !== "technical-ready") {
    return { result: "failed", reason: `terminal-state-${outcome.finalState}` };
  }
  if (outcome.failureHeadSha === outcome.finalHeadSha) {
    return { result: "failed", reason: "no-repair-head-unchanged" };
  }
  return { result: "passed", reason: "observed-failure-repaired-fresh-head-ready" };
}
