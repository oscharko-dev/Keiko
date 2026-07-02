import {
  CONTEXT_ENGINEERING_SCHEMA_VERSION,
  resolveContextTokenAccounting,
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
import type { GatewayConversationMessage } from "./conversation-gateway.js";
import type { ConversationCompactionOutcome } from "./conversation-compaction.js";
import { buildPromptAssemblyTokenSummary } from "./chat-prompt-budget-token-summary.js";

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

function budgetCompactionReason(excludedItems: number): { readonly compactionReason?: string } {
  return excludedItems > 0 ? { compactionReason: "budget" } : {};
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
  readonly compactionContextText?: string | undefined;
  readonly totalCompactionContextItems: number;
  readonly inputBudget: number;
}): ContextLaneDiagnostics {
  const includedItems =
    input.memoryEntries.length + (input.compactionContextText === undefined ? 0 : 1);
  const excludedItems =
    input.totalMemoryEntries + input.totalCompactionContextItems - includedItems;
  return laneDiagnostics({
    laneId: "working-memory",
    estimatedTokens: input.memoryTokens,
    includedItems,
    excludedItems,
    budgetPressure: pressureForTokens(input.memoryTokens, input.inputBudget),
    ...budgetCompactionReason(excludedItems),
  });
}

function buildRepoEvidenceLane(input: {
  readonly documentTokens: number;
  readonly documentContext: readonly ConversationDocumentContextWire[];
  readonly totalDocumentEntries: number;
  readonly inputBudget: number;
}): ContextLaneDiagnostics {
  const excludedItems = input.totalDocumentEntries - input.documentContext.length;
  return laneDiagnostics({
    laneId: "repo-evidence",
    estimatedTokens: input.documentTokens,
    includedItems: input.documentContext.length,
    excludedItems,
    budgetPressure: pressureForTokens(input.documentTokens, input.inputBudget),
    ...budgetCompactionReason(excludedItems),
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

function allocatorLane(
  diagnostics: ContextAssemblyDiagnostics | undefined,
  laneId: ContextLaneDiagnostics["laneId"],
): ContextLaneDiagnostics | undefined {
  return diagnostics?.lanes.find((lane) => lane.laneId === laneId);
}

function withAllocatorSignals(
  lane: ContextLaneDiagnostics,
  allocator: ContextLaneDiagnostics | undefined,
): ContextLaneDiagnostics {
  if (allocator === undefined) {
    return lane;
  }
  const compactionReason = lane.compactionReason ?? allocator.compactionReason;
  return {
    ...lane,
    budgetPressure: allocator.budgetPressure,
    ...(compactionReason === undefined ? {} : { compactionReason }),
    ...(allocator.provenanceCounts === undefined
      ? {}
      : { provenanceCounts: allocator.provenanceCounts }),
  };
}

function buildPromptWorkingMemoryLane(input: {
  readonly memoryTokens: number;
  readonly memoryEntries: readonly ConversationMemoryContextEntryWire[];
  readonly totalMemoryEntries: number;
  readonly compactionContextText?: string | undefined;
  readonly totalCompactionContextItems: number;
  readonly inputBudget: number;
}): ContextLaneDiagnostics {
  return buildWorkingMemoryLane({
    memoryTokens: input.memoryTokens,
    memoryEntries: input.memoryEntries,
    totalMemoryEntries: input.totalMemoryEntries,
    compactionContextText: input.compactionContextText,
    totalCompactionContextItems: input.totalCompactionContextItems,
    inputBudget: input.inputBudget,
  });
}

interface BuildPromptAssemblyLanesInput {
  readonly tokenSummary: ReturnType<typeof buildPromptAssemblyTokenSummary>;
  readonly profile: ContextProfile;
  readonly historyOutcome: ConversationCompactionOutcome;
  readonly historyTurnCount: number;
  readonly memoryEntries: readonly ConversationMemoryContextEntryWire[];
  readonly totalMemoryEntries: number;
  readonly compactionContextText?: string | undefined;
  readonly totalCompactionContextItems: number;
  readonly documentContext: readonly ConversationDocumentContextWire[];
  readonly totalDocumentEntries: number;
  readonly allocatorDiagnostics?: ContextAssemblyDiagnostics | undefined;
}

function buildPromptAssemblyLanes(input: BuildPromptAssemblyLanesInput): ContextLaneDiagnostics[] {
  const inputBudget = input.profile.effectiveInputBudget;
  const { historyTokens, memoryTokens, documentTokens, latestTurnTokens, systemTokens } =
    input.tokenSummary;
  const systemLane = buildSystemContractLane({ systemTokens, inputBudget });
  const userTaskLane = buildUserTaskLane({ latestTurnTokens, inputBudget });
  const repoEvidenceLane = buildRepoEvidenceLane({
    documentTokens,
    documentContext: input.documentContext,
    totalDocumentEntries: input.totalDocumentEntries,
    inputBudget,
  });
  const workingMemoryLane = buildPromptWorkingMemoryLane({
    memoryTokens,
    memoryEntries: input.memoryEntries,
    totalMemoryEntries: input.totalMemoryEntries,
    compactionContextText: input.compactionContextText,
    totalCompactionContextItems: input.totalCompactionContextItems,
    inputBudget,
  });
  return [
    withAllocatorSignals(systemLane, allocatorLane(input.allocatorDiagnostics, "system-contract")),
    withAllocatorSignals(userTaskLane, allocatorLane(input.allocatorDiagnostics, "user-task")),
    withAllocatorSignals(
      repoEvidenceLane,
      allocatorLane(input.allocatorDiagnostics, "repo-evidence"),
    ),
    withAllocatorSignals(
      workingMemoryLane,
      allocatorLane(input.allocatorDiagnostics, "working-memory"),
    ),
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
  readonly totalCompactionContextItems: number;
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
  const tokenAccounting = resolveContextTokenAccounting(input.profile);
  const profile: ContextProfile =
    input.profile.tokenAccounting === undefined
      ? { ...input.profile, tokenAccounting }
      : input.profile;
  const tokenSummary = buildPromptAssemblyTokenSummary({ ...input, profile });
  return {
    schemaVersion: CONTEXT_ENGINEERING_SCHEMA_VERSION,
    profile,
    totalEstimatedTokens: tokenSummary.totalEstimatedTokens,
    budgetPressure: pressureForTokens(
      tokenSummary.totalEstimatedTokens,
      profile.effectiveInputBudget,
    ),
    lanes: buildPromptAssemblyLanes({
      tokenSummary,
      profile,
      historyOutcome: input.historyOutcome,
      historyTurnCount: input.historyTurnCount,
      memoryEntries: input.memoryEntries,
      totalMemoryEntries: input.totalMemoryEntries,
      compactionContextText: input.compactionContextText,
      totalCompactionContextItems: input.totalCompactionContextItems,
      documentContext: input.documentContext,
      totalDocumentEntries: input.totalDocumentEntries,
      allocatorDiagnostics: input.allocatorDiagnostics,
    }),
    orderedForRecency: true,
  };
}
