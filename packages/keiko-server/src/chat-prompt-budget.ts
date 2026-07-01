import {
  estimateTokens,
  estimateTokensForSegments,
  type ContextProfile,
} from "@oscharko-dev/keiko-contracts";
import {
  allocateContext,
  DEFAULT_CONTEXT_BUDGET,
  type AllocatedContextLane,
  type ContextLaneInput,
} from "@oscharko-dev/keiko-workflows/context-budget";
import type {
  ContextAssemblyDiagnostics,
  ConversationDocumentContextWire,
  DiscussionMode,
} from "@oscharko-dev/keiko-contracts";
import type { ConversationMemoryContextEntryWire } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { ChatMessage } from "./store/index.js";
import { usableGatewayMessages } from "./conversation-gateway.js";
import {
  CONVERSATION_SYSTEM_PROMPT,
  composeConversationPrompt,
  renderConversationDocumentContextBlock,
} from "./conversation-prompt.js";
import {
  conversationForGatewayWithCompaction,
  type ConversationCompactionOutcome,
} from "./conversation-compaction.js";
import { buildPromptAssemblyDiagnostics } from "./chat-prompt-budget-diagnostics.js";
import { buildChatCompactionResurfacingContext } from "./chat-compaction-resurfacing.js";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";

export type { GatewayConversationMessage } from "./conversation-gateway.js";

export interface GatewayPromptAssembly {
  readonly messages: import("./conversation-gateway.js").GatewayConversationMessage[];
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
  readonly compactionContextText?: string | undefined;
  readonly documentContext: readonly ConversationDocumentContextWire[];
  readonly totalDocumentEntries: number;
  readonly redactionSecrets: readonly string[];
  readonly allocatorDiagnostics?: ContextAssemblyDiagnostics | undefined;
  readonly allocatedHistoryTokens?: number | undefined;
}

interface PromptLaneSelection {
  readonly memoryEntries: readonly ConversationMemoryContextEntryWire[];
  readonly compactionContextText?: string | undefined;
  readonly documentContext: readonly ConversationDocumentContextWire[];
  readonly diagnostics: ContextAssemblyDiagnostics;
  readonly historyBudget?: number | undefined;
}

function renderMemoryContextText(
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

function scoreForIndex(total: number, index: number): number {
  return total - index;
}

function memoryLaneItemId(index: number): string {
  return `memory-${String(index).padStart(4, "0")}`;
}

function documentLaneItemId(index: number): string {
  return `document-${String(index).padStart(4, "0")}`;
}

function memoryLaneItemText(memory: ConversationMemoryContextEntryWire): string {
  return `- (${memory.inclusionReason}) ${memory.bodyExcerpt}`;
}

function includedLaneIds(
  lanes: readonly AllocatedContextLane[],
  laneId: ContextLaneInput["laneId"],
): ReadonlySet<string> {
  return new Set(lanes.find((lane) => lane.laneId === laneId)?.includedItemIds ?? []);
}

function promptAllocationBudget(profile: ContextProfile): typeof DEFAULT_CONTEXT_BUDGET {
  return { ...DEFAULT_CONTEXT_BUDGET, profile };
}

function compactionLaneItems(compactionContextText: string | undefined): ContextLaneInput["items"] {
  return compactionContextText === undefined
    ? []
    : [{ id: "compaction-context", text: compactionContextText, score: 1_000_000 }];
}

function memoryLaneItems(
  memories: readonly ConversationMemoryContextEntryWire[],
): ContextLaneInput["items"] {
  return memories.map((memory, index) => ({
    id: memoryLaneItemId(index),
    text: memoryLaneItemText(memory),
    score: scoreForIndex(memories.length, index),
  }));
}

function documentLaneItems(
  documents: readonly ConversationDocumentContextWire[],
): ContextLaneInput["items"] {
  return documents.map((document, index) => ({
    id: documentLaneItemId(index),
    text: renderConversationDocumentContextBlock(document),
    score: scoreForIndex(documents.length, index),
  }));
}

function historyLaneItems(historyPrefix: readonly ChatMessage[]): ContextLaneInput["items"] {
  const usable = usableGatewayMessages(historyPrefix);
  return usable.map((message, index) => ({
    id: `history-${String(index).padStart(4, "0")}`,
    text: message.content,
    score: index + 1,
  }));
}

function buildPromptAllocatorLanes(input: {
  readonly request: PromptAssemblyInput["request"];
  readonly historyPrefix: readonly ChatMessage[];
  readonly memoryEntries: readonly ConversationMemoryContextEntryWire[];
  readonly compactionContextText?: string | undefined;
  readonly documentContext: readonly ConversationDocumentContextWire[];
}): readonly ContextLaneInput[] {
  return [
    {
      laneId: "system-contract",
      items: [{ id: "system-contract", text: CONVERSATION_SYSTEM_PROMPT, score: 1 }],
    },
    {
      laneId: "user-task",
      items: [
        {
          id: "latest-user-task",
          text: composeConversationPrompt(
            input.request.content,
            [],
            undefined,
            input.request.discussionMode,
          ),
          score: 1,
        },
      ],
    },
    {
      laneId: "working-memory",
      items: [
        ...compactionLaneItems(input.compactionContextText),
        ...memoryLaneItems(input.memoryEntries),
      ],
    },
    {
      laneId: "repo-evidence",
      items: documentLaneItems(input.documentContext),
    },
    {
      laneId: "history-summary",
      items: historyLaneItems(input.historyPrefix),
    },
  ];
}

function selectPromptLanes(input: {
  readonly profile: ContextProfile;
  readonly request: PromptAssemblyInput["request"];
  readonly historyPrefix: readonly ChatMessage[];
  readonly memoryEntries: readonly ConversationMemoryContextEntryWire[];
  readonly compactionContextText?: string | undefined;
  readonly documentContext: readonly ConversationDocumentContextWire[];
}): PromptLaneSelection {
  const allocation = allocateContext({
    profile: input.profile,
    budget: promptAllocationBudget(input.profile),
    lanes: buildPromptAllocatorLanes(input),
  });
  const memoryIncluded = includedLaneIds(allocation.lanes, "working-memory");
  const documentIncluded = includedLaneIds(allocation.lanes, "repo-evidence");
  const historyLane = allocation.lanes.find((lane) => lane.laneId === "history-summary");
  const systemTokens = estimateTokens(CONVERSATION_SYSTEM_PROMPT);
  return {
    memoryEntries: input.memoryEntries.filter((_, index) =>
      memoryIncluded.has(memoryLaneItemId(index)),
    ),
    compactionContextText: memoryIncluded.has("compaction-context")
      ? input.compactionContextText
      : undefined,
    documentContext: input.documentContext.filter((_, index) =>
      documentIncluded.has(documentLaneItemId(index)),
    ),
    diagnostics: allocation.diagnostics,
    historyBudget:
      historyLane === undefined ? undefined : systemTokens + historyLane.estimatedTokens,
  };
}

function assembleGatewayPromptCandidate(
  input: PromptAssemblyInput,
): GatewayPromptAssembly | undefined {
  const memoryText = renderMemoryContextText(input.memoryEntries, input.compactionContextText);
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
  const remainingInputBudget = input.profile.effectiveInputBudget - latestTurnTokens;
  const historyBudget =
    input.allocatedHistoryTokens === undefined
      ? remainingInputBudget
      : Math.min(remainingInputBudget, input.allocatedHistoryTokens);
  const historyOutcome = conversationForGatewayWithCompaction(input.historyPrefix, {
    contextProfile: input.profile,
    effectiveInputBudget: historyBudget,
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
      compactionContextText: input.compactionContextText,
      allocatorDiagnostics: input.allocatorDiagnostics,
    }),
  };
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
  readonly compactionContextText?: string | undefined;
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
    compactionContextText: input.compactionContextText,
    redactionSecrets: input.redactionSecrets,
  };
  const selection = selectPromptLanes({
    profile: input.profile,
    request: input.request,
    historyPrefix: input.historyPrefix,
    memoryEntries: input.memoryEntries,
    compactionContextText: input.compactionContextText,
    documentContext: input.documentContext,
  });
  return assembleGatewayPromptCandidate({
    ...baseInput,
    memoryEntries: selection.memoryEntries,
    compactionContextText: selection.compactionContextText,
    documentContext: selection.documentContext,
    allocatorDiagnostics: selection.diagnostics,
    allocatedHistoryTokens: selection.historyBudget,
  });
}

export function buildChatCompactionContextText(
  evidenceStore: EvidenceStore,
  chatId: string,
): string | undefined {
  return buildChatCompactionResurfacingContext(evidenceStore, chatId);
}
