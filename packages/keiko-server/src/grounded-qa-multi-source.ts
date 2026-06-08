// Epic #532 — multi-source (1+N) grounded retrieval merge. A chat may connect N folders/files at
// once; asking one question must search EVERY connected source and return ONE merged answer with
// per-source attribution. This module owns the new branch only. The single-source path
// (`grounded-qa.ts`) is deliberately untouched so its wire output stays byte-identical (AC5).
//
// The path is split out of `grounded-qa.ts` to keep both files under the 400-LOC bound; it imports
// the shared formatters/projection/persistence helpers (now exported) so the two paths build their
// gateway messages, citations, and evidence from the exact same primitives.

import { basename } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  resolveCostClass,
  type ChatMessage as GatewayChatMessage,
} from "@oscharko-dev/keiko-model-gateway";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import { persistConnectedContextEvidence } from "@oscharko-dev/keiko-evidence";

import {
  CANDIDATE_OMISSION_REASONS,
  DEFAULT_EXPLORATION_BUDGET,
  type CandidateOmissionReason,
  type ConnectedContextPack,
  type ExplorationBudget,
  type RetrievalQuery,
  type SelectedScope,
} from "@oscharko-dev/keiko-contracts/connected-context";
import {
  buildGroundedAnswerContextPackSummary,
  type ChatConnectedScope,
  type GroundedAnswer,
  type GroundedAnswerContextPackSummary,
  type GroundedEvidenceCitation,
  type GroundedUncertainty,
} from "@oscharko-dev/keiko-contracts/bff-wire";

import type { RouteResult } from "./routes.js";
import type { Redactor, UiHandlerDeps } from "./deps.js";
import { currentRedactionSecrets } from "./deps.js";
import type { Chat } from "./store/index.js";
import {
  ClarificationNeededError,
  retrieveConnectedContextPack,
  type OrchestratorInput,
  type RetrievalOnlyOutput,
} from "./grounded-orchestrator.js";
import { microIndexForGroundedScope } from "./grounded-context-index.js";
import { GROUNDED_SYSTEM_PROMPT } from "./grounded-prompt.js";
import {
  badRequest,
  buildCitations,
  buildQuery,
  buildSelectedScopeFrom,
  deriveScopeIdFrom,
  ensureNotCancelled,
  evidenceLines,
  internalError,
  isValidGroundedPack,
  mappedGatewayError,
  packBudgetSummary,
  persistGroundedExchange,
  redactString,
  uncertaintyLines,
} from "./grounded-qa.js";

// ─── Canonical reader + label/budget helpers ──────────────────────────────────

// Canonical reader rule (Epic #532 contract): `connectedScopes` supersedes the legacy single
// `connectedScope`. Readers must NOT mix the two — the list, when present, is authoritative.
export function buildConnectedScopes(chat: Chat): readonly ChatConnectedScope[] {
  return chat.connectedScopes ?? (chat.connectedScope ? [chat.connectedScope] : []);
}

// Splits a base budget across n sources so total fan-out work stays bounded regardless of N.
// Per-source dimensions floor-divide with a Math.max(1, …) floor so a source is never starved to
// zero. `rerankCallsMax` is left UNCHANGED (it is 0 by default and is a per-source cap, not a
// shared pool). n=1 returns the base unchanged so the single path is unaffected if it ever routes
// through here.
export function splitExplorationBudget(base: ExplorationBudget, n: number): ExplorationBudget {
  if (n <= 1) return base;
  const split = (value: number): number => Math.max(1, Math.floor(value / n));
  return {
    searchCallsMax: split(base.searchCallsMax),
    filesReadMax: split(base.filesReadMax),
    excerptBytesMax: split(base.excerptBytesMax),
    modelInputTokensMax: split(base.modelInputTokensMax),
    modelOutputTokensMax: split(base.modelOutputTokensMax),
    elapsedMsMax: split(base.elapsedMsMax),
    rerankCallsMax: base.rerankCallsMax,
  };
}

function rawSourceLabel(cs: ChatConnectedScope): string {
  return cs.root === undefined ? "project" : basename(cs.root);
}

function labelDisambiguator(cs: ChatConnectedScope): string {
  const hash = createHash("sha256")
    .update(cs.root ?? "")
    .digest("hex");
  return `~${hash.slice(0, 6)}`;
}

// Human-readable per-source labels, stable in scopes order. Label = basename(root) or "project"
// when root is undefined. Duplicate labels are disambiguated by appending a short hash of the full
// root so two sources that share a basename remain distinguishable in citations.
export function sourceLabels(scopes: readonly ChatConnectedScope[]): readonly string[] {
  const counts = new Map<string, number>();
  for (const cs of scopes) {
    const raw = rawSourceLabel(cs);
    counts.set(raw, (counts.get(raw) ?? 0) + 1);
  }
  return scopes.map((cs) => {
    const raw = rawSourceLabel(cs);
    return (counts.get(raw) ?? 0) > 1 ? `${raw}${labelDisambiguator(cs)}` : raw;
  });
}

// ─── Merged context-pack summary ──────────────────────────────────────────────

function zeroOmittedCounts(): Record<CandidateOmissionReason, number> {
  const counts = {} as Record<CandidateOmissionReason, number>;
  for (const reason of CANDIDATE_OMISSION_REASONS) counts[reason] = 0;
  return counts;
}

function sumUsage(
  summaries: readonly GroundedAnswerContextPackSummary[],
): GroundedAnswerContextPackSummary["usage"] {
  return summaries.reduce<GroundedAnswerContextPackSummary["usage"]>(
    (acc, s) => ({
      searchCalls: acc.searchCalls + s.usage.searchCalls,
      filesRead: acc.filesRead + s.usage.filesRead,
      excerptBytes: acc.excerptBytes + s.usage.excerptBytes,
      modelInputTokens: acc.modelInputTokens + s.usage.modelInputTokens,
      modelOutputTokens: acc.modelOutputTokens + s.usage.modelOutputTokens,
      elapsedMs: acc.elapsedMs + s.usage.elapsedMs,
      rerankCalls: acc.rerankCalls + s.usage.rerankCalls,
    }),
    {
      searchCalls: 0,
      filesRead: 0,
      excerptBytes: 0,
      modelInputTokens: 0,
      modelOutputTokens: 0,
      elapsedMs: 0,
      rerankCalls: 0,
    },
  );
}

function sumBudget(
  summaries: readonly GroundedAnswerContextPackSummary[],
): GroundedAnswerContextPackSummary["budget"] {
  return summaries.reduce<GroundedAnswerContextPackSummary["budget"]>(
    (acc, s) => ({
      searchCallsMax: acc.searchCallsMax + s.budget.searchCallsMax,
      filesReadMax: acc.filesReadMax + s.budget.filesReadMax,
      excerptBytesMax: acc.excerptBytesMax + s.budget.excerptBytesMax,
      modelInputTokensMax: acc.modelInputTokensMax + s.budget.modelInputTokensMax,
      modelOutputTokensMax: acc.modelOutputTokensMax + s.budget.modelOutputTokensMax,
      elapsedMsMax: acc.elapsedMsMax + s.budget.elapsedMsMax,
      rerankCallsMax: acc.rerankCallsMax + s.budget.rerankCallsMax,
    }),
    {
      searchCallsMax: 0,
      filesReadMax: 0,
      excerptBytesMax: 0,
      modelInputTokensMax: 0,
      modelOutputTokensMax: 0,
      elapsedMsMax: 0,
      rerankCallsMax: 0,
    },
  );
}

function mergeOmittedCounts(
  summaries: readonly GroundedAnswerContextPackSummary[],
): Record<CandidateOmissionReason, number> {
  const merged = zeroOmittedCounts();
  for (const s of summaries) {
    for (const reason of CANDIDATE_OMISSION_REASONS) {
      merged[reason] += s.omittedCounts[reason];
    }
  }
  return merged;
}

// `fileCount` is -1 (the workspace-root sentinel) if ANY source is a workspace-root scope; else it
// is the sum of the per-source file counts. `scopeId` folds every source's display fingerprint into
// one deterministic id so the merged summary is stable for a given chat-scope binding.
function mergedFileCount(summaries: readonly GroundedAnswerContextPackSummary[]): number {
  if (summaries.some((s) => s.fileCount === -1)) return -1;
  return summaries.reduce((acc, s) => acc + s.fileCount, 0);
}

export function mergeContextPackSummaries(
  summaries: readonly GroundedAnswerContextPackSummary[],
): GroundedAnswerContextPackSummary {
  const [first] = summaries;
  if (first === undefined) {
    throw new Error("mergeContextPackSummaries requires at least one summary");
  }
  return {
    schemaVersion: first.schemaVersion,
    scopeId: `scope-${createHash("sha256")
      .update(summaries.map((s) => s.scopeId).join("|"))
      .digest("hex")
      .slice(0, 8)}`,
    scopeKind: first.scopeKind,
    fileCount: mergedFileCount(summaries),
    queryKind: first.queryKind,
    usage: sumUsage(summaries),
    budget: sumBudget(summaries),
    citationCount: summaries.reduce((acc, s) => acc + s.citationCount, 0),
    omittedCount: summaries.reduce((acc, s) => acc + s.omittedCount, 0),
    omittedCounts: mergeOmittedCounts(summaries),
    uncertaintyCount: summaries.reduce((acc, s) => acc + s.uncertaintyCount, 0),
    elapsedMs: summaries.reduce((acc, s) => acc + s.elapsedMs, 0),
  };
}

// ─── Multi-source gateway messages ────────────────────────────────────────────

export interface LabeledPack {
  readonly label: string;
  readonly pack: ConnectedContextPack;
}

function sourceSection(entry: LabeledPack, index: number, redactor: Redactor): readonly string[] {
  const { label, pack } = entry;
  return [
    `### Source ${String(index + 1)}: ${label}`,
    `- budget/usage: ${packBudgetSummary(pack)}`,
    `- omitted evidence atoms: ${String(pack.omitted.length)}`,
    "",
    "Repository evidence excerpts:",
    ...evidenceLines(pack, redactor),
    "",
    "Known uncertainty from retrieval:",
    ...uncertaintyLines(pack, redactor),
    "",
  ];
}

// Same system message as the single-source path; the user message lists each source under its own
// header so the model can attribute every claim to a source label in addition to the file ref.
export function buildMultiSourceGatewayMessages(
  question: string,
  labeledPacks: readonly LabeledPack[],
  redactor: Redactor,
): readonly GatewayChatMessage[] {
  const sections = labeledPacks.flatMap((entry, index) => sourceSection(entry, index, redactor));
  const userContent = [
    "User question:",
    redactString(redactor, question),
    "",
    `Connected sources (${String(labeledPacks.length)}). For every repository claim, attribute it`,
    "to its source label (e.g. [source: api] src/file.ts:10-20) in addition to the file reference.",
    "",
    ...sections,
  ].join("\n");
  return [
    { role: "system", content: GROUNDED_SYSTEM_PROMPT },
    { role: "user", content: userContent },
  ];
}

// ─── Per-source retrieval seam (test injection) ───────────────────────────────

export type GroundedRetriever = (input: OrchestratorInput) => Promise<RetrievalOnlyOutput>;

// Production retriever: retrieval-only orchestrator pass with a per-scope micro-index cache. No
// modelId is needed — retrieval performs no model call.
export function defaultRetriever(signal: AbortSignal): GroundedRetriever {
  return (input: OrchestratorInput): Promise<RetrievalOnlyOutput> => {
    const nowMs = Date.now;
    return retrieveConnectedContextPack(input, {
      answerer: { answer: (): Promise<string> => Promise.resolve("") },
      nowMs,
      signal,
      microIndex: microIndexForGroundedScope(input.scope, nowMs),
    });
  };
}

// ─── Multi-source answerer seam ───────────────────────────────────────────────

export type MultiSourceAnswerer = (
  question: string,
  labeledPacks: readonly LabeledPack[],
) => Promise<string>;

export function createMultiSourceAnswerer(
  model: ModelPort,
  modelId: string,
  redactor: Redactor,
  signal: AbortSignal,
): MultiSourceAnswerer {
  return async (question, labeledPacks): Promise<string> => {
    ensureNotCancelled(signal);
    const response = await model.call(
      {
        modelId,
        messages: buildMultiSourceGatewayMessages(question, labeledPacks, redactor),
        stream: false,
      },
      signal,
    );
    const content = response.content.trim();
    return content.length > 0 ? content : "The model returned an empty response.";
  };
}

// ─── Retrieved-source record + worker ─────────────────────────────────────────

interface RetrievedSource {
  readonly label: string;
  readonly pack: ConnectedContextPack;
  readonly elapsedMs: number;
  readonly scope: SelectedScope;
}

export interface MultiSourceAskInput {
  readonly chat: Chat;
  readonly scopes: readonly ChatConnectedScope[];
  readonly content: string;
  readonly modelId: string;
  readonly deps: UiHandlerDeps;
  readonly retriever: GroundedRetriever;
  readonly answerer: MultiSourceAnswerer;
  readonly signal: AbortSignal;
}

async function retrieveAllSources(
  ctx: MultiSourceAskInput,
  query: RetrievalQuery,
  perScopeBudget: ExplorationBudget,
  labels: readonly string[],
): Promise<readonly RetrievedSource[] | RouteResult> {
  const retrieved: RetrievedSource[] = [];
  for (let i = 0; i < ctx.scopes.length; i += 1) {
    ensureNotCancelled(ctx.signal);
    const cs = ctx.scopes[i];
    const label = labels[i];
    if (cs === undefined || label === undefined) continue;
    const scope = buildSelectedScopeFrom(ctx.chat, cs, deriveScopeIdFrom(ctx.chat, cs, i));
    const out = await ctx.retriever({
      scope,
      query,
      workspaceRoot: scope.workspaceRoot,
      budget: perScopeBudget,
    });
    if (!isValidGroundedPack(out.pack)) {
      return internalError("Grounded answer context pack failed validation.");
    }
    retrieved.push({ label, pack: out.pack, elapsedMs: out.elapsedMs, scope });
  }
  return retrieved;
}

function mergedCitations(
  sources: readonly RetrievedSource[],
  redactor: Redactor,
): readonly GroundedEvidenceCitation[] {
  const citations = sources.flatMap((src) =>
    buildCitations(src.pack, redactor).map((c) => ({ ...c, source: src.label })),
  );
  return [...citations].sort((a, b) => b.score - a.score);
}

function mergedUncertainty(
  sources: readonly RetrievedSource[],
  redactor: Redactor,
): readonly GroundedUncertainty[] {
  return sources.flatMap((src) =>
    src.pack.uncertainty.map((u) => ({ kind: u.kind, claim: redactString(redactor, u.claim) })),
  );
}

// Persists ONE evidence run per source, each naming the root that source actually searched (L1
// honesty rule, mirrored from the single path). Returns the FIRST source's run id, which the
// answer surfaces as its primary evidenceRunId.
function persistPerSourceEvidence(
  ctx: MultiSourceAskInput,
  sources: readonly RetrievedSource[],
): {
  readonly firstRunId: string | undefined;
} {
  let firstRunId: string | undefined;
  for (const src of sources) {
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
  return { firstRunId };
}

function assembleMultiSourceAnswer(
  ctx: MultiSourceAskInput,
  sources: readonly RetrievedSource[],
  assistantRaw: string,
  ids: { readonly userMessageId: string; readonly assistantMessageId: string },
): GroundedAnswer {
  const { redactor } = ctx.deps;
  const citations = mergedCitations(sources, redactor);
  const summaries = sources.map((src) =>
    buildGroundedAnswerContextPackSummary(
      src.pack,
      buildCitations(src.pack, redactor).length,
      src.elapsedMs,
    ),
  );
  const { firstRunId } = persistPerSourceEvidence(ctx, sources);
  return {
    groundingKind: "connected-context",
    userMessageId: ids.userMessageId,
    assistantMessageId: ids.assistantMessageId,
    evidenceRunId: firstRunId,
    content: redactString(redactor, assistantRaw),
    citations,
    uncertainty: mergedUncertainty(sources, redactor),
    omittedCount: sources.reduce((acc, src) => acc + src.pack.omitted.length, 0),
    elapsedMs: sources.reduce((acc, src) => acc + src.elapsedMs, 0),
    contextPack: mergeContextPackSummaries(summaries),
  };
}

export async function runMultiSourceAsk(ctx: MultiSourceAskInput): Promise<RouteResult> {
  const query = buildQuery(ctx.content, () => Date.now());
  const labels = sourceLabels(ctx.scopes);
  const perScopeBudget = splitExplorationBudget(DEFAULT_EXPLORATION_BUDGET, ctx.scopes.length);
  let sources: readonly RetrievedSource[] | RouteResult;
  try {
    sources = await retrieveAllSources(ctx, query, perScopeBudget, labels);
  } catch (error) {
    return mapMultiSourceError(error, ctx.deps);
  }
  if (isRouteResult(sources)) {
    return sources;
  }
  const retrieved = sources;
  let assistantRaw: string;
  try {
    assistantRaw = await ctx.answerer(
      ctx.content,
      retrieved.map((s) => ({ label: s.label, pack: s.pack })),
    );
  } catch (error) {
    return mapMultiSourceError(error, ctx.deps);
  }
  const [userMessage, assistantMessage] = persistGroundedExchange(
    ctx.deps,
    ctx.chat.id,
    redactString(ctx.deps.redactor, ctx.content),
    redactString(ctx.deps.redactor, assistantRaw),
  );
  const answer = assembleMultiSourceAnswer(ctx, retrieved, assistantRaw, {
    userMessageId: userMessage.id,
    assistantMessageId: assistantMessage.id,
  });
  return { status: 200, body: answer };
}

function isRouteResult(value: readonly RetrievedSource[] | RouteResult): value is RouteResult {
  return !Array.isArray(value);
}

function mapMultiSourceError(error: unknown, deps: UiHandlerDeps): RouteResult {
  if (error instanceof ClarificationNeededError) return badRequest(error.message);
  const gatewayResult = mappedGatewayError(error, deps);
  if (gatewayResult !== undefined) return gatewayResult;
  throw error;
}
