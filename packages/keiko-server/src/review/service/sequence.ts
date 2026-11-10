// The run sequence of one Keiko for Quality review (ADR-0182 D3-D6, Issue #4136):
//   preparing         validate both role models, resolve and fetch the target (child 3), create the
//                     review worktree (child 3), build the diff package (child 4);
//   reviewing         one Reviewer run on the review runtime instance (child 5) per diff package
//                     part, in part order, each in its own session (#4130);
//   counter-checking  one fresh read-only counter-check per candidate, in severity order;
//   settling          settlement and presentation (pure), then the record (service.ts).
// Each phase records what it learned in the run state; the first preparation failure, a
// cancellation, or a missing building block ends the sequence and lets the run settle.

import { REVIEW_RUN_MAX_DIFF_PARTS } from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";
import {
  reviewDiffCoverageSettlement,
  reviewDiffPackageFailureSettlement,
} from "@oscharko-dev/keiko-contracts/runtime/pull-request-review-rules";
import type {
  ReviewCoverageEntry,
  ReviewDiffCoverage,
  ReviewDiffCoverageSummary,
  ReviewDiffFileRef,
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
import type { ReviewDiffPackage, ReviewDiffPackagePart } from "../diff-package/types.js";
import type { ReviewCandidateFinding } from "../runtime/findingIntake.js";
import { ReviewHeadFileReader } from "../runtime/findingIntake.js";
import type { ReviewRuntimeService } from "../runtime/instance.js";
import type { ReviewServices } from "../services.js";
import {
  logReviewRunPart,
  logReviewRunPhase,
  type ReviewRunPackageCounts,
  type ReviewRunPartLine,
} from "./activity-log.js";
import { reviewDiffBudgetTokens } from "./budget.js";
import type { ReviewRunEventHub } from "./events.js";
import {
  reviewerOutcomeFact,
  runtimeRefusalSettlement,
  targetRefusalSettlement,
  worktreeRefusalSettlement,
} from "./mapping.js";
import {
  admitReviewRoleModels,
  ensureReviewRoleModelsReady,
  evaluateReviewRoleModels,
  type ReviewModelPort,
} from "./models.js";
import { counterCheckOrder } from "./presentation.js";
import {
  combineReviewerFacts,
  type ReviewerSettlementFact,
  type UncheckedCandidatesReason,
} from "./settlement.js";
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
  /** Wall time the `counter-checking` phase may take for each diff package part (#4130). */
  readonly counterCheckPhaseWallTimeMs: number;
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
  /** What left them unchecked: the run's prompt allowance or the phase's wall-time limit (#4130). */
  uncheckedReason: UncheckedCandidatesReason | undefined;
  /**
   * The diff package's part count; the counter-check run allowance and the phase's wall-time limit
   * hold once per part (#4130).
   */
  partCount: number;
  /** `diffBaseSha` is the merge base the diff starts at; `baseSha` is the base the rules come from. */
  target: ReviewRunTarget | undefined;
  worktreeRoot: string | undefined;
  candidates: readonly ReviewCandidateFinding[];
  /** The review rules text the Reviewer received, handed to every counter-check (R4130-047). */
  rulesText: string | undefined;
  readonly outcomes: Map<string, CounterCheckOutcome>;
  reviewerTotals: ReviewRoleTotals;
  counterCheckerTotals: ReviewRoleTotals;
}

interface ReviewRunTarget {
  readonly baseSha: string;
  readonly headSha: string;
  readonly diffBaseSha: string;
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
    uncheckedReason: undefined,
    partCount: 0,
    target: undefined,
    worktreeRoot: undefined,
    candidates: [],
    rulesText: undefined,
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
    readonly counterCheckRunPromptAllowance?: number;
    readonly counterCheckPhaseWallTimeMs?: number;
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
  const { baseSha, headSha } = resolved.target;
  state.target = { baseSha, headSha, diffBaseSha: resolved.mergeBaseSha };
  // R4130-008: the run record keeps the diff base, so its per-file diff view matches the package.
  deps.store.setTarget(
    ctx.runId,
    { baseSha: resolved.mergeBaseSha, headSha },
    resolved.privateRefs,
  );
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
  const add = (list: ReviewCoverageEntry["list"], files: readonly ReviewDiffFileRef[]): void => {
    for (const file of files) {
      const reason = (file as { readonly reason?: string }).reason;
      entries.push({
        path: file.path,
        list,
        ...(reason === undefined ? {} : { reason }),
        ...(file.previousPath === undefined ? {} : { previousPath: file.previousPath }),
      });
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

function packageCounts(built: ReviewDiffPackage): ReviewRunPackageCounts {
  const coverage = built.coverage;
  return {
    changedFiles: coverage.summary.changedFiles,
    includedFiles: coverage.included.length,
    partialFiles: coverage.summary.partiallyReviewedFiles,
    unprocessedFiles: coverage.unprocessed.length,
    filteredFiles: coverage.filtered.length,
    binaryFiles: coverage.binary.length,
    budgetTokens: coverage.summary.budgetTokens,
    usedTokens: coverage.summary.usedTokens,
    partCount: built.parts.length,
  };
}

async function buildPackage(
  deps: ReviewSequenceDeps,
  ctx: ReviewRunContext,
  state: ReviewRunState,
  target: ReviewRunTarget,
): Promise<ReviewDiffPackage | undefined> {
  const built = await deps.reviewServices.buildDiffPackage({
    repositoryRoot: ctx.repositoryRoot,
    baseSha: target.diffBaseSha,
    headSha: target.headSha,
    config: {
      budgetTokens: reviewDiffBudgetTokens(target.diffBaseSha, target.headSha),
      maxParts: REVIEW_RUN_MAX_DIFF_PARTS,
    },
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

/**
 * The role models: the policy admission first, so a refused model is never read or contacted
 * (R4130-003), then eligibility against the gateway's capability data.
 */
/** Admission first, so a refused pair never loads a model; readiness runs before eligibility. */
async function checkRoleModels(
  deps: ReviewSequenceDeps,
  ctx: ReviewRunContext,
  state: ReviewRunState,
): Promise<boolean> {
  if (!admitReviewRoleModels(deps.models, ctx, ctx.correlationId)) {
    return stopWith(state, { kind: "skipped", reason: "policy-invalid" });
  }
  await ensureReviewRoleModelsReady(deps.models, ctx, ctx.correlationId);
  const models = evaluateReviewRoleModels(deps.models, ctx, deps.now());
  return models.ok || stopWith(state, { kind: "skipped", reason: models.reason });
}

/** The `preparing` phase. Returns the diff package when the run may proceed to the Reviewer. */
export async function prepareReviewRun(
  deps: ReviewSequenceDeps,
  ctx: ReviewRunContext,
  state: ReviewRunState,
): Promise<ReviewDiffPackage | undefined> {
  if (!(await checkRoleModels(deps, ctx, state))) return undefined;
  if (cancelled(ctx, state) || !(await resolveTarget(deps, ctx, state))) return undefined;
  const target = state.target;
  if (target === undefined) return undefined;
  if (!(await createWorktree(deps, ctx, state, target.headSha))) return undefined;
  const built = await buildPackage(deps, ctx, state, target);
  if (built !== undefined) {
    enterPhase(deps, ctx, "reviewing", { packageCounts: packageCounts(built) });
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

function addRoleTotals(left: ReviewRoleTotals, right: ReviewRoleTotals): ReviewRoleTotals {
  return {
    promptTokens: left.promptTokens + right.promptTokens,
    completionTokens: left.completionTokens + right.completionTokens,
    durationMs: left.durationMs + right.durationMs,
  };
}

/** An unproven end of any part's runtime makes the run's cleanup unproven (#4136, #4130). */
function combinedCleanup(
  left: ReviewRuntimeCleanup | undefined,
  right: ReviewRuntimeCleanup | undefined,
): ReviewRuntimeCleanup | undefined {
  if (left === "unproven" || right === "unproven") return "unproven";
  return left ?? right;
}

/** The candidates of every part so far, each fingerprint once, in the order they were accepted. */
function mergedCandidates(
  earlier: readonly ReviewCandidateFinding[],
  added: readonly ReviewCandidateFinding[],
): readonly ReviewCandidateFinding[] {
  const seen = new Set(earlier.map((candidate) => candidate.fingerprint));
  const merged = [...earlier];
  for (const candidate of added) {
    if (seen.has(candidate.fingerprint)) continue;
    seen.add(candidate.fingerprint);
    merged.push(candidate);
  }
  return merged;
}

interface ReviewerPart {
  readonly part: ReviewDiffPackagePart;
  readonly index: number;
  readonly count: number;
  readonly target: ReviewRunTarget;
  readonly worktreeRoot: string;
}

/** How one part's session ended: a settlement fact, or a refusal that settles the run on its own. */
type ReviewerPartStep =
  | { readonly kind: "fact"; readonly fact: ReviewerSettlementFact }
  | { readonly kind: "stop"; readonly settlement: PreparationSettlement };

type RuntimeResult = Awaited<ReturnType<ReviewRuntimeService["run"]>>;

function partLine(
  ctx: ReviewRunContext,
  input: ReviewerPart,
  result: RuntimeResult,
  step: ReviewerPartStep,
  totals: ReviewRoleTotals,
): ReviewRunPartLine {
  const base = {
    runId: ctx.runId,
    partNumber: input.index + 1,
    partCount: input.count,
    fileCount: input.part.fileCount,
    usedTokens: input.part.usedTokens,
    candidateCount: result.ok ? result.candidates.length : 0,
    totals,
    ...(result.ok && result.runtimeRunId !== undefined
      ? { runtimeRunId: result.runtimeRunId }
      : {}),
  };
  if (step.kind === "stop") return { ...base, outcome: "refused", reason: step.settlement.reason };
  const fact = step.fact;
  return fact.outcome === "failed"
    ? { ...base, outcome: "failed", reason: fact.reason }
    : { ...base, outcome: fact.outcome };
}

/** One part's Reviewer session: totals, rules digest, cleanup and candidates go into the state. */
async function runReviewerPart(
  deps: ReviewSequenceDeps,
  runtime: Pick<ReviewRuntimeService, "run">,
  ctx: ReviewRunContext,
  state: ReviewRunState,
  input: ReviewerPart,
): Promise<ReviewerPartStep> {
  const startedAt = deps.now();
  const result = await runtime.run({
    reviewRunId: ctx.runId,
    repositoryRoot: ctx.repositoryRoot,
    worktreeRoot: input.worktreeRoot,
    baseSha: input.target.baseSha,
    headSha: input.target.headSha,
    modelId: ctx.reviewerModelId,
    diffPackageText: input.part.text,
    ...(input.count > 1 ? { diffPart: { index: input.index, count: input.count } } : {}),
    correlationId: ctx.correlationId,
    signal: ctx.signal,
  });
  const totals = reviewerTotals(result, deps.now() - startedAt);
  state.reviewerTotals = addRoleTotals(state.reviewerTotals, totals);
  const step = partStep(deps, ctx, state, result);
  logReviewRunPart(deps.activityLog, ctx.correlationId, partLine(ctx, input, result, step, totals));
  return step;
}

function partStep(
  deps: ReviewSequenceDeps,
  ctx: ReviewRunContext,
  state: ReviewRunState,
  result: RuntimeResult,
): ReviewerPartStep {
  if (!result.ok) return { kind: "stop", settlement: runtimeRefusalSettlement(result.reason) };
  if (result.rulesDigest !== undefined) deps.store.setRulesDigest(ctx.runId, result.rulesDigest);
  if (result.rulesText !== undefined) state.rulesText = result.rulesText;
  state.runtimeCleanup = combinedCleanup(state.runtimeCleanup, result.runtimeCleanup);
  const fact = reviewerOutcomeFact(result);
  if ("kind" in fact) return { kind: "stop", settlement: fact };
  state.candidates = mergedCandidates(state.candidates, result.candidates);
  deps.events.update(ctx.runId, { counts: { candidates: state.candidates.length } });
  return { kind: "fact", fact };
}

/**
 * The `reviewing` phase: one Reviewer session per diff package part, in part order, each bounded by
 * the run budgets on its own (#4130). A refusal of the first part settles the run on its own, as
 * before; a later part's refusal (the runtime became unavailable) is a failed Reviewer, and no
 * further part starts. A failed session leaves the next parts to run. A cancellation ends the phase.
 */
export async function runReviewer(
  deps: ReviewSequenceDeps,
  ctx: ReviewRunContext,
  state: ReviewRunState,
  diffPackage: ReviewDiffPackage,
): Promise<boolean> {
  const target = state.target;
  const worktreeRoot = state.worktreeRoot;
  const runtime = deps.reviewRuntime;
  if (runtime === undefined || target === undefined || worktreeRoot === undefined) {
    return stopWith(state, { kind: "skipped", reason: "model-unavailable" });
  }
  if (diffPackage.parts.length === 0) {
    return stopWith(state, { kind: "skipped", reason: "no-reviewable-changes" });
  }
  state.partCount = diffPackage.parts.length;
  const facts = await reviewParts(deps, runtime, ctx, state, {
    parts: diffPackage.parts,
    target,
    worktreeRoot,
  });
  if ("kind" in facts) return stopWith(state, facts);
  const fact = combineReviewerFacts(facts);
  state.reviewer = fact;
  return fact.outcome === "completed" || fact.outcome === "failed";
}

/** Each part's session in order: their facts, or the first part's refusal that settles the run. */
async function reviewParts(
  deps: ReviewSequenceDeps,
  runtime: Pick<ReviewRuntimeService, "run">,
  ctx: ReviewRunContext,
  state: ReviewRunState,
  input: {
    readonly parts: readonly ReviewDiffPackagePart[];
    readonly target: ReviewRunTarget;
    readonly worktreeRoot: string;
  },
): Promise<ReviewerSettlementFact[] | PreparationSettlement> {
  const facts: ReviewerSettlementFact[] = [];
  const count = input.parts.length;
  for (const [index, part] of input.parts.entries()) {
    if (index > 0 && ctx.signal.aborted) return [...facts, { outcome: "cancelled" }];
    const { target, worktreeRoot } = input;
    const step = await runReviewerPart(deps, runtime, ctx, state, {
      part,
      index,
      count,
      target,
      worktreeRoot,
    });
    if (step.kind === "stop") {
      if (index === 0) return step.settlement;
      return [...facts, { outcome: "failed", reason: "model-failed" }];
    }
    facts.push(step.fact);
    if (step.fact.outcome === "cancelled") return facts;
  }
  return facts;
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

/**
 * The prompt tokens all counter-checks of one run may spend: the configured allowance once per diff
 * package part. Each part's Reviewer session may file up to `REVIEW_RUN_MAX_CANDIDATE_REPORTS`
 * candidates, so a fixed run allowance left the candidates of a many-part review unchecked (#4130).
 */
function counterCheckRunAllowance(perPartTokens: number, partCount: number): number {
  return perPartTokens * Math.max(1, partCount);
}

/**
 * The wall time the `counter-checking` phase may take before it starts no further check: the
 * configured limit once per diff package part, like the prompt allowance. A twelve-part review may
 * file 96 candidates, and without this limit their checks could run for 16 hours (#4130).
 */
function counterCheckPhaseLimitMs(perPartMs: number, partCount: number): number {
  return perPartMs * Math.max(1, partCount);
}

/**
 * Why the phase starts no further counter-check, or `undefined` while it may. A refused reservation
 * is checked first: `budget-exhausted` outranks `deadline-exceeded` in the settlement.
 */
function counterCheckStop(
  budget: RunCounterCheckBudget,
  now: number,
  deadline: number,
): UncheckedCandidatesReason | undefined {
  if (budget.exhausted()) return "budget-exhausted";
  return now >= deadline ? "deadline-exceeded" : undefined;
}

/**
 * The `counter-checking` phase: each candidate in severity order, then Reviewer order, in its own
 * fresh session. Once the run's allowance is exhausted or the phase's wall-time limit has passed,
 * the remaining candidates stay unchecked. A check in flight is not cut: it ends at its own limit.
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
  const allowance = counterCheckRunAllowance(deps.counterCheckRunPromptTokens, state.partCount);
  const phaseLimitMs = counterCheckPhaseLimitMs(deps.counterCheckPhaseWallTimeMs, state.partCount);
  const deadline = deps.now() + phaseLimitMs;
  enterPhase(deps, ctx, "counter-checking", {
    candidateCount: state.candidates.length,
    counterCheckRunPromptAllowance: allowance,
    counterCheckPhaseWallTimeMs: phaseLimitMs,
  });
  const reader = new ReviewHeadFileReader({
    worktreeRoot,
    headSha: target.headSha,
    runner: deps.reviewServices.reviewRunner(ctx.correlationId),
  });
  const budget = runBudget(allowance);
  const ranked = counterCheckOrder(
    state.candidates.map((candidate, index) => ({ ...candidate, reviewerRank: index + 1 })),
  );
  for (const [index, candidate] of ranked.entries()) {
    const stop = counterCheckStop(budget, deps.now(), deadline);
    if (ctx.signal.aborted || stop !== undefined) {
      state.uncheckedCandidates = ranked.length - index;
      state.uncheckedReason = stop;
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
      rulesText: state.rulesText,
    });
    state.outcomes.set(candidate.fingerprint, outcome);
    state.counterCheckEffects.push(outcome.effect);
    state.counterCheckerTotals = addRoleTotals(state.counterCheckerTotals, outcome);
    deps.events.update(ctx.runId, { counts: { counterChecked: state.outcomes.size } });
  }
}

export { enterPhase as enterReviewRunPhase };
