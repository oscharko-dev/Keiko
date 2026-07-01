import { estimateTokensForSegments, type ContextProfile } from "@oscharko-dev/keiko-contracts";
import type {
  ConversationDocumentContextWire,
  DiscussionMode,
} from "@oscharko-dev/keiko-contracts";
import type { ConversationMemoryContextEntryWire } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { ChatMessage } from "./store/index.js";
import { composeConversationPrompt } from "./conversation-prompt.js";
import {
  conversationForGatewayWithCompaction,
  type ConversationCompactionOutcome,
} from "./conversation-compaction.js";
import { buildPromptAssemblyDiagnostics } from "./chat-prompt-budget-diagnostics.js";

export interface GatewayConversationMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface GatewayPromptAssembly {
  readonly messages: GatewayConversationMessage[];
  readonly compaction: ConversationCompactionOutcome["compaction"];
  readonly diagnostics: import("@oscharko-dev/keiko-contracts").ContextAssemblyDiagnostics;
}

interface PromptAssemblyInput {
  readonly historyPrefix: readonly ChatMessage[];
  readonly historyTurnCount: number;
  readonly request: {
    readonly content: string;
    readonly discussionMode: DiscussionMode | undefined;
  };
  readonly profile: ContextProfile;
  readonly memoryEntries: readonly ConversationMemoryContextEntryWire[];
  readonly totalMemoryEntries: number;
  readonly documentContext: readonly ConversationDocumentContextWire[];
  readonly totalDocumentEntries: number;
  readonly redactionSecrets: readonly string[];
}

function renderMemoryContextText(
  memories: readonly ConversationMemoryContextEntryWire[],
): string | undefined {
  if (memories.length === 0) {
    return undefined;
  }
  const lines = ["# Relevant memories"];
  for (const memory of memories) {
    lines.push(`- (${memory.inclusionReason}) ${memory.bodyExcerpt}`);
  }
  return lines.join("\n");
}

function assembleGatewayPromptCandidate(
  input: PromptAssemblyInput,
): GatewayPromptAssembly | undefined {
  const memoryText = renderMemoryContextText(input.memoryEntries);
  const latestTurn = composeConversationPrompt(
    input.request.content,
    input.documentContext,
    memoryText,
    input.request.discussionMode,
  );
  const latestTurnTokens = estimateTokensForSegments([latestTurn]);
  if (latestTurnTokens > input.profile.effectiveInputBudget) {
    return undefined;
  }
  const historyBudget = input.profile.effectiveInputBudget - latestTurnTokens;
  const historyOutcome = conversationForGatewayWithCompaction(input.historyPrefix, {
    contextProfile: {
      ...input.profile,
      effectiveInputBudget: historyBudget,
    },
    redactionSecrets: input.redactionSecrets,
  });
  const messages = [...historyOutcome.messages, { role: "user" as const, content: latestTurn }];
  if (
    estimateTokensForSegments(messages.map((message) => message.content)) >
    input.profile.effectiveInputBudget
  ) {
    return undefined;
  }
  return {
    messages,
    compaction: historyOutcome.compaction,
    diagnostics: buildPromptAssemblyDiagnostics({
      profile: input.profile,
      historyOutcome,
      historyTurnCount: input.historyTurnCount,
      memoryEntries: input.memoryEntries,
      totalMemoryEntries: input.totalMemoryEntries,
      documentContext: input.documentContext,
      totalDocumentEntries: input.totalDocumentEntries,
      request: input.request,
      finalMessages: messages,
    }),
  };
}

function selectPrefixCount(items: readonly unknown[], canFit: (count: number) => boolean): number {
  let selected = 0;
  for (let count = 1; count <= items.length; count += 1) {
    if (!canFit(count)) {
      break;
    }
    selected = count;
  }
  return selected;
}

export function selectGatewayPromptAssembly(input: {
  readonly historyPrefix: readonly ChatMessage[];
  readonly historyTurnCount: number;
  readonly request: {
    readonly content: string;
    readonly discussionMode: DiscussionMode | undefined;
  };
  readonly profile: ContextProfile;
  readonly memoryEntries: readonly ConversationMemoryContextEntryWire[];
  readonly documentContext: readonly ConversationDocumentContextWire[];
  readonly redactionSecrets: readonly string[];
}): GatewayPromptAssembly | undefined {
  const baseInput = {
    historyPrefix: input.historyPrefix,
    historyTurnCount: input.historyTurnCount,
    request: input.request,
    profile: input.profile,
    totalMemoryEntries: input.memoryEntries.length,
    totalDocumentEntries: input.documentContext.length,
    redactionSecrets: input.redactionSecrets,
  };
  const selectedMemoryCount = selectPrefixCount(
    input.memoryEntries,
    (count) =>
      assembleGatewayPromptCandidate({
        ...baseInput,
        memoryEntries: input.memoryEntries.slice(0, count),
        documentContext: [],
      }) !== undefined,
  );
  const selectedDocumentCount = selectPrefixCount(
    input.documentContext,
    (count) =>
      assembleGatewayPromptCandidate({
        ...baseInput,
        memoryEntries: input.memoryEntries.slice(0, selectedMemoryCount),
        documentContext: input.documentContext.slice(0, count),
      }) !== undefined,
  );
  return assembleGatewayPromptCandidate({
    ...baseInput,
    memoryEntries: input.memoryEntries.slice(0, selectedMemoryCount),
    documentContext: input.documentContext.slice(0, selectedDocumentCount),
  });
}
