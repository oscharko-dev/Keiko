import type { ConnectedContextPack } from "@oscharko-dev/keiko-contracts/connected-context";
import type {
  GroundedAnswerEvidenceDeclaration,
  GroundedInsufficiencyDeclaration,
  GroundedPromptContextWire,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import type { InsufficiencyDeclarationResult } from "./grounded-faithfulness.js";
import {
  CancelledError,
  ContextOverflowError,
  TimeoutError,
  GatewayError,
  ProviderError,
  type GatewayCallRequest,
} from "@oscharko-dev/keiko-model-gateway";

export interface GroundedAnswerUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
}

/** Charge the sent-prompt estimate as a floor; unreported failed output remains unknown. */
export function groundedSynthesisAttemptUsage(
  promptTokens: number,
  reported?: Readonly<Partial<GroundedAnswerUsage>>,
): GroundedAnswerUsage {
  return {
    promptTokens: Math.max(
      promptTokens,
      isFiniteCount(reported?.promptTokens) ? reported.promptTokens : 0,
    ),
    completionTokens: isFiniteCount(reported?.completionTokens) ? reported.completionTokens : 0,
  };
}

/** Factory-owned synthesis attempts, including context-window retries; not gateway authority. */
export interface GroundedSynthesisCallBudget {
  readonly completed: () => number;
  readonly recordCompleted: () => void;
  readonly remaining: () => number;
  readonly tryReserve: () => boolean;
  readonly pendingUsage: () => GroundedAnswerUsage;
  readonly recordUsage: (usage: GroundedAnswerUsage) => void;
  readonly takeUsage: () => GroundedAnswerUsage;
  readonly releaseReservation: () => void;
  readonly reservedOutputTokens: () => number;
  readonly recordOutputReservation: (tokens: number) => void;
}

export function createGroundedSynthesisCallBudget(): GroundedSynthesisCallBudget {
  let calls = 0;
  let completed = 0;
  let reservedOutput = 0;
  let usage: GroundedAnswerUsage = { promptTokens: 0, completionTokens: 0 };
  return {
    completed: (): number => completed,
    recordCompleted(): void {
      completed += 1;
    },
    remaining: (): number => 2 - calls,
    reservedOutputTokens: (): number => reservedOutput,
    recordOutputReservation(tokens): void {
      reservedOutput += tokens;
    },
    releaseReservation(): void {
      calls = Math.max(0, calls - 1);
    },
    tryReserve: (): boolean => {
      if (calls >= 2) return false;
      calls += 1;
      return true;
    },
    pendingUsage: (): GroundedAnswerUsage => ({ ...usage }),
    recordUsage(next): void {
      usage = {
        promptTokens: usage.promptTokens + next.promptTokens,
        completionTokens: usage.completionTokens + next.completionTokens,
      };
    },
    takeUsage(): GroundedAnswerUsage {
      const pending = usage;
      usage = { promptTokens: 0, completionTokens: 0 };
      return pending;
    },
  };
}

export interface GroundedSynthesisAttemptOptions {
  readonly inputTokensMax: number;
  readonly outputTokensMax: number;
  readonly signal?: AbortSignal | undefined;
  readonly deadlineAtMs?: number | undefined;
  readonly nowMs?: (() => number) | undefined;
}

export interface GroundedSynthesisAttemptTracker {
  readonly admission: NonNullable<GatewayCallRequest["attemptAdmission"]>;
  /** Injected model ports may not implement the gateway's physical-attempt callback. */
  settleFallbackFailure(promptTokens: number, failure: unknown): void;
  settleFallback(
    promptTokens: number,
    reported?: Readonly<Partial<GroundedAnswerUsage>>,
    outputState?: "observed" | "none" | "unknown",
  ): void;
}

export function createGroundedSynthesisAttemptAdmission(
  budget: GroundedSynthesisCallBudget,
  options: GroundedSynthesisAttemptOptions,
): GroundedSynthesisAttemptTracker {
  let gatewayOwned = false;
  const admission: NonNullable<GatewayCallRequest["attemptAdmission"]> = (input) => {
    gatewayOwned = true;
    assertSynthesisAttemptActive(options);
    const pending = budget.pendingUsage();
    if (
      input.promptTokens > options.inputTokensMax - pending.promptTokens ||
      options.outputTokensMax <= pending.completionTokens ||
      !budget.tryReserve()
    )
      return undefined;
    return synthesisAttemptReservation(
      budget,
      input.promptTokens,
      Math.min(input.maxOutputTokens, options.outputTokensMax - pending.completionTokens),
    );
  };
  const settleFallback: GroundedSynthesisAttemptTracker["settleFallback"] = (
    promptTokens,
    reported,
    outputState = "observed",
  ): void => {
    if (gatewayOwned) return;
    const reservation = admission({ promptTokens, maxOutputTokens: options.outputTokensMax });
    if (reservation === undefined)
      throw new ContextOverflowError("Synthesis attempt grant exhausted before dispatch");
    reservation.settle(groundedSynthesisAttemptUsage(promptTokens, reported), true, outputState);
  };
  return {
    admission,
    settleFallback,
    settleFallbackFailure(promptTokens, failure): void {
      settleFallback(
        promptTokens,
        failure instanceof GatewayError ? failure.partialUsage : undefined,
        failedSynthesisOutputState(failure),
      );
    },
  };
}

/** Injected model ports have no gateway-owned attempt settlement. */
function failedSynthesisOutputState(failure: unknown): "observed" | "none" | "unknown" {
  if (failure instanceof GatewayError && (failure.partialUsage?.completionTokens ?? 0) > 0)
    return "observed";
  if (failure instanceof ContextOverflowError && failure.partialUsage === undefined) return "none";
  if (
    failure instanceof ProviderError &&
    failure.httpStatus >= 400 &&
    failure.partialUsage === undefined
  )
    return "none";
  return "unknown";
}

function assertSynthesisAttemptActive(options: GroundedSynthesisAttemptOptions): void {
  if (options.signal?.aborted === true) throw new CancelledError("Synthesis request cancelled");
  if (options.deadlineAtMs !== undefined && (options.nowMs ?? Date.now)() >= options.deadlineAtMs)
    throw new TimeoutError("Synthesis deadline elapsed before provider dispatch");
}

function synthesisAttemptReservation(
  budget: GroundedSynthesisCallBudget,
  promptTokens: number,
  maxOutputTokens: number,
): NonNullable<ReturnType<NonNullable<GatewayCallRequest["attemptAdmission"]>>> {
  let settled = false;
  return {
    maxOutputTokens,
    settle(reported, dispatched, outputState = "observed"): void {
      if (settled) return;
      settled = true;
      if (dispatched && outputState === "unknown") budget.recordOutputReservation(maxOutputTokens);
      if (dispatched)
        budget.recordUsage(
          groundedSynthesisAttemptUsage(
            promptTokens,
            outputState === "unknown"
              ? { ...reported, completionTokens: maxOutputTokens }
              : reported,
          ),
        );
      else budget.releaseReservation();
    },
  };
}

export function combinedGroundedSynthesisFields(
  first: GroundedAnswerResult,
  next: GroundedAnswerResult,
): Pick<
  GroundedAnswerResult,
  "usage" | "synthesisCallCount" | "completedSynthesisCallCount" | "synthesisReservedOutputTokens"
> {
  return {
    usage: {
      promptTokens: first.usage.promptTokens + next.usage.promptTokens,
      completionTokens: first.usage.completionTokens + next.usage.completionTokens,
    },
    ...(first.synthesisCallCount === undefined && next.synthesisCallCount === undefined
      ? {}
      : { synthesisCallCount: (first.synthesisCallCount ?? 0) + (next.synthesisCallCount ?? 0) }),
    completedSynthesisCallCount:
      completedGroundedSynthesisCount(first) + completedGroundedSynthesisCount(next),
    ...(first.synthesisReservedOutputTokens === undefined &&
    next.synthesisReservedOutputTokens === undefined
      ? {}
      : {
          synthesisReservedOutputTokens:
            (first.synthesisReservedOutputTokens ?? 0) + (next.synthesisReservedOutputTokens ?? 0),
        }),
  };
}

interface FailedSynthesisAccounting {
  readonly completedSynthesisCalls?: (() => number) | undefined;
  readonly remainingSynthesisCalls?: (() => number) | undefined;
  readonly takeFailedSynthesisUsage?: (() => GroundedAnswerUsage) | undefined;
  readonly reservedSynthesisOutputTokens?: (() => number) | undefined;
}

function failedSynthesisCountFields(
  accounting: FailedSynthesisAccounting | undefined,
): Pick<
  GroundedAnswerResult,
  "synthesisCallCount" | "completedSynthesisCallCount" | "synthesisReservedOutputTokens"
> {
  const remaining = accounting?.remainingSynthesisCalls?.();
  const reserved = accounting?.reservedSynthesisOutputTokens?.();
  const completed = accounting?.completedSynthesisCalls?.();
  return {
    ...(remaining === undefined ? {} : { synthesisCallCount: 2 - remaining }),
    ...(reserved === undefined ? {} : { synthesisReservedOutputTokens: reserved }),
    ...(completed === undefined ? {} : { completedSynthesisCallCount: completed }),
  };
}

export function retainFailedGroundedSynthesis(
  answer: GroundedAnswerResult,
  accounting?: FailedSynthesisAccounting,
): GroundedAnswerResult {
  const usage = accounting?.takeFailedSynthesisUsage?.() ?? {
    promptTokens: 0,
    completionTokens: 0,
  };
  return {
    ...answer,
    usage: {
      promptTokens: answer.usage.promptTokens + usage.promptTokens,
      completionTokens: answer.usage.completionTokens + usage.completionTokens,
    },
    ...failedSynthesisCountFields(accounting),
  };
}

export interface GroundedAnswerResult extends GroundedAnswerEvidenceDeclaration {
  /** Completed synthesis responses; failed physical retry attempts are not completed calls. */
  readonly completedSynthesisCallCount?: number | undefined;
  readonly synthesisCallCount?: number | undefined;
  readonly synthesisReservedOutputTokens?: number | undefined;
  readonly sentEvidencePacks?: readonly ConnectedContextPack[] | undefined;
  readonly filesInPrompt?: number | undefined;
  readonly modelInvoked?: boolean | undefined;
  readonly noEvidence?: boolean | undefined;
  /** Internal verified inventory; never projected as a wire field or included in logs. */
  readonly evidenceScopeIndex?:
    ReadonlyMap<string, GroundedInsufficiencyDeclaration["state"]> | undefined;
  readonly insufficiencyObservation?:
    Omit<InsufficiencyDeclarationResult, "declarations"> | undefined;
  readonly content: string;
  readonly usage: GroundedAnswerUsage;
  // GEN-AI-GATEWAY-001 (RB-4): the provider finishReason for the completion. When "length" the
  // answer was truncated and must be surfaced (incomplete-answer marker) rather than consumed as a
  // complete grounded answer. Optional/absent on deterministic test answerers and legacy payloads.
  readonly finishReason?: string | undefined;
  // The share the sent prompt took, for the context meter (grounded-prompt-context.ts). Counts only.
  readonly promptContext?: GroundedPromptContextWire | undefined;
}

export type GroundedAnswerPayload = string | GroundedAnswerResult;

export function completedGroundedSynthesisCount(answer: GroundedAnswerResult): number {
  return answer.completedSynthesisCallCount ?? (answer.modelInvoked === false ? 0 : 1);
}

const SAFE_GROUNDED_FALLBACK =
  "I could not produce a clean grounded answer from the retrieved repository evidence.";

const ORCHESTRATION_PREFIX_RE =
  /^(searching for\b|search query\b|we need to call search\b|let'?s search\b|calling search\b|tool call\b|plan\b:|system prompt\b:|developer prompt\b:|internal planning\b:|internal reasoning\b:|hidden instruction\b:)/i;

const PROMPT_DISCLOSURE_RE =
  /^(system prompt\b:|developer prompt\b:|internal planning\b:|internal reasoning\b:|hidden instruction\b:)/i;

const ARGUMENT_LINE_RE =
  /^(?:[{[]|["']?(?:path|query|max_results|maxResults|tool|arguments|scope|search)["']?\s*:)/i;

function isFiniteCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isOrchestrationLine(line: string): boolean {
  return ORCHESTRATION_PREFIX_RE.test(line);
}

function isArgumentLine(line: string): boolean {
  if (ARGUMENT_LINE_RE.test(line)) {
    return true;
  }
  return line === "}" || line === "]" || line === "}," || line === "],";
}

function shouldStripLeadingLine(trimmed: string, stripping: boolean): boolean {
  if (trimmed.length === 0) {
    return true;
  }
  if (!stripping) {
    return isOrchestrationLine(trimmed);
  }
  return (
    isOrchestrationLine(trimmed) ||
    isArgumentLine(trimmed) ||
    trimmed.startsWith("{") ||
    trimmed.startsWith("[")
  );
}

function leadingContentIndex(lines: readonly string[]): number {
  let index = 0;
  let stripping = false;
  while (index < lines.length) {
    const trimmed = lines[index]?.trim() ?? "";
    const shouldStrip = shouldStripLeadingLine(trimmed, stripping);
    if (!shouldStrip) {
      return index;
    }
    stripping ||= isOrchestrationLine(trimmed);
    index += 1;
  }
  return index;
}

export function sanitizeGroundedAnswerContent(content: string): string {
  const lines = content.split("\n");
  const index = leadingContentIndex(lines);
  const sanitized = lines
    .slice(index)
    .filter((line) => !PROMPT_DISCLOSURE_RE.test(line.trim()))
    .join("\n")
    .trim();
  return sanitized.length > 0 ? sanitized : SAFE_GROUNDED_FALLBACK;
}

export function normalizeGroundedAnswerPayload(
  payload: GroundedAnswerPayload,
): GroundedAnswerResult {
  if (typeof payload === "string") {
    return {
      content: sanitizeGroundedAnswerContent(payload.trim()),
      usage: { promptTokens: 0, completionTokens: 0 },
    };
  }
  return {
    content: sanitizeGroundedAnswerContent(payload.content.trim()),
    usage: {
      promptTokens: isFiniteCount(payload.usage.promptTokens) ? payload.usage.promptTokens : 0,
      completionTokens: isFiniteCount(payload.usage.completionTokens)
        ? payload.usage.completionTokens
        : 0,
    },
    ...(payload.finishReason === undefined ? {} : { finishReason: payload.finishReason }),
    ...(payload.promptContext === undefined ? {} : { promptContext: payload.promptContext }),
    ...(payload.synthesisCallCount === undefined
      ? {}
      : { synthesisCallCount: payload.synthesisCallCount }),
    ...(payload.completedSynthesisCallCount === undefined
      ? {}
      : { completedSynthesisCallCount: payload.completedSynthesisCallCount }),
    ...(payload.synthesisReservedOutputTokens === undefined
      ? {}
      : { synthesisReservedOutputTokens: payload.synthesisReservedOutputTokens }),
    ...normalizedEvidenceDeclaration(payload),
  };
}

function normalizedEvidenceDeclaration(
  payload: GroundedAnswerResult,
): Pick<
  GroundedAnswerResult,
  | "answerKind"
  | "citationBehaviour"
  | "insufficiencyDeclarations"
  | "evidenceScopeIndex"
  | "insufficiencyObservation"
  | "sentEvidencePacks"
  | "filesInPrompt"
  | "modelInvoked"
  | "noEvidence"
> {
  return {
    ...(payload.sentEvidencePacks === undefined
      ? {}
      : { sentEvidencePacks: payload.sentEvidencePacks }),
    ...(payload.filesInPrompt === undefined ? {} : { filesInPrompt: payload.filesInPrompt }),
    ...(payload.modelInvoked === undefined ? {} : { modelInvoked: payload.modelInvoked }),
    ...(payload.noEvidence === undefined ? {} : { noEvidence: payload.noEvidence }),
    ...(payload.answerKind === undefined ? {} : { answerKind: payload.answerKind }),
    ...(payload.citationBehaviour === undefined
      ? {}
      : { citationBehaviour: payload.citationBehaviour }),
    ...(payload.insufficiencyDeclarations === undefined
      ? {}
      : { insufficiencyDeclarations: payload.insufficiencyDeclarations }),
    ...(payload.evidenceScopeIndex === undefined
      ? {}
      : { evidenceScopeIndex: payload.evidenceScopeIndex }),
    ...(payload.insufficiencyObservation === undefined
      ? {}
      : { insufficiencyObservation: payload.insufficiencyObservation }),
  };
}

/** True when the payload string produced only the safe fallback (no clean grounded answer). */
export function isSafeGroundedFallback(content: string): boolean {
  return content === SAFE_GROUNDED_FALLBACK;
}
