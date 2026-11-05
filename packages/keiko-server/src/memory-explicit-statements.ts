// A person's explicit memory statements in a chat. They need no model and no approval, so they act
// at once in every mode (ADR-0146 D4b). Everything destructive goes through the one forget
// implementation in memory-handlers.ts.

import type { ConversationMemoryActionWire } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { MemoryRecord, MemoryScope } from "@oscharko-dev/keiko-contracts/memory";
import { isForgettableStatement, type CaptureOutcome } from "@oscharko-dev/keiko-memory-capture";
import type { MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";

import type { UiHandlerDeps } from "./deps.js";
import type { ChatMessage } from "./store/types.js";
import {
  confirmRestatedMemory,
  persistCapturedMemory,
  reuseCapturedMemory,
  type PersistedCapturedMemory,
} from "./memory-capture-persistence.js";
import type { MemoryCaptureSuppressionReason } from "./memory-capture-policy.js";
import { insertSalienceMemoryWithNoveltyGate } from "./memory-embedding.js";
import {
  logExplicitMemoryForget,
  logExplicitMemoryRemember,
} from "./memory-explicit-statement-log.js";
import { forgetMemoryFromStatement, forgetStatementNotLearned } from "./memory-handlers.js";

type RejectedCaptureOutcome = Extract<CaptureOutcome, { readonly kind: "rejected" }>;

export interface ExplicitStatementContext {
  readonly scopes: readonly MemoryScope[];
  readonly previousStatement: () => string | undefined;
  readonly correlationId: string;
}

export type ExplicitStatementPersistence =
  | {
      readonly kind: "persisted";
      readonly persisted: PersistedCapturedMemory;
      readonly confirmed: boolean;
    }
  | { readonly kind: "suppressed"; readonly reason: MemoryCaptureSuppressionReason };

// The person's message before this one. The list holds this turn's own message already when the
// caller admitted it first, so a same-text newest row is skipped.
export function previousUserMessage(
  deps: UiHandlerDeps,
  content: string,
  conversationId: string,
): ChatMessage | undefined {
  const messages = deps.store.listMessages(conversationId).filter((m) => m.role === "user");
  const newest = messages.at(-1);
  return newest?.content === content ? messages.at(-2) : newest;
}

function statementRefused(reason: string): ConversationMemoryActionWire {
  return { kind: "rejected", reason, explicitStatement: true };
}

function forgotAction(memoryId: string): ConversationMemoryActionWire {
  return { kind: "forget", memoryId, requiresConfirmation: false, forgotten: true };
}

export function forgetActionFromOutcome(
  outcome: Extract<CaptureOutcome, { readonly kind: "forget" }>,
  deps: UiHandlerDeps,
  correlationId: string,
): ConversationMemoryActionWire | null {
  if (deps.memoryVault === undefined) return null;
  const { memoryId } = outcome.operation;
  const result = forgetMemoryFromStatement(deps, deps.memoryVault, memoryId, correlationId);
  logExplicitMemoryForget(result, correlationId);
  return result === "forgotten"
    ? forgotAction(String(memoryId))
    : statementRefused("forget-not-applied");
}

// "Vergiss das" with no memory it could mean: the statement before it, which nothing was stored from.
// Without one there is nothing to refer to, and the person is asked.
async function forgetPreviousStatement(
  deps: UiHandlerDeps,
  statement: ExplicitStatementContext,
): Promise<ConversationMemoryActionWire> {
  const { correlationId } = statement;
  const body = statement.previousStatement();
  if (body === undefined || deps.memoryVault === undefined || !isForgettableStatement(body)) {
    logExplicitMemoryForget("ambiguous", correlationId);
    return statementRefused("ambiguous-forget");
  }
  const result = await forgetStatementNotLearned(
    deps,
    deps.memoryVault,
    body,
    statement.scopes,
    correlationId,
  );
  logExplicitMemoryForget(result, correlationId);
  return result === "forgotten"
    ? forgotAction(correlationId)
    : statementRefused("forget-not-applied");
}

function logRefusedStatement(outcome: RejectedCaptureOutcome, correlationId: string): void {
  if (outcome.statement === "forget") {
    logExplicitMemoryForget(
      outcome.reason === "ambiguous-forget" ? "ambiguous" : "refused",
      correlationId,
    );
  } else if (outcome.statement === "remember") {
    logExplicitMemoryRemember("refused", correlationId);
  }
}

// A person's own statement gets its answer in the chat. A refusal of what was only learned, or of
// an ordinary message, stays out of it.
export async function rejectedActionFromOutcome(
  outcome: RejectedCaptureOutcome,
  deps: UiHandlerDeps,
  statement: ExplicitStatementContext,
): Promise<ConversationMemoryActionWire> {
  if (outcome.reason === "forget-reference-unresolved") {
    return forgetPreviousStatement(deps, statement);
  }
  logRefusedStatement(outcome, statement.correlationId);
  return outcome.statement === undefined || outcome.statement === "ambient"
    ? { kind: "rejected", reason: outcome.reason }
    : statementRefused(outcome.reason);
}

// A candidate the capture pipeline accepted and the server then refuses.
export function refusedCandidateAction(
  reason: string,
  explicit: boolean,
  correlationId: string,
): ConversationMemoryActionWire {
  if (!explicit) return { kind: "rejected", reason };
  logExplicitMemoryRemember("refused", correlationId);
  return statementRefused(reason);
}

async function storeUnlessKnownParaphrase(
  deps: UiHandlerDeps,
  vault: MemoryVaultStore,
  candidate: MemoryRecord,
): Promise<ExplicitStatementPersistence> {
  const outcome = await insertSalienceMemoryWithNoveltyGate(deps, vault, candidate);
  if (outcome.kind === "suppressed") return outcome;
  if (outcome.kind === "inserted") {
    return {
      kind: "persisted",
      persisted: { memory: outcome.record, inserted: true, promoted: false },
      confirmed: false,
    };
  }
  const existing = vault.getMemory(outcome.mergedInto);
  if (existing === undefined) throw new Error("Merged memory disappeared during capture.");
  return {
    kind: "persisted",
    // The novelty gate has already recorded this confirmation on the merge.
    persisted: reuseCapturedMemory(vault, existing, candidate),
    confirmed: true,
  };
}

function rememberOutcome(
  result: ExplicitStatementPersistence,
): "stored" | "confirmed" | "suppressed" {
  if (result.kind === "suppressed") return "suppressed";
  return result.confirmed ? "confirmed" : "stored";
}

// A statement said twice is one memory with a recorded confirmation: in the same words without an
// embedder, as a paraphrase with one. A replay of the same turn changes nothing.
export async function persistExplicitStatement(
  deps: UiHandlerDeps,
  vault: MemoryVaultStore,
  candidate: MemoryRecord,
  canonicalCapture: boolean,
  correlationId: string,
): Promise<ExplicitStatementPersistence> {
  if (canonicalCapture && vault.getMemory(candidate.id) !== undefined) {
    logExplicitMemoryRemember("replayed", correlationId);
    return {
      kind: "persisted",
      persisted: persistCapturedMemory(vault, candidate, true),
      confirmed: false,
    };
  }
  const restated = confirmRestatedMemory(vault, candidate);
  const result: ExplicitStatementPersistence =
    restated === undefined
      ? await storeUnlessKnownParaphrase(deps, vault, candidate)
      : { kind: "persisted", persisted: restated, confirmed: true };
  logExplicitMemoryRemember(rememberOutcome(result), correlationId);
  return result;
}
