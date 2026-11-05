// A person's explicit memory statements in a chat. They need no model and no approval, so they act
// at once in every mode (ADR-0146 D4b). Everything destructive goes through the one forget
// implementation in memory-handlers.ts.

import { randomUUID } from "node:crypto";

import type { ConversationMemoryActionWire } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { MemoryRecord, MemoryScope } from "@oscharko-dev/keiko-contracts/memory";
import type { CaptureOutcome, RejectionReason } from "@oscharko-dev/keiko-memory-capture";
import type { MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";

import type { UiHandlerDeps } from "./deps.js";
import type { ChatMessage } from "./store/types.js";
import {
  confirmExistingMemory,
  confirmRestatedMemory,
  persistCapturedMemory,
  type PersistedCapturedMemory,
} from "./memory-capture-persistence.js";
import type { MemoryCaptureSuppressionReason } from "./memory-capture-policy.js";
import { insertSalienceMemoryWithNoveltyGate } from "./memory-embedding.js";
import {
  logExplicitMemoryForget,
  logExplicitMemoryRemember,
} from "./memory-explicit-statement-log.js";
import { forgetMemoryFromStatement, forgetStatementNotLearned } from "./memory-handlers.js";

export interface ExplicitStatementContext {
  readonly scopes: readonly MemoryScope[];
  readonly previousStatement: () => string | undefined;
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

function forgotAction(memoryId: string): ConversationMemoryActionWire {
  return { kind: "forget", memoryId, requiresConfirmation: false, forgotten: true };
}

export function forgetActionFromOutcome(
  outcome: Extract<CaptureOutcome, { readonly kind: "forget" }>,
  deps: UiHandlerDeps,
): ConversationMemoryActionWire | null {
  if (deps.memoryVault === undefined) return null;
  const { memoryId } = outcome.operation;
  const correlationId = randomUUID();
  const result = forgetMemoryFromStatement(deps, deps.memoryVault, memoryId, correlationId);
  logExplicitMemoryForget(result, correlationId);
  return result === "forgotten"
    ? forgotAction(String(memoryId))
    : { kind: "rejected", reason: "forget-not-applied" };
}

// "Vergiss das" with no memory it could mean: the statement before it, which nothing was stored from.
// Without one there is nothing to refer to, and the person is asked.
async function forgetPreviousStatement(
  deps: UiHandlerDeps,
  statement: ExplicitStatementContext,
): Promise<ConversationMemoryActionWire> {
  const correlationId = randomUUID();
  const body = statement.previousStatement();
  if (body === undefined || deps.memoryVault === undefined) {
    logExplicitMemoryForget("ambiguous", correlationId);
    return { kind: "rejected", reason: "ambiguous-forget" };
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
    : { kind: "rejected", reason: "forget-not-applied" };
}

export async function rejectedActionFromOutcome(
  reason: RejectionReason,
  deps: UiHandlerDeps,
  statement: ExplicitStatementContext,
): Promise<ConversationMemoryActionWire> {
  if (reason === "forget-reference-unresolved") return forgetPreviousStatement(deps, statement);
  if (reason === "ambiguous-forget") logExplicitMemoryForget("ambiguous", randomUUID());
  return { kind: "rejected", reason };
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
    persisted: confirmExistingMemory(vault, existing, candidate),
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
): Promise<ExplicitStatementPersistence> {
  if (canonicalCapture && vault.getMemory(candidate.id) !== undefined) {
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
  logExplicitMemoryRemember(rememberOutcome(result), randomUUID());
  return result;
}
