// The review ports of the offline gate (Issue #4138, ADR-0182 D9): the evaluation family's replay
// and seed gate call these, and each one runs one review through the composed review service, the
// same service the review routes use, with the requested model pair. A review settles before the
// next one starts, and the repository's review instance is released after each review, as the pair
// qualification does. Every review's own record (settlement, per-role tokens and durations) is
// kept beside the evaluation result, because the review runtime meters the Reviewer's tokens and
// the injected evaluation model port is never called.

import { randomUUID } from "node:crypto";

import type {
  ReviewCodeLocation,
  ReviewFindingReport,
  ReviewRunSettlement,
  ReviewRunView,
} from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import type { UiHandlerDeps } from "@oscharko-dev/keiko-server";

import type { EvaluationRefs } from "./repository.js";

export interface GateModels {
  readonly reviewerModelId: string;
  readonly counterCheckerModelId: string;
}

/** One review's record, body-free: identities, settlement, counts, tokens and durations. */
export interface GateReviewRecord {
  readonly caseKey: string;
  readonly runId: string | null;
  readonly settlement: ReviewRunSettlement;
  readonly refusal: string | null;
  readonly candidateCount: number;
  readonly presentedCount: number;
  readonly runtimeCleanup: string | null;
  readonly reviewer: RoleCost;
  readonly counterChecker: RoleCost;
  readonly wallTimeMs: number;
}

export interface RoleCost {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly durationMs: number;
}

const NO_COST: RoleCost = { promptTokens: 0, completionTokens: 0, durationMs: 0 };
const REFUSED: ReviewRunSettlement = { kind: "skipped", reason: "model-unavailable" };

/** The evaluation model port: the composed pipeline uses the gateway, so a call is a defect. */
export const UNUSED_EVALUATION_MODEL: ModelPort = {
  call: () => Promise.reject(new Error("the offline gate's review pipeline calls the gateway")),
};

export interface GateReviewer {
  readonly review: (
    caseKey: string,
    repositoryRoot: string,
    refs: EvaluationRefs,
  ) => Promise<{ readonly view: ReviewRunView | undefined; readonly record: GateReviewRecord }>;
  readonly records: () => readonly GateReviewRecord[];
}

function recordOf(caseKey: string, view: ReviewRunView, wallTimeMs: number): GateReviewRecord {
  return {
    caseKey,
    runId: view.runId,
    settlement: view.settlement ?? REFUSED,
    refusal: null,
    candidateCount: view.candidateCount,
    presentedCount: view.presentedFindings.length,
    runtimeCleanup: view.runtimeCleanup ?? null,
    reviewer: view.totals.reviewer,
    counterChecker: view.totals.counterChecker,
    wallTimeMs,
  };
}

function refusedRecord(caseKey: string, refusal: string, wallTimeMs: number): GateReviewRecord {
  return {
    caseKey,
    runId: null,
    settlement: REFUSED,
    refusal,
    candidateCount: 0,
    presentedCount: 0,
    runtimeCleanup: null,
    reviewer: NO_COST,
    counterChecker: NO_COST,
    wallTimeMs,
  };
}

/** Runs reviews one at a time through the composed review service. */
export function createGateReviewer(deps: UiHandlerDeps, models: GateModels): GateReviewer {
  const service = deps.reviewRunService;
  if (service === undefined) throw new Error("the composition has no review run service");
  const records: GateReviewRecord[] = [];
  const review: GateReviewer["review"] = async (caseKey, repositoryRoot, refs) => {
    const startedAt = Date.now();
    const correlationId = randomUUID();
    const started = await service.start({
      repositoryRoot,
      request: {
        target: { kind: "local-range", baseRef: refs.baseRef, headRef: refs.headRef },
        ...models,
        clientRequestId: `review-gate-${caseKey}-${String(startedAt)}`,
      },
      correlationId,
    });
    if (started.kind !== "started") {
      const record = refusedRecord(
        caseKey,
        started.kind === "refused" ? started.reason : started.kind,
        Date.now() - startedAt,
      );
      records.push(record);
      return { view: undefined, record };
    }
    await service.whenSettled(started.run.runId);
    const view = await service.get(started.run.runId, correlationId);
    await deps.reviewRuntime?.release(repositoryRoot, correlationId);
    const record =
      view === undefined
        ? refusedRecord(caseKey, "view-missing", Date.now() - startedAt)
        : recordOf(caseKey, view, Date.now() - startedAt);
    records.push(record);
    return { view, record };
  };
  return { review, records: () => [...records] };
}

/** The presented findings of a review as the evaluation family scores them. */
export function presentedReports(view: ReviewRunView | undefined): readonly ReviewFindingReport[] {
  return view?.presentedFindings.map((finding) => finding.report) ?? [];
}

export function presentedLocations(view: ReviewRunView | undefined): readonly ReviewCodeLocation[] {
  return presentedReports(view).map(({ file, startLine, endLine }) => ({
    file,
    startLine,
    endLine,
  }));
}
