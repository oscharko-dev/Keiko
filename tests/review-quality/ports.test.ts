import { describe, expect, it, vi } from "vitest";

import type { ReviewRunView } from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";
import type { UiHandlerDeps } from "@oscharko-dev/keiko-server";

import {
  createGateReviewer,
  presentedLocations,
  presentedReports,
  UNUSED_EVALUATION_MODEL,
} from "./ports.js";

const MODELS = { reviewerModelId: "reviewer", counterCheckerModelId: "counter" };
const REFS = { baseRef: "keiko-eval/pr-1/base", headRef: "keiko-eval/pr-1/head" };

function view(): ReviewRunView {
  return {
    runId: "review-1",
    settlement: { kind: "complete" },
    candidateCount: 2,
    presentedFindings: [{ report: { file: "src/a.ts", startLine: 3, endLine: 4, title: "t" } }],
    runtimeCleanup: "unproven",
    stale: false,
    totals: {
      reviewer: { promptTokens: 1_000, completionTokens: 200, durationMs: 5_000 },
      counterChecker: { promptTokens: 400, completionTokens: 50, durationMs: 2_000 },
    },
  } as unknown as ReviewRunView;
}

function deps(start: () => Promise<unknown>): {
  readonly deps: UiHandlerDeps;
  readonly release: ReturnType<typeof vi.fn>;
  readonly started: unknown[];
} {
  const started: unknown[] = [];
  const release = vi.fn(() => Promise.resolve());
  const service = {
    start: (input: unknown): Promise<unknown> => {
      started.push(input);
      return start();
    },
    whenSettled: (): Promise<void> => Promise.resolve(),
    get: (): Promise<ReviewRunView> => Promise.resolve(view()),
  };
  return {
    deps: { reviewRunService: service, reviewRuntime: { release } } as unknown as UiHandlerDeps,
    release,
    started,
  };
}

describe("createGateReviewer", () => {
  it("runs a local-range review with the pair, releases the instance and keeps its record", async () => {
    const f = deps(() => Promise.resolve({ kind: "started", run: { runId: "review-1" } }));
    const reviewer = createGateReviewer(f.deps, MODELS);

    const { record } = await reviewer.review("pr-1", "/lab/keiko", REFS);

    expect(f.started[0]).toMatchObject({
      repositoryRoot: "/lab/keiko",
      request: { target: { kind: "local-range", ...REFS }, ...MODELS },
    });
    expect(f.release).toHaveBeenCalledWith("/lab/keiko", expect.any(String));
    expect(record).toMatchObject({
      caseKey: "pr-1",
      runId: "review-1",
      settlement: { kind: "complete" },
      refusal: null,
      candidateCount: 2,
      presentedCount: 1,
      runtimeCleanup: "unproven",
      reviewer: { promptTokens: 1_000, completionTokens: 200 },
      counterChecker: { promptTokens: 400, completionTokens: 50 },
    });
    expect(reviewer.records()).toEqual([record]);
  });

  it("records a refused start as a skipped review with its reason and no cost", async () => {
    const f = deps(() => Promise.resolve({ kind: "refused", reason: "model-unavailable" }));
    const reviewer = createGateReviewer(f.deps, MODELS);

    const { view: settled, record } = await reviewer.review("seed-x", "/lab/seed", REFS);

    expect(settled).toBeUndefined();
    expect(record).toMatchObject({
      runId: null,
      settlement: { kind: "skipped", reason: "model-unavailable" },
      refusal: "model-unavailable",
      reviewer: { promptTokens: 0, completionTokens: 0, durationMs: 0 },
    });
    expect(f.release).not.toHaveBeenCalled();
  });

  it("refuses a composition without a review run service", () => {
    expect(() => createGateReviewer({} as UiHandlerDeps, MODELS)).toThrow(/no review run service/u);
  });
});

describe("presented findings", () => {
  it("maps a view's presented findings to reports and code locations", () => {
    expect(presentedReports(view())).toHaveLength(1);
    expect(presentedLocations(view())).toEqual([{ file: "src/a.ts", startLine: 3, endLine: 4 }]);
    expect(presentedReports(undefined)).toEqual([]);
  });

  it("never lets the pipeline under test use the evaluation model port", async () => {
    await expect(
      UNUSED_EVALUATION_MODEL.call({} as never, new AbortController().signal),
    ).rejects.toThrow(/calls the gateway/u);
  });
});
