import type {
  ChatContextStatusWire,
  GroundedPromptContextWire,
} from "@oscharko-dev/keiko-contracts/bff-wire";
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
import { CONVERSATION_SYSTEM_PROMPT, composeConversationPrompt } from "./conversation-prompt.js";
import {
  conversationForGatewayWithCompaction,
  countConversationCheckpointTokens,
  type ConversationCompactionOutcome,
} from "./conversation-compaction.js";
import {
  captureChatHistoryWithCheckpoint,
  checkpointFitsProfile,
  loadHistoryCheckpoint,
  stampHistoryRevision,
  type LoadedHistoryCheckpoint,
} from "./chat-history-snapshot.js";
import { persistChatCompactionEvidence } from "./chat-compaction-evidence.js";
import { UiStoreError } from "./store/index.js";
import { logChatContextFailure, logChatContextManagement } from "./chat-context-log.js";
import {
  contextBreakdown,
  type ContextBreakdownInput,
  type ConversationShare,
} from "./chat-context-breakdown.js";
import {
  AUTOMATIC_COMPACTION_TARGET,
  AUTOMATIC_COMPACTION_THRESHOLD,
} from "./chat-compaction-thresholds.js";
import { hasGroundingScope } from "./chat-grounding.js";
import {
  groundedConversationLaneProfile,
  groundedHistoryLaneTokens,
} from "./grounded-conversation-continuity.js";

function checkpointForProfile(
  loaded: LoadedHistoryCheckpoint,
  profile: ContextProfile,
): ContextCompactionRecord | undefined {
  const checkpoint = loaded.record;
  if (checkpoint?.conversationCoverage?.contextWindowTokens === undefined) return undefined;
  return checkpointFitsProfile(checkpoint, profile) ? checkpoint : undefined;
}

interface CountedHistory {
  readonly tokens: number;
  readonly systemTokens: number;
  readonly messageTokens: number;
  readonly messages: number;
  readonly checkpointUsed: boolean;
  readonly checkpointTokens: number;
  readonly latestPromptContext: GroundedPromptContextWire | undefined;
}

function countHistory(
  deps: UiHandlerDeps,
  chatId: string,
  profile: ContextProfile,
  checkpoint: ContextCompactionRecord | undefined,
): CountedHistory {
  const systemTokens = countGatewayPromptTokens(
    { messages: [{ role: "system", content: CONVERSATION_SYSTEM_PROMPT }] },
    profile.tokenAccounting,
  );
  let messageTokens = 0;
  let messages = 0;
  let checkpointUsed = false;
  let checkpointTokens = 0;
  let latestPromptContext: GroundedPromptContextWire | undefined;
  const empty = countGatewayPromptTokens({ messages: [] }, profile.tokenAccounting);
  deps.store.visitGatewayMessageUnits(chatId, "", (unit) => {
    for (const message of [...unit].reverse()) {
      latestPromptContext ??= message.groundedAnswer?.promptContext;
      if (message.id === checkpoint?.conversationCoverage?.throughMessageId) {
        checkpointTokens = countConversationCheckpointTokens(checkpoint, profile.tokenAccounting);
        checkpointUsed = true;
        return false;
      }
      if (message.role !== "user" && message.role !== "assistant") continue;
      messageTokens +=
        countGatewayPromptTokens(
          { messages: [{ role: message.role, content: message.content }] },
          profile.tokenAccounting,
        ) - empty;
      messages += 1;
    }
    return undefined;
  });
  return {
    tokens: systemTokens + checkpointTokens + messageTokens,
    systemTokens,
    messageTokens,
    messages,
    checkpointUsed,
    checkpointTokens,
    latestPromptContext,
  };
}

// The send path compacts proactively once the prompt reaches 90 % of the input budget and then
// targets 70 % (chat-compaction-thresholds.ts, shared with selectGatewayPromptAssembly). The meter
// applies the same rule, so it reports what the next request will actually carry instead of the raw
// stored history — a history larger than the window is never shown as 340 % of it (customer report
// on 1.1.13).

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

interface PendingProjection {
  readonly wire: NonNullable<ChatContextStatusWire["pendingCompaction"]>;
  readonly conversation: ConversationShare;
}

// The first projected message is the system message carrying the continuity summary; everything
// after it is carried verbatim.
function projectedConversation(
  outcome: ConversationCompactionOutcome,
  systemTokens: number,
  accounting: ContextProfile["tokenAccounting"],
): ConversationShare {
  const [first, ...rest] = outcome.messages;
  const firstTokens =
    first === undefined ? 0 : countGatewayPromptTokens({ messages: [first] }, accounting);
  const total = countGatewayPromptTokens({ messages: outcome.messages }, accounting);
  return {
    systemTokens,
    summaryTokens: Math.max(0, firstTokens - systemTokens),
    summaryCount: outcome.compaction?.itemsBefore ?? 0,
    messageTokens: Math.max(0, total - firstTokens),
    messageCount: rest.length,
  };
}

// The send path assembles the next request with its current user message, whose empty scaffold
// alone is already part of the prompt it compares with the threshold and compacts to the target
// (selectGatewayPromptAssembly; grounded continuity assembles exactly that empty request). The
// meter counts the same scaffold, so a history just below the threshold is not reported as fitting
// while the send path compacts it (PR #3678 review). A draft only adds to it when sent.
function currentRequestScaffoldTokens(accounting: ContextProfile["tokenAccounting"]): number {
  const empty = countGatewayPromptTokens({ messages: [] }, accounting);
  const scaffold = { role: "user" as const, content: composeConversationPrompt("", []) };
  return countGatewayPromptTokens({ messages: [scaffold] }, accounting) - empty;
}

function pendingCompaction(
  deps: UiHandlerDeps,
  chatId: string,
  profile: ContextProfile,
  counted: CountedHistory,
  correlationId: string | undefined,
  loaded: LoadedHistoryCheckpoint,
): PendingProjection | undefined {
  const scaffold = currentRequestScaffoldTokens(profile.tokenAccounting);
  if (counted.tokens + scaffold < profile.effectiveInputBudget * AUTOMATIC_COMPACTION_THRESHOLD)
    return undefined;
  const target = Math.floor(profile.effectiveInputBudget * AUTOMATIC_COMPACTION_TARGET) - scaffold;
  const outcome = compactionProjection(deps, chatId, profile, target, correlationId, loaded);
  if (outcome === undefined) return undefined;
  const tokensAfter = countGatewayPromptTokens(
    { messages: outcome.messages },
    profile.tokenAccounting,
  );
  if (tokensAfter >= counted.tokens) return undefined;
  return {
    wire: {
      tokensBefore: counted.tokens,
      tokensAfter,
      messagesCompacted: outcome.compaction?.itemsBefore ?? 0,
    },
    conversation: projectedConversation(outcome, counted.systemTokens, profile.tokenAccounting),
  };
}

function storedConversation(
  counted: CountedHistory,
  checkpoint: ContextCompactionRecord | undefined,
): ConversationShare {
  return {
    systemTokens: counted.systemTokens,
    summaryTokens: counted.checkpointTokens,
    summaryCount: counted.checkpointUsed ? (checkpoint?.itemsBefore ?? 0) : 0,
    messageTokens: counted.messageTokens,
    messageCount: counted.messages,
  };
}

type GroundedLane = Pick<NonNullable<ContextBreakdownInput["grounded"]>, "historyLaneTokens">;

// While the chat is grounded, its next question carries sources beside the conversation lane.
function groundedShare(
  deps: UiHandlerDeps,
  chatId: string,
  profile: ContextProfile,
): GroundedLane | undefined {
  const chat = deps.store.findChatById(chatId);
  if (chat === undefined || !hasGroundingScope(chat)) return undefined;
  return { historyLaneTokens: groundedHistoryLaneTokens(profile) };
}

// The latest grounded request describes the current request's shape only while the chat is still
// grounded and the model still plans the window that request was planned for. After a model switch
// or changed input/output limits its reference counts and size are history: the meter keeps the source share
// (fitted to the current budget) but does not present the old request as the last one.
function currentGroundedRequest(
  lastPrompt: GroundedPromptContextWire | undefined,
  grounded: boolean,
  profile: ContextProfile,
  modelId: string,
): GroundedPromptContextWire | undefined {
  if (!grounded || lastPrompt === undefined) return undefined;
  return lastPrompt.modelId === modelId &&
    lastPrompt.contextWindowTokens === profile.maxInputTokens &&
    lastPrompt.inputBudgetTokens === profile.effectiveInputBudget &&
    lastPrompt.reservedOutputTokens === profile.reservedOutputTokens
    ? lastPrompt
    : undefined;
}

function groundedSourceEstimate(
  grounding: GroundedLane | undefined,
  observed: GroundedPromptContextWire | undefined,
  current: GroundedPromptContextWire | undefined,
): ContextBreakdownInput["grounded"] {
  if (grounding === undefined) return undefined;
  const lastPrompt =
    observed === undefined || current !== undefined
      ? observed
      : { ...observed, sentReferenceCount: 0, availableReferenceCount: 0 };
  return { ...grounding, lastPrompt };
}

function groundedStatusFields(
  lastPrompt: GroundedPromptContextWire | undefined,
): Pick<ChatContextStatusWire, "knowledgeSources" | "lastRequest"> {
  if (lastPrompt === undefined) return {};
  return {
    lastRequest: {
      promptTokens: lastPrompt.promptTokens,
      measured: lastPrompt.promptTokensMeasured,
      ...(lastPrompt.promptTokensMeasured && lastPrompt.estimatedPromptTokens !== undefined
        ? { estimatedTokens: lastPrompt.estimatedPromptTokens }
        : {}),
    },
    knowledgeSources: {
      tokens: lastPrompt.sourceTokens,
      sentReferenceCount: lastPrompt.sentReferenceCount,
      availableReferenceCount: lastPrompt.availableReferenceCount,
    },
  };
}

export function readChatContextStatus(
  deps: UiHandlerDeps,
  chatId: string,
  modelId: string,
  correlationId?: string,
): ChatContextStatusWire {
  const loaded = loadHistoryCheckpoint({ ...deps, chatId, correlationId });
  return contextStatusWithCheckpoint(deps, chatId, modelId, correlationId, loaded);
}

function inspectConversationContext(
  deps: UiHandlerDeps,
  chatId: string,
  modelId: string,
  profile: ContextProfile,
  loaded: LoadedHistoryCheckpoint,
): {
  readonly conversationProfile: ContextProfile;
  readonly checkpoint: ContextCompactionRecord | undefined;
  readonly counted: CountedHistory;
  readonly currentPrompt: GroundedPromptContextWire | undefined;
  readonly grounded: ContextBreakdownInput["grounded"];
} {
  const currentGrounding = groundedShare(deps, chatId, profile);
  // Checkpoint validity, counting and pending compaction use the same conversation profile as
  // the grounded send path. Comparing its 8,000-token checkpoint against a full model window
  // would discard a valid checkpoint as though that lane had expanded.
  const conversationProfile =
    currentGrounding === undefined ? profile : groundedConversationLaneProfile(profile);
  const checkpoint = checkpointForProfile(loaded, conversationProfile);
  const counted = countHistory(deps, chatId, conversationProfile, checkpoint);
  const currentPrompt = currentGroundedRequest(
    counted.latestPromptContext,
    currentGrounding !== undefined,
    profile,
    modelId,
  );
  const grounded = groundedSourceEstimate(
    currentGrounding,
    counted.latestPromptContext,
    currentPrompt,
  );
  return { conversationProfile, checkpoint, counted, currentPrompt, grounded };
}

function contextStatusWithCheckpoint(
  deps: UiHandlerDeps,
  chatId: string,
  modelId: string,
  correlationId: string | undefined,
  loaded: LoadedHistoryCheckpoint,
): ChatContextStatusWire {
  const profile = currentContextProfileForModel(deps, modelId) ?? DEFAULT_CONTEXT_PROFILE;
  const { conversationProfile, checkpoint, counted, currentPrompt, grounded } =
    inspectConversationContext(deps, chatId, modelId, profile, loaded);
  const pending = pendingCompaction(
    deps,
    chatId,
    conversationProfile,
    counted,
    correlationId,
    loaded,
  );
  const breakdown = contextBreakdown({
    profile,
    conversation: pending?.conversation ?? storedConversation(counted, checkpoint),
    grounded,
  });
  return {
    modelId,
    contextWindowTokens: profile.maxInputTokens,
    ...(profile.inputTokenLimit === undefined ? {} : { inputLimitTokens: profile.inputTokenLimit }),
    ...assumedWindowField(deps, modelId),
    inputBudgetTokens: profile.effectiveInputBudget,
    reservedOutputTokens: profile.reservedOutputTokens,
    safetyMarginTokens: profile.safetyMarginTokens,
    estimatedInputTokens: breakdown.usedTokens,
    canCompact: counted.messages >= 2,
    ...checkpointSavings(checkpoint, counted),
    ...(pending === undefined ? {} : { pendingCompaction: pending.wire }),
    ...groundedStatusFields(currentPrompt),
    segments: breakdown.segments,
    autoCompactionAtTokens: breakdown.autoCompactionAtTokens,
    ...(grounded === undefined
      ? {}
      : { conversationInputBudgetTokens: grounded.historyLaneTokens }),
  };
}

function compactionProjection(
  deps: UiHandlerDeps,
  chatId: string,
  profile: ContextProfile,
  budget: number,
  correlationId: string | undefined,
  loadedCheckpoint: LoadedHistoryCheckpoint,
): ConversationCompactionOutcome | undefined {
  const snapshot = captureChatHistoryWithCheckpoint({
    store: deps.store,
    evidenceStore: deps.evidenceStore,
    chatId,
    currentUserMessageId: "",
    profile,
    redactionSecrets: currentRedactionSecrets(deps),
    correlationId,
    loadedCheckpoint,
  });
  try {
    return conversationForGatewayWithCompaction(snapshot.history, {
      contextProfile: profile,
      effectiveInputBudget: budget,
      earlierCompaction: snapshot.earlierCompaction,
      redactionSecrets: currentRedactionSecrets(deps),
      // The stored history holds no current request: like the send path's history prefix, even
      // its newest turn may be summarized — an answer larger than the window must not pin it.
      preserveNewestTurn: false,
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
  correlationId: string,
  loadedCheckpoint: LoadedHistoryCheckpoint,
): ContextCompactionRecord | undefined {
  const modelProfile = currentContextProfileForModel(deps, modelId) ?? DEFAULT_CONTEXT_PROFILE;
  const profile =
    groundedShare(deps, chatId, modelProfile) === undefined
      ? modelProfile
      : groundedConversationLaneProfile(modelProfile);
  const snapshot = captureChatHistoryWithCheckpoint({
    store: deps.store,
    evidenceStore: deps.evidenceStore,
    chatId,
    currentUserMessageId: "",
    profile,
    redactionSecrets: currentRedactionSecrets(deps),
    correlationId,
    loadedCheckpoint,
  });
  // The conversation's own stored size: in a grounded chat the reading also carries the sources,
  // which compaction never touches (PR #3678 review).
  const checkpoint = checkpointForProfile(loadedCheckpoint, profile);
  const stored = countHistory(deps, chatId, profile, checkpoint).tokens;
  const budget = Math.floor(
    Math.min(profile.effectiveInputBudget, stored) * AUTOMATIC_COMPACTION_TARGET,
  );
  try {
    const outcome = conversationForGatewayWithCompaction(snapshot.history, {
      contextProfile: profile,
      effectiveInputBudget: budget,
      earlierCompaction: snapshot.earlierCompaction,
      redactionSecrets: currentRedactionSecrets(deps),
      preserveNewestTurn: false,
    });
    const record = stampHistoryRevision(
      outcome.compaction,
      snapshot.historyRevision ?? 0,
      profile.maxInputTokens,
      profile.effectiveInputBudget,
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
  const loaded = loadHistoryCheckpoint({ ...deps, chatId, correlationId });
  const before = contextStatusWithCheckpoint(deps, chatId, modelId, correlationId, loaded);
  const compaction = manualCompactionCandidate(deps, chatId, modelId, correlationId, loaded);
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
  // The compaction record states what the conversation saved; the readings also carry sources.
  logChatContextManagement(
    "compacted",
    after,
    Math.max(0, compaction.tokensBefore - compaction.tokensAfter),
    correlationId,
  );
  return after;
}
