import { estimateTokensForSegments, type ContextProfile } from "@oscharko-dev/keiko-contracts";
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
import { ContextOverflowError } from "@oscharko-dev/keiko-security/errors/gateway";
import type { ConversationMemoryContextEntryWire } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { ChatMessage } from "./store/index.js";
import { usableGatewayMessages } from "./conversation-gateway.js";
import {
  CONVERSATION_CONTEXT_BLOCK_HEADER,
  CONVERSATION_MEMORY_BLOCK_HEADER,
  CONVERSATION_SYSTEM_PROMPT,
  CONVERSATION_USER_BLOCK_HEADER,
  composeConversationPrompt,
  renderConversationDocumentContextBlock,
} from "./conversation-prompt.js";
import { composeDiscussionDirectiveBlock } from "./discussion-prompt.js";
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
  readonly totalCompactionContextItems: number;
  readonly compactionContextText?: string | undefined;
  readonly documentContext: readonly ConversationDocumentContextWire[];
  readonly totalDocumentEntries: number;
  readonly redactionSecrets: readonly string[];
  readonly allocatorDiagnostics?: ContextAssemblyDiagnostics | undefined;
}

interface PromptLaneSelection {
  readonly memoryEntries: readonly ConversationMemoryContextEntryWire[];
  readonly compactionContextText?: string | undefined;
  readonly documentContext: readonly ConversationDocumentContextWire[];
  readonly diagnostics: ContextAssemblyDiagnostics;
}

const MEMORY_LIST_HEADER = "# Relevant memories";

function renderMemoryContextText(
  memories: readonly ConversationMemoryContextEntryWire[],
  compactionContextText: string | undefined,
): string | undefined {
  if (memories.length === 0 && compactionContextText === undefined) {
    return undefined;
  }
  const lines: string[] = [];
  if (memories.length > 0) {
    lines.push(MEMORY_LIST_HEADER);
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

function systemScopedCompactionContextMessage(
  compactionContextText: string | undefined,
): GatewayPromptAssembly["messages"] {
  return compactionContextText === undefined
    ? []
    : [{ role: "system" as const, content: compactionContextText }];
}

function insertSystemScopedCompactionContext(
  messages: GatewayPromptAssembly["messages"],
  compactionContextText: string | undefined,
): GatewayPromptAssembly["messages"] {
  const compactionMessages = systemScopedCompactionContextMessage(compactionContextText);
  if (compactionMessages.length === 0) {
    return messages;
  }
  const [first, ...rest] = messages;
  return first?.role === "system"
    ? [first, ...compactionMessages, ...rest]
    : [...compactionMessages, ...messages];
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

function allocatorUserTaskText(input: {
  readonly request: PromptAssemblyInput["request"];
  readonly memoryEntries: readonly ConversationMemoryContextEntryWire[];
  readonly compactionContextText?: string | undefined;
  readonly documentContext: readonly ConversationDocumentContextWire[];
}): string {
  const hasMemoryContext =
    input.memoryEntries.length > 0 || input.compactionContextText !== undefined;
  const hasDocumentContext = input.documentContext.length > 0;
  if (!hasMemoryContext && !hasDocumentContext) {
    return composeConversationPrompt(
      input.request.content,
      [],
      undefined,
      input.request.discussionMode,
    );
  }
  const blocks = [`${CONVERSATION_USER_BLOCK_HEADER}\n${input.request.content}`];
  if (hasMemoryContext) {
    blocks.push(
      input.memoryEntries.length > 0
        ? `${CONVERSATION_MEMORY_BLOCK_HEADER}\n${MEMORY_LIST_HEADER}`
        : CONVERSATION_MEMORY_BLOCK_HEADER,
    );
  }
  if (hasDocumentContext) {
    blocks.push(CONVERSATION_CONTEXT_BLOCK_HEADER);
  }
  const body = blocks.join("\n\n");
  return input.request.discussionMode === undefined
    ? body
    : `${composeDiscussionDirectiveBlock(input.request.discussionMode)}\n\n${body}`;
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
          text: allocatorUserTaskText(input),
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
  };
}

function promptLaneSelectionVariants(selection: PromptLaneSelection): readonly PromptLaneSelection[] {
  const variants: PromptLaneSelection[] = [];
  const seen = new Set<string>();
  const pushVariant = (
    memoryEntries: readonly ConversationMemoryContextEntryWire[],
    compactionContextText: string | undefined,
    documentContext: readonly ConversationDocumentContextWire[],
  ): void => {
    const key = [
      memoryEntries.length,
      compactionContextText === undefined ? "0" : "1",
      documentContext.length,
    ].join(":");
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    variants.push({
      memoryEntries,
      compactionContextText,
      documentContext,
      diagnostics: selection.diagnostics,
    });
  };

  pushVariant(
    selection.memoryEntries,
    selection.compactionContextText,
    selection.documentContext,
  );
  for (let documentCount = selection.documentContext.length - 1; documentCount >= 0; documentCount -= 1) {
    pushVariant(
      selection.memoryEntries,
      selection.compactionContextText,
      selection.documentContext.slice(0, documentCount),
    );
  }
  for (let memoryCount = selection.memoryEntries.length; memoryCount >= 0; memoryCount -= 1) {
    const memoryEntries = selection.memoryEntries.slice(0, memoryCount);
    pushVariant(memoryEntries, selection.compactionContextText, []);
    if (selection.compactionContextText !== undefined) {
      pushVariant(memoryEntries, undefined, []);
    }
  }
  return variants;
}

function compactHistoryForBudget(
  input: PromptAssemblyInput,
  historyBudget: number,
): ConversationCompactionOutcome | undefined {
  try {
    return conversationForGatewayWithCompaction(input.historyPrefix, {
      contextProfile: input.profile,
      effectiveInputBudget: historyBudget,
      preserveNewestTurn: false,
      redactionSecrets: input.redactionSecrets,
    });
  } catch (error) {
    if (error instanceof ContextOverflowError) {
      return undefined;
    }
    throw error;
  }
}

function buildLatestUserTurn(input: PromptAssemblyInput): string {
  return composeConversationPrompt(
    input.request.content,
    input.documentContext,
    renderMemoryContextText(input.memoryEntries, undefined),
    input.request.discussionMode,
  );
}

function promptScaffoldTokens(latestTurn: string, compactionContextText: string | undefined): number {
  return estimateTokensForSegments([
    ...systemScopedCompactionContextMessage(compactionContextText).map((message) => message.content),
    latestTurn,
  ]);
}

function buildPromptMessages(
  historyOutcome: ConversationCompactionOutcome,
  latestTurn: string,
  compactionContextText: string | undefined,
): GatewayPromptAssembly["messages"] {
  return [
    ...insertSystemScopedCompactionContext(historyOutcome.messages, compactionContextText),
    { role: "user" as const, content: latestTurn },
  ];
}

function assembleGatewayPromptCandidate(
  input: PromptAssemblyInput,
): GatewayPromptAssembly | undefined {
  const latestTurn = buildLatestUserTurn(input);
  const scaffoldTokens = promptScaffoldTokens(latestTurn, input.compactionContextText);
  if (scaffoldTokens > input.profile.effectiveInputBudget) {
    return undefined;
  }
  const historyBudget = input.profile.effectiveInputBudget - scaffoldTokens;
  const historyOutcome = compactHistoryForBudget(input, historyBudget);
  if (historyOutcome === undefined) return undefined;
  const messages = buildPromptMessages(historyOutcome, latestTurn, input.compactionContextText);
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
      totalCompactionContextItems: input.totalCompactionContextItems,
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
    totalCompactionContextItems: input.compactionContextText === undefined ? 0 : 1,
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
  for (const variant of promptLaneSelectionVariants(selection)) {
    const candidate = assembleGatewayPromptCandidate({
      ...baseInput,
      memoryEntries: variant.memoryEntries,
      compactionContextText: variant.compactionContextText,
      documentContext: variant.documentContext,
      allocatorDiagnostics: variant.diagnostics,
    });
    if (candidate !== undefined) {
      return candidate;
    }
  }
  return undefined;
}

export function buildChatCompactionContextText(
  evidenceStore: EvidenceStore,
  chatId: string,
): string | undefined {
  return buildChatCompactionResurfacingContext(evidenceStore, chatId);
}
