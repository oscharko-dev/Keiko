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
  readCitationExcerpt,
  runLocalKnowledgeRetrieval,
  type KnowledgeStore,
  type RetrievalResult,
} from "@oscharko-dev/keiko-local-knowledge";
import type { RetrievalReference } from "@oscharko-dev/keiko-contracts";

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
  type GroundedUncertainty,
  type HybridGroundedAnswer,
  type LocalKnowledgeEvidenceCitation,
  type LocalKnowledgeGroundedAnswerContextSummary,
} from "@oscharko-dev/keiko-contracts/bff-wire";

import { redact } from "@oscharko-dev/keiko-security";

import type { RouteResult } from "./routes.js";
import { errorBody } from "./routes.js";
import type { Redactor, UiHandlerDeps } from "./deps.js";
import { currentRedactionSecrets } from "./deps.js";
import type { Chat } from "./store/index.js";
import { type RetrievalOnlyOutput } from "./grounded-orchestrator.js";
import {
  buildConnectedScopes,
  defaultRetriever,
  mergeContextPackSummaries,
  sourceLabels,
  splitExplorationBudget,
  type GroundedRetriever,
} from "./grounded-qa-multi-source.js";
import {
  DEFAULT_REFERENCE_BUDGET,
  MAX_EXCERPT_CHARS,
  MAX_PROMPT_REFERENCES,
  buildSelectedScopeSourceLookup,
  createEmbeddingAdapter,
  openStoreForDeps,
  renderCitationLabel,
  projectLocalKnowledgeCitation,
  scopeStateFailure,
  selectedCapsulesForScope,
  type SelectedLocalKnowledgeScope,
} from "./local-knowledge-grounded-qa.js";
import { GROUNDED_SYSTEM_PROMPT } from "./grounded-prompt.js";
import {
  normalizeGroundedAnswerPayload,
  type GroundedAnswerPayload,
  type GroundedAnswerResult,
} from "./grounded-answer.js";
import {
  buildCitations,
  buildQuery,
  buildSelectedScopeFrom,
  deriveScopeIdFrom,
  ensureNotCancelled,
  evidenceLines,
  internalError,
  isValidGroundedPack,
  mappedGatewayError,
  persistGroundedExchange,
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
  readonly deps: UiHandlerDeps;
  readonly signal: AbortSignal;
  readonly folderRetriever?: FolderRetriever;
  readonly connectorRetrieve?: ConnectorRetrieve;
  readonly answer?: HybridAnswerer;
}

// ─── Retrieved-source records ─────────────────────────────────────────────────

interface RetrievedFolder {
  readonly label: string;
  readonly pack: ConnectedContextPack;
  readonly elapsedMs: number;
  readonly scope: SelectedScope;
}

interface RetrievedConnector {
  readonly label: string;
  readonly selected: SelectedLocalKnowledgeScope;
  readonly references: readonly RetrievalReference[];
}

interface SkippedConnector {
  readonly label: string;
  readonly reason: string;
  readonly message: string;
}

interface ConnectorRetrieval {
  readonly retrieved: readonly RetrievedConnector[];
  readonly skipped: readonly SkippedConnector[];
}

// ─── Folder retrieval (mirrors runMultiSourceAsk's loop) ──────────────────────

async function retrieveFolderPacks(
  ctx: HybridGroundedAskCtx,
  folderScopes: readonly ChatConnectedScope[],
  query: RetrievalQuery,
  retriever: FolderRetriever,
): Promise<readonly RetrievedFolder[] | RouteResult> {
  const labels = sourceLabels(folderScopes);
  const budget = splitExplorationBudget(DEFAULT_EXPLORATION_BUDGET, folderScopes.length);
  const retrieved: RetrievedFolder[] = [];
  for (let i = 0; i < folderScopes.length; i += 1) {
    ensureNotCancelled(ctx.signal);
    const cs = folderScopes[i];
    const label = labels[i];
    if (cs === undefined || label === undefined) continue;
    const scope = buildSelectedScopeFrom(ctx.chat, cs, deriveScopeIdFrom(ctx.chat, cs, i));
    const out: RetrievalOnlyOutput = await retriever({
      scope,
      query,
      workspaceRoot: scope.workspaceRoot,
      budget,
    });
    if (!isValidGroundedPack(out.pack)) {
      return internalError("Grounded answer context pack failed validation.");
    }
    retrieved.push({ label, pack: out.pack, elapsedMs: out.elapsedMs, scope });
  }
  return retrieved;
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

function distinctEmbeddingModelIds(selected: SelectedLocalKnowledgeScope): readonly string[] {
  return Array.from(
    new Set(selected.capsules.map((capsule) => capsule.embeddingModelIdentity.modelId)),
  );
}

function connectorQuery(scope: ChatLocalKnowledgeScope, content: string): RetrievalQueryShape {
  return {
    text: content,
    topK: MAX_PROMPT_REFERENCES,
    ...(scope.kind === "capsule" ? { capsuleId: scope.capsuleId } : {}),
    ...(scope.kind === "capsule-set" ? { capsuleSetId: scope.capsuleSetId } : {}),
  };
}

type RetrievalQueryShape = Parameters<typeof runLocalKnowledgeRetrieval>[1];

function defaultConnectorRetrieve(ctx: HybridGroundedAskCtx): ConnectorRetrieve {
  return async (store, scope, selected): Promise<RetrievalResult> => {
    const embeddingAdapter = createEmbeddingAdapter(ctx.deps, distinctEmbeddingModelIds(selected));
    if ("status" in embeddingAdapter) {
      throw new EmbeddingAdapterError(embeddingAdapter);
    }
    return runLocalKnowledgeRetrieval(
      { store, embeddingAdapter, signal: ctx.signal },
      connectorQuery(scope, ctx.content),
    );
  };
}

class EmbeddingAdapterError extends Error {
  public constructor(public readonly result: RouteResult) {
    super("embedding adapter unavailable");
    this.name = "EmbeddingAdapterError";
  }
}

async function retrieveConnectors(
  ctx: HybridGroundedAskCtx,
  store: KnowledgeStore,
  connectorScopes: readonly ChatLocalKnowledgeScope[],
  resolved: readonly SelectedLocalKnowledgeScope[],
): Promise<ConnectorRetrieval | RouteResult> {
  const retrieve = ctx.connectorRetrieve ?? defaultConnectorRetrieve(ctx);
  const labels = connectorLabels(resolved.map((s) => s.scopeLabel));
  const retrieved: RetrievedConnector[] = [];
  const skipped: SkippedConnector[] = [];
  for (let i = 0; i < connectorScopes.length; i += 1) {
    ensureNotCancelled(ctx.signal);
    const scope = connectorScopes[i];
    const selected = resolved[i];
    const label = labels[i];
    if (scope === undefined || selected === undefined || label === undefined) continue;
    const failure = scopeStateFailure(selected);
    if (failure !== undefined) {
      skipped.push({ label, reason: failure.reason, message: failure.message });
      continue;
    }
    const outcome = await retrieveOneConnector(retrieve, store, scope, selected);
    if ("status" in outcome) return outcome;
    retrieved.push({ label, selected, references: outcome.references });
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

const HYBRID_SYSTEM_PROMPT =
  `${GROUNDED_SYSTEM_PROMPT} Connector excerpts are indexed-document citations: attribute every ` +
  "connector claim to its source label and the matching [n] marker in addition to any file reference.";

function folderSections(
  folders: readonly RetrievedFolder[],
  redactor: Redactor,
): readonly string[] {
  return folders.flatMap((src, index) => [
    `### Folder source ${String(index + 1)}: ${src.label}`,
    "Repository evidence excerpts:",
    ...evidenceLines(src.pack, redactor),
    "",
  ]);
}

function connectorSections(
  connectors: readonly RetrievedConnector[],
  store: KnowledgeStore,
): readonly string[] {
  return connectors.flatMap((src, index) => [
    `### Connector source ${String(index + 1)}: ${src.label}`,
    ...connectorReferenceLines(src.references, store),
    "",
  ]);
}

function connectorReferenceLines(
  references: readonly RetrievalReference[],
  store: KnowledgeStore,
): readonly string[] {
  const lines: string[] = [];
  const used = references.slice(0, MAX_PROMPT_REFERENCES);
  for (let i = 0; i < used.length; i += 1) {
    const reference = used[i];
    if (reference === undefined) continue;
    lines.push(`[${String(i + 1)}] ${renderCitationLabel(reference.citation)}`);
    const excerpt = readCitationExcerpt(
      store,
      reference.capsuleId,
      reference.citation,
      MAX_EXCERPT_CHARS,
    );
    lines.push("```text", excerpt.length > 0 ? excerpt : "(No excerpt text available.)", "```");
  }
  return lines;
}

function buildHybridUserMessage(
  question: string,
  folders: readonly RetrievedFolder[],
  connectors: readonly RetrievedConnector[],
  store: KnowledgeStore,
  redactor: Redactor,
): string {
  return [
    "User question:",
    redactString(redactor, question),
    "",
    `Connected sources: ${String(folders.length)} folder(s), ${String(connectors.length)} connector(s).`,
    "Attribute every claim to its source label and evidence/citation marker.",
    "",
    ...folderSections(folders, redactor),
    ...connectorSections(connectors, store),
  ].join("\n");
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
    return {
      content: content.length > 0 ? content : "The model returned an empty response.",
      usage: {
        promptTokens: response.usage.promptTokens,
        completionTokens: response.usage.completionTokens,
      },
    };
  };
}

// ─── Citations + summaries ────────────────────────────────────────────────────

function mergedFolderCitations(
  folders: readonly RetrievedFolder[],
  redactor: Redactor,
): readonly GroundedEvidenceCitation[] {
  const citations = folders.flatMap((src) =>
    buildCitations(src.pack, redactor).map((c) => ({ ...c, source: src.label })),
  );
  return [...citations].sort((a, b) => b.score - a.score);
}

function mergedConnectorCitations(
  connectors: readonly RetrievedConnector[],
  store: KnowledgeStore,
): readonly LocalKnowledgeEvidenceCitation[] {
  return connectors.flatMap((src) =>
    src.references.slice(0, MAX_PROMPT_REFERENCES).map((reference, i) =>
      projectLocalKnowledgeCitation(
        reference,
        `[${String(i + 1)}]`,
        buildSelectedScopeSourceLookup(store, src.selected),
      ),
    ),
  );
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
): GroundedAnswerContextPackSummary {
  if (folders.length === 0) return emptyFolderSummary();
  return mergeContextPackSummaries(
    folders.map((src) =>
      buildGroundedAnswerContextPackSummary(
        src.pack,
        buildCitations(src.pack, redactor).length,
        src.elapsedMs,
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
function knowledgeSummary(
  chat: Chat,
  connectors: readonly RetrievedConnector[],
  citationCount: number,
): LocalKnowledgeGroundedAnswerContextSummary {
  const capsuleCount = connectors.reduce((acc, src) => acc + src.selected.capsules.length, 0);
  const referencesUsed = connectors.reduce(
    (acc, src) => acc + Math.min(src.references.length, MAX_PROMPT_REFERENCES),
    0,
  );
  const label = connectors.map((src) => src.label).join("+");
  const scopeKind = connectors.length === 1 ? connectors[0]?.selected.scopeKind : "capsule-set";
  return {
    kind: "local-knowledge",
    scopeKind: scopeKind ?? "capsule-set",
    scopeId: `lk-${hashString32(`${chat.id}|${label}`)}`,
    scopeLabel: label,
    capsuleCount,
    sourceCount: connectorSourceCount(connectors),
    citationCount,
    referenceBudget: DEFAULT_REFERENCE_BUDGET,
    referencesUsed,
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

// ─── Evidence persistence ─────────────────────────────────────────────────────

// Persists ONE evidence run per folder source (mirrors the #532 per-source persist) plus the
// connector retrieval/answer-context audit via the LK sink (mirrors the single-connector path).
// Returns the first folder run id, surfaced as the answer's primary evidenceRunId.
function persistFolderEvidence(
  ctx: HybridGroundedAskCtx,
  folders: readonly RetrievedFolder[],
): string | undefined {
  let firstRunId: string | undefined;
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
        pack: src.pack,
        citationCount: buildCitations(src.pack, ctx.deps.redactor).length,
        elapsedMs: src.elapsedMs,
        startedAt,
        finishedAt,
      },
      {
        store: ctx.deps.evidenceStore,
        env: ctx.deps.env,
        additionalSecrets: currentRedactionSecrets(ctx.deps),
        costClassResolver: resolveCostClass,
      },
    );
    firstRunId ??= runId;
  }
  return firstRunId;
}

function persistConnectorAudit(
  store: KnowledgeStore,
  connectors: readonly RetrievedConnector[],
): void {
  const sink = createSqliteAuditSink(store);
  const occurredAt = Date.now();
  for (const src of connectors) {
    for (const capsule of src.selected.capsules) {
      sink.emit({
        kind: "retrieval-performed",
        capsuleId: capsule.id,
        sourceIds: capsule.sourceIds,
        chunkIds: src.references.map((reference) => String(reference.chunkId)),
        referenceCount: src.references.length,
        noEvidence: src.references.length === 0,
        occurredAt,
      });
    }
  }
}

// ─── Assembly + public entry ──────────────────────────────────────────────────

interface RetrievedSources {
  readonly folders: readonly RetrievedFolder[];
  readonly connectors: readonly RetrievedConnector[];
  readonly skipped: readonly SkippedConnector[];
  readonly folderSourceCount: number;
  readonly connectorSourceCount: number;
}

function assembleHybridAnswer(
  ctx: HybridGroundedAskCtx,
  sources: RetrievedSources,
  store: KnowledgeStore,
  assistant: GroundedAnswerResult,
  ids: { readonly userMessageId: string; readonly assistantMessageId: string },
): HybridGroundedAnswer {
  const { redactor } = ctx.deps;
  const citations = mergedFolderCitations(sources.folders, redactor);
  const knowledgeCitations = mergedConnectorCitations(sources.connectors, store);
  const evidenceRunId = persistFolderEvidence(ctx, sources.folders);
  persistConnectorAudit(store, sources.connectors);
  const elapsedMs = sources.folders.reduce((acc, src) => acc + src.elapsedMs, 0);
  const summary = folderSummary(sources.folders, redactor);
  return {
    groundingKind: "hybrid",
    ...ids,
    evidenceRunId,
    content: redactString(redactor, assistant.content),
    citations,
    knowledgeCitations,
    uncertainty: [
      ...folderUncertainty(sources.folders, redactor),
      ...skippedUncertainty(sources.skipped, redactor),
    ],
    omittedCount: sources.folders.reduce((acc, src) => acc + src.pack.omitted.length, 0),
    elapsedMs,
    contextPack: {
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
      knowledge: knowledgeSummary(ctx.chat, sources.connectors, knowledgeCitations.length),
    },
  };
}

interface ResolvedAnswerer {
  readonly answer: HybridAnswerer;
}

function resolveHybridAnswerer(ctx: HybridGroundedAskCtx): ResolvedAnswerer | RouteResult {
  if (ctx.answer !== undefined) return { answer: ctx.answer };
  const model = ctx.deps.modelPortFactory(ctx.modelId);
  if (model === undefined) {
    return { status: 400, body: errorBody("NO_MODEL", "No model provider is configured.") };
  }
  return { answer: createHybridAnswerer(model, ctx.modelId, ctx.signal) };
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

async function runHybridWithStore(
  ctx: HybridGroundedAskCtx,
  store: KnowledgeStore,
): Promise<RouteResult> {
  const folderScopes = buildConnectedScopes(ctx.chat);
  const connectorScopes = buildLocalKnowledgeScopes(ctx.chat);
  const resolved = resolveConnectorScopes(connectorScopes, store);
  if ("status" in resolved) return resolved;
  const query = buildQuery(ctx.content, () => Date.now());
  const folders = await retrieveFolderPacks(
    ctx,
    folderScopes,
    query,
    ctx.folderRetriever ?? defaultRetriever(ctx.signal),
  );
  if (isRouteResult(folders)) return folders;
  const connectorResult = await retrieveConnectors(ctx, store, connectorScopes, resolved);
  if ("status" in connectorResult) return connectorResult;
  return await answerAndAssemble(ctx, store, folders, {
    folderScopeCount: folderScopes.length,
    connectorScopeCount: connectorScopes.length,
    connectorResult,
  });
}

function isRouteResult(value: readonly RetrievedFolder[] | RouteResult): value is RouteResult {
  return !Array.isArray(value);
}

async function answerAndAssemble(
  ctx: HybridGroundedAskCtx,
  store: KnowledgeStore,
  folders: readonly RetrievedFolder[],
  meta: {
    readonly folderScopeCount: number;
    readonly connectorScopeCount: number;
    readonly connectorResult: ConnectorRetrieval;
  },
): Promise<RouteResult> {
  const answerer = resolveHybridAnswerer(ctx);
  if ("status" in answerer) return answerer;
  const user = buildHybridUserMessage(
    ctx.content,
    folders,
    meta.connectorResult.retrieved,
    store,
    ctx.deps.redactor,
  );
  const assistant = normalizeGroundedAnswerPayload(
    await answerer.answer(HYBRID_SYSTEM_PROMPT, user),
  );
  const [userMessage, assistantMessage] = persistGroundedExchange(
    ctx.deps,
    ctx.chat.id,
    redactString(ctx.deps.redactor, ctx.content),
    redactString(ctx.deps.redactor, assistant.content),
  );
  const answer = assembleHybridAnswer(
    ctx,
    {
      folders,
      connectors: meta.connectorResult.retrieved,
      skipped: meta.connectorResult.skipped,
      folderSourceCount: meta.folderScopeCount,
      connectorSourceCount: meta.connectorScopeCount,
    },
    store,
    assistant,
    { userMessageId: userMessage.id, assistantMessageId: assistantMessage.id },
  );
  return { status: 200, body: answer };
}

// Issue #154 (GAP-B) — a GatewayError is redacted inside mappedGatewayError (shared with the
// single-source path). The non-gateway `Error` fallback carries an arbitrary dynamic message that
// can echo a provider endpoint or token, so it is scrubbed through the SAME boundary before it
// reaches the wire.
function mapHybridError(error: unknown, deps: UiHandlerDeps): RouteResult {
  const gatewayResult = mappedGatewayError(error, deps);
  if (gatewayResult !== undefined) return gatewayResult;
  if (error instanceof Error) {
    return internalError(redact(error.message, currentRedactionSecrets(deps)));
  }
  throw error;
}
