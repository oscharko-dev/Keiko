// The pair qualification routes (Issue #4137) through `POST /api/git-review/pair-qualifications`,
// the production entry point a live qualification is driven through: the policy check in front,
// the progress stream over the shared SSE helper, cancellation, and the qualification's
// reconstruction from its own persisted Activity Log lines (AC6).

import type { ServerResponse } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { TOOL_CALLING_VERIFICATION_MAX_AGE_MS } from "@oscharko-dev/keiko-contracts/runtime/gateway";

import { analyzeLogText } from "@oscharko-dev/keiko-activity-log/reader";
import type { ReviewPairQualificationEvent } from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";
import { createGitReviewProcessRunner } from "@oscharko-dev/keiko-git";

import { formatActivityLogProofLine } from "../../../../../tests/support/activity-log-proof.js";
import type { UiHandlerDeps } from "../../index.js";
import { STREAMING, type RouteResult } from "../../routes.js";
import { reviewGatewayConfig } from "../policy/policyFixtures.test-support.js";
import {
  capability,
  createReviewRunHarness,
  reviewerFiling,
  type ReviewRunHarness,
} from "../service/reviewRunHarness.test-support.js";
import { FakeSseResponse, sseEvents } from "../sseResponse.test-support.js";
import { ReviewPairStatusRegistry } from "./pairStatus.js";
import {
  handlePairQualificationCancel,
  handlePairQualificationEvents,
  handlePairQualificationGet,
  handlePairQualificationStart,
} from "./routes.js";
import { REVIEW_SEED_CORPUS } from "./seed-corpus/index.js";
import { createPairQualificationService, type PairQualificationService } from "./service.js";

const MODELS = [capability("reviewer-model"), capability("checker-model")];
const PAIR = { reviewerModelId: "reviewer-model", counterCheckerModelId: "checker-model" };
const BASE = "/api/git-review/pair-qualifications";

interface RouteFixture {
  readonly h: ReviewRunHarness;
  readonly service: PairQualificationService;
  readonly deps: UiHandlerDeps;
}

let current: RouteFixture | undefined;
afterEach(async () => {
  await current?.service.dispose();
  await current?.h.cleanup();
  current = undefined;
});

/** A pair's model whose tool-call proof was verified and is older than its lifetime. */
function lapsed(id: string): ReturnType<typeof capability> {
  const fresh = capability(id);
  const verification = fresh.toolCallingVerification;
  if (verification === undefined) throw new TypeError("expected a verified fixture capability");
  const checkedAt = new Date(Date.now() - TOOL_CALLING_VERIFICATION_MAX_AGE_MS - 60_000);
  return {
    ...fresh,
    toolCallingVerification: { ...verification, checkedAt: checkedAt.toISOString() },
  };
}

function setUp(
  review: unknown,
  models: readonly ReturnType<typeof capability>[] = MODELS,
): RouteFixture {
  const h = createReviewRunHarness({ runtime: reviewerFiling([]) });
  const pairStatus = new ReviewPairStatusRegistry();
  const service = createPairQualificationService({
    runs: () => h.service,
    runner: () => createGitReviewProcessRunner(),
    root: `${h.fixture.root}/review-qualification`,
    pairStatus,
    activityLog: h.log.sink,
    corpus: REVIEW_SEED_CORPUS.slice(0, 2),
  });
  const deps: UiHandlerDeps = {
    ...h.deps(),
    config: reviewGatewayConfig(models, review),
    activityLog: h.log.sink,
    reviewPolicy: { settings: undefined, pairStatus, qualifications: service },
  };
  current = { h, service, deps };
  return current;
}

function idOf(result: RouteResult): string {
  return (result.body as { readonly qualification: { readonly qualificationId: string } })
    .qualification.qualificationId;
}

// R4130-058: each run of a qualification renews a lapsed tool-call proof at its launch, but the
// start route judged the stored proof and refused the pair, so a pair could not be qualified on a
// server that had run for more than 24 hours.
describe("POST /api/git-review/pair-qualifications with a lapsed tool-call proof", () => {
  const AGED = [lapsed("reviewer-model"), capability("checker-model")];

  /** A renewal that answers like the gateway: the asked model's proof is current afterwards. */
  function renewing(f: RouteFixture, review: unknown): string[] {
    const asked: string[] = [];
    Object.assign(f.deps, {
      reviewPolicy: {
        ...f.deps.reviewPolicy,
        renewToolProof: (modelId: string): Promise<void> => {
          asked.push(modelId);
          Object.assign(f.deps, { config: reviewGatewayConfig(MODELS, review) });
          return Promise.resolve();
        },
      },
    });
    return asked;
  }

  it("renews the proof of an admitted pair and then starts the qualification", async () => {
    const review = { enabled: true };
    const f = setUp(review, AGED);
    const asked = renewing(f, review);
    const started = await handlePairQualificationStart(f.h.ctx(BASE, { body: PAIR }), f.deps);
    expect(asked).toEqual(["reviewer-model"]);
    expect(started.status).toBe(202);
    await f.service.whenSettled(idOf(started));
  });

  it("refused the same pair while nothing renewed the proof", async () => {
    const f = setUp({ enabled: true }, AGED);
    const result = await handlePairQualificationStart(f.h.ctx(BASE, { body: PAIR }), f.deps);
    expect(result.body).toMatchObject({ reason: "tool-verification-stale", role: "reviewer" });
    expect(f.h.runtimeRequests).toEqual([]);
  });

  // R4130-003: a pair the policy refuses receives no traffic, not even a probe.
  it("asks nothing for a pair the policy refuses", async () => {
    const review = { enabled: true, allowedReviewModelIds: ["checker-model"] };
    const f = setUp(review, AGED);
    const asked = renewing(f, review);
    const result = await handlePairQualificationStart(f.h.ctx(BASE, { body: PAIR }), f.deps);
    expect(result.body).toMatchObject({ reason: "outside-allowlist", role: "reviewer" });
    expect(asked).toEqual([]);
  });
});

describe("POST /api/git-review/pair-qualifications", () => {
  it("refuses a pair outside the allowlist before anything runs", async () => {
    const f = setUp({ enabled: true, allowedReviewModelIds: ["reviewer-model"] });
    const result = await handlePairQualificationStart(f.h.ctx(BASE, { body: PAIR }), f.deps);
    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({ reason: "outside-allowlist", role: "counter-checker" });
    expect(f.h.log.withOp("review.model-policy.refused")).toMatchObject([
      { extra: { reason: "outside-allowlist", stage: "qualification" } },
    ]);
    expect(f.h.runtimeRequests).toEqual([]);
    const malformed = await handlePairQualificationStart(
      f.h.ctx(BASE, { body: { ...PAIR, swapRoles: true } }),
      f.deps,
    );
    expect(malformed.status).toBe(400);
  });

  it("runs a qualification, streams its progress and is reconstructable from the log", async () => {
    const f = setUp({ enabled: true });
    const started = await handlePairQualificationStart(f.h.ctx(BASE, { body: PAIR }), f.deps);
    expect(started.status).toBe(202);
    const id = idOf(started);
    const response = new FakeSseResponse();
    const outcome = await handlePairQualificationEvents(
      f.h.ctx(`${BASE}/${id}/events`, {
        params: { qualificationId: id },
        res: response as unknown as ServerResponse,
      }),
      f.deps,
    );
    expect(outcome).toBe(STREAMING);
    await f.service.whenSettled(id);
    const frames = sseEvents<ReviewPairQualificationEvent>(response, "pair-qualification");
    expect(frames[0]).toMatchObject({ kind: "progress", totalCases: 2 });
    expect(frames.at(-1)).toMatchObject({ kind: "settled", outcome: "seed-failed" });
    expect(response.writableEnded).toBe(true);

    const view = handlePairQualificationGet(
      f.h.ctx(`${BASE}/${id}`, { params: { qualificationId: id } }),
      f.deps,
    );
    expect(view.body).toMatchObject({ state: "settled", outcome: "seed-failed" });
    expect(
      handlePairQualificationCancel(
        f.h.ctx(`${BASE}/${id}/cancel`, { params: { qualificationId: id } }),
        f.deps,
      ).status,
    ).toBe(409);

    const text = f.h.log.events.map((event) => formatActivityLogProofLine(event)).join("\n");
    const timeline = analyzeLogText(text).timelines.find(
      (entry) => entry.correlationId === "corr-review-run",
    );
    const ops = timeline?.lines.map((line) => line.op) ?? [];
    expect(ops[0]).toBe("review.pair-qualification.started");
    expect(ops).toEqual(
      expect.arrayContaining([
        "review.run.started",
        "review.run.settled",
        "review.pair-qualification.case-scored",
        "review.pair-qualification.completed",
      ]),
    );
    expect(ops.at(-1)).toBe("review.pair-qualification.completed");
  }, 60_000);

  it("answers 404 for an unknown qualification", () => {
    const f = setUp({ enabled: true });
    const result = handlePairQualificationGet(
      f.h.ctx(`${BASE}/missing`, { params: { qualificationId: "missing" } }),
      f.deps,
    );
    expect(result.status).toBe(404);
  });
});
