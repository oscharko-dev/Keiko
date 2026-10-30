// One counter-check of one candidate finding (ADR-0182 D5, Issue #4136).
//
// The session runs on the generalized read-only child machinery: `runGovernedReadOnlySession`
// owns the governance (read-only gate, per-candidate tool-call ceiling, cancellation, wall-clock
// deadline) and `runReadOnlyHarnessSession` runs the bounded harness session with the reserved
// `review-counter-check` profile, the Counter-checker's model and a prompt budget charged against
// both the candidate's and the run's counter-check allowance. The session starts with fresh context:
// its only input is the candidate task (`prompt.ts`). Its only output is one verdict through the
// verdict tool; a missing or invalid verdict is `undecided` with `insufficient-context`.

import { randomUUID } from "node:crypto";

import {
  REVIEW_COUNTER_CHECK_DEFAULT_MAX_TOOL_CALLS,
  REVIEW_COUNTER_CHECK_DEFAULT_PROMPT_TOKENS,
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
import type { GitProcessRunner } from "@oscharko-dev/keiko-git";

import {
  runGovernedReadOnlySession,
  type ReadOnlySessionResult,
} from "../../coding-runtime/readOnlyChildOrchestrator.js";
import {
  runReadOnlyHarnessSession,
  type ReadOnlyHarnessSessionOutcome,
  type ReadOnlyHarnessToolset,
} from "../../coding-runtime/productionReadOnlyChildRunner.js";
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

const ATTESTATIONS = (["read", "discover", "search", "verdict"] as const).map((tool) => ({
  alias: REVIEW_COUNTER_CHECK_TOOL_ALIASES[tool],
  handlerId: REVIEW_COUNTER_CHECK_HANDLER_REQUIREMENTS[tool].id,
  handlerVersion: REVIEW_COUNTER_CHECK_HANDLER_REQUIREMENTS[tool].contractVersion,
  catalogAction: REVIEW_COUNTER_CHECK_TOOL_ALIASES[tool],
}));

/** Per-candidate bounds; operators may configure them (ADR-0182 D5). */
export interface CounterCheckLimits {
  readonly maxToolCalls: number;
  readonly wallTimeMs: number;
  readonly promptTokens: number;
}

export const DEFAULT_COUNTER_CHECK_LIMITS: CounterCheckLimits = {
  maxToolCalls: REVIEW_COUNTER_CHECK_DEFAULT_MAX_TOOL_CALLS,
  wallTimeMs: REVIEW_COUNTER_CHECK_DEFAULT_WALL_TIME_MS,
  promptTokens: REVIEW_COUNTER_CHECK_DEFAULT_PROMPT_TOKENS,
};

/** The run's shared counter-check prompt allowance. */
export interface CounterCheckRunBudget {
  reserve(promptTokens: number): boolean;
}

export interface CounterCheckDeps {
  readonly modelPortFactory: (modelId: string) => ModelPort | undefined;
  readonly runner: () => GitProcessRunner;
  readonly activityLog: ServerLogSink;
  readonly limits?: Partial<CounterCheckLimits> | undefined;
  readonly now?: (() => number) | undefined;
}

export interface CounterCheckInput {
  readonly candidate: ReviewCandidateFinding;
  readonly modelId: string;
  readonly worktreeRoot: string;
  readonly headSha: string;
  /** The run's shared head-commit reader (evidence verification). */
  readonly reader: ReviewHeadFileReader;
  readonly budget: CounterCheckRunBudget;
  readonly signal: AbortSignal;
  /** The review run's correlation id: every session line points at it. */
  readonly runCorrelationId: string;
}

export interface CounterCheckOutcome {
  readonly verdict: CounterCheckVerdict;
  /** Every evidence range names a readable file of the reviewed head and lies inside it. */
  readonly evidenceInHead: boolean;
  /** What the session's ending means for the run's settlement. */
  readonly effect: CounterCheckEffect;
  readonly toolCallCount: number;
  readonly durationMs: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
}

interface SessionMeter {
  promptTokens: number;
  completionTokens: number;
  reserved: number;
  budgetRefused: boolean;
}

function undecided(fingerprint: string, reasonCode: CounterCheckReasonCode): CounterCheckVerdict {
  return { findingFingerprint: fingerprint, verdict: "undecided", evidence: [], reasonCode };
}

function reserver(
  limits: CounterCheckLimits,
  budget: CounterCheckRunBudget,
  meter: SessionMeter,
): (promptTokens: number) => boolean {
  return (promptTokens) => {
    if (meter.reserved + promptTokens > limits.promptTokens || !budget.reserve(promptTokens)) {
      meter.budgetRefused = true;
      return false;
    }
    meter.reserved += promptTokens;
    return true;
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
function classify(
  session: ReadOnlySessionResult<ReadOnlyHarnessSessionOutcome>,
  meter: SessionMeter,
): Classified {
  if (session.ok) {
    // The harness's own bounds (tool calls, model calls, context) end it as `limit-exceeded`.
    return session.value.outcome === "limit-exceeded"
      ? BUDGET_EXHAUSTED
      : { effect: "none", fallbackReason: "insufficient-context" };
  }
  if (session.terminal === "stopped") {
    return session.reasonCode === "timeout" ? DEADLINE_EXCEEDED : CANCELLED;
  }
  if (session.terminal === "limit-reached" || meter.budgetRefused) return BUDGET_EXHAUSTED;
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
        runner: deps.runner(),
        worktreeRoot: input.worktreeRoot,
        headSha: input.headSha,
        fingerprint: input.candidate.fingerprint,
        reader: input.reader,
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
        const failureClass = classify(thrown, meter).failure ?? "model-failed";
        logCounterCheckFailed(deps.activityLog, sessionFacts(session, input), failureClass, error);
      },
    },
    (gate, signal) =>
      runReadOnlyHarnessSession({
        model,
        reservePromptTokens: reserver(limits, input.budget, meter),
        sessionId: session.correlationId,
        objective: renderCounterCheckTask(input.candidate.report),
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

/** Runs one counter-check session and logs its outcome; never throws for a session failure. */
export async function counterCheckCandidate(
  deps: CounterCheckDeps,
  input: CounterCheckInput,
): Promise<CounterCheckOutcome> {
  const now = deps.now ?? Date.now;
  const session: CounterCheckSession = {
    correlationId: `review-counter-check-${randomUUID()}`,
    startedAt: now(),
    now,
    limits: { ...DEFAULT_COUNTER_CHECK_LIMITS, ...deps.limits },
    state: { verdict: undefined, invalidVerdicts: 0, toolCalls: 0 },
    meter: { promptTokens: 0, completionTokens: 0, reserved: 0, budgetRefused: false },
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
    return finish(deps, input, session, verdict, "model-failed");
  }
  const ended = await runSession(deps, input, model, session);
  const classified = classify(ended, session.meter);
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
  return finish(deps, input, session, verdict, effect);
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
  effect: CounterCheckEffect,
): Promise<CounterCheckOutcome> {
  const facts = sessionFacts(session, input);
  const meter = session.meter;
  const evidenceInHead =
    verdict.evidence.length > 0 &&
    (await evidenceLiesInHead(input.reader, verdict.evidence, undefined));
  const outcome: CounterCheckOutcome = {
    verdict,
    evidenceInHead,
    effect,
    toolCallCount: facts.toolCallCount,
    durationMs: facts.durationMs,
    promptTokens: Math.max(meter.promptTokens, meter.reserved),
    completionTokens: meter.completionTokens,
  };
  logCounterCheckCompleted(deps.activityLog, facts, outcome);
  return outcome;
}
