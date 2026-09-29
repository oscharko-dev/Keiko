import type { ChatContextStatusWire } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { ContextCompactionRecord, ContextProfile } from "@oscharko-dev/keiko-contracts";
import { DEFAULT_CONTEXT_PROFILE } from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import { countGatewayPromptTokens } from "@oscharko-dev/keiko-model-gateway/internal/prompt-token-accounting";
import { ContextOverflowError } from "@oscharko-dev/keiko-security/errors/gateway";
import {
  currentContextProfileForModel,
  currentRedactionSecrets,
  type UiHandlerDeps,
} from "./deps.js";
import { CONVERSATION_SYSTEM_PROMPT } from "./conversation-prompt.js";
import {
  conversationForGatewayWithCompaction,
  renderStructuredSummaryLines,
} from "./conversation-compaction.js";
import { captureChatHistory, stampHistoryRevision } from "./chat-history-snapshot.js";
import { loadChatContinuityCheckpoint } from "./chat-compaction-resurfacing.js";
import { persistChatCompactionEvidence } from "./chat-compaction-evidence.js";
import { UiStoreError } from "./store/index.js";
import { logChatContextManagement } from "./chat-context-log.js";

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
): { tokens: number; messages: number; checkpointUsed: boolean } {
  let tokens = countGatewayPromptTokens(
    { messages: [{ role: "system", content: CONVERSATION_SYSTEM_PROMPT }] },
    profile.tokenAccounting,
  );
  let messages = 0;
  let checkpointUsed = false;
  const empty = countGatewayPromptTokens({ messages: [] }, profile.tokenAccounting);
  deps.store.visitGatewayMessageUnits(chatId, "", (unit) => {
    for (const message of [...unit].reverse()) {
      if (message.id === checkpoint?.conversationCoverage?.throughMessageId) {
        const summary = renderStructuredSummaryLines(
          checkpoint.itemsBefore,
          checkpoint,
          checkpoint.modelSummary,
        ).join("\n");
        tokens +=
          countGatewayPromptTokens(
            { messages: [{ role: "system", content: summary }] },
            profile.tokenAccounting,
          ) - empty;
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
  return { tokens, messages, checkpointUsed };
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
  return {
    modelId,
    contextWindowTokens: profile.maxInputTokens,
    inputBudgetTokens: profile.effectiveInputBudget,
    reservedOutputTokens: profile.reservedOutputTokens,
    safetyMarginTokens: profile.safetyMarginTokens,
    estimatedInputTokens: counted.tokens,
    canCompact: counted.messages >= 2,
    ...(checkpoint === undefined || !counted.checkpointUsed
      ? {}
      : {
          compaction: {
            tokensBefore: checkpoint.tokensBefore,
            tokensAfter: checkpoint.tokensAfter,
            tokensSaved: Math.max(0, checkpoint.tokensBefore - checkpoint.tokensAfter),
            messagesCompacted: checkpoint.itemsBefore,
          },
        }),
  };
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
  );
  const budget = Math.floor(
    Math.min(profile.effectiveInputBudget, status.estimatedInputTokens) * 0.7,
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
  });
  const after = readChatContextStatus(deps, chatId, modelId, correlationId);
  if (after.compaction?.messagesCompacted !== compaction.itemsBefore) {
    logChatContextManagement("failed", before, 0, correlationId);
    throw new UiStoreError("INTERNAL", "Context compaction could not be saved.", 500);
  }
  logChatContextManagement(
    "compacted",
    after,
    Math.max(0, before.estimatedInputTokens - after.estimatedInputTokens),
    correlationId,
  );
  return after;
}
