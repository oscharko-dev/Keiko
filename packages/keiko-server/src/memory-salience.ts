// Server-side orchestration for model-assisted salience capture (Keiko "learns from experience").
//
// After a chat turn, this module asks the model to extract the durable facts the person stated
// about themselves in natural conversation — IN ADDITION to the regex intent path in
// chat-handlers.ts. The checks in keiko-memory-capture decide what is admitted; here the outcome
// reaches the vault: a new fact, a confirmation of a known one, or the replacement of an older one.
//
// This is the model/IO boundary: the WHOLE body runs inside one try/catch so a model error, a
// vault hiccup, or any other failure can NEVER throw into the chat path — it logs and returns [].

import { randomUUID } from "node:crypto";
import type { CodingWorkbenchMode } from "@oscharko-dev/keiko-contracts";
import type {
  ConversationMemoryActionWire,
  ConversationMemoryCaptureSurfaceWire,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import type {
  MemoryId,
  MemoryProposalId,
  MemoryRecord,
  MemoryScope,
} from "@oscharko-dev/keiko-contracts/memory";
import { findConfiguredCapability, type ResponseFormat } from "@oscharko-dev/keiko-model-gateway";
import {
  extractSalientMemories,
  isExplicitMemoryStatement,
  memoryTextSecretEgressRejectionReason,
  type CaptureContext,
  type KnownFact,
  type LearnedFactRelation,
  type RejectionReason,
  type SalienceDiagnostic,
  type SalienceDeps,
  type SalienceOutcome,
} from "@oscharko-dev/keiko-memory-capture";
import {
  MemoryStoragePreconditionError,
  type MemoryVaultStore,
} from "@oscharko-dev/keiko-memory-vault";
import type { UiHandlerDeps } from "./deps.js";
import { currentGatewayConfig } from "./deps.js";
import { deploymentContentPolicy, strictRedactor } from "./content-redactor.js";
import {
  conversationMemoryScopes,
  type ConversationMemoryRuntimeContext,
} from "./memory-conversation-context.js";
import { buildMemoryRecordFromProposal } from "./memory-record-builders.js";
import {
  insertSalienceMemoryWithNoveltyGate,
  type NoveltyInsertOptions,
} from "./memory-embedding.js";
import {
  recordMemoryCaptureDecision,
  type MemoryCaptureDecisionInput,
} from "./memory-capture-audit.js";
import {
  emitServerDiagnostic,
  serverDiagnosticFromError,
  type ServerDiagnosticSummary,
} from "./diagnostics-log.js";
import { LEARNED_REFUSAL_REASONS, type LearnedRefusalReason } from "./memory-capture-projection.js";
import {
  isPersistableMemoryCandidate,
  memoryCaptureAutoAcceptEligible,
  memoryCapturePolicyForDeps,
  memoryOperatorRestrictsAcceptance,
  memoryUnattendedAcceptanceAllowed,
  promoteEligibleMemoryRecord,
  resolveMemoryCaptureAutonomyMode,
  SENSITIVE_MEMORY_ACTION_BODY,
  SENSITIVE_MEMORY_REJECTION_REASON,
  type MemoryCaptureSuppressionReason,
} from "./memory-capture-policy.js";
import { applyLearnedSupersession, isReplaceable, type SeenFact } from "./memory-learned-facts.js";
import {
  logLearnedDrop,
  logLearnedExtraction,
  logLearnedRelation,
  type LearnedRelationDecision,
} from "./memory-learned-facts-log.js";
import { exactCaptureSuppressionReason } from "./memory-suppression.js";

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

// Bounds the comparison so it stays cheap even for a large vault.
const MAX_KNOWN_FACTS = 200;
const SALIENCE_MODEL_ENV = "KEIKO_MEMORY_SALIENCE_MODEL_ID";
const SALIENCE_DEFAULT_SEED = 204;

// Azure OpenAI structured outputs reject a request whose json_schema carries no `name` or whose
// schema root is an array (both 400) — with a bare root-array schema every salience call on a
// supportsResponseFormat model failed GATEWAY_PROVIDER_ERROR (F-11). The item array is therefore
// wrapped in a named root OBJECT under "items"; parseSalienceItems in keiko-memory-capture unwraps
// that shape and still accepts the bare array the prompt-only fallback path produces.
const SALIENCE_RESPONSE_FORMAT: ResponseFormat = {
  type: "json_schema",
  name: "salient_memories",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["items"],
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["body", "evidence", "about", "type", "relation", "related"],
          properties: {
            body: { type: "string", minLength: 1 },
            evidence: { type: "string", minLength: 1 },
            about: { type: "string", enum: ["self", "team", "other", "unclear"] },
            type: { type: "string", enum: ["preference", "fact", "decision", "procedural"] },
            relation: { type: "string", enum: ["new", "same", "update", "contradiction"] },
            related: { type: ["integer", "null"] },
          },
        },
      },
    },
  },
};

// What the learner compares a new fact with: every LIVE record — accepted AND proposed — because a
// proposal is a real record already occupying the review queue, so re-deriving the same fact next
// turn must not queue a second copy. A sensitive body is not shown to the model again. Refused bodies
// (forgotten / rejected) are deliberately NOT here: they stay with the suppression gate in
// persistCandidate, which records the refusal as a capture-decision audit event.
// What it reads is also how each fact stood then, which a later replacement is checked against.
interface KnownFactSnapshot {
  readonly facts: readonly KnownFact[];
  readonly seen: ReadonlyMap<MemoryId, SeenFact>;
}

function gatherKnownFacts(
  vault: MemoryVaultStore,
  context: ConversationMemoryRuntimeContext,
): KnownFactSnapshot {
  const known: KnownFact[] = [];
  const seen = new Map<MemoryId, SeenFact>();
  for (const scope of conversationMemoryScopes(context)) {
    for (const record of vault.listMemoriesByScope(scope, { status: ["accepted", "proposed"] })) {
      if (record.provenance.sensitivity !== "public") continue;
      seen.set(record.id, { status: record.status, updatedAt: record.updatedAt });
      known.push({
        id: record.id,
        body: record.body,
        // Only what Keiko learned, in the person's own scope, gives way to what it learns next.
        fixed: record.provenance.evidenceSpan === undefined || record.scope.kind !== "user",
        scopeKind: record.scope.kind,
        ...(record.validity.validUntil === undefined
          ? {}
          : { validUntil: record.validity.validUntil }),
      });
      if (known.length >= MAX_KNOWN_FACTS) return { facts: known, seen };
    }
  }
  return { facts: known, seen };
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

// The learning pass owns the signal: a new message aborts it, and the gateway carries the abort to
// the provider. The call is joined to the pass that made it (#4213).
interface SalienceCallScope {
  readonly correlationId: string;
  readonly parentCorrelationId?: string | undefined;
  readonly signal: AbortSignal;
}

function buildCallModel(
  deps: UiHandlerDeps,
  modelId: string,
  scope: SalienceCallScope,
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
        logContext: {
          correlationId: scope.correlationId,
          ...(scope.parentCorrelationId === undefined
            ? {}
            : { parentCorrelationId: scope.parentCorrelationId }),
        },
      },
      scope.signal,
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

// Content-free operator diagnostic for the salience pipeline: routes through the single
// redaction-safe server diagnostic sink (diagnostics-log.ts) instead of console.* directly, mirroring
// the emitAdvisoryPhaseSummary pattern in memory-conflict-advisory.ts. errorClass doubles as a
// machine-readable event-kind tag; expected records explicitly select the routine observation channel.
// `correlationId` is always the turn-scoped id `captureSalientFromTurn` already resolved (or its
// own fallback default) — never minted fresh here — so an informational salience diagnostic joins
// the SAME trail as that turn's eventual failure diagnostic (`emitSalienceFailureDiagnostic`)
// instead of reporting under a disconnected, unrelated id.
// Issue #3245: `message` is now the fixed closed-vocabulary condition label. Every call site
// below used to compose a per-invocation detail string (model id, mode, surface, bounded counts —
// never user/model text, per each site's own "safe diagnostic" comment) directly into `message`;
// that detail moves to the optional `code` param as a compact machine-readable string instead, so
// none of it is lost — only relocated to the field this record already has for exactly this shape.
function emitSalienceDiagnostic(
  deps: UiHandlerDeps,
  correlationId: string,
  source: string,
  errorClass: string,
  message: ServerDiagnosticSummary,
  code?: string,
): void {
  emitServerDiagnostic(deps.diagnostics, {
    correlationId,
    timestamp: new Date().toISOString(),
    operation: "memory.salience",
    source,
    errorClass,
    diagnosticOutcome: errorClass === "SalienceCaptureDropped" ? "source-skipped" : "routine",
    message,
    ...(code === undefined ? {} : { code }),
  });
}

function logSalienceDiagnostic(
  diagnostic: SalienceDiagnostic,
  deps: UiHandlerDeps,
  modelId: string,
  correlationId: string,
  sourceMessageCount: number,
): void {
  if (diagnostic.kind === "extraction-summary") {
    logLearnedExtraction(
      {
        rawItemCount: diagnostic.rawItemCount,
        admittedCount: diagnostic.acceptedCount,
        knownFactCount: diagnostic.knownFactCount,
        sourceMessageCount,
        ...(diagnostic.statedPreferenceCount === undefined
          ? {}
          : { statedPreferenceCount: diagnostic.statedPreferenceCount }),
      },
      correlationId,
    );
    return;
  }
  if (diagnostic.kind === "dropped-model-items") {
    logLearnedDrop(diagnostic.reason, diagnostic.count, sourceMessageCount, correlationId);
  }
  const responseFormatEnabled = salienceResponseFormatFor(deps, modelId) !== undefined;
  const detail =
    diagnostic.kind === "dropped-model-items"
      ? `reason=${diagnostic.reason}:count=${String(diagnostic.count)}`
      : `rawItemCount=${String(diagnostic.rawItemCount)}`;
  // `code` is a colon-joined machine token (no spaces — the same closed shape
  // `memory-conflict-advisory.ts`'s `emitAdvisoryPhaseSummary` uses), bounded again by the writer
  // (`diagnostics-log.ts` drops a `code` outside DIAGNOSTIC_CODE_SHAPE). It carries the
  // response-format bit, the diagnostic kind and counts only — never the model id (this file's
  // convention: a model id is recorded once by `gateway.config.resolved`, and the correlation id
  // joins this record to it), never user text, never model text.
  emitSalienceDiagnostic(
    deps,
    correlationId,
    "memory-salience.logSalienceDiagnostic",
    "SalienceExtractionDiagnostic",
    "salience-extraction-diagnostic",
    `responseFormat=${String(responseFormatEnabled)}:kind=${diagnostic.kind}:${detail}`,
  );
}

function emitSalienceFailureDiagnostic(
  deps: UiHandlerDeps,
  correlationId: string,
  operation: string,
  source: string,
  error: unknown,
): void {
  emitServerDiagnostic(
    deps.diagnostics,
    serverDiagnosticFromError({
      correlationId,
      operation,
      source,
      error,
      redact: (summary): string => String(deps.redactor(summary)),
    }),
  );
}

// Salience capture never tracks per-record access stats at capture time, so the governance planner
// sees a fresh record with no recall/utility history: its strength collapses to provenance
// confidence, exactly what shouldPromote's confidence >= promoteStrength gate expects.

// How a candidate settled, for the content-free capture summary. "none" outcomes (non-candidate or
// unbuildable records) are not tallied.
type CaptureDisposition = "accepted" | "proposed" | "rejected" | "merged" | "none";

type LearnedCandidate = Extract<SalienceOutcome, { readonly kind: "candidate" }>;

interface PersistedCandidate {
  readonly action: ConversationMemoryActionWire | null;
  readonly disposition: CaptureDisposition;
}

// Who decided, in which mode, under which correlation: what every capture decision of one turn shares.
type DecisionTrace = Pick<LearningTrace, "mode" | "surface" | "correlationId">;

type CaptureDecisionEvidence = Omit<MemoryCaptureDecisionInput, "mode" | "surface">;

function recordCaptureDecision(
  deps: UiHandlerDeps,
  trace: DecisionTrace,
  decision: CaptureDecisionEvidence,
): void {
  recordMemoryCaptureDecision(
    deps,
    { mode: trace.mode, surface: trace.surface, ...decision },
    trace.correlationId,
  );
}

// Why a persisted fact waits. A sensitive body never reaches this point (it is refused), so the
// fact is held by an explicit operator restriction, by the mode for a team or project fact (project
// memory is step 3, not #4206), or by the governance promotion strength.
function proposedDecisionReason(
  deps: UiHandlerDeps,
  mode: CodingWorkbenchMode,
  inserted: MemoryRecord,
): CaptureDecisionEvidence["reason"] {
  if (memoryOperatorRestrictsAcceptance(deps)) return "operator-requires-approval";
  if (inserted.scope.kind !== "user" && !memoryUnattendedAcceptanceAllowed(mode)) {
    return "mode-requires-approval";
  }
  return "governance-promotion-deferred";
}

function recordPersistedCandidateDecision(
  deps: UiHandlerDeps,
  trace: DecisionTrace,
  inserted: MemoryRecord,
): void {
  const accepted = inserted.status === "accepted";
  recordCaptureDecision(deps, trace, {
    outcome: accepted ? "auto-accepted" : "proposed",
    scope: inserted.scope,
    sourceKind: inserted.provenance.sourceKind,
    reason: accepted
      ? "governance-auto-accepted"
      : proposedDecisionReason(deps, trace.mode, inserted),
    occurredAt: inserted.createdAt,
    memoryId: inserted.id,
  });
}

function recordRejectedCandidateDecision(
  deps: UiHandlerDeps,
  trace: DecisionTrace,
  outcome: LearnedCandidate,
  reason: RejectionReason,
): void {
  recordCaptureDecision(deps, trace, {
    outcome: "rejected",
    scope: outcome.proposal.scope,
    sourceKind: outcome.proposal.provenance.sourceKind,
    reason,
    occurredAt: outcome.proposal.provenance.capturedAt,
  });
}

function candidateWireAction(
  outcome: LearnedCandidate,
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
    status: inserted.status === "accepted" ? "accepted" : "proposed",
  };
}

// Records a candidate rejection and returns the standard rejected PersistedCandidate shape shared
// by both rejection branches of persistCandidate.
function rejectedCandidate(
  deps: UiHandlerDeps,
  trace: DecisionTrace,
  outcome: LearnedCandidate,
  reason: RejectionReason,
): PersistedCandidate {
  recordRejectedCandidateDecision(deps, trace, outcome, reason);
  return { action: { kind: "rejected", reason }, disposition: "rejected" };
}

// The person forgot or rejected the fact's words, or the statement it was learned from.
function personRefused(
  vault: MemoryVaultStore,
  record: MemoryRecord,
  statement: string,
): MemoryCaptureSuppressionReason | null {
  return (
    exactCaptureSuppressionReason(vault, record) ??
    exactCaptureSuppressionReason(vault, { ...record, body: statement })
  );
}

function noveltyOptions(
  vault: MemoryVaultStore,
  relation: LearnedFactRelation,
  trace: LearningTrace,
  onSuperseded: (decision: LearnedRelationDecision) => void,
): NoveltyInsertOptions {
  const { seen } = trace;
  // The person may forget the turn while its embedding is computed.
  const refusedSinceStart = (record: MemoryRecord): MemoryCaptureSuppressionReason | null =>
    personRefused(vault, record, trace.statement);
  // A paraphrased repeat with another end date replaces the fact it repeats, if the learner may.
  const replaceDuplicate = (
    record: MemoryRecord,
    duplicateOf: MemoryId,
  ): MemoryRecord | undefined => {
    const seenFact = seen.get(duplicateOf);
    if (seenFact === undefined || !isReplaceable(vault.getMemory(duplicateOf))) return undefined;
    const applied = applyLearnedSupersession(vault, record, duplicateOf, seenFact);
    if (applied.pendingApproval) onSuperseded("supersession-proposed");
    else if (applied.superseded !== undefined) onSuperseded("superseded");
    return applied.record;
  };
  if (relation.kind === "same-unconfirmed") {
    return { onlyConfirm: true, refusedSinceStart, replaceDuplicate };
  }
  if (relation.kind === "new") return { refusedSinceStart, replaceDuplicate };
  return {
    refusedSinceStart,
    replaces: relation.memoryId,
    insert: (record): MemoryRecord => {
      const applied = applyLearnedSupersession(
        vault,
        record,
        relation.memoryId,
        seen.get(relation.memoryId),
      );
      if (applied.pendingApproval) onSuperseded("supersession-proposed");
      else if (applied.superseded !== undefined) onSuperseded("superseded");
      return applied.record;
    },
  };
}

interface LearningTrace {
  readonly surface: SalienceCaptureSurface;
  readonly mode: CodingWorkbenchMode;
  readonly correlationId: string;
  readonly sourceMessageCount: number;
  // The person's message the turn rests on. A pass that learns it again, after a stop between the
  // vault write and the Chat's learned position, adds nothing it already learned from it (#4213).
  readonly sourceMessageId?: string | undefined;
  readonly conversationId: string;
  // What the person said in the turn, which they may have forgotten while this capture was running.
  readonly statement: string;
  // How the facts the learner compared with stood before the model call.
  readonly seen: ReadonlyMap<MemoryId, SeenFact>;
}

function recordRelation(
  outcome: SalienceOutcome,
  decision: LearnedRelationDecision,
  trace: LearningTrace,
): void {
  const basis =
    outcome.kind === "candidate" && outcome.relation.kind === "supersede"
      ? outcome.relation.basis
      : undefined;
  logLearnedRelation(
    {
      label: outcome.relationLabel,
      decision,
      ...(basis === undefined ? {} : { basis }),
      sourceMessageCount: trace.sourceMessageCount,
    },
    trace.correlationId,
  );
}

// The person said it again: the existing memory records the confirmation, and nothing else changes.
// Only a memory that still stands as the learner saw it is confirmed: one the person forgot, edited
// or replaced while the model call was running is left alone and the relation is recorded as
// refused. The check and the write run without yielding, and the vault's own write touches only a
// memory that still exists.
function confirmKnownFact(
  vault: MemoryVaultStore,
  outcome: Extract<SalienceOutcome, { readonly kind: "confirmation" }>,
  trace: LearningTrace,
): PersistedCandidate {
  // Learned from this very message before: saying it once is no confirmation.
  if (restsOn(vault.getMemory(outcome.memoryId), trace.sourceMessageId)) {
    recordRelation(outcome, "merged", trace);
    return { action: null, disposition: "merged" };
  }
  if (!standsAsSeen(vault, outcome.memoryId, trace.seen.get(outcome.memoryId))) {
    recordRelation(outcome, "refused", trace);
    return { action: null, disposition: "none" };
  }
  vault.recordAccess([outcome.memoryId], Date.now(), trace.conversationId);
  recordRelation(outcome, "confirmed", trace);
  return { action: null, disposition: "merged" };
}

function restsOn(record: MemoryRecord | undefined, sourceMessageId: string | undefined): boolean {
  if (record === undefined || sourceMessageId === undefined) return false;
  return (record.provenance.sourceMessageIds ?? []).includes(sourceMessageId);
}

// A fact the learner already knew, with the same words, learned from this very message.
function learnedFromThisMessage(
  vault: MemoryVaultStore,
  body: string,
  trace: LearningTrace,
): boolean {
  if (trace.sourceMessageId === undefined) return false;
  for (const id of trace.seen.keys()) {
    const record = vault.getMemory(id);
    if (record?.body === body && restsOn(record, trace.sourceMessageId)) return true;
  }
  return false;
}

function standsAsSeen(vault: MemoryVaultStore, id: MemoryId, seen: SeenFact | undefined): boolean {
  if (seen === undefined) return false;
  const current = vault.getMemory(id);
  return current?.status === seen.status && current.updatedAt === seen.updatedAt;
}

// What settles a candidate before it is stored: it was learned from this very message already, or the
// person forgot or rejected its words.
function settleBeforeInsert(
  vault: MemoryVaultStore,
  record: MemoryRecord,
  outcome: SalienceOutcome,
  trace: LearningTrace,
  refuse: (reason: RejectionReason) => PersistedCandidate,
): PersistedCandidate | null {
  if (learnedFromThisMessage(vault, record.body, trace)) {
    recordRelation(outcome, "merged", trace);
    return { action: null, disposition: "merged" };
  }
  const exactSuppression = personRefused(vault, record, trace.statement);
  return exactSuppression === null ? null : refuse(exactSuppression);
}

// Persists one learned candidate and returns its wire action plus how it settled. Returns a null
// action when it merely confirmed a known fact. Embed-on-capture happens INSIDE the novelty gate: the
// body is embedded once, used to detect a near-duplicate, and stored only when the record is actually
// inserted. Graceful when no embedding model is configured (plain insert, no dedup). When the resolved
// mode makes the candidate auto-accept-eligible the record is routed through governance promotion
// before insert; every existing gate stays untouched.
async function persistCandidate(
  deps: UiHandlerDeps,
  outcome: SalienceOutcome,
  vault: MemoryVaultStore,
  trace: LearningTrace,
): Promise<PersistedCandidate> {
  if (outcome.kind === "confirmation") return confirmKnownFact(vault, outcome, trace);
  const { mode } = trace;
  const refuse = (reason: RejectionReason): PersistedCandidate => {
    recordRelation(outcome, "refused", trace);
    return rejectedCandidate(deps, trace, outcome, reason);
  };
  if (!isPersistableMemoryCandidate(outcome)) return refuse(SENSITIVE_MEMORY_REJECTION_REASON);
  const proposalId = outcome.proposal.proposalId as unknown as MemoryId;
  const record = buildMemoryRecordFromProposal(proposalId, outcome);
  const settledBeforeInsert = settleBeforeInsert(vault, record, outcome, trace, refuse);
  if (settledBeforeInsert !== null) return settledBeforeInsert;
  const candidate = memoryCaptureAutoAcceptEligible(deps, mode, outcome)
    ? promoteEligibleMemoryRecord(record)
    : record;
  let decision: LearnedRelationDecision = "new";
  const outcomeOfInsert = await insertSalienceMemoryWithNoveltyGate(
    deps,
    vault,
    candidate,
    noveltyOptions(vault, outcome.relation, trace, (settled) => {
      decision = settled;
    }),
  );
  if (outcomeOfInsert.kind === "suppressed") {
    // A PARAPHRASE of a fact the human already forgot or rejected. Nothing was stored and nothing
    // was reinforced — this is a refusal, so it is audited and tallied as one, exactly like the
    // exact-body suppression above.
    return refuse(outcomeOfInsert.reason);
  }
  if (outcomeOfInsert.kind === "unconfirmed") {
    recordRelation(outcome, "unconfirmed-dropped", trace);
    return { action: null, disposition: "none" };
  }
  if (outcomeOfInsert.kind === "merged") {
    // Near-duplicate of an existing in-scope memory: the canonical was reinforced, nothing new to
    // surface. Over-capture is bounded at the encode boundary rather than deferred to a decay pass.
    recordRelation(outcome, "merged", trace);
    return { action: null, disposition: "merged" };
  }
  const inserted = outcomeOfInsert.record;
  recordRelation(outcome, decision, trace);
  recordPersistedCandidateDecision(deps, trace, inserted);
  return {
    action: candidateWireAction(outcome, inserted),
    disposition: inserted.status === "accepted" ? "accepted" : "proposed",
  };
}

// Another turn changed the memory this outcome would replace, so the vault refused the whole
// replacement. That outcome is reported, refused and audited; the turn's other outcomes still settle.
async function settleCandidate(
  deps: UiHandlerDeps,
  outcome: SalienceOutcome,
  vault: MemoryVaultStore,
  trace: LearningTrace,
): Promise<PersistedCandidate> {
  try {
    return await persistCandidate(deps, outcome, vault, trace);
  } catch (error: unknown) {
    if (!(error instanceof MemoryStoragePreconditionError) || outcome.kind !== "candidate") {
      throw error;
    }
    emitSalienceFailureDiagnostic(
      deps,
      trace.correlationId,
      "memory.salience.capture",
      "memory-salience.settleCandidate",
      error,
    );
    recordRelation(outcome, "refused", trace);
    return rejectedCandidate(deps, trace, outcome, "ambiguous-update");
  }
}

export interface SalienceTurnRequest {
  readonly content: string;
  // The person's message the turn came from, when the caller has one.
  readonly sourceMessageId?: string;
  readonly memory:
    { readonly enabled: boolean; readonly mode?: CodingWorkbenchMode | undefined } | undefined;
}

// The capture surface vocabulary is the wire contract's, not a server-local twin (ADR-0019): the UI
// declares the originating surface on the memory request and the shared capture-decision writer
// maps it to the audit envelope.
type SalienceCaptureSurface = ConversationMemoryCaptureSurfaceWire;

// #4098: the Chat content opt-out preserves an answer for the person reading it, not for memory.
// Memory proposals keep the default projection, so a preserved answer is projected again here.
function memoryAssistantText(deps: UiHandlerDeps, assistantText: string): string {
  return deploymentContentPolicy(deps) === "preserve"
    ? String(strictRedactor(deps)(assistantText))
    : assistantText;
}

type TurnSalienceExtraction =
  | { readonly kind: "unavailable" }
  | { readonly kind: "refused"; readonly reason: RejectionReason }
  | {
      readonly kind: "outcomes";
      readonly outcomes: readonly SalienceOutcome[];
      readonly seen: ReadonlyMap<MemoryId, SeenFact>;
      // Each content reason the learner refused an item for, once per turn (#4206).
      readonly refusals: ReadonlySet<LearnedRefusalReason>;
    };

// The per-turn scalars `extractTurnSalienceOutcomes` and `runSalienceCapture` both thread through
// unchanged, bundled into one parameter so neither function's positional-argument count crosses
// the repository's 7-argument ceiling (Sonar S107) now that g9's correlationId threading added an
// 8th to each. `SalienceCaptureInputs` extends this with the one field `runSalienceCapture` alone
// needs (`surface`), rather than widening this shape for a field `extractTurnSalienceOutcomes`
// never reads.
interface TurnSalienceInputs {
  readonly modelId: string;
  readonly assistantText: string;
  readonly correlationId: string;
  readonly parentCorrelationId?: string | undefined;
  readonly signal: AbortSignal;
}

// The person's message just before this one, so a pronoun can point back to it. A message the
// learner may not see stays out, like the current one would.
function previousUserText(
  deps: UiHandlerDeps,
  request: SalienceTurnRequest,
  context: ConversationMemoryRuntimeContext,
  policy: ReturnType<typeof memoryCapturePolicyForDeps>,
): string | undefined {
  if (request.sourceMessageId === undefined) return undefined;
  const messages = deps.store.listMessages(context.conversationId);
  const current = messages.findIndex((message) => message.id === request.sourceMessageId);
  for (let index = current - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    return memoryTextSecretEgressRejectionReason(message.content, policy) === null
      ? message.content
      : undefined;
  }
  return undefined;
}

async function extractTurnSalienceOutcomes(
  deps: UiHandlerDeps,
  vault: MemoryVaultStore,
  request: SalienceTurnRequest,
  context: ConversationMemoryRuntimeContext,
  captureContext: CaptureContext,
  inputs: TurnSalienceInputs,
): Promise<TurnSalienceExtraction> {
  const { modelId, assistantText, correlationId } = inputs;
  const salienceModelId = configuredSalienceModelId(deps, modelId);
  const callModelMessages = buildCallModel(deps, salienceModelId, inputs);
  if (callModelMessages === null) return { kind: "unavailable" };
  const policy = memoryCapturePolicyForDeps(deps);
  const refusalReason = memoryTextSecretEgressRejectionReason(request.content, policy);
  if (refusalReason !== null) return { kind: "refused", reason: refusalReason };
  const sourceMessageCount = request.sourceMessageId === undefined ? 0 : 1;
  const previous = previousUserText(deps, request, context, policy);
  const known = gatherKnownFacts(vault, context);
  const refusals = new Set<LearnedRefusalReason>();
  const outcomes = await extractSalientMemories(
    {
      userText: request.content,
      ...(previous === undefined ? {} : { previousUserText: previous }),
      assistantText,
      knownFacts: known.facts,
      ...(request.sourceMessageId === undefined
        ? {}
        : { sourceMessageIds: [request.sourceMessageId] }),
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
        logSalienceDiagnostic(diagnostic, deps, salienceModelId, correlationId, sourceMessageCount);
        noteLearnedRefusal(diagnostic, refusals);
      },
    },
  );
  return { kind: "outcomes", outcomes, seen: known.seen, refusals };
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
// user text. Mirrors the logSalienceDiagnostic diagnostic-sink convention.
function logSalienceCaptureSummary(
  mode: CodingWorkbenchMode,
  summary: SalienceCaptureSummary,
  deps: UiHandlerDeps,
  correlationId: string,
): void {
  emitSalienceDiagnostic(
    deps,
    correlationId,
    "memory-salience.captureSalientFromTurn",
    "SalienceCaptureSummary",
    "salience-capture-summary",
    `mode=${mode}:proposed=${String(summary.proposed)}:accepted=${String(summary.accepted)}:` +
      `rejected=${String(summary.rejected)}:merged=${String(summary.merged)}`,
  );
}

interface SalienceCaptureResult {
  readonly actions: readonly ConversationMemoryActionWire[];
  readonly summary: SalienceCaptureSummary;
}

async function persistSalienceActions(
  deps: UiHandlerDeps,
  vault: MemoryVaultStore,
  outcomes: readonly SalienceOutcome[],
  trace: LearningTrace,
): Promise<SalienceCaptureResult> {
  const actions: ConversationMemoryActionWire[] = [];
  const summary = emptySalienceCaptureSummary();
  // One outcome after the other: a supersession must see what the previous outcome stored.
  const persistFrom = async (index: number): Promise<void> => {
    const outcome = outcomes[index];
    if (outcome === undefined) return;
    const { action, disposition } = await settleCandidate(deps, outcome, vault, trace);
    if (action !== null) actions.push(action);
    tallyDisposition(summary, disposition);
    await persistFrom(index + 1);
  };
  await persistFrom(0);
  return { actions, summary };
}

// A refused message is the person's own words and names no team, so its decision belongs to their
// private scope, where what Keiko learns about them lands. A project scope holding none of their
// memories would hide the content-free refusal from the Journal.
function recordTurnCaptureRefusal(
  deps: UiHandlerDeps,
  trace: DecisionTrace,
  context: ConversationMemoryRuntimeContext,
  occurredAt: number,
  reason: RejectionReason | LearnedRefusalReason,
): void {
  recordCaptureDecision(deps, trace, {
    outcome: "rejected",
    scope: { kind: "user", userId: context.userId },
    sourceKind: "system-default",
    reason,
    occurredAt,
  });
}

const LEARNED_REFUSALS: ReadonlySet<string> = new Set(LEARNED_REFUSAL_REASONS);

function isLearnedRefusal(reason: string): reason is LearnedRefusalReason {
  return LEARNED_REFUSALS.has(reason);
}

function noteLearnedRefusal(
  diagnostic: SalienceDiagnostic,
  refusals: Set<LearnedRefusalReason>,
): void {
  if (diagnostic.kind === "dropped-model-items" && isLearnedRefusal(diagnostic.reason)) {
    refusals.add(diagnostic.reason);
  }
}

function activeSalienceVault(
  deps: UiHandlerDeps,
  request: SalienceTurnRequest,
): MemoryVaultStore | undefined {
  return request.memory?.enabled === true ? deps.memoryVault : undefined;
}

interface SalienceCaptureInputs extends TurnSalienceInputs {
  readonly surface: SalienceCaptureSurface;
}

// The turn-scoped work `captureSalientFromTurn` runs inside its own try/catch. Split out so that
// function's own body stays a thin boundary (resolve the vault, catch, report) — everything that
// can throw lives here instead.
type SalienceCaptureRun =
  | { readonly kind: "unavailable" }
  | { readonly kind: "captured"; readonly actions: readonly ConversationMemoryActionWire[] };

async function runSalienceCapture(
  deps: UiHandlerDeps,
  vault: MemoryVaultStore,
  request: SalienceTurnRequest,
  context: ConversationMemoryRuntimeContext,
  inputs: SalienceCaptureInputs,
): Promise<SalienceCaptureRun> {
  const { surface, correlationId } = inputs;
  const mode = resolveMemoryCaptureAutonomyMode(deps, request.memory?.mode);
  const decisionTrace: DecisionTrace = { mode, surface, correlationId };
  const captureContext = buildSalienceContext(context);
  const extraction = await extractTurnSalienceOutcomes(
    deps,
    vault,
    request,
    context,
    captureContext,
    inputs,
  );
  if (extraction.kind === "unavailable") return { kind: "unavailable" };
  if (extraction.kind === "refused") {
    recordTurnCaptureRefusal(deps, decisionTrace, context, captureContext.nowMs, extraction.reason);
    return { kind: "captured", actions: [] };
  }
  const { outcomes, seen, refusals } = extraction;
  for (const reason of refusals) {
    recordTurnCaptureRefusal(deps, decisionTrace, context, captureContext.nowMs, reason);
  }
  const { actions, summary } = await persistSalienceActions(deps, vault, outcomes, {
    surface,
    mode,
    correlationId,
    sourceMessageCount: request.sourceMessageId === undefined ? 0 : 1,
    sourceMessageId: request.sourceMessageId,
    conversationId: context.conversationId,
    statement: request.content,
    seen,
  });
  if (outcomes.length > 0) logSalienceCaptureSummary(mode, summary, deps, correlationId);
  return { kind: "captured", actions };
}

// Captures salient memories from a completed chat turn. Never throws — any failure (model error,
// vault error, malformed output) yields [] so the chat response is unaffected. Direct callers that
// do not own a committed message id receive one capture-scoped fallback correlation id; post-commit
// schedulers pass the assistant message id so every diagnostic for that turn stays correlated.
export async function captureSalientFromTurn(
  deps: UiHandlerDeps,
  request: SalienceTurnRequest,
  context: ConversationMemoryRuntimeContext,
  modelId: string,
  assistantText: string,
  surface: SalienceCaptureSurface = "desktop",
  correlationId: string = randomUUID(),
): Promise<readonly ConversationMemoryActionWire[]> {
  const vault = activeSalienceVault(deps, request);
  if (vault === undefined || isExplicitMemoryStatement(request.content)) return [];
  try {
    const run = await runSalienceCapture(deps, vault, request, context, {
      modelId,
      assistantText,
      surface,
      correlationId,
      signal: new AbortController().signal,
    });
    return run.kind === "captured" ? run.actions : [];
  } catch (error) {
    // Boundary: salience must never break the chat path. Log and continue.
    emitSalienceFailureDiagnostic(
      deps,
      correlationId,
      "memory.salience.capture",
      "memory-salience.captureSalientFromTurn",
      error,
    );
    return [];
  }
}

/** One stored turn a learning pass hands to the learner (#4213). */
export interface StoredLearningTurn {
  readonly request: SalienceTurnRequest;
  readonly context: ConversationMemoryRuntimeContext;
  readonly modelId: string;
  readonly assistantText: string;
  readonly surface: SalienceCaptureSurface;
  /** The turn's own correlation, the assistant message id, which its audit events carry. */
  readonly correlationId: string;
  /** The pass that learns the turn. */
  readonly parentCorrelationId: string;
}

/**
 * How a stored turn ended. Only `learned` and `skipped` move a Chat's learned position: an
 * unavailable model, a failure or a cancellation leaves the turn for a later pass.
 */
export type StoredTurnLearningOutcome =
  "learned" | "skipped" | "unavailable" | "failed" | "cancelled";

export interface StoredTurnLearning {
  readonly outcome: StoredTurnLearningOutcome;
  readonly actionCount: number;
}

function isGatewayFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" && code.startsWith("GATEWAY_");
}

function failedTurnLearning(error: unknown, signal: AbortSignal): StoredTurnLearning {
  if (signal.aborted) return { outcome: "cancelled", actionCount: 0 };
  return { outcome: isGatewayFailure(error) ? "unavailable" : "failed", actionCount: 0 };
}

// A turn that failed for a reason other than the model is reported where it failed, under the turn's
// own correlation and the pass as its parent. An unavailable model and a cancellation are no failure.
function reportTurnLearningFailure(
  deps: UiHandlerDeps,
  turn: StoredLearningTurn,
  error: unknown,
): void {
  emitServerDiagnostic(
    deps.diagnostics,
    serverDiagnosticFromError({
      correlationId: turn.correlationId,
      parentCorrelationId: turn.parentCorrelationId,
      operation: "memory.learn.pass",
      source: "memory-salience.learnStoredTurn",
      error,
      redact: (summary): string => String(deps.redactor(summary)),
    }),
  );
}

/** Learns one stored turn under the pass's signal. Never throws: the outcome says what happened. */
export async function learnStoredTurn(
  deps: UiHandlerDeps,
  turn: StoredLearningTurn,
  signal: AbortSignal,
): Promise<StoredTurnLearning> {
  const vault = activeSalienceVault(deps, turn.request);
  if (vault === undefined || isExplicitMemoryStatement(turn.request.content)) {
    return { outcome: "skipped", actionCount: 0 };
  }
  try {
    const run = await runSalienceCapture(deps, vault, turn.request, turn.context, {
      modelId: turn.modelId,
      assistantText: memoryAssistantText(deps, turn.assistantText),
      surface: turn.surface,
      correlationId: turn.correlationId,
      parentCorrelationId: turn.parentCorrelationId,
      signal,
    });
    // A turn whose facts are stored is learned, even when the pass was cancelled meanwhile.
    return run.kind === "unavailable"
      ? { outcome: "unavailable", actionCount: 0 }
      : { outcome: "learned", actionCount: run.actions.length };
  } catch (error) {
    const learning = failedTurnLearning(error, signal);
    if (learning.outcome === "failed") reportTurnLearningFailure(deps, turn, error);
    return learning;
  }
}
