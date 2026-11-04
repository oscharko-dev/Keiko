import { DEFAULT_LIMITS, type HarnessLimits } from "@oscharko-dev/keiko-contracts/runtime/harness";
import type { ChatToolAuthorityEnvelope } from "@oscharko-dev/keiko-contracts/runtime/chat-tool-authority";

/**
 * The Authority Envelope budget of one accepted Chat tool turn (#4175). It is sized for backlog
 * work — dozens of reads and approved writes with a slow local model — and it is the only turn
 * bound: the loop derives its iteration and model-call ceilings from it instead of the coding
 * harness defaults. The human can stop the turn at any time; approval semantics are unchanged.
 */
export const CHAT_TOOL_TURN_BUDGET: ChatToolAuthorityEnvelope["budget"] = Object.freeze({
  maxRuntimeMs: 60 * 60_000,
  maxToolCalls: 250,
  maxPromptTokens: 5_000_000,
  maxPatchBytes: 0,
});

/**
 * The composed budget, narrowed field by field to the default: the default is also what the stored
 * transcript admits, so a composition can tighten a turn but never widen it.
 */
export function chatToolTurnBudget(deps: {
  readonly chatToolTurnBudget?: ChatToolAuthorityEnvelope["budget"] | undefined;
}): ChatToolAuthorityEnvelope["budget"] {
  const composed = deps.chatToolTurnBudget;
  if (composed === undefined) return CHAT_TOOL_TURN_BUDGET;
  const ceiling = CHAT_TOOL_TURN_BUDGET;
  const narrows =
    composed.maxRuntimeMs <= ceiling.maxRuntimeMs &&
    composed.maxToolCalls <= ceiling.maxToolCalls &&
    composed.maxPromptTokens <= ceiling.maxPromptTokens;
  if (narrows) return composed;
  return Object.freeze({
    maxRuntimeMs: Math.min(composed.maxRuntimeMs, ceiling.maxRuntimeMs),
    maxToolCalls: Math.min(composed.maxToolCalls, ceiling.maxToolCalls),
    maxPromptTokens: Math.min(composed.maxPromptTokens, ceiling.maxPromptTokens),
    maxPatchBytes: 0,
  });
}

/** Every round dispatches at least one tool call or ends; each round may need one repair. */
export function chatToolTurnLimits(budget: ChatToolAuthorityEnvelope["budget"]): HarnessLimits {
  const maxIterations = budget.maxToolCalls + 1;
  return Object.freeze({
    ...DEFAULT_LIMITS,
    maxIterations,
    maxModelCalls: maxIterations * 2,
    maxToolCalls: budget.maxToolCalls,
    maxWallTimeMs: budget.maxRuntimeMs,
  });
}
