// Epic #189 Slice 2 — heterogeneous grounded merge. A chat may carry BOTH connected folders
// (#532, lexical) AND Local Knowledge connectors (#189, vector), or two or more connectors. Asking
// one question must retrieve from EVERY source and return ONE merged grounded answer with
// source-tagged citations from both engines. This module owns that merge branch only; the
// folders-only (#532) and single-connector (#189) paths are untouched so their wire output stays
// byte-identical (AC). It composes the exported folder helpers (grounded-qa-multi-source.ts) and
// connector seams (local-knowledge-grounded-qa.ts) without re-implementing retrieval.

import { randomUUID } from "node:crypto";
import { resolveCostClass } from "@oscharko-dev/keiko-model-gateway";
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
} from "@oscharko-dev/keiko-local-knowledge";
import type {
  KnowledgeCapsule,
  KnowledgeCapsuleId,
  KnowledgeSourceId,
  RetrievalReference,
} from "@oscharko-dev/keiko-contracts";
import {
  applyModelRerankResults,
  rerankAndSelect,
  selectTopPromptCandidates,
  type RerankInput,
  type SelectedCandidate,
} from "./grounded-rerank.js";

import {
  CANDIDATE_OMISSION_REASONS,
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  DEFAULT_EXPLORATION_BUDGET,
  type CandidateOmissionReason,
  type ConnectedContextPack,
  type RetrievalQuery,
  type SelectedScope,
} from "@oscharko-dev/keiko-contracts/connected-context";
import {
  buildGroundedAnswerContextPackSummary,
  type ChatConnectedScope,
  type ChatLocalKnowledgeScope,
  type GroundedAnswerContextPackSummary,
  type GroundedEvidenceCitation,
  type GroundedRerankerDiagnostics,
  type GroundedUncertainty,
  type HybridGroundedAnswer,
  type LocalKnowledgeEvidenceCitation,
  type LocalKnowledgeGroundedAnswerContextSummary,
} from "@oscharko-dev/keiko-contracts/bff-wire";

import { redact } from "@oscharko-dev/keiko-security";

import type { RouteResult } from "./routes.js";
import { errorBody } from "./routes.js";
import type { Redactor, UiHandlerDeps } from "./deps.js";
import { currentGroundingLimits, currentRedactionSecrets } from "./deps.js";
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
  sourceLabels,
  splitExplorationBudget,
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
import {
  normalizeGroundedAnswerPayload,
  type GroundedAnswerPayload,
  type GroundedAnswerResult,
} from "./grounded-answer.js";
import {
  buildPackCitationIndex,
  incompleteAnswerMarker,
  reconcileInlineCitations,
  unsupportedCitationMarker,
} from "./grounded-faithfulness.js";
import { assertUsableAssistantContent } from "./assistant-response.js";
import { requestConfiguredRerank } from "./grounded-model-reranker.js";
import { buildLocalKnowledgeIndexLifecycle } from "./local-knowledge-index-lifecycle.js";
import {
  buildCitations,
  buildQuery,
  buildSelectedScopeFrom,
  clarificationRequest,
  deriveScopeIdFrom,
  ensureNotCancelled,
  groundedContextAssemblyInput,
  groundedContextSummaryInput,
  internalError,
  isValidGroundedPack,
  mappedGatewayError,
  mappedWorkspaceError,
  persistGroundedExchange,
  promptSafeExcerptText,
  redactString,
} from "./grounded-qa.js";

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

export type FolderRetriever = GroundedRetriever;
export type ConnectorRetrieve = (
  store: KnowledgeStore,
  scope: ChatLocalKnowledgeScope,
  selected: SelectedLocalKnowledgeScope,
) => Promise<RetrievalResult>;
export type HybridAnswerer = (system: string, user: string) => Promise<GroundedAnswerPayload>;

export interface HybridGroundedAskCtx {
  readonly chat: Chat;
  readonly content: string;
  readonly modelId: string;
  readonly contextProfile: UiHandlerDeps["contextProfile"];
  readonly deps: UiHandlerDeps;
  readonly signal: AbortSignal;
  readonly folderRetriever?: FolderRetriever;
  readonly connectorRetrieve?: ConnectorRetrieve;
  readonly answer?: HybridAnswerer;
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
function isConnectorCandidate(
  candidate: SelectedCandidate<HybridPayload>,
): candidate is SelectedCandidate<ConnectorPayload> {
  return candidate.kind === "connector";
}

function folderRerankInputs(
  folders: readonly RetrievedFolder[],
  redactor: Redactor,
): RerankInput<HybridPayload>[] {
  return folders.flatMap((src) =>
    src.pack.files.flatMap((file) =>
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
        },
      })),
    ),
  );
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
    return src.references.map((reference) => ({
      kind: "connector" as const,
      redactedText: includeExcerptText
        ? connectorRedactedText(store, reference, redactor, maxExcerptChars)
        : "",
      engineScore: reference.score,
      sourceLabel: redactString(redactor, src.label),
      tieKey: String(reference.chunkId),
      payload: { kind: "connector" as const, reference, lookup },
    }));
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
  if (!isConnectorCandidate(candidate)) return candidate;
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

function withKeptCount(
  diagnostics: GroundedRerankerDiagnostics,
  keptCount: number,
): GroundedRerankerDiagnostics {
  return { ...diagnostics, keptCount };
}

function invalidRerankMappingDiagnostics(
  diagnostics: GroundedRerankerDiagnostics,
  keptCount: number,
): GroundedRerankerDiagnostics {
  return {
    ...diagnostics,
    status: "invalid-response",
    failureKind: "invalid-response",
    keptCount,
  };
}

function policyDeniedRerankDiagnostics(
  candidateCount: number,
  keptCount: number,
): GroundedRerankerDiagnostics {
  return {
    status: "denied",
    mode: "local-only",
    candidateCount,
    documentCount: 0,
    keptCount,
    failureKind: "policy-denied",
    latencyMs: 0,
  };
}

async function rerankHybridSelection(
  ctx: HybridGroundedAskCtx,
  preliminary: readonly SelectedCandidate<HybridPayload>[],
  limits: ReturnType<typeof currentGroundingLimits>,
  externalRerankingDenied: boolean,
): Promise<HybridRerankedSelection> {
  const fallback = selectTopPromptCandidates(preliminary, limits.maxPromptReferences);
  if (externalRerankingDenied) {
    return {
      selected: fallback,
      diagnostics: policyDeniedRerankDiagnostics(preliminary.length, fallback.length),
    };
  }
  const attempt = await requestConfiguredRerank({
    deps: ctx.deps,
    query: ctx.content,
    documents: preliminary.map((candidate) => candidate.redactedText),
    topN: limits.maxPromptReferences,
    signal: ctx.signal,
  });
  if (attempt.outcome === undefined) {
    return { selected: fallback, diagnostics: withKeptCount(attempt.diagnostics, fallback.length) };
  }
  const reranked = applyModelRerankResults(
    preliminary,
    attempt.outcome.value.results,
    limits.maxPromptReferences,
  );
  if (reranked === undefined) {
    return {
      selected: fallback,
      diagnostics: invalidRerankMappingDiagnostics(attempt.diagnostics, fallback.length),
    };
  }
  return { selected: reranked, diagnostics: withKeptCount(attempt.diagnostics, reranked.length) };
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

async function retrieveFolderPacks(
  ctx: HybridGroundedAskCtx,
  folderScopes: readonly ChatConnectedScope[],
  query: RetrievalQuery,
  retriever: FolderRetriever,
): Promise<FolderRetrieval> {
  const labels = sourceLabels(folderScopes);
  const budget = splitExplorationBudget(DEFAULT_EXPLORATION_BUDGET, folderScopes.length);
  const retrieved: RetrievedFolder[] = [];
  const skipped: SkippedConnector[] = [];
  for (let i = 0; i < folderScopes.length; i += 1) {
    ensureNotCancelled(ctx.signal);
    const cs = folderScopes[i];
    const label = labels[i];
    if (cs === undefined || label === undefined) continue;
    const scope = buildSelectedScopeFrom(ctx.chat, cs, deriveScopeIdFrom(ctx.chat, cs, i));
    let out: RetrievalOnlyOutput;
    try {
      out = await retriever({
        scope,
        query,
        workspaceRoot: scope.workspaceRoot,
        budget,
      });
    } catch (error) {
      // Mirror retrieveOneConnector (GRD-006): a per-source embedding-adapter outage is a skippable
      // degradation (answer from the remaining sources, record the skip). EVERY other error MUST
      // propagate — ClarificationNeededError -> 400, ProviderError -> 502, generic -> 500 — so the
      // boundary maps and redacts it instead of silently dropping a folder and returning a
      // misleadingly "complete" answer.
      if (error instanceof EmbeddingAdapterError) {
        skipped.push({
          label,
          reason: "embedding-unavailable",
          message: "Embedding adapter unavailable.",
        });
        continue;
      }
      throw error;
    }
    if (!isValidGroundedPack(out.pack)) {
      skipped.push({ label, reason: "pack-validation-failed", message: "Pack validation failed." });
      continue;
    }
    retrieved.push({ label, pack: out.pack, elapsedMs: out.elapsedMs, scope, plan: out.plan });
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

function connectorQuery(scope: ChatLocalKnowledgeScope, content: string): RetrievalQueryShape {
  return {
    text: content,
    topK: LOCAL_KNOWLEDGE_RETRIEVAL_CANDIDATES,
    ...(scope.kind === "capsule" ? { capsuleId: scope.capsuleId } : {}),
    ...(scope.kind === "capsule-set" ? { capsuleSetId: scope.capsuleSetId } : {}),
  };
}

type RetrievalQueryShape = Parameters<typeof runLocalKnowledgeRetrieval>[1];

function defaultConnectorRetrieve(ctx: HybridGroundedAskCtx): ConnectorRetrieve {
  return async (store, scope, _selected): Promise<RetrievalResult> => {
    const embeddingAdapter = createEmbeddingAdapter(ctx.deps);
    if ("status" in embeddingAdapter) {
      throw new EmbeddingAdapterError(embeddingAdapter);
    }
    return runLocalKnowledgeRetrieval(
      { store, embeddingAdapter, signal: ctx.signal },
      connectorQuery(scope, ctx.content),
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
  const outcome = await retrieveOneConnector(retrieve, store, inputs.scope, inputs.selected);
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
  connectorScopes: readonly ChatLocalKnowledgeScope[],
  resolved: readonly SelectedLocalKnowledgeScope[],
): Promise<ConnectorRetrieval | RouteResult> {
  const retrieve = ctx.connectorRetrieve ?? defaultConnectorRetrieve(ctx);
  const labels = connectorLabels(resolved.map((s) => s.scopeLabel));
  // Index-addressed slots keep the emitted order identical to the scope order regardless of
  // which worker finishes first — evidence and labels stay deterministic.
  const slots: ConnectorSlot[] = new Array<ConnectorSlot>(connectorScopes.length).fill(undefined);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < connectorScopes.length) {
      const i = nextIndex;
      nextIndex += 1;
      ensureNotCancelled(ctx.signal);
      const scope = connectorScopes[i];
      const selected = resolved[i];
      const label = labels[i];
      if (scope === undefined || selected === undefined || label === undefined) continue;
      slots[i] = await retrieveConnectorIntoSlot(retrieve, store, {
        scope,
        selected,
        label,
      });
    }
  };
  const workerCount = Math.min(MAX_CONNECTOR_RETRIEVAL_CONCURRENCY, connectorScopes.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
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
): Promise<RetrievalResult | RouteResult> {
  try {
    return await retrieve(store, scope, selected);
  } catch (error) {
    if (error instanceof EmbeddingAdapterError) return error.result;
    throw error;
  }
}

// ─── Merged prompt ────────────────────────────────────────────────────────────

const HYBRID_NO_EVIDENCE_ANSWER = "No evidence found in the selected connected sources.";
const HYBRID_SYSTEM_PROMPT =
  `${GROUNDED_SYSTEM_PROMPT} Connector excerpts are indexed-document citations: attribute every ` +
  "connector claim to its source label and the matching [n] marker in addition to any file reference.";

// Builds the user message from the SAME selected set used for citations. Each candidate gets a
// single global [n] marker that is consistent with the citation arrays. redactedText is
// already redacted — do NOT pass it through redactString again.
function buildRerankedHybridUserMessage(
  question: string,
  selected: readonly SelectedCandidate<HybridPayload>[],
  redactor: Redactor,
): string {
  const folderCount = selected.filter((s) => s.kind === "folder").length;
  const connectorCount = selected.filter((s) => s.kind === "connector").length;
  const lines: string[] = [
    "User question:",
    redactString(redactor, question),
    "",
    `Connected sources: ${String(folderCount)} folder(s), ${String(connectorCount)} connector(s).`,
    "Cite every claim by its [n] marker and source label.",
    "",
  ];
  for (const candidate of selected) {
    const kindLabel = candidate.kind === "folder" ? "Folder" : "Connector";
    lines.push(`[${String(candidate.marker)}] ### ${kindLabel} source: ${candidate.sourceLabel}`);
    lines.push("```text");
    lines.push(
      candidate.redactedText.length > 0
        ? promptSafeExcerptText(candidate.redactedText)
        : "(No excerpt text available.)",
    );
    lines.push("```");
    lines.push("");
  }
  return lines.join("\n");
}

export function createHybridAnswerer(
  model: ModelPort,
  modelId: string,
  signal: AbortSignal,
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
  redactor: Redactor,
  deps: Pick<UiHandlerDeps, "contextProfile">,
): GroundedAnswerContextPackSummary {
  if (folders.length === 0) return emptyFolderSummary();
  return mergeContextPackSummaries(
    folders.map((src) =>
      buildGroundedAnswerContextPackSummary(
        src.pack,
        buildCitations(src.pack, redactor).length,
        src.elapsedMs,
        groundedContextSummaryInput(deps, src.pack),
      ),
    ),
  );
}

function hashString32(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
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
  return {
    kind: "local-knowledge",
    scopeKind: scopeKind ?? "capsule-set",
    scopeId: `lk-${hashString32(`${chat.id}|${label}`)}`,
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

// GEN-AI-GROUNDING-001/-008 (RB-4): reconcile the hybrid answer's inline `[path:line]` citations
// against the FOLDER evidence packs the model actually received. Connector citations use marker
// labels rather than repo paths, so path-shaped inline references are validated against folder
// evidence (where the [path:line] format applies). Mirrors the single/multi-source reconciliation.
function hybridReconciliationUncertainty(
  assistant: GroundedAnswerResult,
  folders: readonly RetrievedFolder[],
  redactor: Redactor,
): readonly GroundedUncertainty[] {
  const nowMs = Date.now();
  const reconciliation = reconcileInlineCitations(
    assistant.content,
    buildPackCitationIndex(folders.map((f) => f.pack)),
  );
  const unsupported = unsupportedCitationMarker(reconciliation.unsupported, nowMs);
  const markers = [
    ...(unsupported === undefined ? [] : [unsupported]),
    ...(assistant.finishReason === "length" ? [incompleteAnswerMarker(nowMs)] : []),
  ];
  return markers.map((m) => ({ kind: m.kind, claim: redactString(redactor, m.claim) }));
}

// ─── Evidence persistence ─────────────────────────────────────────────────────

// Persists ONE evidence run per folder source (mirrors the #532 per-source persist) plus the
// connector retrieval/answer-context audit via the LK sink (mirrors the single-connector path).
// Returns the first folder run id, surfaced as the answer's primary evidenceRunId, plus the full
// folder evidence set so reviewers can inspect every connected-context source.
function persistFolderEvidence(
  ctx: HybridGroundedAskCtx,
  folders: readonly RetrievedFolder[],
): { readonly firstRunId: string | undefined; readonly runIds: readonly string[] } {
  let firstRunId: string | undefined;
  const runIds: string[] = [];
  for (const src of folders) {
    const finishedAt = Date.now();
    const startedAt = Math.max(0, finishedAt - src.elapsedMs);
    const runId = `grounded-${randomUUID()}`;
    persistConnectedContextEvidence(
      {
        runId,
        modelId: ctx.modelId,
        workspaceRoot: src.scope.workspaceRoot,
        chatId: ctx.chat.id,
        plan: src.plan,
        pack: src.pack,
        citationCount: buildCitations(src.pack, ctx.deps.redactor).length,
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
      chunkIds: [...value.chunkIds].sort(),
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

// ─── Assembly + public entry ──────────────────────────────────────────────────

interface RetrievedSources {
  readonly folders: readonly RetrievedFolder[];
  readonly connectors: readonly RetrievedConnector[];
  readonly skipped: readonly SkippedConnector[];
  readonly skippedFolders: readonly SkippedConnector[];
  readonly folderSourceCount: number;
  readonly connectorSourceCount: number;
}

function buildHybridContextPack(
  ctx: HybridGroundedAskCtx,
  sources: RetrievedSources,
  selected: readonly SelectedCandidate<HybridPayload>[],
  limits: ReturnType<typeof currentGroundingLimits>,
  summary: GroundedAnswerContextPackSummary,
  assistant: GroundedAnswerResult,
  knowledgeCitationCount: number,
  reranker: GroundedRerankerDiagnostics,
): HybridGroundedAnswer["contextPack"] {
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
): readonly GroundedUncertainty[] {
  return selected.length === 0
    ? [
        {
          kind: "no-evidence",
          claim: redactString(redactor, HYBRID_NO_EVIDENCE_ANSWER),
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
): readonly GroundedUncertainty[] {
  return [
    ...folderUncertainty(sources.folders, redactor),
    ...skippedUncertainty(sources.skippedFolders, redactor),
    ...skippedUncertainty(sources.skipped, redactor),
    ...noEvidenceUncertainty(selected, redactor),
    ...hybridReconciliationUncertainty(assistant, sources.folders, redactor),
  ];
}

function hybridAnswerContextPack(
  ctx: HybridGroundedAskCtx,
  sources: RetrievedSources,
  selected: readonly SelectedCandidate<HybridPayload>[],
  limits: ReturnType<typeof currentGroundingLimits>,
  assistant: GroundedAnswerResult,
  knowledgeCitationCount: number,
  reranker: GroundedRerankerDiagnostics,
): HybridGroundedAnswer["contextPack"] {
  const summary = folderSummary(sources.folders, ctx.deps.redactor, {
    contextProfile: ctx.contextProfile,
  });
  return buildHybridContextPack(
    ctx,
    sources,
    selected,
    limits,
    summary,
    assistant,
    knowledgeCitationCount,
    reranker,
  );
}

function assembleHybridAnswer(
  ctx: HybridGroundedAskCtx,
  sources: RetrievedSources,
  store: KnowledgeStore,
  selected: readonly SelectedCandidate<HybridPayload>[],
  limits: ReturnType<typeof currentGroundingLimits>,
  assistant: GroundedAnswerResult,
  reranker: GroundedRerankerDiagnostics,
  ids: { readonly userMessageId: string; readonly assistantMessageId: string },
): HybridGroundedAnswer {
  const { redactor } = ctx.deps;
  const citations = selectedFolderCitations(selected, redactor);
  const knowledgeCitations = selectedConnectorCitations(store, selected, redactor);
  const retrievalActivity = buildHybridRetrievalActivity(
    store,
    sources.connectors,
    sources.skipped,
    knowledgeCitations,
    reranker,
  );
  const { firstRunId: evidenceRunId, runIds: evidenceRunIds } = persistFolderEvidence(
    ctx,
    sources.folders,
  );
  persistConnectorAudit(store, sources.connectors, selected, ctx.modelId);
  const elapsedMs = sources.folders.reduce((acc, src) => acc + src.elapsedMs, 0);
  return {
    groundingKind: "hybrid",
    ...ids,
    evidenceRunId,
    evidenceRunIds,
    content: redactString(redactor, assistant.content),
    citations,
    knowledgeCitations,
    uncertainty: hybridAnswerUncertainty(sources, selected, assistant, redactor),
    omittedCount: sources.folders.reduce((acc, src) => acc + src.pack.omitted.length, 0),
    elapsedMs,
    retrievalActivity,
    contextPack: hybridAnswerContextPack(
      ctx,
      sources,
      selected,
      limits,
      assistant,
      knowledgeCitations.length,
      reranker,
    ),
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
  const model = ctx.deps.modelPortFactory(ctx.modelId);
  if (model === undefined) {
    return { status: 400, body: errorBody("NO_MODEL", "No model provider is configured.") };
  }
  return { answer: createHybridAnswerer(model, ctx.modelId, ctx.signal) };
}

function assembleHybridNoEvidenceRoute(
  ctx: HybridGroundedAskCtx,
  store: KnowledgeStore,
  meta: AnswerMeta,
  selected: readonly SelectedCandidate<HybridPayload>[],
  limits: ReturnType<typeof currentGroundingLimits>,
  reranker: GroundedRerankerDiagnostics,
): RouteResult {
  const content = redactString(ctx.deps.redactor, HYBRID_NO_EVIDENCE_ANSWER);
  const [userMessage, assistantMessage] = persistGroundedExchange(
    ctx.deps,
    ctx.chat.id,
    redactString(ctx.deps.redactor, ctx.content),
    content,
  );
  const answer = assembleHybridAnswer(
    ctx,
    {
      folders: meta.folderResult.retrieved,
      connectors: meta.connectorResult.retrieved,
      skipped: meta.connectorResult.skipped,
      skippedFolders: meta.folderResult.skipped,
      folderSourceCount: meta.folderScopeCount,
      connectorSourceCount: meta.connectorScopeCount,
    },
    store,
    selected,
    limits,
    { content, usage: { promptTokens: 0, completionTokens: 0 } },
    reranker,
    { userMessageId: userMessage.id, assistantMessageId: assistantMessage.id },
  );
  const previewCitations = selectedConnectorPreviewCitations(store, selected, ctx.deps.redactor);
  ctx.deps.store.attachGroundedAnswer(assistantMessage.id, answer, previewCitations);
  return { status: 200, body: answer };
}

export async function runHybridGroundedAsk(ctx: HybridGroundedAskCtx): Promise<RouteResult> {
  const env = openStoreForDeps(ctx.deps);
  try {
    return await runHybridWithStore(ctx, env.store);
  } catch (error) {
    return mapHybridError(error, ctx.deps);
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

async function runHybridWithStore(
  ctx: HybridGroundedAskCtx,
  store: KnowledgeStore,
): Promise<RouteResult> {
  const limits = currentGroundingLimits(ctx.deps);
  const capped = capSourcesToLimits(ctx, limits);
  const resolved = resolveConnectorScopes(capped.connectorScopes, store);
  if ("status" in resolved) return resolved;
  const query = buildQuery(ctx.content, () => Date.now());
  const [rawFolderResult, connectorResult] = await Promise.all([
    retrieveFolderPacks(
      ctx,
      capped.folderScopes,
      query,
      ctx.folderRetriever ?? defaultRetriever(ctx.signal, ctx.deps),
    ),
    retrieveConnectors(ctx, store, capped.connectorScopes, resolved),
  ]);
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
  return await answerAndAssemble(ctx, store, {
    folderScopeCount: capped.allFolderCount,
    connectorScopeCount: capped.allConnectorCount,
    folderResult,
    connectorResult: connectorResultWithOverCap,
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
  const { selected, diagnostics } = await rerankHybridSelection(
    ctx,
    preliminary,
    limits,
    externalRerankingDenied,
  );
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
  if (selected.length === 0) {
    return assembleHybridNoEvidenceRoute(ctx, store, meta, selected, limits, reranker);
  }
  const answerer = resolveHybridAnswerer(ctx);
  if ("status" in answerer) return answerer;
  const user = buildRerankedHybridUserMessage(ctx.content, selected, ctx.deps.redactor);
  const assistant = normalizeGroundedAnswerPayload(
    await answerer.answer(HYBRID_SYSTEM_PROMPT, user),
  );
  ensureNotCancelled(ctx.signal);
  const [userMessage, assistantMessage] = persistHybridGroundedExchange(ctx, assistant.content);
  const answer = assembleHybridAnswer(
    ctx,
    {
      folders,
      connectors: meta.connectorResult.retrieved,
      skipped: meta.connectorResult.skipped,
      skippedFolders: meta.folderResult.skipped,
      folderSourceCount: meta.folderScopeCount,
      connectorSourceCount: meta.connectorScopeCount,
    },
    store,
    selected,
    limits,
    assistant,
    reranker,
    { userMessageId: userMessage.id, assistantMessageId: assistantMessage.id },
  );
  const previewCitations = selectedConnectorPreviewCitations(store, selected, ctx.deps.redactor);
  ctx.deps.store.attachGroundedAnswer(assistantMessage.id, answer, previewCitations);
  return { status: 200, body: answer };
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
  );
}

// Issue #154 (GAP-B) — a GatewayError is redacted inside mappedGatewayError (shared with the
// single-source path). The non-gateway `Error` fallback carries an arbitrary dynamic message that
// can echo a provider endpoint or token, so it is scrubbed through the SAME boundary before it
// reaches the wire.
function mapHybridError(error: unknown, deps: UiHandlerDeps): RouteResult {
  const gatewayResult = mappedGatewayError(error, deps);
  if (gatewayResult !== undefined) return gatewayResult;
  // GRD-016: mirror the single-source and multi-source paths — a vague/no-anchor question
  // (ClarificationNeededError) or a typed workspace read error is a client-actionable 400, not
  // an opaque 500. Without these branches a folders+connectors ask with no anchors 500s.
  if (error instanceof ClarificationNeededError) {
    return clarificationRequest(clarificationUserMessage(error));
  }
  const workspaceResult = mappedWorkspaceError(error);
  if (workspaceResult !== undefined) return workspaceResult;
  if (error instanceof Error) {
    return internalError(redact(error.message, currentRedactionSecrets(deps)));
  }
  throw error;
}
