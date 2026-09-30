// The prompt share of a grounded answer whose excerpts its own path rendered: folder, multi-source
// and hybrid answers (PR #3678 review). Only the Knowledge Pod path reported its share, so the
// context meter showed 0 knowledge tokens for every other grounded chat and left the excerpts it
// had actually sent out of the next question's estimate. Counts only, never an excerpt; the token
// count is the gateway admission's own (`countGatewayPromptTokens`).

import type { ContextProfile } from "@oscharko-dev/keiko-contracts";
import type { GroundedPromptContextWire } from "@oscharko-dev/keiko-contracts/bff-wire";
import { countGatewayPromptTokens } from "@oscharko-dev/keiko-model-gateway/internal/prompt-token-accounting";

export interface RenderedSourcePrompt {
  /** The excerpt blocks exactly as the prompt rendered them. */
  readonly sourceText: string;
  /** The system instructions of that prompt. */
  readonly instructions: string;
  readonly referenceCount: number;
  /** The provider's prompt usage for the answer; 0 when it reported none. */
  readonly measuredPromptTokens: number;
}

function countedTokens(
  role: "system" | "user",
  content: string,
  accounting: ContextProfile["tokenAccounting"] | undefined,
): number {
  if (content.length === 0) return 0;
  return countGatewayPromptTokens({ messages: [{ role, content }] }, accounting);
}

/**
 * The share a rendered grounded prompt took: its excerpts and instructions, estimated with the
 * admission accounting, and the provider-measured prompt when the answer reported one. These paths
 * never trim references to the window, so every rendered reference counts as sent.
 */
export function renderedSourcePromptContext(
  prompt: RenderedSourcePrompt,
  accounting: ContextProfile["tokenAccounting"] | undefined,
): GroundedPromptContextWire {
  const sourceTokens = countedTokens("user", prompt.sourceText, accounting);
  const instructionTokens = countedTokens("system", prompt.instructions, accounting);
  const measured = prompt.measuredPromptTokens > 0;
  return {
    promptTokens: measured ? prompt.measuredPromptTokens : sourceTokens + instructionTokens,
    promptTokensMeasured: measured,
    instructionTokens,
    sourceTokens,
    sentReferenceCount: prompt.referenceCount,
    availableReferenceCount: prompt.referenceCount,
  };
}
