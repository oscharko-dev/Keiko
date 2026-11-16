import type { GatewayConfig } from "@oscharko-dev/keiko-model-gateway";
import type { CodingSafeActivityContent } from "./coding-runtime/codingSafeActivityProjection.js";

export function requiresReasoningContinuation(config: GatewayConfig, model: string): boolean {
  return (
    config.providers.find((provider) => provider.modelId === model)?.reasoningContinuation ===
    "required-with-tools"
  );
}

/** Hide presentation without removing the native runtime's required continuation state. */
export function presentCodingReasoning(
  content: CodingSafeActivityContent | null,
  visible: boolean,
): CodingSafeActivityContent | null {
  if (content === null || visible || content.feed.availability !== "available") return content;
  return {
    ...content,
    feed: {
      ...content.feed,
      turns: content.feed.turns.map((turn) => ({
        ...turn,
        messages: turn.messages.map(({ reasoning: _hidden, ...message }) => message),
      })),
    },
  };
}
