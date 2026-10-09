import { mapWithConcurrency } from "./bounded-concurrency.js";
import {
  caughtGroundedPackValidation,
  inspectGroundedPack,
  recordGroundedPackValidation,
} from "./grounded-pack-validation.js";
// Epic #189 Slice 2 — heterogeneous grounded merge. A chat may carry BOTH connected folders
// (#532, lexical) AND Local Knowledge connectors (#189, vector), or two or more connectors. Asking
// one question must retrieve from EVERY source and return ONE merged grounded answer with
// source-tagged citations from both engines. This module owns that merge branch only; the
// folders-only (#532) and single-connector (#189) paths are untouched so their wire output stays
// byte-identical (AC). It composes the exported folder helpers (grounded-qa-multi-source.ts) and
// connector seams (local-knowledge-grounded-qa.ts) without re-implementing retrieval.

import {
  logCitationReconciliation,
  reconcileAndLogInlineCitations,
} from "./grounded-citation-log.js";
import { isNoEvidenceAnswerText } from "@oscharko-dev/keiko-contracts/runtime/no-evidence-answer";
import {
  resolveCostClass,
  type ChatMessage as GatewayChatMessage,
} from "@oscharko-dev/keiko-model-gateway";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import { persistConnectedContextEvidence } from "@oscharko-dev/keiko-evidence";
import {
  createSqliteAuditSink,
  getCapsule,
  readCitationExcerpt,
  resolveScopeModelUsePolicy,
  runLocalKnowledgeRetrieval,
  type KnowledgeStore,
  type RetrievalResult,
  type VectorIndexOptions,
} from "@oscharko-dev/keiko-local-knowledge";
import type {
  KnowledgeCapsule,
  KnowledgeCapsuleId,
  KnowledgeSourceId,
  RetrievalReference,
  UncertaintyMarker,
} from "@oscharko-dev/keiko-contracts";
import {
  rerankAndSelect,
  withFinalMarkers,
  withModelRerankScore,
  type RerankInput,
  type SelectedCandidate,
} from "./grounded-rerank.js";

import {
  connectedContextOmittedCount,
  CANDIDATE_OMISSION_REASONS,
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  type CandidateOmissionReason,
  type ConnectedContextPack,
  type RetrievalQuery,
  type SelectedScope,
} from "@oscharko-dev/keiko-contracts/connected-context";
import {
  buildGroundedAnswerContextPackSummary,
  type ChatConnectedScope,
  type ChatLocalKnowledgeScope,
  type GroundedAnswer,
  type GroundedAnswerContextPackSummary,
  type GroundedEvidenceCitation,
  type GroundedPromptContextWire,
  type GroundedRerankerDiagnostics,
  type GroundedUncertainty,
  type HybridGroundedAnswer,
  type GroundedInsufficiencyDeclaration,
  type LocalKnowledgeEvidenceCitation,
  type LocalKnowledgeGroundedAnswerContextSummary,
} from "@oscharko-dev/keiko-contracts/bff-wire";

import type { RouteResult } from "./routes.js";
import { errorBody } from "./routes.js";
import type { Redactor, UiHandlerDeps } from "./deps.js";
import {
  currentContextProfileForModel,
  currentGroundingLimits,
  currentRedactionSecrets,
} from "./deps.js";
import { withAdoptedContextWindowRetry } from "./gateway-context-window.js";
import {
  countGatewayPromptTokens,
  type GatewayPromptTokenInput,
} from "@oscharko-dev/keiko-model-gateway/internal/prompt-token-accounting";
import { fitKnowledgePrompt, logPromptWindowFit } from "./knowledge-prompt-window.js";
import type { Chat, ChatMessage } from "./store/index.js";
import {
  ClarificationNeededError,
  clarificationUserMessage,
  type RetrievalOnlyOutput,
} from "./grounded-orchestrator.js";
import {
  buildConnectedScopes,
  defaultRetriever,
  mergeContextPackSummaries,
  groundedSourceScopeFingerprint,
  sourceLabels,
  splitExplorationBudget,
  splitExplorationBudgets,
  type GroundedRetriever,
} from "./grounded-qa-multi-source.js";
import {
  LOCAL_KNOWLEDGE_RETRIEVAL_CANDIDATES,
  activityDisplayName,
  buildSelectedScopeSourceLookup,
  createEmbeddingAdapter,
  openStoreForDeps,
  projectLocalKnowledgeCitation,
  retrievalActivityResultFromRetrieval,
  scopeStateFailure,
  selectedCapsulesForScope,
  tryBuildKnowledgePodRetrievalActivity,
  type SelectedLocalKnowledgeScope,
} from "./local-knowledge-grounded-qa.js";
import { buildStoredPreviewCitations } from "./local-knowledge-preview-authority.js";
import { GROUNDED_SYSTEM_PROMPT } from "./grounded-prompt.js";
import { sentPromptContext } from "./grounded-prompt-context.js";
import { evidenceRetentionObserver } from "./evidence-retention-log.js";
import {
  normalizeGroundedAnswerPayload,
  type GroundedAnswerPayload,
  type GroundedAnswerResult,
} from "./grounded-answer.js";
import {
  buildPackCitationIndex,
  buildInsufficiencyScopeIndex,
  validateGroundedAnswerEvidence,
  connectedSearchNoEvidenceAnswer,
  incompleteAnswerMarker,
  missingCitationMarkerFor,
  noEvidenceMarker,
  reconcileNumericCitations,
  unsupportedCitationMarker,
  unsupportedNumericCitationMarker,
  type NumericEntailmentEvidence,
  type NumericCitationReconciliation,
} from "./grounded-faithfulness.js";
import { assertUsableAssistantContent } from "./assistant-response.js";
import { rerankSelection } from "./grounded-rerank-facade.js";
import { buildLocalKnowledgeIndexLifecycle } from "./local-knowledge-index-lifecycle.js";
import { createEntailmentStage, type EntailmentStage } from "./grounded-entailment-stage.js";
import {
  appendGroundedAnswerEntailment,
  appendGroundedAnswerNumericEntailment,
  buildQuery,
  buildSelectedScopeFrom,
  clarificationRequest,
  deriveScopeIdFrom,
  ensureNotCancelled,
  groundedContextAssemblyInput,
  groundedContextSummaryInput,
  groundedEvidenceRunId,
  groundedScopeWorkspaceFs,
  mappedGatewayError,
  mappedWorkspaceError,
  modelWindowAwareBudget,
  modelInputPromptByteLimit,
  fitPromptOmissionMetadata,
  promptSafeExcerptText,
  numberedEvidenceText,
  evidenceProvenanceLine,
  omissionReasonLines,
  sizeExclusionLines,
  redactString,
} from "./grounded-qa.js";
import { persistGroundedExchange } from "./grounded-message-persistence.js";
import {
  captureConversationReadinessAdmission,
  withConversationReadinessAdmission,
  type ConversationReadinessAdmission,
} from "./conversation-readiness-admission.js";

// ─── Canonical connector reader ───────────────────────────────────────────────

// Mirrors buildConnectedScopes: the plural `localKnowledgeScopes` list supersedes the legacy single
// `localKnowledgeScope`. Readers must not mix the two — the list, when present, is authoritative.
export function buildLocalKnowledgeScopes(chat: Chat): readonly ChatLocalKnowledgeScope[] {
  return chat.localKnowledgeScopes ?? (chat.localKnowledgeScope ? [chat.localKnowledgeScope] : []);
}

// ─── Connector source labels (disambiguated like sourceLabels) ────────────────

export function connectorLabels(rawLabels: readonly string[]): readonly string[] {
  const counts = new Map<string, number>();
  for (const raw of rawLabels) counts.set(raw, (counts.get(raw) ?? 0) + 1);
  const seen = new Map<string, number>();
  return rawLabels.map((raw) => {
    if ((counts.get(raw) ?? 0) <= 1) return raw;
    const ordinal = (seen.get(raw) ?? 0) + 1;
    seen.set(raw, ordinal);
    return `${raw}#${String(ordinal)}`;
  });
}

// ─── Injected seams (tests) ───────────────────────────────────────────────────

export type EntailmentStageFactory = (input: {
  readonly capsules: readonly KnowledgeCapsule[];
  readonly modelId: string;
  readonly signal: AbortSignal;
}) => EntailmentStage | undefined;
export type FolderRetriever = GroundedRetriever;
export type ConnectorRetrieve = (
  store: KnowledgeStore,
  scope: ChatLocalKnowledgeScope,
  selected: SelectedLocalKnowledgeScope,
  signal?: AbortSignal,
) => Promise<RetrievalResult>;
export type HybridAnswerer = (system: string, user: string) => Promise<GroundedAnswerPayload>;

export interface HybridGroundedAskCtx {
  /** Verified discovered paths; only actual sent evidence promotes a path to read-state. */
  readonly insufficiencyScopeIndex?: ReadonlyMap<string, GroundedInsufficiencyDeclaration["state"]>;
  readonly startedAtMs?: number;
  readonly sourceScopeFingerprints?: ReadonlyMap<ChatConnectedScope, string>;
  /** Canonical closed omission counts from retrieved folders; no excluded paths or contents. */
  readonly folderOmissionMetadata?: readonly string[];
  readonly folderOmissionPacks?: readonly RetrievedFolder[];
  readonly retrievalContent?: string | undefined;
  readonly chat: Chat;
  readonly content: string;
  readonly answerContent?: string | undefined;
  readonly answerOnlyContextAvailable?: boolean | undefined;
  readonly clientTurnId?: string | undefined;
  readonly userMessage?: ChatMessage | undefined;
  readonly modelId: string;
  readonly contextProfile: UiHandlerDeps["contextProfile"];
  readonly deps: UiHandlerDeps;
  readonly signal: AbortSignal;
  readonly readinessAdmission?: ConversationReadinessAdmission | undefined;
  // ADR-0173 D5: the request-scoped correlation id, threaded from PreparedGroundedAsk into the
  // GatewayCallRequest.logContext the hybrid answerer stamps onto its model.call.
  readonly correlationId?: string | undefined;
  readonly folderRetriever?: FolderRetriever;
  readonly connectorRetrieve?: ConnectorRetrieve;
  readonly answer?: HybridAnswerer;
  // Test seam (KEIKO-0237): supply the entailment stage instead of building it from `deps`. In
  // production the factory is undefined and createEntailmentStage runs unchanged.
  readonly entailmentStageFactory?: EntailmentStageFactory;
  // Upfront-skipped folder scopes (inaccessible/denied at canonicalization time). Merged into
  // `skippedFolders` uncertainty entries alongside retrieval-time folder skips.
  readonly preSkippedFolders?: readonly {
    readonly label: string;
    readonly reason: string;
    readonly message: string;
  }[];
}

// ─── Retrieved-source records ─────────────────────────────────────────────────

interface RetrievedFolder {
  readonly sourceScopeFingerprint: string;
  readonly label: string;
  readonly pack: ConnectedContextPack;
  readonly elapsedMs: number;
  readonly scope: SelectedScope;
  readonly plan: RetrievalOnlyOutput["plan"];
}

interface RetrievedConnector {
  readonly label: string;
  readonly selected: SelectedLocalKnowledgeScope;
  readonly references: readonly RetrievalReference[];
  readonly result: RetrievalResult;
}

interface SkippedConnector {
  readonly label: string;
  readonly reason: string;
  readonly message: string;
  readonly selected?: SelectedLocalKnowledgeScope | undefined;
}

interface FolderRetrieval {
  readonly retrieved: readonly RetrievedFolder[];
  readonly skipped: readonly SkippedConnector[];
}

interface ConnectorRetrieval {
  readonly retrieved: readonly RetrievedConnector[];
  readonly skipped: readonly SkippedConnector[];
}

// ─── Unified RRF payload types ────────────────────────────────────────────────

interface FolderPayload {
  readonly kind: "folder";
  readonly scopePath: string;
  readonly lineRange: { readonly startLine: number; readonly endLine: number } | undefined;
  readonly score: number;
  readonly stableId: string;
  readonly sourceScopeFingerprint: string;
  readonly provenanceLine: string;
}

interface ConnectorPayload {
  readonly kind: "connector";
  readonly reference: RetrievalReference;
  readonly lookup: ReturnType<typeof buildSelectedScopeSourceLookup>;
}

type HybridPayload = FolderPayload | ConnectorPayload;

// Builds a single RRF-selected set that covers both folder and connector candidates. The selected
// set is the SOLE source of truth for both the prompt and the citations; the two paths must not
// diverge from this point forward.
function isFolderCandidate(
  candidate: SelectedCandidate<HybridPayload>,
): candidate is SelectedCandidate<FolderPayload> {
  return candidate.kind === "folder";
}

function isConnectorCandidate(
  candidate: SelectedCandidate<HybridPayload>,
): candidate is SelectedCandidate<ConnectorPayload> {
  return candidate.kind === "connector";
}

function folderRerankInputs(
  folders: readonly RetrievedFolder[],
  redactor: Redactor,
): RerankInput<HybridPayload>[] {
  return folders.flatMap((src) => {
    const sourceScopeFingerprint = src.sourceScopeFingerprint;
    return src.pack.files.flatMap((file) =>
      file.excerpts.map((excerpt) => ({
        kind: "folder" as const,
        redactedText: redactString(redactor, excerpt.content),
        engineScore: excerpt.atom.score,
        sourceLabel: redactString(redactor, src.label),
        tieKey: excerpt.atom.stableId,
        payload: {
          kind: "folder" as const,
          scopePath: excerpt.atom.scopePath,
          lineRange: excerpt.atom.lineRange,
          score: excerpt.atom.score,
          stableId: excerpt.atom.stableId,
          sourceScopeFingerprint,
          provenanceLine: evidenceProvenanceLine(excerpt.atom.provenance, redactor),
        },
      })),
    );
  });
}

// Cheap length proxy for rerankAndSelect's byte-budget check, computed from the citation's own
// character span — no store access. Text/page-unit references carry characterStart/characterEnd on
// every result (see scoped-vector-search), so this covers the overwhelming majority of connector
// candidates and lets the shared budget truncate the raw pool BEFORE any excerpt is decrypted.
// Returns undefined for a reference with no span (e.g. table/JSON-pointer citations), which falls
// back to eager hydration in connectorRerankInput below since there is nothing cheap to estimate.
export function estimateConnectorExcerptBytes(
  reference: RetrievalReference,
  maxExcerptChars: number,
): number | undefined {
  const { characterStart, characterEnd } = reference.citation;
  if (characterStart === undefined || characterEnd === undefined) return undefined;
  return Math.max(0, Math.min(characterEnd - characterStart, maxExcerptChars));
}

function connectorRerankInput(
  reference: RetrievalReference,
  src: RetrievedConnector,
  store: KnowledgeStore,
  redactor: Redactor,
  maxExcerptChars: number,
  lookup: ReturnType<typeof buildSelectedScopeSourceLookup>,
  includeExcerptText: boolean,
): RerankInput<HybridPayload> {
  const shared = {
    kind: "connector" as const,
    engineScore: reference.score,
    sourceLabel: redactString(redactor, src.label),
    tieKey: String(reference.chunkId),
    payload: { kind: "connector" as const, reference, lookup },
  };
  if (!includeExcerptText) {
    // Policy-denied path: unchanged — no external rerank call will consume this text, so hydration
    // stays fully deferred until the final prompt-sized selection (see selectHybridPromptCandidates).
    return { ...shared, redactedText: "" };
  }
  // The external reranker needs every preliminary candidate's text, but decrypting EVERY raw
  // candidate up front (up to maxLocalKnowledgeSources * topK, before the shared budget below has
  // truncated anything) is the cost this estimate removes: rank/truncate on the cheap proxy first,
  // then hydrateConnectorSelections fills in real text for the survivors only.
  const estimatedBytes = estimateConnectorExcerptBytes(reference, maxExcerptChars);
  return {
    ...shared,
    redactedText:
      estimatedBytes === undefined
        ? connectorRedactedText(store, reference, redactor, maxExcerptChars)
        : "",
    ...(estimatedBytes === undefined ? {} : { estimatedBytes }),
  };
}

function connectorRerankInputs(
  connectors: readonly RetrievedConnector[],
  store: KnowledgeStore,
  redactor: Redactor,
  maxExcerptChars: number,
  includeExcerptText: boolean,
): RerankInput<HybridPayload>[] {
  return connectors.flatMap((src) => {
    const lookup = buildSelectedScopeSourceLookup(store, src.selected);
    return src.references.map((reference) =>
      connectorRerankInput(
        reference,
        src,
        store,
        redactor,
        maxExcerptChars,
        lookup,
        includeExcerptText,
      ),
    );
  });
}

function connectorRedactedText(
  store: KnowledgeStore,
  reference: RetrievalReference,
  redactor: Redactor,
  maxExcerptChars: number,
): string {
  return redactString(
    redactor,
    readCitationExcerpt(store, reference.capsuleId, reference.citation, maxExcerptChars),
  );
}

function buildUnifiedSelection(
  ctx: HybridGroundedAskCtx,
  folders: readonly RetrievedFolder[],
  connectors: readonly RetrievedConnector[],
  store: KnowledgeStore,
  includeConnectorExcerptText: boolean,
): readonly SelectedCandidate<HybridPayload>[] {
  const limits = currentGroundingLimits(ctx.deps);
  const { redactor } = ctx.deps;
  const inputs: RerankInput<HybridPayload>[] = [
    ...folderRerankInputs(folders, redactor),
    ...connectorRerankInputs(
      connectors,
      store,
      redactor,
      limits.maxExcerptChars,
      includeConnectorExcerptText,
    ),
  ];
  return rerankAndSelect(inputs, {
    maxCandidates: limits.hybridMaxCandidates,
    maxExcerptBytes: limits.hybridMaxExcerptBytes,
  });
}

function hydrateConnectorSelection(
  store: KnowledgeStore,
  candidate: SelectedCandidate<HybridPayload>,
  redactor: Redactor,
  maxExcerptChars: number,
): SelectedCandidate<HybridPayload> {
  // Already-hydrated candidates (connectorRerankInput's eager-fallback branch) are a no-op here —
  // only a deferred ("") excerpt needs the real read.
  if (!isConnectorCandidate(candidate) || candidate.redactedText.length > 0) return candidate;
  const redactedText = connectorRedactedText(
    store,
    candidate.payload.reference,
    redactor,
    maxExcerptChars,
  );
  return { ...candidate, redactedText, bytes: Buffer.byteLength(redactedText, "utf8") };
}

function hydrateConnectorSelections(
  store: KnowledgeStore,
  selected: readonly SelectedCandidate<HybridPayload>[],
  redactor: Redactor,
  maxExcerptChars: number,
): readonly SelectedCandidate<HybridPayload>[] {
  return selected.map((candidate) =>
    hydrateConnectorSelection(store, candidate, redactor, maxExcerptChars),
  );
}

interface HybridRerankedSelection {
  readonly selected: readonly SelectedCandidate<HybridPayload>[];
  readonly diagnostics: GroundedRerankerDiagnostics;
}

async function rerankHybridSelection(
  ctx: HybridGroundedAskCtx,
  preliminary: readonly SelectedCandidate<HybridPayload>[],
  limits: ReturnType<typeof currentGroundingLimits>,
  externalRerankingDenied: boolean,
): Promise<HybridRerankedSelection> {
  const result = await rerankSelection({
    deps: ctx.deps,
    query: ctx.retrievalContent ?? ctx.content,
    candidates: preliminary,
    documentFor: (candidate) => candidate.redactedText,
    topN: limits.maxPromptReferences,
    signal: ctx.signal,
    policy: {
      externalReranking: externalRerankingDenied ? "deny" : "allow",
      localReranking: "allow",
    },
    applyScore: withModelRerankScore,
    fallbackMode: "slice-topN",
  });
  return { selected: withFinalMarkers(result.selected), diagnostics: result.diagnostics };
}

function connectorsDenyExternalReranking(connectors: readonly RetrievedConnector[]): boolean {
  return connectors.some(
    (connector) =>
      resolveScopeModelUsePolicy(connector.selected.capsules).operations.externalReranking ===
      "deny",
  );
}

function capsuleAllowsEvidencePersistence(capsule: KnowledgeCapsule | undefined): boolean {
  if (capsule === undefined) return false;
  return resolveScopeModelUsePolicy([capsule]).operations.evidencePersistence === "allow";
}

function referenceAllowsEvidencePersistence(
  store: KnowledgeStore,
  reference: RetrievalReference,
): boolean {
  return capsuleAllowsEvidencePersistence(getCapsule(store, reference.capsuleId));
}

// ─── Folder retrieval (mirrors runMultiSourceAsk's loop) ──────────────────────

// Bounded concurrency for folder retrieval, mirroring MAX_CONNECTOR_RETRIEVAL_CONCURRENCY below:
// each folder retrieval is I/O-bound (embedding + repo-search), and paying those serially made
// hybrid asks with multiple folder scopes scale with the folder count instead of the slowest
// single folder.
const MAX_FOLDER_RETRIEVAL_CONCURRENCY = 4;

type FolderSlot =
  | { readonly kind: "retrieved"; readonly value: RetrievedFolder }
  | { readonly kind: "skipped"; readonly value: SkippedConnector }
  | undefined;

function retrievedFolderSlot(
  ctx: HybridGroundedAskCtx,
  cs: ChatConnectedScope,
  label: string,
  scope: SelectedScope,
  out: RetrievalOnlyOutput,
): FolderSlot {
  return {
    kind: "retrieved",
    value: {
      label,
      pack: out.pack,
      elapsedMs: out.elapsedMs,
      scope,
      plan: out.plan,
      sourceScopeFingerprint: groundedSourceScopeFingerprint(
        scope,
        cs,
        ctx.sourceScopeFingerprints,
      ),
    },
  };
}

function invalidFolderSlot(label: string): FolderSlot {
  return {
    kind: "skipped",
    value: { label, reason: "pack-validation-failed", message: "Pack validation failed." },
  };
}

function recoverableFolderFailure(
  ctx: HybridGroundedAskCtx,
  error: unknown,
  label: string,
  index: number,
): FolderSlot | undefined {
  const failure = caughtGroundedPackValidation(error);
  if (failure !== undefined) {
    recordGroundedPackValidation(ctx.deps, ctx.correlationId, failure, "source-skipped", index);
    return invalidFolderSlot(label);
  }
  if (error instanceof EmbeddingAdapterError) {
    return {
      kind: "skipped",
      value: { label, reason: "embedding-unavailable", message: "Embedding adapter unavailable." },
    };
  }
  return undefined;
}

async function retrieveFolderIntoSlot(
  ctx: HybridGroundedAskCtx,
  retriever: FolderRetriever,
  query: RetrievalQuery,
  budget: ReturnType<typeof splitExplorationBudget>,
  inputs: { readonly cs: ChatConnectedScope; readonly label: string; readonly index: number },
): Promise<FolderSlot> {
  const { cs, label, index } = inputs;
  const scope = buildSelectedScopeFrom(ctx.chat, cs, deriveScopeIdFrom(ctx.chat, cs, index));
  let out: RetrievalOnlyOutput;
  try {
    const workspaceFs = groundedScopeWorkspaceFs(cs);
    out = await retriever(
      {
        scope,
        query,
        workspaceRoot: scope.workspaceRoot,
        budget,
        ...(workspaceFs === undefined ? {} : { workspaceFs }),
      },
      ctx.signal,
    );
    ensureNotCancelled(ctx.signal);
  } catch (error) {
    // Only declared per-source degradation is recoverable; cancellation, gateway and unknown
    // failures retain their original error and propagate to the owning route boundary.
    const recovered = recoverableFolderFailure(ctx, error, label, index);
    if (recovered !== undefined) return recovered;
    throw error;
  }
  const validationFailure = inspectGroundedPack(out.pack, {
    deps: ctx.deps,
    correlationId: ctx.correlationId,
    outcome: "source-skipped",
    sourceIndex: index,
  });
  if (validationFailure !== undefined) return invalidFolderSlot(label);
  return retrievedFolderSlot(ctx, cs, label, scope, out);
}

async function retrieveFolderPacks(
  ctx: HybridGroundedAskCtx,
  folderScopes: readonly ChatConnectedScope[],
  query: RetrievalQuery,
  retriever: FolderRetriever,
): Promise<FolderRetrieval> {
  const labels = sourceLabels(folderScopes);
  // KEIKO-0174 (#2901): the singular form uniformly gives every folder the FIRST slice of an equal
  // split, so with N folders every folder received the same rich share and the total N x work broke
  // the documented "sum of every dimension equals the base cap" invariant. The plural form is
  // query-weighted and per-folder, and re-uses the same allocation runMultiSourceAsk already uses.
  const perFolderBudgets = splitExplorationBudgets(
    modelWindowAwareBudget(ctx.deps, ctx.modelId),
    folderScopes,
    query,
  );
  // Index-addressed slots keep the emitted order identical to the scope order regardless of which
  // worker finishes first — evidence and labels stay deterministic (mirrors retrieveConnectors).
  const slots = await mapWithConcurrency(
    folderScopes,
    MAX_FOLDER_RETRIEVAL_CONCURRENCY,
    async (cs, index, signal): Promise<FolderSlot> => {
      ensureNotCancelled(signal);
      const label = labels[index];
      const folderBudget = perFolderBudgets[index] ?? perFolderBudgets.at(-1);
      if (label === undefined || folderBudget === undefined) return undefined;
      return retrieveFolderIntoSlot({ ...ctx, signal }, retriever, query, folderBudget, {
        cs,
        label,
        index,
      });
    },
    ctx.signal,
  );
  ensureNotCancelled(ctx.signal);
  const retrieved: RetrievedFolder[] = [];
  const skipped: SkippedConnector[] = [];
  for (const slot of slots) {
    if (slot === undefined) continue;
    if (slot.kind === "retrieved") retrieved.push(slot.value);
    else skipped.push(slot.value);
  }
  return { retrieved, skipped };
}

// ─── Connector retrieval ──────────────────────────────────────────────────────

function resolveConnectorScopes(
  connectorScopes: readonly ChatLocalKnowledgeScope[],
  store: KnowledgeStore,
): readonly SelectedLocalKnowledgeScope[] | RouteResult {
  const resolved: SelectedLocalKnowledgeScope[] = [];
  for (const scope of connectorScopes) {
    const selected = selectedCapsulesForScope(scope, store);
    if ("status" in selected) return selected;
    resolved.push(selected);
  }
  return resolved;
}

// Per-connector share of the candidate budget, mirroring splitExplorationBudget on the folder side
// (above): without this, topK stayed fixed per connector regardless of connector count, so raw
// candidate volume scaled as numConnectors * topK (up to maxLocalKnowledgeSources * 100) instead of
// a shared budget. Floored so a large connector count still retrieves a useful minimum per source
// rather than starving to near-zero.
const MIN_CONNECTOR_RETRIEVAL_CANDIDATES = 15;

export function connectorRetrievalTopK(connectorScopeCount: number): number {
  if (connectorScopeCount <= 1) return LOCAL_KNOWLEDGE_RETRIEVAL_CANDIDATES;
  const share = Math.floor(LOCAL_KNOWLEDGE_RETRIEVAL_CANDIDATES / connectorScopeCount);
  return Math.max(MIN_CONNECTOR_RETRIEVAL_CANDIDATES, share);
}

export function connectorQuery(
  scope: ChatLocalKnowledgeScope,
  content: string,
  connectorScopeCount: number,
): RetrievalQueryShape {
  return {
    text: content,
    topK: connectorRetrievalTopK(connectorScopeCount),
    ...(scope.kind === "capsule" ? { capsuleId: scope.capsuleId } : {}),
    ...(scope.kind === "capsule-set" ? { capsuleSetId: scope.capsuleSetId } : {}),
  };
}

type RetrievalQueryShape = Parameters<typeof runLocalKnowledgeRetrieval>[1];

function defaultConnectorRetrieve(
  ctx: HybridGroundedAskCtx,
  connectorScopeCount: number,
  vectorIndex: VectorIndexOptions,
): ConnectorRetrieve {
  return async (store, scope, _selected, signal = ctx.signal): Promise<RetrievalResult> => {
    const embeddingAdapter = createEmbeddingAdapter(ctx.deps);
    if ("status" in embeddingAdapter) {
      throw new EmbeddingAdapterError(embeddingAdapter);
    }
    return await runLocalKnowledgeRetrieval(
      { store, embeddingAdapter, signal, vectorIndex },
      connectorQuery(scope, ctx.retrievalContent ?? ctx.content, connectorScopeCount),
    );
  };
}

export class EmbeddingAdapterError extends Error {
  public constructor(public readonly result: RouteResult) {
    super("embedding adapter unavailable");
    this.name = "EmbeddingAdapterError";
  }
}

// Bounded concurrency for connector retrieval, mirroring MAX_RETRIEVAL_CONCURRENCY on the
// folder-source path: the SQLite reads are synchronous either way, but each connector's query
// embedding is a network call, and paying those serially made multi-connector asks scale with
// the connector count instead of the slowest single connector.
const MAX_CONNECTOR_RETRIEVAL_CONCURRENCY = 4;

type ConnectorSlot =
  | { readonly kind: "retrieved"; readonly value: RetrievedConnector }
  | { readonly kind: "skipped"; readonly value: SkippedConnector }
  | undefined;

async function retrieveConnectorIntoSlot(
  retrieve: ConnectorRetrieve,
  store: KnowledgeStore,
  signal: AbortSignal,
  inputs: {
    readonly scope: ChatLocalKnowledgeScope;
    readonly selected: SelectedLocalKnowledgeScope;
    readonly label: string;
  },
): Promise<ConnectorSlot> {
  const failure = scopeStateFailure(inputs.selected);
  if (failure !== undefined) {
    return {
      kind: "skipped",
      value: {
        label: inputs.label,
        reason: failure.reason,
        message: failure.message,
        selected: inputs.selected,
      },
    };
  }
  const outcome = await retrieveOneConnector(
    retrieve,
    store,
    inputs.scope,
    inputs.selected,
    signal,
  );
  if ("status" in outcome) {
    return {
      kind: "skipped",
      value: {
        label: inputs.label,
        reason: "embedding-unavailable",
        message: "Embedding adapter unavailable.",
        selected: inputs.selected,
      },
    };
  }
  return {
    kind: "retrieved",
    value: {
      label: inputs.label,
      selected: inputs.selected,
      references: outcome.references,
      result: outcome,
    },
  };
}

async function retrieveConnectors(
  ctx: HybridGroundedAskCtx,
  store: KnowledgeStore,
  vectorIndex: VectorIndexOptions,
  connectorScopes: readonly ChatLocalKnowledgeScope[],
  resolved: readonly SelectedLocalKnowledgeScope[],
): Promise<ConnectorRetrieval | RouteResult> {
  const retrieve =
    ctx.connectorRetrieve ?? defaultConnectorRetrieve(ctx, connectorScopes.length, vectorIndex);
  const labels = connectorLabels(resolved.map((s) => s.scopeLabel));
  // Index-addressed slots keep the emitted order identical to the scope order regardless of
  // which worker finishes first — evidence and labels stay deterministic.
  const slots = await mapWithConcurrency(
    connectorScopes,
    MAX_CONNECTOR_RETRIEVAL_CONCURRENCY,
    async (scope, index, signal): Promise<ConnectorSlot> => {
      ensureNotCancelled(signal);
      const selected = resolved[index];
      const label = labels[index];
      if (selected === undefined || label === undefined) return undefined;
      return retrieveConnectorIntoSlot(retrieve, store, signal, { scope, selected, label });
    },
    ctx.signal,
  );
  ensureNotCancelled(ctx.signal);
  const retrieved: RetrievedConnector[] = [];
  const skipped: SkippedConnector[] = [];
  for (const slot of slots) {
    if (slot === undefined) continue;
    if (slot.kind === "retrieved") retrieved.push(slot.value);
    else skipped.push(slot.value);
  }
  return { retrieved, skipped };
}

async function retrieveOneConnector(
  retrieve: ConnectorRetrieve,
  store: KnowledgeStore,
  scope: ChatLocalKnowledgeScope,
  selected: SelectedLocalKnowledgeScope,
  signal: AbortSignal,
): Promise<RetrievalResult | RouteResult> {
  try {
    return await retrieve(store, scope, selected, signal);
  } catch (error) {
    if (error instanceof EmbeddingAdapterError) return error.result;
    throw error;
  }
}

// ─── Merged prompt ────────────────────────────────────────────────────────────

// The hybrid topology shares the folder prompt and deterministic localized abstention producer.
const HYBRID_SYSTEM_PROMPT =
  `${GROUNDED_SYSTEM_PROMPT} Connector excerpts are indexed-document citations: attribute every ` +
  "connector claim to its source label and the matching [n] marker in addition to any file reference.";

function hybridCandidateExcerpt(candidate: SelectedCandidate<HybridPayload>): string {
  if (candidate.redactedText.length === 0) return "(No excerpt text available.)";
  const range = isFolderCandidate(candidate) ? candidate.payload.lineRange : undefined;
  return promptSafeExcerptText(numberedEvidenceText(candidate.redactedText, range));
}

function renderHybridCandidateBlock(candidate: SelectedCandidate<HybridPayload>): string {
  const kindLabel = candidate.kind === "folder" ? "Folder" : "Connector";
  const excerpt = hybridCandidateExcerpt(candidate);
  const provenance = isFolderCandidate(candidate) ? `${candidate.payload.provenanceLine}\n` : "";
  return (
    `[${String(candidate.marker)}] ### ${kindLabel} source: ${candidate.sourceLabel}\n` +
    provenance +
    `\`\`\`text\n${excerpt}\n\`\`\``
  );
}

// Builds the user message from the SAME selected set used for citations. Each candidate gets a
// single global [n] marker that is consistent with the citation arrays. redactedText is
// already redacted — do NOT pass it through redactString again.
function buildRerankedHybridUserMessage(
  question: string,
  selected: readonly SelectedCandidate<HybridPayload>[],
  redactor: Redactor,
  omissionMetadata: readonly string[] = [],
): string {
  const folderCount = selected.filter((s) => s.kind === "folder").length;
  const connectorCount = selected.filter((s) => s.kind === "connector").length;
  const lines: string[] = [
    "User question:",
    redactString(redactor, question),
    "",
    `Connected sources: ${String(folderCount)} folder(s), ${String(connectorCount)} connector(s).`,
    "Cite every claim by its [n] marker and source label.",
    ...omissionMetadata,
    "",
  ];
  for (const candidate of selected) {
    lines.push(renderHybridCandidateBlock(candidate), "");
  }
  return lines.join("\n");
}

function numericEntailmentEvidence(
  selected: readonly SelectedCandidate<HybridPayload>[],
): readonly NumericEntailmentEvidence[] {
  return selected.map((candidate) => ({
    marker: candidate.marker,
    // The exact helper used by the prompt is the source of truth for semantic judgment. Every
    // selected folder and connector receives a numeric marker, so every one must reach the judge.
    excerptText: renderHybridCandidateBlock(candidate),
  }));
}

export function createHybridAnswerer(
  model: ModelPort,
  modelId: string,
  signal: AbortSignal,
  correlationId: string | undefined,
): HybridAnswerer {
  return async (system, user): Promise<GroundedAnswerResult> => {
    ensureNotCancelled(signal);
    const response = await model.call(
      {
        modelId,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        stream: false,
        logContext: { correlationId },
      },
      signal,
    );
    const content = response.content.trim();
    assertUsableAssistantContent(content, modelId);
    return {
      content,
      usage: {
        promptTokens: response.usage.promptTokens,
        completionTokens: response.usage.completionTokens,
      },
      finishReason: response.finishReason,
    };
  };
}

// ─── Citations + summaries ────────────────────────────────────────────────────

// Both citation arrays are derived from the SAME selected set so that the [n] markers in the
// prompt are always consistent with the citation arrays surfaced to the client.
function citedHybridSelections(
  selected: readonly SelectedCandidate<HybridPayload>[],
  assistantContent: string,
): readonly SelectedCandidate<HybridPayload>[] {
  const supportedMarkers = new Set(selected.map((candidate) => candidate.marker));
  const { citedMarkers } = reconcileNumericCitations(assistantContent, supportedMarkers);
  return selected.filter((candidate) => citedMarkers.has(candidate.marker));
}

function selectedFolderCitations(
  selected: readonly SelectedCandidate<HybridPayload>[],
  redactor: Redactor,
): readonly GroundedEvidenceCitation[] {
  return selected
    .filter((s): s is SelectedCandidate<FolderPayload> => s.kind === "folder")
    .map((s) => ({
      scopePath: redactString(redactor, s.payload.scopePath),
      lineRange: s.payload.lineRange,
      score: s.payload.score,
      stableId: redactString(redactor, s.payload.stableId),
      source: s.sourceLabel,
      sourceScopeFingerprint: s.payload.sourceScopeFingerprint,
      marker: s.marker,
    }));
}

function selectedConnectorCitations(
  store: KnowledgeStore,
  selected: readonly SelectedCandidate<HybridPayload>[],
  redactor: Redactor,
): readonly LocalKnowledgeEvidenceCitation[] {
  return selected
    .filter((s): s is SelectedCandidate<ConnectorPayload> => s.kind === "connector")
    .map((s) =>
      projectLocalKnowledgeCitation(
        s.payload.reference,
        `[${String(s.marker)}]`,
        s.payload.lookup,
        (value) => redactString(redactor, value),
        store,
      ),
    );
}

function selectedConnectorPreviewCitations(
  store: KnowledgeStore,
  selected: readonly SelectedCandidate<HybridPayload>[],
  redactor: Redactor,
): readonly import("@oscharko-dev/keiko-contracts").StoredPdfCitationPreviewCitation[] {
  return buildStoredPreviewCitations(
    store,
    selected
      .filter((s): s is SelectedCandidate<ConnectorPayload> => s.kind === "connector")
      .filter((s) => referenceAllowsEvidencePersistence(store, s.payload.reference))
      .map((s) => {
        const sourceLabel = s.payload.lookup(s.payload.reference);
        return {
          marker: `[${String(s.marker)}]`,
          ...(sourceLabel === undefined
            ? {}
            : { sourceLabel: redactString(redactor, sourceLabel) }),
          reference: s.payload.reference,
        };
      }),
  );
}

function connectorCapsuleIds(connector: RetrievedConnector): ReadonlySet<string> {
  return new Set(connector.selected.capsules.map((capsule) => String(capsule.id)));
}

function knowledgeCitationsForConnector(
  citations: readonly LocalKnowledgeEvidenceCitation[],
  connector: RetrievedConnector,
): readonly LocalKnowledgeEvidenceCitation[] {
  const capsuleIds = connectorCapsuleIds(connector);
  return citations.filter((citation) => capsuleIds.has(String(citation.lineage.capsuleId)));
}

function selectedConnectorSkips(skipped: readonly SkippedConnector[]): readonly {
  readonly selected: SelectedLocalKnowledgeScope;
  readonly reason: string;
}[] {
  return skipped.flatMap((entry) =>
    entry.selected === undefined ? [] : [{ selected: entry.selected, reason: entry.reason }],
  );
}

function buildHybridRetrievalActivity(
  store: KnowledgeStore,
  connectors: readonly RetrievedConnector[],
  skipped: readonly SkippedConnector[],
  knowledgeCitations: readonly LocalKnowledgeEvidenceCitation[],
  reranker: GroundedRerankerDiagnostics,
  diagnostics: UiHandlerDeps["diagnostics"],
): HybridGroundedAnswer["retrievalActivity"] {
  return tryBuildKnowledgePodRetrievalActivity({
    store,
    sources: connectors.map((connector) => ({
      selected: connector.selected,
      result: retrievalActivityResultFromRetrieval(
        connector.result,
        knowledgeCitationsForConnector(knowledgeCitations, connector),
        reranker,
      ),
    })),
    skipped: selectedConnectorSkips(skipped),
    diagnostics,
  });
}

function zeroExploration(): GroundedAnswerContextPackSummary["usage"] {
  return {
    searchCalls: 0,
    filesRead: 0,
    excerptBytes: 0,
    modelInputTokens: 0,
    modelOutputTokens: 0,
    elapsedMs: 0,
    rerankCalls: 0,
  };
}

function zeroBudget(): GroundedAnswerContextPackSummary["budget"] {
  return {
    searchCallsMax: 0,
    filesReadMax: 0,
    excerptBytesMax: 0,
    modelInputTokensMax: 0,
    modelOutputTokensMax: 0,
    elapsedMsMax: 0,
    rerankCallsMax: 0,
  };
}

function zeroOmittedCounts(): Record<CandidateOmissionReason, number> {
  const counts = {} as Record<CandidateOmissionReason, number>;
  for (const reason of CANDIDATE_OMISSION_REASONS) counts[reason] = 0;
  return counts;
}

// The hybrid contract requires a folder summary even when a chat has zero folders (connector-only
// merge). This is a structurally empty, deterministic summary — no source pack to derive from.
function emptyFolderSummary(): GroundedAnswerContextPackSummary {
  return {
    schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
    scopeId: "scope-empty",
    scopeKind: "workspace-root",
    fileCount: 0,
    queryKind: "natural-language",
    usage: zeroExploration(),
    budget: zeroBudget(),
    citationCount: 0,
    omittedCount: 0,
    omittedCounts: zeroOmittedCounts(),
    uncertaintyCount: 0,
    elapsedMs: 0,
  };
}

function folderSummary(
  folders: readonly RetrievedFolder[],
  cited: readonly SelectedCandidate<HybridPayload>[],
  _redactor: Redactor,
  deps: Pick<UiHandlerDeps, "contextProfile">,
): GroundedAnswerContextPackSummary {
  if (folders.length === 0) return emptyFolderSummary();
  return mergeContextPackSummaries(
    folders.map((src) =>
      buildGroundedAnswerContextPackSummary(
        src.pack,
        folderCitationCount(src.pack, cited),
        src.elapsedMs,
        groundedContextSummaryInput(deps, src.pack),
      ),
    ),
  );
}

function folderCitationCount(
  pack: ConnectedContextPack,
  cited: readonly SelectedCandidate<HybridPayload>[],
): number {
  const availableIds = new Set(
    pack.files.flatMap((file) => file.excerpts.map((excerpt) => excerpt.atom.stableId)),
  );
  return cited
    .filter(isFolderCandidate)
    .filter((candidate) => availableIds.has(candidate.payload.stableId)).length;
}

export function hashString32(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.at(index)?.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function connectorSourceCount(connectors: readonly RetrievedConnector[]): number {
  const sourceIds = new Set<string>();
  for (const src of connectors) {
    for (const capsule of src.selected.capsules) {
      for (const id of capsule.sourceIds) sourceIds.add(String(id));
    }
  }
  return sourceIds.size;
}

// One merged knowledge summary across every connector. Counts are aggregated so the wire shape
// stays a single LocalKnowledgeGroundedAnswerContextSummary even when N connectors contributed.
// referencesUsed = connector candidates in the SHARED prompt-selected set; referenceBudget = the
// shared prompt-reference cap so the invariant referencesUsed <= referenceBudget always holds.
function knowledgeSummary(
  chat: Chat,
  connectors: readonly RetrievedConnector[],
  citationCount: number,
  referencesUsed: number,
  referenceBudget: number,
  reranker: GroundedRerankerDiagnostics,
): LocalKnowledgeGroundedAnswerContextSummary {
  const capsuleCount = connectors.reduce((acc, src) => acc + src.selected.capsules.length, 0);
  const label = connectors.map((src) => src.label).join("+");
  const scopeKind = connectors.length === 1 ? connectors[0]?.selected.scopeKind : "capsule-set";
  const capsules = connectors.flatMap((src) => src.selected.capsules);
  // Unlike the local-knowledge context pack, this joined multi-connector label previously reached
  // the client-facing summary with no redaction or safe-text gate at all — a raw pod/pod-set
  // display name containing a filesystem path or PII leaked verbatim. Gate each connector's label
  // individually before joining, so one unsafe label falls back without discarding the others.
  const safeLabel = connectors.map((src) => activityDisplayName(src.label)).join("+");
  const chatLabelHash = hashString32(`${chat.id}|${label}`);
  return {
    kind: "local-knowledge",
    scopeKind: scopeKind ?? "capsule-set",
    scopeId: `lk-${chatLabelHash}`,
    scopeLabel: safeLabel,
    capsuleCount,
    sourceCount: connectorSourceCount(connectors),
    citationCount,
    referenceBudget,
    referencesUsed,
    reranker,
    indexLifecycle: buildLocalKnowledgeIndexLifecycle(capsules),
  };
}

function skippedUncertainty(
  skipped: readonly SkippedConnector[],
  redactor: Redactor,
): readonly GroundedUncertainty[] {
  return skipped.map((entry) => ({
    kind: entry.reason,
    claim: redactString(redactor, `Connector ${entry.label} skipped: ${entry.message}`),
  }));
}

function folderUncertainty(
  folders: readonly RetrievedFolder[],
  redactor: Redactor,
): readonly GroundedUncertainty[] {
  return folders.flatMap((src) =>
    src.pack.uncertainty.map((u) => ({
      kind: u.kind,
      claim: redactString(redactor, u.claim),
    })),
  );
}

// The folder evidence the model was shown: every retrieved folder pack restricted to the excerpts
// of the sent (reranked and window-fitted) folder candidates. A `[path:line]` citation and its
// entailment judgment obey the same sent-evidence boundary as a numeric `[n]`; an excerpt the fit or
// the rerank cap left out of the prompt supports nothing (PR #3678 review).
function sentFolderPacks(
  folders: readonly RetrievedFolder[],
  selected: readonly SelectedCandidate<HybridPayload>[],
): readonly ConnectedContextPack[] {
  const sent = new Set(
    selected.filter(isFolderCandidate).map((candidate) => candidate.payload.stableId),
  );
  return folders.map(({ pack }) => ({
    ...pack,
    files: pack.files
      .map((file) => ({
        ...file,
        excerpts: file.excerpts.filter((excerpt) => sent.has(excerpt.atom.stableId)),
      }))
      .filter((file) => file.excerpts.length > 0),
  }));
}

function hybridNumericReconciliation(
  answer: string,
  selected: readonly SelectedCandidate<HybridPayload>[],
  correlationId: string | undefined,
): NumericCitationReconciliation {
  const supportedMarkers = new Set(selected.map((candidate) => candidate.marker));
  const reconciliation = reconcileNumericCitations(answer, supportedMarkers);
  logCitationReconciliation(
    {
      answer,
      referenceCount: supportedMarkers.size,
      attachedIndices: [...reconciliation.citedMarkers],
      refusal: isNoEvidenceAnswerText(answer),
    },
    correlationId,
  );
  return reconciliation;
}

// GEN-AI-GROUNDING-001/-008 (RB-4): reconcile the hybrid answer's inline `[path:line]` citations
// against the FOLDER evidence packs the model actually received. Connector citations use marker
// labels rather than repo paths, so path-shaped inline references are validated against folder
// evidence (where the [path:line] format applies). Mirrors the single/multi-source reconciliation.
function hybridReconciliationUncertainty(
  assistant: GroundedAnswerResult,
  folders: readonly RetrievedFolder[],
  selected: readonly SelectedCandidate<HybridPayload>[],
  redactor: Redactor,
  sourceEvidenceAvailable: boolean,
  correlationId: string | undefined,
): readonly GroundedUncertainty[] {
  const nowMs = Date.now();
  const reconciliation = reconcileAndLogInlineCitations(
    assistant.content,
    buildPackCitationIndex(sentFolderPacks(folders, selected)),
    correlationId,
  );
  const unsupported = unsupportedCitationMarker(reconciliation.unsupported, nowMs);
  const numericReconciliation = hybridNumericReconciliation(
    assistant.content,
    selected,
    correlationId,
  );
  const unsupportedNumeric = unsupportedNumericCitationMarker(
    numericReconciliation.unsupportedMarkers,
    nowMs,
  );
  const missing =
    sourceEvidenceAvailable &&
    unsupported === undefined &&
    unsupportedNumeric === undefined &&
    reconciliation.citedScopePaths.size === 0 &&
    numericReconciliation.citedMarkers.size === 0
      ? missingCitationMarkerFor(assistant.content, nowMs, assistant.answerKind)
      : undefined;
  const markers = [
    ...(unsupported === undefined ? [] : [unsupported]),
    ...(unsupportedNumeric === undefined ? [] : [unsupportedNumeric]),
    ...(missing === undefined ? [] : [missing]),
    ...(assistant.finishReason === "length" ? [incompleteAnswerMarker(nowMs)] : []),
  ];
  return markers.map((m) => ({ kind: m.kind, claim: redactString(redactor, m.claim) }));
}

// Knowledge M1.2 (#2563) / #2947: judge the hybrid answer's `[path:line]` and connector `[n]`
// citations against their selected evidence. Capsule policy applies here — a connector capsule that
// denies `answerSynthesis` keeps the stage inert.
function hybridEntailmentStage(
  ctx: HybridGroundedAskCtx,
  capsules: readonly KnowledgeCapsule[],
): EntailmentStage | undefined {
  return ctx.entailmentStageFactory !== undefined
    ? ctx.entailmentStageFactory({ capsules, modelId: ctx.modelId, signal: ctx.signal })
    : createEntailmentStage(
        ctx.deps,
        capsules,
        ctx.modelId,
        // The request's correlation, so the verdict line joins the ask (PR #3678 review).
        { diagnostics: ctx.deps.diagnostics, correlationId: ctx.correlationId },
        ctx.signal,
      );
}

function answerWithHybridMarkers(
  ctx: HybridGroundedAskCtx,
  answer: HybridGroundedAnswer,
  markers: readonly UncertaintyMarker[],
): HybridGroundedAnswer {
  if (markers.length === 0) return answer;
  return {
    ...answer,
    uncertainty: [
      ...answer.uncertainty,
      ...markers.map((marker) => ({
        kind: marker.kind,
        claim: redactString(ctx.deps.redactor, marker.claim),
      })),
    ],
  };
}

async function applyHybridEntailment(
  ctx: HybridGroundedAskCtx,
  answer: HybridGroundedAnswer,
  answerContent: string,
  folders: readonly RetrievedFolder[],
  connectors: readonly RetrievedConnector[],
  selected: readonly SelectedCandidate<HybridPayload>[],
): Promise<HybridGroundedAnswer> {
  const capsules = connectors.flatMap((src) => src.selected.capsules);
  const stage = hybridEntailmentStage(ctx, capsules);
  if (stage === undefined) {
    return answer;
  }
  const sentPacks = sentFolderPacks(folders, selected);
  if (stage.evaluateHybrid !== undefined) {
    const markers = await stage.evaluateHybrid(
      answerContent,
      sentPacks,
      numericEntailmentEvidence(selected),
      Date.now(),
    );
    return answerWithHybridMarkers(ctx, answer, markers);
  }
  const folderEntailment = await appendGroundedAnswerEntailment(
    answer,
    stage,
    answerContent,
    sentPacks,
    ctx.deps.redactor,
  );
  return appendGroundedAnswerNumericEntailment(
    folderEntailment,
    stage,
    answerContent,
    numericEntailmentEvidence(selected),
    ctx.deps.redactor,
  );
}

// ─── Evidence persistence ─────────────────────────────────────────────────────

// Persists ONE evidence run per folder source (mirrors the #532 per-source persist) plus the
// connector retrieval/answer-context audit via the LK sink (mirrors the single-connector path).
// Returns the first folder run id, surfaced as the answer's primary evidenceRunId, plus the full
// folder evidence set so reviewers can inspect every connected-context source.
function persistFolderEvidence(
  ctx: HybridGroundedAskCtx,
  folders: readonly RetrievedFolder[],
  cited: readonly SelectedCandidate<HybridPayload>[],
): { readonly firstRunId: string | undefined; readonly runIds: readonly string[] } {
  let firstRunId: string | undefined;
  const runIds: string[] = [];
  for (const [ordinal, src] of folders.entries()) {
    const finishedAt = Date.now();
    const startedAt = Math.max(0, finishedAt - src.elapsedMs);
    const runId = groundedEvidenceRunId({
      chatId: ctx.chat.id,
      clientTurnId: ctx.clientTurnId,
      workspaceRoot: src.scope.workspaceRoot,
      sourceKind: "folder",
      ordinal,
    });
    persistConnectedContextEvidence(
      {
        runId,
        modelId: ctx.modelId,
        workspaceRoot: src.scope.workspaceRoot,
        chatId: ctx.chat.id,
        plan: src.plan,
        pack: src.pack,
        citationCount: folderCitationCount(src.pack, cited),
        elapsedMs: src.elapsedMs,
        startedAt,
        finishedAt,
        ...groundedContextAssemblyInput({ contextProfile: ctx.contextProfile }, src.pack),
      },
      {
        store: ctx.deps.evidenceStore,
        env: ctx.deps.env,
        additionalSecrets: currentRedactionSecrets(ctx.deps),
        costClassResolver: resolveCostClass,
        onRetentionDeleted: evidenceRetentionObserver("grounded-qa-hybrid"),
      },
    );
    firstRunId ??= runId;
    runIds.push(runId);
  }
  return { firstRunId, runIds };
}

interface CapsuleUsageSummary {
  readonly capsuleId: KnowledgeCapsuleId;
  readonly sourceIds: readonly KnowledgeSourceId[];
  readonly chunkIds: readonly string[];
  readonly referenceCount: number;
}

function summariseReferenceUsage(
  references: readonly RetrievalReference[],
): readonly CapsuleUsageSummary[] {
  const byCapsule = new Map<
    KnowledgeCapsuleId,
    { sourceIds: Set<KnowledgeSourceId>; chunkIds: Set<string>; referenceCount: number }
  >();
  for (const reference of references) {
    const current = byCapsule.get(reference.capsuleId) ?? {
      sourceIds: new Set<KnowledgeSourceId>(),
      chunkIds: new Set<string>(),
      referenceCount: 0,
    };
    current.sourceIds.add(reference.citation.sourceId);
    current.chunkIds.add(String(reference.chunkId));
    current.referenceCount += 1;
    byCapsule.set(reference.capsuleId, current);
  }
  return [...byCapsule.entries()]
    .sort(([a], [b]) => (String(a) < String(b) ? -1 : 1))
    .map(([capsuleId, value]) => ({
      capsuleId,
      sourceIds: [...value.sourceIds].sort((a, b) => (String(a) < String(b) ? -1 : 1)),
      chunkIds: [...value.chunkIds].sort((a, b) => a.localeCompare(b)),
      referenceCount: value.referenceCount,
    }));
}

function selectedConnectorReferences(
  selected: readonly SelectedCandidate<HybridPayload>[],
): readonly RetrievalReference[] {
  return selected
    .filter((s): s is SelectedCandidate<ConnectorPayload> => s.kind === "connector")
    .map((s) => s.payload.reference);
}

function emitRetrievalAuditForConnector(
  sink: ReturnType<typeof createSqliteAuditSink>,
  src: RetrievedConnector,
  occurredAt: number,
): void {
  const usage = summariseReferenceUsage(src.references);
  if (usage.length === 0) {
    for (const capsule of src.selected.capsules) {
      if (!capsuleAllowsEvidencePersistence(capsule)) continue;
      sink.emit({
        kind: "retrieval-performed",
        capsuleId: capsule.id,
        sourceIds: capsule.sourceIds,
        chunkIds: [],
        referenceCount: 0,
        noEvidence: true,
        occurredAt,
      });
    }
    return;
  }
  for (const entry of usage) {
    const capsule = src.selected.capsules.find(
      (item) => String(item.id) === String(entry.capsuleId),
    );
    if (!capsuleAllowsEvidencePersistence(capsule)) continue;
    sink.emit({
      kind: "retrieval-performed",
      capsuleId: entry.capsuleId,
      sourceIds: entry.sourceIds,
      chunkIds: entry.chunkIds,
      referenceCount: entry.referenceCount,
      noEvidence: false,
      occurredAt,
    });
  }
}

function emitAnswerContextAudit(
  sink: ReturnType<typeof createSqliteAuditSink>,
  store: KnowledgeStore,
  selected: readonly SelectedCandidate<HybridPayload>[],
  modelId: string,
  occurredAt: number,
): void {
  for (const entry of summariseReferenceUsage(selectedConnectorReferences(selected))) {
    if (!capsuleAllowsEvidencePersistence(getCapsule(store, entry.capsuleId))) continue;
    sink.emit({
      kind: "answer-context-assembled",
      capsuleId: entry.capsuleId,
      sourceIds: entry.sourceIds,
      chunkIds: entry.chunkIds,
      referenceCount: entry.referenceCount,
      citationCount: entry.referenceCount,
      occurredAt,
    });
    sink.emit({
      kind: "model-context-sent",
      capsuleId: entry.capsuleId,
      sourceIds: entry.sourceIds,
      chunkIds: entry.chunkIds,
      referenceCount: entry.referenceCount,
      citationCount: entry.referenceCount,
      modelId,
      occurredAt,
    });
  }
}

function persistConnectorAudit(
  store: KnowledgeStore,
  connectors: readonly RetrievedConnector[],
  selected: readonly SelectedCandidate<HybridPayload>[],
  modelId: string,
): void {
  const sink = createSqliteAuditSink(store);
  const occurredAt = Date.now();
  for (const src of connectors) {
    emitRetrievalAuditForConnector(sink, src, occurredAt);
  }
  emitAnswerContextAudit(sink, store, selected, modelId, occurredAt);
}

function persistHybridEvidence(
  ctx: HybridGroundedAskCtx,
  sources: RetrievedSources,
  store: KnowledgeStore,
  selected: readonly SelectedCandidate<HybridPayload>[],
  cited: readonly SelectedCandidate<HybridPayload>[],
): Pick<HybridGroundedAnswer, "evidenceRunId" | "evidenceRunIds"> {
  const folder = persistFolderEvidence(ctx, sources.folders, cited);
  persistConnectorAudit(store, sources.connectors, selected, ctx.modelId);
  return { evidenceRunId: folder.firstRunId, evidenceRunIds: folder.runIds };
}

// ─── Assembly + public entry ──────────────────────────────────────────────────

interface RetrievedSources {
  readonly folders: readonly RetrievedFolder[];
  readonly connectors: readonly RetrievedConnector[];
  readonly skipped: readonly SkippedConnector[];
  readonly skippedFolders: readonly SkippedConnector[];
  readonly folderSourceCount: number;
  readonly connectorSourceCount: number;
}

interface HybridContextPackInput {
  readonly ctx: HybridGroundedAskCtx;
  readonly sources: RetrievedSources;
  readonly selected: readonly SelectedCandidate<HybridPayload>[];
  readonly limits: ReturnType<typeof currentGroundingLimits>;
  readonly assistant: GroundedAnswerResult;
  readonly knowledgeCitationCount: number;
  readonly reranker: GroundedRerankerDiagnostics;
}

function buildHybridContextPack(
  input: HybridContextPackInput,
  summary: GroundedAnswerContextPackSummary,
): HybridGroundedAnswer["contextPack"] {
  const { ctx, sources, selected, limits, assistant, knowledgeCitationCount, reranker } = input;
  const selectedConnectorCount = selected.filter((s) => s.kind === "connector").length;
  return {
    kind: "hybrid",
    folderSourceCount: sources.folderSourceCount,
    connectorSourceCount: sources.connectorSourceCount,
    folder: {
      ...summary,
      usage: {
        ...summary.usage,
        modelInputTokens: summary.usage.modelInputTokens + assistant.usage.promptTokens,
        modelOutputTokens: summary.usage.modelOutputTokens + assistant.usage.completionTokens,
      },
    },
    knowledge: knowledgeSummary(
      ctx.chat,
      sources.connectors,
      knowledgeCitationCount,
      selectedConnectorCount,
      limits.maxPromptReferences,
      reranker,
    ),
    reranker,
  };
}

function noEvidenceUncertainty(
  selected: readonly SelectedCandidate<HybridPayload>[],
  redactor: Redactor,
  nowMs: number,
): readonly GroundedUncertainty[] {
  // KEIKO-0196: share the marker with the folder/multi-source topologies via
  // noEvidenceMarker, so the "no-evidence" claim text is the same in every grounding
  // topology (and the UncertaintyMarker's emittedAtMs is honestly attributed rather than
  // fabricated in-place).
  return selected.length === 0
    ? [
        {
          ...noEvidenceMarker(nowMs),
          claim: redactString(redactor, noEvidenceMarker(nowMs).claim),
        },
      ]
    : [];
}

// Assembles the hybrid answer's uncertainty markers: per-source pack markers, skipped-source
// notices, empty-selection no-evidence, and citation reconciliation (RB-4). Split out to keep
// assembleHybridAnswer under the LOC bound.
function hybridAnswerUncertainty(
  sources: RetrievedSources,
  selected: readonly SelectedCandidate<HybridPayload>[],
  assistant: GroundedAnswerResult,
  redactor: Redactor,
  nowMs: number,
  correlationId: string | undefined,
): readonly GroundedUncertainty[] {
  return [
    ...folderUncertainty(sources.folders, redactor),
    ...skippedUncertainty(sources.skippedFolders, redactor),
    ...skippedUncertainty(sources.skipped, redactor),
    ...noEvidenceUncertainty(selected, redactor, nowMs),
    ...hybridReconciliationUncertainty(
      assistant,
      sources.folders,
      selected,
      redactor,
      true,
      correlationId,
    ),
  ];
}

function hybridAnswerContextPack(
  input: HybridContextPackInput & {
    readonly cited: readonly SelectedCandidate<HybridPayload>[];
  },
): HybridGroundedAnswer["contextPack"] {
  const { ctx, sources, cited } = input;
  const summary = folderSummary(sources.folders, cited, ctx.deps.redactor, {
    contextProfile: ctx.contextProfile,
  });
  return buildHybridContextPack(input, summary);
}

function hybridEvidenceForAnswer(
  ctx: HybridGroundedAskCtx,
  sources: RetrievedSources,
  store: KnowledgeStore,
  selected: readonly SelectedCandidate<HybridPayload>[],
  cited: readonly SelectedCandidate<HybridPayload>[],
  sourceEvidenceAvailable: boolean,
): Pick<HybridGroundedAnswer, "evidenceRunId" | "evidenceRunIds"> {
  if (sourceEvidenceAvailable) return persistHybridEvidence(ctx, sources, store, selected, cited);
  persistConnectorAudit(store, sources.connectors, [], ctx.modelId);
  return { evidenceRunIds: [] };
}

function hybridUncertaintyForAnswer(
  sources: RetrievedSources,
  selected: readonly SelectedCandidate<HybridPayload>[],
  assistant: GroundedAnswerResult,
  ctx: HybridGroundedAskCtx,
  sourceEvidenceAvailable: boolean,
  nowMs: number,
): readonly GroundedUncertainty[] {
  const { redactor } = ctx.deps;
  const { correlationId } = ctx;
  if (sourceEvidenceAvailable) {
    return hybridAnswerUncertainty(sources, selected, assistant, redactor, nowMs, correlationId);
  }
  return [
    ...folderUncertainty(sources.folders, redactor),
    ...skippedUncertainty(sources.skippedFolders, redactor),
    ...skippedUncertainty(sources.skipped, redactor),
    ...noEvidenceUncertainty(selected, redactor, nowMs),
    ...hybridReconciliationUncertainty(
      assistant,
      sources.folders,
      selected,
      redactor,
      sourceEvidenceAvailable,
      correlationId,
    ),
  ];
}

function projectHybridAnswer(
  ctx: HybridGroundedAskCtx,
  sources: RetrievedSources,
  store: KnowledgeStore,
  selected: readonly SelectedCandidate<HybridPayload>[],
  assistant: GroundedAnswerResult,
  reranker: GroundedRerankerDiagnostics,
  sourceEvidenceAvailable: boolean,
): {
  readonly cited: readonly SelectedCandidate<HybridPayload>[];
  readonly citations: readonly GroundedEvidenceCitation[];
  readonly knowledgeCitations: readonly LocalKnowledgeEvidenceCitation[];
  readonly retrievalActivity: HybridGroundedAnswer["retrievalActivity"];
  readonly evidence: Pick<HybridGroundedAnswer, "evidenceRunId" | "evidenceRunIds">;
  readonly uncertainty: readonly GroundedUncertainty[];
} {
  const cited = citedHybridSelections(selected, assistant.content);
  const citations = selectedFolderCitations(cited, ctx.deps.redactor);
  const knowledgeCitations = selectedConnectorCitations(store, cited, ctx.deps.redactor);
  const retrievalActivity = buildHybridRetrievalActivity(
    store,
    sources.connectors,
    sources.skipped,
    knowledgeCitations,
    reranker,
    ctx.deps.diagnostics,
  );
  return {
    cited,
    citations,
    knowledgeCitations,
    retrievalActivity,
    evidence: hybridEvidenceForAnswer(
      ctx,
      sources,
      store,
      selected,
      cited,
      sourceEvidenceAvailable,
    ),
    uncertainty: hybridUncertaintyForAnswer(
      sources,
      selected,
      assistant,
      ctx,
      sourceEvidenceAvailable,
      Date.now(),
    ),
  };
}

interface AssembleHybridAnswerInput {
  readonly ctx: HybridGroundedAskCtx;
  readonly sources: RetrievedSources;
  readonly store: KnowledgeStore;
  readonly selected: readonly SelectedCandidate<HybridPayload>[];
  readonly limits: ReturnType<typeof currentGroundingLimits>;
  readonly assistant: GroundedAnswerResult;
  readonly reranker: GroundedRerankerDiagnostics;
  readonly ids: { readonly userMessageId: string; readonly assistantMessageId: string };
  readonly sourceEvidenceAvailable?: boolean;
  /** Candidates before the window fit; defaults to `selected.length` (nothing trimmed). */
  readonly availableReferenceCount?: number;
}

// The context meter's view of a hybrid prompt: the exact system and user messages the answerer sent
// (the same pure builder over the same selected candidates) and the same prompt without candidates
// (grounded-prompt-context.ts). The selected set is already capped, so every candidate is sent.
function hybridPromptContext(
  ctx: HybridGroundedAskCtx,
  selected: readonly SelectedCandidate<HybridPayload>[],
  assistant: GroundedAnswerResult,
  availableReferenceCount: number,
): GroundedPromptContextWire {
  const question = ctx.answerContent ?? ctx.content;
  const { redactor } = ctx.deps;
  const system = { role: "system" as const, content: HYBRID_SYSTEM_PROMPT };
  return sentPromptContext(
    {
      messages: [
        system,
        {
          role: "user",
          content: buildRerankedHybridUserMessage(
            question,
            selected,
            redactor,
            ctx.folderOmissionMetadata,
          ),
        },
      ],
      withoutSources: [
        system,
        {
          role: "user",
          content: buildRerankedHybridUserMessage(
            question,
            [],
            redactor,
            ctx.folderOmissionMetadata,
          ),
        },
      ],
      sentReferenceCount: selected.length,
      availableReferenceCount,
    },
    assistant.usage.promptTokens,
    currentContextProfileForModel(ctx.deps, ctx.modelId),
  );
}

function totalFolderOmissions(folders: readonly RetrievedFolder[]): number {
  return folders.reduce((total, source) => total + connectedContextOmittedCount(source.pack), 0);
}

function assembleHybridAnswer(
  input: AssembleHybridAnswerInput,
): HybridGroundedAnswer & Pick<GroundedAnswer, "promptContext"> {
  const {
    ctx,
    sources,
    store,
    selected,
    limits,
    assistant,
    reranker,
    ids,
    sourceEvidenceAvailable = true,
  } = input;
  const { redactor } = ctx.deps;
  const projection = projectHybridAnswer(
    ctx,
    sources,
    store,
    selected,
    assistant,
    reranker,
    sourceEvidenceAvailable,
  );
  const elapsedMs = sources.folders.reduce((acc, src) => acc + src.elapsedMs, 0);
  return {
    groundingKind: "hybrid",
    ...ids,
    ...projection.evidence,
    content: redactString(redactor, assistant.content),
    answerKind: assistant.answerKind,
    ...(assistant.citationBehaviour === undefined
      ? {}
      : { citationBehaviour: assistant.citationBehaviour }),
    ...(assistant.insufficiencyDeclarations === undefined
      ? {}
      : { insufficiencyDeclarations: assistant.insufficiencyDeclarations }),
    citations: projection.citations,
    knowledgeCitations: projection.knowledgeCitations,
    uncertainty: projection.uncertainty,
    omittedCount: totalFolderOmissions(sources.folders),
    elapsedMs,
    retrievalActivity: projection.retrievalActivity,
    contextPack: hybridAnswerContextPack({
      ctx,
      sources,
      selected,
      cited: projection.cited,
      limits,
      assistant,
      knowledgeCitationCount: projection.knowledgeCitations.length,
      reranker,
    }),
    ...hybridPromptContextField(input),
  };
}

// A deterministic abstention sends no prompt and reports none. An answer-only request (governed
// memory context, no source evidence) does call the model, so its prompt is reported like every
// other grounded request (PR #3678 review).
function hybridPromptContextField(
  input: AssembleHybridAnswerInput,
): Pick<GroundedAnswer, "promptContext"> {
  const modelInvoked =
    input.sourceEvidenceAvailable !== false || input.ctx.answerOnlyContextAvailable === true;
  if (!modelInvoked) return {};
  const available = input.availableReferenceCount ?? input.selected.length;
  return {
    promptContext: hybridPromptContext(input.ctx, input.selected, input.assistant, available),
  };
}

interface ResolvedAnswerer {
  readonly answer: HybridAnswerer;
}

interface AnswerMeta {
  readonly folderScopeCount: number;
  readonly connectorScopeCount: number;
  readonly folderResult: FolderRetrieval;
  readonly connectorResult: ConnectorRetrieval;
}

function resolveHybridAnswerer(ctx: HybridGroundedAskCtx): ResolvedAnswerer | RouteResult {
  if (ctx.answer !== undefined) return { answer: ctx.answer };
  const readinessAdmission =
    ctx.readinessAdmission ?? captureConversationReadinessAdmission(ctx.deps, ctx.modelId);
  if ("status" in readinessAdmission) return readinessAdmission;
  const resolvedModel = ctx.deps.modelPortFactory(ctx.modelId);
  if (resolvedModel === undefined) {
    return { status: 400, body: errorBody("NO_MODEL", "No model provider is configured.") };
  }
  const model = withConversationReadinessAdmission(
    resolvedModel,
    ctx.modelId,
    readinessAdmission,
    ctx.deps,
  );
  return { answer: createHybridAnswerer(model, ctx.modelId, ctx.signal, ctx.correlationId) };
}

async function noEvidenceAssistant(
  ctx: HybridGroundedAskCtx,
  selected: readonly SelectedCandidate<HybridPayload>[],
): Promise<
  | { readonly assistant: GroundedAnswerResult; readonly promptCtx: HybridGroundedAskCtx }
  | RouteResult
> {
  ensureNotCancelled(ctx.signal);
  if (ctx.answerOnlyContextAvailable !== true) {
    // Share the localized deterministic search outcome with folder and multi-source paths.
    return {
      assistant: {
        content: connectedSearchNoEvidenceAnswer(ctx.content),
        answerKind: "refusal",
        usage: { promptTokens: 0, completionTokens: 0 },
      },
      promptCtx: ctx,
    };
  }
  const answerer = resolveHybridAnswerer(ctx);
  if ("status" in answerer) return answerer;
  const { assistant, promptCtx } = await answerHybridWithinWindow(ctx, answerer, selected);
  ensureNotCancelled(ctx.signal);
  return { assistant, promptCtx };
}

function noEvidenceSources(meta: AnswerMeta): RetrievedSources {
  return {
    folders: meta.folderResult.retrieved,
    connectors: meta.connectorResult.retrieved,
    skipped: meta.connectorResult.skipped,
    skippedFolders: meta.folderResult.skipped,
    folderSourceCount: meta.folderScopeCount,
    connectorSourceCount: meta.connectorScopeCount,
  };
}

async function assembleHybridNoEvidenceRoute(
  ctx: HybridGroundedAskCtx,
  store: KnowledgeStore,
  meta: AnswerMeta,
  selected: readonly SelectedCandidate<HybridPayload>[],
  limits: ReturnType<typeof currentGroundingLimits>,
  reranker: GroundedRerankerDiagnostics,
): Promise<RouteResult> {
  const outcome = await noEvidenceAssistant(ctx, selected);
  if ("status" in outcome) return outcome;
  const { assistant, promptCtx } = outcome;
  ensureNotCancelled(ctx.signal);
  const content = redactString(ctx.deps.redactor, assistant.content);
  ensureNotCancelled(ctx.signal);
  const [userMessage, assistantMessage] = persistGroundedExchange(
    ctx.deps,
    ctx.chat.id,
    redactString(ctx.deps.redactor, ctx.content),
    content,
    ctx.userMessage,
  );
  const answer = assembleHybridAnswer({
    ctx: promptCtx,
    sources: noEvidenceSources(meta),
    store,
    selected,
    limits,
    assistant: { ...assistant, content },
    reranker,
    ids: { userMessageId: userMessage.id, assistantMessageId: assistantMessage.id },
    sourceEvidenceAvailable: false,
  });
  const finalAnswer =
    ctx.answerOnlyContextAvailable === true
      ? await applyHybridEntailment(
          ctx,
          answer,
          assistant.content,
          meta.folderResult.retrieved,
          meta.connectorResult.retrieved,
          selected,
        )
      : answer;
  ensureNotCancelled(ctx.signal);
  const previewCitations = selectedConnectorPreviewCitations(store, selected, ctx.deps.redactor);
  const completedAnswer = withHybridAnswerDuration(finalAnswer, ctx);
  ctx.deps.store.attachGroundedAnswer(assistantMessage.id, completedAnswer, previewCitations);
  return { status: 200, body: completedAnswer };
}

function withHybridAnswerDuration(
  answer: HybridGroundedAnswer,
  ctx: HybridGroundedAskCtx,
): HybridGroundedAnswer {
  const elapsedMs = Math.max(0, Date.now() - (ctx.startedAtMs ?? Date.now()));
  return {
    ...answer,
    elapsedMs,
    contextPack: {
      ...answer.contextPack,
      folder: { ...answer.contextPack.folder, elapsedMs },
    },
  };
}

export async function runHybridGroundedAsk(ctx: HybridGroundedAskCtx): Promise<RouteResult> {
  const startedAtMs = Date.now();
  const env = openStoreForDeps(ctx.deps);
  try {
    return await runHybridWithStore({ ...ctx, startedAtMs }, env.store, env.vectorIndex);
  } catch (error) {
    if (ctx.signal.aborted) {
      return { status: 499, body: errorBody("CANCELLED", "Grounded request was cancelled.") };
    }
    return mapHybridError(error, ctx.deps, ctx.correlationId);
  } finally {
    env.close();
  }
}

interface CappedSources {
  readonly folderScopes: readonly ChatConnectedScope[];
  readonly connectorScopes: readonly ChatLocalKnowledgeScope[];
  readonly allFolderCount: number;
  readonly allConnectorCount: number;
  readonly overCapFolderSkipped: readonly SkippedConnector[];
  readonly overCapConnectorSkipped: readonly SkippedConnector[];
}

interface CapCandidate {
  readonly kind: "folder" | "connector";
  readonly index: number;
  readonly connectedAtMs: number;
}

function combinedSourceCap(limits: ReturnType<typeof currentGroundingLimits>): number {
  return Math.max(limits.maxConnectedSources, limits.maxLocalKnowledgeSources);
}

function combinedSourceCandidates(
  folders: readonly ChatConnectedScope[],
  connectors: readonly ChatLocalKnowledgeScope[],
): readonly CapCandidate[] {
  return [
    ...folders.map((scope, index): CapCandidate => ({
      kind: "folder",
      index,
      connectedAtMs: scope.connectedAtMs,
    })),
    ...connectors.map((scope, index): CapCandidate => ({
      kind: "connector",
      index,
      connectedAtMs: scope.connectedAtMs,
    })),
  ].sort((a, b) => {
    if (a.connectedAtMs !== b.connectedAtMs) return a.connectedAtMs - b.connectedAtMs;
    if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
    return a.index - b.index;
  });
}

function capSelectedIndexes(
  folders: readonly ChatConnectedScope[],
  connectors: readonly ChatLocalKnowledgeScope[],
  totalCap: number,
): { readonly folderIndexes: ReadonlySet<number>; readonly connectorIndexes: ReadonlySet<number> } {
  const selected = combinedSourceCandidates(folders, connectors).slice(0, totalCap);
  return {
    folderIndexes: new Set(
      selected
        .filter((candidate) => candidate.kind === "folder")
        .map((candidate) => candidate.index),
    ),
    connectorIndexes: new Set(
      selected
        .filter((candidate) => candidate.kind === "connector")
        .map((candidate) => candidate.index),
    ),
  };
}

function skippedFoldersForCaps(
  all: readonly ChatConnectedScope[],
  perListFolders: readonly ChatConnectedScope[],
  selected: { readonly folderIndexes: ReadonlySet<number> },
  limits: ReturnType<typeof currentGroundingLimits>,
): readonly SkippedConnector[] {
  return [
    ...perListFolders.flatMap((cs, index): readonly SkippedConnector[] =>
      selected.folderIndexes.has(index)
        ? []
        : [
            {
              label: sourceLabels([cs])[0] ?? `folder-${String(index)}`,
              reason: "source-skipped",
              message: "Exceeded combined source limit.",
            },
          ],
    ),
    ...all.slice(limits.maxConnectedSources).map((cs, i): SkippedConnector => ({
      label: sourceLabels([cs])[0] ?? `folder-${String(limits.maxConnectedSources + i)}`,
      reason: "source-skipped",
      message: "Exceeded maxConnectedSources limit.",
    })),
  ];
}

function skippedConnectorsForCaps(
  allConnectors: readonly ChatLocalKnowledgeScope[],
  perListConnectors: readonly ChatLocalKnowledgeScope[],
  selected: { readonly connectorIndexes: ReadonlySet<number> },
  limits: ReturnType<typeof currentGroundingLimits>,
): readonly SkippedConnector[] {
  return [
    ...perListConnectors.flatMap((_cs, index): readonly SkippedConnector[] =>
      selected.connectorIndexes.has(index)
        ? []
        : [
            {
              label: `connector-${String(index)}`,
              reason: "source-skipped",
              message: "Exceeded combined source limit.",
            },
          ],
    ),
    ...allConnectors.slice(limits.maxLocalKnowledgeSources).map((_cs, i): SkippedConnector => ({
      label: `connector-${String(limits.maxLocalKnowledgeSources + i)}`,
      reason: "source-skipped",
      message: "Exceeded maxLocalKnowledgeSources limit.",
    })),
  ];
}

// Cap both source lists at their respective operator limits before any budget-split or retrieval
// loop, then cap the combined total to the release contract ("up to 16 sources" total by default).
// A chat row may carry legacy over-limit sources (e.g. operator lowered a limit after connection,
// or a direct DB edit). Capping here is the single choke-point: all loops downstream derive their
// iteration counts from these sliced lists. Over-cap entries are tagged as "source-skipped"
// uncertainties so callers can observe the omission without path information.
function capSourcesToLimits(
  ctx: HybridGroundedAskCtx,
  limits: ReturnType<typeof currentGroundingLimits>,
): CappedSources {
  const all = buildConnectedScopes(ctx.chat);
  const allConnectors = buildLocalKnowledgeScopes(ctx.chat);
  const perListFolders = all.slice(0, limits.maxConnectedSources);
  const perListConnectors = allConnectors.slice(0, limits.maxLocalKnowledgeSources);
  const selected = capSelectedIndexes(perListFolders, perListConnectors, combinedSourceCap(limits));
  return {
    folderScopes: perListFolders.filter((_scope, index) => selected.folderIndexes.has(index)),
    connectorScopes: perListConnectors.filter((_scope, index) =>
      selected.connectorIndexes.has(index),
    ),
    allFolderCount: all.length,
    allConnectorCount: allConnectors.length,
    overCapFolderSkipped: skippedFoldersForCaps(all, perListFolders, selected, limits),
    overCapConnectorSkipped: skippedConnectorsForCaps(
      allConnectors,
      perListConnectors,
      selected,
      limits,
    ),
  };
}

async function retrieveHybridSources(
  ctx: HybridGroundedAskCtx,
  store: KnowledgeStore,
  vectorIndex: VectorIndexOptions,
  capped: CappedSources,
  resolved: readonly SelectedLocalKnowledgeScope[],
  query: RetrievalQuery,
): Promise<{
  readonly folderResult: FolderRetrieval;
  readonly connectorResult: ConnectorRetrieval | RouteResult;
}> {
  let folderResult: FolderRetrieval | undefined;
  let connectorResult: ConnectorRetrieval | RouteResult | undefined;
  await mapWithConcurrency(
    ["folders", "connectors"] as const,
    2,
    async (kind, _index, signal) => {
      const child = { ...ctx, signal };
      if (kind === "folders") {
        folderResult = await retrieveFolderPacks(
          child,
          capped.folderScopes,
          query,
          ctx.folderRetriever ?? defaultRetriever(signal, ctx.deps, ctx.correlationId),
        );
      } else {
        connectorResult = await retrieveConnectors(
          child,
          store,
          vectorIndex,
          capped.connectorScopes,
          resolved,
        );
      }
    },
    ctx.signal,
  );
  if (folderResult === undefined || connectorResult === undefined)
    throw new TypeError("Hybrid retrieval did not settle both source kinds");
  return { folderResult, connectorResult };
}

async function runHybridWithStore(
  ctx: HybridGroundedAskCtx,
  store: KnowledgeStore,
  vectorIndex: VectorIndexOptions,
): Promise<RouteResult> {
  const limits = currentGroundingLimits(ctx.deps);
  const capped = capSourcesToLimits(ctx, limits);
  const resolved = resolveConnectorScopes(capped.connectorScopes, store);
  if ("status" in resolved) return resolved;
  const query = buildQuery(ctx.retrievalContent ?? ctx.content, () => Date.now());
  const { folderResult: rawFolderResult, connectorResult } = await retrieveHybridSources(
    ctx,
    store,
    vectorIndex,
    capped,
    resolved,
    query,
  );
  ensureNotCancelled(ctx.signal);
  // Merge upfront-skipped folders (inaccessible/denied at canonicalization), over-cap folder skips,
  // and retrieval-time folder skips so all omissions appear in the assembled uncertainty entries.
  const folderResult: FolderRetrieval = {
    ...rawFolderResult,
    skipped: [
      ...(ctx.preSkippedFolders ?? []),
      ...capped.overCapFolderSkipped,
      ...rawFolderResult.skipped,
    ],
  };
  if ("status" in connectorResult) return connectorResult;
  const connectorResultWithOverCap: ConnectorRetrieval =
    capped.overCapConnectorSkipped.length > 0
      ? {
          ...connectorResult,
          skipped: [...capped.overCapConnectorSkipped, ...connectorResult.skipped],
        }
      : connectorResult;
  const answerCtx = {
    ...ctx,
    folderOmissionMetadata: folderOmissionMetadata(folderResult.retrieved, ctx.deps.redactor),
    folderOmissionPacks: folderResult.retrieved,
  };
  return await answerAndAssemble(answerCtx, store, {
    folderScopeCount: capped.allFolderCount,
    connectorScopeCount: capped.allConnectorCount,
    folderResult,
    connectorResult: connectorResultWithOverCap,
  });
}

function folderOmissionMetadata(
  folders: readonly RetrievedFolder[],
  redactor: Redactor,
  pathByteLimit?: number,
): readonly string[] {
  return folders.flatMap((source) => {
    const reasons = [
      ...omissionReasonLines(source.pack),
      ...sizeExclusionLines(source.pack, redactor, pathByteLimit),
    ];
    return reasons.length === 0
      ? []
      : [`Folder source: ${redactString(redactor, source.label)}`, ...reasons];
  });
}

async function selectHybridPromptCandidates(
  ctx: HybridGroundedAskCtx,
  store: KnowledgeStore,
  folders: readonly RetrievedFolder[],
  connectors: readonly RetrievedConnector[],
  limits: ReturnType<typeof currentGroundingLimits>,
): Promise<HybridRerankedSelection> {
  const externalRerankingDenied = connectorsDenyExternalReranking(connectors);
  const preliminary = buildUnifiedSelection(
    ctx,
    folders,
    connectors,
    store,
    !externalRerankingDenied,
  );
  // The external reranker below scores every preliminary candidate's TEXT, so any candidate whose
  // hydration connectorRerankInput deferred to a cheap byte estimate must be filled in first —
  // hydrateConnectorSelection is a no-op for candidates that were already eagerly hydrated. The
  // policy-denied path skips this: it never calls the external reranker, so hydration stays
  // deferred until the final prompt-sized `selected` below (unchanged from before).
  const rerankable = externalRerankingDenied
    ? preliminary
    : hydrateConnectorSelections(store, preliminary, ctx.deps.redactor, limits.maxExcerptChars);
  const { selected, diagnostics } = await rerankHybridSelection(
    ctx,
    rerankable,
    limits,
    externalRerankingDenied,
  );
  ensureNotCancelled(ctx.signal);
  return {
    selected: externalRerankingDenied
      ? hydrateConnectorSelections(store, selected, ctx.deps.redactor, limits.maxExcerptChars)
      : selected,
    diagnostics,
  };
}

async function answerAndAssemble(
  ctx: HybridGroundedAskCtx,
  store: KnowledgeStore,
  meta: AnswerMeta,
): Promise<RouteResult> {
  const limits = currentGroundingLimits(ctx.deps);
  const { retrieved: folders } = meta.folderResult;
  const connectors = meta.connectorResult.retrieved;
  const { selected, diagnostics: reranker } = await selectHybridPromptCandidates(
    ctx,
    store,
    folders,
    connectors,
    limits,
  );
  ensureNotCancelled(ctx.signal);
  if (selected.length === 0) {
    return await assembleHybridNoEvidenceRoute(ctx, store, meta, selected, limits, reranker);
  }
  const answerer = resolveHybridAnswerer(ctx);
  if ("status" in answerer) return answerer;
  const { assistant, sent, promptCtx } = await answerHybridWithinWindow(ctx, answerer, selected);
  ensureNotCancelled(ctx.signal);
  const [userMessage, assistantMessage] = persistHybridGroundedExchange(ctx, assistant.content);
  // Citations and the prompt share follow the candidates the model was actually shown.
  return finalizeHybridAnswer(promptCtx, store, meta, {
    selected: sent,
    availableReferenceCount: selected.length,
    limits,
    assistant,
    reranker,
    ids: { userMessageId: userMessage.id, assistantMessageId: assistantMessage.id },
  });
}

function hybridPromptMessages(
  ctx: HybridGroundedAskCtx,
  selected: readonly SelectedCandidate<HybridPayload>[],
): readonly GatewayChatMessage[] {
  return [
    { role: "system", content: HYBRID_SYSTEM_PROMPT },
    {
      role: "user",
      content: buildRerankedHybridUserMessage(
        ctx.answerContent ?? ctx.content,
        selected,
        ctx.deps.redactor,
        ctx.folderOmissionMetadata,
      ),
    },
  ];
}

function hybridContextWithinWindow(
  ctx: HybridGroundedAskCtx,
  selected: readonly SelectedCandidate<HybridPayload>[],
): HybridGroundedAskCtx {
  const profile = currentContextProfileForModel(ctx.deps, ctx.modelId);
  if (profile === undefined || ctx.folderOmissionPacks === undefined) return ctx;
  const tokens = (messages: readonly GatewayChatMessage[]): number =>
    countGatewayPromptTokens({ messages }, profile.tokenAccounting);
  if (tokens(hybridPromptMessages(ctx, selected)) <= profile.effectiveInputBudget) return ctx;
  const withMetadata = (bytes: number): HybridGroundedAskCtx => ({
    ...ctx,
    folderOmissionMetadata: folderOmissionMetadata(
      ctx.folderOmissionPacks ?? [],
      ctx.deps.redactor,
      bytes,
    ),
  });
  const fitted = fitPromptOmissionMetadata(
    (bytes) => hybridPromptMessages(withMetadata(bytes), selected),
    (messages) => tokens(messages) <= profile.effectiveInputBudget,
    modelInputPromptByteLimit(profile.effectiveInputBudget),
  );
  const promptCtx = withMetadata(fitted?.omissionPathBytes ?? 0);
  if (fitted !== undefined)
    logPromptWindowFit(
      {
        state: "trimmed",
        referenceCount: selected.length,
        sentReferenceCount: selected.length,
        promptTokens: tokens(fitted.messages),
        inputBudget: profile.effectiveInputBudget,
      },
      ctx.correlationId,
    );
  return promptCtx;
}

// The highest-ranked candidates whose prompt fits the model's current input budget. Candidates keep
// their markers, so a prefix keeps `[1]..[n]` consistent with the citations derived from it.
function hybridCandidatesWithinWindow(
  ctx: HybridGroundedAskCtx,
  selected: readonly SelectedCandidate<HybridPayload>[],
): readonly SelectedCandidate<HybridPayload>[] {
  const question = ctx.answerContent ?? ctx.content;
  const render = (count: number): GatewayPromptTokenInput => ({
    messages: [
      { role: "system", content: HYBRID_SYSTEM_PROMPT },
      {
        role: "user",
        content: buildRerankedHybridUserMessage(
          question,
          selected.slice(0, count),
          ctx.deps.redactor,
          ctx.folderOmissionMetadata,
        ),
      },
    ],
  });
  const fitted = fitKnowledgePrompt(
    selected.length,
    render,
    currentContextProfileForModel(ctx.deps, ctx.modelId),
    { correlationId: ctx.correlationId, diagnostics: ctx.deps.diagnostics },
  );
  return selected.slice(0, fitted.referenceCount);
}

// Like the folder, multi-source and Knowledge Pod answerers: each attempt fits the candidates to the
// model's current input budget, and a provider overflow that states the real window re-fits and
// sends once more (withAdoptedContextWindowRetry, PR #3678 review).
async function answerHybridWithinWindow(
  ctx: HybridGroundedAskCtx,
  answerer: ResolvedAnswerer,
  selected: readonly SelectedCandidate<HybridPayload>[],
): Promise<{
  readonly assistant: GroundedAnswerResult;
  readonly sent: readonly SelectedCandidate<HybridPayload>[];
  readonly promptCtx: HybridGroundedAskCtx;
}> {
  let sent = selected;
  let promptCtx = ctx;
  const assistant = await withAdoptedContextWindowRetry(
    ctx.deps,
    { modelId: ctx.modelId, surface: "grounded", correlationId: ctx.correlationId },
    async () => {
      promptCtx = hybridContextWithinWindow(ctx, selected);
      sent = hybridCandidatesWithinWindow(promptCtx, selected);
      const user = buildRerankedHybridUserMessage(
        ctx.answerContent ?? ctx.content,
        sent,
        ctx.deps.redactor,
        promptCtx.folderOmissionMetadata,
      );
      return normalizeGroundedAnswerPayload(await answerer.answer(HYBRID_SYSTEM_PROMPT, user));
    },
  );
  const evidenceScopeIndex = buildInsufficiencyScopeIndex(
    sentFolderPacks(promptCtx.folderOmissionPacks ?? [], sent),
    ctx.insufficiencyScopeIndex,
  );
  return {
    assistant: {
      ...assistant,
      insufficiencyDeclarations: undefined,
      evidenceScopeIndex,
      ...validateGroundedAnswerEvidence(assistant.content, evidenceScopeIndex, ctx.content),
    },
    sent,
    promptCtx,
  };
}

interface HybridFinalizeInput {
  readonly selected: readonly SelectedCandidate<HybridPayload>[];
  /** Candidates selected before the window fit; more than `selected` means the window trimmed. */
  readonly availableReferenceCount: number;
  readonly limits: ReturnType<typeof currentGroundingLimits>;
  readonly assistant: GroundedAnswerResult;
  readonly reranker: GroundedRerankerDiagnostics;
  readonly ids: { readonly userMessageId: string; readonly assistantMessageId: string };
}

// Assemble the hybrid answer, judge its selected folder and connector evidence (#2563, #2947), and
// attach the result. Extracted from answerAndAssemble to keep both functions under the LOC bound.
async function finalizeHybridAnswer(
  ctx: HybridGroundedAskCtx,
  store: KnowledgeStore,
  meta: AnswerMeta,
  input: HybridFinalizeInput,
): Promise<RouteResult> {
  const { selected, availableReferenceCount, limits, assistant, reranker, ids } = input;
  const folders = meta.folderResult.retrieved;
  const answer = assembleHybridAnswer({
    ctx,
    sources: {
      folders,
      connectors: meta.connectorResult.retrieved,
      skipped: meta.connectorResult.skipped,
      skippedFolders: meta.folderResult.skipped,
      folderSourceCount: meta.folderScopeCount,
      connectorSourceCount: meta.connectorScopeCount,
    },
    store,
    selected,
    availableReferenceCount,
    limits,
    assistant,
    reranker,
    ids,
  });
  const finalAnswer = await applyHybridEntailment(
    ctx,
    answer,
    assistant.content,
    folders,
    meta.connectorResult.retrieved,
    selected,
  );
  ensureNotCancelled(ctx.signal);
  const previewCitations = selectedConnectorPreviewCitations(store, selected, ctx.deps.redactor);
  const completedAnswer = withHybridAnswerDuration(finalAnswer, ctx);
  ctx.deps.store.attachGroundedAnswer(ids.assistantMessageId, completedAnswer, previewCitations);
  return { status: 200, body: completedAnswer };
}

function persistHybridGroundedExchange(
  ctx: HybridGroundedAskCtx,
  assistantContent: string,
): readonly [ChatMessage, ChatMessage] {
  return persistGroundedExchange(
    ctx.deps,
    ctx.chat.id,
    redactString(ctx.deps.redactor, ctx.content),
    redactString(ctx.deps.redactor, assistantContent),
    ctx.userMessage,
  );
}

// Expected domain failures retain their canonical mapping. Unexpected failures reach the shared
// route boundary with their original cause, which emits body-free diagnostics and an opaque 500.
function mapHybridError(
  error: unknown,
  deps: UiHandlerDeps,
  correlationId: string | undefined,
): RouteResult {
  const gatewayResult = mappedGatewayError(error, deps, correlationId);
  if (gatewayResult !== undefined) return gatewayResult;
  // GRD-016: mirror the single-source and multi-source paths — a vague/no-anchor question
  // (ClarificationNeededError) or a typed workspace read error is a client-actionable 400, not
  // an opaque 500. Without these branches a folders+connectors ask with no anchors 500s.
  if (error instanceof ClarificationNeededError) {
    return clarificationRequest(clarificationUserMessage(error));
  }
  const workspaceResult = mappedWorkspaceError(error, { correlationId });
  if (workspaceResult !== undefined) return workspaceResult;
  throw error;
}
