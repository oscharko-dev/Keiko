import {
  CONTEXT_ENGINEERING_SCHEMA_VERSION,
  estimateTokens,
  estimateTokensForSegments,
  type ContextAssemblyDiagnostics,
  type ContextBudgetPressure,
  type ContextLaneDiagnostics,
  type ContextProfile,
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

function pressureForTokens(tokens: number, budgetTokens: number): ContextBudgetPressure {
  if (budgetTokens <= 0) {
    return tokens > 0 ? "exceeded" : "low";
  }
  const ratio = tokens / budgetTokens;
  if (ratio > 1) return "exceeded";
  if (ratio >= 0.9) return "high";
  if (ratio >= 0.6) return "moderate";
  return "low";
}

function laneDiagnostics(input: {
  readonly laneId: ContextLaneDiagnostics["laneId"];
  readonly estimatedTokens: number;
  readonly includedItems: number;
  readonly excludedItems: number;
  readonly budgetPressure: ContextBudgetPressure;
  readonly compactionReason?: string | undefined;
  readonly provenanceCounts?: Readonly<Record<string, number>> | undefined;
}): ContextLaneDiagnostics {
  return input;
}

function textTokens(text: string | undefined): number {
  return estimateTokensForSegments(text === undefined ? [] : [text]);
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

function renderDocumentContextText(
  documentContext: readonly ConversationDocumentContextWire[],
): string | undefined {
  if (documentContext.length === 0) {
    return undefined;
  }
  const blocks = documentContext.map(renderConversationDocumentContextBlock);
  return `${CONVERSATION_CONTEXT_BLOCK_HEADER}\n${blocks.join("\n")}`;
}

function estimateUserTaskTokens(input: {
  readonly content: string;
  readonly discussionMode: DiscussionMode | undefined;
}): number {
  return estimateTokensForSegments([
    composeConversationPrompt(input.content, [], undefined, input.discussionMode),
  ]);
}

function estimateFinalPromptTokens(finalMessages: readonly GatewayConversationMessage[]): number {
  return estimateTokensForSegments(finalMessages.map((message) => message.content));
}

function buildPromptAssemblyTokenSummary(input: {
  readonly historyOutcome: ConversationCompactionOutcome;
  readonly memoryEntries: readonly ConversationMemoryContextEntryWire[];
  readonly compactionContextText?: string | undefined;
  readonly documentContext: readonly ConversationDocumentContextWire[];
  readonly request: {
    readonly content: string;
    readonly discussionMode: DiscussionMode | undefined;
  };
  readonly finalMessages: readonly GatewayConversationMessage[];
}): {
  readonly historyTokens: number;
  readonly memoryTokens: number;
  readonly documentTokens: number;
  readonly latestTurnTokens: number;
  readonly systemTokens: number;
  readonly totalEstimatedTokens: number;
} {
  const historyTokens = estimateTokensForSegments(
    input.historyOutcome.messages.slice(1).map((message) => message.content),
  );
  const memoryTokens = textTokens(
    renderMemoryContextText(input.memoryEntries, input.compactionContextText),
  );
  const documentTokens = textTokens(renderDocumentContextText(input.documentContext));
  const latestTurnTokens = estimateUserTaskTokens(input.request);
  const systemTokens = estimateTokens(CONVERSATION_SYSTEM_PROMPT);
  return {
    historyTokens,
    memoryTokens,
    documentTokens,
    latestTurnTokens,
    systemTokens,
    totalEstimatedTokens: estimateFinalPromptTokens(input.finalMessages),
  };
}

function buildSystemContractLane(input: {
  readonly systemTokens: number;
  readonly inputBudget: number;
}): ContextLaneDiagnostics {
  return laneDiagnostics({
    laneId: "system-contract",
    estimatedTokens: input.systemTokens,
    includedItems: 1,
    excludedItems: 0,
    budgetPressure: pressureForTokens(input.systemTokens, input.inputBudget),
  });
}

function buildWorkingMemoryLane(input: {
  readonly memoryTokens: number;
  readonly memoryEntries: readonly ConversationMemoryContextEntryWire[];
  readonly totalMemoryEntries: number;
  readonly inputBudget: number;
}): ContextLaneDiagnostics {
  return laneDiagnostics({
    laneId: "working-memory",
    estimatedTokens: input.memoryTokens,
    includedItems: input.memoryEntries.length,
    excludedItems: input.totalMemoryEntries - input.memoryEntries.length,
    budgetPressure: pressureForTokens(input.memoryTokens, input.inputBudget),
  });
}

function buildRepoEvidenceLane(input: {
  readonly documentTokens: number;
  readonly documentContext: readonly ConversationDocumentContextWire[];
  readonly totalDocumentEntries: number;
  readonly inputBudget: number;
}): ContextLaneDiagnostics {
  return laneDiagnostics({
    laneId: "repo-evidence",
    estimatedTokens: input.documentTokens,
    includedItems: input.documentContext.length,
    excludedItems: input.totalDocumentEntries - input.documentContext.length,
    budgetPressure: pressureForTokens(input.documentTokens, input.inputBudget),
  });
}

function buildUserTaskLane(input: {
  readonly latestTurnTokens: number;
  readonly inputBudget: number;
}): ContextLaneDiagnostics {
  return laneDiagnostics({
    laneId: "user-task",
    estimatedTokens: input.latestTurnTokens,
    includedItems: 1,
    excludedItems: 0,
    budgetPressure: pressureForTokens(input.latestTurnTokens, input.inputBudget),
  });
}

function buildVerificationEvidenceLane(input: {
  readonly reservedOutputTokens: number;
  readonly maxInputTokens: number;
}): ContextLaneDiagnostics {
  return laneDiagnostics({
    laneId: "verification-evidence",
    estimatedTokens: input.reservedOutputTokens,
    includedItems: 1,
    excludedItems: 0,
    budgetPressure: pressureForTokens(
      input.reservedOutputTokens,
      Math.max(1, input.maxInputTokens),
    ),
  });
}

function buildHistorySummaryLane(input: {
  readonly historyOutcome: ConversationCompactionOutcome;
  readonly historyTurnCount: number;
  readonly historyTokens: number;
  readonly inputBudget: number;
}): ContextLaneDiagnostics {
  const droppedHistoryTurns = input.historyOutcome.compaction?.itemsBefore ?? 0;
  const retainedHistoryTurns = input.historyTurnCount - droppedHistoryTurns;
  return laneDiagnostics({
    laneId: "history-summary",
    estimatedTokens: input.historyTokens,
    includedItems:
      input.historyOutcome.compaction === undefined
        ? retainedHistoryTurns
        : retainedHistoryTurns + 1,
    excludedItems: droppedHistoryTurns,
    budgetPressure: pressureForTokens(input.historyTokens, input.inputBudget),
    ...(input.historyOutcome.compaction === undefined
      ? {}
      : {
          compactionReason: input.historyOutcome.compaction.reason,
          provenanceCounts: {
            droppedTurns: droppedHistoryTurns,
            retainedTurns: retainedHistoryTurns,
          },
        }),
  });
}

function buildPromptAssemblyLanes(input: {
  readonly tokenSummary: ReturnType<typeof buildPromptAssemblyTokenSummary>;
  readonly profile: ContextProfile;
  readonly historyOutcome: ConversationCompactionOutcome;
  readonly historyTurnCount: number;
  readonly memoryEntries: readonly ConversationMemoryContextEntryWire[];
  readonly totalMemoryEntries: number;
  readonly documentContext: readonly ConversationDocumentContextWire[];
  readonly totalDocumentEntries: number;
  readonly allocatorDiagnostics?: ContextAssemblyDiagnostics | undefined;
}): ContextLaneDiagnostics[] {
  const inputBudget = input.profile.effectiveInputBudget;
  const { historyTokens, memoryTokens, documentTokens, latestTurnTokens, systemTokens } =
    input.tokenSummary;
  const allocatorLane = (
    laneId: ContextLaneDiagnostics["laneId"],
  ): ContextLaneDiagnostics | undefined =>
    input.allocatorDiagnostics?.lanes.find((lane) => lane.laneId === laneId);
  return [
    allocatorLane("system-contract") ?? buildSystemContractLane({ systemTokens, inputBudget }),
    allocatorLane("user-task") ?? buildUserTaskLane({ latestTurnTokens, inputBudget }),
    allocatorLane("repo-evidence") ??
      buildRepoEvidenceLane({
        documentTokens,
        documentContext: input.documentContext,
        totalDocumentEntries: input.totalDocumentEntries,
        inputBudget,
      }),
    allocatorLane("working-memory") ??
      buildWorkingMemoryLane({
        memoryTokens,
        memoryEntries: input.memoryEntries,
        totalMemoryEntries: input.totalMemoryEntries,
        inputBudget,
      }),
    buildHistorySummaryLane({
      historyOutcome: input.historyOutcome,
      historyTurnCount: input.historyTurnCount,
      historyTokens,
      inputBudget,
    }),
    buildVerificationEvidenceLane({
      reservedOutputTokens: input.profile.reservedOutputTokens,
      maxInputTokens: input.profile.maxInputTokens,
    }),
  ];
}

export function buildPromptAssemblyDiagnostics(input: {
  readonly profile: ContextProfile;
  readonly historyOutcome: ConversationCompactionOutcome;
  readonly historyTurnCount: number;
  readonly memoryEntries: readonly ConversationMemoryContextEntryWire[];
  readonly totalMemoryEntries: number;
  readonly documentContext: readonly ConversationDocumentContextWire[];
  readonly totalDocumentEntries: number;
  readonly compactionContextText?: string | undefined;
  readonly request: {
    readonly content: string;
    readonly discussionMode: DiscussionMode | undefined;
  };
  readonly finalMessages: readonly GatewayConversationMessage[];
  readonly allocatorDiagnostics?: ContextAssemblyDiagnostics | undefined;
}): ContextAssemblyDiagnostics {
  const tokenSummary = buildPromptAssemblyTokenSummary(input);
  return {
    schemaVersion: CONTEXT_ENGINEERING_SCHEMA_VERSION,
    profile: input.profile,
    totalEstimatedTokens: tokenSummary.totalEstimatedTokens,
    budgetPressure: pressureForTokens(
      tokenSummary.totalEstimatedTokens,
      input.profile.effectiveInputBudget,
    ),
    lanes: buildPromptAssemblyLanes({
      tokenSummary,
      profile: input.profile,
      historyOutcome: input.historyOutcome,
      historyTurnCount: input.historyTurnCount,
      memoryEntries: input.memoryEntries,
      totalMemoryEntries: input.totalMemoryEntries,
      documentContext: input.documentContext,
      totalDocumentEntries: input.totalDocumentEntries,
      allocatorDiagnostics: input.allocatorDiagnostics,
    }),
    orderedForRecency: true,
  };
}
