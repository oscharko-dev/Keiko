// One counter-check of one candidate finding (ADR-0185 D5, Issue #4136).
//
// The session runs on the generalized read-only child machinery: `runGovernedReadOnlySession`
// owns the governance (read-only gate, per-candidate tool-call ceiling, cancellation, wall-clock
// deadline) and `runReadOnlyHarnessSession` runs the bounded harness session with the reserved
// `review-counter-check` profile and the Counter-checker's model. Keiko does not limit tokens
// (#4346): the session's token use is measured and reported, never capped. The session starts with
// fresh context: its only input is the candidate task (`prompt.ts`). Its only output is one verdict
// through the verdict tool; a missing or invalid verdict is `undecided` with `insufficient-context`.

import { randomUUID } from "node:crypto";

import {
  REVIEW_COUNTER_CHECK_DEFAULT_MAX_OUTPUT_TOKENS,
  REVIEW_COUNTER_CHECK_DEFAULT_MAX_READ_CALLS,
  REVIEW_COUNTER_CHECK_DEFAULT_MAX_TOOL_CALLS,
  REVIEW_COUNTER_CHECK_DEFAULT_WALL_TIME_MS,
  type CounterCheckReasonCode,
  type CounterCheckVerdict,
  type ReviewEvidence,
} from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import {
  REVIEW_COUNTER_CHECK_HANDLER_REQUIREMENTS,
  REVIEW_COUNTER_CHECK_PROFILE,
  REVIEW_COUNTER_CHECK_TOOL_ALIASES,
} from "@oscharko-dev/keiko-tool-catalog";
import type { GitProcessRunner, GitReviewRunnerOptions } from "@oscharko-dev/keiko-git";

import {
  runGovernedReadOnlySession,
  type ReadOnlySessionResult,
} from "../../coding-runtime/readOnlyChildOrchestrator.js";
import {
  runReadOnlyHarnessSession,
  type ReadOnlyHarnessSessionOutcome,
  type ReadOnlyHarnessToolset,
} from "../../coding-runtime/productionReadOnlyChildRunner.js";
import {
  createReviewReadAllowance,
  type ReviewReadAllowance,
  type ReviewReadCallCounts,
} from "../../coding-runtime/reviewRuntimeGuard.js";
import type { ServerLogSink } from "../../observability/index.js";
import type { ReviewCandidateFinding, ReviewHeadFileReader } from "../runtime/findingIntake.js";
import {
  logCounterCheckCompleted,
  logCounterCheckFailed,
  type CounterCheckEffect,
  type CounterCheckFailureClass,
} from "./activity-log.js";
import { renderCounterCheckTask } from "./prompt.js";
import {
  admissibleCounterCheckPath,
  COUNTER_CHECK_CATALOG,
  createCounterCheckToolPort,
  type CounterCheckToolsetInput,
  type CounterCheckToolsetState,
} from "./tools.js";
import { reviewObjectFormat } from "../objectFormat.js";

const ATTESTATIONS = (["read", "discover", "search", "verdict"] as const).map((tool) => ({
  alias: REVIEW_COUNTER_CHECK_TOOL_ALIASES[tool],
  handlerId: REVIEW_COUNTER_CHECK_HANDLER_REQUIREMENTS[tool].id,
  handlerVersion: REVIEW_COUNTER_CHECK_HANDLER_REQUIREMENTS[tool].contractVersion,
  catalogAction: REVIEW_COUNTER_CHECK_TOOL_ALIASES[tool],
}));

/** Per-candidate bounds; operators may configure them (ADR-0185 D5). */
export interface CounterCheckLimits {
  readonly maxToolCalls: number;
  /** Read, list and search calls the session's tools answer; the verdict tool is not counted. */
  readonly maxReadCalls: number;
  readonly wallTimeMs: number;
  /** Output tokens one turn may take before the gateway's steered repair asks for the answer. */
  readonly maxOutputTokens: number;
}

export const DEFAULT_COUNTER_CHECK_LIMITS: CounterCheckLimits = {
  maxToolCalls: REVIEW_COUNTER_CHECK_DEFAULT_MAX_TOOL_CALLS,
  maxReadCalls: REVIEW_COUNTER_CHECK_DEFAULT_MAX_READ_CALLS,
  wallTimeMs: REVIEW_COUNTER_CHECK_DEFAULT_WALL_TIME_MS,
  maxOutputTokens: REVIEW_COUNTER_CHECK_DEFAULT_MAX_OUTPUT_TOKENS,
};

export interface CounterCheckDeps {
  readonly modelPortFactory: (modelId: string) => ModelPort | undefined;
  /**
   * The hardened local review runner. The counter-check asks for one that reads `.gitattributes`
   * from the empty tree, so a head's attributes cannot hide files from its search.
   */
  readonly runner: (options: GitReviewRunnerOptions) => GitProcessRunner;
  readonly activityLog: ServerLogSink;
  readonly limits?: Partial<CounterCheckLimits> | undefined;
  /**
   * The output tokens the model's configuration declares as its limit, when it declares one
   * (R4130-067). A turn never asks for more: the gateway refuses a request above it.
   */
  readonly declaredMaxOutputTokens?: ((modelId: string) => number | undefined) | undefined;
  readonly now?: (() => number) | undefined;
}

export interface CounterCheckInput {
  readonly candidate: ReviewCandidateFinding;
  readonly modelId: string;
  readonly worktreeRoot: string;
  readonly headSha: string;
  /** The run's shared head-commit reader (evidence verification). */
  readonly reader: ReviewHeadFileReader;
  readonly signal: AbortSignal;
  /** The review run's correlation id: every session line points at it. */
  readonly runCorrelationId: string;
  /** The review rules text the Reviewer received; absent when the repository has none. */
  readonly rulesText?: string | undefined;
  /** Only on a candidate's second session, after the first ended on a model failure (#4130). */
  readonly attempt?: number | undefined;
}

export interface CounterCheckOutcome {
  readonly verdict: CounterCheckVerdict;
  /** Every evidence range names a readable file of the reviewed head and lies inside it. */
  readonly evidenceInHead: boolean;
  /** What the session's ending means for the run's settlement. */
  readonly effect: CounterCheckEffect;
  /**
   * Whether a fresh session may end differently (#4130): this one ended without a verdict on a
   * model failure or on its own wall-time limit. A model that does not exist, a session at its
   * tool-call ceiling and a cancelled one are not.
   */
  readonly retryable: boolean;
  readonly toolCallCount: number;
  /** The read, list and search calls the session's read allowance answered and refused (#4130). */
  readonly readCalls: ReviewReadCallCounts;
  readonly durationMs: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  /** Attempts the gateway discarded inside the session's turns: a repaired answer, a corrected tool call. */
  readonly discardedAttemptCount: number;
}

/** The provider-reported token use of one session; counts only, never a limit (#4346). */
interface SessionMeter {
  promptTokens: number;
  completionTokens: number;
  discardedAttempts: number;
}

function undecided(fingerprint: string, reasonCode: CounterCheckReasonCode): CounterCheckVerdict {
  return { findingFingerprint: fingerprint, verdict: "undecided", evidence: [], reasonCode };
}

type CounterCheckModelRequest = Parameters<ModelPort["call"]>[0];
type CounterCheckModelResponse = Awaited<ReturnType<ModelPort["call"]>>;

/**
 * Counts what a discarded attempt cost. The provider has processed these tokens, so they belong to
 * the session's totals; Keiko does not limit tokens (#4346), so nothing is charged against a limit.
 */
function countDiscarded(
  meter: SessionMeter,
  discarded: NonNullable<CounterCheckModelResponse["discardedAttemptUsage"]>,
): void {
  meter.discardedAttempts += discarded.attemptCount;
  meter.promptTokens += discarded.promptTokens;
  meter.completionTokens += discarded.completionTokens;
}

/**
 * The Counter-checker's model port for one session (#4130). Every turn gets the session's output
 * budget and asks for the gateway's one steered repair, so a turn that spends its budget on
 * reasoning is asked once more for the answer instead of failing the check. What the gateway
 * discarded inside a turn (the repaired answer, a tool call it corrected) was processed by the
 * provider: its tokens count in the session's totals. The read-only harness calls `call` only, so
 * the port has no streaming variant.
 */
function counterCheckModel(
  model: ModelPort,
  limits: CounterCheckLimits,
  meter: SessionMeter,
): ModelPort {
  return {
    call: async (request, signal): Promise<CounterCheckModelResponse> => {
      const shaped: CounterCheckModelRequest = {
        ...request,
        maxOutputTokens: Math.min(
          request.maxOutputTokens ?? limits.maxOutputTokens,
          limits.maxOutputTokens,
        ),
        answerRepair: "steered",
      };
      const response = await model.call(shaped, signal);
      const discarded = response.discardedAttemptUsage;
      if (discarded !== undefined) countDiscarded(meter, discarded);
      return response;
    },
  };
}

/** Whether every evidence range names a readable head file and lies inside it. */
async function evidenceLiesInHead(
  reader: ReviewHeadFileReader,
  evidence: readonly ReviewEvidence[],
  signal: AbortSignal | undefined,
): Promise<boolean> {
  for (const entry of evidence) {
    if (!admissibleCounterCheckPath(entry.file)) return false;
    const file = await reader.read(entry.file, signal);
    if (file.kind === "refused" || entry.endLine > file.lines.length) return false;
  }
  return true;
}

interface Classified {
  readonly effect: CounterCheckEffect;
  readonly failure?: CounterCheckFailureClass | undefined;
  readonly fallbackReason: CounterCheckReasonCode;
}

const CANCELLED: Classified = {
  effect: "cancelled",
  failure: "cancelled",
  fallbackReason: "out-of-budget",
};
const DEADLINE_EXCEEDED: Classified = {
  effect: "deadline-exceeded",
  failure: "deadline-exceeded",
  fallbackReason: "out-of-budget",
};
const BUDGET_EXHAUSTED: Classified = {
  effect: "budget-exhausted",
  failure: "budget-exhausted",
  fallbackReason: "out-of-budget",
};
const MODEL_FAILED: Classified = {
  effect: "model-failed",
  failure: "model-failed",
  fallbackReason: "insufficient-context",
};

/** Maps a session ending to its settlement effect and, when abnormal, its failure class. */
function classify(session: ReadOnlySessionResult<ReadOnlyHarnessSessionOutcome>): Classified {
  if (session.ok) {
    // The harness's own bounds (tool calls, model calls, context) end it as `limit-exceeded`.
    return session.value.outcome === "limit-exceeded"
      ? BUDGET_EXHAUSTED
      : { effect: "none", fallbackReason: "insufficient-context" };
  }
  if (session.terminal === "stopped") {
    return session.reasonCode === "timeout" ? DEADLINE_EXCEEDED : CANCELLED;
  }
  if (session.terminal === "limit-reached") return BUDGET_EXHAUSTED;
  if (session.terminal === "denied") {
    return { effect: "none", failure: "governance-denied", fallbackReason: "insufficient-context" };
  }
  return MODEL_FAILED;
}

/** One session in flight: its identity, the state its tools fill and its token meter. */
interface CounterCheckSession {
  readonly correlationId: string;
  readonly startedAt: number;
  readonly now: () => number;
  readonly limits: CounterCheckLimits;
  readonly state: CounterCheckToolsetState;
  readonly readAllowance: ReviewReadAllowance;
  readonly meter: SessionMeter;
}

function sessionFacts(
  session: CounterCheckSession,
  input: CounterCheckInput,
): Parameters<typeof logCounterCheckFailed>[1] {
  return {
    correlationId: session.correlationId,
    runCorrelationId: input.runCorrelationId,
    fingerprint: input.candidate.fingerprint,
    toolCallCount: session.state.toolCalls,
    durationMs: session.now() - session.startedAt,
    ...(input.attempt === undefined ? {} : { attempt: input.attempt }),
  };
}

function counterCheckToolset(
  deps: CounterCheckDeps,
  input: CounterCheckInput,
  session: CounterCheckSession,
  governance: Pick<CounterCheckToolsetInput, "gate" | "stop">,
): ReadOnlyHarnessToolset {
  return {
    catalog: COUNTER_CHECK_CATALOG,
    profile: REVIEW_COUNTER_CHECK_PROFILE,
    attestations: ATTESTATIONS,
    tools: createCounterCheckToolPort(
      {
        runner: deps.runner({
          neutralizeTreeAttributes: reviewObjectFormat(input.headSha),
        }),
        worktreeRoot: input.worktreeRoot,
        headSha: input.headSha,
        fingerprint: input.candidate.fingerprint,
        reader: input.reader,
        readAllowance: session.readAllowance,
        ...governance,
      },
      session.state,
    ),
  };
}

function runSession(
  deps: CounterCheckDeps,
  input: CounterCheckInput,
  model: ModelPort,
  session: CounterCheckSession,
): Promise<ReadOnlySessionResult<ReadOnlyHarnessSessionOutcome>> {
  const { limits, meter } = session;
  return runGovernedReadOnlySession(
    {
      allowedActionClasses: ["workspace-read"],
      maxToolCalls: limits.maxToolCalls,
      charger: { chargeParentToolCall: () => true },
      cancellation: { stopReason: () => undefined },
      clock: { now: session.now },
      deadlineMs: session.startedAt + limits.wallTimeMs,
      signal: input.signal,
      reportRunnerFault: (failure, error) => {
        const thrown = { ok: false, ...failure, thrown: true } as const;
        const failureClass = classify(thrown).failure ?? "model-failed";
        logCounterCheckFailed(deps.activityLog, sessionFacts(session, input), failureClass, error);
      },
    },
    (gate, signal) =>
      runReadOnlyHarnessSession({
        model: counterCheckModel(model, limits, meter),
        // Nothing is left to refuse a model call for: the governed session cancels the harness
        // on a stop or at its deadline, and no token allowance exists (#4346).
        admitModelCall: () => true,
        sessionId: session.correlationId,
        objective: renderCounterCheckTask(input.candidate.report, {
          rulesText: input.rulesText,
          maxReadCalls: limits.maxReadCalls,
        }),
        modelId: input.modelId,
        workspaceRoot: input.worktreeRoot,
        maxToolCalls: limits.maxToolCalls,
        maxWallTimeMs: limits.wallTimeMs,
        signal,
        parentCorrelationId: input.runCorrelationId,
        onUsage: (usage) => {
          meter.promptTokens += usage.inputTokens;
          meter.completionTokens += usage.outputTokens;
        },
        toolset: (stop) => counterCheckToolset(deps, input, session, { gate, stop }),
      }),
  );
}

/**
 * The session's limits: the configured ones over the defaults, with the output budget of a turn
 * lowered to what the model declares (R4130-067). A model that declares no limit, or 0, keeps the
 * configured budget.
 */
function sessionLimits(deps: CounterCheckDeps, modelId: string): CounterCheckLimits {
  const limits = { ...DEFAULT_COUNTER_CHECK_LIMITS, ...deps.limits };
  const declared = deps.declaredMaxOutputTokens?.(modelId);
  if (declared === undefined || !Number.isSafeInteger(declared) || declared <= 0) return limits;
  return { ...limits, maxOutputTokens: Math.min(limits.maxOutputTokens, declared) };
}

/** Runs one counter-check session and logs its outcome; never throws for a session failure. */
export async function counterCheckCandidate(
  deps: CounterCheckDeps,
  input: CounterCheckInput,
): Promise<CounterCheckOutcome> {
  const now = deps.now ?? Date.now;
  const limits = sessionLimits(deps, input.modelId);
  const session: CounterCheckSession = {
    correlationId: `review-counter-check-${randomUUID()}`,
    startedAt: now(),
    now,
    limits,
    state: { verdict: undefined, invalidVerdicts: 0, toolCalls: 0 },
    readAllowance: createReviewReadAllowance(limits.maxReadCalls),
    meter: { promptTokens: 0, completionTokens: 0, discardedAttempts: 0 },
  };
  const fingerprint = input.candidate.fingerprint;
  const model = deps.modelPortFactory(input.modelId);
  if (model === undefined) {
    logCounterCheckFailed(
      deps.activityLog,
      sessionFacts(session, input),
      "model-unavailable",
      undefined,
    );
    const verdict = undecided(fingerprint, "insufficient-context");
    return finish(deps, input, session, verdict, { effect: "model-failed", retryable: false });
  }
  const ended = await runSession(deps, input, model, session);
  const classified = classify(ended);
  // A runner that threw was already recorded, with its error, by `reportRunnerFault`.
  if (classified.failure !== undefined && (ended.ok || !ended.thrown)) {
    logCounterCheckFailed(
      deps.activityLog,
      sessionFacts(session, input),
      classified.failure,
      undefined,
    );
  }
  // A verdict the model recorded before a bound ended the session is still its decision.
  const recorded = session.state.verdict;
  const verdict = recorded ?? undecided(fingerprint, classified.fallbackReason);
  const effect = recorded === undefined ? classified.effect : nonFailureEffect(classified);
  const retryable = effect === "model-failed" || effect === "deadline-exceeded";
  return finish(deps, input, session, verdict, { effect, retryable });
}

/** A recorded verdict survives a later bound; only a cancellation still abandons the run. */
function nonFailureEffect(classified: Classified): CounterCheckEffect {
  return classified.effect === "cancelled" ? "cancelled" : "none";
}

async function finish(
  deps: CounterCheckDeps,
  input: CounterCheckInput,
  session: CounterCheckSession,
  verdict: CounterCheckVerdict,
  ending: Pick<CounterCheckOutcome, "effect" | "retryable">,
): Promise<CounterCheckOutcome> {
  const facts = sessionFacts(session, input);
  const meter = session.meter;
  const evidenceInHead =
    verdict.evidence.length > 0 &&
    (await evidenceLiesInHead(input.reader, verdict.evidence, undefined));
  const outcome: CounterCheckOutcome = {
    verdict,
    evidenceInHead,
    ...ending,
    toolCallCount: facts.toolCallCount,
    readCalls: session.readAllowance.counts(),
    durationMs: facts.durationMs,
    promptTokens: meter.promptTokens,
    completionTokens: meter.completionTokens,
    discardedAttemptCount: meter.discardedAttempts,
  };
  logCounterCheckCompleted(deps.activityLog, facts, outcome);
  return outcome;
}
