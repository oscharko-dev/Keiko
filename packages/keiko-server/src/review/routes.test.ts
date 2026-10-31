// The review run progress stream and the run's Activity Log reconstruction (Issue #4136, AC6, AC7).
// The stream writes through the shared SSE flow control: a `false` write is buffer accounting, not
// a dead reader, so no frame size ends it; it carries phases and counts only, never candidate
// content, and closes after the one `settled` event. The run is reconstructed from its own
// persisted lines with the support analyzer's `analyzeLogText` by its correlation id.

import type { ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { ReviewRunEvent } from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";
import { analyzeLogText } from "@oscharko-dev/keiko-activity-log/reader";
import { createGitReviewProcessRunner } from "@oscharko-dev/keiko-git";

import { formatActivityLogProofLine } from "../../../../tests/support/activity-log-proof.js";
import { STREAMING } from "../routes.js";
import { counterCheckCandidate } from "./counter-check/counterCheck.js";
import { handleReviewRunEvents, handleReviewRunStart } from "./routes.js";
import { FakeSseResponse, sseEvents } from "./sseResponse.test-support.js";
import {
  counterCheckBy,
  createReviewRunHarness,
  reportAt,
  reviewerFiling,
  startBody,
  type ReviewRunHarness,
  type RuntimeScript,
} from "./service/reviewRunHarness.test-support.js";

let harness: ReviewRunHarness | undefined;

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

function events(response: FakeSseResponse): ReviewRunEvent[] {
  return sseEvents<ReviewRunEvent>(response, "review");
}

describe("GET /api/git-review/runs/{runId}/events (AC6)", () => {
  it("streams phases and counts without candidate content, then one settled event", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const filing = reviewerFiling([reportAt(3, "high")]);
    const runtime: RuntimeScript = async (request, h) => {
      await gate;
      return filing(request, h);
    };
    const h = createReviewRunHarness({ runtime, counterCheck: counterCheckBy({ 3: "confirmed" }) });
    harness = h;
    const query = `?root=${encodeURIComponent(h.repo)}`;
    const started = await handleReviewRunStart(
      h.ctx(`/api/git-review/runs${query}`, { body: startBody() }),
      h.deps(),
    );
    const runId = (started.body as { run: { runId: string } }).run.runId;
    const response = new FakeSseResponse();
    // Node buffers every frame above its high-water mark; the stream must keep going regardless.
    response.accept = false;
    const outcome = await handleReviewRunEvents(
      h.ctx(`/api/git-review/runs/${runId}/events`, {
        params: { runId },
        res: response as unknown as ServerResponse,
      }),
      h.deps(),
    );
    expect(outcome).toBe(STREAMING);
    release();
    await h.service.whenSettled(runId);
    const received = events(response);
    expect(received.at(-1)).toMatchObject({
      kind: "settled",
      settlement: { kind: "complete" },
      presentedCount: 1,
    });
    expect(received.slice(0, -1).every((event) => event.kind === "phase")).toBe(true);
    expect(received.map((event) => (event.kind === "phase" ? event.phase : "settled"))).toEqual(
      expect.arrayContaining(["reviewing", "counter-checking", "settling", "settled"]),
    );
    const content = response.frames.join("");
    expect(content).not.toContain("Finding at 3");
    expect(content).not.toContain("src/total.ts");
    expect(response.writableEnded).toBe(true);
    expect(response.destroyed).toBe(false);

    const replay = new FakeSseResponse();
    await handleReviewRunEvents(
      h.ctx(`/api/git-review/runs/${runId}/events`, {
        params: { runId },
        res: replay as unknown as ServerResponse,
      }),
      h.deps(),
    );
    expect(events(replay)).toEqual([
      expect.objectContaining({ kind: "settled", presentedCount: 1 }),
    ]);
    expect(replay.writableEnded).toBe(true);
  });

  it("answers 404 for an unknown run", async () => {
    const h = createReviewRunHarness();
    harness = h;
    const result = await handleReviewRunEvents(
      h.ctx("/api/git-review/runs/nope/events", { params: { runId: "nope" } }),
      h.deps(),
    );
    expect(result).toMatchObject({ status: 404 });
  });
});

describe("review run reconstruction from the Activity Log (AC7)", () => {
  it("rebuilds the run and its counter-checks from the lines of its correlation id", async () => {
    const h = createReviewRunHarness({
      runtime: reviewerFiling([reportAt(3, "high")]),
      // The real counter-check with no model: it records its failure under the run.
      counterCheck: (input) =>
        counterCheckCandidate(
          {
            modelPortFactory: () => undefined,
            runner: () => createGitReviewProcessRunner(),
            activityLog: harness?.log.sink ?? { write: (): void => undefined },
          },
          input,
        ),
    });
    harness = h;
    const query = `?root=${encodeURIComponent(h.repo)}`;
    const started = await handleReviewRunStart(
      h.ctx(`/api/git-review/runs${query}`, { body: startBody() }),
      h.deps(),
    );
    const runId = (started.body as { run: { runId: string } }).run.runId;
    await h.service.whenSettled(runId);
    const text = h.log.events.map((event) => formatActivityLogProofLine(event)).join("\n");
    const analysis = analyzeLogText(text);
    const run = analysis.timelines.find((timeline) => timeline.correlationId === "corr-review-run");
    const ops = run?.lines.map((line) => line.op) ?? [];
    expect(ops).toEqual(
      expect.arrayContaining(["review.run.started", "review.run.phase", "review.run.settled"]),
    );
    expect(ops.indexOf("review.run.started")).toBeLessThan(ops.indexOf("review.run.settled"));
    const settled = run?.lines.find((line) => line.op === "review.run.settled");
    expect(settled?.extra).toMatchObject({
      settlement: "incomplete",
      reason: "model-failed",
      candidateCount: 1,
    });
    // The analyzer joins each counter-check session to its run through `parentCorrelationId`.
    expect(ops).toEqual(expect.arrayContaining(["review.counter-check.completed"]));
    const checks = analysis.timelines.filter((timeline) =>
      timeline.correlationId.startsWith("review-counter-check-"),
    );
    expect(checks).toHaveLength(1);
    expect(checks[0]?.lines.every((line) => line.parentCorrelationId === "corr-review-run")).toBe(
      true,
    );
  });
});
