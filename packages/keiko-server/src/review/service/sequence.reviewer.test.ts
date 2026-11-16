// The `reviewing` phase hands every Reviewer launch the model's readiness check (ADR-0184 D8,
// Issue #4130), on the phase itself with a clock the test advances. The launch accepts only a fresh
// readiness observation, and the rules read and the instance start take time before it reads one,
// so the check has to run at the launch, not before the session is requested (R4130-048).

import { describe, expect, it } from "vitest";
import type { ReviewDiffCoverageSummary } from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";

import { captureActivityLog } from "../../activityLogCapture.test-support.js";
import type { ReviewDiffPackage } from "../diff-package/types.js";
import type { ReviewCandidateFinding } from "../runtime/findingIntake.js";
import type { ReviewRuntimeRunRequest, ReviewRuntimeRunResult } from "../runtime/instance.js";
import { ReviewRunEventHub } from "./events.js";
import {
  newReviewRunState,
  runReviewer,
  type ReviewRunContext,
  type ReviewRunState,
  type ReviewSequenceDeps,
} from "./sequence.js";

const COMPLETED: Extract<ReviewRuntimeRunResult, { readonly ok: true }> = {
  ok: true,
  outcome: "completed",
  rules: "absent",
  candidates: [],
  rejections: {
    "schema-invalid": 0,
    "path-outside-worktree": 0,
    "range-invalid": 0,
    "evidence-mismatch": 0,
    "limit-reached": 0,
  },
};

/** The phase reads only a candidate's fingerprint. */
function candidateOf(index: number): ReviewCandidateFinding {
  return { fingerprint: String(index).padStart(64, "0") } as ReviewCandidateFinding;
}

/** The read calls a part's sessions report, as a result fragment. */
function readCallsOf(
  options: PhaseOptions,
  index: number,
): Pick<Extract<ReviewRuntimeRunResult, { readonly ok: true }>, "readCalls"> | object {
  const readCalls = options.readCalls?.[index];
  return readCalls === undefined ? {} : { readCalls };
}

/**
 * One session's result for a part: the scripted end of this launch when the options name one,
 * otherwise completed with the read calls and report the options name.
 */
function sessionResult(
  options: PhaseOptions,
  index: number,
  launch: number,
): ReviewRuntimeRunResult {
  const end = options.sessions?.[index]?.[launch];
  const reads = readCallsOf(options, index);
  if (end !== undefined && end !== "completed") {
    const candidates = end.candidate === true ? [candidateOf(index)] : [];
    const failed = { outcome: "failed" as const, failureCode: end.failureCode };
    return { ...COMPLETED, ...failed, candidates, ...reads };
  }
  const candidates = options.reportingParts?.includes(index) === true ? [candidateOf(index)] : [];
  return { ...COMPLETED, candidates, ...reads };
}

/** A fresh readiness observation lives this long in the fixture. */
const READINESS_LIFETIME_MS = 300_000;
/** The rules read and the instance start, before the launch reads the model's authority. */
const LAUNCH_MS = 38_000;

interface Phase {
  readonly state: ReviewRunState;
  /** Readiness checks and launches, in the order they happened. */
  readonly order: string[];
  readonly completed: boolean;
  /** The fields of every `review.run.part` line the phase wrote. */
  readonly partLines: readonly Readonly<Record<string, unknown>>[];
  /** Every coverage summary the phase stored, in order (#4130: the read-limit counts). */
  readonly coverageSummaries: readonly ReviewDiffCoverageSummary[];
}

interface PhaseOptions {
  readonly partCount: number;
  /** How long one Reviewer session takes on the fixture's clock. */
  readonly sessionMs?: number;
  /** The age of the Reviewer model's readiness observation when the phase starts. */
  readonly observationAgeMs?: number;
  /** `false` composes the phase without the readiness port, as a deployment without it does. */
  readonly ensureReady?: boolean;
  /** The read calls each session's result reports, by part index (#4130). */
  readonly readCalls?: readonly ReviewRuntimeReadCalls[];
  /** The part indexes whose session filed one accepted report. */
  readonly reportingParts?: readonly number[];
  /** How each part's sessions end, in order, by part index; a missing entry completes. */
  readonly sessions?: readonly (readonly SessionEnd[])[];
}

/** A scripted session end: completed, or failed with the runtime's failure code. */
type SessionEnd = "completed" | { readonly failureCode: string; readonly candidate?: boolean };

type ReviewRuntimeReadCalls = NonNullable<
  Extract<ReviewRuntimeRunResult, { readonly ok: true }>["readCalls"]
>;

/**
 * A launch as the review runtime performs it: the rules read and the instance start take time, then
 * the launch calls the request's readiness check and refuses a model whose observation is older
 * than its lifetime. Only the check renews the observation.
 */
function runPhase(options: PhaseOptions): Promise<Phase> {
  const order: string[] = [];
  const launches = new Map<number, number>();
  const capture = captureActivityLog();
  const clock = { now: 1_000_000 };
  let observedAt = clock.now - (options.observationAgeMs ?? 0);
  const now = (): number => clock.now;
  const run = async (request: ReviewRuntimeRunRequest): Promise<ReviewRuntimeRunResult> => {
    clock.now += LAUNCH_MS;
    await request.ensureModelReady?.();
    order.push(`launch:${String(request.diffPart?.index ?? 0)}`);
    if (clock.now - observedAt >= READINESS_LIFETIME_MS) {
      return { ok: false, reason: "runtime-unavailable" };
    }
    clock.now += options.sessionMs ?? 1_000;
    const index = request.diffPart?.index ?? 0;
    const launch = launches.get(index) ?? 0;
    launches.set(index, launch + 1);
    return sessionResult(options, index, launch);
  };
  const ensureReady = (modelId: string, correlationId: string | undefined): Promise<void> => {
    order.push(`ready:${modelId}:${String(correlationId)}`);
    if (clock.now - observedAt >= READINESS_LIFETIME_MS) observedAt = clock.now;
    return Promise.resolve();
  };
  // The phase reads only these ports; of the store it calls the coverage summary's update.
  const coverageSummaries: ReviewDiffCoverageSummary[] = [];
  const deps = {
    store: {
      setCoverageSummary: (_runId: string, summary: ReviewDiffCoverageSummary): void => {
        coverageSummaries.push(summary);
      },
    },
    reviewServices: {},
    reviewRuntime: { run },
    models: options.ensureReady === false ? {} : { ensureReady },
    activityLog: capture.sink,
    events: new ReviewRunEventHub(now),
    now,
  } as unknown as ReviewSequenceDeps;
  const state = newReviewRunState();
  state.target = { baseSha: "b".repeat(40), headSha: "a".repeat(40), diffBaseSha: "b".repeat(40) };
  state.worktreeRoot = "/review-worktree";
  state.coverageSummary = {
    changedFiles: options.partCount,
    reviewedFiles: options.partCount,
    partiallyReviewedFiles: 0,
    unprocessedFiles: 0,
    addedLines: 1,
    removedLines: 0,
    budgetTokens: 100,
    usedTokens: 10,
  };
  const ctx: ReviewRunContext = {
    runId: "review-run-1",
    correlationId: "run-correlation",
    repositoryRoot: "/repository",
    target: { kind: "local-range", baseRef: "main", headRef: "topic" },
    reviewerModelId: "reviewer",
    counterCheckerModelId: "counter-checker",
    counterCheck: "on",
    signal: new AbortController().signal,
    startedAt: clock.now,
  };
  const parts = Array.from({ length: options.partCount }, (_, index) => ({
    text: `part ${String(index)}`,
    usedTokens: 10,
    fileCount: 1,
  }));
  const diffPackage = { parts } as unknown as ReviewDiffPackage;
  return runReviewer(deps, ctx, state, diffPackage).then((completed) => ({
    state,
    order,
    completed,
    coverageSummaries,
    partLines: capture.events
      .filter((event) => event.op === "review.run.part")
      .map((event) => event.extra ?? {}),
  }));
}

describe("the Reviewer model's readiness at each launch (Issue #4130)", () => {
  it("hands every part's launch the check for the Reviewer model under the run's correlation", async () => {
    const { order, state } = await runPhase({ partCount: 2 });
    expect(order).toEqual([
      "ready:reviewer:run-correlation",
      "launch:0",
      "ready:reviewer:run-correlation",
      "launch:1",
    ]);
    expect(state.reviewer).toEqual({ outcome: "completed" });
  });

  it("reviews after a preparation that outlasted the readiness observation", async () => {
    const { state, completed } = await runPhase({
      partCount: 1,
      observationAgeMs: READINESS_LIFETIME_MS + 1,
    });
    expect(completed).toBe(true);
    expect(state.preparation).toBeUndefined();
    expect(state.reviewer).toEqual({ outcome: "completed" });
  });

  // R4130-048: fresh when the session is requested, lapsed by the time the launch reads it.
  it("reviews when the observation lapses during the rules read and the instance start", async () => {
    const { state, completed } = await runPhase({
      partCount: 1,
      observationAgeMs: READINESS_LIFETIME_MS - 20_000,
    });
    expect(completed).toBe(true);
    expect(state.preparation).toBeUndefined();
    expect(state.reviewer).toEqual({ outcome: "completed" });
  });

  it("reviews a later part after a session that outlasted the readiness observation", async () => {
    const { state } = await runPhase({ partCount: 3, sessionMs: READINESS_LIFETIME_MS + 1 });
    expect(state.reviewer).toEqual({ outcome: "completed" });
  });

  it("still launches when the deployment has no readiness port", async () => {
    const { order, state } = await runPhase({ partCount: 1, ensureReady: false });
    expect(order).toEqual(["launch:0"]);
    expect(state.reviewer).toEqual({ outcome: "completed" });
  });
});

describe("the Reviewer session's read calls on the part line (Issue #4130)", () => {
  it("records each session's admitted and refused read calls on its own part line", async () => {
    const { partLines, state } = await runPhase({
      partCount: 2,
      readCalls: [
        { admitted: 7, refused: 0 },
        { admitted: 24, refused: 3 },
      ],
      reportingParts: [1],
    });

    expect(state.reviewer).toEqual({ outcome: "completed" });
    expect(partLines).toMatchObject([
      { partNumber: 1, outcome: "completed", readCallCount: 7, refusedReadCallCount: 0 },
      { partNumber: 2, outcome: "completed", readCallCount: 24, refusedReadCallCount: 3 },
    ]);
  });

  // R4130-054: the allowance stopped the session, the session ended its turn as told, and the part
  // settled as a clean `complete` although nothing was reported and nothing said so. The first fix
  // failed such a part. The owner decided on 2026-11-16 that the part counts as reviewed and that
  // the result must show it: the run counts the parts whose reading was cut and, of those, the
  // ones that reported nothing.
  it("keeps a part whose session was refused a read and filed no report, and counts it", async () => {
    const { partLines, state, completed, coverageSummaries } = await runPhase({
      partCount: 4,
      readCalls: [
        { admitted: 16, refused: 2 },
        { admitted: 16, refused: 1 },
        { admitted: 5, refused: 0 },
        { admitted: 16, refused: 4 },
      ],
      reportingParts: [0],
    });

    expect(state.reviewer).toEqual({ outcome: "completed" });
    expect(completed).toBe(true);
    expect(state.candidates).toHaveLength(1);
    expect(partLines).toMatchObject([
      { partNumber: 1, outcome: "completed", candidateCount: 1, refusedReadCallCount: 2 },
      { partNumber: 2, outcome: "completed", candidateCount: 0, refusedReadCallCount: 1 },
      { partNumber: 3, outcome: "completed", candidateCount: 0, refusedReadCallCount: 0 },
      { partNumber: 4, outcome: "completed", candidateCount: 0, refusedReadCallCount: 4 },
    ]);
    // Three parts had a read refused; two of them reported nothing.
    expect(state.readLimitedParts).toBe(3);
    expect(state.readLimitedPartsWithoutReport).toBe(2);
    expect(coverageSummaries.at(-1)).toMatchObject({
      readLimitedParts: 3,
      readLimitedPartsWithoutReport: 2,
    });
  });

  it("counts no part of a run whose sessions were never refused a read", async () => {
    const { state, coverageSummaries } = await runPhase({
      partCount: 2,
      readCalls: [
        { admitted: 3, refused: 0 },
        { admitted: 16, refused: 0 },
      ],
    });
    expect(state.readLimitedParts).toBe(0);
    expect(state.readLimitedPartsWithoutReport).toBe(0);
    expect(coverageSummaries.at(-1)).toMatchObject({
      readLimitedParts: 0,
      readLimitedPartsWithoutReport: 0,
    });
  });

  it("does not call a part silent whose read-limited session failed", async () => {
    const { state } = await runPhase({
      partCount: 1,
      readCalls: [{ admitted: 16, refused: 1 }],
      sessions: [[{ failureCode: "authority-budget-exceeded" }]],
    });
    expect(state.reviewer).toEqual({ outcome: "failed", reason: "budget-exhausted" });
    expect(state.readLimitedParts).toBe(1);
    expect(state.readLimitedPartsWithoutReport).toBe(0);
  });

  it("writes no read counts for a session whose result carries none", async () => {
    const { partLines } = await runPhase({ partCount: 1 });

    expect(partLines).toHaveLength(1);
    expect(partLines[0]).not.toHaveProperty("readCallCount");
    expect(partLines[0]).not.toHaveProperty("refusedReadCallCount");
  });
});

// #4130: one malformed tool call or one empty answer of a local model ended the session, and the
// review lost the whole part (`incomplete/model-failed`): 5 of 100 sessions in development
// iteration 7 (2 of them before any report), and 6 of 187 seed reviews before it.
describe("a Reviewer session that fails before any report (Issue #4130)", () => {
  it("starts the part's session once more after a model failure without a candidate", async () => {
    const { order, partLines, state } = await runPhase({
      partCount: 2,
      sessions: [[{ failureCode: "invalid-tool-call" }, "completed"]],
    });

    expect(order.filter((entry) => entry.startsWith("launch:"))).toEqual([
      "launch:0",
      "launch:0",
      "launch:1",
    ]);
    expect(state.reviewer).toEqual({ outcome: "completed" });
    expect(partLines).toMatchObject([
      { partNumber: 1, outcome: "failed", reason: "model-failed" },
      { partNumber: 1, outcome: "completed", attempt: 2 },
      { partNumber: 2, outcome: "completed" },
    ]);
    expect(partLines[0]).not.toHaveProperty("attempt");
    expect(partLines[2]).not.toHaveProperty("attempt");
  });

  it("keeps the failure when the second session fails as well, and starts no third", async () => {
    const { order, partLines, state } = await runPhase({
      partCount: 1,
      sessions: [
        [{ failureCode: "empty-answer" }, { failureCode: "invalid-tool-call" }, "completed"],
      ],
    });

    expect(order.filter((entry) => entry.startsWith("launch:"))).toEqual(["launch:0", "launch:0"]);
    expect(state.reviewer).toEqual({ outcome: "failed", reason: "model-failed" });
    expect(partLines).toMatchObject([
      { partNumber: 1, outcome: "failed", reason: "model-failed" },
      { partNumber: 1, outcome: "failed", reason: "model-failed", attempt: 2 },
    ]);
  });

  // R4130-059: the worst case of a review is two sessions for every part, never more.
  it("starts at most two sessions for each part when every session fails", async () => {
    const failing: readonly SessionEnd[] = [
      { failureCode: "empty-answer" },
      { failureCode: "empty-answer" },
      "completed",
    ];
    const { order, partLines, state } = await runPhase({
      partCount: 3,
      sessions: [failing, failing, failing],
    });

    expect(order.filter((entry) => entry.startsWith("launch:"))).toEqual([
      "launch:0",
      "launch:0",
      "launch:1",
      "launch:1",
      "launch:2",
      "launch:2",
    ]);
    expect(partLines).toHaveLength(6);
    expect(state.reviewer).toEqual({ outcome: "failed", reason: "model-failed" });
  });

  it("does not start a session again that already filed a candidate", async () => {
    const { order, state } = await runPhase({
      partCount: 1,
      sessions: [[{ failureCode: "invalid-tool-call", candidate: true }, "completed"]],
    });

    expect(order.filter((entry) => entry.startsWith("launch:"))).toEqual(["launch:0"]);
    expect(state.reviewer).toEqual({ outcome: "failed", reason: "model-failed" });
    expect(state.candidates).toHaveLength(1);
  });

  it("does not start a session again that ran out of budget or time", async () => {
    for (const failureCode of ["authority-budget-exceeded", "envelope-duration-exhausted"]) {
      const { order } = await runPhase({
        partCount: 1,
        sessions: [[{ failureCode }, "completed"]],
      });
      expect(
        order.filter((entry) => entry.startsWith("launch:")),
        failureCode,
      ).toEqual(["launch:0"]);
    }
  });

  it("adds both sessions' tokens and time to the Reviewer totals", async () => {
    const { state } = await runPhase({
      partCount: 1,
      sessionMs: 1_000,
      sessions: [[{ failureCode: "invalid-tool-call" }, "completed"]],
    });

    expect(state.reviewerTotals.durationMs).toBe(2 * (38_000 + 1_000));
  });
});
