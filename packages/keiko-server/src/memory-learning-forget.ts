// #4213: "Forget …" reaches what is still waiting to be learned. When the person asks Keiko to forget
// something that was not learned yet, nothing matched at that moment. A learning pass that later
// learns the earlier turns of the same Chat reaches the forget again, in Chat order, and applies it
// to the facts it has just learned from before it. A forget that refers to the previous message
// ("Vergiss das") left its forget record at message time, which keeps that message from being
// learned at all.

import { randomUUID } from "node:crypto";
import {
  explicitStatementKind,
  extractCandidatesFromUserText,
  isMemoryForgetReference,
} from "@oscharko-dev/keiko-memory-capture";
import type { MemoryId, MemoryProposalId } from "@oscharko-dev/keiko-contracts/memory";
import type { MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";

import type { UiHandlerDeps } from "./deps.js";
import type { PendingLearningMessage } from "./store/chatMemoryLearning.js";
import {
  conversationMemoryScopes,
  type ConversationMemoryRuntimeContext,
} from "./memory-conversation-context.js";
import { memoryCapturePolicyForDeps } from "./memory-capture-policy.js";
import { logExplicitMemoryForget } from "./memory-explicit-statement-log.js";
import { forgetMemoryFromStatement } from "./memory-handlers.js";
import {
  createMemoryForgetResolver,
  createMemoryTargetResolver,
} from "./memory-target-resolver.js";

export interface PendingForgetInput {
  /** The stored message the pass reached. */
  readonly statement: PendingLearningMessage;
  readonly context: ConversationMemoryRuntimeContext;
  readonly correlationId: string;
}

// Only what this Chat learned, after the forget was written, from its own messages before the
// forget: the facts that were still pending when the person asked. A fact that also rests on words
// from anywhere else, said again after the forget, stays.
function learnedWhilePending(
  deps: UiHandlerDeps,
  vault: MemoryVaultStore,
  id: MemoryId,
  input: PendingForgetInput,
): boolean {
  const record = vault.getMemory(id);
  const writtenAt = input.statement.position.timestamp;
  const sources = record?.provenance.sourceMessageIds ?? [];
  if (record === undefined || record.createdAt < writtenAt || sources.length === 0) return false;
  return sources.every((messageId) => {
    const source = deps.store.findMessageById(messageId);
    return (
      source?.chatId === input.context.conversationId &&
      source.id !== input.statement.id &&
      source.timestamp <= writtenAt
    );
  });
}

function pendingForgetTargets(
  deps: UiHandlerDeps,
  vault: MemoryVaultStore,
  input: PendingForgetInput,
): ReadonlySet<MemoryId> {
  const matched = new Set<MemoryId>();
  const base = createMemoryForgetResolver(vault, {
    scopes: conversationMemoryScopes(input.context),
    conversationId: input.context.conversationId,
    lastTurnStartedAt: () => undefined,
    previousMessageId: () => undefined,
    previousStatement: () => undefined,
  });
  const { context } = input;
  extractCandidatesFromUserText(
    input.statement.content,
    {
      userId: context.userId,
      nowMs: Date.now(),
      newMemoryId: () => randomUUID() as MemoryId,
      newProposalId: () => randomUUID() as MemoryProposalId,
      workspaceId: context.workspaceId,
      projectId: context.projectId,
      conversationId: context.conversationId,
    },
    memoryCapturePolicyForDeps(deps, {
      resolver: createMemoryTargetResolver(vault),
      rememberScopeKind: "user",
      // Every pending fact the name matches is forgotten: the person asked for it while none of
      // them existed, so there was nothing to ask back about.
      forgetResolver: (target, scope) => {
        if (isMemoryForgetReference(target)) return [];
        const ids = base(target, scope).filter((id) => learnedWhilePending(deps, vault, id, input));
        for (const id of ids) matched.add(id);
        return ids;
      },
    }),
  );
  return matched;
}

/**
 * Applies a forget the pass reached to the facts learned from before it while they were pending.
 * Returns undefined for a message that is no forget, else how many facts were forgotten.
 */
export function replayPendingForget(
  deps: UiHandlerDeps,
  input: PendingForgetInput,
): number | undefined {
  const vault = deps.memoryVault;
  if (vault === undefined || explicitStatementKind(input.statement.content) !== "forget") {
    return undefined;
  }
  let forgotten = 0;
  for (const id of pendingForgetTargets(deps, vault, input)) {
    const result = forgetMemoryFromStatement(deps, vault, id, input.correlationId);
    logExplicitMemoryForget(result, input.correlationId);
    if (result === "forgotten") forgotten += 1;
  }
  return forgotten;
}
