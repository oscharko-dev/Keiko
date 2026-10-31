// The Keiko for Quality review runtime service (ADR-0182 D1/D2/D4, Issue #4135).
//
// One review instance per repository, started on demand when a review starts and stopped after an
// idle period (default five minutes). Each instance is its own composition of the coding runtime
// (`composition.ts`) with its own orchestrator and run slot, so it serves one review run at a time
// and never touches the user's Coding Workbench run, active workspace, run list or history.
//
// One review run:
//   1. reads the review rules from the base commit (`rulesFile.ts`); an invalid rules file refuses
//      the run with its closed outcome before any runtime work;
//   2. renders the review task (`reviewPrompt.ts`): rules and diff package as fenced, nonce-bound,
//      untrusted data;
//   3. binds the instance's workspace view to the review worktree and runs the startup self-check
//      over all four read-only layers; any missing layer refuses with its closed reason;
//   4. starts the run on the instance's own orchestrator with a run-bound finding intake behind
//      `keiko_review_report`, waits for it to settle, and returns the accepted candidates.
// Orchestration, counter-check, settlement and presentation belong to Issue #4136.

import { randomUUID } from "node:crypto";

import { sha256Hex } from "@oscharko-dev/keiko-security";

import type {
  ReviewProfileRefusalReason,
  ReviewReportRejectionReason,
  ReviewRulesFileOutcome,
} from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";
import { REVIEW_RUNTIME_DEFAULT_IDLE_MS } from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";
import type { GitProcessRunner } from "@oscharko-dev/keiko-git";

import type {
  GovernedCodingToolPort,
  GovernedCodingToolResult,
} from "../../coding-runtime/codingToolGovernedDelegate.js";
import type { ServerLogSink } from "../../observability/index.js";
import {
  logReviewProfileRefused,
  logReviewRulesFile,
  logReviewRuntimeStarted,
  logReviewRuntimeStopped,
  type ReviewRuntimeStopTrigger,
} from "./activity-log.js";
import type { ReviewRuntimeComposition } from "./composition.js";
import {
  createReviewFindingIntake,
  type ReviewCandidateFinding,
  type ReviewFindingIntake,
} from "./findingIntake.js";
import { renderReviewTask } from "./reviewPrompt.js";
import {
  readReviewRulesFromBase,
  ReviewRulesReadError,
  type ReviewRulesReadResult,
  type ReviewRulesSettingsPort,
} from "./rulesFile.js";
import { checkReviewRuntimeLayers, type ReviewRuntimeLayers } from "./selfCheck.js";
import { driveReviewRun, type ReviewRunDriveOutcome } from "./runDriver.js";

export interface ReviewRuntimeRunRequest {
  /** The review run's own id (Issue #4136). */
  readonly reviewRunId: string;
  readonly repositoryRoot: string;
  /** The hardened, detached review worktree at the head commit (Issue #4133). */
  readonly worktreeRoot: string;
  readonly baseSha: string;
  readonly headSha: string;
  /** The Reviewer model, already admitted by the role policy (Issue #4137). */
  readonly modelId: string;
  /** The reviewer-facing diff package text (Issue #4134). */
  readonly diffPackageText: string;
  readonly correlationId?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

type ReviewRuntimeRefusalReason =
  | ReviewProfileRefusalReason
  | "busy"
  | "rules-file-invalid"
  | "rules-read-failed"
  | "task-too-large"
  | "runtime-unavailable";

export type ReviewRuntimeRunResult =
  | {
      readonly ok: true;
      readonly outcome: ReviewRunDriveOutcome["outcome"];
      readonly runtimeRunId?: string | undefined;
      readonly failureCode?: string | undefined;
      /** The Reviewer's prompt tokens and model turns as the runtime host accounted them (#4136). */
      readonly effort?: ReviewRunDriveOutcome["effort"];
      readonly rules: ReviewRulesFileOutcome;
      /** SHA-256 of the loaded rules text (#4136 run record); absent without rules. */
      readonly rulesDigest?: string | undefined;
      readonly candidates: readonly ReviewCandidateFinding[];
      readonly rejections: Readonly<Record<ReviewReportRejectionReason, number>>;
    }
  | {
      readonly ok: false;
      readonly reason: ReviewRuntimeRefusalReason;
      readonly rules?: ReviewRulesFileOutcome | undefined;
    };

/** The pieces one instance is composed with; production builds them from the activated runtime. */
export interface ReviewRuntimeServiceDeps {
  /** Composes one instance; `reviewReportPort` resolves the run-bound intake of a minted run. */
  readonly compose: (
    instanceId: string,
    reviewReportPort: (runId: string) => GovernedCodingToolPort<"review-report"> | undefined,
  ) => ReviewRuntimeComposition | undefined;
  /** What the self-check reads for a composed instance about to run one review. */
  readonly layersFor: (
    composition: ReviewRuntimeComposition,
    modelId: string,
  ) => ReviewRuntimeLayers;
  /** A hardened review runner (`createGitReviewProcessRunner`) for the rules and evidence reads. */
  readonly runner: () => GitProcessRunner;
  readonly rulesSettings?: ReviewRulesSettingsPort | undefined;
  readonly activityLog: ServerLogSink;
  readonly idleMs?: number | undefined;
  readonly now?: (() => number) | undefined;
  readonly setTimer?: ((callback: () => void, ms: number) => unknown) | undefined;
  readonly clearTimer?: ((handle: unknown) => void) | undefined;
}

export interface ReviewRuntimeService {
  run(request: ReviewRuntimeRunRequest): Promise<ReviewRuntimeRunResult>;
  /** The composed instance that owns a runtime capability, for the review sidecar routes. */
  instanceForCapability(
    capability: string,
    audience: "model-gateway" | "tool-facade",
  ): ReviewRuntimeComposition | undefined;
  /** Live instances; review runs never appear in the Coding Workbench's lists. */
  instanceCount(): number;
  /**
   * Stops the idle instance of one repository now instead of after the idle period (Issue #4137:
   * a pair qualification's seed repositories are removed right after their review). An instance
   * with a review in flight or in preparation is left alone.
   */
  release(repositoryRoot: string, correlationId?: string): Promise<void>;
  dispose(correlationId?: string): Promise<void>;
}

interface LiveInstance {
  readonly composition: ReviewRuntimeComposition;
  readonly slot: { intake: ReviewFindingIntake | undefined; pending: PendingIntake | undefined };
  busy: boolean;
  runCount: number;
  idleSince: number;
  timer: unknown;
}

interface PendingIntake {
  readonly create: (runId: string) => ReviewFindingIntake;
}

function reviewReportPortFor(
  slot: LiveInstance["slot"],
): (runId: string) => GovernedCodingToolPort<"review-report"> | undefined {
  return (runId) => {
    const pending = slot.pending;
    if (pending === undefined) return undefined;
    slot.pending = undefined;
    const intake = pending.create(runId);
    slot.intake = intake;
    return {
      execute: async (request, signal): Promise<GovernedCodingToolResult> => ({
        status: "completed",
        reviewReport: await intake.submit(request.report, signal),
      }),
    };
  };
}

function authenticates(
  composition: ReviewRuntimeComposition,
  capability: string,
  audience: "model-gateway" | "tool-facade",
): boolean {
  const authenticator = composition.controlPlane.runtimeCapabilityAuthenticator;
  if (authenticator === undefined) return false;
  const result: unknown = authenticator.authenticate(capability, audience);
  return typeof result === "object" && result !== null && (result as { ok?: unknown }).ok === true;
}

class ReviewRuntimeServiceImpl implements ReviewRuntimeService, ServiceContext {
  public readonly instances = new Map<string, LiveInstance>();
  public readonly reserved = new Set<string>();
  private readonly now: () => number;
  private readonly idleMs: number;

  public constructor(public readonly deps: ReviewRuntimeServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.idleMs = deps.idleMs ?? REVIEW_RUNTIME_DEFAULT_IDLE_MS;
  }

  public run(request: ReviewRuntimeRunRequest): Promise<ReviewRuntimeRunResult> {
    return runReview(this, request);
  }

  public instanceForCapability(
    capability: string,
    audience: "model-gateway" | "tool-facade",
  ): ReviewRuntimeComposition | undefined {
    return [...this.instances.values()].find((live) =>
      authenticates(live.composition, capability, audience),
    )?.composition;
  }

  public instanceCount(): number {
    return this.instances.size;
  }

  public async release(repositoryRoot: string, correlationId?: string): Promise<void> {
    await this.stop(repositoryRoot, "idle", correlationId);
  }

  public async dispose(correlationId?: string): Promise<void> {
    for (const key of this.instances.keys()) await this.stop(key, "shutdown", correlationId);
  }

  public start(key: string, correlationId?: string): LiveInstance | undefined {
    const startedAt = this.now();
    const slot: LiveInstance["slot"] = { intake: undefined, pending: undefined };
    const composition = this.deps.compose(randomUUID(), reviewReportPortFor(slot));
    if (composition === undefined) return undefined;
    const live: LiveInstance = {
      composition,
      slot,
      busy: false,
      runCount: 0,
      idleSince: this.now(),
      timer: undefined,
    };
    this.instances.set(key, live);
    logReviewRuntimeStarted(
      this.deps.activityLog,
      correlationId,
      composition.instanceId,
      this.now() - startedAt,
    );
    return live;
  }

  public arm(key: string, live: LiveInstance): void {
    this.clearTimer(live.timer);
    live.idleSince = this.now();
    const setTimer =
      this.deps.setTimer ?? ((callback, ms): unknown => setTimeout(callback, ms).unref());
    live.timer = setTimer(() => {
      void this.stop(key, "idle");
    }, this.idleMs);
  }

  public async stop(
    key: string,
    trigger: ReviewRuntimeStopTrigger,
    correlationId?: string,
  ): Promise<void> {
    const live = this.instances.get(key);
    if (live === undefined || live.busy || this.reserved.has(key)) return;
    this.instances.delete(key);
    this.clearTimer(live.timer);
    await live.composition.controlPlane.orchestrator.shutdown(correlationId);
    live.composition.close();
    logReviewRuntimeStopped(this.deps.activityLog, correlationId, {
      instanceId: live.composition.instanceId,
      trigger,
      idleDurationMs: this.now() - live.idleSince,
      runCount: live.runCount,
    });
  }

  private clearTimer(handle: unknown): void {
    if (handle === undefined) return;
    if (this.deps.clearTimer !== undefined) this.deps.clearTimer(handle);
    else clearTimeout(handle as ReturnType<typeof setTimeout>);
  }
}

export function createReviewRuntimeService(deps: ReviewRuntimeServiceDeps): ReviewRuntimeService {
  return new ReviewRuntimeServiceImpl(deps);
}

interface ServiceContext {
  readonly deps: ReviewRuntimeServiceDeps;
  readonly instances: Map<string, LiveInstance>;
  /** Repositories with a review in preparation or in flight. */
  readonly reserved: Set<string>;
  start(key: string, correlationId?: string): LiveInstance | undefined;
  arm(key: string, live: LiveInstance): void;
}

async function readRules(
  context: ServiceContext,
  request: ReviewRuntimeRunRequest,
): Promise<ReviewRulesReadResult | undefined> {
  try {
    return await readReviewRulesFromBase({
      repositoryRoot: request.repositoryRoot,
      baseSha: request.baseSha,
      path: context.deps.rulesSettings?.rulesPath(request.repositoryRoot),
      runner: context.deps.runner(),
      abortSignal: request.signal,
    });
  } catch (error) {
    if (!(error instanceof ReviewRulesReadError)) throw error;
    logReviewRulesFile(context.deps.activityLog, request.reviewRunId, "read-failed", 0);
    return undefined;
  }
}

async function runReview(
  context: ServiceContext,
  request: ReviewRuntimeRunRequest,
): Promise<ReviewRuntimeRunResult> {
  // Reserved synchronously, before the first await: one review at a time per repository, and no
  // idle stop of an instance a review is about to use.
  const key = request.repositoryRoot;
  if (context.reserved.has(key)) return { ok: false, reason: "busy" };
  context.reserved.add(key);
  try {
    return await prepareAndRun(context, request);
  } finally {
    context.reserved.delete(key);
    // An idle stop that fell while this review held the repository bailed without stopping the
    // instance; re-arm it now, whether or not this review reached the instance.
    const live = context.instances.get(key);
    if (live !== undefined && !live.busy) context.arm(key, live);
  }
}

async function prepareAndRun(
  context: ServiceContext,
  request: ReviewRuntimeRunRequest,
): Promise<ReviewRuntimeRunResult> {
  const rules = await readRules(context, request);
  if (rules === undefined) return { ok: false, reason: "rules-read-failed" };
  logReviewRulesFile(context.deps.activityLog, request.reviewRunId, rules.outcome, rules.byteCount);
  if (rules.outcome !== "loaded" && rules.outcome !== "absent") {
    return { ok: false, reason: "rules-file-invalid", rules: rules.outcome };
  }
  const task = renderReviewTask({
    baseSha: request.baseSha,
    headSha: request.headSha,
    rules:
      rules.outcome === "loaded" ? { outcome: "loaded", text: rules.text } : { outcome: "absent" },
    diffPackageText: request.diffPackageText,
  });
  if (!task.ok) return { ok: false, reason: "task-too-large", rules: rules.outcome };
  const instance =
    context.instances.get(request.repositoryRoot) ??
    context.start(request.repositoryRoot, request.correlationId);
  if (instance === undefined) {
    return { ok: false, reason: "runtime-unavailable", rules: rules.outcome };
  }
  const result = await runOnInstance(context, instance, request, {
    taskText: task.text,
    rules: rules.outcome,
  });
  return withRulesDigest(result, rules);
}

async function runOnInstance(
  context: ServiceContext,
  live: LiveInstance,
  request: ReviewRuntimeRunRequest,
  prepared: { readonly taskText: string; readonly rules: ReviewRulesFileOutcome },
): Promise<ReviewRuntimeRunResult> {
  if (live.busy) return { ok: false, reason: "busy" };
  live.busy = true;
  const workspace = live.composition.workspace;
  try {
    if (!workspace.bind(request)) return { ok: false, reason: "busy", rules: prepared.rules };
    const check = checkReviewRuntimeLayers(
      context.deps.layersFor(live.composition, request.modelId),
    );
    if (!check.ok) {
      logReviewProfileRefused(
        context.deps.activityLog,
        request.correlationId,
        check.reason,
        check.layer,
      );
      return { ok: false, reason: check.reason, rules: prepared.rules };
    }
    live.slot.pending = {
      create: (runId): ReviewFindingIntake =>
        createReviewFindingIntake({
          runId,
          worktreeRoot: request.worktreeRoot,
          headSha: request.headSha,
          runner: context.deps.runner(),
          activityLog: context.deps.activityLog,
        }),
    };
    const outcome = await driveReviewRun(live.composition, {
      modelId: request.modelId,
      taskText: prepared.taskText,
      signal: request.signal,
      correlationId: request.correlationId,
    });
    return collected(live, outcome, prepared.rules);
  } finally {
    workspace.clear();
    live.slot.pending = undefined;
    live.slot.intake = undefined;
    live.busy = false;
    live.runCount += 1;
    // `runReview` re-arms the idle stop once the repository's reservation is released.
  }
}

function collected(
  live: LiveInstance,
  outcome: ReviewRunDriveOutcome,
  rules: ReviewRulesFileOutcome,
): ReviewRuntimeRunResult {
  const intake = live.slot.intake;
  return {
    ok: true,
    outcome: outcome.outcome,
    ...(outcome.runId === undefined ? {} : { runtimeRunId: outcome.runId }),
    ...(outcome.failureCode === undefined ? {} : { failureCode: outcome.failureCode }),
    ...(outcome.effort === undefined ? {} : { effort: outcome.effort }),
    rules,
    candidates: intake?.candidates() ?? [],
    rejections: intake?.rejections() ?? {
      "schema-invalid": 0,
      "path-outside-worktree": 0,
      "range-invalid": 0,
      "evidence-mismatch": 0,
      "limit-reached": 0,
    },
  };
}

/** The run record's rules identity (Issue #4136): a digest of the loaded rules text, never text. */
function withRulesDigest(
  result: ReviewRuntimeRunResult,
  rules: ReviewRulesReadResult,
): ReviewRuntimeRunResult {
  if (!result.ok || rules.outcome !== "loaded") return result;
  return { ...result, rulesDigest: sha256Hex(rules.text) };
}
