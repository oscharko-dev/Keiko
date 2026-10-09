import {
  caughtGroundedPackValidation,
  inspectGroundedPack,
  recordGroundedPackValidation,
  GROUNDED_PACK_VALIDATION_MESSAGE,
  type GroundedPackValidationFailure,
} from "./grounded-pack-validation.js";
// Epic #532 — multi-source (1+N) grounded retrieval merge. A chat may connect N folders/files at
// once; asking one question must search EVERY connected source and return ONE merged answer with
// per-source attribution. This module owns the new branch only. The single-source path
// (`grounded-qa.ts`) is deliberately untouched so its wire output stays byte-identical (AC5).
//
// The path is split out of `grounded-qa.ts` to keep both files under the 400-LOC bound; it imports
// the shared formatters/projection/persistence helpers (now exported) so the two paths build their
// gateway messages, citations, and evidence from the exact same primitives.

import { mapWithConcurrency } from "./bounded-concurrency.js";
import {
  reconcileAndLogInlineCitations,
  type CitationReconciliationMetadata,
} from "./grounded-citation-log.js";
import { basename } from "node:path";
import { createHash } from "node:crypto";
import {
  CancelledError,
  ContextOverflowError,
  resolveCostClass,
  type ChatMessage as GatewayChatMessage,
  type NormalizedResponse,
} from "@oscharko-dev/keiko-model-gateway";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
import { persistConnectedContextEvidence } from "@oscharko-dev/keiko-evidence";
import type { ContextBudgetPressure, ContextLaneId } from "@oscharko-dev/keiko-contracts";
import { CONTEXT_LANE_IDS } from "@oscharko-dev/keiko-contracts/runtime/context-engineering";

import {
  connectedContextOmittedCount,
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
  chatConnectedScopeFingerprintInput,
  type ChatConnectedScope,
  type GroundedAnswer,
  type GroundedInsufficiencyDeclaration,
  type GroundedAnswerContextSummary,
  type GroundedAnswerContextPackSummary,
  type GroundedEvidenceCitation,
  type GroundedUncertainty,
  type CitationRepairDisposition,
} from "@oscharko-dev/keiko-contracts/bff-wire";

import type { RouteResult } from "./routes.js";
import type { Redactor, UiHandlerDeps } from "./deps.js";
import { currentContextProfileForModel, currentRedactionSecrets } from "./deps.js";
import { withAdoptedContextWindowRetry } from "./gateway-context-window.js";
import { countGatewayPromptTokens } from "@oscharko-dev/keiko-model-gateway/internal/prompt-token-accounting";
import type { Chat, ChatMessage } from "./store/index.js";
import {
  ClarificationNeededError,
  clarificationUserMessage,
  retrieveConnectedContextPack,
  type OrchestratorInput,
  type GroundedAnswerOptions,
  type GroundedAnswerer,
  type RetrievalOnlyOutput,
  logGroundedAnswerForPack,
} from "./grounded-orchestrator.js";
import { microIndexForGroundedScope } from "./grounded-context-index.js";
import { configuredGroundedSemanticRequest } from "./grounded-semantic-request.js";
import { createEntailmentStage } from "./grounded-entailment-stage.js";
import type { EntailmentStageFactory } from "./grounded-qa-hybrid.js";
import { GROUNDED_SYSTEM_PROMPT, sentGroundedFileCount } from "./grounded-prompt.js";
import { evidenceRetentionObserver } from "./evidence-retention-log.js";
import { assertUsableAssistantContent } from "./assistant-response.js";
import { splitExplorationBudgets } from "./grounded-multi-source-budget.js";
import {
  createGroundedSynthesisCallBudget,
  normalizeGroundedAnswerPayload,
  type GroundedAnswerPayload,
  type GroundedAnswerResult,
  type GroundedSynthesisCallBudget,
  type GroundedSynthesisAttemptOptions,
} from "./grounded-answer.js";
import {
  callPluralGroundedSynthesis,
  pluralSynthesisMetadata,
  withPluralSynthesisUsage,
  capturePluralSynthesisCounts,
} from "./grounded-plural-synthesis.js";
import {
  connectedSearchNoEvidenceAnswer,
  groundedAnswerEvidenceFields,
  buildInsufficiencyScopeIndex,
  declaredInsufficiencyPaths,
  validateGroundedAnswerEvidence,
  buildPackCitationIndex,
  citationSourceIdForIndex,
  incompleteAnswerMarker,
  missingCitationMarkerFor,
  packsHaveUsableEvidence,
  noEvidenceMarker,
  unsupportedCitationMarker,
} from "./grounded-faithfulness.js";
import {
  buildAnswerCitations,
  buildSourcedAnswerCitations,
} from "./grounded-citation-projection.js";
import {
  appendGroundedAnswerEntailment,
  buildQuery,
  buildSelectedScopeFrom,
  clarificationRequest,
  deriveScopeIdFrom,
  ensureNotCancelled,
  evidenceLines,
  omissionReasonLines,
  groundedContextAssemblyInput,
  groundedContextSummaryInput,
  groundedEvidenceRunId,
  groundedPromptOptions,
  groundedScopeWorkspaceFs,
  type GroundedGatewayPromptOptions,
  internalError,
  mappedGatewayError,
  mappedWorkspaceError,
  modelWindowAwareBudget,
  modelInputPromptByteLimit,
  packBudgetSummary,
  promptExcerptCount,
  promptByteLength,
  registerGroundedTurn,
  redactString,
  uncertaintyLines,
  sizeExclusionLines,
  fitPromptOmissionMetadata,
  withPromptExcerptByteLimit,
  groundedRetrievalContinuityFields,
  type GroundedRetrievalContinuityInput,
} from "./grounded-qa.js";
import { persistGroundedExchange } from "./grounded-message-persistence.js";
import { sentPromptContext, type SentGroundedPrompt } from "./grounded-prompt-context.js";
import { logPromptWindowFit } from "./knowledge-prompt-window.js";
import { buildCitationRepairPrompt } from "./grounded-citation-repair.js";
import {
  repairGroundedAnswer,
  observeGroundedCitationBehaviour,
  type GroundedRepairContext,
  type GroundedRepairResult,
} from "./grounded-answer-repair.js";
import {
  citationBehaviourFor,
  citationBehaviourObserverFor,
} from "./grounded-citation-capability.js";
import { emitServerDiagnostic, serverDiagnosticFromError } from "./diagnostics-log.js";
import { correlationIdOrUnknown } from "./correlation.js";
import { logGroundedPromptSelection } from "./chat-activity.js";

export { splitExplorationBudget, splitExplorationBudgets } from "./grounded-multi-source-budget.js";

// ─── Canonical reader + label/budget helpers ──────────────────────────────────

// Canonical reader rule (Epic #532 contract): `connectedScopes` supersedes the legacy single
// `connectedScope`. Readers must NOT mix the two — the list, when present, is authoritative.
export function buildConnectedScopes(chat: Chat): readonly ChatConnectedScope[] {
  return chat.connectedScopes ?? (chat.connectedScope ? [chat.connectedScope] : []);
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
      filesReadMax:
        acc.filesReadMax === null || s.budget.filesReadMax === null
          ? null
          : acc.filesReadMax + s.budget.filesReadMax,
      excerptBytesMax: acc.excerptBytesMax + s.budget.excerptBytesMax,
      modelInputTokensMax: acc.modelInputTokensMax + s.budget.modelInputTokensMax,
      modelOutputTokensMax: acc.modelOutputTokensMax + s.budget.modelOutputTokensMax,
      elapsedMsMax:
        acc.elapsedMsMax === null || s.budget.elapsedMsMax === null
          ? null
          : acc.elapsedMsMax + s.budget.elapsedMsMax,
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
type SummableCoverageField =
  | "filesDiscovered"
  | "filesAfterPolicy"
  | "filesScanned"
  | "filesSkipped"
  | "ignoredByDiscovery"
  | "deniedByDiscovery"
  | "unrepresentablePathsByDiscovery"
  | "depthPrunedByDiscovery"
  | "maxFilesPrunedByDiscovery"
  | "matchesReturned"
  | "elapsedMs";

function isCoverageSummary(
  coverage: GroundedAnswerContextPackSummary["coverage"],
): coverage is CoverageSummary {
  return coverage !== undefined;
}

function sumCoverage(summaries: readonly CoverageSummary[], field: SummableCoverageField): number {
  return summaries.reduce((sum, coverage) => sum + (coverage[field] ?? 0), 0);
}

function mergeCoverageLimits(summaries: readonly CoverageSummary[]): CoverageSummary["limits"] {
  return {
    maxFilesScanned: summaries.some((coverage) => coverage.limits.maxFilesScanned === null)
      ? null
      : summaries.reduce((sum, coverage) => sum + (coverage.limits.maxFilesScanned ?? 0), 0),
    maxMatchesReturned: summaries.reduce(
      (sum, coverage) => sum + coverage.limits.maxMatchesReturned,
      0,
    ),
    elapsedMsMax: summaries.some((coverage) => coverage.limits.elapsedMsMax === null)
      ? null
      : summaries.reduce((sum, coverage) => sum + (coverage.limits.elapsedMsMax ?? 0), 0),
  };
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
    filesDiscovered: sumCoverage(coverageSummaries, "filesDiscovered"),
    filesAfterPolicy: sumCoverage(coverageSummaries, "filesAfterPolicy"),
    filesScanned: sumCoverage(coverageSummaries, "filesScanned"),
    filesSkipped: sumCoverage(coverageSummaries, "filesSkipped"),
    truncated: coverageSummaries.some((coverage) => coverage.truncated),
    ignoredByDiscovery: sumCoverage(coverageSummaries, "ignoredByDiscovery"),
    deniedByDiscovery: sumCoverage(coverageSummaries, "deniedByDiscovery"),
    ...(sumCoverage(coverageSummaries, "unrepresentablePathsByDiscovery") > 0
      ? {
          unrepresentablePathsByDiscovery: sumCoverage(
            coverageSummaries,
            "unrepresentablePathsByDiscovery",
          ),
        }
      : {}),
    depthPrunedByDiscovery: sumCoverage(coverageSummaries, "depthPrunedByDiscovery"),
    maxFilesPrunedByDiscovery: sumCoverage(coverageSummaries, "maxFilesPrunedByDiscovery"),
    matchesReturned: sumCoverage(coverageSummaries, "matchesReturned"),
    elapsedMs: sumCoverage(coverageSummaries, "elapsedMs"),
    limits: mergeCoverageLimits(coverageSummaries),
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

function sourceSection(
  entry: LabeledPack,
  index: number,
  redactor: Redactor,
  omissionPathBytes?: number,
): readonly string[] {
  const { label, pack } = entry;
  return [
    `### Source ${String(index + 1)}: ${label}`,
    `- budget/usage: ${packBudgetSummary(pack)}`,
    `- omitted files: ${String(connectedContextOmittedCount(pack))}`,
    ...omissionReasonLines(pack),
    ...sizeExclusionLines(pack, redactor, omissionPathBytes),
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
  return budgetedMultiSourceGatewayMessages(question, labeledPacks, redactor).messages;
}

function buildRawMultiSourceGatewayMessages(
  question: string,
  labeledPacks: readonly LabeledPack[],
  redactor: Redactor,
  omissionPathBytes?: number,
): readonly GatewayChatMessage[] {
  const sections = labeledPacks.flatMap((entry, index) =>
    sourceSection(entry, index, redactor, omissionPathBytes),
  );
  const userContent = [
    "User question:",
    redactString(redactor, question),
    "",
    `Connected sources (${String(labeledPacks.length)}). For every repository claim, cite its`,
    "source ordinal and file in one marker (e.g. [source:1|src/file.ts:10-20]).",
    "",
    ...sections,
  ].join("\n");
  return [
    { role: "system", content: GROUNDED_SYSTEM_PROMPT },
    { role: "user", content: userContent },
  ];
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

function bestPackScore(pack: ConnectedContextPack): number {
  let best = 0.01;
  for (const file of pack.files) {
    for (const excerpt of file.excerpts) {
      best = Math.max(best, excerpt.atom.score);
    }
  }
  return best;
}

function packExcerptCount(pack: ConnectedContextPack): number {
  return pack.files.reduce((count, file) => count + file.excerpts.length, 0);
}

function sourceBudgetBytes(totalBytes: number, index: number, weights: readonly number[]): number {
  const equalPool = totalBytes * 0.35;
  const weightedPool = totalBytes - equalPool;
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  const equal = equalPool / weights.length;
  const weighted = weightSum <= 0 ? 0 : (weightedPool * (weights[index] ?? 0)) / weightSum;
  return Math.floor(equal + weighted);
}

function withMultiSourcePromptExcerptTotalBudget(
  labeledPacks: readonly LabeledPack[],
  totalExcerptBytes: number,
): readonly LabeledPack[] {
  if (totalExcerptBytes <= 0 || labeledPacks.length === 0) {
    return withMultiSourcePromptExcerptByteLimit(labeledPacks, 0);
  }
  const weights = labeledPacks.map((entry) => bestPackScore(entry.pack));
  return labeledPacks.map((entry, index) => {
    const excerptCount = packExcerptCount(entry.pack);
    const perExcerpt =
      excerptCount === 0
        ? 0
        : Math.floor(sourceBudgetBytes(totalExcerptBytes, index, weights) / excerptCount);
    return {
      ...entry,
      pack: withPromptExcerptByteLimit(entry.pack, perExcerpt),
    };
  });
}

interface FittedMultiSourcePrompt {
  readonly omissionPathBytes?: number;
  readonly messages: readonly GatewayChatMessage[];
  readonly packs: readonly LabeledPack[];
}

// The merged prompt fits the smaller of the packs' own budgets and the answering model's input
// budget, counted in bytes and with the admission token accounting, like the folder prompt
// (fitGroundedPrompt). The packs' budgets add up per source, so on their own they let three sources
// send three windows' worth of excerpts to one model (PR #3678 review).
function multiSourceInputTokens(
  labeledPacks: readonly LabeledPack[],
  options: GroundedGatewayPromptOptions,
): number {
  const packTokens = labeledPacks.reduce(
    (sum, entry) =>
      sum + Math.max(0, entry.pack.budget.modelInputTokensMax - entry.pack.usage.modelInputTokens),
    0,
  );
  return Math.min(packTokens, options.modelInputTokensMax ?? packTokens);
}

function multiSourcePromptFit(
  labeledPacks: readonly LabeledPack[],
  options: GroundedGatewayPromptOptions,
): { readonly limit: number; readonly fits: (m: readonly GatewayChatMessage[]) => boolean } {
  const tokensMax = multiSourceInputTokens(labeledPacks, options);
  const limit = modelInputPromptByteLimit(tokensMax);
  return {
    limit,
    fits: (messages) =>
      promptByteLength(messages) <= limit &&
      countGatewayPromptTokens({ messages }, options.tokenAccounting) <= tokensMax,
  };
}

function budgetedMultiSourceGatewayMessages(
  question: string,
  labeledPacks: readonly LabeledPack[],
  redactor: Redactor,
  options: GroundedGatewayPromptOptions = {},
): FittedMultiSourcePrompt {
  const { limit, fits } = multiSourcePromptFit(labeledPacks, options);
  const fullMessages = buildRawMultiSourceGatewayMessages(question, labeledPacks, redactor);
  if (fits(fullMessages)) return { messages: fullMessages, packs: labeledPacks };
  const metadataFit = fitPromptOmissionMetadata(
    (bytes) => buildRawMultiSourceGatewayMessages(question, labeledPacks, redactor, bytes),
    fits,
    limit,
  );
  if (metadataFit !== undefined) return { ...metadataFit, packs: labeledPacks };

  const emptyPacks = withMultiSourcePromptExcerptByteLimit(labeledPacks, 0);
  const overheadBytes = promptByteLength(
    buildRawMultiSourceGatewayMessages(question, emptyPacks, redactor, 0),
  );
  // When overhead alone (system prompt + question + framing for all sources) exceeds the limit,
  // no amount of excerpt trimming can bring the prompt within budget. Throw instead of sending
  // an over-limit prompt to the provider which would result in an opaque 400 context-window error.
  if (!fits(buildRawMultiSourceGatewayMessages(question, emptyPacks, redactor, 0))) {
    throw new ContextOverflowError(
      `Multi-source grounded prompt overhead (${String(overheadBytes)} bytes) exceeds model input limit (${String(limit)} bytes).`,
    );
  }
  let totalExcerptBytes = Math.max(0, limit - overheadBytes);
  while (totalExcerptBytes >= 0) {
    const packs = withMultiSourcePromptExcerptTotalBudget(labeledPacks, totalExcerptBytes);
    const messages = buildRawMultiSourceGatewayMessages(question, packs, redactor, 0);
    if (fits(messages) || totalExcerptBytes === 0) {
      return { messages, packs, omissionPathBytes: 0 };
    }
    totalExcerptBytes = Math.max(0, Math.floor(totalExcerptBytes * 0.8));
  }
  return {
    messages: buildRawMultiSourceGatewayMessages(question, emptyPacks, redactor, 0),
    packs: emptyPacks,
    omissionPathBytes: 0,
  };
}

// The fit decision on the existing `search.prompt.window-fitted` port, like the Knowledge Pod and
// hybrid prompts (PR #3678 review): a trim records the excerpts kept and the prompt sent, a refusal
// the smallest prompt refused, both on the request's correlation.
function loggedMultiSourceFit(
  question: string,
  labeledPacks: readonly LabeledPack[],
  redactor: Redactor,
  options: GroundedGatewayPromptOptions,
  correlationId: string | undefined,
): FittedMultiSourcePrompt {
  const referenceCount = promptExcerptCount(labeledPacks.map((entry) => entry.pack));
  const inputBudget = multiSourceInputTokens(labeledPacks, options);
  const tokens = (messages: readonly GatewayChatMessage[]): number =>
    countGatewayPromptTokens({ messages }, options.tokenAccounting);
  let fitted: FittedMultiSourcePrompt;
  try {
    fitted = budgetedMultiSourceGatewayMessages(question, labeledPacks, redactor, options);
  } catch (error) {
    if (error instanceof ContextOverflowError) {
      const empty = withMultiSourcePromptExcerptByteLimit(labeledPacks, 0);
      const promptTokens = tokens(buildRawMultiSourceGatewayMessages(question, empty, redactor, 0));
      const fit = { referenceCount, sentReferenceCount: 0, promptTokens, inputBudget };
      logPromptWindowFit({ state: "refused", ...fit }, correlationId);
    }
    throw error;
  }
  if (fitted.packs !== labeledPacks || fitted.omissionPathBytes !== undefined) {
    const sentReferenceCount = promptExcerptCount(fitted.packs.map((entry) => entry.pack));
    const fit = { referenceCount, sentReferenceCount, promptTokens: tokens(fitted.messages) };
    const state = fitted.packs === labeledPacks ? "metadata-trimmed" : "trimmed";
    logPromptWindowFit({ state, ...fit, inputBudget }, correlationId);
  }
  return fitted;
}

/**
 * The merged multi-source prompt exactly as it is sent, with the same prompt rendered without
 * excerpts, so the context meter can count the share the sources took.
 */
export function fittedMultiSourcePrompt(
  question: string,
  labeledPacks: readonly LabeledPack[],
  redactor: Redactor,
  options: GroundedGatewayPromptOptions = {},
  correlationId?: string,
): SentGroundedPrompt & { readonly packs: readonly LabeledPack[] } {
  const fitted = loggedMultiSourceFit(question, labeledPacks, redactor, options, correlationId);
  return {
    packs: fitted.packs,
    messages: fitted.messages,
    withoutSources: buildRawMultiSourceGatewayMessages(
      question,
      withMultiSourcePromptExcerptByteLimit(labeledPacks, 0),
      redactor,
      -1,
    ),
    sentReferenceCount: promptExcerptCount(fitted.packs.map((entry) => entry.pack)),
    availableReferenceCount: promptExcerptCount(labeledPacks.map((entry) => entry.pack)),
  };
}

// ─── Per-source retrieval seam (test injection) ───────────────────────────────

export type GroundedRetriever = (
  input: OrchestratorInput,
  signal?: AbortSignal,
) => Promise<RetrievalOnlyOutput>;

// Production retriever: retrieval-only orchestrator pass with a per-scope micro-index cache. No
// modelId is needed — retrieval performs no model call.
export function defaultRetriever(
  signal: AbortSignal,
  deps?: UiHandlerDeps,
  correlationId?: string,
): GroundedRetriever {
  return (input: OrchestratorInput, childSignal = signal): Promise<RetrievalOnlyOutput> => {
    const nowMs = Date.now;
    const semanticLease =
      deps === undefined
        ? { providerFor: undefined, close: (): void => undefined }
        : configuredGroundedSemanticRequest(deps, input.workspaceRoot);
    return retrieveConnectedContextPack(input, {
      answerer: { answer: (): Promise<string> => Promise.resolve("") },
      nowMs,
      signal: childSignal,
      declarationVerificationSignal: signal,
      microIndex: microIndexForGroundedScope(input.scope, nowMs),
      // ADR-0173 D5. A multi-folder or hybrid ask retrieves through THIS path, not through the
      // single-folder one, so without the id every git-history read failure on the plural-source
      // routes lands under UNKNOWN_CORRELATION_ID and cannot be joined to the ask that degraded.
      correlationId,
      ...(deps?.workspaceIndexForRoot === undefined
        ? {}
        : { workspaceIndexForRoot: deps.workspaceIndexForRoot }),
      diagnostics: deps?.diagnostics,
      ...(semanticLease.providerFor === undefined
        ? {}
        : { repoSemanticSearchProviderFor: semanticLease.providerFor }),
    }).finally(() => {
      semanticLease.close();
    });
  };
}

// ─── Multi-source answerer seam ───────────────────────────────────────────────

export interface MultiSourceAnswerer {
  (question: string, labeledPacks: readonly LabeledPack[]): Promise<GroundedAnswerPayload>;
  readonly repair?: GroundedAnswerer["repair"];
  readonly remainingSynthesisCalls?: GroundedSynthesisCallBudget["remaining"];
  readonly pendingSynthesisUsage?: GroundedSynthesisCallBudget["pendingUsage"];
  readonly takeFailedSynthesisUsage?: GroundedSynthesisCallBudget["takeUsage"];
  readonly reservedSynthesisOutputTokens?: GroundedSynthesisCallBudget["reservedOutputTokens"];
  readonly completedSynthesisCalls?: GroundedSynthesisCallBudget["completed"];
}

interface MultiSourceGatewayContext {
  readonly synthesisBudget: GroundedSynthesisCallBudget;
  readonly originalBudget: ReturnType<typeof modelWindowAwareBudget>;
  readonly startedAtMs: number;
  readonly deps: UiHandlerDeps;
  readonly model: ModelPort;
  readonly modelId: string;
  readonly signal: AbortSignal;
  readonly correlationId: string | undefined;
  readonly answerOptions: Pick<
    GroundedAnswerOptions,
    "answerOnlyContextAvailable" | "currentQuestion"
  >;
  sent?: ReturnType<typeof fittedMultiSourcePrompt>;
}

// Like the folder answerer (createGatewayAnswerer): each attempt fits the prompt to the model's
// current input budget, and a provider overflow that states the real window re-fits and sends once
// more (withAdoptedContextWindowRetry). The prompt of the last attempt is the one reported.
export function createMultiSourceAnswerer(
  deps: UiHandlerDeps,
  model: ModelPort,
  modelId: string,
  signal: AbortSignal,
  correlationId: string | undefined,
  answerOptions: Pick<GroundedAnswerOptions, "answerOnlyContextAvailable" | "currentQuestion"> = {},
): MultiSourceAnswerer {
  const ctx: MultiSourceGatewayContext = {
    synthesisBudget: createGroundedSynthesisCallBudget(),
    originalBudget: modelWindowAwareBudget(deps, modelId),
    startedAtMs: Date.now(),
    deps,
    model,
    modelId,
    signal,
    correlationId,
    answerOptions,
  };
  return Object.assign(
    (question: string, packs: readonly LabeledPack[]) =>
      multiSourceGatewayAnswer(ctx, question, packs),
    {
      remainingSynthesisCalls: (): number => ctx.synthesisBudget.remaining(),
      pendingSynthesisUsage: (): ReturnType<GroundedSynthesisCallBudget["pendingUsage"]> =>
        ctx.synthesisBudget.pendingUsage(),
      takeFailedSynthesisUsage: (): ReturnType<GroundedSynthesisCallBudget["takeUsage"]> =>
        ctx.synthesisBudget.takeUsage(),
      reservedSynthesisOutputTokens: (): number => ctx.synthesisBudget.reservedOutputTokens(),
      completedSynthesisCalls: (): number => ctx.synthesisBudget.completed(),
      repair: (
        question: string,
        _pack: ConnectedContextPack,
        original: string,
        options: GroundedAnswerOptions,
      ) => multiSourceGatewayRepair(ctx, question, original, options),
    },
  );
}

async function multiSourceGatewayAnswer(
  ctx: MultiSourceGatewayContext,
  question: string,
  labeledPacks: readonly LabeledPack[],
): Promise<GroundedAnswerResult> {
  const countsBefore = capturePluralSynthesisCounts(ctx.synthesisBudget);
  ensureNotCancelled(ctx.signal);
  const response = await withAdoptedContextWindowRetry(
    ctx.deps,
    { modelId: ctx.modelId, surface: "grounded", correlationId: ctx.correlationId },
    () => multiSourceGatewayAttempt(ctx, question, labeledPacks),
  );
  const sent = ctx.sent;
  if (sent === undefined) throw new TypeError("Multi-source fitted prompt is unavailable");
  const answer = multiSourceAnswerResult(
    response,
    sent,
    ctx.answerOptions.currentQuestion ?? question,
    ctx.modelId,
    currentContextProfileForModel(ctx.deps, ctx.modelId),
  );
  return withPluralSynthesisUsage(answer, ctx.synthesisBudget, countsBefore);
}

async function multiSourceGatewayAttempt(
  ctx: MultiSourceGatewayContext,
  question: string,
  packs: readonly LabeledPack[],
): Promise<NormalizedResponse | undefined> {
  const accounting = currentContextProfileForModel(ctx.deps, ctx.modelId)?.tokenAccounting;
  const options = multiSourceRemainingPromptOptions(ctx, packs, accounting);
  const sent = fittedMultiSourcePrompt(
    question,
    packs,
    ctx.deps.redactor,
    options,
    ctx.correlationId,
  );
  ctx.sent = sent;
  if (sent.sentReferenceCount === 0 && ctx.answerOptions.answerOnlyContextAvailable !== true)
    return undefined;
  logGroundedPromptSelection(
    ctx.correlationId,
    sent,
    multiSourceInputTokens(packs, options),
    accounting,
  );
  const grants = multiSourceSynthesisGrants(ctx, packs);
  return callPluralGroundedSynthesis({
    model: ctx.model,
    signal: ctx.signal,
    budget: ctx.synthesisBudget,
    grants,
    accounting,
    request: {
      modelId: ctx.modelId,
      messages: sent.messages,
      stream: false,
      maxOutputTokens: Math.min(
        modelWindowAwareBudget(ctx.deps, ctx.modelId).modelOutputTokensMax,
        grants.outputTokensMax - ctx.synthesisBudget.pendingUsage().completionTokens,
      ),
      logContext: { correlationId: ctx.correlationId },
    },
  });
}

function multiSourceSynthesisGrants(
  ctx: MultiSourceGatewayContext,
  packs: readonly LabeledPack[],
): GroundedSynthesisAttemptOptions {
  const elapsed = [
    ctx.originalBudget.elapsedMsMax,
    ...packs.map((entry) => entry.pack.budget.elapsedMsMax),
  ].filter((limit): limit is number => limit !== null);
  return {
    inputTokensMax: remainingMultiSourceResource(
      ctx.originalBudget.modelInputTokensMax,
      packs,
      "modelInputTokensMax",
      "modelInputTokens",
    ),
    outputTokensMax: remainingMultiSourceResource(
      ctx.originalBudget.modelOutputTokensMax,
      packs,
      "modelOutputTokensMax",
      "modelOutputTokens",
    ),
    ...(elapsed.length === 0 ? {} : { deadlineAtMs: ctx.startedAtMs + Math.min(...elapsed) }),
    signal: ctx.signal,
  };
}

function remainingMultiSourceResource(
  max: number,
  packs: readonly LabeledPack[],
  budgetKey: "modelInputTokensMax" | "modelOutputTokensMax",
  usageKey: "modelInputTokens" | "modelOutputTokens",
): number {
  const original = Math.min(
    max,
    packs.reduce((sum, entry) => sum + entry.pack.budget[budgetKey], 0),
  );
  return Math.max(0, original - packs.reduce((sum, entry) => sum + entry.pack.usage[usageKey], 0));
}

function multiSourceRemainingPromptOptions(
  ctx: MultiSourceGatewayContext,
  packs: readonly LabeledPack[],
  accounting: GroundedGatewayPromptOptions["tokenAccounting"],
): GroundedGatewayPromptOptions {
  const options = groundedPromptOptions(ctx.deps, ctx.modelId, accounting);
  return {
    ...options,
    modelInputTokensMax: Math.min(
      options.modelInputTokensMax ?? Number.MAX_SAFE_INTEGER,
      multiSourceSynthesisGrants(ctx, packs).inputTokensMax -
        ctx.synthesisBudget.pendingUsage().promptTokens,
    ),
  };
}

function multiSourceRepairPrompt(
  ctx: MultiSourceGatewayContext,
  question: string,
  original: string,
  options: GroundedAnswerOptions,
): ReturnType<typeof fittedMultiSourcePrompt> | undefined {
  const packs = ctx.sent?.packs;
  if (packs === undefined) return undefined;
  const accounting = currentContextProfileForModel(ctx.deps, ctx.modelId)?.tokenAccounting;
  const promptOptions = groundedPromptOptions(ctx.deps, ctx.modelId, accounting);
  try {
    const fitted = fittedMultiSourcePrompt(
      `${question}\n\n${buildCitationRepairPrompt(original)}`,
      packs,
      ctx.deps.redactor,
      {
        ...promptOptions,
        modelInputTokensMax: Math.min(
          promptOptions.modelInputTokensMax ?? Number.MAX_SAFE_INTEGER,
          options.modelInputTokensMax ?? 0,
        ),
      },
      ctx.correlationId,
    );
    return fitted.packs === packs ? fitted : undefined;
  } catch (error) {
    if (error instanceof ContextOverflowError) return undefined;
    throw error;
  }
}

async function multiSourceGatewayRepair(
  ctx: MultiSourceGatewayContext,
  question: string,
  original: string,
  options: GroundedAnswerOptions,
): Promise<GroundedAnswerResult> {
  const countsBefore = capturePluralSynthesisCounts(ctx.synthesisBudget);
  const sent = multiSourceRepairPrompt(ctx, question, original, options);
  if (sent === undefined || ctx.synthesisBudget.remaining() <= 0)
    return uninvokedCitationRepair(original);
  const signal = multiSourceRepairSignal(ctx.signal, options);
  if (signal === undefined) return uninvokedCitationRepair(original);
  logMultiSourceRepairPrompt(ctx, sent, options);
  if (options.deadlineAtMs !== undefined && Date.now() >= options.deadlineAtMs)
    return uninvokedCitationRepair(original);
  ensureNotCancelled(signal);
  const response = await callPluralGroundedSynthesis({
    model: ctx.model,
    signal,
    budget: ctx.synthesisBudget,
    grants: {
      inputTokensMax: options.modelInputTokensMax ?? 0,
      outputTokensMax: options.modelOutputTokensMax ?? 0,
      signal,
      deadlineAtMs: options.deadlineAtMs,
    },
    accounting: currentContextProfileForModel(ctx.deps, ctx.modelId)?.tokenAccounting,
    request: {
      modelId: ctx.modelId,
      messages: sent.messages,
      stream: false,
      maxOutputTokens: options.modelOutputTokensMax,
      logContext: { correlationId: ctx.correlationId },
    },
  });
  assertUsableAssistantContent(response.content.trim(), ctx.modelId);
  return withPluralSynthesisUsage(
    {
      content: response.content.trim(),
      usage: { promptTokens: 0, completionTokens: 0 },
      sentEvidencePacks: sent.packs.map((entry) => entry.pack),
      modelInvoked: true,
    },
    ctx.synthesisBudget,
    countsBefore,
  );
}

function logMultiSourceRepairPrompt(
  ctx: MultiSourceGatewayContext,
  sent: ReturnType<typeof fittedMultiSourcePrompt>,
  options: GroundedAnswerOptions,
): void {
  logGroundedPromptSelection(
    ctx.correlationId,
    sent,
    Math.min(
      options.modelInputTokensMax ?? 0,
      multiSourceInputTokens(sent.packs, groundedPromptOptions(ctx.deps, ctx.modelId, undefined)),
    ),
    currentContextProfileForModel(ctx.deps, ctx.modelId)?.tokenAccounting,
  );
}

export function uninvokedCitationRepair(content: string): GroundedAnswerResult {
  return { content, modelInvoked: false, usage: { promptTokens: 0, completionTokens: 0 } };
}

function multiSourceRepairSignal(
  parent: AbortSignal,
  options: GroundedAnswerOptions,
): AbortSignal | undefined {
  const remainingMs =
    options.deadlineAtMs === undefined ? undefined : options.deadlineAtMs - Date.now();
  if (remainingMs !== undefined && remainingMs <= 0) return undefined;
  const signals = [parent, ...(options.signal === undefined ? [] : [options.signal])];
  if (remainingMs !== undefined) signals.push(AbortSignal.timeout(Math.ceil(remainingMs)));
  return AbortSignal.any(signals);
}

function multiSourceAnswerResult(
  response: NormalizedResponse | undefined,
  sent: ReturnType<typeof fittedMultiSourcePrompt>,
  question: string,
  modelId: string,
  profile: ReturnType<typeof currentContextProfileForModel>,
): GroundedAnswerResult {
  const content = response?.content.trim() ?? connectedSearchNoEvidenceAnswer(question);
  if (response !== undefined) assertUsableAssistantContent(content, modelId);
  const packs = sent.packs.map((entry) => entry.pack);
  return {
    content,
    modelInvoked: response !== undefined,
    noEvidence: sent.sentReferenceCount === 0,
    usage: {
      promptTokens: response?.usage.promptTokens ?? 0,
      completionTokens: response?.usage.completionTokens ?? 0,
    },
    evidenceScopeIndex: buildInsufficiencyScopeIndex(packs),
    sentEvidencePacks: packs,
    filesInPrompt: sentGroundedFileCount(packs),
    ...(response === undefined
      ? {}
      : { promptContext: sentPromptContext(sent, response.usage.promptTokens, profile) }),
  };
}

// ─── Retrieved-source record + worker ─────────────────────────────────────────

const MAX_RETRIEVAL_CONCURRENCY = 4;

interface RetrievedSource {
  readonly sourceScopeFingerprint: string;
  readonly label: string;
  readonly pack: ConnectedContextPack;
  readonly elapsedMs: number;
  readonly scope: SelectedScope;
  readonly plan: RetrievalOnlyOutput["plan"];
  readonly declarationScopeIndexFor?: RetrievalOnlyOutput["declarationScopeIndexFor"];
}

/** Reuse canonical admission for declared paths; only final sent excerpts establish read-state. */
export function verifiedPluralInsufficiencyScopeIndex(
  sources: readonly Pick<RetrievalOnlyOutput, "declarationScopeIndexFor">[],
  content: string,
  sentPacks: readonly ConnectedContextPack[],
  discovered?: ReadonlyMap<string, GroundedInsufficiencyDeclaration["state"]>,
): ReadonlyMap<string, GroundedInsufficiencyDeclaration["state"]> {
  const paths = declaredInsufficiencyPaths(content);
  const inventory = new Map(buildInsufficiencyScopeIndex([], discovered));
  for (const source of sources) {
    for (const [path, state] of source.declarationScopeIndexFor?.(paths) ?? []) {
      inventory.set(path, state);
    }
  }
  return buildInsufficiencyScopeIndex(sentPacks, inventory);
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

export interface MultiSourceAskInput extends GroundedRetrievalContinuityInput {
  /** Verified discovered paths; only actual sent evidence promotes a path to read-state. */
  readonly insufficiencyScopeIndex?: ReadonlyMap<string, GroundedInsufficiencyDeclaration["state"]>;
  readonly sourceScopeFingerprints?: ReadonlyMap<ChatConnectedScope, string>;
  readonly retrievalContent?: string | undefined;
  readonly chat: Chat;
  readonly scopes: readonly ChatConnectedScope[];
  readonly content: string;
  readonly answerContent?: string | undefined;
  readonly answerOnlyContextAvailable?: boolean | undefined;
  readonly clientTurnId?: string | undefined;
  readonly commitTurnId?: string | undefined;
  readonly userMessage?: ChatMessage | undefined;
  readonly modelId: string;
  readonly contextProfile: UiHandlerDeps["contextProfile"];
  readonly deps: UiHandlerDeps;
  readonly retriever: GroundedRetriever;
  readonly answerer: MultiSourceAnswerer;
  readonly signal: AbortSignal;
  // Upfront-skipped sources (inaccessible/denied at canonicalization time). Merged into the
  // `source-skipped` uncertainty entries so the caller sees which folders were omitted.
  readonly preSkipped?: readonly { readonly label: string; readonly message: string }[];
  /** The request's correlation, joined by every diagnostic of this ask. */
  readonly correlationId?: string | undefined;
  /** Test seam (KEIKO-0237): supply the entailment stage instead of building it from `deps`. */
  readonly entailmentStageFactory?: EntailmentStageFactory;
}

// GRD-006: classify a thrown per-source retrieve error. A recoverable workspace error becomes a
// skip (with the mapped RouteResult preserved as the all-bad fallback); anything else returns
// undefined so the caller re-throws it to the outer handler (ClarificationNeededError, cancel, …).
function classifyPerSourceRetrieveError(
  error: unknown,
  label: string,
  correlationId: string | undefined,
  deps: UiHandlerDeps,
  sourceIndex: number,
):
  | {
      readonly skipped: SkippedScope;
      readonly mapped: RouteResult;
      readonly validationFailure?: GroundedPackValidationFailure;
    }
  | undefined {
  const validationFailure = caughtGroundedPackValidation(error);
  if (validationFailure !== undefined) {
    recordGroundedPackValidation(
      deps,
      correlationId,
      validationFailure,
      "source-skipped",
      sourceIndex,
    );
    return {
      skipped: { label, message: GROUNDED_PACK_VALIDATION_MESSAGE },
      mapped: internalError(GROUNDED_PACK_VALIDATION_MESSAGE, correlationId),
      validationFailure,
    };
  }
  const mapped = mappedWorkspaceError(error, { correlationId });
  if (mapped === undefined) return undefined;
  const body = mapped.body as { readonly error?: { readonly message?: unknown } };
  const safeMessage =
    typeof body.error?.message === "string"
      ? body.error.message
      : "Connected source is not readable.";
  return {
    skipped: { label, message: safeMessage },
    mapped,
  };
}

interface RetrieveAccumulator {
  readonly retrieved: (RetrievedSource | undefined)[];
  readonly skipped: SkippedScope[];
  firstError: RouteResult | undefined;
  firstValidationFailure?: {
    readonly failure: GroundedPackValidationFailure;
    readonly sourceIndex: number;
  };
}

function rememberSkippedSource(
  acc: RetrieveAccumulator,
  classified: NonNullable<ReturnType<typeof classifyPerSourceRetrieveError>>,
  sourceIndex: number,
): void {
  acc.skipped.push(classified.skipped);
  acc.firstError ??= classified.mapped;
  if (classified.validationFailure !== undefined) {
    acc.firstValidationFailure ??= { failure: classified.validationFailure, sourceIndex };
  }
}

function classifyReturnedPack(
  ctx: MultiSourceAskInput,
  pack: ConnectedContextPack,
  label: string,
  sourceIndex: number,
): ReturnType<typeof classifyPerSourceRetrieveError> {
  const validationFailure = inspectGroundedPack(pack, {
    deps: ctx.deps,
    correlationId: ctx.correlationId,
    outcome: "source-skipped",
    sourceIndex,
  });
  if (validationFailure === undefined) return undefined;
  return {
    skipped: { label, message: GROUNDED_PACK_VALIDATION_MESSAGE },
    mapped: internalError(GROUNDED_PACK_VALIDATION_MESSAGE, ctx.correlationId),
    validationFailure,
  };
}

// Retrieve one source into the shared accumulator. GRD-006: a recoverable workspace error skips
// just that source (preserving the all-bad 400 fallback in `firstError`); any other error
// propagates to the outer handler.
async function retrieveOneSource(
  ctx: MultiSourceAskInput,
  query: RetrievalQuery,
  perScopeBudgets: readonly ExplorationBudget[],
  labels: readonly string[],
  acc: RetrieveAccumulator,
  i: number,
): Promise<void> {
  ensureNotCancelled(ctx.signal);
  const cs = ctx.scopes[i];
  const label = labels[i];
  if (cs === undefined || label === undefined) return;
  const budget = perScopeBudgets[i] ?? DEFAULT_EXPLORATION_BUDGET;
  const scope = buildSelectedScopeFrom(ctx.chat, cs, deriveScopeIdFrom(ctx.chat, cs, i));
  let out: Awaited<ReturnType<GroundedRetriever>>;
  try {
    const workspaceFs = groundedScopeWorkspaceFs(cs);
    out = await ctx.retriever(
      {
        scope,
        query,
        workspaceRoot: scope.workspaceRoot,
        budget,
        ...groundedRetrievalContinuityFields(ctx),
        ...(workspaceFs === undefined ? {} : { workspaceFs }),
      },
      ctx.signal,
    );
    ensureNotCancelled(ctx.signal);
  } catch (error) {
    const classified = classifyPerSourceRetrieveError(error, label, ctx.correlationId, ctx.deps, i);
    if (classified === undefined) throw error; // non-workspace error → outer handler
    rememberSkippedSource(acc, classified, i);
    return;
  }
  const classified = classifyReturnedPack(ctx, out.pack, label, i);
  if (classified !== undefined) {
    rememberSkippedSource(acc, classified, i);
    return;
  }
  acc.retrieved[i] = {
    label,
    pack: out.pack,
    elapsedMs: out.elapsedMs,
    scope,
    plan: out.plan,
    declarationScopeIndexFor: out.declarationScopeIndexFor,
    sourceScopeFingerprint: groundedSourceScopeFingerprint(scope, cs, ctx.sourceScopeFingerprints),
  };
}

async function retrieveAllSources(
  ctx: MultiSourceAskInput,
  query: RetrievalQuery,
  perScopeBudgets: readonly ExplorationBudget[],
  labels: readonly string[],
): Promise<RetrievalOutcome | RouteResult> {
  const acc: RetrieveAccumulator = {
    retrieved: new Array<RetrievedSource | undefined>(ctx.scopes.length),
    skipped: [],
    firstError: undefined,
  };
  await mapWithConcurrency(
    ctx.scopes,
    MAX_RETRIEVAL_CONCURRENCY,
    (_scope, index, signal) =>
      retrieveOneSource({ ...ctx, signal }, query, perScopeBudgets, labels, acc, index),
    ctx.signal,
  );
  ensureNotCancelled(ctx.signal);
  const sources = acc.retrieved.filter((source): source is RetrievedSource => source !== undefined);
  const skipped = acc.skipped;
  const firstError = acc.firstError;
  if (sources.length === 0 && firstError !== undefined) {
    const validation = acc.firstValidationFailure;
    if (firstError.status === 500 && validation !== undefined) {
      recordGroundedPackValidation(
        ctx.deps,
        ctx.correlationId,
        validation.failure,
        "request-failed",
        validation.sourceIndex,
      );
    }
    return firstError;
  }
  return { retrieved: sources, skipped, firstError };
}

interface SourceCitationBundle {
  readonly source: RetrievedSource;
  readonly citations: readonly GroundedEvidenceCitation[];
  readonly labeledCitations: readonly GroundedEvidenceCitation[];
}

export function groundedSourceScopeFingerprint(
  scope: SelectedScope,
  connectedScope?: ChatConnectedScope,
  selectedFingerprints?: ReadonlyMap<ChatConnectedScope, string>,
): string {
  if (connectedScope !== undefined && selectedFingerprints !== undefined) {
    const fingerprint = selectedFingerprints.get(connectedScope);
    if (fingerprint === undefined)
      throw new TypeError("Selected source attribution is unavailable");
    return fingerprint;
  }
  const input = chatConnectedScopeFingerprintInput({
    root: scope.workspaceRoot,
    kind: scope.kind,
    relativePaths: scope.relativePaths,
    connectedAtMs: 0,
  });
  if (input === undefined) throw new TypeError("Connected source identity is unavailable");
  return createHash("sha256").update(input).digest("hex");
}

function labelAnswerCitations(
  citations: readonly GroundedEvidenceCitation[],
  sourceLabel: string,
  redactor: Redactor,
  sourceScopeFingerprint?: string,
): readonly GroundedEvidenceCitation[] {
  return citations.map((citation) => ({
    ...citation,
    source: redactString(redactor, sourceLabel),
    ...(sourceScopeFingerprint === undefined ? {} : { sourceScopeFingerprint }),
  }));
}

export function buildLabeledAnswerCitations(
  pack: ConnectedContextPack,
  assistantContent: string,
  sourceLabel: string,
  redactor: Redactor,
): readonly GroundedEvidenceCitation[] {
  return labelAnswerCitations(
    buildAnswerCitations(pack, assistantContent, (value) => redactString(redactor, value)),
    sourceLabel,
    redactor,
  );
}

function sourceCitationBundles(
  sources: readonly RetrievedSource[],
  redactor: Redactor,
  assistantContent: string,
  sentPacks: readonly ConnectedContextPack[],
): readonly SourceCitationBundle[] {
  const projected = buildSourcedAnswerCitations(sentPacks, assistantContent, (value) =>
    redactString(redactor, value),
  );
  return sources.map((source, index) => {
    const sourceId = citationSourceIdForIndex(index);
    const citations = projected
      .filter((entry) => entry.sourceId === sourceId)
      .map((entry) => entry.citation);
    return {
      source,
      citations,
      labeledCitations: labelAnswerCitations(
        citations,
        source.label,
        redactor,
        source.sourceScopeFingerprint,
      ),
    };
  });
}

function mergedCitations(
  bundles: readonly SourceCitationBundle[],
): readonly GroundedEvidenceCitation[] {
  const citations = bundles.flatMap((bundle) => bundle.labeledCitations);
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
  bundles: readonly SourceCitationBundle[],
  completedSynthesisCallCount: number | undefined,
): {
  readonly firstRunId: string | undefined;
  readonly runIds: readonly string[];
} {
  let firstRunId: string | undefined;
  const runIds: string[] = [];
  for (const [ordinal, { source: src, citations }] of bundles.entries()) {
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
        sourceScopeFingerprint: src.sourceScopeFingerprint,
        chatId: ctx.chat.id,
        plan: src.plan,
        pack: src.pack,
        citationCount: citations.length,
        completedSynthesisCallCount,
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
        onRetentionDeleted: evidenceRetentionObserver("grounded-qa-multi-source"),
      },
    );
    firstRunId ??= runId;
    runIds.push(runId);
  }
  return { firstRunId, runIds };
}

function noSourceAnswerMarkers(
  assistant: GroundedAnswerResult,
  redactor: Redactor,
): readonly GroundedUncertainty[] {
  if (assistant.noEvidence !== true) return [];
  const marker = noEvidenceMarker(Date.now());
  return [{ kind: marker.kind, claim: redactString(redactor, marker.claim) }];
}

function multiSourceAnswerSummaries(
  ctx: MultiSourceAskInput,
  bundles: ReturnType<typeof sourceCitationBundles>,
  modelInvoked: boolean,
): readonly GroundedAnswerContextPackSummary[] {
  return bundles.map(({ source: src, citations }) =>
    buildGroundedAnswerContextPackSummary(
      src.pack,
      modelInvoked ? citations.length : 0,
      src.elapsedMs,
      groundedContextSummaryInput({ contextProfile: ctx.contextProfile }, src.pack),
    ),
  );
}

function assembleMultiSourceAnswer(
  ctx: MultiSourceAskInput,
  sources: readonly RetrievedSource[],
  skipped: readonly SkippedScope[],
  assistant: RepairedMultiSourceAnswer,
  ids: {
    readonly userMessageId: string;
    readonly assistantMessageId: string;
    // GEN-AI-GROUNDING-002/-003 (RB-4): the multi-source path abstained (no usable evidence across
    // any source). Suppress citations and skip per-source evidence persistence.
    readonly abstained: boolean;
  },
): GroundedAnswer {
  const { redactor } = ctx.deps;
  const modelInvoked =
    assistant.modelInvoked ?? (!ids.abstained || ctx.answerOnlyContextAvailable === true);
  const citationBundles = sourceCitationBundles(
    sources,
    redactor,
    assistant.content,
    finalMultiSourceEvidence(assistant, sources),
  );
  const citations = modelInvoked ? mergedCitations(citationBundles) : [];
  const summaries = multiSourceAnswerSummaries(ctx, citationBundles, modelInvoked);
  const { firstRunId, runIds } = ids.abstained
    ? { firstRunId: undefined, runIds: [] as readonly string[] }
    : persistPerSourceEvidence(ctx, citationBundles, assistant.completedSynthesisCallCount);
  // GEN-AI-GROUNDING-001/-008 (RB-4): reconcile the model's inline citations against the merged
  // evidence packs the model actually received; flag references to un-retrieved files.
  const reconciliationUncertainty = modelInvoked
    ? buildMultiSourceReconciliationUncertainty(assistant, sources, redactor, ctx.correlationId)
    : [];
  return {
    groundingKind: "connected-context",
    userMessageId: ids.userMessageId,
    assistantMessageId: ids.assistantMessageId,
    ...(firstRunId === undefined ? {} : { evidenceRunId: firstRunId }),
    evidenceRunIds: runIds,
    content: redactString(redactor, assistant.content),
    ...groundedAnswerEvidenceFields(assistant),
    citations,
    uncertainty: [
      ...mergedUncertainty(sources, skipped, ctx.preSkipped ?? [], redactor),
      ...reconciliationUncertainty,
      ...noSourceAnswerMarkers(assistant, redactor),
    ],
    omittedCount: sources.reduce((acc, src) => acc + connectedContextOmittedCount(src.pack), 0),
    elapsedMs: sources.reduce((acc, src) => acc + src.elapsedMs, 0),
    contextPack: withMergedAssistantUsage(mergeContextPackSummaries(summaries), assistant),
    ...(modelInvoked && assistant.promptContext !== undefined
      ? { promptContext: assistant.promptContext }
      : {}),
  };
}

// Folds the answer's model-token usage into the merged multi-source context-pack summary.
function withMergedAssistantUsage(
  mergedSummary: ReturnType<typeof mergeContextPackSummaries>,
  assistant: GroundedAnswerResult,
): ReturnType<typeof mergeContextPackSummaries> {
  return {
    ...mergedSummary,
    ...(assistant.filesInPrompt === undefined ? {} : { filesInPrompt: assistant.filesInPrompt }),
    usage: {
      ...mergedSummary.usage,
      modelInputTokens: mergedSummary.usage.modelInputTokens + assistant.usage.promptTokens,
      modelOutputTokens: mergedSummary.usage.modelOutputTokens + assistant.usage.completionTokens,
    },
  };
}

function finalMultiSourceEvidence(
  assistant: GroundedAnswerResult,
  sources: readonly RetrievedSource[],
): readonly ConnectedContextPack[] {
  return assistant.sentEvidencePacks ?? sources.map((source) => source.pack);
}

// Wire-projected reconciliation markers (unsupported-citation + incomplete-answer) for the
// multi-source path. Mirrors the single-source reconciliation in runGroundedExploration.
function buildMultiSourceReconciliationUncertainty(
  assistant: RepairedMultiSourceAnswer,
  sources: readonly RetrievedSource[],
  redactor: Redactor,
  correlationId: string | undefined,
): readonly GroundedUncertainty[] {
  const nowMs = Date.now();
  const reconciliation = reconcileAndLogInlineCitations(
    assistant.content,
    buildPackCitationIndex(finalMultiSourceEvidence(assistant, sources)),
    correlationId,
    {
      answerKind: assistant.answerKind,
      citationBehaviour: assistant.citationBehaviour,
      citationRepairDisposition: assistant.citationRepairDisposition,
      ...multiSourceInsufficiencyObservation(assistant),
    },
  );
  const unsupported = unsupportedCitationMarker(reconciliation.unsupported, nowMs);
  const missing =
    unsupported === undefined && reconciliation.citedScopePaths.size === 0
      ? missingCitationMarkerFor(assistant.content, nowMs, assistant.answerKind)
      : undefined;
  const markers = [
    ...(unsupported === undefined ? [] : [unsupported]),
    ...(missing === undefined ? [] : [missing]),
    ...(assistant.finishReason === "length" ? [incompleteAnswerMarker(nowMs)] : []),
  ];
  return markers.map((m) => ({ kind: m.kind, claim: redactString(redactor, m.claim) }));
}

// Knowledge M1.2 (#2563): folder scopes carry no capsule, so entailment is governed only by whether
// a compatible judge model is configured. Abstained or inert ⇒ the assembled answer is unchanged.
async function applyMultiSourceEntailment(
  ctx: MultiSourceAskInput,
  assembled: GroundedAnswer,
  assistant: GroundedAnswerResult,
  retrieved: readonly RetrievedSource[],
  modelInvoked: boolean,
): Promise<GroundedAnswer> {
  if (!modelInvoked) {
    return assembled;
  }
  const stage =
    ctx.entailmentStageFactory !== undefined
      ? ctx.entailmentStageFactory({ capsules: [], modelId: ctx.modelId, signal: ctx.signal })
      : createEntailmentStage(
          ctx.deps,
          [],
          ctx.modelId,
          // The request's correlation, so the verdict line joins the ask (PR #3678 review).
          { diagnostics: ctx.deps.diagnostics, correlationId: ctx.correlationId },
          ctx.signal,
        );
  if (stage === undefined) {
    return assembled;
  }
  return appendGroundedAnswerEntailment(
    assembled,
    stage,
    assistant.content,
    finalMultiSourceEvidence(assistant, retrieved),
    ctx.deps.redactor,
  );
}

interface PersistedMultiSourceExchange {
  readonly userMessageId: string;
  readonly assistantMessageId: string;
}

function persistMultiSourceExchange(
  ctx: MultiSourceAskInput,
  assistant: GroundedAnswerResult,
): PersistedMultiSourceExchange {
  const [userMessage, assistantMessage] = persistGroundedExchange(
    ctx.deps,
    ctx.chat.id,
    redactString(ctx.deps.redactor, ctx.content),
    redactString(ctx.deps.redactor, assistant.content),
    ctx.userMessage,
  );
  return {
    userMessageId: userMessage.id,
    assistantMessageId: assistantMessage.id,
  };
}

function recordMultiSourceAnswer(
  ctx: MultiSourceAskInput,
  retrieved: readonly RetrievedSource[],
  answer: GroundedAnswer,
  assistantMessageId: string,
  abstained: boolean,
): void {
  ctx.deps.store.attachGroundedAnswer(assistantMessageId, answer);
  if (abstained) return;
  registerGroundedTurn(
    {
      assistantMessageId,
      chatId: ctx.chat.id,
      workspaceRoot: retrieved[0]?.pack.scope.workspaceRoot ?? ctx.chat.projectPath,
      ...(answer.evidenceRunId === undefined ? {} : { evidenceRunId: answer.evidenceRunId }),
      packs: retrieved.map((source) => source.pack),
    },
    ctx.commitTurnId ?? ctx.clientTurnId,
  );
}

function withAnswerDuration(answer: GroundedAnswer, startedAtMs: number): GroundedAnswer {
  if (answer.groundingKind !== "connected-context") return answer;
  const elapsedMs = Math.max(0, Date.now() - startedAtMs);
  return { ...answer, elapsedMs, contextPack: { ...answer.contextPack, elapsedMs } };
}

export async function runMultiSourceAsk(ctx: MultiSourceAskInput): Promise<RouteResult> {
  const startedAtMs = Date.now();
  const query = buildQuery(ctx.retrievalContent ?? ctx.content, () => Date.now());
  const labels = sourceLabels(ctx.scopes);
  const perScopeBudgets = splitExplorationBudgets(
    modelWindowAwareBudget(ctx.deps, ctx.modelId),
    ctx.scopes,
    query,
  );
  let outcome: RetrievalOutcome | RouteResult;
  try {
    outcome = await retrieveAllSources(ctx, query, perScopeBudgets, labels);
  } catch (error) {
    const failure =
      ctx.signal.aborted && error === ctx.signal.reason
        ? new CancelledError("grounded request cancelled")
        : error;
    return mapMultiSourceError(failure, ctx.deps, ctx.correlationId);
  }
  if (isRouteResult(outcome)) {
    return outcome;
  }
  const { retrieved, skipped } = outcome;
  // GEN-AI-GROUNDING-002/-003 (RB-4): abstain BEFORE the model call when no source carries usable
  // evidence — the folders path must not answer confidently over zero evidence, and no grounded
  // evidence manifest may be persisted.
  const noRetrievedEvidence = !packsHaveUsableEvidence(retrieved.map((s) => s.pack));
  const assistant = await answerMultiSource(ctx, retrieved, noRetrievedEvidence, startedAtMs);
  if (isRouteResult(assistant)) {
    return assistant;
  }
  ensureNotCancelled(ctx.signal);
  const abstained = noRetrievedEvidence || assistant.noEvidence === true;
  const persisted = persistMultiSourceExchange(ctx, assistant);
  const answer = await applyMultiSourceEntailment(
    ctx,
    assembleMultiSourceAnswer(ctx, retrieved, skipped, assistant, {
      ...persisted,
      abstained,
    }),
    assistant,
    retrieved,
    assistant.modelInvoked ?? (!abstained || ctx.answerOnlyContextAvailable === true),
  );
  ensureNotCancelled(ctx.signal);
  const completedAnswer = withAnswerDuration(answer, startedAtMs);
  recordMultiSourceAnswer(ctx, retrieved, completedAnswer, persisted.assistantMessageId, abstained);
  return { status: 200, body: completedAnswer };
}

function isRouteResult(
  value: RetrievalOutcome | RouteResult | GroundedAnswerResult,
): value is RouteResult {
  return "status" in value;
}

// Produces the multi-source answer: a deterministic no-evidence answer when abstaining (no model
// call), otherwise the model answer over the merged packs. Returns a RouteResult on failure so
// runMultiSourceAsk stays under the LOC bound (GEN-AI-GROUNDING-002/-003, RB-4).
async function answerMultiSource(
  ctx: MultiSourceAskInput,
  retrieved: readonly RetrievedSource[],
  abstained: boolean,
  startedAtMs: number,
): Promise<RepairedMultiSourceAnswer | RouteResult> {
  ensureNotCancelled(ctx.signal);
  if (abstained && ctx.answerOnlyContextAvailable !== true) {
    return {
      content: connectedSearchNoEvidenceAnswer(ctx.content),
      answerKind: "refusal",
      usage: { promptTokens: 0, completionTokens: 0 },
    };
  }
  const observeCitationBehaviour = citationBehaviourObserverFor(
    ctx.deps,
    ctx.modelId,
    ctx.correlationId,
  );
  try {
    const assistant = normalizeGroundedAnswerPayload(
      await ctx.answerer(
        ctx.answerContent ?? ctx.content,
        retrieved.map((s) => ({ label: s.label, pack: s.pack })),
      ),
    );
    ensureNotCancelled(ctx.signal);
    const scopeIndex = verifiedPluralInsufficiencyScopeIndex(
      retrieved,
      assistant.content,
      assistant.sentEvidencePacks ?? [],
      ctx.insufficiencyScopeIndex,
    );
    const validated = {
      ...assistant,
      insufficiencyDeclarations: undefined,
      ...validateGroundedAnswerEvidence(assistant.content, scopeIndex, ctx.content),
    };
    return await repairMultiSourceAnswer(
      ctx,
      retrieved,
      validated,
      startedAtMs,
      observeCitationBehaviour,
    );
  } catch (error) {
    return mapMultiSourceError(error, ctx.deps, ctx.correlationId);
  }
}

interface RepairedMultiSourceAnswer extends GroundedAnswerResult {
  readonly citationRepairDisposition?: CitationRepairDisposition;
}

function multiSourceInsufficiencyObservation(
  assistant: GroundedAnswerResult,
): CitationReconciliationMetadata {
  const counts = assistant.insufficiencyObservation;
  return counts === undefined
    ? {}
    : {
        insufficiencyDeclaredCount: counts.declaredCount,
        declaredInScopeCount: counts.inScopeCount,
        declaredUnreadInScopeCount: counts.unreadInScopeCount,
        declaredNotInScopeCount: counts.notInScopeCount,
      };
}

function multiSourceRepairPack(
  ctx: MultiSourceAskInput,
  sources: readonly RetrievedSource[],
): ConnectedContextPack | undefined {
  const first = sources[0]?.pack;
  if (first === undefined) return undefined;
  const budget = modelWindowAwareBudget(ctx.deps, ctx.modelId);
  const elapsedLimits = [
    budget.elapsedMsMax,
    ...sources.map((source) => source.pack.budget.elapsedMsMax),
  ].filter((limit): limit is number => limit !== null);
  return {
    ...first,
    usage: {
      ...first.usage,
      modelInputTokens: sources.reduce(
        (sum, source) => sum + source.pack.usage.modelInputTokens,
        0,
      ),
      modelOutputTokens: sources.reduce(
        (sum, source) => sum + source.pack.usage.modelOutputTokens,
        0,
      ),
    },
    budget: {
      ...budget,
      elapsedMsMax: elapsedLimits.length === 0 ? null : Math.min(...elapsedLimits),
      modelInputTokensMax: Math.min(
        budget.modelInputTokensMax,
        sources.reduce((sum, source) => sum + source.pack.budget.modelInputTokensMax, 0),
      ),
      modelOutputTokensMax: Math.min(
        budget.modelOutputTokensMax,
        sources.reduce((sum, source) => sum + source.pack.budget.modelOutputTokensMax, 0),
      ),
    },
  };
}

async function repairMultiSourceAnswer(
  ctx: MultiSourceAskInput,
  sources: readonly RetrievedSource[],
  assistant: GroundedAnswerResult,
  startedAtMs: number,
  observeCitationBehaviour: ReturnType<typeof citationBehaviourObserverFor>,
): Promise<RepairedMultiSourceAnswer> {
  const pack = multiSourceRepairPack(ctx, sources);
  if (pack === undefined) return assistant;
  let budgetRefused = false;
  const repair = ctx.answerer.repair;
  const repairContext = {
    question: ctx.answerContent ?? ctx.content,
    pack,
    answer: assistant,
    nowMs: Date.now,
    ...(pack.budget.elapsedMsMax === null
      ? {}
      : { deadlineAtMs: startedAtMs + pack.budget.elapsedMsMax }),
    ...(repair === undefined
      ? {}
      : {
          invokeRepair: async (
            original: string,
            options: GroundedAnswerOptions,
          ): Promise<GroundedAnswerPayload> => {
            const result = normalizeGroundedAnswerPayload(
              await repair(ctx.answerContent ?? ctx.content, pack, original, options),
            );
            budgetRefused = result.modelInvoked === false;
            return result;
          },
        }),
    deps: {
      answerer: pluralSynthesisMetadata(ctx.answerer),
      signal: ctx.signal,
      reliableCitationBehaviour: citationBehaviourFor(ctx.deps, ctx.modelId),
      observeCitationBehaviour,
    },
  };
  const repaired = await repairGroundedAnswer(repairContext);
  const finalAnswer = finalPluralRepairAnswer(repairContext, repaired, budgetRefused);
  recordMultiSourceRepair(sources, finalAnswer, ctx.correlationId, repaired.failure);
  return finalAnswer;
}

function recordMultiSourceRepair(
  sources: readonly RetrievedSource[],
  answer: GroundedAnswerResult & { readonly citationRepairDisposition: CitationRepairDisposition },
  correlationId: string | undefined,
  failure: unknown,
): void {
  recordPluralGroundedAnswer(
    sources.map((source) => source.pack),
    answer,
    answer.citationRepairDisposition,
    correlationId,
    failure,
  );
}

export function finalPluralRepairAnswer(
  context: GroundedRepairContext,
  repaired: GroundedRepairResult,
  budgetRefused: boolean,
): GroundedAnswerResult & { readonly citationRepairDisposition: CitationRepairDisposition } {
  return {
    ...observeGroundedCitationBehaviour({ ...context, answer: repaired.answer }),
    citationRepairDisposition: budgetRefused ? "skipped-budget" : repaired.disposition,
  };
}

function declarationMatchesScope(path: string, scope: SelectedScope): boolean {
  if (scope.kind === "workspace-root") return true;
  return scope.relativePaths.some(
    (selected) =>
      path === selected || (scope.kind === "directory" && path.startsWith(`${selected}/`)),
  );
}

function pluralAnswerForPack(
  pack: ConnectedContextPack,
  packs: readonly ConnectedContextPack[],
  answer: GroundedAnswerResult,
): GroundedAnswerResult {
  const sent = (answer.sentEvidencePacks ?? []).filter(
    (entry) =>
      entry.scope.scopeId === pack.scope.scopeId &&
      entry.scope.workspaceRoot === pack.scope.workspaceRoot,
  );
  const declarations = (answer.insufficiencyDeclarations ?? []).filter((declaration) => {
    const matches = packs.filter((entry) =>
      declarationMatchesScope(declaration.scopePath, entry.scope),
    );
    return matches.length === 1 && matches[0] === pack;
  });
  return {
    ...answer,
    sentEvidencePacks: sent,
    filesInPrompt: sentGroundedFileCount(sent),
    insufficiencyDeclarations: declarations,
    insufficiencyObservation: {
      declaredCount: declarations.length,
      inScopeCount: declarations.length,
      unreadInScopeCount: declarations.filter(
        (declaration) => declaration.state === "unread-in-scope",
      ).length,
      notInScopeCount: 0,
    },
  };
}

export function recordPluralGroundedAnswer(
  packs: readonly ConnectedContextPack[],
  answer: GroundedAnswerResult,
  disposition: CitationRepairDisposition,
  correlationId: string | undefined,
  failure?: unknown,
): void {
  for (const pack of packs)
    logGroundedAnswerForPack(
      pack,
      pluralAnswerForPack(pack, packs, answer),
      disposition,
      correlationId,
      failure,
    );
}

export function recordPluralCitationRepairFailure(
  deps: Pick<UiHandlerDeps, "diagnostics" | "redactor">,
  correlationId: string | undefined,
  error: unknown,
): void {
  emitServerDiagnostic(deps.diagnostics, {
    ...serverDiagnosticFromError({
      correlationId: correlationIdOrUnknown(correlationId),
      operation: "POST /api/chats/messages/grounded",
      source: "grounded.qa.citation-repair",
      error,
      redact: (message): string => deps.redactor(message) as string,
    }),
    code: "GROUNDED_CITATION_REPAIR_FAILED",
  });
}

function mapMultiSourceError(
  error: unknown,
  deps: UiHandlerDeps,
  correlationId: string | undefined,
): RouteResult {
  if (error instanceof ClarificationNeededError) {
    return clarificationRequest(clarificationUserMessage(error));
  }
  const workspaceResult = mappedWorkspaceError(error, { correlationId });
  if (workspaceResult !== undefined) return workspaceResult;
  // The request's correlation, so a local refusal's diagnostic joins the ask (PR #3678 review).
  const gatewayResult = mappedGatewayError(error, deps, correlationId);
  if (gatewayResult !== undefined) return gatewayResult;
  throw error;
}
