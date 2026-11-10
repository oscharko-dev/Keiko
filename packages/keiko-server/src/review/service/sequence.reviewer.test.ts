// The `reviewing` phase's readiness re-check (ADR-0182 D8, Issue #4130), on the phase itself: the
// Reviewer model's readiness is verified again right before each part's session, because the launch
// accepts only a fresh observation and the preparation or an earlier session can outlast it.

import { describe, expect, it } from "vitest";

import { captureActivityLog } from "../../activityLogCapture.test-support.js";
import type { ReviewDiffPackage } from "../diff-package/types.js";
import type { ReviewRuntimeRunRequest, ReviewRuntimeRunResult } from "../runtime/instance.js";
import { ReviewRunEventHub } from "./events.js";
import {
  newReviewRunState,
  runReviewer,
  type ReviewRunContext,
  type ReviewRunState,
  type ReviewSequenceDeps,
} from "./sequence.js";

const NO_REJECTIONS = {
  "schema-invalid": 0,
  "path-outside-worktree": 0,
  "range-invalid": 0,
  "evidence-mismatch": 0,
  "limit-reached": 0,
};

const COMPLETED: ReviewRuntimeRunResult = {
  ok: true,
  outcome: "completed",
  rules: "absent",
  candidates: [],
  rejections: NO_REJECTIONS,
};

/** A fresh readiness observation lives this long in the fixture. */
const READINESS_LIFETIME_MS = 300_000;

interface Phase {
  readonly state: ReviewRunState;
  /** Readiness checks and session starts, in the order they happened. */
  readonly order: string[];
  readonly completed: boolean;
}

interface PhaseOptions {
  readonly partCount: number;
  /** How long one Reviewer session takes on the fixture's clock. */
  readonly sessionMs?: number;
  /** The age of the Reviewer model's readiness observation when the phase starts. */
  readonly observationAgeMs?: number;
  /** `false` composes the phase without the readiness port, as a deployment without it does. */
  readonly ensureReady?: boolean;
}

/**
 * A launch as the review runtime performs it: it refuses a model whose readiness observation is
 * older than its lifetime. Only the readiness check renews the observation here, so a session
 * that outlasts the lifetime leaves the next part's launch to the re-check.
 */
function runPhase(options: PhaseOptions): Promise<Phase> {
  const order: string[] = [];
  const clock = { now: 1_000_000 };
  let observedAt = clock.now - (options.observationAgeMs ?? 0);
  const now = (): number => clock.now;
  const run = (request: ReviewRuntimeRunRequest): Promise<ReviewRuntimeRunResult> => {
    order.push(`session:${String(request.diffPart?.index ?? 0)}`);
    if (clock.now - observedAt >= READINESS_LIFETIME_MS) {
      return Promise.resolve({ ok: false, reason: "runtime-unavailable" });
    }
    clock.now += options.sessionMs ?? 1_000;
    return Promise.resolve(COMPLETED);
  };
  const ensureReady = (modelId: string): Promise<void> => {
    order.push(`ready:${modelId}`);
    if (clock.now - observedAt >= READINESS_LIFETIME_MS) observedAt = clock.now;
    return Promise.resolve();
  };
  // The phase reads only these ports; the store is not exercised without a rules digest.
  const deps = {
    store: {},
    reviewServices: {},
    reviewRuntime: { run },
    models: options.ensureReady === false ? {} : { ensureReady },
    activityLog: captureActivityLog().sink,
    events: new ReviewRunEventHub(now),
    now,
    counterCheckRunPromptTokens: 1_000,
  } as unknown as ReviewSequenceDeps;
  const state = newReviewRunState();
  state.target = { baseSha: "b".repeat(40), headSha: "a".repeat(40), diffBaseSha: "b".repeat(40) };
  state.worktreeRoot = "/review-worktree";
  const ctx: ReviewRunContext = {
    runId: "review-run-1",
    correlationId: "review-run-correlation",
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
  }));
}

describe("the Reviewer model's readiness before each session (Issue #4130)", () => {
  it("verifies the Reviewer model again right before every part's session", async () => {
    const { order, state } = await runPhase({ partCount: 2 });
    expect(order).toEqual(["ready:reviewer", "session:0", "ready:reviewer", "session:1"]);
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

  it("reviews a later part after a session that outlasted the readiness observation", async () => {
    const { state } = await runPhase({ partCount: 3, sessionMs: READINESS_LIFETIME_MS + 1 });
    expect(state.reviewer).toEqual({ outcome: "completed" });
  });

  it("still starts the session when the deployment has no readiness port", async () => {
    const { order, state } = await runPhase({ partCount: 1, ensureReady: false });
    expect(order).toEqual(["session:0"]);
    expect(state.reviewer).toEqual({ outcome: "completed" });
  });
});
