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
}

export async function waitForCiRepairOutcome(page: Page): Promise<CiRepairOutcome> {
  let observedFailure = false;
  const snapshot = await waitWhileAnsweringApprovals(
    page,
    async () => {
      const value = await runtimeSnapshot(page);
      if (value.ciReadiness?.state === "failed") observedFailure = true;
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
  };
}
