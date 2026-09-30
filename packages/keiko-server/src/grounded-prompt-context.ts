// The prompt share of a grounded answer whose excerpts its own path rendered: folder, multi-source
// and hybrid answers (PR #3678 review). Only the Knowledge Pod path reported its share, so the
// context meter showed 0 knowledge tokens for every other grounded chat and left the excerpts it
// had actually sent out of the next question's estimate. The share is taken from the messages the
// path really sent after fitting them to the model's input budget, never from the retrieval result
// before fitting. Counts only, never an excerpt; the token counts are the gateway admission's own.

import type { ContextProfile } from "@oscharko-dev/keiko-contracts";
import type { GroundedPromptContextWire } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { GatewayPromptTokenInput } from "@oscharko-dev/keiko-model-gateway/internal/prompt-token-accounting";

import { knowledgePromptShare } from "./knowledge-prompt-window.js";

export interface SentGroundedPrompt {
  /** The messages exactly as the model received them. */
  readonly messages: GatewayPromptTokenInput["messages"];
  /** The same prompt rendered without any excerpt: the question, instructions and framing. */
  readonly withoutSources: GatewayPromptTokenInput["messages"];
  readonly sentReferenceCount: number;
  /** References the path had before fitting; more than sent means the window trimmed them. */
  readonly availableReferenceCount: number;
}

/**
 * The share a sent grounded prompt took: the whole request, its excerpts and its instructions,
 * estimated with the admission accounting, and the provider-measured prompt when the answer
 * reported one.
 */
export function sentPromptContext(
  prompt: SentGroundedPrompt,
  measuredPromptTokens: number,
  accounting: ContextProfile["tokenAccounting"] | undefined,
): GroundedPromptContextWire {
  const share = knowledgePromptShare(
    { messages: prompt.messages },
    { messages: prompt.withoutSources },
    accounting,
  );
  const measured = measuredPromptTokens > 0;
  return {
    promptTokens: measured ? measuredPromptTokens : share.estimatedTokens,
    promptTokensMeasured: measured,
    estimatedPromptTokens: share.estimatedTokens,
    instructionTokens: share.instructionTokens,
    sourceTokens: share.sourceTokens,
    sentReferenceCount: prompt.sentReferenceCount,
    availableReferenceCount: prompt.availableReferenceCount,
  };
}
