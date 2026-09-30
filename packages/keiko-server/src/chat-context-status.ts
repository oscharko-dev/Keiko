import type { ChatContextStatusWire } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { ContextCompactionRecord, ContextProfile } from "@oscharko-dev/keiko-contracts";
import { findConfiguredCapability } from "@oscharko-dev/keiko-model-gateway";
import { DEFAULT_CONTEXT_PROFILE } from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import { countGatewayPromptTokens } from "@oscharko-dev/keiko-model-gateway/internal/prompt-token-accounting";
import { ContextOverflowError } from "@oscharko-dev/keiko-security/errors/gateway";
import {
  currentContextProfileForModel,
  currentGatewayConfig,
  currentRedactionSecrets,
  type UiHandlerDeps,
} from "./deps.js";
import { CONVERSATION_SYSTEM_PROMPT } from "./conversation-prompt.js";
import {
  conversationForGatewayWithCompaction,
  countConversationCheckpointTokens,
  type ConversationCompactionOutcome,
} from "./conversation-compaction.js";
import { captureChatHistory, stampHistoryRevision } from "./chat-history-snapshot.js";
import { loadChatContinuityCheckpoint } from "./chat-compaction-resurfacing.js";
import { persistChatCompactionEvidence } from "./chat-compaction-evidence.js";
import { UiStoreError } from "./store/index.js";
import { logChatContextFailure, logChatContextManagement } from "./chat-context-log.js";

function checkpointForProfile(
  deps: UiHandlerDeps,
  chatId: string,
  profile: ContextProfile,
  correlationId?: string,
): ContextCompactionRecord | undefined {
  const checkpoint = loadChatContinuityCheckpoint(
    deps.evidenceStore,
    chatId,
    deps.store.chatHistoryRevision(chatId),
    correlationId,
  );
  if (checkpoint?.conversationCoverage?.contextWindowTokens === undefined) return undefined;
  return profile.maxInputTokens <= checkpoint.conversationCoverage.contextWindowTokens
    ? checkpoint
    : undefined;
}

function countHistory(
  deps: UiHandlerDeps,
  chatId: string,
  profile: ContextProfile,
  checkpoint: ContextCompactionRecord | undefined,
): { tokens: number; messages: number; checkpointUsed: boolean; checkpointTokens: number } {
  let tokens = countGatewayPromptTokens(
    { messages: [{ role: "system", content: CONVERSATION_SYSTEM_PROMPT }] },
    profile.tokenAccounting,
  );
  let messages = 0;
  let checkpointUsed = false;
  let checkpointTokens = 0;
  const empty = countGatewayPromptTokens({ messages: [] }, profile.tokenAccounting);
  deps.store.visitGatewayMessageUnits(chatId, "", (unit) => {
    for (const message of [...unit].reverse()) {
      if (message.id === checkpoint?.conversationCoverage?.throughMessageId) {
        checkpointTokens = countConversationCheckpointTokens(checkpoint, profile.tokenAccounting);
        tokens += checkpointTokens;
        checkpointUsed = true;
        return false;
      }
      if (message.role !== "user" && message.role !== "assistant") continue;
      tokens +=
        countGatewayPromptTokens(
          { messages: [{ role: message.role, content: message.content }] },
          profile.tokenAccounting,
        ) - empty;
      messages += 1;
    }
    return undefined;
  });
  return { tokens, messages, checkpointUsed, checkpointTokens };
}

// The send path compacts proactively once the prompt reaches 90 % of the input budget and then
// targets 70 % (chat-prompt-budget.ts selectGatewayPromptAssembly). The meter applies the same rule,
// so it reports what the next request will actually carry instead of the raw stored history — a
// history larger than the window is never shown as 340 % of it (customer report on 1.1.13).
const AUTOMATIC_COMPACTION_THRESHOLD = 0.9;
const AUTOMATIC_COMPACTION_TARGET = 0.7;

function assumedWindowField(
  deps: UiHandlerDeps,
  modelId: string,
): Pick<ChatContextStatusWire, "contextWindowAssumed"> {
  const config = currentGatewayConfig(deps);
  const capability = config === undefined ? undefined : findConfiguredCapability(config, modelId);
  return capability?.contextWindowAssumed === true ? { contextWindowAssumed: true } : {};
}

function checkpointSavings(
  checkpoint: ContextCompactionRecord | undefined,
  counted: ReturnType<typeof countHistory>,
): Pick<ChatContextStatusWire, "compaction"> {
  if (checkpoint === undefined || !counted.checkpointUsed) return {};
  return {
    compaction: {
      tokensBefore: checkpoint.tokensBefore,
      tokensAfter: counted.checkpointTokens,
      tokensSaved: Math.max(0, checkpoint.tokensBefore - counted.checkpointTokens),
      messagesCompacted: checkpoint.itemsBefore,
    },
  };
}

function pendingCompaction(
  deps: UiHandlerDeps,
  chatId: string,
  profile: ContextProfile,
  storedTokens: number,
  correlationId: string | undefined,
): Pick<ChatContextStatusWire, "pendingCompaction"> {
  if (storedTokens < profile.effectiveInputBudget * AUTOMATIC_COMPACTION_THRESHOLD) return {};
  const target = Math.floor(profile.effectiveInputBudget * AUTOMATIC_COMPACTION_TARGET);
  const outcome = compactionProjection(deps, chatId, profile, target, correlationId);
  if (outcome === undefined) return {};
  const tokensAfter = countGatewayPromptTokens(
    { messages: outcome.messages },
    profile.tokenAccounting,
  );
  if (tokensAfter >= storedTokens) return {};
  return {
    pendingCompaction: {
      tokensBefore: storedTokens,
      tokensAfter,
      messagesCompacted: outcome.compaction?.itemsBefore ?? 0,
    },
  };
}

export function readChatContextStatus(
  deps: UiHandlerDeps,
  chatId: string,
  modelId: string,
  correlationId?: string,
): ChatContextStatusWire {
  const profile = currentContextProfileForModel(deps, modelId) ?? DEFAULT_CONTEXT_PROFILE;
  const checkpoint = checkpointForProfile(deps, chatId, profile, correlationId);
  const counted = countHistory(deps, chatId, profile, checkpoint);
  const pending = pendingCompaction(deps, chatId, profile, counted.tokens, correlationId);
  return {
    modelId,
    contextWindowTokens: profile.maxInputTokens,
    ...assumedWindowField(deps, modelId),
    inputBudgetTokens: profile.effectiveInputBudget,
    reservedOutputTokens: profile.reservedOutputTokens,
    safetyMarginTokens: profile.safetyMarginTokens,
    estimatedInputTokens: pending.pendingCompaction?.tokensAfter ?? counted.tokens,
    canCompact: counted.messages >= 2,
    ...checkpointSavings(checkpoint, counted),
    ...pending,
  };
}

function compactionProjection(
  deps: UiHandlerDeps,
  chatId: string,
  profile: ContextProfile,
  budget: number,
  correlationId: string | undefined,
): ConversationCompactionOutcome | undefined {
  const snapshot = captureChatHistory(
    deps.store,
    chatId,
    "",
    profile,
    currentRedactionSecrets(deps),
    checkpointForProfile(deps, chatId, profile, correlationId),
    correlationId === undefined ? {} : { correlationId },
  );
  try {
    return conversationForGatewayWithCompaction(snapshot.history, {
      contextProfile: profile,
      effectiveInputBudget: budget,
      earlierCompaction: snapshot.earlierCompaction,
      redactionSecrets: currentRedactionSecrets(deps),
    });
  } catch (error) {
    if (error instanceof ContextOverflowError) return undefined;
    throw error;
  }
}

function manualCompactionCandidate(
  deps: UiHandlerDeps,
  chatId: string,
  modelId: string,
  status: ChatContextStatusWire,
  correlationId: string,
): ContextCompactionRecord | undefined {
  const profile = currentContextProfileForModel(deps, modelId) ?? DEFAULT_CONTEXT_PROFILE;
  const snapshot = captureChatHistory(
    deps.store,
    chatId,
    "",
    profile,
    currentRedactionSecrets(deps),
    checkpointForProfile(deps, chatId, profile, correlationId),
    { correlationId },
  );
  const stored = status.pendingCompaction?.tokensBefore ?? status.estimatedInputTokens;
  const budget = Math.floor(
    Math.min(profile.effectiveInputBudget, stored) * AUTOMATIC_COMPACTION_TARGET,
  );
  try {
    const outcome = conversationForGatewayWithCompaction(snapshot.history, {
      contextProfile: profile,
      effectiveInputBudget: budget,
      earlierCompaction: snapshot.earlierCompaction,
      redactionSecrets: currentRedactionSecrets(deps),
    });
    const record = stampHistoryRevision(
      outcome.compaction,
      snapshot.historyRevision ?? 0,
      profile.maxInputTokens,
    );
    return record !== undefined && record.tokensAfter < record.tokensBefore ? record : undefined;
  } catch (error) {
    if (error instanceof ContextOverflowError) return undefined;
    throw error;
  }
}

export function compactChatContext(
  deps: UiHandlerDeps,
  chatId: string,
  modelId: string,
  correlationId: string,
): ChatContextStatusWire {
  const startedAt = Date.now();
  const before = readChatContextStatus(deps, chatId, modelId, correlationId);
  const compaction = manualCompactionCandidate(deps, chatId, modelId, before, correlationId);
  if (compaction === undefined) {
    logChatContextManagement("unchanged", before, 0, correlationId);
    return { ...before, canCompact: false };
  }
  persistChatCompactionEvidence(deps, {
    compaction,
    chatId,
    modelId,
    messageCount: deps.store.countMessages(chatId),
    startedAt,
    finishedAt: Date.now(),
    correlationId,
  });
  const after = readChatContextStatus(deps, chatId, modelId, correlationId);
  if (after.compaction?.messagesCompacted !== compaction.itemsBefore) {
    logChatContextManagement("failed", before, 0, correlationId);
    const error = new UiStoreError("INTERNAL", "Context compaction could not be saved.", 500);
    logChatContextFailure(error, correlationId);
    throw error;
  }
  logChatContextManagement(
    "compacted",
    after,
    Math.max(
      0,
      (before.pendingCompaction?.tokensBefore ?? before.estimatedInputTokens) -
        after.estimatedInputTokens,
    ),
    correlationId,
  );
  return after;
}
