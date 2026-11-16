// The `counter-checking` phase's wall-time limit (ADR-0184 D5, Issue #4130), on the phase itself
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
  /** What one counter-check does besides answering: advance the clock. */
  readonly onCheck?: (input: CounterCheckInput, clock: { now: number }) => void;
  readonly effect?: CounterCheckOutcome["effect"];
  /** A check's effect by the candidate's start line, where it differs from `effect`. */
  readonly effectByLine?: Readonly<Record<number, CounterCheckOutcome["effect"]>>;
  /** The verdict by a candidate's start line; a line not named stays undecided. */
  readonly verdicts?: Readonly<Record<number, "confirmed" | "refuted" | "undecided">>;
  /** The run's exclusion of dismissed fingerprints; by default nothing is excluded. */
  readonly excluded?: (fingerprint: string) => boolean;
}

function sequenceDeps(
  options: PhaseOptions,
  phase: Pick<Phase, "log" | "checked" | "clock">,
): ReviewSequenceDeps {
  const answer = counterCheckBy(options.verdicts ?? {}, options.effect ?? "none");
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
      const effect = options.effectByLine?.[input.candidate.report.startLine];
      return effect === undefined
        ? answer(input)
        : answer(input).then((outcome) => ({ ...outcome, effect }));
    },
    models: { capability: (): undefined => undefined },
    activityLog: phase.log.sink,
    events: new ReviewRunEventHub(now),
    now,
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
  await counterCheckCandidates(
    sequenceDeps(options, phase),
    ctx,
    phase.state,
    options.excluded ?? ((): boolean => false),
  );
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
    expect(phaseLine(log)).toMatchObject({ counterCheckPhaseWallTimeMs: 2 * PHASE_LIMIT_MS });
  });

  // Keiko does not limit tokens (#4346): the wall-time limit is the phase's only stop of this kind.
  it("records no token allowance on the phase line", async () => {
    const { log } = await runPhase({ reports: THREE, onCheck: taking(19_000) });
    expect(phaseLine(log)).not.toHaveProperty("counterCheckRunPromptAllowance");
  });
});

// #4130: counter-checks run in presentation order and a run presents at most three findings, so a
// candidate checked after the third presentable one can never be presented. In development
// iteration 7 the checks after that point took 3.76 of 9.05 hours in the first 13 reviews, and one
// of them ran into its time limit and alone made its review incomplete.
describe("the counter-check phase stops when the presentation is full (Issue #4130)", () => {
  const SIX = [
    reportAt(3, "high"),
    reportAt(7, "high"),
    reportAt(10, "medium"),
    reportAt(12, "medium"),
    reportAt(15, "low"),
    reportAt(18, "low"),
  ];

  it("checks no candidate after the third one that will be presented", async () => {
    const { state, checked } = await runPhase({
      reports: SIX,
      verdicts: { 3: "confirmed", 7: "confirmed", 10: "confirmed", 12: "confirmed" },
    });

    expect(checked).toEqual([3, 7, 10]);
    expect(state.surplusCandidates).toBe(3);
    expect(state.uncheckedCandidates).toBe(0);
    expect(state.uncheckedReason).toBeUndefined();
    expect(state.outcomes.size).toBe(3);
    expect(settlementOf(state)).toEqual({ kind: "complete" });
  });

  it("goes on past refuted candidates until three are presentable", async () => {
    const { state, checked } = await runPhase({
      reports: SIX,
      verdicts: { 3: "confirmed", 7: "refuted", 10: "confirmed", 12: "refuted", 15: "confirmed" },
    });

    expect(checked).toEqual([3, 7, 10, 12, 15]);
    expect(state.surplusCandidates).toBe(1);
    expect(settlementOf(state)).toEqual({ kind: "complete" });
  });

  it("checks every candidate when fewer than three are presentable", async () => {
    const { state, checked } = await runPhase({
      reports: SIX,
      verdicts: { 3: "confirmed", 7: "refuted", 10: "confirmed", 12: "refuted", 15: "refuted" },
    });

    expect(checked).toEqual([3, 7, 10, 12, 15, 18]);
    expect(state.surplusCandidates).toBe(0);
  });

  it("reports no surplus when the third presentable candidate is the last one", async () => {
    const { state, checked } = await runPhase({
      reports: THREE,
      verdicts: { 3: "confirmed", 7: "confirmed", 10: "confirmed" },
    });

    expect(checked).toEqual([3, 7, 10]);
    expect(state.surplusCandidates).toBe(0);
  });

  // The stop must not hide an earlier check that could not finish: had it been decided, it could
  // have been presented in place of a later one.
  it("keeps the run incomplete when a check before the stop ended undecided on its limit", async () => {
    const effects: Readonly<Record<number, CounterCheckOutcome["effect"]>> = {
      7: "deadline-exceeded",
    };
    const { state, checked } = await runPhase({
      reports: SIX,
      verdicts: { 3: "confirmed", 10: "confirmed", 12: "confirmed" },
      effectByLine: effects,
    });

    expect(checked).toEqual([3, 7, 10, 12]);
    expect(state.surplusCandidates).toBe(2);
    expect(settlementOf(state)).toEqual({ kind: "incomplete", reason: "deadline-exceeded" });
  });

  it("does not count a confirmed candidate whose fingerprint is excluded", async () => {
    const { state, checked } = await runPhase({
      reports: SIX,
      verdicts: { 3: "confirmed", 7: "confirmed", 10: "confirmed", 12: "confirmed" },
      excluded: (fingerprint) => fingerprint === "fingerprint-7",
    });

    expect(checked).toEqual([3, 7, 10, 12]);
    expect(state.surplusCandidates).toBe(2);
  });

  it("leaves the phase's own limits in place: a passed deadline still leaves candidates unchecked", async () => {
    const { state, checked } = await runPhase({
      reports: SIX,
      verdicts: { 3: "confirmed", 7: "confirmed" },
      onCheck: taking(30_000),
    });

    expect(checked).toEqual([3, 7]);
    expect(state.surplusCandidates).toBe(0);
    expect(state.uncheckedCandidates).toBe(4);
    expect(settlementOf(state)).toEqual({ kind: "incomplete", reason: "deadline-exceeded" });
  });
});
