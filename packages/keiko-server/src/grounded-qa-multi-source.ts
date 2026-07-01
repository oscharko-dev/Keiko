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
  ContextOverflowError,
  resolveCostClass,
  type ChatMessage as GatewayChatMessage,
} from "@oscharko-dev/keiko-model-gateway";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import { persistConnectedContextEvidence } from "@oscharko-dev/keiko-evidence";
import {
  CONTEXT_LANE_IDS,
  type ContextBudgetPressure,
  type ContextLaneId,
} from "@oscharko-dev/keiko-contracts";

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
  type GroundedAnswerContextSummary,
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
  clarificationUserMessage,
  retrieveConnectedContextPack,
  type OrchestratorInput,
  type RetrievalOnlyOutput,
} from "./grounded-orchestrator.js";
import { microIndexForGroundedScope } from "./grounded-context-index.js";
import { GROUNDED_SYSTEM_PROMPT } from "./grounded-prompt.js";
import { rememberGroundedTurn } from "./grounded-turn-registry.js";
import { assertUsableAssistantContent } from "./assistant-response.js";
import {
  normalizeGroundedAnswerPayload,
  type GroundedAnswerPayload,
  type GroundedAnswerResult,
} from "./grounded-answer.js";
import {
  buildCitations,
  buildQuery,
  buildSelectedScopeFrom,
  clarificationRequest,
  deriveScopeIdFrom,
  ensureNotCancelled,
  evidenceLines,
  groundedContextAssemblyInput,
  groundedContextSummaryInput,
  internalError,
  isValidGroundedPack,
  mappedGatewayError,
  mappedWorkspaceError,
  modelInputPromptByteLimit,
  packBudgetSummary,
  persistGroundedExchange,
  promptByteLength,
  redactString,
  uncertaintyLines,
  withPromptExcerptByteLimit,
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

const PRESSURE_RANK: Readonly<Record<ContextBudgetPressure, number>> = {
  low: 0,
  moderate: 1,
  high: 2,
  exceeded: 3,
} as const;

function isContextSummary(
  summary: GroundedAnswerContextPackSummary["contextSummary"],
): summary is GroundedAnswerContextSummary {
  return summary !== undefined;
}

function emptyLaneCounts(): Record<ContextLaneId, number> {
  const counts = {} as Record<ContextLaneId, number>;
  for (const laneId of CONTEXT_LANE_IDS) {
    counts[laneId] = 0;
  }
  return counts;
}

function worstPressure(
  current: ContextBudgetPressure,
  next: ContextBudgetPressure,
): ContextBudgetPressure {
  return PRESSURE_RANK[next] > PRESSURE_RANK[current] ? next : current;
}

function mergeContextSummaries(
  summaries: readonly GroundedAnswerContextPackSummary[],
): GroundedAnswerContextSummary | undefined {
  const contextSummaries = summaries
    .map((summary) => summary.contextSummary)
    .filter(isContextSummary);
  if (contextSummaries.length === 0) {
    return undefined;
  }
  const laneCounts = emptyLaneCounts();
  let totalEstimatedTokens = 0;
  let budgetPressure: ContextBudgetPressure = "low";
  let compactionActive = false;
  for (const summary of contextSummaries) {
    totalEstimatedTokens += summary.totalEstimatedTokens;
    budgetPressure = worstPressure(budgetPressure, summary.budgetPressure);
    compactionActive ||= summary.compactionActive;
    for (const laneId of CONTEXT_LANE_IDS) {
      laneCounts[laneId] += summary.laneCounts[laneId];
    }
  }
  return { totalEstimatedTokens, budgetPressure, laneCounts, compactionActive };
}

type CoverageSummary = NonNullable<GroundedAnswerContextPackSummary["coverage"]>;

function isCoverageSummary(
  coverage: GroundedAnswerContextPackSummary["coverage"],
): coverage is CoverageSummary {
  return coverage !== undefined;
}

function mergeCoverageSummaries(
  summaries: readonly GroundedAnswerContextPackSummary[],
): CoverageSummary | undefined {
  const coverageSummaries = summaries.map((summary) => summary.coverage).filter(isCoverageSummary);
  if (coverageSummaries.length === 0) {
    return undefined;
  }
  const reasons = [...new Set(coverageSummaries.flatMap((coverage) => coverage.reasons))];
  return {
    incomplete: coverageSummaries.some((coverage) => coverage.incomplete),
    reasons,
    filesDiscovered: coverageSummaries.reduce((sum, coverage) => sum + coverage.filesDiscovered, 0),
    filesAfterPolicy: coverageSummaries.reduce((sum, coverage) => sum + coverage.filesAfterPolicy, 0),
    filesScanned: coverageSummaries.reduce((sum, coverage) => sum + coverage.filesScanned, 0),
    filesSkipped: coverageSummaries.reduce((sum, coverage) => sum + coverage.filesSkipped, 0),
    ignoredByDiscovery: coverageSummaries.reduce(
      (sum, coverage) => sum + coverage.ignoredByDiscovery,
      0,
    ),
    deniedByDiscovery: coverageSummaries.reduce(
      (sum, coverage) => sum + coverage.deniedByDiscovery,
      0,
    ),
    depthPrunedByDiscovery: coverageSummaries.reduce(
      (sum, coverage) => sum + coverage.depthPrunedByDiscovery,
      0,
    ),
    matchesReturned: coverageSummaries.reduce((sum, coverage) => sum + coverage.matchesReturned, 0),
    elapsedMs: coverageSummaries.reduce((sum, coverage) => sum + coverage.elapsedMs, 0),
    limits: {
      maxFilesScanned: coverageSummaries.reduce(
        (sum, coverage) => sum + coverage.limits.maxFilesScanned,
        0,
      ),
      maxMatchesReturned: coverageSummaries.reduce(
        (sum, coverage) => sum + coverage.limits.maxMatchesReturned,
        0,
      ),
      elapsedMsMax: coverageSummaries.reduce(
        (sum, coverage) => sum + coverage.limits.elapsedMsMax,
        0,
      ),
    },
  };
}

export function mergeContextPackSummaries(
  summaries: readonly GroundedAnswerContextPackSummary[],
): GroundedAnswerContextPackSummary {
  const [first] = summaries;
  if (first === undefined) {
    throw new Error("mergeContextPackSummaries requires at least one summary");
  }
  // ADR-0057 D1: merge every contributing source's path-free contextSummary. The projection remains
  // structurally path-free: fixed lane-id keys, numeric counts/tokens, a pressure enum, and a boolean.
  const mergedContextSummary = mergeContextSummaries(summaries);
  const mergedCoverage = mergeCoverageSummaries(summaries);
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
    ...(mergedCoverage !== undefined ? { coverage: mergedCoverage } : {}),
    ...(mergedContextSummary !== undefined ? { contextSummary: mergedContextSummary } : {}),
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
  return budgetedMultiSourceGatewayMessages(question, labeledPacks, redactor);
}

function buildRawMultiSourceGatewayMessages(
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

function multiSourceExcerptCount(labeledPacks: readonly LabeledPack[]): number {
  return labeledPacks.reduce(
    (count, entry) =>
      count + entry.pack.files.reduce((fileCount, file) => fileCount + file.excerpts.length, 0),
    0,
  );
}

function withMultiSourcePromptExcerptByteLimit(
  labeledPacks: readonly LabeledPack[],
  maxExcerptBytes: number,
): readonly LabeledPack[] {
  return labeledPacks.map((entry) => ({
    ...entry,
    pack: withPromptExcerptByteLimit(entry.pack, maxExcerptBytes),
  }));
}

function budgetedMultiSourceGatewayMessages(
  question: string,
  labeledPacks: readonly LabeledPack[],
  redactor: Redactor,
): readonly GatewayChatMessage[] {
  const limit = modelInputPromptByteLimit(
    labeledPacks.reduce((sum, entry) => sum + entry.pack.budget.modelInputTokensMax, 0),
  );
  let messages = buildRawMultiSourceGatewayMessages(question, labeledPacks, redactor);
  if (limit === 0 || promptByteLength(messages) <= limit) return messages;
  const excerptCount = multiSourceExcerptCount(labeledPacks);
  if (excerptCount === 0) return messages;

  const emptyPacks = withMultiSourcePromptExcerptByteLimit(labeledPacks, 0);
  const overheadBytes = promptByteLength(
    buildRawMultiSourceGatewayMessages(question, emptyPacks, redactor),
  );
  // When overhead alone (system prompt + question + framing for all sources) exceeds the limit,
  // no amount of excerpt trimming can bring the prompt within budget. Throw instead of sending
  // an over-limit prompt to the provider which would result in an opaque 400 context-window error.
  if (overheadBytes > limit) {
    throw new ContextOverflowError(
      `Multi-source grounded prompt overhead (${String(overheadBytes)} bytes) exceeds model input limit (${String(limit)} bytes).`,
    );
  }
  let maxExcerptBytes = Math.max(0, Math.floor((limit - overheadBytes) / excerptCount));
  while (maxExcerptBytes >= 0) {
    messages = buildRawMultiSourceGatewayMessages(
      question,
      withMultiSourcePromptExcerptByteLimit(labeledPacks, maxExcerptBytes),
      redactor,
    );
    if (promptByteLength(messages) <= limit || maxExcerptBytes === 0) {
      return messages;
    }
    maxExcerptBytes = Math.max(0, Math.floor(maxExcerptBytes * 0.8));
  }
  return buildRawMultiSourceGatewayMessages(question, emptyPacks, redactor);
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
) => Promise<GroundedAnswerPayload>;

export function createMultiSourceAnswerer(
  model: ModelPort,
  modelId: string,
  redactor: Redactor,
  signal: AbortSignal,
): MultiSourceAnswerer {
  return async (question, labeledPacks): Promise<GroundedAnswerResult> => {
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
    assertUsableAssistantContent(content, modelId);
    return {
      content,
      usage: {
        promptTokens: response.usage.promptTokens,
        completionTokens: response.usage.completionTokens,
      },
    };
  };
}

// ─── Retrieved-source record + worker ─────────────────────────────────────────

const MAX_RETRIEVAL_CONCURRENCY = 4;

interface RetrievedSource {
  readonly label: string;
  readonly pack: ConnectedContextPack;
  readonly elapsedMs: number;
  readonly scope: SelectedScope;
  readonly plan: RetrievalOnlyOutput["plan"];
}

interface SkippedScope {
  readonly label: string;
  readonly message: string;
}

interface RetrievalOutcome {
  readonly retrieved: readonly RetrievedSource[];
  readonly skipped: readonly SkippedScope[];
  readonly firstError: RouteResult | undefined;
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
  // Upfront-skipped sources (inaccessible/denied at canonicalization time). Merged into the
  // `source-skipped` uncertainty entries so the caller sees which folders were omitted.
  readonly preSkipped?: readonly { readonly label: string; readonly message: string }[];
}

// GRD-006: classify a thrown per-source retrieve error. A recoverable workspace error becomes a
// skip (with the mapped RouteResult preserved as the all-bad fallback); anything else returns
// undefined so the caller re-throws it to the outer handler (ClarificationNeededError, cancel, …).
function classifyPerSourceRetrieveError(
  error: unknown,
  label: string,
): { readonly skipped: SkippedScope; readonly mapped: RouteResult } | undefined {
  const mapped = mappedWorkspaceError(error);
  if (mapped === undefined) return undefined;
  return {
    skipped: {
      label,
      message: error instanceof Error ? error.message : "Connected source is not readable.",
    },
    mapped,
  };
}

interface RetrieveAccumulator {
  readonly retrieved: (RetrievedSource | undefined)[];
  readonly skipped: SkippedScope[];
  firstError: RouteResult | undefined;
}

// Retrieve one source into the shared accumulator. GRD-006: a recoverable workspace error skips
// just that source (preserving the all-bad 400 fallback in `firstError`); any other error
// propagates to the outer handler.
async function retrieveOneSource(
  ctx: MultiSourceAskInput,
  query: RetrievalQuery,
  perScopeBudget: ExplorationBudget,
  labels: readonly string[],
  acc: RetrieveAccumulator,
  i: number,
): Promise<void> {
  ensureNotCancelled(ctx.signal);
  const cs = ctx.scopes[i];
  const label = labels[i];
  if (cs === undefined || label === undefined) return;
  const scope = buildSelectedScopeFrom(ctx.chat, cs, deriveScopeIdFrom(ctx.chat, cs, i));
  let out: Awaited<ReturnType<GroundedRetriever>>;
  try {
    out = await ctx.retriever({
      scope,
      query,
      workspaceRoot: scope.workspaceRoot,
      budget: perScopeBudget,
    });
  } catch (error) {
    const classified = classifyPerSourceRetrieveError(error, label);
    if (classified === undefined) throw error; // non-workspace error → outer handler
    acc.skipped.push(classified.skipped);
    acc.firstError ??= classified.mapped;
    return;
  }
  if (!isValidGroundedPack(out.pack)) {
    acc.skipped.push({ label, message: "Pack validation failed." });
    acc.firstError ??= internalError("Grounded answer context pack failed validation.");
    return;
  }
  acc.retrieved[i] = { label, pack: out.pack, elapsedMs: out.elapsedMs, scope, plan: out.plan };
}

async function retrieveAllSources(
  ctx: MultiSourceAskInput,
  query: RetrievalQuery,
  perScopeBudget: ExplorationBudget,
  labels: readonly string[],
): Promise<RetrievalOutcome | RouteResult> {
  const acc: RetrieveAccumulator = {
    retrieved: new Array<RetrievedSource | undefined>(ctx.scopes.length),
    skipped: [],
    firstError: undefined,
  };
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = nextIndex;
      nextIndex += 1;
      if (i >= ctx.scopes.length) return;
      await retrieveOneSource(ctx, query, perScopeBudget, labels, acc, i);
    }
  }

  const workerCount = Math.min(MAX_RETRIEVAL_CONCURRENCY, Math.max(1, ctx.scopes.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  const sources = acc.retrieved.filter((source): source is RetrievedSource => source !== undefined);
  const skipped = acc.skipped;
  const firstError = acc.firstError;
  if (sources.length === 0 && firstError !== undefined) return firstError;
  return { retrieved: sources, skipped, firstError };
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
  skipped: readonly SkippedScope[],
  preSkipped: readonly { readonly label: string; readonly message: string }[],
  redactor: Redactor,
): readonly GroundedUncertainty[] {
  const fromPacks = sources.flatMap((src) =>
    src.pack.uncertainty.map((u) => ({ kind: u.kind, claim: redactString(redactor, u.claim) })),
  );
  const allSkipped = [
    ...preSkipped.map((s) => ({ label: s.label, message: s.message })),
    ...skipped,
  ];
  const fromSkipped = allSkipped.map((entry) => ({
    kind: "source-skipped",
    claim: redactString(redactor, `Source ${entry.label} skipped: ${entry.message}`),
  }));
  return [...fromPacks, ...fromSkipped];
}

// Persists ONE evidence run per source, each naming the root that source actually searched (L1
// honesty rule, mirrored from the single path). Returns the FIRST source's run id, which the
// answer surfaces as its primary evidenceRunId, plus the full set for audit discovery.
function persistPerSourceEvidence(
  ctx: MultiSourceAskInput,
  sources: readonly RetrievedSource[],
): {
  readonly firstRunId: string | undefined;
  readonly runIds: readonly string[];
} {
  let firstRunId: string | undefined;
  const runIds: string[] = [];
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
        plan: src.plan,
        pack: src.pack,
        citationCount: buildCitations(src.pack, ctx.deps.redactor).length,
        elapsedMs: src.elapsedMs,
        startedAt,
        finishedAt,
        ...groundedContextAssemblyInput(ctx.deps, src.pack),
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

function assembleMultiSourceAnswer(
  ctx: MultiSourceAskInput,
  sources: readonly RetrievedSource[],
  skipped: readonly SkippedScope[],
  assistant: GroundedAnswerResult,
  ids: { readonly userMessageId: string; readonly assistantMessageId: string },
): GroundedAnswer {
  const { redactor } = ctx.deps;
  const citations = mergedCitations(sources, redactor);
  const summaries = sources.map((src) =>
    buildGroundedAnswerContextPackSummary(
      src.pack,
      buildCitations(src.pack, redactor).length,
      src.elapsedMs,
      groundedContextSummaryInput(ctx.deps, src.pack),
    ),
  );
  const mergedSummary = mergeContextPackSummaries(summaries);
  const { firstRunId, runIds } = persistPerSourceEvidence(ctx, sources);
  return {
    groundingKind: "connected-context",
    userMessageId: ids.userMessageId,
    assistantMessageId: ids.assistantMessageId,
    evidenceRunId: firstRunId,
    evidenceRunIds: runIds,
    content: redactString(redactor, assistant.content),
    citations,
    uncertainty: mergedUncertainty(sources, skipped, ctx.preSkipped ?? [], redactor),
    omittedCount: sources.reduce((acc, src) => acc + src.pack.omitted.length, 0),
    elapsedMs: sources.reduce((acc, src) => acc + src.elapsedMs, 0),
    contextPack: {
      ...mergedSummary,
      usage: {
        ...mergedSummary.usage,
        modelInputTokens: mergedSummary.usage.modelInputTokens + assistant.usage.promptTokens,
        modelOutputTokens: mergedSummary.usage.modelOutputTokens + assistant.usage.completionTokens,
      },
    },
  };
}

export async function runMultiSourceAsk(ctx: MultiSourceAskInput): Promise<RouteResult> {
  const query = buildQuery(ctx.content, () => Date.now());
  const labels = sourceLabels(ctx.scopes);
  const perScopeBudget = splitExplorationBudget(DEFAULT_EXPLORATION_BUDGET, ctx.scopes.length);
  let outcome: RetrievalOutcome | RouteResult;
  try {
    outcome = await retrieveAllSources(ctx, query, perScopeBudget, labels);
  } catch (error) {
    return mapMultiSourceError(error, ctx.deps);
  }
  if (isRouteResult(outcome)) {
    return outcome;
  }
  const { retrieved, skipped } = outcome;
  let assistant: GroundedAnswerResult;
  try {
    assistant = normalizeGroundedAnswerPayload(
      await ctx.answerer(
        ctx.content,
        retrieved.map((s) => ({ label: s.label, pack: s.pack })),
      ),
    );
    ensureNotCancelled(ctx.signal);
  } catch (error) {
    return mapMultiSourceError(error, ctx.deps);
  }
  const [userMessage, assistantMessage] = persistGroundedExchange(
    ctx.deps,
    ctx.chat.id,
    redactString(ctx.deps.redactor, ctx.content),
    redactString(ctx.deps.redactor, assistant.content),
  );
  const answer = assembleMultiSourceAnswer(ctx, retrieved, skipped, assistant, {
    userMessageId: userMessage.id,
    assistantMessageId: assistantMessage.id,
  });
  ctx.deps.store.attachGroundedAnswer(assistantMessage.id, answer);
  rememberGroundedTurn({
    assistantMessageId: assistantMessage.id,
    chatId: ctx.chat.id,
    workspaceRoot: retrieved[0]?.pack.scope.workspaceRoot ?? ctx.chat.projectPath,
    evidenceRunId: answer.evidenceRunId,
    packs: retrieved.map((source) => source.pack),
  });
  return { status: 200, body: answer };
}

function isRouteResult(value: RetrievalOutcome | RouteResult): value is RouteResult {
  return "status" in value;
}

function mapMultiSourceError(error: unknown, deps: UiHandlerDeps): RouteResult {
  if (error instanceof ClarificationNeededError) {
    return clarificationRequest(clarificationUserMessage(error));
  }
  const workspaceResult = mappedWorkspaceError(error);
  if (workspaceResult !== undefined) return workspaceResult;
  const gatewayResult = mappedGatewayError(error, deps);
  if (gatewayResult !== undefined) return gatewayResult;
  throw error;
}
