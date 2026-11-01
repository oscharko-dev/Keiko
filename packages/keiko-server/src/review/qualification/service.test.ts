// The local pair qualification through the real review orchestrator (Issue #4137, AC4, AC5, AC6):
// the shipped seed corpus is materialized as Git repositories and reviewed by the real run service
// (target resolver, hardened worktree, diff package, finding intake, settlement, presentation) with
// a scripted pair at the coding-runtime seam. A pair that files every planted defect qualifies; one
// that misses a required seed fails naming its class; a cancellation leaves no seed repository.

import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  CounterCheckVerdict,
  ReviewFindingReport,
  ReviewPairQualificationEvent,
} from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";
import { createGitReviewProcessRunner } from "@oscharko-dev/keiko-git";

import type { CounterCheckInput, CounterCheckOutcome } from "../counter-check/counterCheck.js";
import { createReviewFindingIntake } from "../runtime/findingIntake.js";
import {
  createReviewRunHarness,
  reviewerUntilCancelled,
  type ReviewRunHarness,
  type RuntimeScript,
} from "../service/reviewRunHarness.test-support.js";
import { ReviewPairStatusRegistry } from "./pairStatus.js";
import { REVIEW_SEED_CORPUS, type ReviewSeedDefectKind } from "./seed-corpus/index.js";
import { createPairQualificationService, type PairQualificationService } from "./service.js";

const MODELS = { reviewerModelId: "reviewer-model", counterCheckerModelId: "checker-model" };

/** A Reviewer that files each planted defect at its expected range, except the skipped kinds. */
function seedReviewer(skip: readonly ReviewSeedDefectKind[] = []): RuntimeScript {
  return async (request, harness) => {
    const entry = REVIEW_SEED_CORPUS[Number(basename(request.repositoryRoot))];
    const intake = createReviewFindingIntake({
      runId: request.reviewRunId,
      worktreeRoot: request.worktreeRoot,
      headSha: request.headSha,
      runner: createGitReviewProcessRunner(),
      activityLog: harness.log.sink,
    });
    const seed = entry?.seed;
    const skipped = entry !== undefined && skip.includes(entry.kind as ReviewSeedDefectKind);
    if (seed !== undefined && !seed.cleanControl && !skipped) {
      const report: ReviewFindingReport = {
        ...seed.expected,
        title: "Planted defect",
        condition: "condition",
        mechanism: "mechanism",
        consequence: "consequence",
        remedy: "remedy",
        category: seed.seedClass,
        severity: "high",
        evidence: [{ ...seed.expected, role: "defect" }],
      };
      await intake.submit(report);
    }
    return {
      ok: true,
      outcome: "completed",
      effort: { promptTokens: 1_000, completionTokens: 120, modelTurns: 2 },
      rules: "absent",
      candidates: intake.candidates(),
      rejections: intake.rejections(),
    };
  };
}

/** A Counter-checker that confirms every candidate with its own reported location. */
function confirmAll(input: CounterCheckInput): Promise<CounterCheckOutcome> {
  const report = input.candidate.report;
  const verdict: CounterCheckVerdict = {
    findingFingerprint: input.candidate.fingerprint,
    verdict: "confirmed",
    reasonCode: "defect-reproduced-in-code",
    evidence: [
      { file: report.file, startLine: report.startLine, endLine: report.endLine, role: "defect" },
    ],
  };
  return Promise.resolve({
    verdict,
    evidenceInHead: true,
    effect: "none",
    toolCallCount: 2,
    durationMs: 5,
    promptTokens: 300,
    completionTokens: 10,
  });
}

interface QualificationFixture {
  readonly h: ReviewRunHarness;
  readonly service: PairQualificationService;
  readonly pairStatus: ReviewPairStatusRegistry;
  readonly root: string;
}

let current: QualificationFixture | undefined;
afterEach(async () => {
  await current?.service.dispose();
  await current?.h.cleanup();
  current = undefined;
});

function setUp(runtime: RuntimeScript): QualificationFixture {
  const h = createReviewRunHarness({ runtime, counterCheck: confirmAll });
  const pairStatus = new ReviewPairStatusRegistry();
  const root = join(h.fixture.root, "review-qualification");
  const service = createPairQualificationService({
    runs: () => h.service,
    runner: () => createGitReviewProcessRunner(),
    root,
    pairStatus,
    activityLog: h.log.sink,
  });
  current = { h, service, pairStatus, root };
  return current;
}

async function qualify(f: QualificationFixture, generation = 7): Promise<string> {
  const started = f.service.start({
    models: MODELS,
    generation,
    correlationId: "corr-pair-qualification",
  });
  if (started.kind !== "started") throw new TypeError("qualification refused");
  const id = started.qualification.qualificationId;
  await f.service.whenSettled(id);
  return id;
}

describe("local pair qualification (AC4)", () => {
  it("qualifies a pair that finds every required seed and removes every seed repository", async () => {
    const f = setUp(seedReviewer());
    const events: ReviewPairQualificationEvent[] = [];
    const started = f.service.start({
      models: MODELS,
      generation: 7,
      correlationId: "corr-pair-qualification",
    });
    if (started.kind !== "started") throw new TypeError("qualification refused");
    const id = started.qualification.qualificationId;
    f.service.subscribe(id, { onEvent: (event) => events.push(event), onClose: () => undefined });
    await f.service.whenSettled(id);

    const view = f.service.get(id);
    expect(view).toMatchObject({
      state: "settled",
      outcome: "seed-qualified",
      configurationGeneration: 7,
      missedSeedClasses: [],
      score: {
        defectCaseCount: 9,
        cleanControlCount: 3,
        requiredFound: 9,
        missed: 0,
        falseAlarms: 0,
      },
    });
    expect(view?.cases.every((entry) => entry.result === "found" || entry.result === "clean")).toBe(
      true,
    );
    expect(view?.totals.reviewer.promptTokens).toBe(12_000);
    expect(f.h.runtimeRequests).toHaveLength(REVIEW_SEED_CORPUS.length);
    expect(existsSync(f.root) ? readdirSync(f.root) : []).toEqual([]);
    expect(events.at(-1)).toMatchObject({ kind: "settled", outcome: "seed-qualified" });
    expect(f.pairStatus.status({ ...MODELS, generation: 7 })).toMatchObject({
      status: "seed-qualified",
      qualificationId: id,
    });
    const scored = f.h.log.withOp("review.pair-qualification.case-scored");
    expect(scored).toHaveLength(REVIEW_SEED_CORPUS.length);
    expect(f.h.log.withOp("review.pair-qualification.completed")).toMatchObject([
      {
        correlationId: "corr-pair-qualification",
        extra: { outcome: "seed-qualified", requiredFound: 9 },
      },
    ]);
    // Every seed case's review run joins the qualification's timeline.
    expect(
      f.h.log
        .withOp("review.run.started")
        .every((event) => event.correlationId === "corr-pair-qualification"),
    ).toBe(true);
  }, 120_000);

  it("fails a pair that misses one required seed and names the seed class", async () => {
    const f = setUp(seedReviewer(["missing-await"]));
    const id = await qualify(f);
    const view = f.service.get(id);
    expect(view).toMatchObject({
      outcome: "seed-failed",
      missedSeedClasses: ["concurrency"],
      score: { requiredFound: 8, missed: 1 },
    });
    expect(view?.cases.find((entry) => entry.caseId === "synthetic-missing-await")?.result).toBe(
      "missed",
    );
    expect(f.pairStatus.status({ ...MODELS, generation: 7 }).status).toBe("seed-failed");
    expect(f.h.log.withOp("review.pair-qualification.completed")).toMatchObject([
      { level: "warn", extra: { outcome: "seed-failed", missedSeedClassCount: 1 } },
    ]);
  }, 120_000);

  it("cancels without leaving a fixture repository behind or recording a status", async () => {
    const f = setUp(reviewerUntilCancelled);
    const started = f.service.start({
      models: MODELS,
      generation: 7,
      correlationId: "corr-pair-qualification",
    });
    if (started.kind !== "started") throw new TypeError("qualification refused");
    const id = started.qualification.qualificationId;
    await vi.waitFor(() => {
      expect(f.h.runtimeRequests).toHaveLength(1);
    });
    expect(existsSync(join(f.root, id, "0"))).toBe(true);
    expect(f.service.cancel(id)).toBe("cancelling");
    await f.service.whenSettled(id);

    expect(f.service.get(id)?.outcome).toBe("cancelled");
    expect(existsSync(join(f.root, id))).toBe(false);
    expect(f.h.runtimeRequests).toHaveLength(1);
    expect(f.pairStatus.status({ ...MODELS, generation: 7 }).status).toBe("unmeasured");
    expect(f.h.log.withOp("review.pair-qualification.failed")).toMatchObject([
      { errorKind: "cancelled", extra: { reason: "cancelled", scoredCases: 0 } },
    ]);
    expect(f.service.cancel(id)).toBe("settled");
  }, 60_000);

  it("runs one qualification at a time", () => {
    const f = setUp(reviewerUntilCancelled);
    const first = f.service.start({
      models: MODELS,
      generation: 7,
      correlationId: "corr-qualification-a",
    });
    expect(first.kind).toBe("started");
    expect(
      f.service.start({ models: MODELS, generation: 7, correlationId: "corr-qualification-b" }),
    ).toEqual({
      kind: "refused",
      reason: "active-qualification",
    });
    expect(f.h.log.withOp("review.pair-qualification.failed")).toMatchObject([
      { correlationId: "corr-qualification-b", extra: { reason: "active-qualification" } },
    ]);
  }, 60_000);
});
