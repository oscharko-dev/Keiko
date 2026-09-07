// Review 3941793538: `waitForCiRepairOutcome` alone let an immediately-blocked PR, an
// already-green PR (no failure ever observed), or a "ready" readiness on the SAME head a failure
// was observed on all serialize as a passing `ci-repair-loop` receipt, because the spec's generic
// `recordOutcome` treats "the runner did not throw" as "passed". `evaluateCiRepairLoopOutcome` is
// the pure decision this runner must consult before returning normally; pinned here independent of
// Playwright/the live harness so the causal-fact requirement (an observed failure, a genuinely
// repaired head, and fresh technical-ready readiness) cannot silently regress.

import { describe, expect, it } from "vitest";
import {
  evaluateCiRepairLoopOutcome,
  type CiRepairOutcome,
} from "./coding-issue-journey-live-ci.js";

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
