import {
  countContextTokens,
  countContextTokensForSegments,
  type ContextProfile,
  type ContextTokenAccounting,
} from "@oscharko-dev/keiko-contracts";
import type {
  ConversationDocumentContextWire,
  DiscussionMode,
} from "@oscharko-dev/keiko-contracts";
import type { ConversationMemoryContextEntryWire } from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  CONVERSATION_CONTEXT_BLOCK_HEADER,
  CONVERSATION_SYSTEM_PROMPT,
  composeConversationPrompt,
  renderConversationDocumentContextBlock,
} from "./conversation-prompt.js";
import type { GatewayConversationMessage } from "./conversation-gateway.js";
import type { ConversationCompactionOutcome } from "./conversation-compaction.js";

export function textTokens(
  text: string | undefined,
  tokenAccounting: ContextTokenAccounting | undefined,
): number {
  return countContextTokensForSegments(text === undefined ? [] : [text], tokenAccounting);
}

export function renderMemoryContextText(
  memories: readonly ConversationMemoryContextEntryWire[],
  compactionContextText: string | undefined,
): string | undefined {
  if (memories.length === 0 && compactionContextText === undefined) {
    return undefined;
  }
  const lines: string[] = [];
  if (memories.length > 0) {
    lines.push("# Relevant memories");
    for (const memory of memories) {
      lines.push(`- (${memory.inclusionReason}) ${memory.bodyExcerpt}`);
    }
  }
  if (compactionContextText !== undefined) {
    if (lines.length > 0) {
      lines.push("");
    }
    lines.push(compactionContextText);
  }
  return lines.join("\n");
}

export function renderDocumentContextText(
  documentContext: readonly ConversationDocumentContextWire[],
): string | undefined {
  if (documentContext.length === 0) {
    return undefined;
  }
  const blocks = documentContext.map(renderConversationDocumentContextBlock);
  return `${CONVERSATION_CONTEXT_BLOCK_HEADER}\n${blocks.join("\n")}`;
}

export function estimateUserTaskTokens(input: {
  readonly content: string;
  readonly discussionMode: DiscussionMode | undefined;
  readonly tokenAccounting: ContextTokenAccounting | undefined;
}): number {
  return countContextTokensForSegments(
    [composeConversationPrompt(input.content, [], undefined, input.discussionMode)],
    input.tokenAccounting,
  );
}

export function estimateFinalPromptTokens(
  finalMessages: readonly GatewayConversationMessage[],
  tokenAccounting: ContextTokenAccounting | undefined,
): number {
  return countContextTokensForSegments(
    finalMessages.map((message) => message.content),
    tokenAccounting,
  );
}

// The compaction summary is physically embedded in the retained system message (see
// buildSystemScopedCompactionContent in conversation-compaction.ts), but its tokens are
// deliberately attributed to the history-summary lane rather than system-contract: that lane
// counts the summary as its "+1" included item and reports the compaction provenance (see
// buildHistorySummaryLane in chat-prompt-budget-diagnostics.ts), while system-contract
// intentionally reports only the bare canonical CONVERSATION_SYSTEM_PROMPT tokens. Subtracting
// systemTokens here keeps each lane's item-count consistent with its token-count and keeps the
// lane sum equal to totalEstimatedTokens.
export function estimateHistoryLaneTokens(input: {
  readonly historyOutcome: ConversationCompactionOutcome;
  readonly systemTokens: number;
  readonly tokenAccounting: ContextTokenAccounting | undefined;
}): number {
  const historyMessageTokens = countContextTokensForSegments(
    input.historyOutcome.messages.map((message) => message.content),
    input.tokenAccounting,
  );
  const systemPromptIsEmbedded = input.historyOutcome.messages.at(0)?.role === "system";
  return systemPromptIsEmbedded
    ? Math.max(0, historyMessageTokens - input.systemTokens)
    : historyMessageTokens;
}

export function buildPromptAssemblyTokenSummary(input: {
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
}): {
  readonly historyTokens: number;
  readonly memoryTokens: number;
  readonly documentTokens: number;
  readonly latestTurnTokens: number;
  readonly systemTokens: number;
  readonly totalEstimatedTokens: number;
} {
  const tokenAccounting = input.profile.tokenAccounting;
  const systemTokens = countContextTokens(CONVERSATION_SYSTEM_PROMPT, tokenAccounting);
  const historyTokens = estimateHistoryLaneTokens({
    historyOutcome: input.historyOutcome,
    systemTokens,
    tokenAccounting,
  });
  const memoryTokens = textTokens(
    renderMemoryContextText(input.memoryEntries, input.compactionContextText),
    tokenAccounting,
  );
  const documentTokens = textTokens(
    renderDocumentContextText(input.documentContext),
    tokenAccounting,
  );
  const latestTurnTokens = estimateUserTaskTokens({
    ...input.request,
    tokenAccounting,
  });
  return {
    historyTokens,
    memoryTokens,
    documentTokens,
    latestTurnTokens,
    systemTokens,
    totalEstimatedTokens: estimateFinalPromptTokens(input.finalMessages, tokenAccounting),
  };
}
