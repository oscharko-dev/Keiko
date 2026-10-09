import type { ModelPort } from "@oscharko-dev/keiko-harness";
import type { ContextProfile } from "@oscharko-dev/keiko-contracts";
import {
  ContextOverflowError,
  CancelledError,
  TimeoutError,
  type GatewayCallRequest,
  type NormalizedResponse,
} from "@oscharko-dev/keiko-model-gateway";
import { countGatewayPromptTokens } from "@oscharko-dev/keiko-model-gateway/internal/prompt-token-accounting";
import {
  createGroundedSynthesisAttemptAdmission,
  type GroundedSynthesisAttemptOptions,
  type GroundedSynthesisCallBudget,
  type GroundedAnswerResult,
} from "./grounded-answer.js";
import type { GroundedAnswerer } from "./grounded-orchestrator.js";

type PluralSynthesisMetadata = Pick<
  GroundedAnswerer,
  | "remainingSynthesisCalls"
  | "pendingSynthesisUsage"
  | "takeFailedSynthesisUsage"
  | "reservedSynthesisOutputTokens"
>;

export function pluralSynthesisMetadata(source: PluralSynthesisMetadata): PluralSynthesisMetadata {
  return {
    ...(source.remainingSynthesisCalls === undefined
      ? {}
      : { remainingSynthesisCalls: source.remainingSynthesisCalls }),
    ...(source.pendingSynthesisUsage === undefined
      ? {}
      : { pendingSynthesisUsage: source.pendingSynthesisUsage }),
    ...(source.takeFailedSynthesisUsage === undefined
      ? {}
      : { takeFailedSynthesisUsage: source.takeFailedSynthesisUsage }),
    ...(source.reservedSynthesisOutputTokens === undefined
      ? {}
      : { reservedSynthesisOutputTokens: source.reservedSynthesisOutputTokens }),
  };
}

export function withPluralSynthesisUsage(
  answer: GroundedAnswerResult,
  budget: GroundedSynthesisCallBudget,
  remainingBefore: number,
  reservedBefore: number,
): GroundedAnswerResult {
  return {
    ...answer,
    usage: budget.takeUsage(),
    synthesisCallCount: remainingBefore - budget.remaining(),
    synthesisReservedOutputTokens: budget.reservedOutputTokens() - reservedBefore,
  };
}

interface PluralSynthesisCall {
  readonly model: ModelPort;
  readonly request: GatewayCallRequest;
  readonly signal: AbortSignal;
  readonly budget: GroundedSynthesisCallBudget;
  readonly grants: GroundedSynthesisAttemptOptions;
  readonly accounting: ContextProfile["tokenAccounting"] | undefined;
}

/** Uses the shared physical-attempt admission; injected ports settle the same ledger. */
export async function callPluralGroundedSynthesis(
  input: PluralSynthesisCall,
): Promise<NormalizedResponse> {
  if (input.budget.remaining() <= 0)
    throw new ContextOverflowError("Grounded synthesis attempt grant is exhausted");
  const tracker = createGroundedSynthesisAttemptAdmission(input.budget, input.grants);
  const promptTokens = countGatewayPromptTokens(input.request, input.accounting);
  const pending = input.budget.pendingUsage();
  if (
    promptTokens > input.grants.inputTokensMax - pending.promptTokens ||
    (input.request.maxOutputTokens ?? 0) <= 0
  )
    throw new ContextOverflowError("Grounded synthesis token grant is exhausted");
  if (input.signal.aborted) throw new CancelledError("Grounded synthesis cancelled");
  if (input.grants.deadlineAtMs !== undefined && Date.now() >= input.grants.deadlineAtMs)
    throw new TimeoutError("Grounded synthesis deadline exhausted");
  try {
    const response = await input.model.call(
      { ...input.request, attemptAdmission: tracker.admission },
      input.signal,
    );
    tracker.settleFallback(promptTokens, response.usage);
    return response;
  } catch (error) {
    tracker.settleFallbackFailure(promptTokens, error);
    throw error;
  }
}
