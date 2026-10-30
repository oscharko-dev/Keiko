// The Keiko for Quality review service (ADR-0182 D3-D6, Issue #4136).
//
// Turns a person's "Start review" into one governed review run: it records the run, runs the
// sequence (`sequence.ts`) in the background, settles it honestly (`settlement.ts`), decides what is
// presented (`presentation.ts`), persists the record (`store.ts`), removes the review worktree
// (the private refs stay for the diff route), and streams body-free progress (`events.ts`).
// One review per repository may be in flight; a repeated client request id returns the same run.
// A server restart settles every unsettled record `abandoned/interrupted` at the next start.
//
// Evaluation switches (counter-check off, role swap) exist only on `createReviewEvaluationService`,
// which the evaluation composition of Issues #4137 and #4138 uses; the product factory and the
// product routes cannot reach them.

import { randomUUID } from "node:crypto";

import type {
  ReviewPullRequestReviewState,
  ReviewRunRefusalReason,
  ReviewRunStartRequest,
  ReviewRunView,
  ReviewRunEstimate,
} from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";
import {
  REVIEW_COUNTER_CHECK_DEFAULT_RUN_PROMPT_TOKENS,
  REVIEW_RUN_DEFAULT_PROMPT_TOKENS,
  REVIEW_RUN_HISTORY_MAX,
} from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";

import type { ServerLogSink } from "../../observability/index.js";
import { deriveRepositoryId } from "../../task-workspace/naming.js";
import {
  DEFAULT_COUNTER_CHECK_LIMITS,
  type CounterCheckInput,
  type CounterCheckLimits,
  type CounterCheckOutcome,
} from "../counter-check/counterCheck.js";
import { reportReviewFailure } from "../diagnostics.js";
import type { ReviewRuntimeService } from "../runtime/instance.js";
import type { ReviewServices } from "../services.js";
import { logReviewRunRefused, logReviewRunSettled, logReviewRunStarted } from "./activity-log.js";
import { estimateDryRun } from "./dryRun.js";
import { reviewRunDiff, type ReviewRunDiffResult } from "./diff.js";
import { ReviewRunEventHub, type ReviewRunEventListener } from "./events.js";
import type { ReviewModelPort } from "./models.js";
import { validateReviewRoleModels } from "./models.js";
import {
  counterCheckCandidates,
  enterReviewRunPhase,
  newReviewRunState,
  prepareReviewRun,
  runReviewer,
  type ReviewRunContext,
  type ReviewRunState,
  type ReviewSequenceDeps,
} from "./sequence.js";
import { settleRunRecord } from "./settle.js";
import { ReviewStaleHeads } from "./stale.js";
import type { ReviewRunRow, ReviewRunStore } from "./store.js";
import { reviewRunView } from "./views.js";

export interface ReviewRunServiceDeps {
  readonly store: ReviewRunStore;
  readonly reviewServices: ReviewServices;
  readonly reviewRuntime: Pick<ReviewRuntimeService, "run"> | undefined;
  readonly counterCheck: (input: CounterCheckInput) => Promise<CounterCheckOutcome>;
  readonly models: ReviewModelPort;
  readonly activityLog: ServerLogSink;
  readonly now?: (() => number) | undefined;
  readonly newRunId?: (() => string) | undefined;
  /** The Reviewer's prompt budget as the review runtime is configured (logged at start). */
  readonly reviewerPromptBudget?: number | undefined;
  readonly counterCheckRunPromptTokens?: number | undefined;
  readonly counterCheckLimits?: Partial<CounterCheckLimits> | undefined;
  /** Issue #4141's exclusion (a fingerprint already dismissed on the pull request); default none. */
  readonly excludedFingerprint?: ((run: ReviewRunRow, fingerprint: string) => boolean) | undefined;
}

/** Measurement-only switches (Issues #4137, #4138); never reachable from a product route. */
export interface ReviewEvaluationSwitches {
  readonly counterCheck?: "on" | "off" | undefined;
  readonly swapRoles?: boolean | undefined;
}

interface ReviewRunStartInput {
  readonly repositoryRoot: string;
  readonly request: ReviewRunStartRequest;
  readonly correlationId: string;
}

type ReviewRunStartOutcome =
  | { readonly kind: "dry-run"; readonly estimate: ReviewRunEstimate }
  | { readonly kind: "started"; readonly run: ReviewRunView; readonly replayed: boolean }
  | {
      readonly kind: "refused";
      readonly reason: ReviewRunRefusalReason;
      readonly activeRunId?: string | undefined;
    };

type ReviewRunCancelOutcome = "cancelling" | "settled" | "not-found";

export interface ReviewRunService {
  start(input: ReviewRunStartInput): Promise<ReviewRunStartOutcome>;
  get(runId: string, correlationId?: string): Promise<ReviewRunView | undefined>;
  history(repositoryId: string, pullRequestNumber?: number): Promise<readonly ReviewRunView[]>;
  reviewStates(repositoryId: string): Promise<readonly ReviewPullRequestReviewState[]>;
  /** Subscribes to a live run's progress; `undefined` when the run is not in flight. */
  subscribe(runId: string, listener: ReviewRunEventListener): (() => void) | undefined;
  cancel(runId: string): ReviewRunCancelOutcome;
  /** Records a start request the route refused before the service saw it (`request-invalid`). */
  refuseInvalidRequest(correlationId: string, dryRun: boolean): void;
  diff(runId: string, path: string, contextLines: number): Promise<ReviewRunDiffResult>;
  /** Private refs recorded runs still reference; the retention sweep keeps them. */
  retainedRefs(repositoryRoot: string): ReadonlySet<string>;
  /** Resolves when the run settled (tests and shutdown). */
  whenSettled(runId: string): Promise<void>;
  dispose(): Promise<void>;
}

interface LiveRun {
  readonly controller: AbortController;
  cancelRequested: boolean;
  readonly done: Promise<void>;
}

class ReviewRunServiceImpl implements ReviewRunService {
  private readonly now: () => number;
  private readonly events: ReviewRunEventHub;
  private readonly live = new Map<string, LiveRun>();
  private readonly stale: ReviewStaleHeads;
  private readonly limits: CounterCheckLimits;
  private shuttingDown = false;

  public constructor(
    private readonly deps: ReviewRunServiceDeps,
    private readonly evaluation: ReviewEvaluationSwitches,
  ) {
    this.now = deps.now ?? Date.now;
    this.events = new ReviewRunEventHub(this.now);
    this.stale = new ReviewStaleHeads(deps.reviewServices, this.now);
    this.limits = { ...DEFAULT_COUNTER_CHECK_LIMITS, ...deps.counterCheckLimits };
    this.recoverInterrupted();
  }

  /** Every run a previous server process left unsettled ends `abandoned/interrupted`. */
  private recoverInterrupted(): void {
    for (const row of this.deps.store.unsettled()) {
      const settlement = { kind: "abandoned", reason: "interrupted" } as const;
      const at = Math.max(this.now(), row.createdAt);
      this.deps.store.settle(row.runId, [], {
        settlement,
        settledAt: at,
        candidateCount: 0,
        reviewer: row.reviewer,
        counterChecker: row.counterChecker,
      });
      logReviewRunSettled(this.deps.activityLog, row.correlationId, {
        runId: row.runId,
        settlement,
        coverage: row.coverage,
        verdicts: { candidates: 0, confirmed: 0, refuted: 0, undecided: 0, presented: 0 },
        reviewer: row.reviewer,
        counterChecker: row.counterChecker,
        durationMs: at - row.createdAt,
        stale: false,
      });
    }
  }

  public async start(input: ReviewRunStartInput): Promise<ReviewRunStartOutcome> {
    const repositoryId = deriveRepositoryId(input.repositoryRoot);
    if (input.request.dryRun === true) return this.dryRun(input);
    const replayed = this.deps.store.findByClientRequest(
      repositoryId,
      input.request.clientRequestId,
    );
    if (replayed !== undefined) return this.replay(replayed, input.correlationId);
    return this.insertAndLaunch(input, repositoryId);
  }

  private async insertAndLaunch(
    input: ReviewRunStartInput,
    repositoryId: string,
  ): Promise<ReviewRunStartOutcome> {
    const runId = this.deps.newRunId?.() ?? `review-${randomUUID()}`;
    const inserted = this.deps.store.insert({
      runId,
      repositoryId,
      repositoryRoot: input.repositoryRoot,
      clientRequestId: input.request.clientRequestId,
      correlationId: input.correlationId,
      target: input.request.target,
      reviewerModelId: input.request.reviewerModelId,
      counterCheckerModelId: input.request.counterCheckerModelId,
      gatewayGeneration: this.deps.models.generation?.() ?? null,
      createdAt: this.now(),
    });
    if (!inserted.ok && inserted.reason === "duplicate-request") {
      return this.replay(inserted.runId, input.correlationId);
    }
    if (!inserted.ok) return this.refuse("active-review-exists", input, inserted.activeRunId);
    this.launch(runId, input);
    const view = await this.get(runId, input.correlationId);
    if (view === undefined) throw new Error("review run record missing after insert");
    return { kind: "started", run: view, replayed: false };
  }

  private async replay(runId: string, correlationId: string): Promise<ReviewRunStartOutcome> {
    const view = await this.get(runId, correlationId);
    if (view === undefined) throw new Error("replayed review run record missing");
    return { kind: "started", run: view, replayed: true };
  }

  private refuse(
    reason: ReviewRunRefusalReason,
    input: ReviewRunStartInput,
    activeRunId?: string,
  ): ReviewRunStartOutcome {
    logReviewRunRefused(
      this.deps.activityLog,
      input.correlationId,
      reason,
      input.request.dryRun === true,
    );
    return { kind: "refused", reason, ...(activeRunId === undefined ? {} : { activeRunId }) };
  }

  private async dryRun(input: ReviewRunStartInput): Promise<ReviewRunStartOutcome> {
    const models = validateReviewRoleModels(this.deps.models, input.request, this.now());
    if (!models.ok) return this.refuse(models.reason, input);
    const estimate = await estimateDryRun(
      this.deps.reviewServices,
      this.deps.store,
      input.repositoryRoot,
      input.request.target,
      input.correlationId,
    );
    return estimate === undefined
      ? this.refuse("request-invalid", input)
      : { kind: "dry-run", estimate };
  }

  private roleModels(request: ReviewRunStartRequest): {
    readonly reviewerModelId: string;
    readonly counterCheckerModelId: string;
  } {
    return this.evaluation.swapRoles === true
      ? {
          reviewerModelId: request.counterCheckerModelId,
          counterCheckerModelId: request.reviewerModelId,
        }
      : request;
  }

  private launch(runId: string, input: ReviewRunStartInput): void {
    const controller = new AbortController();
    const ctx: ReviewRunContext = {
      runId,
      correlationId: input.correlationId,
      repositoryRoot: input.repositoryRoot,
      target: input.request.target,
      ...this.roleModels(input.request),
      counterCheck: this.evaluation.counterCheck ?? "on",
      signal: controller.signal,
      startedAt: this.now(),
    };
    logReviewRunStarted(this.deps.activityLog, ctx.correlationId, {
      runId,
      targetKind: ctx.target.kind,
      reviewerModelId: ctx.reviewerModelId,
      counterCheckerModelId: ctx.counterCheckerModelId,
      reviewerPromptBudget: this.deps.reviewerPromptBudget ?? REVIEW_RUN_DEFAULT_PROMPT_TOKENS,
      counterCheckRunPromptBudget: this.counterCheckRunPromptTokens(),
      counterCheckMaxToolCalls: this.limits.maxToolCalls,
      counterCheckWallTimeMs: this.limits.wallTimeMs,
      counterCheckEnabled: ctx.counterCheck === "on",
    });
    this.events.open(runId);
    const live: LiveRun = {
      controller,
      cancelRequested: false,
      done: Promise.resolve().then(() => this.execute(ctx, live)),
    };
    this.live.set(runId, live);
  }

  private counterCheckRunPromptTokens(): number {
    return this.deps.counterCheckRunPromptTokens ?? REVIEW_COUNTER_CHECK_DEFAULT_RUN_PROMPT_TOKENS;
  }

  private sequenceDeps(): ReviewSequenceDeps {
    return {
      store: this.deps.store,
      reviewServices: this.deps.reviewServices,
      reviewRuntime: this.deps.reviewRuntime,
      counterCheck: this.deps.counterCheck,
      models: this.deps.models,
      activityLog: this.deps.activityLog,
      events: this.events,
      now: this.now,
      counterCheckRunPromptTokens: this.counterCheckRunPromptTokens(),
    };
  }

  private async execute(ctx: ReviewRunContext, live: LiveRun): Promise<void> {
    const state = newReviewRunState();
    const deps = this.sequenceDeps();
    try {
      const diffPackage = await prepareReviewRun(deps, ctx, state);
      if (diffPackage !== undefined && (await runReviewer(deps, ctx, state, diffPackage))) {
        await counterCheckCandidates(deps, ctx, state);
      }
    } catch (error) {
      // A failure no building block turned into a closed outcome (a store write, a thrown port)
      // interrupts the run; its cause is on the diagnostic sink under the run's correlation.
      state.preparation ??= { kind: "abandoned", reason: "interrupted" };
      reportReviewFailure("review.run.execute", ctx.correlationId, error);
    }
    await this.settle(ctx, state, live);
  }

  private async settle(ctx: ReviewRunContext, state: ReviewRunState, live: LiveRun): Promise<void> {
    try {
      enterReviewRunPhase(this.sequenceDeps(), ctx, "settling");
    } catch (error) {
      reportReviewFailure("review.run.persist", ctx.correlationId, error);
    }
    const row = this.deps.store.get(ctx.runId);
    const settled = await settleRunRecord(
      {
        store: this.deps.store,
        reviewServices: this.deps.reviewServices,
        activityLog: this.deps.activityLog,
        stale: this.stale,
        now: this.now,
        excluded: (fingerprint) =>
          row !== undefined && this.deps.excludedFingerprint?.(row, fingerprint) === true,
      },
      ctx,
      state,
      { cancelled: () => live.cancelRequested, interrupted: () => this.shuttingDown },
    );
    this.live.delete(ctx.runId);
    this.events.settle(ctx.runId, settled.settlement, settled.presentedCount);
  }

  public async get(runId: string, correlationId?: string): Promise<ReviewRunView | undefined> {
    const row = this.deps.store.get(runId);
    if (row === undefined) return undefined;
    return reviewRunView(this.deps.store, row, await this.stale.isStale(row, correlationId));
  }

  public async history(
    repositoryId: string,
    pullRequestNumber?: number,
  ): Promise<readonly ReviewRunView[]> {
    const rows = this.deps.store.history(repositoryId, pullRequestNumber, REVIEW_RUN_HISTORY_MAX);
    return Promise.all(
      rows.map(async (row) =>
        reviewRunView(this.deps.store, row, await this.stale.isStale(row, undefined)),
      ),
    );
  }

  public async reviewStates(
    repositoryId: string,
  ): Promise<readonly ReviewPullRequestReviewState[]> {
    const rows = this.deps.store.latestPerPullRequest(repositoryId);
    return Promise.all(rows.map((row) => this.reviewState(row)));
  }

  private async reviewState(row: ReviewRunRow): Promise<ReviewPullRequestReviewState> {
    const pullRequestNumber = row.pullRequestNumber ?? 0;
    if (row.phase !== "settled" || row.settlement === null) {
      return { pullRequestNumber, state: "reviewing", runId: row.runId };
    }
    if (await this.stale.isStale(row, undefined)) {
      return { pullRequestNumber, state: "stale", runId: row.runId };
    }
    const presentedCount = this.deps.store
      .findings(row.runId)
      .filter((finding) => finding.presented).length;
    return {
      pullRequestNumber,
      state: "settled",
      runId: row.runId,
      settlement: row.settlement,
      presentedCount,
    };
  }

  public subscribe(runId: string, listener: ReviewRunEventListener): (() => void) | undefined {
    return this.events.subscribe(runId, listener);
  }

  public cancel(runId: string): ReviewRunCancelOutcome {
    const live = this.live.get(runId);
    if (live !== undefined) {
      live.cancelRequested = true;
      live.controller.abort();
      return "cancelling";
    }
    return this.deps.store.get(runId) === undefined ? "not-found" : "settled";
  }

  public refuseInvalidRequest(correlationId: string, dryRun: boolean): void {
    logReviewRunRefused(this.deps.activityLog, correlationId, "request-invalid", dryRun);
  }

  public diff(runId: string, path: string, contextLines: number): Promise<ReviewRunDiffResult> {
    return reviewRunDiff(this.deps.store, this.deps.reviewServices, { runId, path, contextLines });
  }

  public retainedRefs(repositoryRoot: string): ReadonlySet<string> {
    return this.deps.store.retainedRefs(repositoryRoot);
  }

  public async whenSettled(runId: string): Promise<void> {
    await this.live.get(runId)?.done;
  }

  public async dispose(): Promise<void> {
    this.shuttingDown = true;
    const pending = [...this.live.values()];
    for (const live of pending) live.controller.abort();
    await Promise.all(pending.map((live) => live.done));
  }
}

/** The product review service: no evaluation switch can be set through it. */
export function createReviewRunService(deps: ReviewRunServiceDeps): ReviewRunService {
  return new ReviewRunServiceImpl(deps, {});
}

/**
 * The evaluation composition's review service (Issues #4137, #4138): the same service with the
 * measurement switches set. Never composed into the server's deps graph or reachable from a route.
 */
export function createReviewEvaluationService(
  deps: ReviewRunServiceDeps,
  switches: ReviewEvaluationSwitches,
): ReviewRunService {
  return new ReviewRunServiceImpl(deps, switches);
}
