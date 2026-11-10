// The `counter-checking` phase's wall-time limit (ADR-0182 D5, Issue #4130), on the phase itself
// with a clock the test advances: no counter-check starts after the limit, the limit holds once per
// diff package part, a check in flight is not cut, and the candidates left over settle the run
// `incomplete/deadline-exceeded`.

import { describe, expect, it } from "vitest";
import type { ReviewFindingReport } from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";

import {
  captureActivityLog,
  type ActivityLogCapture,
} from "../../activityLogCapture.test-support.js";
import type { CounterCheckInput, CounterCheckOutcome } from "../counter-check/counterCheck.js";
import type { ReviewServices } from "../services.js";
import { ReviewRunEventHub } from "./events.js";
import { counterCheckBy, reportAt } from "./reviewRunHarness.test-support.js";
import {
  counterCheckCandidates,
  newReviewRunState,
  type ReviewRunContext,
  type ReviewRunState,
  type ReviewSequenceDeps,
} from "./sequence.js";
import { settleReviewRun } from "./settlement.js";
import type { ReviewRunStore } from "./store.js";

const PHASE_LIMIT_MS = 60_000;
const RUN_ALLOWANCE = 1_000;
const START = 1_000_000;

interface Phase {
  readonly state: ReviewRunState;
  readonly log: ActivityLogCapture;
  /** The start line of every candidate a counter-check ran for, in order. */
  readonly checked: number[];
  readonly clock: { now: number };
}

interface PhaseOptions {
  readonly reports: readonly ReviewFindingReport[];
  readonly partCount?: number;
  /** What one counter-check does besides answering: advance the clock, reserve prompt tokens. */
  readonly onCheck?: (input: CounterCheckInput, clock: { now: number }) => void;
  readonly effect?: CounterCheckOutcome["effect"];
}

function sequenceDeps(
  options: PhaseOptions,
  phase: Pick<Phase, "log" | "checked" | "clock">,
): ReviewSequenceDeps {
  const answer = counterCheckBy({}, options.effect ?? "none");
  const now = (): number => phase.clock.now;
  // Of the store and the review services the phase calls one method each, and the scripted
  // counter-check never reads through the runner, so only these two ports are cast. The object
  // itself is typed: a port added to `ReviewSequenceDeps` fails to compile here.
  const store = { setPhase: (): void => undefined } as unknown as ReviewRunStore;
  const reviewServices = { reviewRunner: (): undefined => undefined } as unknown as ReviewServices;
  return {
    store,
    reviewServices,
    reviewRuntime: undefined,
    counterCheck: (input: CounterCheckInput): Promise<CounterCheckOutcome> => {
      phase.checked.push(input.candidate.report.startLine);
      options.onCheck?.(input, phase.clock);
      return answer(input);
    },
    models: { capability: (): undefined => undefined },
    activityLog: phase.log.sink,
    events: new ReviewRunEventHub(now),
    now,
    counterCheckRunPromptTokens: RUN_ALLOWANCE,
    counterCheckPhaseWallTimeMs: PHASE_LIMIT_MS,
  };
}

async function runPhase(options: PhaseOptions): Promise<Phase> {
  const phase: Phase = {
    state: newReviewRunState(),
    log: captureActivityLog(),
    checked: [],
    clock: { now: START },
  };
  phase.state.target = {
    baseSha: "b".repeat(40),
    headSha: "a".repeat(40),
    diffBaseSha: "b".repeat(40),
  };
  phase.state.worktreeRoot = "/review-worktree";
  phase.state.partCount = options.partCount ?? 1;
  phase.state.candidates = options.reports.map((report) => ({
    fingerprint: `fingerprint-${String(report.startLine)}`,
    report,
    defectExcerpt: "excerpt",
  }));
  const ctx: ReviewRunContext = {
    runId: "review-run-1",
    correlationId: "review-run-correlation",
    repositoryRoot: "/repository",
    target: { kind: "local-range", baseRef: "main", headRef: "topic" },
    reviewerModelId: "reviewer",
    counterCheckerModelId: "counter-checker",
    counterCheck: "on",
    signal: new AbortController().signal,
    startedAt: START,
  };
  await counterCheckCandidates(sequenceDeps(options, phase), ctx, phase.state);
  return phase;
}

function settlementOf(state: ReviewRunState): ReturnType<typeof settleReviewRun> {
  return settleReviewRun({
    cancelled: false,
    coverage: { kind: "reviewable" },
    reviewer: { outcome: "completed" },
    counterChecks: state.counterCheckEffects,
    uncheckedCandidates: state.uncheckedCandidates,
    uncheckedReason: state.uncheckedReason,
  });
}

function phaseLine(log: ActivityLogCapture): Readonly<Record<string, unknown>> | undefined {
  return log.withOp("review.run.phase").at(-1)?.extra;
}

const THREE = [reportAt(3, "high"), reportAt(7, "medium"), reportAt(10, "low")];

/** Every counter-check takes `ms` of the clock. */
function taking(ms: number): NonNullable<PhaseOptions["onCheck"]> {
  return (_input, clock) => {
    clock.now += ms;
  };
}

describe("the counter-check phase's wall-time limit (Issue #4130)", () => {
  it("checks every candidate while the phase stays inside its limit", async () => {
    const { state, checked, log } = await runPhase({ reports: THREE, onCheck: taking(19_000) });
    expect(checked).toEqual([3, 7, 10]);
    expect(state.uncheckedCandidates).toBe(0);
    expect(state.uncheckedReason).toBeUndefined();
    expect(settlementOf(state)).toEqual({ kind: "complete" });
    expect(phaseLine(log)).toMatchObject({
      phase: "counter-checking",
      candidateCount: 3,
      counterCheckPhaseWallTimeMs: PHASE_LIMIT_MS,
    });
  });

  it("starts no counter-check once the limit has passed and settles on the deadline", async () => {
    const { state, checked } = await runPhase({ reports: THREE, onCheck: taking(30_000) });
    // Two checks take the whole limit; the third candidate stays unchecked.
    expect(checked).toEqual([3, 7]);
    expect(state.uncheckedCandidates).toBe(1);
    expect(state.uncheckedReason).toBe("deadline-exceeded");
    expect(state.outcomes.size).toBe(2);
    expect(settlementOf(state)).toEqual({ kind: "incomplete", reason: "deadline-exceeded" });
  });

  it("does not cut a check in flight: the phase overruns by at most that check", async () => {
    // The first check alone runs past the limit and still counts.
    const { state, checked } = await runPhase({ reports: THREE, onCheck: taking(90_000) });
    expect(checked).toEqual([3]);
    expect(state.outcomes.size).toBe(1);
    expect(state.uncheckedCandidates).toBe(2);
    expect(state.uncheckedReason).toBe("deadline-exceeded");
  });

  it("holds the limit once for each part of the diff package", async () => {
    const { state, checked, log } = await runPhase({
      reports: THREE,
      partCount: 2,
      onCheck: taking(30_000),
    });
    expect(checked).toEqual([3, 7, 10]);
    expect(state.uncheckedCandidates).toBe(0);
    expect(phaseLine(log)).toMatchObject({
      counterCheckRunPromptAllowance: 2 * RUN_ALLOWANCE,
      counterCheckPhaseWallTimeMs: 2 * PHASE_LIMIT_MS,
    });
  });

  it("names the prompt allowance when it and the limit both ran out", async () => {
    const { state, checked } = await runPhase({
      reports: THREE,
      effect: "budget-exhausted",
      onCheck: (input, clock) => {
        clock.now += 90_000;
        input.budget.reserve(RUN_ALLOWANCE + 1);
      },
    });
    expect(checked).toEqual([3]);
    expect(state.uncheckedCandidates).toBe(2);
    expect(state.uncheckedReason).toBe("budget-exhausted");
    expect(settlementOf(state)).toEqual({ kind: "incomplete", reason: "budget-exhausted" });
  });

  it("keeps the prompt allowance as the reason when only it ran out", async () => {
    const { state } = await runPhase({
      reports: THREE,
      onCheck: (input) => {
        input.budget.reserve(RUN_ALLOWANCE + 1);
      },
    });
    expect(state.uncheckedCandidates).toBe(2);
    expect(state.uncheckedReason).toBe("budget-exhausted");
  });
});
