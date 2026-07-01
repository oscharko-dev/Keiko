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
import { findConfiguredCapability, type ResponseFormat } from "@oscharko-dev/keiko-model-gateway";
import {
  extractSalientMemories,
  memoryTextSecretEgressRejectionReason,
  type CaptureContext,
  type CaptureOutcome,
  type SalienceDiagnostic,
} from "@oscharko-dev/keiko-memory-capture";
import type { MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";
import type { UiHandlerDeps } from "./deps.js";
import { currentGatewayConfig, currentRedactionSecrets } from "./deps.js";
import {
  conversationMemoryScopes,
  type ConversationMemoryRuntimeContext,
} from "./memory-conversation-context.js";
import { buildMemoryRecordFromProposal } from "./memory-record-builders.js";
import { insertSalienceMemoryWithNoveltyGate } from "./memory-embedding.js";
import {
  FORGOTTEN_MEMORY_SUPPRESSION_REASON,
  isPersistableMemoryCandidate,
  memoryCapturePolicyForDeps,
  SENSITIVE_MEMORY_ACTION_BODY,
  SENSITIVE_MEMORY_REJECTION_REASON,
} from "./memory-capture-policy.js";
import { isSuppressedByForgetTombstone } from "./memory-suppression.js";

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
const SALIENCE_MODEL_ENV = "KEIKO_MEMORY_SALIENCE_MODEL_ID";
const SALIENCE_DEFAULT_SEED = 204;

const SALIENCE_RESPONSE_FORMAT: ResponseFormat = {
  type: "json_schema",
  schema: {
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
      required: ["body", "type", "confidence", "scope", "source", "tags"],
      properties: {
        body: { type: "string", minLength: 1 },
        type: {
          type: "string",
          enum: [
            "identity",
            "preference",
            "fact",
            "decision",
            "constraint",
            "goal",
            "lesson",
            "procedural",
          ],
        },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        scope: { type: "string", enum: ["user", "project", "workspace"] },
        source: { type: "string", enum: ["user"] },
        tags: { type: "array", items: { type: "string" } },
      },
    },
  },
};

function gatherExistingBodies(
  vault: MemoryVaultStore,
  context: ConversationMemoryRuntimeContext,
): readonly string[] {
  const seen = new Set<string>();
  for (const scope of conversationMemoryScopes(context)) {
    for (const record of vault.listMemoriesByScope(scope, { status: ["accepted"] })) {
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
  const responseFormat = salienceResponseFormatFor(deps, modelId);
  const seed = salienceSeedFor(deps, modelId);
  return async (system: string, user: string): Promise<string> => {
    const response = await model.call(
      {
        modelId,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        stream: false,
        ...(responseFormat !== undefined ? { responseFormat } : {}),
        ...(seed !== undefined ? { seed } : {}),
      },
      new AbortController().signal,
    );
    return response.content;
  };
}

function configuredSalienceModelId(deps: UiHandlerDeps, chatModelId: string): string {
  const configured = deps.env[SALIENCE_MODEL_ENV]?.trim();
  return configured === undefined || configured.length === 0 ? chatModelId : configured;
}

function salienceResponseFormatFor(
  deps: UiHandlerDeps,
  modelId: string,
): ResponseFormat | undefined {
  const config = currentGatewayConfig(deps);
  if (config === undefined) return undefined;
  const capability = findConfiguredCapability(config, modelId);
  return capability?.supportsResponseFormat === true ? SALIENCE_RESPONSE_FORMAT : undefined;
}

function salienceSeedFor(deps: UiHandlerDeps, modelId: string): number | undefined {
  const config = currentGatewayConfig(deps);
  if (config === undefined) return undefined;
  const capability = findConfiguredCapability(config, modelId);
  return capability?.supportsSeeding === true ? SALIENCE_DEFAULT_SEED : undefined;
}

function logSalienceDiagnostic(
  diagnostic: SalienceDiagnostic,
  deps: UiHandlerDeps,
  modelId: string,
): void {
  const responseFormatEnabled = salienceResponseFormatFor(deps, modelId) !== undefined;
  const diagnosticDetails =
    diagnostic.kind === "dropped-model-items"
      ? { reason: diagnostic.reason, count: diagnostic.count }
      : { rawItemCount: diagnostic.rawItemCount };
  // Safe diagnostic: model id, response-format bit, and counts only; never user text or model text.
  // eslint-disable-next-line no-console
  console.warn("salience capture diagnostic", {
    modelId,
    responseFormat: responseFormatEnabled,
    kind: diagnostic.kind,
    ...diagnosticDetails,
  });
}

function redactedErrorMessage(error: unknown, deps: UiHandlerDeps): string {
  const message = error instanceof Error ? error.message : String(error);
  return redact(message, currentRedactionSecrets(deps));
}

// Persists one salience candidate and returns its wire action, or null when the outcome is not a
// candidate, no record could be built, or the candidate was merged into an existing semantic
// near-duplicate (#204, O-F1) instead of stored. Embed-on-capture happens INSIDE the novelty gate:
// the body is embedded once, used to detect a near-duplicate, and stored only when the record is
// actually inserted. Graceful when no embedding model is configured (plain insert, no dedup).
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
  if (isSuppressedByForgetTombstone(vault, record)) {
    return { kind: "rejected", reason: FORGOTTEN_MEMORY_SUPPRESSION_REASON };
  }
  const { inserted } = await insertSalienceMemoryWithNoveltyGate(deps, vault, record);
  if (inserted === null) {
    // Near-duplicate of an existing in-scope memory: the canonical was reinforced, nothing new to
    // surface. Over-capture is bounded at the encode boundary rather than deferred to a decay pass.
    return null;
  }
  return {
    kind: "candidate",
    proposalId: String(inserted.id),
    body:
      outcome.requiresApproval || inserted.provenance.sensitivity !== "public"
        ? SENSITIVE_MEMORY_ACTION_BODY
        : inserted.body,
    scopeLabel: scopeLabel(inserted.scope),
    requiresApproval: outcome.requiresApproval,
  };
}

interface SalienceTurnRequest {
  readonly content: string;
  readonly memory: { readonly enabled: boolean } | undefined;
}

async function extractTurnSalienceOutcomes(
  deps: UiHandlerDeps,
  vault: MemoryVaultStore,
  request: SalienceTurnRequest,
  context: ConversationMemoryRuntimeContext,
  modelId: string,
  assistantText: string,
): Promise<readonly CaptureOutcome[] | null> {
  const salienceModelId = configuredSalienceModelId(deps, modelId);
  const callModel = buildCallModel(deps, salienceModelId);
  if (callModel === null) return null;
  const policy = memoryCapturePolicyForDeps(deps);
  if (memoryTextSecretEgressRejectionReason(request.content, policy) !== null) return null;
  return extractSalientMemories(
    {
      userText: request.content,
      assistantText,
      existingBodies: gatherExistingBodies(vault, context),
      context: buildSalienceContext(context),
      policy,
    },
    {
      callModel,
      now: () => Date.now(),
      newMemoryId: () => randomUUID() as MemoryId,
      newProposalId: () => randomUUID() as MemoryProposalId,
      onDiagnostic: (diagnostic) => {
        logSalienceDiagnostic(diagnostic, deps, salienceModelId);
      },
    },
  );
}

async function persistSalienceActions(
  deps: UiHandlerDeps,
  vault: MemoryVaultStore,
  outcomes: readonly CaptureOutcome[],
): Promise<readonly ConversationMemoryActionWire[]> {
  const actions: ConversationMemoryActionWire[] = [];
  for (const outcome of outcomes) {
    const action = await persistCandidate(deps, outcome, vault);
    if (action !== null) actions.push(action);
  }
  return actions;
}

// Captures salient memories from a completed chat turn. Never throws — any failure (model error,
// vault error, malformed output) yields [] so the chat response is unaffected.
export async function captureSalientFromTurn(
  deps: UiHandlerDeps,
  request: SalienceTurnRequest,
  context: ConversationMemoryRuntimeContext,
  modelId: string,
  assistantText: string,
): Promise<readonly ConversationMemoryActionWire[]> {
  const vault = deps.memoryVault;
  if (request.memory === undefined || !request.memory.enabled || vault === undefined) {
    return [];
  }
  try {
    const outcomes = await extractTurnSalienceOutcomes(
      deps,
      vault,
      request,
      context,
      modelId,
      assistantText,
    );
    return outcomes === null ? [] : await persistSalienceActions(deps, vault, outcomes);
  } catch (error) {
    // Boundary: salience must never break the chat path. Log and continue.
    // eslint-disable-next-line no-console
    console.error("salience capture failed", redactedErrorMessage(error, deps));
    return [];
  }
}
