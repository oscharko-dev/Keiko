import type { GatewayConfig } from "@oscharko-dev/keiko-model-gateway";
import type { CodingAppSessionContentSource } from "./coding-app-session/sessionChannel.js";
import type {
  CodingSafeActivityContent,
  CodingSafeActivityProjection,
} from "./coding-runtime/codingSafeActivityProjection.js";

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
  const textDeltas = content.textDeltas?.filter((delta) => delta.part !== "reasoning");
  const { textDeltas: _all, ...rest } = content;
  return {
    ...rest,
    feed: {
      ...content.feed,
      turns: content.feed.turns.map((turn) => ({
        ...turn,
        messages: turn.messages.map(
          ({ reasoning: _hidden, fullReasoning: _hiddenLength, ...message }) => message,
        ),
      })),
    },
    ...(textDeltas === undefined || textDeltas.length === 0 ? {} : { textDeltas }),
  };
}

/**
 * The authenticated channel's view of the safe-activity projection, with the deployment's reasoning
 * display applied. Reasoning the deployment does not show is never served, as a snapshot, a delta
 * or a page.
 */
export function codingSafeActivityContentSource(
  projection: CodingSafeActivityProjection | undefined,
  visible: () => boolean,
): CodingAppSessionContentSource | undefined {
  return projection === undefined
    ? undefined
    : {
        contentFor: () => presentCodingReasoning(projection.currentContent(), visible()),
        subscribeContent: (listener) =>
          projection.subscribeContent((content) => {
            listener(presentCodingReasoning(content, visible()));
          }),
        answerPageFor: ({ runId, ...request }) =>
          request.part === "reasoning" && !visible() ? null : projection.answerPage(runId, request),
      };
}
