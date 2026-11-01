import type { ContextCompactionRecord } from "@oscharko-dev/keiko-contracts";
import type { UiHandlerDeps } from "./deps.js";
import { currentContextProfileForModel, currentAuditRedactString } from "./deps.js";
import { UiStoreError } from "./store/index.js";
import { countConversationCheckpointTokens } from "./conversation-compaction.js";
import { logChatContinuityCheckpoint } from "./chat-continuity-log.js";
import { emitServerDiagnostic, serverDiagnosticFromError } from "./diagnostics-log.js";
import { correlationIdOrUnknown } from "./correlation.js";

interface CheckpointInput {
  readonly chatId: string;
  readonly modelId: string | undefined;
  readonly compaction: ContextCompactionRecord;
  readonly correlationId?: string | undefined;
}

class CheckpointWriteError extends Error {
  public readonly outcome: "stale" | "rejected";
  public constructor(outcome: "stale" | "rejected") {
    super("Private context checkpoint was not accepted.");
    this.outcome = outcome;
  }
}

/** Required private state is independent of best-effort audit retention and projection. */
export function persistRequiredChatContinuityCheckpoint(
  deps: UiHandlerDeps,
  input: CheckpointInput,
  expectedCheckpoint?: { readonly generation?: number | undefined },
): void {
  const record = input.compaction;
  if (record.conversationCoverage === undefined) return;
  try {
    const current = deps.store.readChatContinuityCheckpoint(input.chatId);
    const generation = current?.generation;
    assertExpectedGeneration(generation, expectedCheckpoint);
    if (current !== undefined && largerCanonicalCheckpoint(current.record, record)) {
      logChatContinuityCheckpoint(
        { operation: "write", outcome: "retained", generation: current.generation },
        input.correlationId,
      );
      return;
    }
    const checkpoint = retainCurrentSummary(record, current?.record);
    const projected = {
      ...checkpoint,
      tokensAfter: countConversationCheckpointTokens(
        checkpoint,
        currentContextProfileForModel(deps, input.modelId)?.tokenAccounting,
      ),
    };
    if (!deps.store.writeChatContinuityCheckpoint(input.chatId, projected, generation)) {
      throw new CheckpointWriteError("rejected");
    }
    logChatContinuityCheckpoint(
      { operation: "write", outcome: "persisted", generation: (generation ?? 0) + 1 },
      input.correlationId,
    );
  } catch (error) {
    throw checkpointFailure(deps, input, error);
  }
}

function assertExpectedGeneration(
  generation: number | undefined,
  expected: { readonly generation?: number | undefined } | undefined,
): void {
  if (expected !== undefined && generation !== expected.generation)
    throw new CheckpointWriteError("stale");
}

function largerCanonicalCheckpoint(
  current: ContextCompactionRecord | undefined,
  record: ContextCompactionRecord,
): boolean {
  if (current === undefined) return false;
  const a = current.conversationCoverage,
    b = record.conversationCoverage;
  if (a === undefined || b === undefined) return false;
  return (
    current.itemsBefore > record.itemsBefore &&
    a.historyRevision === b.historyRevision &&
    a.contextWindowTokens === b.contextWindowTokens &&
    a.effectiveInputBudget === b.effectiveInputBudget
  );
}

function retainCurrentSummary(
  record: ContextCompactionRecord,
  current: ContextCompactionRecord | undefined,
): ContextCompactionRecord {
  if (current?.modelSummary?.status !== "valid" || record.modelSummary?.status === "valid")
    return record;
  if (!matchesCoveredPrefix(current, record)) return record;
  return { ...record, modelSummary: current.modelSummary };
}

function matchesCoveredPrefix(
  first: ContextCompactionRecord,
  second: ContextCompactionRecord,
): boolean {
  const a = first.conversationCoverage,
    b = second.conversationCoverage;
  if (a === undefined || b === undefined) return false;
  return (
    first.itemsBefore === second.itemsBefore &&
    a.throughMessageId === b.throughMessageId &&
    a.historyRevision === b.historyRevision
  );
}

function checkpointFailure(
  deps: UiHandlerDeps,
  input: CheckpointInput,
  error: unknown,
): UiStoreError {
  const outcome = error instanceof CheckpointWriteError ? error.outcome : "failed";
  logChatContinuityCheckpoint({ operation: "write", outcome }, input.correlationId);
  emitServerDiagnostic(
    deps.diagnostics,
    serverDiagnosticFromError({
      correlationId: correlationIdOrUnknown(input.correlationId),
      operation: "chat.compaction.checkpoint",
      source: "chat-continuity-checkpoint",
      error,
      summary: "Private context checkpoint persistence failed.",
      redact: currentAuditRedactString(deps),
    }),
  );
  return new UiStoreError(
    "INTERNAL",
    outcome === "stale"
      ? "Conversation changed while saving context. Please retry."
      : "Context storage is unavailable. Please retry.",
    503,
  );
}
