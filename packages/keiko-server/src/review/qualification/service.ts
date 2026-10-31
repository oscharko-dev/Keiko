// The local pair qualification of Keiko for Quality (ADR-0182 D8/D9, Issue #4137).
//
// Runs Keiko's shipped synthetic seed corpus (Issue #4132) through the real review orchestrator
// (Issue #4136) with one Reviewer/Counter-checker pair: each case is materialized as a fresh Git
// repository under `<stateDir>/review-qualification/<id>/`, started as a `local-range` review run
// under the qualification's correlation, awaited, scored with `scoreReviewSeedRun` and removed. The
// pair status is recorded only for a scored outcome: `seed-qualified` when every required seed was
// found, `seed-failed` (naming the missed seed classes) otherwise. A cancellation, the deadline or
// an unscored case leaves the status unchanged. No customer code is read, and nothing leaves the
// machine beyond the configured model gateway calls of the review runs themselves.

import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type {
  ReviewPairQualificationCaseView,
  ReviewPairQualificationEvent,
  ReviewPairQualificationOutcome,
  ReviewPairQualificationView,
  ReviewRoleTotals,
  ReviewRunView,
} from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";
import {
  REVIEW_CONTRACT_VERSION,
  REVIEW_PAIR_QUALIFICATION_DEFAULT_DEADLINE_MS,
} from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";
import type { GitProcessRunner } from "@oscharko-dev/keiko-git";

import type { ServerLogSink } from "../../observability/index.js";
import { reportReviewFailure } from "../diagnostics.js";
import type { ReviewEventListener } from "../eventStream.js";
import type { ReviewRoleModels } from "../policy/resolution.js";
import type { ReviewRunService } from "../service/service.js";
import {
  logPairQualificationCaseScored,
  logPairQualificationCompleted,
  logPairQualificationFailed,
  logPairQualificationStarted,
  type PairQualificationTotals,
} from "./activity-log.js";
import type { ReviewPairStatusRegistry } from "./pairStatus.js";
import {
  qualificationOutcome,
  scoreQualification,
  seedCaseResult,
  seedRunResult,
  type ScoredCase,
} from "./scoring.js";
import { REVIEW_SEED_CORPUS, type ReviewSeedCorpusEntry } from "./seed-corpus/index.js";
import {
  REVIEW_SEED_BASE_BRANCH,
  REVIEW_SEED_HEAD_BRANCH,
  materializeSeedRepository,
  removeSeedRepositories,
} from "./seedRepository.js";

export const REVIEW_QUALIFICATION_DIR = "review-qualification";
/** Settled qualifications kept readable; the oldest is forgotten first. */
const SETTLED_KEPT = 16;

type PairQualificationRunPort = Pick<ReviewRunService, "start" | "whenSettled" | "get" | "cancel">;

export interface PairQualificationServiceDeps {
  /** The review run service; read late because it is composed after this service. */
  readonly runs: () => PairQualificationRunPort | undefined;
  /** A hardened review runner for materializing the seed repositories. */
  readonly runner: (correlationId: string) => GitProcessRunner;
  /** Stops a seed repository's idle review runtime instance after its run. */
  readonly releaseRuntime?:
    ((repositoryRoot: string, correlationId: string) => Promise<void>) | undefined;
  /** `<stateDir>/review-qualification`. */
  readonly root: string;
  readonly pairStatus: ReviewPairStatusRegistry;
  readonly activityLog: ServerLogSink;
  readonly corpus?: readonly ReviewSeedCorpusEntry[] | undefined;
  readonly deadlineMs?: number | undefined;
  readonly now?: (() => number) | undefined;
  readonly newId?: (() => string) | undefined;
}

interface PairQualificationStartInput {
  readonly models: ReviewRoleModels;
  readonly generation: number | undefined;
  readonly correlationId: string;
}

type PairQualificationStartOutcome =
  | { readonly kind: "started"; readonly qualification: ReviewPairQualificationView }
  | { readonly kind: "refused"; readonly reason: "active-qualification" | "unavailable" };

export interface PairQualificationService {
  start(input: PairQualificationStartInput): PairQualificationStartOutcome;
  get(qualificationId: string): ReviewPairQualificationView | undefined;
  subscribe(
    qualificationId: string,
    listener: ReviewEventListener<ReviewPairQualificationEvent>,
  ): (() => void) | undefined;
  cancel(qualificationId: string): "cancelling" | "settled" | "not-found";
  whenSettled(qualificationId: string): Promise<void>;
  /** Removes every seed repository a previous process left behind. */
  sweep(): Promise<void>;
  dispose(): Promise<void>;
}

interface CaseState {
  readonly entry: ReviewSeedCorpusEntry;
  view: ReviewPairQualificationCaseView;
  scored: ScoredCase;
}

interface LiveQualification {
  readonly id: string;
  readonly input: PairQualificationStartInput;
  readonly dir: string;
  readonly startedAt: number;
  readonly controller: AbortController;
  readonly cases: CaseState[];
  readonly listeners: Set<ReviewEventListener<ReviewPairQualificationEvent>>;
  stop: "none" | "cancelled" | "deadline";
  currentRunId: string | undefined;
  totals: PairQualificationTotals;
  done: Promise<void>;
}

const ZERO_TOTALS: ReviewRoleTotals = { promptTokens: 0, completionTokens: 0, durationMs: 0 };

function addTotals(left: ReviewRoleTotals, right: ReviewRoleTotals): ReviewRoleTotals {
  return {
    promptTokens: left.promptTokens + right.promptTokens,
    completionTokens: left.completionTokens + right.completionTokens,
    durationMs: left.durationMs + right.durationMs,
  };
}

function pendingCase(entry: ReviewSeedCorpusEntry): CaseState {
  return {
    entry,
    scored: { seed: entry.seed, result: undefined },
    view: {
      caseId: entry.seed.id,
      seedClass: entry.seed.seedClass,
      required: entry.seed.required,
      cleanControl: entry.seed.cleanControl,
      result: "pending",
      presentedCount: 0,
      runId: null,
    },
  };
}

interface SettledFacts {
  readonly outcome: ReviewPairQualificationOutcome;
  readonly settledAt: number;
  readonly scored: ReturnType<typeof scoreQualification>;
}

class PairQualificationServiceImpl implements PairQualificationService {
  private readonly now: () => number;
  private readonly corpus: readonly ReviewSeedCorpusEntry[];
  private readonly deadlineMs: number;
  private live: LiveQualification | undefined;
  private readonly settled = new Map<string, ReviewPairQualificationView>();

  public constructor(private readonly deps: PairQualificationServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.corpus = deps.corpus ?? REVIEW_SEED_CORPUS;
    this.deadlineMs = deps.deadlineMs ?? REVIEW_PAIR_QUALIFICATION_DEFAULT_DEADLINE_MS;
  }

  public start(input: PairQualificationStartInput): PairQualificationStartOutcome {
    if (this.live !== undefined) return this.refuse("active-qualification", input.correlationId);
    if (this.deps.runs() === undefined) return this.refuse("unavailable", input.correlationId);
    const id = this.deps.newId?.() ?? `pair-qualification-${randomUUID()}`;
    const live: LiveQualification = {
      id,
      input,
      dir: join(this.deps.root, id),
      startedAt: this.now(),
      controller: new AbortController(),
      cases: this.corpus.map(pendingCase),
      listeners: new Set(),
      stop: "none",
      currentRunId: undefined,
      totals: { reviewer: ZERO_TOTALS, counterChecker: ZERO_TOTALS },
      done: Promise.resolve(),
    };
    this.live = live;
    logPairQualificationStarted(this.deps.activityLog, input.correlationId, {
      qualificationId: id,
      ...input.models,
      corpus: this.corpus,
      deadlineMs: this.deadlineMs,
    });
    live.done = Promise.resolve().then(() => this.execute(live));
    return { kind: "started", qualification: this.view(live, undefined) };
  }

  private refuse(
    reason: "active-qualification" | "unavailable",
    correlationId: string,
  ): PairQualificationStartOutcome {
    logPairQualificationFailed(this.deps.activityLog, correlationId, { reason });
    return { kind: "refused", reason };
  }

  private async execute(live: LiveQualification): Promise<void> {
    const timer = setTimeout(() => {
      this.stopLive(live, "deadline");
    }, this.deadlineMs);
    timer.unref();
    let failure: unknown;
    try {
      for (const [index, state] of live.cases.entries()) {
        if (live.controller.signal.aborted) break;
        await this.runCase(live, index, state);
        this.emit(live, this.progress(live));
      }
    } catch (error) {
      // A step that ends because the qualification was stopped is the stop, not a failure.
      if (!live.controller.signal.aborted) {
        failure = error;
        reportReviewFailure("review.pair-qualification.execute", live.input.correlationId, error);
      }
    } finally {
      clearTimeout(timer);
      await this.cleanup(live.dir, live.input.correlationId);
    }
    this.settle(live, failure);
  }

  private async cleanup(
    dir: string,
    correlationId: string,
    release?: (repositoryRoot: string, correlationId: string) => Promise<void>,
  ): Promise<void> {
    try {
      await release?.(dir, correlationId);
      await removeSeedRepositories(dir);
    } catch (error) {
      reportReviewFailure("review.pair-qualification.cleanup", correlationId, error);
    }
  }

  private async runCase(live: LiveQualification, index: number, state: CaseState): Promise<void> {
    const repositoryRoot = join(live.dir, String(index));
    const correlationId = live.input.correlationId;
    try {
      const runner = this.deps.runner(correlationId);
      await materializeSeedRepository(repositoryRoot, state.entry, runner, live.controller.signal);
      const view = await this.reviewCase(live, index, repositoryRoot);
      this.recordCase(live, index, state, view);
    } finally {
      live.currentRunId = undefined;
      await this.cleanup(repositoryRoot, correlationId, this.deps.releaseRuntime);
    }
  }

  private async reviewCase(
    live: LiveQualification,
    index: number,
    repositoryRoot: string,
  ): Promise<ReviewRunView | undefined> {
    const runs = this.deps.runs();
    if (runs === undefined || live.controller.signal.aborted) return undefined;
    const started = await runs.start({
      repositoryRoot,
      request: {
        target: {
          kind: "local-range",
          baseRef: REVIEW_SEED_BASE_BRANCH,
          headRef: REVIEW_SEED_HEAD_BRANCH,
        },
        ...live.input.models,
        clientRequestId: `${live.id}-${String(index)}`,
      },
      correlationId: live.input.correlationId,
    });
    if (started.kind !== "started") return undefined;
    const runId = started.run.runId;
    live.currentRunId = runId;
    // A stop that arrived while the run was being started cancels it now.
    if (stopped(live)) runs.cancel(runId);
    await runs.whenSettled(runId);
    return runs.get(runId, live.input.correlationId);
  }

  private recordCase(
    live: LiveQualification,
    index: number,
    state: CaseState,
    view: ReviewRunView | undefined,
  ): void {
    const result = seedRunResult(state.entry.seed, view);
    const caseResult = seedCaseResult(state.entry.seed, result);
    const presentedCount = view?.presentedFindings.length ?? 0;
    state.scored = { seed: state.entry.seed, result };
    state.view = { ...state.view, result: caseResult, presentedCount, runId: view?.runId ?? null };
    if (view !== undefined) {
      live.totals = {
        reviewer: addTotals(live.totals.reviewer, view.totals.reviewer),
        counterChecker: addTotals(live.totals.counterChecker, view.totals.counterChecker),
      };
    }
    logPairQualificationCaseScored(this.deps.activityLog, live.input.correlationId, {
      qualificationId: live.id,
      caseIndex: index,
      entry: state.entry,
      result: caseResult,
      presentedCount,
      runId: view?.runId,
    });
  }

  private settle(live: LiveQualification, failure: unknown): void {
    const scored = scoreQualification(live.cases.map((state) => state.scored));
    const outcome = failure === undefined ? qualificationOutcome(scored, live.stop) : "incomplete";
    const facts: SettledFacts = { outcome, settledAt: this.now(), scored };
    this.recordOutcome(live, facts, failure);
    const view = this.view(live, facts);
    this.settled.set(live.id, view);
    while (this.settled.size > SETTLED_KEPT) {
      const oldest = this.settled.keys().next().value;
      if (oldest === undefined) break;
      this.settled.delete(oldest);
    }
    this.live = undefined;
    const event: ReviewPairQualificationEvent = {
      kind: "settled",
      qualificationId: live.id,
      outcome,
      score: scored.score,
      elapsedMs: facts.settledAt - live.startedAt,
    };
    for (const listener of live.listeners) {
      listener.onEvent(event);
      listener.onClose();
    }
  }

  private recordOutcome(live: LiveQualification, facts: SettledFacts, failure: unknown): void {
    const correlationId = live.input.correlationId;
    const durationMs = facts.settledAt - live.startedAt;
    const outcome = facts.outcome;
    if (outcome === "seed-qualified" || outcome === "seed-failed") {
      this.deps.pairStatus.record(
        { ...live.input.models, generation: live.input.generation },
        {
          status: outcome,
          qualificationId: live.id,
          recordedAt: new Date(facts.settledAt).toISOString(),
          score: facts.scored.score,
        },
      );
      logPairQualificationCompleted(this.deps.activityLog, correlationId, {
        qualificationId: live.id,
        outcome,
        score: facts.scored.score,
        missedSeedClasses: facts.scored.missedSeedClasses,
        totals: live.totals,
        durationMs,
      });
      return;
    }
    logPairQualificationFailed(this.deps.activityLog, correlationId, {
      qualificationId: live.id,
      reason: failureReason(live.stop, failure),
      scoredCases: live.cases.length - facts.scored.unscored,
      unscoredCases: facts.scored.unscored,
      totals: live.totals,
      durationMs,
      error: failure,
    });
  }

  private progress(live: LiveQualification): ReviewPairQualificationEvent {
    return {
      kind: "progress",
      qualificationId: live.id,
      completedCases: live.cases.filter((state) => state.view.result !== "pending").length,
      totalCases: live.cases.length,
      elapsedMs: this.now() - live.startedAt,
    };
  }

  private emit(live: LiveQualification, event: ReviewPairQualificationEvent): void {
    for (const listener of live.listeners) listener.onEvent(event);
  }

  private view(
    live: LiveQualification,
    facts: SettledFacts | undefined,
  ): ReviewPairQualificationView {
    return {
      schemaVersion: REVIEW_CONTRACT_VERSION,
      qualificationId: live.id,
      ...live.input.models,
      configurationGeneration: live.input.generation ?? null,
      startedAt: new Date(live.startedAt).toISOString(),
      durationMs: (facts?.settledAt ?? this.now()) - live.startedAt,
      ...settledFields(facts),
      cases: live.cases.map((state) => state.view),
      totals: live.totals,
    };
  }

  private stopLive(live: LiveQualification, stop: "cancelled" | "deadline"): void {
    if (live.stop === "none") live.stop = stop;
    live.controller.abort();
    const runId = live.currentRunId;
    if (runId !== undefined) this.deps.runs()?.cancel(runId);
  }

  public get(qualificationId: string): ReviewPairQualificationView | undefined {
    const live = this.live;
    if (live?.id === qualificationId) return this.view(live, undefined);
    return this.settled.get(qualificationId);
  }

  public subscribe(
    qualificationId: string,
    listener: ReviewEventListener<ReviewPairQualificationEvent>,
  ): (() => void) | undefined {
    const live = this.live;
    if (live?.id !== qualificationId) return undefined;
    live.listeners.add(listener);
    listener.onEvent(this.progress(live));
    return (): void => {
      live.listeners.delete(listener);
    };
  }

  public cancel(qualificationId: string): "cancelling" | "settled" | "not-found" {
    const live = this.live;
    if (live?.id === qualificationId) {
      this.stopLive(live, "cancelled");
      return "cancelling";
    }
    return this.settled.has(qualificationId) ? "settled" : "not-found";
  }

  public async whenSettled(qualificationId: string): Promise<void> {
    if (this.live?.id === qualificationId) await this.live.done;
  }

  public async sweep(): Promise<void> {
    if (this.live === undefined) await removeSeedRepositories(this.deps.root);
  }

  public async dispose(): Promise<void> {
    const live = this.live;
    if (live === undefined) return;
    this.stopLive(live, "cancelled");
    await live.done;
  }
}

function stopped(live: LiveQualification): boolean {
  return live.controller.signal.aborted;
}

function settledFields(
  facts: SettledFacts | undefined,
): Pick<
  ReviewPairQualificationView,
  "state" | "outcome" | "settledAt" | "score" | "missedSeedClasses"
> {
  if (facts === undefined) {
    return { state: "running", outcome: null, settledAt: null, score: null, missedSeedClasses: [] };
  }
  return {
    state: "settled",
    outcome: facts.outcome,
    settledAt: new Date(facts.settledAt).toISOString(),
    score: facts.scored.score,
    missedSeedClasses: facts.scored.missedSeedClasses,
  };
}

function failureReason(
  stop: LiveQualification["stop"],
  failure: unknown,
): "cancelled" | "incomplete" | "deadline-exceeded" | "failed" {
  if (failure !== undefined) return "failed";
  if (stop === "cancelled") return "cancelled";
  return stop === "deadline" ? "deadline-exceeded" : "incomplete";
}

export function createPairQualificationService(
  deps: PairQualificationServiceDeps,
): PairQualificationService {
  return new PairQualificationServiceImpl(deps);
}
