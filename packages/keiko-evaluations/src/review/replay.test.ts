// AC3 (Issue #4132): the replay refuses, with a typed error, a run that marks a holdout pull
// request as a tuning input — proven through `runReviewReplay`, the production entry point, with the
// real manifest boundary and the package's real offline model provider.

import { describe, expect, it } from "vitest";

import { createScriptedModelPort } from "../scripted-model.js";
import { REVIEW_EVALUATION_MANIFEST } from "./manifest.js";
import {
  ReviewHoldoutViolationError,
  reviewSplitOf,
  runReviewReplay,
  type ReviewReplayOptions,
} from "./replay.js";
import {
  dataset,
  finding,
  pullRequest,
  reviewResponse,
  scriptedReplayPort,
  thread,
} from "./_support.js";

const BOUNDARY = REVIEW_EVALUATION_MANIFEST.holdoutFromPullRequest;
const DEV_A = BOUNDARY - 2;
const DEV_B = BOUNDARY - 1;
const HOLDOUT = BOUNDARY;

const history = dataset([
  pullRequest(DEV_A, [thread({ id: "a-hit", regionChange: "changed" })]),
  pullRequest(DEV_B, [], { reviewedBy: ["human"] }),
  pullRequest(HOLDOUT, [
    thread({ id: "h-false", reply: { classification: "refuted", producer: "human" } }),
  ]),
]);

function transcripts(): ReadonlyMap<string, ReturnType<typeof reviewResponse>[]> {
  return new Map([
    [
      String(DEV_A),
      [
        reviewResponse([
          finding({ file: "src/a.ts", startLine: 11, endLine: 11 }),
          finding({ file: "src/z.ts", startLine: 1, endLine: 1 }, "security", "low"),
        ]),
      ],
    ],
    [
      String(HOLDOUT),
      [reviewResponse([finding({ file: "src/a.ts", startLine: 10, endLine: 10 })])],
    ],
  ]);
}

function options(
  overrides: Partial<ReviewReplayOptions>,
  calls: number[] = [],
): ReviewReplayOptions {
  let clock = 0;
  return {
    dataset: history,
    split: "development",
    purpose: "evaluation",
    tuningInputs: [],
    port: scriptedReplayPort(calls),
    model: { mode: "offline", modelId: "scripted-reviewer", transcripts: transcripts() },
    now: () => (clock += 250),
    ...overrides,
  };
}

describe("runReviewReplay holdout discipline", () => {
  it("places the manifest boundary in the holdout and everything before it in development", () => {
    expect(reviewSplitOf(BOUNDARY)).toBe("holdout");
    expect(reviewSplitOf(BOUNDARY - 1)).toBe("development");
  });

  it("refuses a run that marks a holdout pull request as a tuning input, before any review", async () => {
    const calls: number[] = [];
    const run = runReviewReplay(
      options({ purpose: "tuning", tuningInputs: [DEV_A, HOLDOUT] }, calls),
    );
    await expect(run).rejects.toBeInstanceOf(ReviewHoldoutViolationError);
    await expect(run).rejects.toMatchObject({
      code: "holdout-tuning-input",
      pullRequests: [HOLDOUT],
    });
    expect(calls).toEqual([]);
  });

  it("refuses a holdout tuning input on an evaluation run as well", async () => {
    await expect(
      runReviewReplay(options({ split: "holdout", tuningInputs: [HOLDOUT] })),
    ).rejects.toMatchObject({ name: "ReviewHoldoutViolationError", code: "holdout-tuning-input" });
  });

  it("refuses to tune on the holdout split", async () => {
    await expect(
      runReviewReplay(options({ split: "holdout", purpose: "tuning" })),
    ).rejects.toMatchObject({
      code: "holdout-tuning-run",
    });
  });

  it("refuses a development run that reaches into the holdout", async () => {
    await expect(
      runReviewReplay(options({ pullRequests: [DEV_A, HOLDOUT] })),
    ).rejects.toMatchObject({
      code: "split-mismatch",
      pullRequests: [HOLDOUT],
    });
  });

  it("refuses a pull request the dataset does not hold", async () => {
    await expect(runReviewReplay(options({ pullRequests: [BOUNDARY - 5] }))).rejects.toMatchObject({
      code: "unknown-pull-request",
    });
  });

  it("allows tuning on development inputs and records the inputs and the split", async () => {
    const run = await runReviewReplay(options({ purpose: "tuning", tuningInputs: [DEV_B, DEV_A] }));
    expect(run).toMatchObject({
      split: "development",
      purpose: "tuning",
      tuningInputs: [DEV_A, DEV_B],
      holdoutFromPullRequest: BOUNDARY,
      datasetDigest: history.digest,
      modelId: "scripted-reviewer",
    });
  });
});

describe("runReviewReplay scoring", () => {
  it("replays the split's pull requests with threads and scores findings by file and range", async () => {
    const calls: number[] = [];
    const run = await runReviewReplay(options({}, calls));
    expect(calls).toEqual([DEV_A]);
    expect(run.pullRequests).toHaveLength(1);
    expect(run.pullRequests[0]?.findings.map((entry) => entry.outcome)).toEqual([
      "hit",
      "unmatched",
    ]);
    expect(run.pullRequests[0]?.findings[0]?.matchedThreadIds).toEqual(["a-hit"]);
  });

  it("meters cost from the scripted model's reported usage and the injected clock", async () => {
    const run = await runReviewReplay(options({}));
    expect(run.pullRequests[0]?.cost).toEqual({
      modelCalls: 1,
      inputTokens: 100,
      outputTokens: 20,
      wallTimeMs: 250,
    });
  });

  it("evaluates the holdout split when asked to, and labels the run accordingly", async () => {
    const run = await runReviewReplay(options({ split: "holdout" }));
    expect(run.split).toBe("holdout");
    expect(run.pullRequests.map((entry) => entry.number)).toEqual([HOLDOUT]);
    expect(run.pullRequests[0]?.findings[0]?.outcome).toBe("false-alarm");
  });

  it("replays an explicitly selected pull request even without threads", async () => {
    const run = await runReviewReplay(
      options({
        pullRequests: [DEV_B],
        model: {
          mode: "offline",
          modelId: "scripted-reviewer",
          factory: () => createScriptedModelPort([reviewResponse([])]),
        },
      }),
    );
    expect(run.pullRequests).toEqual([
      expect.objectContaining({ number: DEV_B, findings: [], settlement: { kind: "complete" } }),
    ]);
  });
});
