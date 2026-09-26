// Review 3941793538: `waitForCiRepairOutcome` alone let an immediately-blocked PR, an
// already-green PR (no failure ever observed), or a "ready" readiness on the SAME head a failure
// was observed on all serialize as a passing `ci-repair-loop` receipt, because the spec's generic
// `recordOutcome` treats "the runner did not throw" as "passed". `evaluateCiRepairLoopOutcome` is
// the pure decision this runner must consult before returning normally; pinned here independent of
// Playwright/the live harness so the causal-fact requirement (an observed failure, a genuinely
// repaired head, and fresh technical-ready readiness) cannot silently regress.

import { describe, expect, it } from "vitest";
import {
  currentCiReading,
  evaluateCiRepairLoopOutcome,
  type CiRepairOutcome,
} from "./coding-issue-journey-live-ci.js";
import type { ObservedCiReadiness } from "./coding-issue-journey-live-observed.js";

const REQUIRED_CHECKS = { total: 3, passed: 3, failed: 0, pending: 0, blocked: 0, unknown: 0 };

function outcome(overrides: Partial<CiRepairOutcome> = {}): CiRepairOutcome {
  return {
    finalState: "technical-ready",
    observedFailureBeforeReady: true,
    requiredChecks: REQUIRED_CHECKS,
    failureHeadSha: "a".repeat(40),
    finalHeadSha: "b".repeat(40),
    ...overrides,
  };
}

describe("evaluateCiRepairLoopOutcome", () => {
  it("blocks an already-green PR that never needed repair (no failure was ever observed)", () => {
    const result = evaluateCiRepairLoopOutcome(
      outcome({ observedFailureBeforeReady: false, failureHeadSha: undefined }),
    );
    expect(result).toEqual({ result: "blocked", reason: "ci-never-failed" });
  });

  it("fails an immediately blocked PR (a failure was observed but readiness never followed)", () => {
    const result = evaluateCiRepairLoopOutcome(outcome({ finalState: "blocked" }));
    expect(result).toEqual({ result: "failed", reason: "terminal-state-blocked" });
  });

  it("fails readiness reached on the SAME head the failure was observed on (no repair landed)", () => {
    const sameHead = "c".repeat(40);
    const result = evaluateCiRepairLoopOutcome(
      outcome({ failureHeadSha: sameHead, finalHeadSha: sameHead }),
    );
    expect(result).toEqual({ result: "failed", reason: "no-repair-head-unchanged" });
  });

  it("passes an observed failure repaired onto a fresh head that reaches technical-ready", () => {
    const result = evaluateCiRepairLoopOutcome(outcome());
    expect(result).toEqual({
      result: "passed",
      reason: "observed-failure-repaired-fresh-head-ready",
    });
  });
});

// #3390: the CI readiness card reports a settled run's own observations as stale by design, and
// nothing on that card can refresh them; from then on the Issue handoff card's CI group is the
// operator's only current reading. Choosing the wrong source is not a wrong answer but NO answer:
// the lane waited its full twenty minutes on every settled run before this choice existed.
describe("currentCiReading", () => {
  const reading = (state: string, head = "a".repeat(40)): ObservedCiReadiness => ({
    state,
    headSha: head,
    requiredChecks: REQUIRED_CHECKS,
    advisoryChecks: REQUIRED_CHECKS,
  });

  it("acts on the run's own card while its reading is current", () => {
    const runCard = reading("failed");
    expect(
      currentCiReading({ runState: "running", runCard, journey: reading("technical-ready") }),
    ).toBe(runCard);
  });

  it("switches to the handoff's group once the run's card reports its observations as stale", () => {
    const journey = reading("technical-ready", "b".repeat(40));
    expect(currentCiReading({ runState: "succeeded", runCard: reading("stale"), journey })).toBe(
      journey,
    );
  });

  it("reads the handoff's group when the run's card shows nothing at all", () => {
    const journey = reading("blocked");
    expect(currentCiReading({ runState: "succeeded", runCard: undefined, journey })).toBe(journey);
  });

  it("returns the stale run card, never undefined, when the handoff is not shown yet", () => {
    const runCard = reading("stale");
    expect(currentCiReading({ runState: "succeeded", runCard, journey: undefined })).toBe(runCard);
  });
});
