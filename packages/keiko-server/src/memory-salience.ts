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
import type { CodingWorkbenchMode } from "@oscharko-dev/keiko-contracts";
import type { ConversationMemoryActionWire } from "@oscharko-dev/keiko-contracts/bff-wire";
import type {
  MemoryId,
  MemoryProposalId,
  MemoryRecord,
  MemoryScope,
  MemorySourceKind,
} from "@oscharko-dev/keiko-contracts/memory";
import { redact } from "@oscharko-dev/keiko-security";
import {
  type MemoryAccessStatLike,
  planMemoryMaintenance,
} from "@oscharko-dev/keiko-memory-governance";
import { findConfiguredCapability, type ResponseFormat } from "@oscharko-dev/keiko-model-gateway";
import {
  extractSalientMemories,
  memoryTextSecretEgressRejectionReason,
  type CaptureContext,
  type CaptureOutcome,
  type RejectionReason,
  type SalienceDiagnostic,
  type SalienceDeps,
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
import { recordMemoryAudit } from "./memory-audit-handler.js";
import {
  buildMemoryCaptureDecisionAuditEvent,
  type MemoryCaptureDecisionOutcome,
  type MemoryCaptureDecisionReason,
} from "./memory-capture-projection.js";
import {
  FORGOTTEN_MEMORY_SUPPRESSION_REASON,
  isPersistableMemoryCandidate,
  memoryCaptureAutoAcceptEligible,
  memoryCapturePolicyForDeps,
  resolveMemoryCaptureAutonomyMode,
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
const MAX_PENDING_SALIENCE_CAPTURES = 32;
const SALIENCE_MODEL_ENV = "KEIKO_MEMORY_SALIENCE_MODEL_ID";
const SALIENCE_DEFAULT_SEED = 204;
let pendingSalienceCaptures = 0;

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
): NonNullable<SalienceDeps["callModelMessages"]> | null {
  const model = deps.modelPortFactory(modelId);
  if (model === undefined) {
    return null;
  }
  const responseFormat = salienceResponseFormatFor(deps, modelId);
  const seed = salienceSeedFor(deps, modelId);
  return async (messages): Promise<string> => {
    const response = await model.call(
      {
        modelId,
        messages,
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

// Salience capture never tracks per-record access stats at capture time, so the governance planner
// sees a fresh record with no recall/utility history: its strength collapses to provenance
// confidence, exactly what shouldPromote's confidence >= promoteStrength gate expects.
const EMPTY_SALIENCE_ACCESS_STATS: ReadonlyMap<MemoryId, MemoryAccessStatLike> = new Map();

// How a candidate settled, for the content-free capture summary. "none" outcomes (non-candidate or
// unbuildable records) are not tallied.
type CaptureDisposition = "accepted" | "proposed" | "rejected" | "merged" | "none";

interface PersistedCandidate {
  readonly action: ConversationMemoryActionWire | null;
  readonly disposition: CaptureDisposition;
}

interface CaptureDecisionEvidence {
  readonly outcome: MemoryCaptureDecisionOutcome;
  readonly scope: MemoryScope;
  readonly sourceKind: MemorySourceKind;
  readonly reason: MemoryCaptureDecisionReason;
  readonly occurredAt: number;
  readonly memoryId?: MemoryId;
}

function recordCaptureDecision(
  deps: UiHandlerDeps,
  mode: CodingWorkbenchMode,
  decision: CaptureDecisionEvidence,
): void {
  const event = buildMemoryCaptureDecisionAuditEvent({
    eventId: randomUUID(),
    mode,
    ...decision,
  });
  recordMemoryAudit(
    {
      evidenceStore: deps.evidenceStore,
      redactString: (input) => redact(input, currentRedactionSecrets(deps)),
    },
    event,
  );
}

function proposedDecisionReason(
  mode: CodingWorkbenchMode,
  outcome: Extract<CaptureOutcome, { readonly kind: "candidate" }>,
): MemoryCaptureDecisionReason {
  if (outcome.requiresApproval) return "sensitivity-requires-approval";
  return mode === "governed-assist" ? "mode-requires-approval" : "governance-promotion-deferred";
}

function recordPersistedCandidateDecision(
  deps: UiHandlerDeps,
  mode: CodingWorkbenchMode,
  outcome: Extract<CaptureOutcome, { readonly kind: "candidate" }>,
  inserted: MemoryRecord,
): void {
  const accepted = inserted.status === "accepted";
  recordCaptureDecision(deps, mode, {
    outcome: accepted ? "auto-accepted" : "proposed",
    scope: inserted.scope,
    sourceKind: inserted.provenance.sourceKind,
    reason: accepted ? "governance-auto-accepted" : proposedDecisionReason(mode, outcome),
    occurredAt: inserted.createdAt,
    memoryId: inserted.id,
  });
}

function recordRejectedCandidateDecision(
  deps: UiHandlerDeps,
  mode: CodingWorkbenchMode,
  outcome: Extract<CaptureOutcome, { readonly kind: "candidate" }>,
  reason: RejectionReason,
): void {
  recordCaptureDecision(deps, mode, {
    outcome: "rejected",
    scope: outcome.proposal.scope,
    sourceKind: outcome.proposal.provenance.sourceKind,
    reason,
    occurredAt: outcome.proposal.provenance.capturedAt,
  });
}

// Auto-accept a freshly captured public record by routing it THROUGH the existing governance
// promotion lever — no second promotion path. planMemoryMaintenance/shouldPromote keeps its own
// gates (status proposed + sensitivity public + strength >= promoteStrength). The record's own
// createdAt is the clock so a just-captured record decays by zero and its strength equals its
// provenance confidence deterministically. Promoted -> insert as "accepted" (one atomic insert, no
// proposed->accepted window); otherwise the record is inserted unchanged.
function promoteEligibleRecord(record: MemoryRecord): MemoryRecord {
  const plan = planMemoryMaintenance([record], EMPTY_SALIENCE_ACCESS_STATS, {
    nowMs: record.createdAt,
  });
  return plan.promote.includes(record.id) ? { ...record, status: "accepted" } : record;
}

function candidateWireAction(
  outcome: Extract<CaptureOutcome, { readonly kind: "candidate" }>,
  inserted: MemoryRecord,
): ConversationMemoryActionWire {
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

// Persists one salience candidate and returns its wire action plus how it settled. Returns a null
// action when the outcome is not a candidate, no record could be built, or the candidate was merged
// into an existing semantic near-duplicate (#204, O-F1) instead of stored. Embed-on-capture happens
// INSIDE the novelty gate: the body is embedded once, used to detect a near-duplicate, and stored
// only when the record is actually inserted. Graceful when no embedding model is configured (plain
// insert, no dedup). When the resolved mode makes the candidate auto-accept-eligible the record is
// routed through governance promotion before insert; every existing gate stays untouched.
async function persistCandidate(
  deps: UiHandlerDeps,
  outcome: CaptureOutcome,
  vault: MemoryVaultStore,
  mode: CodingWorkbenchMode,
): Promise<PersistedCandidate> {
  if (outcome.kind !== "candidate") {
    return { action: null, disposition: "none" };
  }
  if (!isPersistableMemoryCandidate(outcome)) {
    recordRejectedCandidateDecision(deps, mode, outcome, SENSITIVE_MEMORY_REJECTION_REASON);
    return {
      action: { kind: "rejected", reason: SENSITIVE_MEMORY_REJECTION_REASON },
      disposition: "rejected",
    };
  }
  const proposalId = outcome.proposal.proposalId as unknown as MemoryId;
  const record = buildMemoryRecordFromProposal(proposalId, outcome);
  if (record === null) {
    return { action: null, disposition: "none" };
  }
  if (isSuppressedByForgetTombstone(vault, record)) {
    recordRejectedCandidateDecision(deps, mode, outcome, FORGOTTEN_MEMORY_SUPPRESSION_REASON);
    return {
      action: { kind: "rejected", reason: FORGOTTEN_MEMORY_SUPPRESSION_REASON },
      disposition: "rejected",
    };
  }
  const candidate = memoryCaptureAutoAcceptEligible(mode, outcome)
    ? promoteEligibleRecord(record)
    : record;
  const { inserted } = await insertSalienceMemoryWithNoveltyGate(deps, vault, candidate);
  if (inserted === null) {
    // Near-duplicate of an existing in-scope memory: the canonical was reinforced, nothing new to
    // surface. Over-capture is bounded at the encode boundary rather than deferred to a decay pass.
    return { action: null, disposition: "merged" };
  }
  recordPersistedCandidateDecision(deps, mode, outcome, inserted);
  return {
    action: candidateWireAction(outcome, inserted),
    disposition: inserted.status === "accepted" ? "accepted" : "proposed",
  };
}

interface SalienceTurnRequest {
  readonly content: string;
  readonly memory:
    { readonly enabled: boolean; readonly mode?: CodingWorkbenchMode | undefined } | undefined;
}

type SalienceCaptureSurface = "desktop" | "voice";

function logSalienceCaptureFailure(
  surface: SalienceCaptureSurface,
  error: unknown,
  deps: UiHandlerDeps,
): void {
  // eslint-disable-next-line no-console
  console.error(`${surface} salience capture failed`, redactedErrorMessage(error, deps));
}

function logSalienceCaptureDropped(surface: SalienceCaptureSurface): void {
  // eslint-disable-next-line no-console
  console.error(
    `${surface} salience capture skipped: background queue full (${String(
      pendingSalienceCaptures,
    )}/${String(MAX_PENDING_SALIENCE_CAPTURES)})`,
  );
}

export function scheduleMemorySalienceCapture(
  deps: UiHandlerDeps,
  request: SalienceTurnRequest,
  context: ConversationMemoryRuntimeContext | undefined,
  modelId: string,
  assistantText: string,
  surface: SalienceCaptureSurface,
): void {
  if (context === undefined || request.memory?.enabled !== true || deps.memoryVault === undefined) {
    return;
  }
  if (pendingSalienceCaptures >= MAX_PENDING_SALIENCE_CAPTURES) {
    logSalienceCaptureDropped(surface);
    return;
  }
  pendingSalienceCaptures += 1;
  setImmediate(() => {
    void captureSalientFromTurn(deps, request, context, modelId, assistantText)
      .catch((error: unknown) => {
        logSalienceCaptureFailure(surface, error, deps);
      })
      .finally(() => {
        pendingSalienceCaptures -= 1;
      });
  });
}

type TurnSalienceExtraction =
  | { readonly kind: "unavailable" }
  | { readonly kind: "refused"; readonly reason: RejectionReason }
  | { readonly kind: "outcomes"; readonly outcomes: readonly CaptureOutcome[] };

async function extractTurnSalienceOutcomes(
  deps: UiHandlerDeps,
  vault: MemoryVaultStore,
  request: SalienceTurnRequest,
  context: ConversationMemoryRuntimeContext,
  captureContext: CaptureContext,
  modelId: string,
  assistantText: string,
): Promise<TurnSalienceExtraction> {
  const salienceModelId = configuredSalienceModelId(deps, modelId);
  const callModelMessages = buildCallModel(deps, salienceModelId);
  if (callModelMessages === null) return { kind: "unavailable" };
  const policy = memoryCapturePolicyForDeps(deps);
  const refusalReason = memoryTextSecretEgressRejectionReason(request.content, policy);
  if (refusalReason !== null) return { kind: "refused", reason: refusalReason };
  const outcomes = await extractSalientMemories(
    {
      userText: request.content,
      assistantText,
      existingBodies: gatherExistingBodies(vault, context),
      context: captureContext,
      policy,
    },
    {
      callModel: (system, user) =>
        callModelMessages([
          { role: "system", content: system },
          { role: "user", content: user },
        ]),
      callModelMessages,
      now: () => captureContext.nowMs,
      newMemoryId: captureContext.newMemoryId,
      newProposalId: captureContext.newProposalId,
      onDiagnostic: (diagnostic) => {
        logSalienceDiagnostic(diagnostic, deps, salienceModelId);
      },
    },
  );
  return { kind: "outcomes", outcomes };
}

interface SalienceCaptureSummary {
  proposed: number;
  accepted: number;
  rejected: number;
  merged: number;
}

function emptySalienceCaptureSummary(): SalienceCaptureSummary {
  return { proposed: 0, accepted: 0, rejected: 0, merged: 0 };
}

function tallyDisposition(summary: SalienceCaptureSummary, disposition: CaptureDisposition): void {
  switch (disposition) {
    case "accepted":
      summary.accepted += 1;
      return;
    case "proposed":
      summary.proposed += 1;
      return;
    case "rejected":
      summary.rejected += 1;
      return;
    case "merged":
      summary.merged += 1;
      return;
    case "none":
      return;
  }
}

// Content-free capture summary: the effective mode and per-disposition counts only, never bodies or
// user text. Mirrors the logSalienceDiagnostic console.warn convention.
function logSalienceCaptureSummary(
  mode: CodingWorkbenchMode,
  summary: SalienceCaptureSummary,
): void {
  // eslint-disable-next-line no-console
  console.warn("salience capture summary", {
    mode,
    proposed: summary.proposed,
    accepted: summary.accepted,
    rejected: summary.rejected,
    merged: summary.merged,
  });
}

interface SalienceCaptureResult {
  readonly actions: readonly ConversationMemoryActionWire[];
  readonly summary: SalienceCaptureSummary;
}

async function persistSalienceActions(
  deps: UiHandlerDeps,
  vault: MemoryVaultStore,
  outcomes: readonly CaptureOutcome[],
  mode: CodingWorkbenchMode,
): Promise<SalienceCaptureResult> {
  const actions: ConversationMemoryActionWire[] = [];
  const summary = emptySalienceCaptureSummary();
  for (const outcome of outcomes) {
    const { action, disposition } = await persistCandidate(deps, outcome, vault, mode);
    if (action !== null) actions.push(action);
    tallyDisposition(summary, disposition);
  }
  return { actions, summary };
}

function recordTurnCaptureRefusal(
  deps: UiHandlerDeps,
  mode: CodingWorkbenchMode,
  context: ConversationMemoryRuntimeContext,
  occurredAt: number,
  reason: RejectionReason,
): void {
  recordCaptureDecision(deps, mode, {
    outcome: "rejected",
    scope: { kind: "project", projectId: context.projectId },
    sourceKind: "system-default",
    reason,
    occurredAt,
  });
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
    const mode = resolveMemoryCaptureAutonomyMode(deps, request.memory.mode);
    const captureContext = buildSalienceContext(context);
    const extraction = await extractTurnSalienceOutcomes(
      deps,
      vault,
      request,
      context,
      captureContext,
      modelId,
      assistantText,
    );
    if (extraction.kind === "unavailable") return [];
    if (extraction.kind === "refused") {
      recordTurnCaptureRefusal(deps, mode, context, captureContext.nowMs, extraction.reason);
      return [];
    }
    const { outcomes } = extraction;
    const { actions, summary } = await persistSalienceActions(deps, vault, outcomes, mode);
    if (outcomes.length > 0) logSalienceCaptureSummary(mode, summary);
    return actions;
  } catch (error) {
    // Boundary: salience must never break the chat path. Log and continue.
    // eslint-disable-next-line no-console
    console.error("salience capture failed", redactedErrorMessage(error, deps));
    return [];
  }
}
