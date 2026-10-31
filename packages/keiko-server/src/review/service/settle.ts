// The `settling` phase of a review run (ADR-0182 D4-D6, Issue #4136): compute the settlement and
// the presentation with the pure rules, persist the record (findings and settlement in one
// transaction), remove the review worktree while its private refs stay for the diff route, and
// record `review.run.settled`. A record that cannot be written (a full disk) settles the run
// `abandoned/interrupted`: nothing it found is presented, and the next start settles the stored
// row the same way.

import type { ReviewRunSettlement } from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";

import type { ServerLogSink } from "../../observability/index.js";
import { reportReviewFailure } from "../diagnostics.js";
import type { ReviewServices } from "../services.js";
import { logReviewRunSettled } from "./activity-log.js";
import { presentReviewFindings, type PresentationCandidate } from "./presentation.js";
import type { ReviewRunContext, ReviewRunState } from "./sequence.js";
import { settleReviewRun } from "./settlement.js";
import type { ReviewStaleHeads } from "./stale.js";
import type { ReviewFindingRow, ReviewRunStore } from "./store.js";

export interface ReviewSettleDeps {
  readonly store: ReviewRunStore;
  readonly reviewServices: Pick<ReviewServices, "worktrees">;
  readonly activityLog: ServerLogSink;
  readonly stale: ReviewStaleHeads;
  readonly now: () => number;
  readonly excluded: (fingerprint: string) => boolean;
}

export interface ReviewSettledRun {
  readonly settlement: ReviewRunSettlement;
  readonly presentedCount: number;
}

function presentationCandidates(state: ReviewRunState): PresentationCandidate[] {
  return state.candidates.map((candidate, index) => {
    const outcome = state.outcomes.get(candidate.fingerprint);
    return {
      fingerprint: candidate.fingerprint,
      report: candidate.report,
      reviewerRank: index + 1,
      verdict: outcome?.verdict,
      evidenceInHead: outcome?.evidenceInHead ?? false,
    };
  });
}

/**
 * One stored row per candidate. An abandoned run (cancelled or interrupted) presents nothing: it
 * stopped before settling normally, so its candidates are kept for measurement only.
 */
function findingRows(
  candidates: readonly PresentationCandidate[],
  ctx: ReviewRunContext,
  excluded: (fingerprint: string) => boolean,
  settlement: ReviewRunSettlement,
): ReviewFindingRow[] {
  const abandoned = settlement.kind === "abandoned";
  const decisions = presentReviewFindings(candidates, {
    counterCheck: ctx.counterCheck,
    excluded: (fingerprint) => abandoned || excluded(fingerprint),
  });
  return candidates.map((candidate, index) => {
    const decision = decisions[index];
    return {
      fingerprint: candidate.fingerprint,
      reviewerRank: candidate.reviewerRank,
      report: candidate.report,
      verdict: candidate.verdict ?? null,
      evidenceInHead: candidate.evidenceInHead,
      presented: decision?.presented === true,
      presentationRank: decision?.presentationRank ?? null,
    };
  });
}

function verdictCounts(
  rows: readonly ReviewFindingRow[],
  presented: number,
): {
  readonly candidates: number;
  readonly confirmed: number;
  readonly refuted: number;
  readonly undecided: number;
  readonly presented: number;
} {
  const count = (verdict: string): number =>
    rows.filter((row) => row.verdict?.verdict === verdict).length;
  return {
    candidates: rows.length,
    confirmed: count("confirmed"),
    refuted: count("refuted"),
    undecided: count("undecided"),
    presented,
  };
}

function persist(
  deps: ReviewSettleDeps,
  ctx: ReviewRunContext,
  state: ReviewRunState,
  rows: readonly ReviewFindingRow[],
  settlement: ReviewRunSettlement,
): boolean {
  try {
    deps.store.settle(ctx.runId, rows, {
      settlement,
      settledAt: deps.now(),
      candidateCount: rows.length,
      reviewer: state.reviewerTotals,
      counterChecker: state.counterCheckerTotals,
      runtimeCleanup: state.runtimeCleanup,
    });
    return true;
  } catch (error) {
    reportReviewFailure("review.run.persist", ctx.correlationId, error);
    return false;
  }
}

async function removeWorktree(
  deps: ReviewSettleDeps,
  ctx: ReviewRunContext,
  state: ReviewRunState,
  settlement: ReviewRunSettlement,
): Promise<void> {
  if (state.worktreeRoot === undefined) return;
  const trigger = settlement.kind === "abandoned" ? "abandoned" : "settled";
  try {
    await deps.reviewServices.worktrees.remove(ctx.runId, trigger, ctx.correlationId);
  } catch (error) {
    reportReviewFailure("review.worktree.remove", ctx.correlationId, error);
  }
}

async function staleAtSettlement(deps: ReviewSettleDeps, ctx: ReviewRunContext): Promise<boolean> {
  const row = deps.store.get(ctx.runId);
  if (row === undefined) return false;
  try {
    return await deps.stale.isStale(row, ctx.correlationId);
  } catch (error) {
    reportReviewFailure("review.target.provider-read", ctx.correlationId, error);
    return false;
  }
}

/** Settles, presents, persists and cleans up one run; returns what the stream announces. */
export async function settleRunRecord(
  deps: ReviewSettleDeps,
  ctx: ReviewRunContext,
  state: ReviewRunState,
  flags: { readonly cancelled: () => boolean; readonly interrupted: () => boolean },
): Promise<ReviewSettledRun> {
  // The head read is the settling phase's one wait: a cancellation that arrives during it still
  // abandons the run, which has not settled yet.
  const stale = await staleAtSettlement(deps, ctx);
  const computed = settleReviewRun({
    cancelled: flags.cancelled(),
    interrupted: flags.interrupted(),
    preparation: state.preparation,
    coverage: state.coverage,
    reviewer: state.reviewer,
    counterChecks: state.counterCheckEffects,
    uncheckedCandidates: state.uncheckedCandidates,
  });
  const rows = findingRows(presentationCandidates(state), ctx, deps.excluded, computed);
  const recorded = persist(deps, ctx, state, rows, computed);
  const settlement: ReviewRunSettlement = recorded
    ? computed
    : { kind: "abandoned", reason: "interrupted" };
  const presentedCount = recorded ? rows.filter((row) => row.presented).length : 0;
  await removeWorktree(deps, ctx, state, settlement);
  logReviewRunSettled(deps.activityLog, ctx.correlationId, {
    runId: ctx.runId,
    settlement,
    coverage: state.coverageSummary,
    verdicts: verdictCounts(rows, presentedCount),
    reviewer: state.reviewerTotals,
    counterChecker: state.counterCheckerTotals,
    durationMs: deps.now() - ctx.startedAt,
    stale,
    runtimeCleanup: state.runtimeCleanup,
  });
  return { settlement, presentedCount };
}
