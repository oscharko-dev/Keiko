// The run sequence of one Keiko for Quality review (ADR-0182 D3-D6, Issue #4136):
//   preparing         validate both role models, resolve and fetch the target (child 3), create the
//                     review worktree (child 3), build the diff package (child 4);
//   reviewing         one Reviewer run on the review runtime instance (child 5);
//   counter-checking  one fresh read-only counter-check per candidate, in severity order;
//   settling          settlement and presentation (pure), then the record (service.ts).
// Each phase records what it learned in the run state; the first preparation failure, a
// cancellation, or a missing building block ends the sequence and lets the run settle.

import {
  reviewDiffCoverageSettlement,
  reviewDiffPackageFailureSettlement,
} from "@oscharko-dev/keiko-contracts/runtime/pull-request-review-rules";
import type {
  ReviewCoverageEntry,
  ReviewDiffCoverage,
  ReviewDiffCoverageSummary,
  ReviewDiffSettlementInput,
  ReviewRoleTotals,
  ReviewRunPhase,
  ReviewRunSettlement,
  ReviewRuntimeCleanup,
  ReviewTargetRequest,
} from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";

import type { ServerLogSink } from "../../observability/index.js";
import type { CounterCheckEffect } from "../counter-check/activity-log.js";
import type {
  CounterCheckInput,
  CounterCheckOutcome,
  CounterCheckRunBudget,
} from "../counter-check/counterCheck.js";
import type { ReviewDiffPackage } from "../diff-package/types.js";
import type { ReviewCandidateFinding } from "../runtime/findingIntake.js";
import { ReviewHeadFileReader } from "../runtime/findingIntake.js";
import type { ReviewRuntimeService } from "../runtime/instance.js";
import type { ReviewServices } from "../services.js";
import { logReviewRunPhase, type ReviewRunPackageCounts } from "./activity-log.js";
import { reviewDiffBudgetTokens } from "./budget.js";
import type { ReviewRunEventHub } from "./events.js";
import {
  reviewerOutcomeFact,
  runtimeRefusalSettlement,
  targetRefusalSettlement,
  worktreeRefusalSettlement,
} from "./mapping.js";
import {
  ensureReviewRoleModelsReady,
  validateReviewRoleModels,
  type ReviewModelPort,
} from "./models.js";
import { counterCheckOrder } from "./presentation.js";
import type { ReviewerSettlementFact } from "./settlement.js";
import type { ReviewRunStore } from "./store.js";

type PreparationSettlement = Exclude<
  ReviewRunSettlement,
  { readonly kind: "complete" | "incomplete" }
>;

export interface ReviewSequenceDeps {
  readonly store: ReviewRunStore;
  readonly reviewServices: ReviewServices;
  readonly reviewRuntime: Pick<ReviewRuntimeService, "run"> | undefined;
  readonly counterCheck: (input: CounterCheckInput) => Promise<CounterCheckOutcome>;
  readonly models: ReviewModelPort;
  readonly activityLog: ServerLogSink;
  readonly events: ReviewRunEventHub;
  readonly now: () => number;
  readonly counterCheckRunPromptTokens: number;
}

/** The fixed identity of one run in flight. Role models are already swapped for an evaluation. */
export interface ReviewRunContext {
  readonly runId: string;
  readonly correlationId: string;
  readonly repositoryRoot: string;
  readonly target: ReviewTargetRequest;
  readonly reviewerModelId: string;
  readonly counterCheckerModelId: string;
  readonly counterCheck: "on" | "off";
  readonly signal: AbortSignal;
  readonly startedAt: number;
}

/** What the sequence learned; the settlement and the record are computed from it. */
export interface ReviewRunState {
  preparation: PreparationSettlement | undefined;
  coverage: ReviewDiffSettlementInput | undefined;
  coverageSummary: ReviewDiffCoverageSummary | null;
  reviewer: ReviewerSettlementFact | undefined;
  /** Whether the Reviewer runtime's end was proven; a warning, never a settlement (#4136). */
  runtimeCleanup: ReviewRuntimeCleanup | undefined;
  readonly counterCheckEffects: CounterCheckEffect[];
  uncheckedCandidates: number;
  target: { readonly baseSha: string; readonly headSha: string } | undefined;
  worktreeRoot: string | undefined;
  candidates: readonly ReviewCandidateFinding[];
  readonly outcomes: Map<string, CounterCheckOutcome>;
  reviewerTotals: ReviewRoleTotals;
  counterCheckerTotals: ReviewRoleTotals;
}

const ZERO_TOTALS: ReviewRoleTotals = { promptTokens: 0, completionTokens: 0, durationMs: 0 };

export function newReviewRunState(): ReviewRunState {
  return {
    preparation: undefined,
    coverage: undefined,
    coverageSummary: null,
    reviewer: undefined,
    runtimeCleanup: undefined,
    counterCheckEffects: [],
    uncheckedCandidates: 0,
    target: undefined,
    worktreeRoot: undefined,
    candidates: [],
    outcomes: new Map(),
    reviewerTotals: ZERO_TOTALS,
    counterCheckerTotals: ZERO_TOTALS,
  };
}

function enterPhase(
  deps: ReviewSequenceDeps,
  ctx: ReviewRunContext,
  phase: ReviewRunPhase,
  extra: {
    readonly packageCounts?: ReviewRunPackageCounts;
    readonly candidateCount?: number;
  } = {},
): void {
  deps.store.setPhase(ctx.runId, phase, deps.now());
  deps.events.update(ctx.runId, { phase });
  logReviewRunPhase(deps.activityLog, ctx.correlationId, {
    runId: ctx.runId,
    phase,
    elapsedMs: deps.now() - ctx.startedAt,
    ...extra,
  });
}

/** Ends the sequence with a preparation settlement; returns `false` so callers stop. */
function stopWith(state: ReviewRunState, settlement: PreparationSettlement): false {
  state.preparation = settlement;
  return false;
}

function cancelled(ctx: ReviewRunContext, state: ReviewRunState): boolean {
  if (!ctx.signal.aborted) return false;
  state.preparation = { kind: "abandoned", reason: "cancelled" };
  return true;
}

async function resolveTarget(
  deps: ReviewSequenceDeps,
  ctx: ReviewRunContext,
  state: ReviewRunState,
): Promise<boolean> {
  const resolved = await deps.reviewServices.resolveTarget({
    repositoryRoot: ctx.repositoryRoot,
    runId: ctx.runId,
    request: ctx.target,
    correlationId: ctx.correlationId,
  });
  if (!resolved.ok) return stopWith(state, targetRefusalSettlement(resolved.reason));
  const target = { baseSha: resolved.target.baseSha, headSha: resolved.target.headSha };
  state.target = target;
  deps.store.setTarget(ctx.runId, target, resolved.privateRefs);
  return !cancelled(ctx, state);
}

async function createWorktree(
  deps: ReviewSequenceDeps,
  ctx: ReviewRunContext,
  state: ReviewRunState,
  headSha: string,
): Promise<boolean> {
  const created = await deps.reviewServices.worktrees.create({
    runId: ctx.runId,
    repositoryRoot: ctx.repositoryRoot,
    headSha,
    correlationId: ctx.correlationId,
    abortSignal: ctx.signal,
  });
  if (!created.ok) return stopWith(state, worktreeRefusalSettlement(created.reason));
  state.worktreeRoot = created.worktree.path;
  deps.reviewServices.worktrees.markInUse(ctx.runId);
  return !cancelled(ctx, state);
}

/** Every changed path with its coverage list and closed reason, in list order. */
function coverageEntries(coverage: ReviewDiffCoverage): ReviewCoverageEntry[] {
  const entries: ReviewCoverageEntry[] = [];
  const add = (list: ReviewCoverageEntry["list"], files: readonly { path: string }[]): void => {
    for (const file of files) {
      const reason = (file as { readonly reason?: string }).reason;
      entries.push({ path: file.path, list, ...(reason === undefined ? {} : { reason }) });
    }
  };
  add("included", coverage.included);
  add("unprocessed", coverage.unprocessed);
  add("deletedOnly", coverage.deletedOnly);
  add("filtered", coverage.filtered);
  add("binary", coverage.binary);
  add("submodule", coverage.submodule);
  add("symlink", coverage.symlink);
  add("modeOnly", coverage.modeOnly);
  return entries;
}

function packageCounts(coverage: ReviewDiffCoverage): ReviewRunPackageCounts {
  return {
    changedFiles: coverage.summary.changedFiles,
    includedFiles: coverage.included.length,
    partialFiles: coverage.summary.partiallyReviewedFiles,
    unprocessedFiles: coverage.unprocessed.length,
    filteredFiles: coverage.filtered.length,
    binaryFiles: coverage.binary.length,
    budgetTokens: coverage.summary.budgetTokens,
    usedTokens: coverage.summary.usedTokens,
  };
}

async function buildPackage(
  deps: ReviewSequenceDeps,
  ctx: ReviewRunContext,
  state: ReviewRunState,
  target: { readonly baseSha: string; readonly headSha: string },
): Promise<ReviewDiffPackage | undefined> {
  const built = await deps.reviewServices.buildDiffPackage({
    repositoryRoot: ctx.repositoryRoot,
    baseSha: target.baseSha,
    headSha: target.headSha,
    config: { budgetTokens: reviewDiffBudgetTokens(target.baseSha, target.headSha) },
    abortSignal: ctx.signal,
    correlationId: ctx.correlationId,
  });
  if (!built.ok) {
    const failed = reviewDiffPackageFailureSettlement(built.failure);
    state.preparation =
      failed.kind === "incomplete" ? { kind: "abandoned", reason: "interrupted" } : failed;
    return undefined;
  }
  const coverage = built.package.coverage;
  state.coverageSummary = coverage.summary;
  state.coverage = reviewDiffCoverageSettlement(coverage);
  deps.store.setCoverage(ctx.runId, coverage.summary, coverageEntries(coverage));
  deps.events.update(ctx.runId, { counts: { filesPackaged: coverage.included.length } });
  if (state.coverage.kind === "skipped" || state.coverage.kind === "abandoned") return undefined;
  return cancelled(ctx, state) ? undefined : built.package;
}

/** The `preparing` phase. Returns the diff package when the run may proceed to the Reviewer. */
export async function prepareReviewRun(
  deps: ReviewSequenceDeps,
  ctx: ReviewRunContext,
  state: ReviewRunState,
): Promise<ReviewDiffPackage | undefined> {
  await ensureReviewRoleModelsReady(deps.models, ctx, ctx.correlationId);
  const models = validateReviewRoleModels(deps.models, ctx, deps.now(), ctx.correlationId);
  if (!models.ok) {
    stopWith(state, { kind: "skipped", reason: models.reason });
    return undefined;
  }
  if (cancelled(ctx, state) || !(await resolveTarget(deps, ctx, state))) return undefined;
  const target = state.target;
  if (target === undefined) return undefined;
  if (!(await createWorktree(deps, ctx, state, target.headSha))) return undefined;
  const built = await buildPackage(deps, ctx, state, target);
  if (built !== undefined) {
    enterPhase(deps, ctx, "reviewing", { packageCounts: packageCounts(built.coverage) });
  }
  return built;
}

/**
 * The Reviewer's totals: the prompt and completion tokens the provider reported, as the review
 * runtime host accounted them (#4138).
 */
function reviewerTotals(
  result: Awaited<ReturnType<ReviewRuntimeService["run"]>>,
  durationMs: number,
): ReviewRoleTotals {
  const promptTokens = result.ok ? (result.effort?.promptTokens ?? 0) : 0;
  const completionTokens = result.ok ? (result.effort?.completionTokens ?? 0) : 0;
  return { promptTokens, completionTokens, durationMs };
}

/** The `reviewing` phase: one Reviewer run; collects its accepted candidates. */
export async function runReviewer(
  deps: ReviewSequenceDeps,
  ctx: ReviewRunContext,
  state: ReviewRunState,
  diffPackage: ReviewDiffPackage,
): Promise<boolean> {
  const target = state.target;
  const worktreeRoot = state.worktreeRoot;
  if (deps.reviewRuntime === undefined || target === undefined || worktreeRoot === undefined) {
    return stopWith(state, { kind: "skipped", reason: "model-unavailable" });
  }
  const startedAt = deps.now();
  const result = await deps.reviewRuntime.run({
    reviewRunId: ctx.runId,
    repositoryRoot: ctx.repositoryRoot,
    worktreeRoot,
    baseSha: target.baseSha,
    headSha: target.headSha,
    modelId: ctx.reviewerModelId,
    diffPackageText: diffPackage.text,
    correlationId: ctx.correlationId,
    signal: ctx.signal,
  });
  state.reviewerTotals = reviewerTotals(result, deps.now() - startedAt);
  if (!result.ok) return stopWith(state, runtimeRefusalSettlement(result.reason));
  if (result.rulesDigest !== undefined) deps.store.setRulesDigest(ctx.runId, result.rulesDigest);
  state.runtimeCleanup = result.runtimeCleanup;
  const fact = reviewerOutcomeFact(result);
  if ("kind" in fact) return stopWith(state, fact);
  state.reviewer = fact;
  state.candidates = result.candidates;
  deps.events.update(ctx.runId, { counts: { candidates: result.candidates.length } });
  return fact.outcome === "completed" || fact.outcome === "failed";
}

interface RunCounterCheckBudget extends CounterCheckRunBudget {
  /** The run's allowance refused a reservation: no further counter-check can start. */
  exhausted(): boolean;
}

function runBudget(limit: number): RunCounterCheckBudget {
  let used = 0;
  let refused = false;
  return {
    reserve: (promptTokens): boolean => {
      if (used + promptTokens > limit) {
        refused = true;
        return false;
      }
      used += promptTokens;
      return true;
    },
    exhausted: () => refused,
  };
}

function addTotals(left: ReviewRoleTotals, outcome: CounterCheckOutcome): ReviewRoleTotals {
  return {
    promptTokens: left.promptTokens + outcome.promptTokens,
    completionTokens: left.completionTokens + outcome.completionTokens,
    durationMs: left.durationMs + outcome.durationMs,
  };
}

/**
 * The `counter-checking` phase: each candidate in severity order, then Reviewer order, in its own
 * fresh session. Once the run's allowance is exhausted the remaining candidates stay unchecked.
 */
export async function counterCheckCandidates(
  deps: ReviewSequenceDeps,
  ctx: ReviewRunContext,
  state: ReviewRunState,
): Promise<void> {
  const target = state.target;
  const worktreeRoot = state.worktreeRoot;
  if (ctx.counterCheck === "off" || state.candidates.length === 0) return;
  if (target === undefined || worktreeRoot === undefined) return;
  enterPhase(deps, ctx, "counter-checking", { candidateCount: state.candidates.length });
  const reader = new ReviewHeadFileReader({
    worktreeRoot,
    headSha: target.headSha,
    runner: deps.reviewServices.reviewRunner(ctx.correlationId),
  });
  const budget = runBudget(deps.counterCheckRunPromptTokens);
  const ranked = counterCheckOrder(
    state.candidates.map((candidate, index) => ({ ...candidate, reviewerRank: index + 1 })),
  );
  for (const [index, candidate] of ranked.entries()) {
    if (ctx.signal.aborted || budget.exhausted()) {
      state.uncheckedCandidates = ranked.length - index;
      return;
    }
    const outcome = await deps.counterCheck({
      candidate,
      modelId: ctx.counterCheckerModelId,
      worktreeRoot,
      headSha: target.headSha,
      reader,
      budget,
      signal: ctx.signal,
      runCorrelationId: ctx.correlationId,
    });
    state.outcomes.set(candidate.fingerprint, outcome);
    state.counterCheckEffects.push(outcome.effect);
    state.counterCheckerTotals = addTotals(state.counterCheckerTotals, outcome);
    deps.events.update(ctx.runId, { counts: { counterChecked: state.outcomes.size } });
  }
}

export { enterPhase as enterReviewRunPhase };
