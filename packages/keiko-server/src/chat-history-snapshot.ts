import type { ContextCompactionRecord, ContextProfile } from "@oscharko-dev/keiko-contracts";
import {
  CONTEXT_ENGINEERING_SCHEMA_VERSION,
  countContextTokens,
  countContextTokensForSegments,
} from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import {
  buildStructuredCompactionDigest,
  mergeHistoryDigests,
  type CompactionDigest,
} from "@oscharko-dev/keiko-workflows/context-budget";
import type { ChatMessage, UiStore } from "./store/index.js";
import { usableGatewayTurns } from "./conversation-gateway.js";
import {
  boundedConversationSourceSpans,
  renderStructuredSummaryLines,
} from "./conversation-compaction.js";

export interface GatewayHistorySnapshot {
  readonly history: readonly ChatMessage[];
  readonly currentUserMessageId: string;
  readonly historyRevision?: number | undefined;
  readonly earlierCompaction?: ContextCompactionRecord | undefined;
  readonly rehydratedContext?: string | undefined;
}

interface HistoryAccumulator {
  readonly units: ChatMessage[][];
  tokens: number;
  compactedCount: number;
  compactedTokens: number;
  digest: CompactionDigest;
  modelSummary: ContextCompactionRecord["modelSummary"];
  sourceSpans: NonNullable<ContextCompactionRecord["sourceSpans"]>[number][];
  throughMessageId: string | undefined;
}

// The database visitor retains canonical turn eligibility and reads bounded pages. Keep a bounded
// verbatim tail and fold every older eligible turn into the existing structured compaction record.
// A count-based read cap must never silently discard a budget-safe turn before compaction sees it.
export function captureChatHistory(
  store: UiStore,
  chatId: string,
  currentUserMessageId: string,
  profile: ContextProfile,
  redactionSecrets: readonly string[],
  suppliedCheckpoint?: ContextCompactionRecord,
): GatewayHistorySnapshot {
  const historyRevision = store.chatHistoryRevision(chatId);
  const checkpoint =
    suppliedCheckpoint?.conversationCoverage?.historyRevision === historyRevision
      ? suppliedCheckpoint
      : undefined;
  const state = emptyHistoryAccumulator();
  store.visitGatewayMessageUnits(chatId, currentUserMessageId, (unit) => {
    const boundary = unit.findIndex(
      (message) => message.id === checkpoint?.conversationCoverage?.throughMessageId,
    );
    if (
      checkpoint !== undefined &&
      boundary >= 0 &&
      shouldRestoreCheckpoint(state, checkpoint, profile)
    ) {
      const afterBoundary = unit.slice(boundary + 1);
      if (afterBoundary.length > 0)
        consumeHistoryUnit(state, afterBoundary, currentUserMessageId, profile, redactionSecrets);
      restoreCheckpoint(state, checkpoint);
      return false;
    }
    consumeHistoryUnit(state, unit, currentUserMessageId, profile, redactionSecrets);
    return undefined;
  });
  state.units.reverse();
  const history = state.units.flat();
  return {
    history,
    currentUserMessageId,
    historyRevision,
    earlierCompaction: stampHistoryRevision(
      earlierRecord(state, profile),
      historyRevision,
      profile.maxInputTokens,
    ),
  };
}

function consumeHistoryUnit(
  state: HistoryAccumulator,
  unit: readonly ChatMessage[],
  currentUserMessageId: string,
  profile: ContextProfile,
  redactionSecrets: readonly string[],
): void {
  const turns = usableGatewayTurns(unit);
  const tokens = countContextTokensForSegments(
    turns.map((turn) => turn.content),
    profile.tokenAccounting,
  );
  if (
    unit.some((message) => message.id === currentUserMessageId) ||
    (state.compactedCount === 0 && state.tokens + tokens <= profile.effectiveInputBudget)
  ) {
    state.units.push([...unit]);
    state.tokens += tokens;
    return;
  }
  const older = buildStructuredCompactionDigest({ entries: turns, redactionSecrets });
  state.throughMessageId ??= unit.at(-1)?.id;
  state.digest = mergeHistoryDigests(older, state.digest);
  state.compactedCount += turns.length;
  state.compactedTokens += tokens;
  state.sourceSpans.unshift(
    ...turns.map((turn) => ({ kind: "message" as const, stableId: turn.stableId })),
  );
  state.sourceSpans = [...boundedConversationSourceSpans(state.sourceSpans)];
}

function restoreCheckpoint(state: HistoryAccumulator, record: ContextCompactionRecord): void {
  state.modelSummary = record.modelSummary;
  state.digest = mergeHistoryDigests(record, state.digest);
  state.compactedCount += record.itemsBefore;
  state.compactedTokens += record.tokensBefore;
  state.throughMessageId ??= record.conversationCoverage?.throughMessageId;
  state.sourceSpans.unshift(...boundedConversationSourceSpans(record.sourceSpans ?? []));
  state.sourceSpans = [...boundedConversationSourceSpans(state.sourceSpans)];
}

function earlierRecord(
  state: HistoryAccumulator,
  profile: ContextProfile,
): ContextCompactionRecord | undefined {
  if (state.compactedCount === 0) return undefined;
  const summary = renderStructuredSummaryLines(
    state.compactedCount,
    state.digest,
    state.modelSummary,
  ).join("\n");
  return {
    schemaVersion: CONTEXT_ENGINEERING_SCHEMA_VERSION,
    laneId: "history-summary",
    reason: "paged history exceeded the verbatim token budget",
    itemsBefore: state.compactedCount,
    itemsAfter: 1,
    tokensBefore: state.compactedTokens,
    tokensAfter: countContextTokens(summary, profile.tokenAccounting),
    orderedAt: state.compactedCount,
    sourceSpans: state.sourceSpans,
    ...state.digest,
    ...(state.modelSummary === undefined ? {} : { modelSummary: state.modelSummary }),
    ...(state.throughMessageId === undefined
      ? {}
      : {
          conversationCoverage: {
            version: 1 as const,
            throughMessageId: state.throughMessageId,
            historyRevision: 0,
          },
        }),
  };
}

export function stampHistoryRevision(
  record: ContextCompactionRecord | undefined,
  historyRevision: number,
  contextWindowTokens?: number,
): ContextCompactionRecord | undefined {
  return record?.conversationCoverage === undefined
    ? record
    : {
        ...record,
        conversationCoverage: {
          ...record.conversationCoverage,
          historyRevision,
          ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
        },
      };
}

function shouldRestoreCheckpoint(
  state: HistoryAccumulator,
  record: ContextCompactionRecord,
  profile: ContextProfile,
): boolean {
  const originalWindow = record.conversationCoverage?.contextWindowTokens;
  return (
    (originalWindow !== undefined && profile.maxInputTokens <= originalWindow) ||
    state.tokens + record.tokensBefore > profile.effectiveInputBudget
  );
}

function emptyHistoryAccumulator(): HistoryAccumulator {
  return {
    units: [],
    tokens: 0,
    compactedCount: 0,
    compactedTokens: 0,
    digest: {},
    sourceSpans: [],
    throughMessageId: undefined,
    modelSummary: undefined,
  };
}
