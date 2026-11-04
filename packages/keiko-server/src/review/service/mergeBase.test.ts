// R4130-008 through the run service's production entry point: a target whose base branch moved on
// after the head branched off is diffed from the merge base. Changes the base made later never
// appear as reverted or deleted by the head, while the rules file is still read from the base tip.

import { afterEach, expect, it } from "vitest";
import type { ReviewRunView } from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";

import { commitFile, git } from "../reviewFixtures.test-support.js";
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

function start(h: ReviewRunHarness, body = startBody()): ReturnType<typeof handleReviewRunStart> {
  const query = `?root=${encodeURIComponent(h.repo)}`;
  return handleReviewRunStart(h.ctx(`/api/git-review/runs${query}`, { body }), h.deps());
}

async function reviewedRun(h: ReviewRunHarness): Promise<ReviewRunView> {
  const started = await start(h);
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

// R4130-035: the dry run counts the lines the run would review, from the same merge base.
it("estimates a dry run from the merge base after the base moved on", async () => {
  const h = createReviewRunHarness();
  harness = h;
  const before = await start(h, startBody({ dryRun: true }));
  expect(before.body).toMatchObject({ kind: "dry-run" });
  const expected = (before.body as { readonly estimate: { readonly changedLines: number } })
    .estimate.changedLines;
  commitFile(h.repo, "src/later.ts", "one\ntwo\nthree\n", "later");
  const after = await start(h, startBody({ dryRun: true }));
  expect(after.status).toBe(200);
  expect(after.body).toMatchObject({ kind: "dry-run", estimate: { changedLines: expected } });
});

it("refuses a dry run whose head shares no history with its base", async () => {
  const h = createReviewRunHarness();
  harness = h;
  git(h.repo, "checkout", "-q", "--orphan", "unrelated");
  commitFile(h.repo, "other.ts", "export const other = 1;\n", "unrelated root");
  git(h.repo, "checkout", "-q", "main");
  const body = startBody({
    dryRun: true,
    target: { kind: "local-range", baseRef: "main", headRef: "unrelated" },
  });
  const refused = await start(h, body);
  expect(refused.body).not.toMatchObject({ kind: "dry-run" });
  expect(h.log.events.find((event) => event.op === "review.run.refused")).toMatchObject({
    extra: { reason: "request-invalid", dryRun: true },
  });
});
