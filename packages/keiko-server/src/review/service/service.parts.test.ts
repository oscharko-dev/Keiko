// A review whose diff package has several parts (Issue #4130), through the production entry point
// `POST /api/git-review/runs`: one Reviewer session per part, their candidates merged, and the run
// settled from every part's outcome.

import { afterEach, describe, expect, it } from "vitest";
import { countContextTokens } from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import {
  REVIEW_COUNTER_CHECK_DEFAULT_RUN_PROMPT_TOKENS,
  type ReviewRunView,
} from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";

import type { ReviewRuntimeRunRequest, ReviewRuntimeRunResult } from "../runtime/instance.js";
import { handleReviewRunStart } from "../routes.js";
import { reviewDiffBudgetTokens } from "./budget.js";
import {
  counterCheckBy,
  createReviewRunHarness,
  reportAt,
  reviewerFiling,
  startBody,
  type HarnessOptions,
  type ReviewRunHarness,
  type RuntimeScript,
} from "./reviewRunHarness.test-support.js";

let harness: ReviewRunHarness | undefined;

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

/** A new TypeScript file of `lines` distinct declarations: one hunk of about 10k tokens. */
function generated(
  name: string,
  lines: number,
): { readonly path: string; readonly content: string } {
  const body = Array.from(
    { length: lines },
    (_, index) => `export const ${name}_${String(index).padStart(4, "0")} = ${String(index)};\n`,
  ).join("");
  return { path: `src/${name}.ts`, content: body };
}

/** Two generated files that together exceed one part, so the package has two parts. */
const TWO_PARTS: HarnessOptions["topicFiles"] = [generated("alpha", 900), generated("beta", 900)];

async function review(options: HarnessOptions): Promise<{
  readonly h: ReviewRunHarness;
  readonly view: ReviewRunView;
}> {
  const h = createReviewRunHarness({ topicFiles: TWO_PARTS, ...options });
  harness = h;
  const query = `?root=${encodeURIComponent(h.repo)}`;
  const result = await handleReviewRunStart(
    h.ctx(`/api/git-review/runs${query}`, { body: startBody() }),
    h.deps(),
  );
  expect(result.status).toBe(202);
  const runId = (result.body as { readonly run: ReviewRunView }).run.runId;
  await h.service.whenSettled(runId);
  const view = await h.service.get(runId);
  if (view === undefined) throw new TypeError("run missing");
  return { h, view };
}

/** A Reviewer scripted per part: the script for the part's index, or the last one. */
function perPart(...scripts: readonly RuntimeScript[]): RuntimeScript {
  return (request, h) => {
    const script = scripts[Math.min(request.diffPart?.index ?? 0, scripts.length - 1)];
    if (script === undefined) throw new TypeError("no script");
    return script(request, h);
  };
}

const refused: RuntimeScript = () =>
  Promise.resolve<ReviewRuntimeRunResult>({ ok: false, reason: "runtime-unavailable" });

function parts(h: ReviewRunHarness): readonly ReviewRuntimeRunRequest[] {
  return h.runtimeRequests;
}

/** A counter-check that reserves `promptTokens` of the run's allowance before it confirms. */
function reserving(promptTokens: number): NonNullable<HarnessOptions["counterCheck"]> {
  const confirm = counterCheckBy({ 3: "confirmed", 10: "confirmed" });
  const refuse = counterCheckBy({}, "budget-exhausted");
  return (input) => (input.budget.reserve(promptTokens) ? confirm(input) : refuse(input));
}

/** More than half of one part's counter-check allowance: two such checks exceed it. */
const OVER_HALF_ALLOWANCE = Math.floor(REVIEW_COUNTER_CHECK_DEFAULT_RUN_PROMPT_TOKENS / 2) + 1;

function counterCheckingLine(h: ReviewRunHarness): Readonly<Record<string, unknown>> | undefined {
  return h.log.withOp("review.run.phase").find((event) => event.extra?.phase === "counter-checking")
    ?.extra;
}

describe("a review in several parts (Issue #4130)", () => {
  it("reviews each part in its own session and merges the candidates once each", async () => {
    const { h, view } = await review({
      runtime: perPart(
        reviewerFiling([reportAt(3, "high")]),
        reviewerFiling([reportAt(3, "high"), reportAt(10, "medium")]),
      ),
      counterCheck: counterCheckBy({ 3: "confirmed", 10: "confirmed" }),
    });
    expect(view.settlement).toEqual({ kind: "complete" });
    const requests = parts(h);
    expect(requests.map((request) => request.diffPart)).toEqual([
      { index: 0, count: 2 },
      { index: 1, count: 2 },
    ]);
    const budget = reviewDiffBudgetTokens(h.baseSha, requests[0]?.headSha ?? "");
    for (const request of requests) {
      expect(countContextTokens(request.diffPackageText)).toBeLessThanOrEqual(budget);
    }
    expect(requests[0]?.diffPackageText).not.toBe(requests[1]?.diffPackageText);
    // The duplicate of line 3 is one candidate; both are counter-checked.
    expect(h.counterInputs.map((input) => input.candidate.report.startLine).sort()).toEqual([
      10, 3,
    ]);
    expect(view.coverage).toMatchObject({ unprocessedFiles: 0, partiallyReviewedFiles: 0 });
    // The Reviewer's totals add up every part's session.
    const [settledLine] = h.log.withOp("review.run.settled");
    expect(settledLine?.extra).toMatchObject({ reviewerPromptTokens: 2 * 4_321 });
  });

  it("records each part's session and the part count on the Activity Log", async () => {
    const { h } = await review({});
    const reviewing = h.log
      .withOp("review.run.phase")
      .find((event) => event.extra?.phase === "reviewing");
    expect(reviewing?.extra).toMatchObject({ partCount: 2 });
    const lines = h.log.withOp("review.run.part");
    expect(lines.map((event) => event.extra)).toMatchObject([
      { partNumber: 1, partCount: 2, outcome: "completed", candidateCount: 0 },
      { partNumber: 2, partCount: 2, outcome: "completed", candidateCount: 0 },
    ]);
    for (const event of lines) expect(event.level).toBe("info");
  });

  it("runs the remaining parts after a failed part and settles on its reason", async () => {
    const { h, view } = await review({
      runtime: perPart(
        reviewerFiling([reportAt(3, "high")], "failed", "prompt-allowance-exhausted"),
        reviewerFiling([reportAt(10, "medium")]),
      ),
      counterCheck: counterCheckBy({ 3: "confirmed", 10: "confirmed" }),
    });
    expect(parts(h)).toHaveLength(2);
    expect(view.settlement).toEqual({ kind: "incomplete", reason: "budget-exhausted" });
    // The failed part's candidate is still counter-checked, like a failed single-part Reviewer's.
    expect(h.counterInputs).toHaveLength(2);
    expect(h.log.withOp("review.run.part").map((event) => event.extra)).toMatchObject([
      { partNumber: 1, outcome: "failed", reason: "budget-exhausted" },
      { partNumber: 2, outcome: "completed" },
    ]);
  });

  it("settles a later part's refusal as a failed Reviewer and starts no further part", async () => {
    const { h, view } = await review({
      runtime: perPart(reviewerFiling([reportAt(3, "high")]), refused),
      counterCheck: counterCheckBy({ 3: "confirmed" }),
    });
    expect(parts(h)).toHaveLength(2);
    expect(view.settlement).toEqual({ kind: "incomplete", reason: "model-failed" });
    expect(h.counterInputs).toHaveLength(1);
    expect(h.log.withOp("review.run.part").at(-1)?.extra).toMatchObject({
      partNumber: 2,
      outcome: "refused",
      reason: "model-unavailable",
    });
  });

  it("skips the run when its first part is refused, as a single-part review is", async () => {
    const { h, view } = await review({ runtime: refused });
    expect(parts(h)).toHaveLength(1);
    expect(view.settlement).toEqual({ kind: "skipped", reason: "model-unavailable" });
  });

  it("gives the counter-checks the run allowance once for each part", async () => {
    const { h, view } = await review({
      runtime: perPart(
        reviewerFiling([reportAt(3, "high")]),
        reviewerFiling([reportAt(10, "medium")]),
      ),
      counterCheck: reserving(OVER_HALF_ALLOWANCE),
    });
    // Both checks together exceed one part's allowance and fit in two.
    expect(h.counterInputs).toHaveLength(2);
    expect(view.settlement).toEqual({ kind: "complete" });
    expect(view.presentedFindings).toHaveLength(2);
    expect(counterCheckingLine(h)).toMatchObject({
      candidateCount: 2,
      counterCheckRunPromptAllowance: 2 * REVIEW_COUNTER_CHECK_DEFAULT_RUN_PROMPT_TOKENS,
    });
  });

  it("keeps a single-part review at one run allowance for its counter-checks", async () => {
    const { h, view } = await review({
      topicFiles: [],
      runtime: reviewerFiling([reportAt(3, "high"), reportAt(10, "medium")]),
      counterCheck: reserving(OVER_HALF_ALLOWANCE),
    });
    expect(view.settlement).toEqual({ kind: "incomplete", reason: "budget-exhausted" });
    expect(view.presentedFindings).toHaveLength(1);
    expect(counterCheckingLine(h)).toMatchObject({
      counterCheckRunPromptAllowance: REVIEW_COUNTER_CHECK_DEFAULT_RUN_PROMPT_TOKENS,
    });
  });

  it("gives a single-part review no part line in its task", async () => {
    const { h, view } = await review({ topicFiles: [] });
    expect(view.settlement).toEqual({ kind: "complete" });
    expect(parts(h)).toHaveLength(1);
    expect(parts(h)[0]?.diffPart).toBeUndefined();
  });
});
