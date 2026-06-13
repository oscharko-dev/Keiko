// Server-side orchestration for model-assisted salience capture (Keiko "learns from experience").
//
// After a chat turn, this module asks the model to extract durable, salient facts the USER stated
// in natural conversation and persists them as `proposed` memory candidates — IN ADDITION to the
// regex intent path in chat-handlers.ts. The capture filter is intentionally LOW; a later
// decay/consolidation pass prunes.
//
// This is the model/IO boundary: the WHOLE body runs inside one try/catch so a model error, a
// vault hiccup, or any other failure can NEVER throw into the chat path — it logs and returns [].

import { randomUUID } from "node:crypto";
import type { ConversationMemoryActionWire } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { MemoryId, MemoryProposalId, MemoryScope } from "@oscharko-dev/keiko-contracts/memory";
import { redact } from "@oscharko-dev/keiko-security";
import {
  extractSalientMemories,
  memoryTextEgressRejectionReason,
  type CaptureContext,
  type CaptureOutcome,
} from "@oscharko-dev/keiko-memory-capture";
import type { MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";
import type { UiHandlerDeps } from "./deps.js";
import { currentRedactionSecrets } from "./deps.js";
import {
  conversationMemoryScopes,
  type ConversationMemoryRuntimeContext,
} from "./memory-conversation-context.js";
import { buildMemoryRecordFromProposal } from "./memory-record-builders.js";
import { embedAndStoreMemory } from "./memory-embedding.js";
import {
  isPersistableMemoryCandidate,
  memoryCapturePolicyForDeps,
  SENSITIVE_MEMORY_REJECTION_REASON,
} from "./memory-capture-policy.js";

// Mirror of chat-handlers' private scopeLabel (decision 3 — mirrored rather than exported to keep
// the modules decoupled). Pure and trivial.
function scopeLabel(scope: MemoryScope): string {
  switch (scope.kind) {
    case "user":
      return "User memory";
    case "workspace":
      return "Workspace memory";
    case "project":
      return "Project memory";
    case "workflow":
      return "Workflow memory";
    case "global":
      return "Global memory";
  }
}

// Bounds the dedup corpus so the Jaccard loop stays cheap even for a large vault.
const MAX_EXISTING_BODIES = 200;

function gatherExistingBodies(
  vault: MemoryVaultStore,
  context: ConversationMemoryRuntimeContext,
): readonly string[] {
  const seen = new Set<string>();
  for (const scope of conversationMemoryScopes(context)) {
    for (const record of vault.listMemoriesByScope(scope)) {
      seen.add(record.body);
      if (seen.size >= MAX_EXISTING_BODIES) {
        return [...seen];
      }
    }
  }
  return [...seen];
}

function buildSalienceContext(context: ConversationMemoryRuntimeContext): CaptureContext {
  return {
    userId: context.userId,
    nowMs: Date.now(),
    newMemoryId: () => randomUUID() as MemoryId,
    newProposalId: () => randomUUID() as MemoryProposalId,
    workspaceId: context.workspaceId,
    projectId: context.projectId,
    conversationId: context.conversationId,
  };
}

function buildCallModel(
  deps: UiHandlerDeps,
  modelId: string,
): ((system: string, user: string) => Promise<string>) | null {
  const model = deps.modelPortFactory(modelId);
  if (model === undefined) {
    return null;
  }
  return async (system: string, user: string): Promise<string> => {
    const response = await model.call(
      {
        modelId,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        stream: false,
      },
      new AbortController().signal,
    );
    return response.content;
  };
}

function redactedErrorMessage(error: unknown, deps: UiHandlerDeps): string {
  const message = error instanceof Error ? error.message : String(error);
  return redact(message, currentRedactionSecrets(deps));
}

// Persists one salience candidate and returns its wire action, or null when the outcome is not a
// candidate or no record could be built. Best-effort embed-on-capture (#204): the inserted memory
// is embedded and the vector stored when an embedding model is configured; failure is swallowed by
// embedAndStoreMemory so capture is never affected.
async function persistCandidate(
  deps: UiHandlerDeps,
  outcome: CaptureOutcome,
  vault: MemoryVaultStore,
): Promise<ConversationMemoryActionWire | null> {
  if (outcome.kind !== "candidate") {
    return null;
  }
  if (!isPersistableMemoryCandidate(outcome)) {
    return { kind: "rejected", reason: SENSITIVE_MEMORY_REJECTION_REASON };
  }
  const proposalId = outcome.proposal.proposalId as unknown as MemoryId;
  const record = buildMemoryRecordFromProposal(proposalId, outcome);
  if (record === null) {
    return null;
  }
  const inserted = vault.insertMemory(record);
  await embedAndStoreMemory(deps, vault, inserted.id, inserted.body);
  return {
    kind: "candidate",
    proposalId: String(inserted.id),
    body: inserted.body,
    scopeLabel: scopeLabel(inserted.scope),
    requiresApproval: outcome.requiresApproval,
  };
}

interface SalienceTurnRequest {
  readonly content: string;
  readonly memory: { readonly enabled: boolean } | undefined;
}

// Captures salient memories from a completed chat turn. Never throws — any failure (model error,
// vault error, malformed output) yields [] so the chat response is unaffected.
export async function captureSalientFromTurn(
  deps: UiHandlerDeps,
  request: SalienceTurnRequest,
  context: ConversationMemoryRuntimeContext,
  modelId: string,
  _assistantText: string,
): Promise<readonly ConversationMemoryActionWire[]> {
  const vault = deps.memoryVault;
  if (request.memory === undefined || !request.memory.enabled || vault === undefined) {
    return [];
  }
  try {
    const callModel = buildCallModel(deps, modelId);
    if (callModel === null) {
      return [];
    }
    const policy = memoryCapturePolicyForDeps(deps);
    if (memoryTextEgressRejectionReason(request.content, policy) !== null) {
      return [];
    }
    const outcomes = await extractSalientMemories(
      {
        userText: request.content,
        existingBodies: gatherExistingBodies(vault, context),
        context: buildSalienceContext(context),
        policy,
      },
      {
        callModel,
        now: () => Date.now(),
        newMemoryId: () => randomUUID() as MemoryId,
        newProposalId: () => randomUUID() as MemoryProposalId,
      },
    );
    const actions: ConversationMemoryActionWire[] = [];
    for (const outcome of outcomes) {
      const action = await persistCandidate(deps, outcome, vault);
      if (action !== null) {
        actions.push(action);
      }
    }
    return actions;
  } catch (error) {
    // Boundary: salience must never break the chat path. Log and continue.
    // eslint-disable-next-line no-console
    console.error("salience capture failed", redactedErrorMessage(error, deps));
    return [];
  }
}
