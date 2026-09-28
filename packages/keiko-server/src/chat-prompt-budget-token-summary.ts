import type {
  ContextProfile,
  ContextTokenAccounting,
  ConversationDocumentContextWire,
  DiscussionMode,
} from "@oscharko-dev/keiko-contracts";
import { countGatewayPromptTokens } from "@oscharko-dev/keiko-model-gateway/internal/prompt-token-accounting";
import type { ConversationMemoryContextEntryWire } from "@oscharko-dev/keiko-contracts/bff-wire";
import { CONVERSATION_SYSTEM_PROMPT, composeConversationPrompt } from "./conversation-prompt.js";
import {
  withGatewayConversationImages,
  type GatewayConversationMessage,
} from "./conversation-gateway.js";
import type { ConversationCompactionOutcome } from "./conversation-compaction.js";

export function estimateFinalPromptTokens(
  finalMessages: readonly GatewayConversationMessage[],
  tokenAccounting: ContextTokenAccounting | undefined,
): number {
  return countGatewayPromptTokens({ messages: finalMessages }, tokenAccounting);
}

export function estimateHistoryLaneTokens(input: {
  readonly historyOutcome: ConversationCompactionOutcome;
  readonly systemTokens: number;
  readonly tokenAccounting: ContextTokenAccounting | undefined;
}): number {
  const historyMessageTokens = estimateFinalPromptTokens(
    input.historyOutcome.messages,
    input.tokenAccounting,
  );
  return input.historyOutcome.messages.at(0)?.role === "system"
    ? Math.max(0, historyMessageTokens - input.systemTokens)
    : historyMessageTokens;
}

interface TokenSummaryInput {
  readonly historyOutcome: ConversationCompactionOutcome;
  readonly memoryEntries: readonly ConversationMemoryContextEntryWire[];
  readonly compactionContextText?: string | undefined;
  readonly documentContext: readonly ConversationDocumentContextWire[];
  readonly request: {
    readonly content: string;
    readonly discussionMode: DiscussionMode | undefined;
  };
  readonly finalMessages: readonly GatewayConversationMessage[];
  readonly profile: ContextProfile;
}

function userProjectionTokens(input: TokenSummaryInput, includeMemory: boolean): number {
  const memory =
    includeMemory && input.memoryEntries.length > 0
      ? [
          "# Relevant memories",
          ...input.memoryEntries.map(
            (entry) => `- (${entry.inclusionReason}) ${entry.bodyExcerpt}`,
          ),
        ].join("\n")
      : undefined;
  const content = composeConversationPrompt(
    input.request.content,
    [],
    memory,
    input.request.discussionMode,
  );
  const images =
    input.finalMessages.at(-1)?.contentParts?.filter((part) => part.type === "image_url") ?? [];
  return estimateFinalPromptTokens(
    withGatewayConversationImages([{ role: "user", content }], images),
    input.profile.tokenAccounting,
  );
}

function currentTurnLaneTokens(input: TokenSummaryInput): {
  latestTurnTokens: number;
  memoryTokens: number;
  documentTokens: number;
} {
  const current = input.finalMessages.at(-1);
  const total = estimateFinalPromptTokens(
    current === undefined ? [] : [current],
    input.profile.tokenAccounting,
  );
  // Attribute incremental serialization costs in assembly order. Bounds keep lane sums exact even
  // when calibrated token estimates are not additive across the text blocks of one message.
  const latestTurnTokens = Math.min(total, userProjectionTokens(input, false));
  const memoryTokens = Math.min(
    total - latestTurnTokens,
    Math.max(0, userProjectionTokens(input, true) - latestTurnTokens),
  );
  const resurfacedTokens = estimateFinalPromptTokens(
    input.compactionContextText === undefined
      ? []
      : [{ role: "system", content: input.compactionContextText }],
    input.profile.tokenAccounting,
  );
  return {
    latestTurnTokens,
    memoryTokens: memoryTokens + resurfacedTokens,
    documentTokens: total - latestTurnTokens - memoryTokens,
  };
}

export function buildPromptAssemblyTokenSummary(input: TokenSummaryInput): {
  readonly historyTokens: number;
  readonly memoryTokens: number;
  readonly documentTokens: number;
  readonly latestTurnTokens: number;
  readonly systemTokens: number;
  readonly totalEstimatedTokens: number;
} {
  const tokenAccounting = input.profile.tokenAccounting;
  const systemTokens = estimateFinalPromptTokens(
    [{ role: "system", content: CONVERSATION_SYSTEM_PROMPT }],
    tokenAccounting,
  );
  return {
    systemTokens,
    historyTokens: estimateHistoryLaneTokens({
      historyOutcome: input.historyOutcome,
      systemTokens,
      tokenAccounting,
    }),
    ...currentTurnLaneTokens(input),
    totalEstimatedTokens: estimateFinalPromptTokens(input.finalMessages, tokenAccounting),
  };
}
