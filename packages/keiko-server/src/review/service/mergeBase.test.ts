// R4130-008 through the run service's production entry point: a target whose base branch moved on
// after the head branched off is diffed from the merge base. Changes the base made later never
// appear as reverted or deleted by the head, while the rules file is still read from the base tip.

import { afterEach, expect, it } from "vitest";
import type { ReviewRunView } from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";

import { commitFile } from "../reviewFixtures.test-support.js";
import { handleReviewRunStart } from "../routes.js";
import {
  counterCheckBy,
  createReviewRunHarness,
  reviewerFiling,
  startBody,
  type ReviewRunHarness,
} from "./reviewRunHarness.test-support.js";

let harness: ReviewRunHarness | undefined;

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

async function reviewedRun(h: ReviewRunHarness): Promise<ReviewRunView> {
  const query = `?root=${encodeURIComponent(h.repo)}`;
  const started = await handleReviewRunStart(
    h.ctx(`/api/git-review/runs${query}`, { body: startBody() }),
    h.deps(),
  );
  const runId = (started.body as { readonly run: ReviewRunView }).run.runId;
  await h.service.whenSettled(runId);
  const view = await h.service.get(runId);
  if (view === undefined) throw new TypeError("run missing");
  return view;
}

it("diffs from the merge base and reads the rules from the base tip", async () => {
  const h = createReviewRunHarness({
    runtime: reviewerFiling([]),
    counterCheck: counterCheckBy({}),
  });
  harness = h;
  // `main` moves on after `topic` branched off it at the fixture's base commit.
  const baseTip = commitFile(h.repo, "src/later.ts", "export const later = 1;\n", "later");
  const view = await reviewedRun(h);
  expect(view.settlement).toEqual({ kind: "complete" });
  expect(view.coverageEntries.map((entry) => entry.path).sort()).toEqual([
    "src/total.ts",
    "src/util.ts",
  ]);
  expect(view.baseSha).toBe(h.baseSha);
  expect(h.runtimeRequests.map((request) => request.baseSha)).toEqual([baseTip]);
});
