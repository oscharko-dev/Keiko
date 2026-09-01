// Grounded repository Q&A orchestrator (Epic #177, Issue #185). Composes the connected-context
// layers — #181 exploration planner, #179 lexical search facade, #180 structural adapters,
// #182 candidate ranker, and #183 context-pack assembler — into a single linear pipeline that
// produces a redacted `ConnectedContextPack` plus an assistant-content string. The model call
// is injected through the `GroundedAnswerer` seam so production can route through the Model
// Gateway while tests can keep deterministic answerers.
//
// Pure orchestration: the only IO this module performs is delegated through the workspace
// package's already-bounded WorkspaceFs port. Path validation is enforced by every composed
// layer at its own boundary, so this file does not re-validate scope paths.

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  DEFAULT_EXPLORATION_BUDGET,
  isValidScopePath,
  type CandidateFile,
  type ConnectedContextPack,
  type ContextCoverageDiagnostics,
  type ContextPackDiagnostics,
  type EvidenceAtom,
  type ExplorationBudget,
  type ExplorationUsage,
  type OmittedContextEntry,
  type RetrievalQuery,
  type SelectedScope,
  type UncertaintyMarker,
  type UncertaintyMarkerKind,
} from "@oscharko-dev/keiko-contracts/connected-context";
import type { ContextProfile } from "@oscharko-dev/keiko-contracts";
import {
  advanceRing,
  applyUsage,
  assembleContextPack,
  canContinue,
  complete,
  contextPackIndexKey,
  planAndGovern,
  rankCandidates,
  type ClarificationPrompt,
  type ClarificationReason,
  type ExcerptWindow,
  type ExplorationPlan,
  type GovernorState,
  type MicroIndex,
  type RerankerExecutionContext,
  type RerankerSeam,
  type RetrievalIntent,
  type RetrievalRing,
  type SearchAnchor,
} from "@oscharko-dev/keiko-workflows";
import {
  CANONICAL_MANIFEST_BASENAMES,
  DEFAULT_SEARCH_LIMITS,
  FileTooLargeError,
  PathDeniedError,
  RepoSearchUnsupportedFileError,
  WorkspaceNotFoundError,
  detectWorkspaceAt,
  endpointContractAdapter,
  gitHistoryAdapter,
  isCanonicalMetadataFile,
  isEcosystemSourceFile,
  isDenied,
  readExcerpt,
  resolveWithinWorkspace,
  searchText,
  symbolGraphAdapter,
  type SearchLimits,
  type SearchResult,
  type SearchScope,
  type SemanticSearchProvider,
  type WorkspaceDirEntry,
  type WorkspaceFs,
  type WorkspaceIndex,
  type WorkspaceIndexPreparationReport,
  type WorkspaceInfo,
  type WorkspaceStat,
  containedRealPathInfo,
  evidenceAtomStableId,
} from "@oscharko-dev/keiko-workspace";
import {
  isAllowedContainedPathParent,
  isCanonicalAllowedContainedPath,
} from "@oscharko-dev/keiko-workspace/internal/realpath-policy";
import {
  createStructuralAdapterRequestContext,
  createEcosystemStructureAdapters,
  importGraphAdapter,
  runStructuralAdapters,
  type StructuralAdapterRequestContext,
  type StructuralRequestContextDiagnostics,
  type StructuralAdapterRegistry,
  type StructuralCoverageDiagnostics,
  testSourcePairingAdapter,
} from "@oscharko-dev/keiko-workspace/code-intelligence";
import { CancelledError, ERROR_CODES } from "@oscharko-dev/keiko-model-gateway";
import {
  isWorkspacePathSnapshotCurrent,
  nodeWorkspaceFs,
  type WorkspaceDescriptorReadCompleteness,
  type WorkspaceDescriptorUtf8Read,
  type WorkspaceFileReader,
  type WorkspaceHardLinkPolicy,
} from "@oscharko-dev/keiko-workspace/internal/fs";
import { preserveOwnedRootAuthority } from "@oscharko-dev/keiko-workspace/internal/owned-root-preserve";
import {
  normalizeGroundedAnswerPayload,
  type GroundedAnswerPayload,
  type GroundedAnswerResult,
} from "./grounded-answer.js";
import {
  GROUNDED_NO_EVIDENCE_ANSWER,
  buildPackCitationIndex,
  incompleteAnswerMarker,
  missingCitationMarker,
  noEvidenceMarker,
  packHasUsableEvidence,
  reconcileInlineCitations,
  unsupportedCitationMarker,
} from "./grounded-faithfulness.js";
import type { EntailmentStage } from "./grounded-entailment-stage.js";
import {
  collectDiscoveredSymbolTraceEvidence,
  collectFollowSymbolTraceEvidence,
  GROUNDED_TRACE_SEARCH_LIMITS,
} from "./grounded-symbol-trace.js";
import {
  defaultGitFileHistoryEvidenceProvider,
  type GitFileHistoryEvidenceProvider,
} from "./grounded-git-history-evidence.js";
import {
  collectConnectedDocumentEvidence,
  isConnectedDocumentPath,
  type DocumentEvidenceResult,
} from "./grounded-document-evidence.js";
import {
  selectGroundedCandidateFiles,
  selectGroundedEvidenceAtoms,
  tracePriority,
} from "./grounded-evidence-selection.js";
import { directDefinitionSymbol } from "./grounded-query-shape.js";
import { attachContextBudgetDiagnostics } from "./grounded-context-diagnostics.js";
import { correlationIdOrUnknown } from "./correlation.js";
import {
  createServerLogger,
  errorKindOf,
  reportServerLogFailure,
  startLogTimer,
  type ServerLogEvent,
  type ServerLogSink,
} from "./observability/index.js";
import { causeChain, keikoStackFrames } from "./observability/stack-frames.js";
import { processServerLogSink } from "./process-log-sink.js";
import { AbortDeadlineRaceError, raceAbortDeadline } from "./abort-race.js";
import { resolveRecordedWorkspaceRoot } from "./workspace-root-denial-log.js";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface GroundedAnswerer {
  // The seam the route uses: production supplies a Model Gateway-backed answerer, while tests can
  // keep deterministic answerers.
  answer(question: string, pack: ConnectedContextPack): Promise<GroundedAnswerPayload>;
}

export interface OrchestratorInput {
  readonly scope: SelectedScope;
  readonly query: RetrievalQuery;
  // The original query remains authoritative for every retrieval ring. Callers may supply a
  // separately assembled answer question (for example with governed memory context) so personal
  // context can inform generation without changing repository retrieval decisions.
  readonly answerQuestion?: string | undefined;
  readonly answerOnlyContextAvailable?: boolean | undefined;
  readonly workspaceRoot: string;
  // Request-scoped filesystem authority for the exact canonical root. Ordinary callers omit it;
  // managed-task callers receive it only after the lifecycle owner has re-proved the persisted
  // instance and paired app session. It is never serialized into evidence or wire payloads.
  readonly workspaceFs?: WorkspaceFs | undefined;
  readonly budget?: ExplorationBudget;
}

export interface OrchestratorDeps {
  readonly answerer: GroundedAnswerer;
  readonly nowMs?: () => number;
  readonly signal?: AbortSignal | undefined;
  // Activity evidence for the retrieval-only operation. Production resolves the shared process
  // sink; tests may inject a buffer without replacing the process-wide logger.
  readonly activityLog?: ServerLogSink | undefined;
  // Optional injected port for tests; production uses the realpath-contained node adapter.
  readonly fs?: WorkspaceFs;
  // Optional injected detector for tests so memFs fixtures don't need full WorkspaceInfo wiring.
  readonly detectWorkspace?: (root: string, fs: WorkspaceFs) => WorkspaceInfo;
  // Called after a ready plan exists and before any workspace detection or repository IO starts.
  readonly recordPlan?: (plan: ExplorationPlan) => void;
  // Ephemeral #183 context-pack cache for one connected scope/session.
  readonly microIndex?: MicroIndex;
  readonly contextPackReranker?: RerankerSeam | undefined;
  readonly repoSemanticSearchProvider?: SemanticSearchProvider | undefined;
  readonly gitFileHistoryEvidence?: GitFileHistoryEvidenceProvider | undefined;
  // ADR-0173 D5 — the request-scoped correlation id, already carried this far for the Gateway
  // answerer. Threaded on to the git-history evidence provider so a git read that silently emptied
  // this ask's history ring is joinable to the ask itself in `server.log` (AGENTS.md §8 Rule 1).
  //
  // REQUIRED, not optional-with-a-fallback. Three production paths reach retrieval — single-folder,
  // multi-source and hybrid — and each builds this object by hand. Two of them shipped without the
  // id and stamped every git-history failure `UNKNOWN_CORRELATION_ID`, which type-checked perfectly
  // because the field was optional. `undefined` is still an accepted VALUE (a caller genuinely
  // without a request id says so explicitly, and the provider falls back at the emitting site);
  // what the compiler now refuses is a call site that never considered it.
  readonly correlationId: string | undefined;
  // Optional context profile (ADR-0055 D1, PR4-W1). When absent (legacy callers, multi-source and
  // hybrid paths in W1), the diagnostics observer is NOT invoked and the assembled pack is
  // byte-identical to today. When present, the observer attaches ContextAssemblyDiagnostics-derived
  // ContextBudget to pack.diagnostics.contextBudget? — an additive field no prompt builder reads.
  readonly contextProfile?: ContextProfile | undefined;
  // Issue #1736 — optional production index provider. Tests and unsupported runtime dirs omit it;
  // the lexical ring falls back to bounded live scans.
  readonly workspaceIndexForRoot?:
    ((workspaceRoot: string) => WorkspaceIndex | undefined) | undefined;
  readonly semanticSearchProvider?: SemanticSearchProvider | undefined;
  // Knowledge M1.2 (#2563) — optional injected entailment stage. When present AND a compatible judge
  // model is configured, the model's cited claims are judged for SUPPORT (not just membership) after
  // answering, and any unsupported-claim / entailment-unavailable markers are appended to the pack's
  // uncertainty. Absent (the default, and every legacy caller/test) ⇒ byte-identical to today.
  readonly entailmentStage?: EntailmentStage | undefined;
}

export interface OrchestratorOutput {
  readonly pack: ConnectedContextPack;
  readonly assistantContent: string;
  readonly elapsedMs: number;
  readonly plan?: ExplorationPlan;
  // GEN-AI-GROUNDING-002/-003 (RB-4): true when the folder path ABSTAINED because the assembled
  // pack carried no usable evidence. The model was NOT called; assistantContent is the deterministic
  // no-evidence answer. Callers must suppress citations and skip persisting grounded evidence.
  readonly noEvidence?: boolean;
  // Distinguishes a deterministic no-evidence abstention from an answer generated over explicit
  // answer-only context. Citation and entailment checks follow model invocation; evidence
  // persistence follows source availability.
  readonly modelInvoked?: boolean;
}

// Epic #532 — retrieval-only output. The multi-source (1+N) path runs retrieval per connected
// source, then answers ONCE over the merged packs, so it needs the pack without a per-scope
// answer. `elapsedMs` here is retrieval-only wall time (no model call), distinct from
// OrchestratorOutput.elapsedMs which also includes the answer.
export interface RetrievalOnlyOutput {
  readonly pack: ConnectedContextPack;
  readonly elapsedMs: number;
  readonly plan: ExplorationPlan;
}

// Raised when the planner asks for clarification (no anchors, too-generic prompt, etc.). The
// route maps this to a 400 BAD_REQUEST via clarificationUserMessage below; the Error message
// itself keeps the stable machine-ish form for logs and tests.
export class ClarificationNeededError extends Error {
  public constructor(public readonly clarification: ClarificationPrompt) {
    super(`clarification needed: ${clarification.reason}`);
    this.name = "ClarificationNeededError";
  }
}

// Release 0.2.0 — user-facing mapping for a planner clarification. The raw reason string
// ("clarification needed: too-generic") told the user nothing actionable; the HTTP message now
// says what the planner needs and folds in the planner's own suggested questions. Static text
// plus planner-built suggestions only — no user/file content, so nothing to redact.
function clarificationIntro(reason: ClarificationReason): string {
  if (reason === "scope-empty") return "Die verbundene Quelle enthält nichts Durchsuchbares.";
  if (reason === "scope-invalid") return "Die verbundene Quelle konnte nicht durchsucht werden.";
  return "Keiko braucht mehr Kontext, um die verbundenen Quellen gezielt zu durchsuchen.";
}

export function clarificationUserMessage(error: ClarificationNeededError): string {
  const { reason, suggestedQuestions } = error.clarification;
  const intro = clarificationIntro(reason);
  const anchorHint =
    reason === "no-anchors" || reason === "too-generic"
      ? " Nenne eine konkrete Datei, einen Identifier, eine Fehlermeldung oder eine exakte Phrase."
      : "";
  const examples = suggestedQuestions.slice(0, 2);
  const quotedExamples = examples.map((q) => `"${q}"`).join(" oder ");
  const exampleText = examples.length > 0 ? ` Zum Beispiel: ${quotedExamples}` : "";
  return `${intro}${anchorHint}${exampleText}`;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

interface SearchInputs {
  readonly searchScope: SearchScope;
  readonly query: RetrievalQuery;
  readonly anchors: readonly SearchAnchor[];
  readonly retrievalIntent: RetrievalIntent;
  readonly fs: WorkspaceFs;
  readonly nowMs: () => number;
  readonly signal?: AbortSignal | undefined;
  readonly workspaceIndex?: WorkspaceIndex | undefined;
  readonly workspaceIndexActivity: WorkspaceIndexActivity;
  readonly repoSemanticSearchProvider?: SemanticSearchProvider | undefined;
  readonly gitFileHistoryEvidence: GitFileHistoryEvidenceProvider;
  readonly correlationId?: string | undefined;
  readonly structuralContexts: StructuralRequestContextPool;
  readonly deadlineAtMs: number;
}

interface StructuralRequestContextPoolDiagnostics extends StructuralRequestContextDiagnostics {
  readonly contextCount: number;
}

interface StructuralRequestContextPool {
  readonly forLimits: (limits: SearchLimits) => StructuralAdapterRequestContext;
  readonly diagnostics: () => StructuralRequestContextPoolDiagnostics;
}

type WorkspaceIndexProviderStatus = "not-evaluated" | "available" | "unavailable";
type WorkspaceIndexSearchMode =
  | "not-evaluated"
  | "unused"
  | "live-fallback"
  | "persistent-cold"
  | "persistent-warm"
  | "persistent-reconciled"
  | "request-local-cold"
  | "request-local-warm"
  | "request-local-reconciled";
type WorkspaceIndexLoadStatus = "not-attempted" | "hit" | "miss" | "mixed" | "failed";
type WorkspaceIndexSaveStatus = "not-attempted" | "succeeded" | "unfinished" | "failed";

interface WorkspaceIndexActivityDiagnostics extends WorkspaceIndexPreparationReport {
  readonly providerStatus: WorkspaceIndexProviderStatus;
  readonly searchMode: WorkspaceIndexSearchMode;
  readonly loadStatus: WorkspaceIndexLoadStatus;
  readonly saveStatus: WorkspaceIndexSaveStatus;
  readonly searchCount: number;
  readonly reportCount: number;
  readonly fallbackSearchCount: number;
  readonly loadAttempts: number;
  readonly loadHits: number;
  readonly loadMisses: number;
  readonly loadFailures: number;
  readonly saveAttempts: number;
  readonly saveSuccesses: number;
  readonly saveFailures: number;
}

interface MutableWorkspaceIndexActivityCounters {
  discoveredEntries: number;
  retainedEntries: number;
  indexedRecords: number;
  reusedRecords: number;
  staleRecords: number;
  skippedEntries: number;
  deletedEntries: number;
  droppedRecords: number;
  searchCount: number;
  reportCount: number;
  fallbackSearchCount: number;
  loadAttempts: number;
  loadHits: number;
  loadMisses: number;
  loadFailures: number;
  saveAttempts: number;
  saveSuccesses: number;
  saveFailures: number;
}

interface WorkspaceIndexActivity {
  readonly workspaceIndex: WorkspaceIndex | undefined;
  readonly recordSearchResult: (result: SearchResult) => void;
  readonly diagnostics: () => WorkspaceIndexActivityDiagnostics;
}

interface WorkspaceIoActivityDiagnostics {
  readonly readDirCalls: number;
  readonly readDirEntries: number;
  readonly statCalls: number;
  readonly realPathCalls: number;
  readonly existsCalls: number;
  readonly contentReadCalls: number;
  readonly contentReadBytes: number;
}

type MutableWorkspaceIoActivityCounters = {
  -readonly [Key in keyof WorkspaceIoActivityDiagnostics]: WorkspaceIoActivityDiagnostics[Key];
};

interface WorkspaceIoActivity {
  readonly fs: WorkspaceFs;
  readonly diagnostics: () => WorkspaceIoActivityDiagnostics;
}

function searchLimitsKey(limits: SearchLimits): string {
  return JSON.stringify([
    limits.maxFilesScanned,
    limits.maxMatchesReturned,
    limits.maxBytesPerFileScanned,
    limits.elapsedMsMax,
  ]);
}

function sumContextDiagnostics(
  contexts: readonly StructuralAdapterRequestContext[],
): StructuralRequestContextPoolDiagnostics {
  const values = contexts.map((context) => context.diagnostics());
  const sum = (key: keyof StructuralRequestContextDiagnostics): number =>
    values.reduce((total, value) => total + value[key], 0);
  return {
    contextCount: contexts.length,
    candidateInventoryBuildCount: sum("candidateInventoryBuildCount"),
    candidateFileCount: sum("candidateFileCount"),
    candidateDirectoryCount: sum("candidateDirectoryCount"),
    codeIndexBuildCount: sum("codeIndexBuildCount"),
    symbolGraphBuildCount: sum("symbolGraphBuildCount"),
    importGraphBuildCount: sum("importGraphBuildCount"),
    endpointGraphBuildCount: sum("endpointGraphBuildCount"),
    fileSearchCount: sum("fileSearchCount"),
    textSearchCount: sum("textSearchCount"),
  };
}

function emptyWorkspaceIndexActivityCounters(): MutableWorkspaceIndexActivityCounters {
  return {
    discoveredEntries: 0,
    retainedEntries: 0,
    indexedRecords: 0,
    reusedRecords: 0,
    staleRecords: 0,
    skippedEntries: 0,
    deletedEntries: 0,
    droppedRecords: 0,
    searchCount: 0,
    reportCount: 0,
    fallbackSearchCount: 0,
    loadAttempts: 0,
    loadHits: 0,
    loadMisses: 0,
    loadFailures: 0,
    saveAttempts: 0,
    saveSuccesses: 0,
    saveFailures: 0,
  };
}

function stoppedBeforeWorkspaceScan(result: SearchResult): boolean {
  return (
    result.workspaceIndex === undefined &&
    result.filesScanned === 0 &&
    result.diagnostics === undefined &&
    result.coverage.filesDiscovered === 0 &&
    result.coverage.reasons.some((reason) => reason === "aborted" || reason === "timeout")
  );
}

function addWorkspaceIndexResult(
  counters: MutableWorkspaceIndexActivityCounters,
  result: SearchResult,
): void {
  counters.searchCount += 1;
  const report = result.workspaceIndex;
  if (report === undefined) {
    if (!stoppedBeforeWorkspaceScan(result)) counters.fallbackSearchCount += 1;
    return;
  }
  counters.reportCount += 1;
  counters.discoveredEntries += report.discoveredEntries;
  counters.retainedEntries += report.retainedEntries;
  counters.indexedRecords += report.indexedRecords;
  counters.reusedRecords += report.reusedRecords;
  counters.staleRecords += report.staleRecords;
  counters.skippedEntries += report.skippedEntries;
  counters.deletedEntries += report.deletedEntries;
  counters.droppedRecords += report.droppedRecords;
}

function workspaceIndexPersistenceSucceeded(
  providerStatus: WorkspaceIndexProviderStatus,
  counters: MutableWorkspaceIndexActivityCounters,
): boolean {
  if (providerStatus !== "available") return false;
  return counters.loadHits > 0 || counters.saveSuccesses > 0;
}

function workspaceIndexSearchMode(
  providerStatus: WorkspaceIndexProviderStatus,
  counters: MutableWorkspaceIndexActivityCounters,
): WorkspaceIndexSearchMode {
  if (providerStatus === "not-evaluated") return "not-evaluated";
  if (counters.searchCount === 0) return "unused";
  if (counters.reportCount === 0) {
    return counters.fallbackSearchCount > 0 ? "live-fallback" : "unused";
  }
  const reconciled = counters.staleRecords + counters.deletedEntries + counters.droppedRecords > 0;
  const persistent = workspaceIndexPersistenceSucceeded(providerStatus, counters);
  if (reconciled) return persistent ? "persistent-reconciled" : "request-local-reconciled";
  if (counters.reusedRecords > 0) return persistent ? "persistent-warm" : "request-local-warm";
  return persistent ? "persistent-cold" : "request-local-cold";
}

function workspaceIndexLoadStatus(
  counters: MutableWorkspaceIndexActivityCounters,
): WorkspaceIndexLoadStatus {
  if (counters.loadFailures > 0) return "failed";
  if (counters.loadHits > 0 && counters.loadMisses > 0) return "mixed";
  if (counters.loadHits > 0) return "hit";
  if (counters.loadMisses > 0) return "miss";
  return "not-attempted";
}

function workspaceIndexSaveStatus(
  counters: MutableWorkspaceIndexActivityCounters,
): WorkspaceIndexSaveStatus {
  if (counters.saveFailures > 0) return "failed";
  if (counters.saveSuccesses > 0) return "succeeded";
  return counters.saveAttempts > 0 ? "unfinished" : "not-attempted";
}

function workspaceIndexActivityDiagnostics(
  providerStatus: WorkspaceIndexProviderStatus,
  counters: MutableWorkspaceIndexActivityCounters,
): WorkspaceIndexActivityDiagnostics {
  return {
    providerStatus,
    searchMode: workspaceIndexSearchMode(providerStatus, counters),
    loadStatus: workspaceIndexLoadStatus(counters),
    saveStatus: workspaceIndexSaveStatus(counters),
    ...counters,
  };
}

function observedWorkspaceIndex(
  source: WorkspaceIndex,
  counters: MutableWorkspaceIndexActivityCounters,
): WorkspaceIndex {
  return {
    loadSnapshot: async (scopeKey): ReturnType<WorkspaceIndex["loadSnapshot"]> => {
      counters.loadAttempts += 1;
      try {
        const snapshot = await source.loadSnapshot(scopeKey);
        if (snapshot === undefined) counters.loadMisses += 1;
        else counters.loadHits += 1;
        return snapshot;
      } catch (error) {
        counters.loadFailures += 1;
        throw error;
      }
    },
    saveSnapshot: async (scopeKey, snapshot): Promise<void> => {
      counters.saveAttempts += 1;
      try {
        await source.saveSnapshot(scopeKey, snapshot);
        counters.saveSuccesses += 1;
      } catch (error) {
        counters.saveFailures += 1;
        throw error;
      }
    },
  };
}

function createWorkspaceIndexActivity(source: WorkspaceIndex | undefined): WorkspaceIndexActivity {
  const providerStatus = source === undefined ? "unavailable" : "available";
  const counters = emptyWorkspaceIndexActivityCounters();
  return {
    workspaceIndex: source === undefined ? undefined : observedWorkspaceIndex(source, counters),
    recordSearchResult: (result): void => {
      addWorkspaceIndexResult(counters, result);
    },
    diagnostics: (): WorkspaceIndexActivityDiagnostics =>
      workspaceIndexActivityDiagnostics(providerStatus, counters),
  };
}

function observedStructuralContext(
  context: StructuralAdapterRequestContext,
  activity: WorkspaceIndexActivity,
): StructuralAdapterRequestContext {
  return {
    assertGraphBinding: context.assertGraphBinding.bind(context),
    candidatePaths: context.candidatePaths.bind(context),
    skippedSymbolicLinks: context.skippedSymbolicLinks.bind(context),
    candidateLimitReached: context.candidateLimitReached.bind(context),
    codeIntelligenceIndex: context.codeIntelligenceIndex.bind(context),
    symbolGraph: context.symbolGraph.bind(context),
    importGraph: context.importGraph.bind(context),
    endpointContractGraph: context.endpointContractGraph.bind(context),
    findFiles: context.findFiles.bind(context),
    searchText: async (
      query,
      limits,
      deps,
    ): ReturnType<StructuralAdapterRequestContext["searchText"]> => {
      const result = await context.searchText(query, limits, deps);
      activity.recordSearchResult(result);
      return result;
    },
    diagnostics: context.diagnostics.bind(context),
  };
}

function createStructuralRequestContextPool(
  scope: SearchScope,
  fs: WorkspaceFs,
  nowMs: () => number,
  deadlineAtMs: number,
  workspaceIndexActivity: WorkspaceIndexActivity,
  signal?: AbortSignal,
): StructuralRequestContextPool {
  const contexts = new Map<string, StructuralAdapterRequestContext>();
  return {
    forLimits: (limits): StructuralAdapterRequestContext => {
      const key = searchLimitsKey(limits);
      const existing = contexts.get(key);
      if (existing !== undefined) return existing;
      const created = observedStructuralContext(
        createStructuralAdapterRequestContext(scope, limits, fs, {
          nowMs,
          deadlineAtMs,
          ...(signal === undefined ? {} : { signal }),
        }),
        workspaceIndexActivity,
      );
      contexts.set(key, created);
      return created;
    },
    diagnostics: (): StructuralRequestContextPoolDiagnostics =>
      sumContextDiagnostics([...contexts.values()]),
  };
}

interface RingResult {
  readonly atoms: readonly EvidenceAtom[];
  readonly omitted: readonly OmittedContextEntry[];
  readonly uncertainty: readonly UncertaintyMarker[];
  readonly usage: ExplorationUsage;
  // Explainable-ranking diagnostics from the lexical ring's candidate ordering (M2). Only the
  // lexical ring populates this; structural/git rings leave it undefined.
  readonly diagnostics?: ContextPackDiagnostics | undefined;
}

// Maps the workspace-layer SearchDiagnostics.rankedCandidates onto the contract pack-diagnostics
// shape. Structurally identical (path/bucket/score/ecosystem/signals) but mapped explicitly so the
// workspace and contracts types stay decoupled. Coverage may still be present when ranking is absent.
function toPackDiagnostics(result: Awaited<ReturnType<typeof searchText>>): ContextPackDiagnostics {
  const diagnostics = result.diagnostics;
  const coverage = (result as { readonly coverage?: ContextCoverageDiagnostics }).coverage;
  const coverageDiagnostics = coverage === undefined ? {} : { coverage };
  if (diagnostics === undefined) {
    return {
      rankedCandidates: [],
      ...coverageDiagnostics,
    };
  }
  return {
    rankedCandidates: diagnostics.rankedCandidates.map((entry) => ({
      scopePath: entry.scopePath,
      bucket: entry.bucket,
      score: entry.score,
      ecosystem: entry.ecosystem,
      signals: entry.signals.map((signal) => ({ name: signal.name, value: signal.value })),
    })),
    ...coverageDiagnostics,
  };
}

function coverageUncertainty(
  result: Awaited<ReturnType<typeof searchText>>,
  nowMs: number,
): readonly UncertaintyMarker[] {
  const coverage = result.coverage;
  if (!coverage.incomplete) {
    return [];
  }
  const diagnostics = result.diagnostics;
  const details =
    diagnostics === undefined
      ? `scanned ${String(coverage.filesScanned)} file(s), reasons ${coverage.reasons.join(", ")}`
      : [
          `reasons ${coverage.reasons.join(", ")}`,
          `discovered ${String(coverage.filesDiscovered)} file(s)`,
          `kept ${String(coverage.filesAfterPolicy)} after policy`,
          `scanned ${String(coverage.filesScanned)}`,
          `oversized-prefix ${String(coverage.oversizedFilesScanned ?? 0)}`,
          `low-value-rescue-discovered ${String(coverage.lowValueRescueFilesDiscovered ?? 0)}`,
          `low-value-rescue-scanned ${String(coverage.lowValueRescueFilesScanned ?? 0)}`,
          `ignored ${String(coverage.ignoredByDiscovery)}`,
          `denied ${String(coverage.deniedByDiscovery)}`,
          `depth-pruned ${String(coverage.depthPrunedByDiscovery)}`,
          `max-files-pruned ${String(coverage.maxFilesPrunedByDiscovery)}`,
        ].join(", ");
  return [
    {
      kind: "scope-incomplete",
      claim: `repository search coverage was incomplete (${details}); relevant files may be missing from the context pack`,
      impactedAtomIds: [],
      emittedAtMs: nowMs,
    },
  ];
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new CancelledError("grounded repository request cancelled");
  }
}

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function usageDelta(overrides: Partial<ExplorationUsage> = {}): ExplorationUsage {
  return {
    searchCalls: 0,
    filesRead: 0,
    excerptBytes: 0,
    modelInputTokens: 0,
    modelOutputTokens: 0,
    elapsedMs: 0,
    rerankCalls: 0,
    ...overrides,
  };
}

function clampUsageToBudget(usage: ExplorationUsage, budget: ExplorationBudget): ExplorationUsage {
  return {
    searchCalls: Math.min(usage.searchCalls, budget.searchCallsMax),
    filesRead: Math.min(usage.filesRead, budget.filesReadMax),
    excerptBytes: Math.min(usage.excerptBytes, budget.excerptBytesMax),
    modelInputTokens: Math.min(usage.modelInputTokens, budget.modelInputTokensMax),
    modelOutputTokens: Math.min(usage.modelOutputTokens, budget.modelOutputTokensMax),
    elapsedMs: Math.min(usage.elapsedMs, budget.elapsedMsMax),
    rerankCalls: Math.min(usage.rerankCalls, budget.rerankCallsMax),
  };
}

function budgetClipped(stopReason: string, nowMs: number): UncertaintyMarker {
  return {
    kind: "budget-clipped",
    claim: `repository exploration stopped: ${stopReason}`,
    impactedAtomIds: [],
    emittedAtMs: nowMs,
  };
}

function answerBudgetClipped(dimensions: readonly string[], nowMs: number): UncertaintyMarker {
  return {
    kind: "budget-clipped",
    claim: `grounded answer exceeded budget: ${dimensions.join(", ")}`,
    impactedAtomIds: [],
    emittedAtMs: nowMs,
  };
}

// Delegates to the shared marker factory so all three grounding topologies emit byte-identical
// no-evidence claims (KEIKO-0196). This used to be a hand-copied duplicate of the same literal,
// which is why grounded-faithfulness.ts's noEvidenceMarker had zero production call sites.
function noEvidence(nowMs: number): UncertaintyMarker {
  return noEvidenceMarker(nowMs);
}

function toolUnavailable(claim: string, nowMs: number): UncertaintyMarker {
  return {
    kind: "tool-unavailable",
    claim,
    impactedAtomIds: [],
    emittedAtMs: nowMs,
  };
}

function readBudgetStopReason(budget: ExplorationBudget): string | undefined {
  const exhausted = [
    ...(budget.filesReadMax <= 0 ? ["filesRead"] : []),
    ...(budget.excerptBytesMax <= 0 ? ["excerptBytes"] : []),
  ];
  if (exhausted.length === 0) {
    return undefined;
  }
  return `budget-exhausted on ${exhausted.join(", ")}`;
}

function omittedFromSearchCandidates(
  candidates: readonly CandidateFile[],
  nowMs: number,
): readonly OmittedContextEntry[] {
  const omitted: OmittedContextEntry[] = [];
  for (const candidate of candidates) {
    if (candidate.omitted === undefined) {
      continue;
    }
    if (!isValidScopePath(candidate.scopePath, { mustBeRelative: true })) {
      continue;
    }
    omitted.push({
      scopePath: candidate.scopePath,
      reason: candidate.omitted,
      omittedAtMs: nowMs,
    });
  }
  return omitted;
}

function safeAdapterName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, "");
  return cleaned.length === 0 ? "structural-adapter" : cleaned;
}

function structuralCoverageMarker(
  coverage: StructuralCoverageDiagnostics,
  nowMs: number,
): UncertaintyMarker | undefined {
  const partiallyIndexed = coverage.filesPartiallyIndexed ?? 0;
  if (
    coverage.filesSkipped <= 0 &&
    partiallyIndexed <= 0 &&
    coverage.candidateLimitReached !== true
  ) {
    return undefined;
  }
  const safeName = safeAdapterName(coverage.name);
  return {
    kind: "scope-incomplete",
    claim:
      `structural adapter coverage was incomplete: ${safeName} indexed ` +
      `${String(coverage.filesIndexed)} file(s), skipped ${String(
        coverage.filesSkipped,
      )} file(s), partially indexed ${String(
        partiallyIndexed,
      )} file(s), candidate limit reached=${String(
        coverage.candidateLimitReached === true,
      )}; structural edges may be missing from the context pack`,
    impactedAtomIds: [],
    emittedAtMs: nowMs,
  };
}

function adapterDiagnostics(
  result: {
    readonly unavailable: readonly string[];
    readonly errored: readonly { readonly name: string }[];
    readonly coverage?: readonly StructuralCoverageDiagnostics[] | undefined;
  },
  nowMs: number,
): readonly UncertaintyMarker[] {
  const markers: UncertaintyMarker[] = [];
  const seen = new Set<string>();
  for (const name of result.unavailable) {
    const safeName = safeAdapterName(name);
    if (seen.has(`unavailable:${safeName}`)) {
      continue;
    }
    seen.add(`unavailable:${safeName}`);
    markers.push(toolUnavailable(`structural adapter unavailable: ${safeName}`, nowMs));
  }
  for (const error of result.errored) {
    const safeName = safeAdapterName(error.name);
    if (seen.has(`errored:${safeName}`)) {
      continue;
    }
    seen.add(`errored:${safeName}`);
    markers.push(toolUnavailable(`structural adapter failed safely: ${safeName}`, nowMs));
  }
  for (const coverage of result.coverage ?? []) {
    const marker = structuralCoverageMarker(coverage, nowMs);
    if (marker === undefined) continue;
    const key = `${marker.kind}:${marker.claim}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    markers.push(marker);
  }
  return markers;
}

function dedupeUncertainty(markers: readonly UncertaintyMarker[]): readonly UncertaintyMarker[] {
  const seen = new Set<string>();
  const out: UncertaintyMarker[] = [];
  for (const marker of markers) {
    const key = `${marker.kind}:${marker.claim}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(marker);
  }
  return out;
}

function suppressGitMetadataAdapterDiagnostics(
  markers: readonly UncertaintyMarker[],
  gitFileAtomCount: number,
): readonly UncertaintyMarker[] {
  if (gitFileAtomCount === 0) {
    return markers;
  }
  return markers.filter((marker) => !marker.claim.includes("git-history"));
}

function anchorKindForTerm(
  term: string,
  anchors: readonly SearchAnchor[],
): SearchAnchor["kind"] | undefined {
  return anchors.find((anchor) => anchor.term === term)?.kind;
}

function looksPathAnchor(term: string): boolean {
  return term.includes("/") || /\.[a-z0-9]+$/i.test(term);
}

function queryForStructuralAnchor(
  term: string,
  kind: SearchAnchor["kind"] | undefined,
  base: RetrievalQuery,
): RetrievalQuery {
  return {
    ...base,
    kind:
      kind === "identifier" || (!looksPathAnchor(term) && kind !== "path")
        ? "exact-symbol"
        : "natural-language",
    text: term,
  };
}

function structuralQueriesForRing(
  ring: RetrievalRing,
  inputs: SearchInputs,
): readonly RetrievalQuery[] {
  if (queryTargetsRouteImplementation(inputs.query.text)) {
    return [inputs.query];
  }
  const queries: RetrievalQuery[] = [];
  const seen = new Set<string>();
  for (const term of ring.anchorTerms) {
    const anchorKind = anchorKindForTerm(term, inputs.anchors);
    if (anchorKind !== "path" && anchorKind !== "identifier" && anchorKind !== "quoted") {
      continue;
    }
    const query = queryForStructuralAnchor(term, anchorKind, inputs.query);
    const key = `${query.kind}:${query.text}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    queries.push(query);
  }
  return queries.length === 0 ? [inputs.query] : queries;
}

const MAX_STRUCTURAL_FOLLOW_UP_QUERIES = 6;

function plannedSearchCallsForRing(ring: RetrievalRing, inputs: SearchInputs): number {
  if (ring.kind !== "structural") return 1;
  const followUpCount = queryTargetsRouteImplementation(inputs.query.text)
    ? 0
    : MAX_STRUCTURAL_FOLLOW_UP_QUERIES;
  return structuralQueriesForRing(ring, inputs).length + followUpCount;
}

function mergeAtomsByStableId(
  results: readonly RunRingStructuralResult[],
  cap: number,
): readonly EvidenceAtom[] {
  const atoms: EvidenceAtom[] = [];
  const seen = new Set<string>();
  for (const result of results) {
    for (const atom of result.atoms) {
      if (atoms.length >= cap) {
        return atoms;
      }
      if (seen.has(atom.stableId)) {
        continue;
      }
      seen.add(atom.stableId);
      atoms.push(atom);
    }
  }
  return atoms;
}

function isGitMetadataPath(scopePath: string): boolean {
  return scopePath === ".git" || scopePath.startsWith(".git/");
}

function isRankableFileAtom(
  atom: EvidenceAtom,
  inputs: SearchInputs,
  existsCache: FileExistenceCache,
): boolean {
  return (
    isValidScopePath(atom.scopePath, { mustBeRelative: true }) &&
    !isGitMetadataPath(atom.scopePath) &&
    !isDenied(atom.scopePath) &&
    fileExistsInSearchScope(inputs.searchScope, inputs.fs, atom.scopePath, existsCache)
  );
}

interface RunRingStructuralResult {
  readonly atoms: readonly EvidenceAtom[];
  readonly unavailable: readonly string[];
  readonly errored: readonly { readonly name: string }[];
  readonly coverage: readonly StructuralCoverageDiagnostics[];
  readonly elapsedMs: number;
}

function structuralFollowUpQueries(
  atoms: readonly EvidenceAtom[],
  base: RetrievalQuery,
): readonly RetrievalQuery[] {
  const queries: RetrievalQuery[] = [];
  const seen = new Set<string>([`${base.kind}:${base.text}`]);
  const push = (text: string | undefined, kind: SearchAnchor["kind"]): void => {
    const clean = text?.trim();
    if (
      clean === undefined ||
      clean.length === 0 ||
      queries.length >= MAX_STRUCTURAL_FOLLOW_UP_QUERIES
    ) {
      return;
    }
    const query = queryForStructuralAnchor(clean, kind, base);
    const key = `${query.kind}:${query.text}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    queries.push(query);
  };
  for (const atom of atoms) {
    const edge = atom.edge;
    if (edge === undefined) {
      continue;
    }
    push(edge.target.scopePath, "path");
    push(edge.target.symbol, "identifier");
    push(edge.source.scopePath, "path");
    push(edge.source.symbol, "identifier");
    if (queries.length >= MAX_STRUCTURAL_FOLLOW_UP_QUERIES) {
      break;
    }
  }
  return queries;
}

function structuralEdgeTargetAtoms(
  atoms: readonly EvidenceAtom[],
  inputs: SearchInputs,
): readonly EvidenceAtom[] {
  const out: EvidenceAtom[] = [];
  const seen = new Set<string>();
  const existsCache = createFileExistenceCache();
  const fs = cancellationGuardedWorkspaceFs(inputs.fs, inputs.signal);
  for (const atom of atoms) {
    throwIfCancelled(inputs.signal);
    if (inputs.nowMs() >= inputs.deadlineAtMs) break;
    const edge = atom.edge;
    if (edge === undefined) continue;
    const target = edge.target;
    if (
      target.scopePath === atom.scopePath ||
      !isValidScopePath(target.scopePath, { mustBeRelative: true }) ||
      isDenied(target.scopePath) ||
      !fileExistsInSearchScope(inputs.searchScope, fs, target.scopePath, existsCache)
    ) {
      continue;
    }
    const stableId = evidenceAtomStableId({
      scopeId: inputs.searchScope.scopeId,
      scopePath: target.scopePath,
      lineRange: target.lineRange,
      edge,
      provenanceKind: "structural",
      provenanceTool: "structural-edge-target",
      queryFingerprint: atom.provenance.queryFingerprint,
    });
    if (seen.has(stableId)) {
      continue;
    }
    seen.add(stableId);
    out.push(structuralEdgeTargetAtom(atom, edge, stableId, inputs.nowMs));
  }
  return out;
}

function structuralEdgeTargetAtom(
  atom: EvidenceAtom,
  edge: NonNullable<EvidenceAtom["edge"]>,
  stableId: string,
  nowMs: () => number,
): EvidenceAtom {
  return {
    schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
    stableId,
    scopePath: edge.target.scopePath,
    lineRange: edge.target.lineRange,
    score: Math.max(0, Math.min(1, atom.score * 0.96)),
    provenance: {
      kind: "structural",
      tool: "structural-edge-target",
      queryFingerprint: atom.provenance.queryFingerprint,
    },
    edge,
    redactionState: "redacted",
    emittedAtMs: nowMs(),
    ledgerRef: undefined,
  };
}

function dedupeAtoms(atoms: readonly EvidenceAtom[], cap: number): readonly EvidenceAtom[] {
  const out: EvidenceAtom[] = [];
  const seen = new Set<string>();
  for (const atom of atoms) {
    if (out.length >= cap) {
      break;
    }
    if (seen.has(atom.stableId)) {
      continue;
    }
    seen.add(atom.stableId);
    out.push(atom);
  }
  return out;
}

type NonLexicalRing = Omit<RetrievalRing, "kind"> & {
  readonly kind: "structural" | "git-history";
};

async function runLexicalRing(ring: RetrievalRing, inputs: SearchInputs): Promise<RingResult> {
  const definitionSymbol = directDefinitionSymbol(inputs.query, inputs.anchors);
  const query =
    definitionSymbol === undefined
      ? inputs.query
      : { ...inputs.query, kind: "exact-symbol" as const, text: definitionSymbol };
  const result = await searchText(inputs.searchScope, query, ring.searchLimits, {
    fs: inputs.fs,
    nowMs: inputs.nowMs,
    deadlineAtMs: inputs.deadlineAtMs,
    searchHints: { retrievalIntent: inputs.retrievalIntent },
    ...(inputs.signal === undefined ? {} : { signal: inputs.signal }),
    ...(inputs.workspaceIndex === undefined ? {} : { workspaceIndex: inputs.workspaceIndex }),
    ...(definitionSymbol === undefined && inputs.repoSemanticSearchProvider !== undefined
      ? { semanticSearchProvider: inputs.repoSemanticSearchProvider }
      : {}),
  });
  inputs.workspaceIndexActivity.recordSearchResult(result);
  // Lexical scanning is transient: each candidate file is read to match lines, then discarded.
  // It does NOT consume the excerpt budget; excerpt reads are charged later by the assembler.
  return {
    atoms: result.atoms,
    omitted: omittedFromSearchCandidates(result.candidates, inputs.nowMs()),
    uncertainty: coverageUncertainty(result, inputs.nowMs()),
    usage: usageDelta({ elapsedMs: result.elapsedMs }),
    diagnostics: toPackDiagnostics(result),
  };
}

function registryForRing(ring: NonLexicalRing): StructuralAdapterRegistry {
  // Keep the planner's ring split authoritative: the structural ring should only run the
  // structural adapters, while the git-history ring should only run the repo-level history
  // adapter. Reusing the full default registry for both rings duplicates atoms and inflates
  // downstream ranking signals whenever a workspace-root query plans both rings.
  return ring.kind === "structural"
    ? {
        adapters: [
          testSourcePairingAdapter,
          symbolGraphAdapter,
          importGraphAdapter,
          endpointContractAdapter,
          ...createEcosystemStructureAdapters(),
        ],
      }
    : { adapters: [gitHistoryAdapter] };
}

async function runAdapterQueries(
  registry: StructuralAdapterRegistry,
  ring: NonLexicalRing,
  queries: readonly RetrievalQuery[],
  inputs: SearchInputs,
  requestContext: StructuralAdapterRequestContext | undefined,
): Promise<readonly RunRingStructuralResult[]> {
  if (inputs.nowMs() >= inputs.deadlineAtMs) return [];
  return Promise.all(
    queries.map((query) =>
      runStructuralAdapters(registry, inputs.searchScope, query, ring.searchLimits, inputs.fs, {
        nowMs: inputs.nowMs,
        deadlineAtMs: inputs.deadlineAtMs,
        ...(inputs.signal === undefined ? {} : { signal: inputs.signal }),
        ...(requestContext === undefined ? {} : { requestContext }),
      }),
    ),
  );
}

async function runNonLexicalAdapters(
  ring: NonLexicalRing,
  inputs: SearchInputs,
): Promise<readonly RunRingStructuralResult[]> {
  const registry = registryForRing(ring);
  const queries =
    ring.kind === "structural" ? structuralQueriesForRing(ring, inputs) : [inputs.query];
  const requestContext =
    ring.kind === "structural" ? inputs.structuralContexts.forLimits(ring.searchLimits) : undefined;
  const results = await runAdapterQueries(registry, ring, queries, inputs, requestContext);
  const followUpQueries =
    ring.kind === "structural" &&
    inputs.nowMs() < inputs.deadlineAtMs &&
    !queryTargetsRouteImplementation(inputs.query.text)
      ? structuralFollowUpQueries(
          mergeAtomsByStableId(results, ring.searchLimits.maxMatchesReturned),
          inputs.query,
        )
      : [];
  const followUpResults = await runAdapterQueries(
    registry,
    ring,
    followUpQueries,
    inputs,
    requestContext,
  );
  return [...results, ...followUpResults];
}

async function gitFileAtomsForRing(
  ring: NonLexicalRing,
  inputs: SearchInputs,
  cap: number,
): Promise<{ readonly atoms: readonly EvidenceAtom[]; readonly elapsedMs: number }> {
  if (ring.kind !== "git-history" || inputs.nowMs() >= inputs.deadlineAtMs) {
    return { atoms: [], elapsedMs: 0 };
  }
  const startedAtMs = inputs.nowMs();
  let atoms: readonly EvidenceAtom[];
  try {
    atoms = await raceAbortDeadline(
      ({ signal }) =>
        inputs.gitFileHistoryEvidence({
          searchScope: inputs.searchScope,
          query: inputs.query,
          fs: inputs.fs,
          nowMs: inputs.nowMs,
          signal,
          maxFiles: cap,
          correlationId: inputs.correlationId,
          deadlineAtMs: inputs.deadlineAtMs,
        }),
      {
        deadlineAtMs: inputs.deadlineAtMs,
        nowMs: inputs.nowMs,
        ...(inputs.signal === undefined ? {} : { signal: inputs.signal }),
      },
    );
  } catch (error) {
    if (!(error instanceof AbortDeadlineRaceError)) throw error;
    if (error.reason === "aborted") {
      throw new CancelledError("grounded repository request cancelled");
    }
    atoms = [];
  }
  return { atoms, elapsedMs: Math.max(0, inputs.nowMs() - startedAtMs) };
}

function nonLexicalAtoms(
  ring: NonLexicalRing,
  merged: readonly EvidenceAtom[],
  gitAtoms: readonly EvidenceAtom[],
  inputs: SearchInputs,
  cap: number,
): readonly EvidenceAtom[] {
  if (ring.kind === "structural") {
    return dedupeAtoms([...merged, ...structuralEdgeTargetAtoms(merged, inputs)], cap);
  }
  const existsCache = createFileExistenceCache();
  const guardedInputs = {
    ...inputs,
    fs: cancellationGuardedWorkspaceFs(inputs.fs, inputs.signal),
  };
  return dedupeAtoms(
    [...merged, ...gitAtoms].filter((atom) => {
      throwIfCancelled(inputs.signal);
      return (
        inputs.nowMs() < inputs.deadlineAtMs && isRankableFileAtom(atom, guardedInputs, existsCache)
      );
    }),
    cap,
  );
}

async function runNonLexicalRing(ring: NonLexicalRing, inputs: SearchInputs): Promise<RingResult> {
  const allResults = await runNonLexicalAdapters(ring, inputs);
  const elapsedMs = allResults.reduce((sum, result) => sum + result.elapsedMs, 0);
  const cap = Math.min(ring.searchLimits.maxMatchesReturned, inputs.query.maxResults);
  const merged = mergeAtomsByStableId(allResults, cap);
  const git = await gitFileAtomsForRing(ring, inputs, cap);
  const atoms = nonLexicalAtoms(ring, merged, git.atoms, inputs, cap);
  const adapterUncertainty = allResults.flatMap((result) =>
    adapterDiagnostics(result, inputs.nowMs()),
  );
  const uncertainty = dedupeUncertainty(
    ring.kind === "git-history"
      ? suppressGitMetadataAdapterDiagnostics(adapterUncertainty, git.atoms.length)
      : adapterUncertainty,
  );
  return {
    atoms,
    omitted: [],
    uncertainty,
    usage: usageDelta({ elapsedMs: elapsedMs + git.elapsedMs }),
  };
}

async function runRing(ring: RetrievalRing, inputs: SearchInputs): Promise<RingResult> {
  if (ring.kind === "lexical") {
    return runLexicalRing(ring, inputs);
  }
  return runNonLexicalRing(ring as NonLexicalRing, inputs);
}

interface RingRunSummary {
  readonly atoms: readonly EvidenceAtom[];
  readonly omitted: readonly OmittedContextEntry[];
  readonly governor: GovernorState;
  readonly uncertainty: readonly UncertaintyMarker[];
  // Ranking diagnostics from the (first) lexical ring; undefined when no lexical ring ran (M2).
  readonly diagnostics?: ContextPackDiagnostics | undefined;
}

interface AugmentationBudgetResult {
  readonly governor: GovernorState;
  readonly marker?: UncertaintyMarker | undefined;
}

interface AugmentationBudgetMeter {
  readonly canContinue: () => boolean;
  readonly tryReserveSearchCall: () => boolean;
  readonly finish: (governor: GovernorState) => AugmentationBudgetResult;
}

function createAugmentationBudgetMeter(
  plan: ExplorationPlan,
  governor: GovernorState,
  nowMs: () => number,
  deadlineAtMs: number,
): AugmentationBudgetMeter {
  const startedAtMs = nowMs();
  let reservedSearchCalls = 0;
  let stopReason: string | undefined;
  const canContinue = (): boolean => {
    if (governor.status === "budget-exhausted") {
      stopReason ??= governor.stopReason ?? "budget exhausted";
      return false;
    }
    if (nowMs() < deadlineAtMs) return true;
    stopReason ??= "budget-exhausted on elapsedMs";
    return false;
  };
  const tryReserveSearchCall = (): boolean => {
    if (!canContinue()) return false;
    if (governor.usage.searchCalls + reservedSearchCalls >= plan.budget.searchCallsMax) {
      stopReason ??= "budget-exhausted on searchCalls";
      return false;
    }
    reservedSearchCalls += 1;
    return true;
  };
  return {
    canContinue,
    tryReserveSearchCall,
    finish: (current): AugmentationBudgetResult => {
      const endedAtMs = nowMs();
      if (endedAtMs >= deadlineAtMs) stopReason ??= "budget-exhausted on elapsedMs";
      const elapsedMs = Math.max(0, Math.floor(endedAtMs - startedAtMs));
      const charged = applyUsage(
        current,
        usageDelta({ searchCalls: reservedSearchCalls, elapsedMs }),
      );
      const reason = stopReason ?? charged.stopReason;
      return {
        governor: charged,
        ...(reason === undefined ? {} : { marker: budgetClipped(reason, endedAtMs) }),
      };
    },
  };
}

interface RingReservation {
  readonly governor: GovernorState;
  readonly marker?: UncertaintyMarker | undefined;
}

interface StoppedRingReservation {
  readonly governor: GovernorState;
  readonly marker: UncertaintyMarker;
}

function reserveRingSearchCalls(
  governor: GovernorState,
  ring: RetrievalRing,
  inputs: SearchInputs,
): RingReservation {
  const reserved = applyUsage(
    governor,
    usageDelta({ searchCalls: plannedSearchCallsForRing(ring, inputs) }),
  );
  if (reserved.status !== "budget-exhausted") {
    return { governor: reserved };
  }
  return {
    governor: reserved,
    marker: budgetClipped(reserved.stopReason ?? "budget exhausted", inputs.nowMs()),
  };
}

function initialBlockedRingSummary(
  governor: GovernorState,
  inputs: SearchInputs,
): RingRunSummary | undefined {
  const reason = readBudgetStopReason(governor.plan.budget);
  if (reason === undefined) return undefined;
  return {
    atoms: [],
    omitted: [],
    governor: complete(governor),
    uncertainty: [budgetClipped(reason, inputs.nowMs())],
  };
}

function elapsedDeadlineStop(
  governor: GovernorState,
  inputs: SearchInputs,
): StoppedRingReservation | undefined {
  if (inputs.nowMs() < inputs.deadlineAtMs) return undefined;
  const remainingElapsedMs = Math.max(
    0,
    governor.plan.budget.elapsedMsMax - governor.usage.elapsedMs,
  );
  return {
    governor: applyUsage(governor, usageDelta({ elapsedMs: remainingElapsedMs })),
    marker: budgetClipped("budget-exhausted on elapsedMs", inputs.nowMs()),
  };
}

async function runAllRings(
  rings: readonly RetrievalRing[],
  inputs: SearchInputs,
  initialGovernor: GovernorState,
): Promise<RingRunSummary> {
  const blocked = initialBlockedRingSummary(initialGovernor, inputs);
  if (blocked !== undefined) return blocked;
  const atoms: EvidenceAtom[] = [];
  const omitted: OmittedContextEntry[] = [];
  const uncertainty: UncertaintyMarker[] = [];
  // Ring order is fixed by the plan, so capturing the first lexical ring's diagnostics is
  // deterministic. (There is normally exactly one lexical ring.)
  let diagnostics: ContextPackDiagnostics | undefined;
  let governor = initialGovernor;
  for (const ring of rings) {
    throwIfCancelled(inputs.signal);
    if (!canContinue(governor)) {
      break;
    }
    const deadlineStop = elapsedDeadlineStop(governor, inputs);
    if (deadlineStop !== undefined) {
      governor = deadlineStop.governor;
      uncertainty.push(deadlineStop.marker);
      break;
    }
    const reservation = reserveRingSearchCalls(governor, ring, inputs);
    governor = reservation.governor;
    if (reservation.marker !== undefined) {
      uncertainty.push(reservation.marker);
      break;
    }
    const result = await runRing(ring, inputs);
    throwIfCancelled(inputs.signal);
    // First lexical ring wins (??= never overwrites once set); ring order is plan-fixed.
    diagnostics ??= result.diagnostics;
    const afterRing = applyUsage(governor, result.usage);
    atoms.push(...result.atoms);
    omitted.push(...result.omitted);
    uncertainty.push(...result.uncertainty);
    if (afterRing.status === "budget-exhausted") {
      governor = afterRing;
      uncertainty.push(budgetClipped(afterRing.stopReason ?? "budget exhausted", inputs.nowMs()));
      break;
    }
    governor = advanceRing(afterRing);
  }
  if (governor.status === "running") {
    governor = complete(governor);
  }
  return { atoms, omitted, governor, uncertainty, diagnostics };
}

interface ExcerptInputs {
  readonly searchScope: SearchScope;
  readonly fs: WorkspaceFs;
  readonly budget: ExplorationBudget;
  readonly initialUsage: ExplorationUsage;
  readonly atomsByPath: ReadonlyMap<string, readonly EvidenceAtom[]>;
  readonly nowMs: () => number;
  readonly signal?: AbortSignal | undefined;
  readonly deadlineAtMs: number;
}

interface ExcerptReadSummary {
  readonly excerpts: ReadonlyMap<string, readonly ExcerptWindow[]>;
  readonly uncertainty: readonly UncertaintyMarker[];
}

type PackCacheIdentity = readonly string[];

interface CandidateOrdering {
  readonly kept: readonly CandidateFile[];
  readonly omitted: readonly OmittedContextEntry[];
}

interface LineWindow {
  readonly startLine: number;
  readonly endLine: number;
}

const DEFAULT_EXCERPT_WINDOW: LineWindow = { startLine: 1, endLine: 200 };
const SINGLE_LINE_EXCERPT_CONTEXT_LINES = 3;
const DISCOVERED_DEFINITION_CONTEXT_AFTER = 24;
const MAX_EXCERPT_WINDOWS_PER_FILE = 8;
const PROJECT_METADATA_QUERY_TERMS = [
  "abhängigkeit",
  "abhängigkeiten",
  "abhaengigkeit",
  "abhaengigkeiten",
  "build",
  "cypress",
  "dependenc",
  "dependencies",
  "devdependencies",
  "framework",
  "java-script",
  "javascript",
  "jest",
  "node",
  "node.js",
  "npm",
  "package",
  "package.json",
  "package-manager",
  "paketmanager",
  "playwright",
  "pnpm",
  "react",
  "script",
  "stack",
  "tech-stack",
  "techstack",
  "test",
  "test-runner",
  "testing",
  "testumgebung",
  "type script",
  "type-script",
  "typescript",
  "version",
  "versionen",
  "vite",
  "vitest",
  "yarn",
] as const;
// Dependency lockfiles surfaced for project-metadata questions (unchanged behaviour). The manifest
// basenames themselves now come from the shared ecosystem registry (CANONICAL_MANIFEST_BASENAMES),
// which is a superset of the prior JS/TS-only list and additionally covers Maven/Gradle/Go/Rust/
// Python/.NET/etc., so "Which Java version does this project use?" injects pom.xml/build.gradle as
// deterministic score-1 metadata atoms.
const PROJECT_METADATA_LOCKFILES = [
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
] as const;
const PROJECT_METADATA_FILENAMES: readonly string[] = [
  ...CANONICAL_MANIFEST_BASENAMES,
  ...PROJECT_METADATA_LOCKFILES,
];
const REPOSITORY_OVERVIEW_FILENAMES = [
  "README.md",
  "readme.md",
  "AGENTS.md",
  "CLAUDE.md",
  "CONTRIBUTING.md",
  "docs/README.md",
  "docs/architecture.md",
  "docs/ARCHITECTURE.md",
  "docs/adr/README.md",
] as const;
const WORKSPACE_PACKAGE_DIRS = ["packages", "apps", "services", "libs"] as const;
const MAX_WORKSPACE_MANIFESTS = 24;
const WORKSPACE_MANIFEST_BYTES_MAX = 1_048_576;
const WORKSPACE_PATTERN_COUNT_MAX = 32;
const WORKSPACE_PATTERN_CHARS_MAX = 1_024;
const SYMBOL_FILE_EXTENSIONS = [
  "cs",
  "fs",
  "go",
  "graphql",
  "gql",
  "groovy",
  "java",
  "ts",
  "tsx",
  "js",
  "jsx",
  "kt",
  "kts",
  "mts",
  "cts",
  "mjs",
  "cjs",
  "php",
  "proto",
  "py",
  "pyi",
  "rb",
  "rs",
  "scala",
  "swift",
  "vb",
  "vue",
] as const;
const SYMBOL_FILE_EXTENSION_SET: ReadonlySet<string> = new Set(SYMBOL_FILE_EXTENSIONS);
// Aggregate cap on firstSymbolLine reads across ALL terms in one question, so a vague code question
// on a large customer repo can never trigger an unbounded number of full-file reads even if many
// files match the symbol globs (each read also re-stats + splits the file — see firstSymbolLine).
const MAX_SYMBOL_LINE_READS = 64;
const SYMBOL_FILE_MATCHES_MAX = 96;
const DOCUMENT_REFERENCE_MATCHES_MAX = 8;
const MAX_DOCUMENT_REFERENCE_ANCHORS = 4;
const DOCUMENT_REFERENCE_ANCHOR_RE = /^(?:adr|rfc)-\d{3,6}$/u;
const SYMBOL_FILE_SEARCH_LIMITS = {
  maxFilesScanned: 10_000,
  maxMatchesReturned: SYMBOL_FILE_MATCHES_MAX,
  maxBytesPerFileScanned: DEFAULT_SEARCH_LIMITS.maxBytesPerFileScanned,
  elapsedMsMax: DEFAULT_SEARCH_LIMITS.elapsedMsMax,
} as const;
const DOCUMENT_REFERENCE_SEARCH_LIMITS = {
  maxFilesScanned: 10_000,
  maxMatchesReturned: DOCUMENT_REFERENCE_MATCHES_MAX,
  maxBytesPerFileScanned: DEFAULT_SEARCH_LIMITS.maxBytesPerFileScanned,
  elapsedMsMax: DEFAULT_SEARCH_LIMITS.elapsedMsMax,
} as const;
const SYMBOL_LINE_SCAN_BYTES_MAX = 2_097_152;
const LOCKFILE_NAMES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "cargo.lock",
  "composer.lock",
  "gemfile.lock",
]);

function basename(scopePath: string): string {
  const index = scopePath.lastIndexOf("/");
  return index >= 0 ? scopePath.slice(index + 1) : scopePath;
}

function compareByScopePath(a: OmittedContextEntry, b: OmittedContextEntry): number {
  return a.scopePath.localeCompare(b.scopePath);
}

function isKeikoEvidenceArtifact(scopePath: string): boolean {
  return scopePath.toLowerCase().startsWith(".keiko/evidence/");
}

function isLockfilePath(scopePath: string): boolean {
  return LOCKFILE_NAMES.has(basename(scopePath).toLowerCase());
}

function dirname(scopePath: string): string {
  const index = scopePath.lastIndexOf("/");
  return index <= 0 ? "" : scopePath.slice(0, index);
}

function joinScopePath(base: string, filename: string): string {
  return base.length === 0 ? filename : `${base}/${filename}`;
}

function projectMetadataQueryFingerprint(query: RetrievalQuery): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        kind: "project-metadata",
        queryKind: query.kind,
        text: query.text,
        caseSensitive: query.caseSensitive,
      }),
    )
    .digest("hex")
    .slice(0, 16);
}

function selectedFileQueryFingerprint(query: RetrievalQuery): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        kind: "explicit-selected-file",
        queryKind: query.kind,
        text: query.text,
        caseSensitive: query.caseSensitive,
      }),
    )
    .digest("hex")
    .slice(0, 16);
}

function normalizedQueryText(queryText: string): string {
  return queryText.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

function wantsProjectMetadata(input: OrchestratorInput, intent: RetrievalIntent): boolean {
  if (intent === "project-metadata" || intent === "repository-overview") {
    return true;
  }
  const lowered = input.query.text.toLowerCase();
  const normalized = normalizedQueryText(input.query.text);
  return PROJECT_METADATA_QUERY_TERMS.some(
    (term) => lowered.includes(term) || normalized.includes(term),
  );
}

function wantsRepositoryOverview(intent: RetrievalIntent): boolean {
  return intent === "repository-overview";
}

function metadataRootsForScope(scope: SelectedScope): readonly string[] {
  if (scope.relativePaths.length === 0) {
    return [""];
  }
  const roots = new Set<string>();
  for (const entry of scope.relativePaths) {
    if (!isValidScopePath(entry, { mustBeRelative: true })) {
      continue;
    }
    roots.add(scope.kind === "files" ? dirname(entry) : entry);
  }
  return [...roots].sort((a, b) => a.localeCompare(b));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type MetadataCoverageIssue =
  | "workspace-manifest-byte-limit"
  | "workspace-manifest-read-unavailable"
  | "workspace-manifest-shape-unsupported"
  | "workspace-pattern-count-limit"
  | "workspace-pattern-length-limit"
  | "workspace-pattern-shape-unsupported";

function recordMetadataCoverageIssue(
  cache: FileExistenceCache | undefined,
  issue: MetadataCoverageIssue,
  count = 1,
): void {
  if (cache === undefined || count <= 0) return;
  cache.metadataCoverageIssues.set(issue, (cache.metadataCoverageIssues.get(issue) ?? 0) + count);
}

function descriptorReadExceededLimit(error: unknown): boolean {
  return isRecord(error) && error.reason === "too-large";
}

function readBoundedWorkspaceManifest(
  fs: WorkspaceFs,
  absolutePath: string,
  cache?: FileExistenceCache,
): string | undefined {
  try {
    const stat = fs.stat(absolutePath);
    if (!stat.isFile || stat.size > WORKSPACE_MANIFEST_BYTES_MAX) {
      recordMetadataCoverageIssue(cache, "workspace-manifest-byte-limit");
      return undefined;
    }
    if (fs.readFileUtf8SameDescriptor !== undefined) {
      const read = fs.readFileUtf8SameDescriptor(
        absolutePath,
        WORKSPACE_MANIFEST_BYTES_MAX,
        "reject",
        stat,
      );
      return isWorkspacePathSnapshotCurrent(fs, absolutePath, absolutePath, stat)
        ? read.rawText
        : undefined;
    }
    const rawText = fs.readFileUtf8(absolutePath);
    if (!isWorkspacePathSnapshotCurrent(fs, absolutePath, absolutePath, stat)) return undefined;
    if (utf8ByteLength(rawText) > WORKSPACE_MANIFEST_BYTES_MAX) {
      recordMetadataCoverageIssue(cache, "workspace-manifest-byte-limit");
      return undefined;
    }
    return rawText;
  } catch (error) {
    rethrowMetadataCancellation(error);
    recordMetadataCoverageIssue(
      cache,
      descriptorReadExceededLimit(error)
        ? "workspace-manifest-byte-limit"
        : "workspace-manifest-read-unavailable",
    );
    return undefined;
  }
}

function workspacePatternEntries(
  workspaces: unknown,
  cache?: FileExistenceCache,
): readonly unknown[] | undefined {
  if (Array.isArray(workspaces)) {
    return workspaces.map((entry: unknown): unknown => entry);
  }
  if (isRecord(workspaces) && Array.isArray(workspaces.packages)) {
    return workspaces.packages.map((entry: unknown): unknown => entry);
  }
  if (workspaces !== undefined) {
    recordMetadataCoverageIssue(cache, "workspace-manifest-shape-unsupported");
  }
  return undefined;
}

function boundedWorkspacePatterns(
  entries: readonly unknown[],
  cache?: FileExistenceCache,
): readonly string[] {
  recordMetadataCoverageIssue(
    cache,
    "workspace-pattern-count-limit",
    Math.max(0, entries.length - WORKSPACE_PATTERN_COUNT_MAX),
  );
  const patterns: string[] = [];
  for (const entry of entries.slice(0, WORKSPACE_PATTERN_COUNT_MAX)) {
    if (typeof entry !== "string") {
      recordMetadataCoverageIssue(cache, "workspace-pattern-shape-unsupported");
    } else if (entry.length > WORKSPACE_PATTERN_CHARS_MAX) {
      recordMetadataCoverageIssue(cache, "workspace-pattern-length-limit");
    } else {
      patterns.push(entry);
    }
  }
  return patterns;
}

function readWorkspacePatterns(
  searchScope: SearchScope,
  fs: WorkspaceFs,
  control: MetadataTraversalControl,
  existsCache?: FileExistenceCache,
): readonly string[] {
  if (!metadataTraversalCanContinue(control)) return [];
  if (!fileExistsInSearchScope(searchScope, fs, "package.json", existsCache)) {
    return [];
  }
  let rawText: string | undefined;
  try {
    const contained = canonicalContainedSearchPath(searchScope, fs, "package.json");
    if (contained === undefined) {
      recordMetadataCoverageIssue(existsCache, "workspace-manifest-read-unavailable");
      return [];
    }
    rawText = readBoundedWorkspaceManifest(fs, contained.path, existsCache);
  } catch (error) {
    rethrowMetadataCancellation(error);
    recordMetadataCoverageIssue(existsCache, "workspace-manifest-read-unavailable");
  }
  if (!metadataTraversalCanContinue(control)) return [];
  if (rawText === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(rawText);
    if (!isRecord(parsed)) {
      recordMetadataCoverageIssue(existsCache, "workspace-manifest-shape-unsupported");
      return [];
    }
    const entries = workspacePatternEntries(parsed.workspaces, existsCache);
    return entries === undefined ? [] : boundedWorkspacePatterns(entries, existsCache);
  } catch {
    recordMetadataCoverageIssue(existsCache, "workspace-manifest-shape-unsupported");
    return [];
  }
}

// Strips trailing "/" one character at a time instead of via `/\/+$/u` (SonarCloud S8786): that
// pattern is unanchored at the start, so a long run of "/" that never reaches the string's true end
// forces the engine to retry the backtrack at every position within the run, giving O(n²) work. A
// manual scan from the end can't backtrack and is O(n).
// Exported for the co-located S8786 pin (#3347); not a package public surface.
export function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end--;
  return value.slice(0, end);
}

// Exported for the co-located S8786 pin (#3347); not a package public surface.
export function normalizeWorkspacePattern(pattern: string): string | undefined {
  let normalized = pattern.trim().replaceAll("\\", "/");
  while (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }
  normalized = stripTrailingSlashes(normalized);
  if (normalized.length === 0 || normalized.startsWith("../") || normalized.includes("/../")) {
    return undefined;
  }
  return normalized;
}

type BoundedDirectoryReadStatus = "complete" | "truncated" | "unavailable";

interface BoundedDirectoryRead {
  readonly entries: readonly WorkspaceDirEntry[];
  readonly status: BoundedDirectoryReadStatus;
}

interface MetadataTraversalControl {
  readonly signal: AbortSignal | undefined;
  readonly nowMs: () => number;
  readonly deadlineAtMs: number;
}

class MetadataTraversalDeadlineError extends Error {
  public constructor() {
    super("project metadata traversal deadline reached");
    this.name = "MetadataTraversalDeadlineError";
  }
}

function assertMetadataTraversalActive(control: MetadataTraversalControl): void {
  throwIfCancelled(control.signal);
  if (control.nowMs() >= control.deadlineAtMs) {
    throw new MetadataTraversalDeadlineError();
  }
}

function metadataTraversalOperation<T>(control: MetadataTraversalControl, run: () => T): T {
  assertMetadataTraversalActive(control);
  const result = run();
  assertMetadataTraversalActive(control);
  return result;
}

function metadataTraversalFs(fs: WorkspaceFs, control: MetadataTraversalControl): WorkspaceFs {
  const descriptorRead = fs.readFileUtf8SameDescriptor;
  const canonicalRoot = fs.canonicalWorkspaceRoot;
  const run = <T>(operation: () => T): T => metadataTraversalOperation(control, operation);
  return preserveOwnedRootAuthority(fs, {
    readFileUtf8: (path): string => run(() => fs.readFileUtf8(path)),
    stat: (path): WorkspaceStat => run(() => fs.stat(path)),
    readDir: (path, maxEntries): readonly WorkspaceDirEntry[] =>
      run(() => fs.readDir(path, maxEntries)),
    realPath: (path): string => run(() => fs.realPath(path)),
    exists: (path): boolean => run(() => fs.exists(path)),
    ...(descriptorRead === undefined
      ? {}
      : {
          readFileUtf8SameDescriptor: (
            path: string,
            maxBytes: number,
            hardLinkPolicy: WorkspaceHardLinkPolicy,
            expected: WorkspaceStat,
          ): WorkspaceDescriptorUtf8Read =>
            run(() => descriptorRead.call(fs, path, maxBytes, hardLinkPolicy, expected)),
        }),
    ...(canonicalRoot === undefined
      ? {}
      : {
          canonicalWorkspaceRoot: (root: string): string => run(() => canonicalRoot.call(fs, root)),
        }),
  });
}

function cancellationGuardedWorkspaceFs(
  fs: WorkspaceFs,
  signal: AbortSignal | undefined,
): WorkspaceFs {
  return signal === undefined
    ? fs
    : metadataTraversalFs(fs, { signal, nowMs: () => 0, deadlineAtMs: Number.POSITIVE_INFINITY });
}

function metadataTraversalCanContinue(control: MetadataTraversalControl): boolean {
  throwIfCancelled(control.signal);
  return control.nowMs() < control.deadlineAtMs;
}

function rethrowMetadataCancellation(error: unknown): void {
  if (error instanceof CancelledError) throw error;
}

type ContainedSearchPath = ReturnType<typeof containedRealPathInfo>;

function canonicalContainedSearchPath(
  searchScope: SearchScope,
  fs: WorkspaceFs,
  scopePath: string,
): ContainedSearchPath | undefined {
  const root = searchScope.workspace.root;
  const contained = containedRealPathInfo(fs, root, resolveWithinWorkspace(root, scopePath));
  return isCanonicalAllowedContainedPath(contained, root, scopePath) ? contained : undefined;
}

function safeReadDir(
  searchScope: SearchScope,
  fs: WorkspaceFs,
  scopePath: string,
  maxEntries: number,
): BoundedDirectoryRead {
  if (scopePath.length > 0 && !isValidScopePath(scopePath, { mustBeRelative: true })) {
    return { entries: [], status: "unavailable" };
  }
  const root = searchScope.workspace.root;
  const abs = resolveWithinWorkspace(root, scopePath);
  try {
    const contained = containedRealPathInfo(fs, root, abs);
    if (!isCanonicalAllowedContainedPath(contained, root, scopePath)) {
      if (!isAllowedContainedPathParent(contained, root, scopePath)) {
        return { entries: [], status: "unavailable" };
      }
      return fs.exists(abs)
        ? { entries: [], status: "unavailable" }
        : { entries: [], status: "complete" };
    }
    if (!fs.stat(contained.path).isDirectory) {
      return { entries: [], status: "complete" };
    }
    const entries = fs.readDir(contained.path, maxEntries + 1);
    const truncated = entries.length > maxEntries;
    return {
      entries: truncated ? [] : entries,
      status: truncated ? "truncated" : "complete",
    };
  } catch (error) {
    rethrowMetadataCancellation(error);
    return { entries: [], status: "unavailable" };
  }
}

// Bound on how many service subdirectories under a `dir/*` pattern are scanned, so a monorepo with
// thousands of packages cannot trigger an unbounded directory fan-out (the per-result cap in the
// caller is MAX_WORKSPACE_MANIFESTS; this caps the WORK, not just the output).
const MAX_MONOREPO_SERVICE_DIRS = 96;

// Canonical project manifests of ANY ecosystem present directly inside `dir` (one bounded readDir,
// realpath-contained, no symlink following). Replaces the prior package.json-only probe so a
// polyglot monorepo surfaces service-local pom.xml / go.mod / Cargo.toml / *.csproj, not just
// JS packages. isDenied is applied even though the registry is deny-clean (defence in depth), and
// the result is sorted for deterministic evidence ordering.
function canonicalManifestScopePathsInDir(
  dir: string,
  searchScope: SearchScope,
  fs: WorkspaceFs,
  maxEntries: number,
  existsCache?: FileExistenceCache,
): readonly string[] {
  return cachedDirectoryEntries(searchScope, fs, dir, maxEntries, existsCache)
    .entries.filter((entry) => !entry.isDirectory && !entry.isSymbolicLink)
    .map((entry) => joinScopePath(dir, entry.name))
    .filter((scopePath) => isCanonicalMetadataFile(scopePath) && !isDenied(scopePath))
    .sort((a, b) => a.localeCompare(b));
}

function expandWorkspacePattern(
  pattern: string,
  searchScope: SearchScope,
  fs: WorkspaceFs,
  control: MetadataTraversalControl,
  existsCache?: FileExistenceCache,
): readonly string[] {
  if (!metadataTraversalCanContinue(control)) return [];
  const normalized = normalizeWorkspacePattern(pattern);
  if (normalized === undefined) {
    recordMetadataCoverageIssue(existsCache, "workspace-pattern-shape-unsupported");
    return [];
  }
  if (!normalized.includes("*")) {
    const dir = normalized.endsWith("/package.json")
      ? normalized.slice(0, -"/package.json".length)
      : normalized;
    return canonicalManifestScopePathsInDir(
      dir,
      searchScope,
      fs,
      MAX_WORKSPACE_MANIFESTS,
      existsCache,
    );
  }
  if (!normalized.endsWith("/*") || normalized.slice(0, -2).includes("*")) {
    recordMetadataCoverageIssue(existsCache, "workspace-pattern-shape-unsupported");
    return [];
  }
  return workspacePatternServiceManifests(
    normalized.slice(0, -2),
    searchScope,
    fs,
    control,
    existsCache,
  );
}

function workspacePatternServiceManifests(
  base: string,
  searchScope: SearchScope,
  fs: WorkspaceFs,
  control: MetadataTraversalControl,
  existsCache?: FileExistenceCache,
): readonly string[] {
  if (!metadataTraversalCanContinue(control)) return [];
  const serviceNames = cachedDirectoryEntries(
    searchScope,
    fs,
    base,
    MAX_MONOREPO_SERVICE_DIRS,
    existsCache,
  )
    .entries.filter((entry) => entry.isDirectory && !entry.isSymbolicLink)
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, MAX_MONOREPO_SERVICE_DIRS);
  const manifests: string[] = [];
  for (const name of serviceNames) {
    if (!metadataTraversalCanContinue(control)) break;
    const remaining = MAX_WORKSPACE_MANIFESTS - manifests.length;
    if (remaining <= 0) break;
    manifests.push(
      ...canonicalManifestScopePathsInDir(
        joinScopePath(base, name),
        searchScope,
        fs,
        remaining,
        existsCache,
      ),
    );
  }
  return manifests;
}

function workspacePackageManifestPaths(
  input: OrchestratorInput,
  searchScope: SearchScope,
  fs: WorkspaceFs,
  control: MetadataTraversalControl,
  existsCache?: FileExistenceCache,
): readonly string[] {
  if (input.scope.kind !== "workspace-root" || input.scope.relativePaths.length !== 0) {
    return [];
  }
  if (!metadataTraversalCanContinue(control)) return [];
  const patterns = new Set<string>(readWorkspacePatterns(searchScope, fs, control, existsCache));
  for (const dir of WORKSPACE_PACKAGE_DIRS) {
    patterns.add(`${dir}/*`);
  }
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const pattern of [...patterns].sort((a, b) => a.localeCompare(b))) {
    if (!metadataTraversalCanContinue(control)) break;
    for (const scopePath of expandWorkspacePattern(
      pattern,
      searchScope,
      fs,
      control,
      existsCache,
    )) {
      if (seen.has(scopePath)) {
        continue;
      }
      seen.add(scopePath);
      paths.push(scopePath);
      if (paths.length >= MAX_WORKSPACE_MANIFESTS) {
        return paths;
      }
    }
  }
  return paths;
}

function metadataAtom(
  scope: SelectedScope,
  scopePath: string,
  queryFingerprint: string,
  nowMs: () => number,
): EvidenceAtom {
  return {
    schemaVersion: scope.schemaVersion,
    stableId: evidenceAtomStableId({
      scopeId: scope.scopeId,
      scopePath,
      lineRange: undefined,
      provenanceKind: "file-listing",
      provenanceTool: "repo.projectMetadata",
      queryFingerprint,
    }),
    scopePath,
    lineRange: undefined,
    score: 1,
    provenance: {
      kind: "file-listing",
      tool: "repo.projectMetadata",
      queryFingerprint,
    },
    redactionState: "redacted",
    emittedAtMs: nowMs(),
    ledgerRef: undefined,
  };
}

function overviewAtom(
  scope: SelectedScope,
  scopePath: string,
  queryFingerprint: string,
  nowMs: () => number,
): EvidenceAtom {
  return {
    schemaVersion: scope.schemaVersion,
    stableId: evidenceAtomStableId({
      scopeId: scope.scopeId,
      scopePath,
      lineRange: undefined,
      provenanceKind: "file-listing",
      provenanceTool: "repo.repositoryOverview",
      queryFingerprint,
    }),
    scopePath,
    lineRange: undefined,
    score: 1,
    provenance: {
      kind: "file-listing",
      tool: "repo.repositoryOverview",
      queryFingerprint,
    },
    redactionState: "redacted",
    emittedAtMs: nowMs(),
    ledgerRef: undefined,
  };
}

function symbolFileQuery(input: OrchestratorInput, pattern: string): RetrievalQuery {
  return {
    kind: "file-pattern",
    text: pattern,
    caseSensitive: false,
    maxResults: SYMBOL_FILE_MATCHES_MAX,
    emittedAtMs: input.query.emittedAtMs,
  };
}

function documentReferenceAnchorTerms(plan: ExplorationPlan): readonly string[] {
  return plan.anchors
    .filter(
      (anchor) =>
        (anchor.kind === "identifier" || anchor.kind === "quoted") &&
        DOCUMENT_REFERENCE_ANCHOR_RE.test(anchor.term),
    )
    .map((anchor) => anchor.term)
    .slice(0, MAX_DOCUMENT_REFERENCE_ANCHORS);
}

function documentReferenceQuery(input: OrchestratorInput, term: string): RetrievalQuery {
  return {
    kind: "file-pattern",
    text: `**${term}*`,
    caseSensitive: false,
    maxResults: DOCUMENT_REFERENCE_MATCHES_MAX,
    emittedAtMs: input.query.emittedAtMs,
  };
}

function documentReferenceCoverageMarker(
  term: string,
  coverage: ContextCoverageDiagnostics,
  nowMs: () => number,
): UncertaintyMarker | undefined {
  if (!coverage.incomplete) return undefined;
  return {
    kind: "scope-incomplete",
    claim:
      `Document reference discovery for "${term}" was incomplete: ` +
      `reasons=${coverage.reasons.join(",")}; ` +
      `filesScanned=${String(coverage.filesScanned)}, ` +
      `filesSkipped=${String(coverage.filesSkipped)}, ` +
      `matchesReturned=${String(coverage.matchesReturned)}.`,
    impactedAtomIds: [],
    emittedAtMs: nowMs(),
  };
}

function reserveAugmentationSearchTerms(
  terms: readonly string[],
  signal: AbortSignal | undefined,
  budget: AugmentationBudgetMeter,
): readonly string[] {
  const reserved: string[] = [];
  for (const term of terms) {
    throwIfCancelled(signal);
    if (!budget.tryReserveSearchCall()) break;
    reserved.push(term);
  }
  return reserved;
}

async function documentReferenceAtoms(
  input: OrchestratorInput,
  plan: ExplorationPlan,
  nowMs: () => number,
  signal: AbortSignal | undefined,
  requestContext: StructuralAdapterRequestContext,
  budget: AugmentationBudgetMeter,
): Promise<DeterministicContextEvidence> {
  const terms = reserveAugmentationSearchTerms(documentReferenceAnchorTerms(plan), signal, budget);
  const results = await Promise.all(
    terms.map(async (term) => {
      throwIfCancelled(signal);
      const result = await requestContext.findFiles(
        documentReferenceQuery(input, term),
        DOCUMENT_REFERENCE_SEARCH_LIMITS,
        {
          ...(signal === undefined ? {} : { signal }),
          searchHints: { retrievalIntent: plan.retrievalIntent },
        },
      );
      return { term, result };
    }),
  );
  const markers = results.flatMap(({ term, result }) => {
    const marker = documentReferenceCoverageMarker(term, result.coverage, nowMs);
    return marker === undefined ? [] : [marker];
  });
  return { atoms: results.flatMap(({ result }) => result.atoms), uncertainty: markers };
}

// eslint-disable-next-line complexity -- Guard chain keeps symbol-anchor filtering explicit.
function symbolFileAnchorTerms(plan: ExplorationPlan): readonly string[] {
  if (
    plan.retrievalIntent !== "targeted-code-search" &&
    plan.retrievalIntent !== "diagnostic-search"
  ) {
    return [];
  }
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const anchor of plan.anchors) {
    if ((anchor.kind !== "identifier" && anchor.kind !== "quoted") || anchor.weight < 0.7) {
      continue;
    }
    if (!/^[a-z_$][a-z0-9_$-]+$/u.test(anchor.term) || anchor.term.includes(".")) {
      continue;
    }
    if (!seen.has(anchor.term)) {
      seen.add(anchor.term);
      terms.push(anchor.term);
    }
    if (terms.length >= 8) {
      break;
    }
  }
  return terms;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
}

function symbolDefinitionPatterns(term: string): readonly RegExp[] {
  const escaped = escapeRegex(term);
  return [
    new RegExp(String.raw`\b(?:export\s+)?(?:async\s+)?function\s+${escaped}\b`, "iu"),
    new RegExp(String.raw`\b(?:export\s+)?(?:class|interface|type|enum)\s+${escaped}\b`, "iu"),
    new RegExp(String.raw`\b(?:export\s+)?(?:const|let|var)\s+${escaped}\b`, "iu"),
    new RegExp(
      String.raw`\b(?:public\s+|private\s+|protected\s+|abstract\s+|final\s+|data\s+)*(?:class|interface|record|enum)\s+${escaped}\b`,
      "iu",
    ),
    new RegExp(
      String.raw`\b(?:public\s+|private\s+|protected\s+|static\s+|final\s+)*[A-Za-z_$][\w$<>, ?.[\]]+\s+${escaped}\s*\(`,
      "iu",
    ),
    new RegExp(String.raw`\b(?:def|func|fn|fun)\s+${escaped}\s*\(`, "iu"),
    new RegExp(String.raw`\btype\s+${escaped}\s+(?:struct|interface)\b`, "iu"),
    new RegExp(String.raw`\b(?:struct|trait|enum|class)\s+${escaped}\b`, "iu"),
  ];
}

function lineDefinesSymbol(line: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(line));
}

interface SymbolLineScanControl {
  readonly signal: AbortSignal | undefined;
  readonly nowMs: () => number;
  readonly deadlineMs: number;
}

interface SymbolLineLookupResult {
  readonly lineNumber: number | undefined;
  readonly deadlineReached: boolean;
}

function symbolLineDeadlineReached(control: SymbolLineScanControl): boolean {
  return control.nowMs() >= control.deadlineMs;
}

// Exported only for deterministic cancellation/deadline regression coverage; this file is not a
// package export. The per-line guard ensures a bounded-but-large 2 MiB source cannot run past the
// request's absolute elapsed deadline after the descriptor read has completed.
export function scanFirstSymbolLine(
  rawText: string,
  term: string,
  control: SymbolLineScanControl,
): SymbolLineLookupResult {
  const loweredTerm = term.toLowerCase();
  const definitionPatterns = symbolDefinitionPatterns(term);
  let firstOccurrence: number | undefined;
  let lineNumber = 1;
  let start = 0;
  while (start <= rawText.length) {
    throwIfCancelled(control.signal);
    if (symbolLineDeadlineReached(control)) {
      return { lineNumber: undefined, deadlineReached: true };
    }
    const newline = rawText.indexOf("\n", start);
    const line = rawText.slice(start, newline < 0 ? rawText.length : newline);
    if (lineDefinesSymbol(line, definitionPatterns)) {
      return { lineNumber, deadlineReached: false };
    }
    if (firstOccurrence === undefined && line.toLowerCase().includes(loweredTerm)) {
      firstOccurrence = lineNumber;
    }
    if (newline < 0) break;
    start = newline + 1;
    lineNumber += 1;
  }
  return { lineNumber: firstOccurrence, deadlineReached: false };
}

function boundedSymbolFileText(fs: WorkspaceFs, absolutePath: string): string | undefined {
  const stat = fs.stat(absolutePath);
  if (!stat.isFile || stat.size > SYMBOL_LINE_SCAN_BYTES_MAX) return undefined;
  if (fs.readFileUtf8SameDescriptor !== undefined) {
    const read = fs.readFileUtf8SameDescriptor(
      absolutePath,
      SYMBOL_LINE_SCAN_BYTES_MAX,
      "reject",
      stat,
    );
    return isWorkspacePathSnapshotCurrent(fs, absolutePath, absolutePath, stat)
      ? read.rawText
      : undefined;
  }
  // Compatibility for in-memory/test ports only. Production always supplies the same-descriptor
  // reader; the pre-read stat keeps legacy fakes bounded without weakening the production path.
  const rawText = fs.readFileUtf8(absolutePath);
  return utf8ByteLength(rawText) <= SYMBOL_LINE_SCAN_BYTES_MAX &&
    isWorkspacePathSnapshotCurrent(fs, absolutePath, absolutePath, stat)
    ? rawText
    : undefined;
}

function firstSymbolLine(
  searchScope: SearchScope,
  fs: WorkspaceFs,
  scopePath: string,
  term: string,
  control: SymbolLineScanControl,
): SymbolLineLookupResult {
  throwIfCancelled(control.signal);
  if (symbolLineDeadlineReached(control)) {
    return { lineNumber: undefined, deadlineReached: true };
  }
  try {
    const contained = canonicalContainedSearchPath(searchScope, fs, scopePath);
    if (contained === undefined) return { lineNumber: undefined, deadlineReached: false };
    throwIfCancelled(control.signal);
    if (symbolLineDeadlineReached(control)) {
      return { lineNumber: undefined, deadlineReached: true };
    }
    const rawText = boundedSymbolFileText(fs, contained.path);
    if (rawText === undefined) return { lineNumber: undefined, deadlineReached: false };
    return scanFirstSymbolLine(rawText, term, control);
  } catch (error) {
    if (error instanceof CancelledError) throw error;
    return { lineNumber: undefined, deadlineReached: false };
  }
}

function symbolLineAtom(
  scope: SelectedScope,
  scopePath: string,
  lineNumber: number,
  queryFingerprint: string,
  nowMs: () => number,
): EvidenceAtom {
  const lineRange = { startLine: lineNumber, endLine: lineNumber };
  return {
    schemaVersion: scope.schemaVersion,
    stableId: evidenceAtomStableId({
      scopeId: scope.scopeId,
      scopePath,
      lineRange,
      provenanceKind: "lexical-search",
      provenanceTool: "repo.symbolFileDiscovery",
      queryFingerprint,
    }),
    scopePath,
    lineRange,
    score: 1,
    provenance: {
      kind: "lexical-search",
      tool: "repo.symbolFileDiscovery",
      queryFingerprint,
    },
    redactionState: "redacted",
    emittedAtMs: nowMs(),
    ledgerRef: undefined,
  };
}

function scopePathExtension(scopePath: string): string {
  const name = scopePath.slice(scopePath.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

// True when `scopePath` is a `<term>.<code-extension>` definition file. The single-walk symbol glob
// `**/term.*` also matches multi-dot names like `term.test.tsx` (which the prior per-extension globs
// did not), so this restores the exact contract: keep only paths ending in `term.<ext>` for a code
// extension — the implementation file, not its co-named spec/story. Exported for direct testing.
export function isSymbolDefinitionPath(scopePath: string, term: string): boolean {
  const extension = scopePathExtension(scopePath);
  return (
    (SYMBOL_FILE_EXTENSION_SET.has(extension) || isEcosystemSourceFile(scopePath)) &&
    scopePath.toLowerCase().endsWith(`${term.toLowerCase()}.${extension}`)
  );
}

interface SymbolDefinitionMatch {
  readonly atom: EvidenceAtom;
  readonly term: string;
  readonly priority: number;
}

interface SymbolDiscoveryResult {
  readonly atoms: readonly EvidenceAtom[];
  readonly uncertainty: readonly UncertaintyMarker[];
}

function symbolCoverageIncomplete(
  term: string,
  coverage: ContextCoverageDiagnostics | undefined,
  nowMs: () => number,
): UncertaintyMarker | undefined {
  if (coverage?.incomplete !== true) {
    return undefined;
  }
  return {
    kind: "scope-incomplete",
    claim:
      `Symbol file discovery for "${term}" was incomplete: ` +
      `reasons=${coverage.reasons.join(",")}; ` +
      `filesScanned=${String(coverage.filesScanned)}, ` +
      `filesSkipped=${String(coverage.filesSkipped)}, ` +
      `matchesReturned=${String(coverage.matchesReturned)}, ` +
      `limits=maxFilesScanned:${String(coverage.limits.maxFilesScanned)},` +
      `maxMatchesReturned:${String(coverage.limits.maxMatchesReturned)},` +
      `elapsedMsMax:${String(coverage.limits.elapsedMsMax)}.`,
    impactedAtomIds: [],
    emittedAtMs: nowMs(),
  };
}

function symbolDefinitionPriority(scopePath: string, term: string): number {
  const loweredPath = scopePath.toLowerCase();
  return (
    1 +
    (loweredPath.includes(`/src/`) || loweredPath.startsWith("src/") ? 0.4 : 0) +
    (isSymbolDefinitionPath(scopePath, term) ? 0.2 : 0) -
    (/(^|\/)(test|tests|spec|specs|__tests__)\//u.test(loweredPath) ? 0.3 : 0)
  );
}

function compareSymbolMatches(a: SymbolDefinitionMatch, b: SymbolDefinitionMatch): number {
  const priorityDelta = b.priority - a.priority;
  if (priorityDelta !== 0) {
    return priorityDelta;
  }
  return a.atom.scopePath.localeCompare(b.atom.scopePath);
}

function symbolLineReadOverflow(
  overflowCount: number,
  terms: readonly string[],
  nowMs: () => number,
): UncertaintyMarker | undefined {
  if (overflowCount === 0) {
    return undefined;
  }
  return {
    kind: "scope-incomplete",
    claim:
      `Symbol line lookup skipped ${String(overflowCount)} definition file(s) after ` +
      `${String(MAX_SYMBOL_LINE_READS)} prioritized line reads; ` +
      `file-level symbol matches remain available for terms=${terms.join(",")}.`,
    impactedAtomIds: [],
    emittedAtMs: nowMs(),
  };
}

function symbolLineDeadlineMarker(
  skippedCount: number,
  nowMs: () => number,
): UncertaintyMarker | undefined {
  if (skippedCount === 0) return undefined;
  return {
    kind: "scope-incomplete",
    claim:
      `Symbol line lookup reached the absolute elapsed deadline and skipped ` +
      `${String(skippedCount)} definition file(s); file-level symbol matches remain available.`,
    impactedAtomIds: [],
    emittedAtMs: nowMs(),
  };
}

// Walk the tree ONCE for `**/term.*` and keep only `term.<code-ext>` definition files. The single
// walk replaces the prior
// per-extension globs (up to 27 redundant full-tree walks per question, ~4.7s on a 3.5k-file repo).
async function symbolDefinitionMatchesForTerm(
  term: string,
  input: OrchestratorInput,
  plan: ExplorationPlan,
  nowMs: () => number,
  signal: AbortSignal | undefined,
  requestContext: StructuralAdapterRequestContext,
): Promise<{
  readonly matches: readonly SymbolDefinitionMatch[];
  readonly uncertainty: readonly UncertaintyMarker[];
}> {
  const result = await requestContext.findFiles(
    symbolFileQuery(input, `**/${term}.*`),
    SYMBOL_FILE_SEARCH_LIMITS,
    {
      ...(signal === undefined ? {} : { signal }),
      searchHints: { retrievalIntent: plan.retrievalIntent },
    },
  );
  const matches: SymbolDefinitionMatch[] = [];
  for (const atom of result.atoms) {
    if (!isSymbolDefinitionPath(atom.scopePath, term)) {
      continue;
    }
    matches.push({
      atom,
      term,
      priority: symbolDefinitionPriority(atom.scopePath, term),
    });
  }
  const marker = symbolCoverageIncomplete(term, result.coverage, nowMs);
  return { matches, uncertainty: marker === undefined ? [] : [marker] };
}

async function collectSymbolDefinitionMatches(
  terms: readonly string[],
  input: OrchestratorInput,
  plan: ExplorationPlan,
  nowMs: () => number,
  signal: AbortSignal | undefined,
  requestContext: StructuralAdapterRequestContext,
  budget: AugmentationBudgetMeter,
): Promise<{
  readonly matches: readonly SymbolDefinitionMatch[];
  readonly uncertainty: readonly UncertaintyMarker[];
}> {
  const reservedTerms = reserveAugmentationSearchTerms(terms, signal, budget);
  const results = await Promise.all(
    reservedTerms.map((term) => {
      throwIfCancelled(signal);
      return symbolDefinitionMatchesForTerm(term, input, plan, nowMs, signal, requestContext);
    }),
  );
  const matches: SymbolDefinitionMatch[] = [];
  const uncertainty: UncertaintyMarker[] = [];
  for (const result of results) {
    throwIfCancelled(signal);
    matches.push(...result.matches);
    uncertainty.push(...result.uncertainty);
  }
  return { matches, uncertainty };
}

function pushUniqueAtom(atoms: EvidenceAtom[], seen: Set<string>, atom: EvidenceAtom): void {
  if (seen.has(atom.stableId)) {
    return;
  }
  seen.add(atom.stableId);
  atoms.push(atom);
}

function pushSymbolLineAtom(
  input: OrchestratorInput,
  searchScope: SearchScope,
  fs: WorkspaceFs,
  nowMs: () => number,
  match: SymbolDefinitionMatch,
  atoms: EvidenceAtom[],
  seen: Set<string>,
  control: SymbolLineScanControl,
): boolean {
  const { atom, term } = match;
  const lookup = firstSymbolLine(searchScope, fs, atom.scopePath, term, control);
  if (lookup.lineNumber === undefined) {
    return lookup.deadlineReached;
  }
  pushUniqueAtom(
    atoms,
    seen,
    symbolLineAtom(
      input.scope,
      atom.scopePath,
      lookup.lineNumber,
      atom.provenance.queryFingerprint,
      nowMs,
    ),
  );
  return false;
}

interface PrioritizedSymbolInputs {
  readonly input: OrchestratorInput;
  readonly searchScope: SearchScope;
  readonly fs: WorkspaceFs;
  readonly nowMs: () => number;
  readonly signal: AbortSignal | undefined;
  readonly deadlineAtMs: number;
}

function collectPrioritizedSymbolAtoms(
  inputs: PrioritizedSymbolInputs,
  matches: readonly SymbolDefinitionMatch[],
  terms: readonly string[],
): SymbolDiscoveryResult {
  const atoms: EvidenceAtom[] = [];
  const seen = new Set<string>();
  let remainingLineReads = MAX_SYMBOL_LINE_READS;
  let overflowCount = 0;
  let deadlineSkippedCount = 0;
  let lineDeadlineReached = false;
  const control: SymbolLineScanControl = {
    signal: inputs.signal,
    nowMs: inputs.nowMs,
    deadlineMs: inputs.deadlineAtMs,
  };
  for (const match of [...matches].sort(compareSymbolMatches)) {
    throwIfCancelled(inputs.signal);
    pushUniqueAtom(atoms, seen, match.atom);
    if (lineDeadlineReached) {
      deadlineSkippedCount += 1;
    } else if (remainingLineReads <= 0) {
      overflowCount += 1;
    } else {
      remainingLineReads -= 1;
      lineDeadlineReached = pushSymbolLineAtom(
        inputs.input,
        inputs.searchScope,
        inputs.fs,
        inputs.nowMs,
        match,
        atoms,
        seen,
        control,
      );
      if (lineDeadlineReached) deadlineSkippedCount += 1;
    }
  }
  return {
    atoms,
    uncertainty: [
      symbolLineReadOverflow(overflowCount, terms, inputs.nowMs),
      symbolLineDeadlineMarker(deadlineSkippedCount, inputs.nowMs),
    ].filter((marker): marker is UncertaintyMarker => marker !== undefined),
  };
}

async function symbolFileAtoms(
  input: OrchestratorInput,
  plan: ExplorationPlan,
  searchScope: SearchScope,
  fs: WorkspaceFs,
  nowMs: () => number,
  signal: AbortSignal | undefined,
  requestContext: StructuralAdapterRequestContext,
  deadlineAtMs: number,
  budget: AugmentationBudgetMeter,
): Promise<SymbolDiscoveryResult> {
  const terms = symbolFileAnchorTerms(plan);
  if (terms.length === 0) {
    return { atoms: [], uncertainty: [] };
  }
  const collected = await collectSymbolDefinitionMatches(
    terms,
    input,
    plan,
    nowMs,
    signal,
    requestContext,
    budget,
  );
  const prioritized = collectPrioritizedSymbolAtoms(
    {
      input,
      searchScope,
      fs,
      nowMs,
      signal,
      deadlineAtMs,
    },
    collected.matches,
    terms,
  );
  return {
    atoms: prioritized.atoms,
    uncertainty: [...collected.uncertainty, ...prioritized.uncertainty],
  };
}

function selectedFileAtom(
  scope: SelectedScope,
  scopePath: string,
  queryFingerprint: string,
  nowMs: () => number,
): EvidenceAtom {
  return {
    schemaVersion: scope.schemaVersion,
    stableId: evidenceAtomStableId({
      scopeId: scope.scopeId,
      scopePath,
      lineRange: undefined,
      provenanceKind: "file-listing",
      provenanceTool: "repo.selectedFile",
      queryFingerprint,
    }),
    scopePath,
    lineRange: undefined,
    score: 1,
    provenance: {
      kind: "file-listing",
      tool: "repo.selectedFile",
      queryFingerprint,
    },
    redactionState: "redacted",
    emittedAtMs: nowMs(),
    ledgerRef: undefined,
  };
}

function fileExistsInSearchScope(
  searchScope: SearchScope,
  fs: WorkspaceFs,
  scopePath: string,
  existsCache?: FileExistenceCache,
): boolean {
  const cached = existsCache?.files.get(scopePath);
  if (cached !== undefined) return cached;
  const parentScopePath = dirname(scopePath);
  const entryName = basenameScopePath(scopePath);
  const directory = cachedDirectoryEntries(
    searchScope,
    fs,
    parentScopePath,
    MAX_WORKSPACE_MANIFESTS,
    existsCache,
  );
  const entry = directory.entries.find((candidate) => candidate.name === entryName);
  if (entry === undefined) {
    const exists =
      directory.status === "complete"
        ? false
        : fileExistsByContainedStat(searchScope, fs, scopePath);
    existsCache?.files.set(scopePath, exists);
    return exists;
  }
  // A Dirent is only an enumeration hint. The path may have been replaced after readDir(), and a
  // hard link is reported as an ordinary file, so every positive candidate still needs the shared
  // canonical/stat authority check before it can produce evidence.
  const exists =
    entry.isFile || entry.isSymbolicLink
      ? fileExistsByContainedStat(searchScope, fs, scopePath)
      : false;
  existsCache?.files.set(scopePath, exists);
  return exists;
}

function fileExistsByContainedStat(
  searchScope: SearchScope,
  fs: WorkspaceFs,
  scopePath: string,
): boolean {
  try {
    const contained = canonicalContainedSearchPath(searchScope, fs, scopePath);
    return containedPathIsSafeRegularFile(fs, contained);
  } catch (error) {
    rethrowMetadataCancellation(error);
    return false;
  }
}

function isSafeRegularFile(stat: WorkspaceStat): boolean {
  return (
    stat.isFile &&
    !stat.isSymbolicLink &&
    (stat.hardLinkCount === undefined || stat.hardLinkCount <= 1)
  );
}

function containedPathIsSafeRegularFile(
  fs: WorkspaceFs,
  contained: ContainedSearchPath | undefined,
): boolean {
  return contained === undefined ? false : isSafeRegularFile(fs.stat(contained.path));
}

interface FileExistenceCache {
  readonly files: Map<string, boolean>;
  readonly directories: Map<string, BoundedDirectoryRead>;
  readonly truncatedDirectories: Set<string>;
  readonly unavailableDirectories: Set<string>;
  readonly metadataCoverageIssues: Map<MetadataCoverageIssue, number>;
}

function createFileExistenceCache(): FileExistenceCache {
  return {
    files: new Map(),
    directories: new Map(),
    truncatedDirectories: new Set(),
    unavailableDirectories: new Set(),
    metadataCoverageIssues: new Map(),
  };
}

function basenameScopePath(scopePath: string): string {
  const index = scopePath.lastIndexOf("/");
  return index === -1 ? scopePath : scopePath.slice(index + 1);
}

function cachedDirectoryEntries(
  searchScope: SearchScope,
  fs: WorkspaceFs,
  scopePath: string,
  maxEntries: number,
  existsCache?: FileExistenceCache,
): BoundedDirectoryRead {
  const cacheKey = `${maxEntries.toString()}:${scopePath}`;
  const cached = existsCache?.directories.get(cacheKey);
  if (cached !== undefined) return cached;
  const read = safeReadDir(searchScope, fs, scopePath, maxEntries);
  existsCache?.directories.set(cacheKey, read);
  if (read.status === "truncated") existsCache?.truncatedDirectories.add(scopePath);
  if (read.status === "unavailable") existsCache?.unavailableDirectories.add(scopePath);
  return read;
}

function selectedFileScopeAtoms(
  input: OrchestratorInput,
  searchScope: SearchScope,
  fs: WorkspaceFs,
  nowMs: () => number,
  existsCache?: FileExistenceCache,
  deadlineAtMs?: number,
  signal?: AbortSignal,
): readonly EvidenceAtom[] {
  if (input.scope.explicitConnection !== true || input.scope.kind !== "files") {
    return [];
  }
  const atoms: EvidenceAtom[] = [];
  const seen = new Set<string>();
  const queryFingerprint = selectedFileQueryFingerprint(input.query);
  const guardedFs = cancellationGuardedWorkspaceFs(fs, signal);
  for (const entry of input.scope.relativePaths) {
    throwIfCancelled(signal);
    if (deadlineAtMs !== undefined && nowMs() >= deadlineAtMs) break;
    if (!isValidScopePath(entry, { mustBeRelative: true })) {
      continue;
    }
    const scopePath = entry.replaceAll("\\", "/");
    if (seen.has(scopePath)) {
      continue;
    }
    seen.add(scopePath);
    // Connected documents (supported DOCX/XLSX/PDF, or a known-unsupported document format) are not
    // code-first excerpt files; they are handled exclusively by bounded document extraction (Issue
    // #1285), so they must not also enter the line-window excerpt path here — that would double-count
    // the file and leave an empty, unreadable code excerpt alongside the document evidence/diagnostic.
    if (isConnectedDocumentPath(scopePath)) {
      continue;
    }
    if (fileExistsInSearchScope(searchScope, guardedFs, scopePath, existsCache)) {
      atoms.push(selectedFileAtom(input.scope, scopePath, queryFingerprint, nowMs));
    }
  }
  return atoms;
}

// Accept a candidate injection path once: not already seen, shape-valid, and NOT deny-listed.
// isDenied is re-checked here (not only at the downstream read gate) so a registry manifest pattern
// can never inject a deny-listed/secret path as a score-1 atom; registry patterns are also asserted
// deny-clean in ecosystems.test.ts. Mutates `seen` on acceptance.
function acceptInjectionScopePath(scopePath: string, seen: Set<string>): boolean {
  if (
    seen.has(scopePath) ||
    !isValidScopePath(scopePath, { mustBeRelative: true }) ||
    isDenied(scopePath)
  ) {
    return false;
  }
  seen.add(scopePath);
  return true;
}

// Bound on glob-manifest atoms injected per metadata root from a single directory listing (M4,
// risk #1). The exact-name loop above handles fixed basenames; this catches GLOB manifests at the
// root/scope dir (e.g. *.csproj, *.tf) that have no fixed name. Deny-checked + deduped + capped.
const MAX_ROOT_GLOB_MANIFESTS = 16;

// Bounded glob-manifest sweep of a single directory: returns the accepted (deduped, deny-clean,
// shape-valid) scope paths, capped at MAX_ROOT_GLOB_MANIFESTS. Mutates `seen` via the gate.
function rootGlobManifestPaths(
  root: string,
  searchScope: SearchScope,
  fs: WorkspaceFs,
  seen: Set<string>,
  control: MetadataTraversalControl,
  existsCache?: FileExistenceCache,
): readonly string[] {
  if (!metadataTraversalCanContinue(control)) return [];
  const paths: string[] = [];
  for (const scopePath of canonicalManifestScopePathsInDir(
    root,
    searchScope,
    fs,
    MAX_ROOT_GLOB_MANIFESTS,
    existsCache,
  )) {
    if (paths.length >= MAX_ROOT_GLOB_MANIFESTS) {
      break;
    }
    if (acceptInjectionScopePath(scopePath, seen)) {
      paths.push(scopePath);
    }
  }
  return paths;
}

interface MetadataAtomCollectionContext {
  readonly input: OrchestratorInput;
  readonly searchScope: SearchScope;
  readonly fs: WorkspaceFs;
  readonly nowMs: () => number;
  readonly queryFingerprint: string;
  readonly control: MetadataTraversalControl;
  readonly existsCache: FileExistenceCache;
  readonly seen: Set<string>;
}

function projectMetadataRootAtoms(
  root: string,
  context: MetadataAtomCollectionContext,
): readonly EvidenceAtom[] {
  const { input, searchScope, fs, nowMs, queryFingerprint, control, existsCache, seen } = context;
  const atoms: EvidenceAtom[] = [];
  for (const filename of PROJECT_METADATA_FILENAMES) {
    if (!metadataTraversalCanContinue(control)) break;
    const scopePath = joinScopePath(root, filename);
    if (
      acceptInjectionScopePath(scopePath, seen) &&
      fileExistsInSearchScope(searchScope, fs, scopePath, existsCache)
    ) {
      atoms.push(metadataAtom(input.scope, scopePath, queryFingerprint, nowMs));
    }
  }
  for (const scopePath of rootGlobManifestPaths(
    root,
    searchScope,
    fs,
    seen,
    control,
    existsCache,
  )) {
    atoms.push(metadataAtom(input.scope, scopePath, queryFingerprint, nowMs));
  }
  return atoms;
}

function workspacePackageMetadataAtoms(
  context: MetadataAtomCollectionContext,
): readonly EvidenceAtom[] {
  const { input, searchScope, fs, nowMs, queryFingerprint, control, existsCache, seen } = context;
  const atoms: EvidenceAtom[] = [];
  for (const scopePath of workspacePackageManifestPaths(
    input,
    searchScope,
    fs,
    control,
    existsCache,
  )) {
    if (!metadataTraversalCanContinue(control)) break;
    if (acceptInjectionScopePath(scopePath, seen)) {
      atoms.push(metadataAtom(input.scope, scopePath, queryFingerprint, nowMs));
    }
  }
  return atoms;
}

function projectMetadataAtoms(
  input: OrchestratorInput,
  intent: RetrievalIntent,
  searchScope: SearchScope,
  fs: WorkspaceFs,
  nowMs: () => number,
  queryFingerprint: string,
  control: MetadataTraversalControl,
  existsCache: FileExistenceCache,
): readonly EvidenceAtom[] {
  if (!wantsProjectMetadata(input, intent) || !metadataTraversalCanContinue(control)) {
    return [];
  }
  const atoms: EvidenceAtom[] = [];
  const seen = new Set<string>();
  const context: MetadataAtomCollectionContext = {
    input,
    searchScope,
    fs,
    nowMs,
    queryFingerprint,
    control,
    existsCache,
    seen,
  };
  for (const root of metadataRootsForScope(input.scope)) {
    if (!metadataTraversalCanContinue(control)) break;
    atoms.push(...projectMetadataRootAtoms(root, context));
  }
  atoms.push(...workspacePackageMetadataAtoms(context));
  return atoms;
}

function repositoryOverviewAtoms(
  input: OrchestratorInput,
  intent: RetrievalIntent,
  searchScope: SearchScope,
  fs: WorkspaceFs,
  nowMs: () => number,
  queryFingerprint: string,
  control: MetadataTraversalControl,
  existsCache?: FileExistenceCache,
): readonly EvidenceAtom[] {
  if (!wantsRepositoryOverview(intent) || !metadataTraversalCanContinue(control)) {
    return [];
  }
  const atoms: EvidenceAtom[] = [];
  const seen = new Set<string>();
  for (const root of metadataRootsForScope(input.scope)) {
    if (!metadataTraversalCanContinue(control)) break;
    for (const filename of REPOSITORY_OVERVIEW_FILENAMES) {
      if (!metadataTraversalCanContinue(control)) break;
      const scopePath = joinScopePath(root, filename);
      if (
        acceptInjectionScopePath(scopePath, seen) &&
        fileExistsInSearchScope(searchScope, fs, scopePath, existsCache)
      ) {
        atoms.push(overviewAtom(input.scope, scopePath, queryFingerprint, nowMs));
      }
    }
  }
  return atoms;
}

interface DeterministicContextEvidence {
  readonly atoms: readonly EvidenceAtom[];
  readonly uncertainty: readonly UncertaintyMarker[];
}

function metadataDirectoryCoverageUncertainty(
  cache: FileExistenceCache,
  nowMs: number,
): readonly UncertaintyMarker[] {
  const markers: UncertaintyMarker[] = [];
  if (cache.truncatedDirectories.size > 0) {
    markers.push({
      kind: "scope-incomplete",
      claim:
        `project metadata discovery was truncated by bounded directory reads in ` +
        `${String(cache.truncatedDirectories.size)} directory path(s); relevant manifests may be missing`,
      impactedAtomIds: [],
      emittedAtMs: nowMs,
    });
  }
  if (cache.unavailableDirectories.size > 0) {
    markers.push({
      kind: "scope-incomplete",
      claim:
        `project metadata discovery could not enumerate ` +
        `${String(cache.unavailableDirectories.size)} directory path(s); ` +
        `exact manifest probes were used but glob manifests may be missing`,
      impactedAtomIds: [],
      emittedAtMs: nowMs,
    });
  }
  return markers;
}

function metadataManifestCoverageUncertainty(
  cache: FileExistenceCache,
  nowMs: number,
): readonly UncertaintyMarker[] {
  if (cache.metadataCoverageIssues.size === 0) return [];
  const issueCounts = [...cache.metadataCoverageIssues]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([issue, count]) => `${issue}:${String(count)}`)
    .join(",");
  return [
    {
      kind: "scope-incomplete",
      claim:
        `project metadata discovery skipped bounded or unsupported workspace metadata ` +
        `(reasons=${issueCounts}); workspace package manifests may be missing`,
      impactedAtomIds: [],
      emittedAtMs: nowMs,
    },
  ];
}

function deterministicMetadataEvidence(
  input: OrchestratorInput,
  plan: ExplorationPlan,
  searchScope: SearchScope,
  fs: WorkspaceFs,
  nowMs: () => number,
  signal: AbortSignal | undefined,
  deadlineAtMs: number,
): DeterministicContextEvidence {
  const control: MetadataTraversalControl = { signal, nowMs, deadlineAtMs };
  const guardedFs = metadataTraversalFs(fs, control);
  const existsCache = createFileExistenceCache();
  const queryFingerprint = projectMetadataQueryFingerprint(input.query);
  const atoms = [
    ...projectMetadataAtoms(
      input,
      plan.retrievalIntent,
      searchScope,
      guardedFs,
      nowMs,
      queryFingerprint,
      control,
      existsCache,
    ),
    ...repositoryOverviewAtoms(
      input,
      plan.retrievalIntent,
      searchScope,
      guardedFs,
      nowMs,
      queryFingerprint,
      control,
      existsCache,
    ),
  ];
  const emittedAtMs = nowMs();
  return {
    atoms,
    uncertainty: [
      ...metadataDirectoryCoverageUncertainty(existsCache, emittedAtMs),
      ...metadataManifestCoverageUncertainty(existsCache, emittedAtMs),
    ],
  };
}

type ParallelDeterministicEvidence = readonly [
  DeterministicContextEvidence,
  DeterministicContextEvidence,
  DeterministicContextEvidence,
];

async function collectParallelDeterministicEvidence(
  input: OrchestratorInput,
  plan: ExplorationPlan,
  searchScope: SearchScope,
  fs: WorkspaceFs,
  nowMs: () => number,
  signal: AbortSignal | undefined,
  fileSearchContext: StructuralAdapterRequestContext,
  traceContext: StructuralAdapterRequestContext,
  deadlineAtMs: number,
  budget: AugmentationBudgetMeter,
): Promise<ParallelDeterministicEvidence> {
  return Promise.all([
    collectFollowSymbolTraceEvidence({
      scope: input.scope,
      query: input.query,
      anchors: plan.anchors,
      retrievalIntent: plan.retrievalIntent,
      searchScope,
      fs,
      nowMs,
      signal,
      requestContext: traceContext,
      deadlineAtMs,
      tryReserveSearchCall: budget.tryReserveSearchCall,
    }),
    symbolFileAtoms(
      input,
      plan,
      searchScope,
      fs,
      nowMs,
      signal,
      fileSearchContext,
      deadlineAtMs,
      budget,
    ),
    documentReferenceAtoms(input, plan, nowMs, signal, fileSearchContext, budget),
  ]);
}

async function deterministicContextEvidence(
  input: OrchestratorInput,
  plan: ExplorationPlan,
  searchScope: SearchScope,
  fs: WorkspaceFs,
  nowMs: () => number,
  signal: AbortSignal | undefined,
  structuralContexts: StructuralRequestContextPool,
  deadlineAtMs: number,
  budget: AugmentationBudgetMeter,
): Promise<DeterministicContextEvidence> {
  const fileSearchContext = structuralContexts.forLimits(SYMBOL_FILE_SEARCH_LIMITS);
  const traceContext = structuralContexts.forLimits(GROUNDED_TRACE_SEARCH_LIMITS);
  const [traceEvidence, symbolDiscovery, referencedDocuments] =
    await collectParallelDeterministicEvidence(
      input,
      plan,
      searchScope,
      fs,
      nowMs,
      signal,
      fileSearchContext,
      traceContext,
      deadlineAtMs,
      budget,
    );
  const metadata = budget.canContinue()
    ? deterministicMetadataEvidence(input, plan, searchScope, fs, nowMs, signal, deadlineAtMs)
    : { atoms: [], uncertainty: [] };
  return {
    atoms: [
      ...symbolDiscovery.atoms,
      ...traceEvidence.atoms,
      ...referencedDocuments.atoms,
      ...metadata.atoms,
    ],
    uncertainty: [
      ...symbolDiscovery.uncertainty,
      ...traceEvidence.uncertainty,
      ...referencedDocuments.uncertainty,
      ...metadata.uncertainty,
    ],
  };
}

async function withDeterministicContextAtoms(
  rings: RingRunSummary,
  input: OrchestratorInput,
  plan: ExplorationPlan,
  searchScope: SearchScope,
  fs: WorkspaceFs,
  nowMs: () => number,
  signal: AbortSignal | undefined,
  structuralContexts: StructuralRequestContextPool,
  deadlineAtMs: number,
  budget: AugmentationBudgetMeter,
): Promise<RingRunSummary> {
  const deterministic = await deterministicContextEvidence(
    input,
    plan,
    searchScope,
    fs,
    nowMs,
    signal,
    structuralContexts,
    deadlineAtMs,
    budget,
  );
  if (deterministic.atoms.length === 0 && deterministic.uncertainty.length === 0) {
    return rings;
  }
  return {
    ...rings,
    atoms: [...rings.atoms, ...deterministic.atoms],
    uncertainty: [...rings.uncertainty, ...deterministic.uncertainty],
  };
}

function withExplicitScopeAtoms(
  rings: RingRunSummary,
  input: OrchestratorInput,
  searchScope: SearchScope,
  fs: WorkspaceFs,
  nowMs: () => number,
  deadlineAtMs: number,
  signal: AbortSignal | undefined,
): RingRunSummary {
  const selectedAtoms = selectedFileScopeAtoms(
    input,
    searchScope,
    fs,
    nowMs,
    createFileExistenceCache(),
    deadlineAtMs,
    signal,
  );
  return selectedAtoms.length === 0
    ? rings
    : { ...rings, atoms: [...selectedAtoms, ...rings.atoms] };
}

function queryTerms(queryText: string, anchors: readonly SearchAnchor[]): readonly string[] {
  const terms = new Set<string>();
  const loweredQuery = queryText.toLowerCase();
  for (const token of loweredQuery.split(/[^a-z0-9._/-]+/)) {
    if (token.length > 0) {
      terms.add(token);
    }
  }
  for (const anchor of anchors) {
    const lowered = anchor.term.toLowerCase();
    if (lowered.length > 0) {
      terms.add(lowered);
    }
    for (const token of lowered.split(/[^a-z0-9._/-]+/)) {
      if (token.length > 0) {
        terms.add(token);
      }
    }
  }
  return [...terms];
}

function explicitlyTargetsRuntimeArtifact(
  scopePath: string,
  queryText: string,
  anchors: readonly SearchAnchor[],
): boolean {
  if (!isKeikoEvidenceArtifact(scopePath)) {
    return false;
  }
  const loweredQuery = queryText.toLowerCase();
  if (loweredQuery.includes(".keiko") || loweredQuery.includes("evidence artifact")) {
    return true;
  }
  return queryTerms(queryText, anchors).some((term) => scopePath.toLowerCase().includes(term));
}

function explicitlyTargetsLockfile(
  scopePath: string,
  queryText: string,
  anchors: readonly SearchAnchor[],
): boolean {
  if (!isLockfilePath(scopePath)) {
    return false;
  }
  const loweredQuery = queryText.toLowerCase();
  if (
    loweredQuery.includes("lockfile") ||
    loweredQuery.includes("package manager") ||
    loweredQuery.includes("packagemanager") ||
    loweredQuery.includes("dependency version") ||
    loweredQuery.includes("dependency versions") ||
    loweredQuery.includes("resolved version") ||
    loweredQuery.includes("resolved versions")
  ) {
    return true;
  }
  const path = scopePath.toLowerCase();
  const name = basename(scopePath).toLowerCase();
  return queryTerms(queryText, anchors).some((term) => path.includes(term) || name === term);
}

function refineCandidateOrdering(
  kept: readonly CandidateFile[],
  omitted: readonly OmittedContextEntry[],
  query: RetrievalQuery,
  anchors: readonly SearchAnchor[],
  diagnostics: ContextPackDiagnostics | undefined,
  nowMs: number,
): CandidateOrdering {
  const queryText = query.text;
  const preferred: CandidateFile[] = [];
  const lockfiles: CandidateFile[] = [];
  const runtimeArtifacts: CandidateFile[] = [];

  for (const candidate of kept) {
    const scopePath = candidate.scopePath;
    if (
      isKeikoEvidenceArtifact(scopePath) &&
      !explicitlyTargetsRuntimeArtifact(scopePath, queryText, anchors)
    ) {
      runtimeArtifacts.push(candidate);
      continue;
    }
    if (isLockfilePath(scopePath) && !explicitlyTargetsLockfile(scopePath, queryText, anchors)) {
      lockfiles.push(candidate);
      continue;
    }
    preferred.push(candidate);
  }

  if (preferred.length === 0) {
    return { kept, omitted };
  }

  const nextOmitted = [...omitted];
  for (const candidate of runtimeArtifacts) {
    nextOmitted.push({
      scopePath: candidate.scopePath,
      reason: "low-relevance",
      omittedAtMs: nowMs,
    });
  }
  nextOmitted.sort(compareByScopePath);
  const useSearchOrder =
    queryTargetsRouteImplementation(queryText) ||
    directDefinitionSymbol(query, anchors) !== undefined;
  const orderedPreferred = useSearchOrder
    ? orderPreferredCandidates(preferred, diagnostics)
    : preferred;
  return {
    kept: [...orderedPreferred, ...lockfiles],
    omitted: nextOmitted,
  };
}

const ROUTE_METHOD_QUERY_RE = /\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/iu;
const ROUTE_PATH_QUERY_RE = /\/[A-Za-z0-9:_?&=./-]*[A-Za-z0-9_}/-]/u;
const ROUTE_INTENT_QUERY_RE =
  /\b(?:api|endpoint|handler|implement|implements|implemented|route)\b/iu;

function queryTargetsRouteImplementation(queryText: string): boolean {
  return (
    ROUTE_METHOD_QUERY_RE.test(queryText) &&
    ROUTE_PATH_QUERY_RE.test(queryText) &&
    ROUTE_INTENT_QUERY_RE.test(queryText)
  );
}

function orderPreferredCandidates(
  kept: readonly CandidateFile[],
  diagnostics: ContextPackDiagnostics | undefined,
): readonly CandidateFile[] {
  const ranked = diagnostics?.rankedCandidates ?? [];
  if (ranked.length === 0 || kept.length <= 1) {
    return kept;
  }
  const byPath = new Map(kept.map((candidate) => [candidate.scopePath, candidate]));
  const routeCandidate = ranked
    .map((candidate) => byPath.get(candidate.scopePath))
    .find((candidate) => candidate !== undefined);
  if (routeCandidate === undefined) return kept;
  return [routeCandidate, ...kept.filter((candidate) => candidate !== routeCandidate)];
}

function groupEvidenceAtomsByPath(
  atoms: readonly EvidenceAtom[],
): ReadonlyMap<string, readonly EvidenceAtom[]> {
  const grouped = new Map<string, EvidenceAtom[]>();
  for (const atom of atoms) {
    const existing = grouped.get(atom.scopePath);
    if (existing === undefined) {
      grouped.set(atom.scopePath, [atom]);
    } else {
      existing.push(atom);
    }
  }
  return grouped;
}

function lineWindowForAtom(atom: EvidenceAtom): LineWindow {
  const range = atom.lineRange;
  if (range === undefined) {
    return DEFAULT_EXCERPT_WINDOW;
  }
  const isDiscoveredDefinition = atom.provenance.tool === "discovered-symbol-definition";
  const addSingleLineContext =
    range.startLine === range.endLine &&
    atom.provenance.kind !== "semantic-search" &&
    atom.provenance.kind !== "model-rerank";
  let contextBefore: number;
  let contextAfter: number;
  if (isDiscoveredDefinition) {
    contextBefore = 0;
    contextAfter = DISCOVERED_DEFINITION_CONTEXT_AFTER;
  } else {
    const surroundingContext = addSingleLineContext ? SINGLE_LINE_EXCERPT_CONTEXT_LINES : 0;
    contextBefore = surroundingContext;
    contextAfter = surroundingContext;
  }
  return {
    startLine: Math.max(1, range.startLine - contextBefore),
    endLine: range.endLine + contextAfter,
  };
}

function mergeLineWindows(windows: readonly LineWindow[]): readonly LineWindow[] {
  const sorted = [...windows].sort((a, b) =>
    a.startLine === b.startLine ? a.endLine - b.endLine : a.startLine - b.startLine,
  );
  const merged: LineWindow[] = [];
  for (const window of sorted) {
    const previous = merged.at(-1);
    if (previous === undefined || window.startLine > previous.endLine + 1) {
      merged.push(window);
      continue;
    }
    merged[merged.length - 1] = {
      startLine: previous.startLine,
      endLine: Math.max(previous.endLine, window.endLine),
    };
  }
  return merged;
}

function windowContainsAtom(window: LineWindow, atom: EvidenceAtom): boolean {
  const range = atom.lineRange;
  return (
    range === undefined || (window.startLine <= range.startLine && window.endLine >= range.endLine)
  );
}

interface ExcerptWindowStrength {
  readonly tracePriority: number;
  readonly score: number;
}

function windowsOverlap(a: LineWindow, b: LineWindow): boolean {
  return a.startLine <= b.endLine && b.startLine <= a.endLine;
}

function mergeWindowsByTracePriority(atomsForPath: readonly EvidenceAtom[]): readonly LineWindow[] {
  const selected: LineWindow[] = [];
  for (const priority of [2, 1, 0]) {
    const windows = mergeLineWindows(
      atomsForPath.filter((atom) => tracePriority(atom) === priority).map(lineWindowForAtom),
    );
    selected.push(
      ...windows.filter((window) => !selected.some((kept) => windowsOverlap(kept, window))),
    );
  }
  return selected;
}

function strongerExcerptWindow(
  candidate: ExcerptWindowStrength,
  current: ExcerptWindowStrength,
): ExcerptWindowStrength {
  if (candidate.tracePriority !== current.tracePriority) {
    return candidate.tracePriority > current.tracePriority ? candidate : current;
  }
  return candidate.score > current.score ? candidate : current;
}

function strongestAtomStrengthForWindow(
  window: LineWindow,
  atomsForPath: readonly EvidenceAtom[],
): ExcerptWindowStrength {
  let strength: ExcerptWindowStrength = { tracePriority: 0, score: 0 };
  for (const atom of atomsForPath) {
    if (windowContainsAtom(window, atom)) {
      strength = strongerExcerptWindow(
        { tracePriority: tracePriority(atom), score: atom.score },
        strength,
      );
    }
  }
  return strength;
}

function compareExcerptWindows(
  a: LineWindow,
  b: LineWindow,
  atomsForPath: readonly EvidenceAtom[],
): number {
  const aStrength = strongestAtomStrengthForWindow(a, atomsForPath);
  const bStrength = strongestAtomStrengthForWindow(b, atomsForPath);
  const priorityDelta = bStrength.tracePriority - aStrength.tracePriority;
  if (priorityDelta !== 0) return priorityDelta;
  const scoreDelta = bStrength.score - aStrength.score;
  return scoreDelta === 0 ? a.startLine - b.startLine : scoreDelta;
}

interface ExcerptWindowSelection {
  readonly windows: readonly LineWindow[];
  readonly omittedWindowCount: number;
}

function excerptLineWindows(
  atomsForPath: readonly EvidenceAtom[] | undefined,
): ExcerptWindowSelection {
  if (atomsForPath === undefined || atomsForPath.length === 0) {
    return { windows: [DEFAULT_EXCERPT_WINDOW], omittedWindowCount: 0 };
  }
  const merged = mergeWindowsByTracePriority(atomsForPath);
  const selected = [...merged]
    .sort((a, b) => compareExcerptWindows(a, b, atomsForPath))
    .slice(0, MAX_EXCERPT_WINDOWS_PER_FILE);
  return {
    windows: selected,
    omittedWindowCount: Math.max(0, merged.length - selected.length),
  };
}

function exhaustedDimensions(remainingFiles: number, remainingBytes: number): string {
  return [
    ...(remainingFiles <= 0 ? ["filesRead"] : []),
    ...(remainingBytes <= 0 ? ["excerptBytes"] : []),
  ].join(", ");
}

interface ReadPathExcerptWindowsResult {
  readonly windows: readonly ExcerptWindow[];
  readonly bytesConsumed: number;
  readonly omittedWindowCount: number;
  readonly truncatedWindowCount: number;
  readonly deadlineReached: boolean;
}

interface ReadPathExcerptTaskResult {
  readonly scopePath: string;
  readonly result?: ReadPathExcerptWindowsResult | undefined;
  readonly skippedReason?: "too-large" | "unsupported" | undefined;
}

async function readPathExcerptWindows(
  scopePath: string,
  inputs: ExcerptInputs,
  remainingBytes: number,
): Promise<ReadPathExcerptWindowsResult> {
  const windows: ExcerptWindow[] = [];
  let bytesConsumed = 0;
  let truncatedWindowCount = 0;
  let deadlineReached = false;
  const selection = excerptLineWindows(inputs.atomsByPath.get(scopePath));
  for (const window of selection.windows) {
    throwIfCancelled(inputs.signal);
    if (inputs.nowMs() >= inputs.deadlineAtMs) {
      deadlineReached = true;
      break;
    }
    const availableBytes = remainingBytes - bytesConsumed;
    if (availableBytes <= 0) {
      break;
    }
    const maxBytes = Math.min(8192, availableBytes);
    const result = await readExcerpt(
      inputs.searchScope,
      { scopePath, startLine: window.startLine, endLine: window.endLine, maxBytes },
      {
        fs: inputs.fs,
        nowMs: inputs.nowMs,
        deadlineAtMs: inputs.deadlineAtMs,
        ...(inputs.signal === undefined ? {} : { signal: inputs.signal }),
      },
    );
    throwIfCancelled(inputs.signal);
    if (inputs.nowMs() >= inputs.deadlineAtMs) deadlineReached = true;
    if (result.truncated) {
      truncatedWindowCount += 1;
    }
    const actualRange = result.atom.lineRange;
    if (actualRange !== undefined) {
      windows.push({ ...actualRange, content: result.content });
    }
    bytesConsumed += utf8ByteLength(result.content);
  }
  return {
    windows,
    bytesConsumed,
    omittedWindowCount: selection.omittedWindowCount,
    truncatedWindowCount,
    deadlineReached,
  };
}

function excerptWindowUncertainty(
  scopePath: string,
  result: ReadPathExcerptWindowsResult,
  nowMs: () => number,
): readonly UncertaintyMarker[] {
  const markers: UncertaintyMarker[] = [];
  if (result.omittedWindowCount > 0) {
    markers.push({
      kind: "scope-incomplete",
      claim: `excerpt window limit omitted ${String(result.omittedWindowCount)} additional matching range(s) in ${scopePath}`,
      impactedAtomIds: [],
      emittedAtMs: nowMs(),
    });
  }
  if (result.truncatedWindowCount > 0) {
    markers.push({
      kind: "scope-incomplete",
      claim:
        `excerpt byte limit truncated ${String(result.truncatedWindowCount)} selected ` +
        `range(s) in ${scopePath}`,
      impactedAtomIds: [],
      emittedAtMs: nowMs(),
    });
  }
  return markers;
}

function largeFileExcerptOmitted(scopePath: string, nowMs: () => number): UncertaintyMarker {
  return {
    kind: "scope-incomplete",
    claim: `large file omitted from excerpt evidence because it exceeds the bounded read cap: ${scopePath}`,
    impactedAtomIds: [],
    emittedAtMs: nowMs(),
  };
}

function distributeByteBudget(totalBytes: number, slots: number): readonly number[] {
  if (slots <= 0 || totalBytes <= 0) return [];
  const base = Math.floor(totalBytes / slots);
  const remainder = totalBytes % slots;
  return Array.from({ length: slots }, (_value, index) => base + (index < remainder ? 1 : 0));
}

async function readPathExcerptTask(
  scopePath: string,
  inputs: ExcerptInputs,
  byteBudget: number,
): Promise<ReadPathExcerptTaskResult> {
  try {
    return {
      scopePath,
      result: await readPathExcerptWindows(scopePath, inputs, byteBudget),
    };
  } catch (error) {
    // A single unreadable file (unsupported/binary, or larger than the excerpt read cap) must
    // degrade to a skipped excerpt, never crash the whole grounded answer. Other kept files and
    // the rest of the pipeline continue; the file simply contributes no excerpt content.
    if (error instanceof FileTooLargeError) {
      return { scopePath, skippedReason: "too-large" };
    }
    if (error instanceof RepoSearchUnsupportedFileError) {
      return { scopePath, skippedReason: "unsupported" };
    }
    throw error;
  }
}

interface RemainingExcerptCapacity {
  readonly files: number;
  readonly bytes: number;
}

function remainingExcerptCapacity(inputs: ExcerptInputs): RemainingExcerptCapacity {
  return {
    files: Math.max(0, inputs.budget.filesReadMax - inputs.initialUsage.filesRead),
    bytes: Math.max(0, inputs.budget.excerptBytesMax - inputs.initialUsage.excerptBytes),
  };
}

async function readKeptExcerpts(
  keptPaths: readonly string[],
  inputs: ExcerptInputs,
): Promise<ExcerptReadSummary> {
  const excerpts = new Map<string, readonly ExcerptWindow[]>();
  const uncertainty: UncertaintyMarker[] = [];
  const { files: remainingFiles, bytes: remainingBytes } = remainingExcerptCapacity(inputs);
  if (inputs.nowMs() >= inputs.deadlineAtMs) {
    return {
      excerpts,
      uncertainty: [budgetClipped("budget-exhausted on elapsedMs", inputs.nowMs())],
    };
  }
  if (remainingFiles <= 0 || remainingBytes <= 0) {
    const dimensions = exhaustedDimensions(remainingFiles, remainingBytes);
    return {
      excerpts,
      uncertainty: [budgetClipped(`budget-exhausted on ${dimensions}`, inputs.nowMs())],
    };
  }
  const readablePaths = keptPaths.slice(0, remainingFiles);
  if (readablePaths.length < keptPaths.length) {
    uncertainty.push(budgetClipped("budget-exhausted on filesRead", inputs.nowMs()));
  }
  const byteBudgets = distributeByteBudget(remainingBytes, readablePaths.length);
  const results = await Promise.all(
    readablePaths.map((scopePath, index) => {
      throwIfCancelled(inputs.signal);
      return readPathExcerptTask(scopePath, inputs, byteBudgets[index] ?? 0);
    }),
  );
  for (const { scopePath, result, skippedReason } of results) {
    throwIfCancelled(inputs.signal);
    if (result === undefined || result.windows.length === 0) {
      if (skippedReason === "too-large") {
        uncertainty.push(largeFileExcerptOmitted(scopePath, inputs.nowMs));
      }
      continue;
    }
    excerpts.set(scopePath, result.windows);
    uncertainty.push(...excerptWindowUncertainty(scopePath, result, inputs.nowMs));
  }
  if (results.some(({ result }) => result?.deadlineReached === true)) {
    uncertainty.push(budgetClipped("budget-exhausted on elapsedMs", inputs.nowMs()));
  }
  return { excerpts, uncertainty };
}

function buildSearchScope(scope: SelectedScope, workspace: WorkspaceInfo): SearchScope {
  return {
    workspace,
    scopeId: scope.scopeId,
    relativePaths: scope.relativePaths,
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function strongFileCacheIdentity(
  scopePath: string,
  canonicalRelativePath: string,
  stat: WorkspaceStat,
): string | undefined {
  if (
    canonicalRelativePath !== scopePath ||
    !stat.isFile ||
    stat.isSymbolicLink ||
    stat.hardLinkCount !== 1 ||
    !isNonEmptyString(stat.fileIdentity) ||
    !isNonEmptyString(stat.mtimeNs) ||
    !isNonEmptyString(stat.ctimeNs)
  ) {
    return undefined;
  }
  return JSON.stringify({
    scopePath,
    canonicalRelativePath,
    size: stat.size,
    fileIdentity: stat.fileIdentity,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
    hardLinkCount: stat.hardLinkCount,
  });
}

function fileStateCacheIdentity(
  keptPaths: readonly string[],
  searchScope: SearchScope,
  fs: WorkspaceFs,
  nowMs: () => number,
  deadlineAtMs: number,
  signal?: AbortSignal,
): PackCacheIdentity | undefined {
  const identity: string[] = [];
  const guardedFs = cancellationGuardedWorkspaceFs(fs, signal);
  try {
    for (const scopePath of keptPaths) {
      throwIfCancelled(signal);
      if (nowMs() >= deadlineAtMs) return undefined;
      const target = canonicalContainedSearchPath(searchScope, guardedFs, scopePath);
      if (target === undefined) return undefined;
      throwIfCancelled(signal);
      if (nowMs() >= deadlineAtMs) return undefined;
      const stat = guardedFs.stat(target.path);
      const strongIdentity = strongFileCacheIdentity(scopePath, target.realRelative, stat);
      if (strongIdentity === undefined) return undefined;
      identity.push(strongIdentity);
    }
  } catch (error) {
    rethrowMetadataCancellation(error);
    return undefined;
  }
  return identity.sort((left, right) => left.localeCompare(right));
}

// Internal mutation seam: package-local tests pin cancellation between synchronous cache-identity
// probes without exposing this implementation detail from the server package root.
export function _fileStateCacheIdentityForTests(
  keptPaths: readonly string[],
  searchScope: SearchScope,
  fs: WorkspaceFs,
  nowMs: () => number,
  deadlineAtMs: number,
  signal: AbortSignal | undefined,
): readonly string[] | undefined {
  return fileStateCacheIdentity(keptPaths, searchScope, fs, nowMs, deadlineAtMs, signal);
}

interface ReadyPlanResult {
  readonly plan: ExplorationPlan;
  readonly governor: GovernorState;
}

function createReadyGovernedPlan(input: OrchestratorInput, nowMs: () => number): ReadyPlanResult {
  const planned = planAndGovern(
    input.budget === undefined
      ? { scope: input.scope, query: input.query }
      : { scope: input.scope, query: input.query, budget: input.budget },
    { nowMs },
  );
  const { plan } = planned;
  if (plan.state !== "ready") {
    if (plan.clarification !== undefined) {
      throw new ClarificationNeededError(plan.clarification);
    }
    throw new ClarificationNeededError({
      reason: "scope-invalid",
      suggestedQuestions: ["Reselect files or a directory before asking."],
      minimumAnchorCount: 0,
    });
  }
  if (planned.governor === undefined) {
    throw new Error("ready exploration plan did not produce a budget governor");
  }
  return { plan, governor: planned.governor };
}

interface AssembleGroundedPackInputs {
  readonly input: OrchestratorInput;
  readonly deps: OrchestratorDeps;
  readonly plan: ExplorationPlan;
  readonly rings: RingRunSummary;
  readonly searchScope: SearchScope;
  readonly fs: WorkspaceFs;
  readonly nowMs: () => number;
  readonly structuralContexts: StructuralRequestContextPool;
  readonly workspaceIndex: WorkspaceIndex | undefined;
  readonly deadlineAtMs: number;
}

interface EmptyGroundedPackInputs {
  readonly input: OrchestratorInput;
  readonly deps: OrchestratorDeps;
  readonly plan: ExplorationPlan;
  readonly governor: GovernorState;
  readonly nowMs: () => number;
  readonly stopReason: string;
}

interface GroundedPackCacheLookupInputs {
  readonly input: OrchestratorInput;
  readonly plan: ExplorationPlan;
  readonly rings: RingRunSummary;
  readonly atoms: readonly EvidenceAtom[];
  readonly ordered: CandidateOrdering;
  readonly cacheIdentity: PackCacheIdentity | undefined;
  readonly initialUsage: ExplorationUsage;
  readonly assembleOptions: AssembleOptionsForGroundedPack;
}

interface AssembleOptionsForGroundedPack {
  readonly nowMs: () => number;
  readonly microIndex?: MicroIndex;
  readonly reranker?: RerankerSeam;
}

function deadlineBoundMicroIndex(
  index: MicroIndex,
  nowMs: () => number,
  deadlineAtMs: number,
): MicroIndex {
  const canStart = (): boolean => nowMs() < deadlineAtMs;
  return {
    get: (key): ConnectedContextPack | undefined => (canStart() ? index.get(key) : undefined),
    set: (key, pack): void => {
      if (canStart()) index.set(key, pack);
    },
    delete: index.delete.bind(index),
    clear: index.clear.bind(index),
    size: index.size.bind(index),
  };
}

async function raceRerankerToDeadline<T>(
  operation: (context: RerankerExecutionContext) => Promise<T>,
  nowMs: () => number,
  deadlineAtMs: number,
  callerSignal: AbortSignal | undefined,
): Promise<T | undefined> {
  try {
    return await raceAbortDeadline(operation, {
      deadlineAtMs,
      nowMs,
      ...(callerSignal === undefined ? {} : { signal: callerSignal }),
    });
  } catch (error) {
    if (error instanceof AbortDeadlineRaceError) {
      if (error.reason === "aborted") {
        throw new CancelledError("grounded repository request cancelled");
      }
      return undefined;
    }
    throw error;
  }
}

function deadlineBoundReranker(
  reranker: RerankerSeam,
  nowMs: () => number,
  deadlineAtMs: number,
  callerSignal: AbortSignal | undefined,
): RerankerSeam {
  return {
    name: reranker.name,
    isAvailable: async (): ReturnType<RerankerSeam["isAvailable"]> => {
      const availability = await raceRerankerToDeadline(
        (context) => reranker.isAvailable(context),
        nowMs,
        deadlineAtMs,
        callerSignal,
      );
      return availability ?? { available: false, reason: "elapsed-budget-exhausted" };
    },
    rerank: async (candidates, atomsByPath, topK): ReturnType<RerankerSeam["rerank"]> => {
      const reordered = await raceRerankerToDeadline(
        (context) => reranker.rerank(candidates, atomsByPath, topK, context),
        nowMs,
        deadlineAtMs,
        callerSignal,
      );
      return reordered ?? candidates;
    },
  };
}

function assembleOptionsFor(
  deps: OrchestratorDeps,
  nowMs: () => number,
  includeMicroIndex: boolean,
  includeReranker = true,
  deadlineAtMs?: number,
): AssembleOptionsForGroundedPack {
  const microIndex =
    deps.microIndex === undefined || deadlineAtMs === undefined
      ? deps.microIndex
      : deadlineBoundMicroIndex(deps.microIndex, nowMs, deadlineAtMs);
  const reranker =
    deps.contextPackReranker === undefined || deadlineAtMs === undefined
      ? deps.contextPackReranker
      : deadlineBoundReranker(deps.contextPackReranker, nowMs, deadlineAtMs, deps.signal);
  return {
    nowMs,
    ...(includeMicroIndex && microIndex !== undefined ? { microIndex } : {}),
    ...(includeReranker && reranker !== undefined ? { reranker } : {}),
  };
}

interface PreparedPackAssembly {
  readonly atoms: readonly EvidenceAtom[];
  readonly initialUsage: ExplorationUsage;
  readonly ordered: CandidateOrdering;
  readonly atomsByPath: ReadonlyMap<string, readonly EvidenceAtom[]>;
  readonly evidenceUncertainty: readonly UncertaintyMarker[];
  readonly keptPaths: readonly string[];
}

interface FinalContextPackInputs {
  readonly input: OrchestratorInput;
  readonly plan: ExplorationPlan;
  readonly rings: RingRunSummary;
  readonly prepared: PreparedPackAssembly;
  readonly excerptReads: ExcerptReadSummary;
  readonly documentEvidence: DocumentEvidenceResult;
  readonly cacheIdentity: PackCacheIdentity | undefined;
  readonly assembleOptions: AssembleOptionsForGroundedPack;
}

// Document paths are disjoint from code excerpt paths (documents are excluded from the code-first
// selected-file atoms), so a plain copy-merge never overwrites a code excerpt.
function mergeExcerptSources(
  base: ReadonlyMap<string, readonly ExcerptWindow[]>,
  documents: ReadonlyMap<string, readonly ExcerptWindow[]>,
): ReadonlyMap<string, readonly ExcerptWindow[]> {
  if (documents.size === 0) {
    return base;
  }
  const merged = new Map<string, readonly ExcerptWindow[]>(base);
  for (const [scopePath, windows] of documents) {
    merged.set(scopePath, windows);
  }
  return merged;
}

async function assembleEmptyGroundedPack({
  input,
  deps,
  plan,
  governor,
  nowMs,
  stopReason,
}: EmptyGroundedPackInputs): Promise<ConnectedContextPack> {
  // An empty pack has nothing to rerank or cache. Keeping both seams out also ensures a request
  // stopped before workspace IO cannot start unrelated external work during empty-pack assembly.
  const assembleOptions = assembleOptionsFor(deps, nowMs, false, false);
  const assemble = await assembleContextPack(
    {
      scope: input.scope,
      query: input.query,
      budget: plan.budget,
      atoms: [],
      ranked: [],
      omittedFromRanking: [],
      excerpts: new Map(),
      initialUsage: clampUsageToBudget(governor.usage, plan.budget),
      initialUncertainty: [budgetClipped(stopReason, nowMs())],
    },
    assembleOptions,
  );
  return assemble.pack;
}

function cachedGroundedPack({
  input,
  plan,
  rings,
  atoms,
  ordered,
  cacheIdentity,
  initialUsage,
  assembleOptions,
}: GroundedPackCacheLookupInputs): ConnectedContextPack | undefined {
  if (assembleOptions.microIndex === undefined || cacheIdentity === undefined) {
    return undefined;
  }
  const key = contextPackIndexKey(
    {
      scope: input.scope,
      query: input.query,
      budget: plan.budget,
      atoms,
      ranked: ordered.kept,
      omittedFromRanking: [...rings.omitted, ...ordered.omitted],
      excerpts: new Map(),
      cacheIdentity,
      initialUsage,
      diagnostics: rings.diagnostics,
    },
    assembleOptions,
  );
  return assembleOptions.microIndex.get(key);
}

function preparePackAssembly(
  input: OrchestratorInput,
  plan: ExplorationPlan,
  rings: RingRunSummary,
  nowMs: () => number,
): PreparedPackAssembly {
  const atoms = rings.atoms;
  const initialUsage = clampUsageToBudget(rings.governor.usage, plan.budget);
  // M4: pass the classified retrieval intent so ranking can apply intent-conditioned signals
  // (canonical-metadata, structural-edge). Non-boosted intents (e.g. clarification) and the
  // no-context default are byte-identical — see weightsForIntent / isIntentBoosted.
  const ranking = rankCandidates(
    { atoms, anchors: plan.anchors, context: { retrievalIntent: plan.retrievalIntent } },
    { nowMs },
  );
  const refined = refineCandidateOrdering(
    ranking.kept,
    ranking.omitted,
    input.query,
    plan.anchors,
    rings.diagnostics,
    nowMs(),
  );
  const ordered = selectGroundedCandidateFiles({
    ...refined,
    scopeKind: input.scope.kind,
    filesReadMax: plan.budget.filesReadMax,
    nowMs: nowMs(),
  });
  const selectedPaths = new Set(ordered.kept.map((candidate) => candidate.scopePath));
  const selectedAtoms = selectGroundedEvidenceAtoms(atoms, selectedPaths, input.scope.scopeId);
  return {
    atoms: selectedAtoms,
    initialUsage,
    ordered,
    atomsByPath: groupEvidenceAtomsByPath(selectedAtoms),
    evidenceUncertainty:
      selectedAtoms.length === 0 || ordered.kept.length === 0 ? [noEvidence(nowMs())] : [],
    keptPaths: ordered.kept.map((c) => c.scopePath),
  };
}

async function assemblePackFromReads({
  input,
  plan,
  rings,
  prepared,
  excerptReads,
  documentEvidence,
  cacheIdentity,
  assembleOptions,
}: FinalContextPackInputs): Promise<ConnectedContextPack> {
  const excerpts = mergeExcerptSources(excerptReads.excerpts, documentEvidence.excerpts);
  const needsNoEvidenceMarker =
    excerpts.size === 0 &&
    !prepared.evidenceUncertainty.some((marker) => marker.kind === "no-evidence");
  // Connected documents are owned exclusively by the bounded document-extraction path: they either
  // surface as document evidence or as a precise document diagnostic. The code-first lexical scan
  // also sees them as binary candidates, so strip any document-path omission it produced to avoid a
  // path that is both a selected file and an omitted entry (which the pack validator rejects).
  const codeOmitted = [...rings.omitted, ...prepared.ordered.omitted].filter(
    (entry) => !isConnectedDocumentPath(entry.scopePath),
  );
  const assemble = await assembleContextPack(
    {
      scope: input.scope,
      query: input.query,
      budget: plan.budget,
      atoms: [...prepared.atoms, ...documentEvidence.atoms],
      ranked: [...prepared.ordered.kept, ...documentEvidence.candidates],
      omittedFromRanking: [...codeOmitted, ...documentEvidence.omitted],
      excerpts,
      // Document evidence is request-local and not part of the file-state cache key, so a pack that
      // carries any document evidence — extracted atoms OR skipped-document omissions — must not be
      // written into the micro-index under a code-only file-state key (it would orphan an entry the
      // read-bypass gate never serves). Mirror the bypass condition in prepareGroundedAssembly.
      cacheIdentity:
        documentEvidence.atoms.length > 0 || documentEvidence.omitted.length > 0
          ? undefined
          : cacheIdentity,
      initialUsage: prepared.initialUsage,
      diagnostics: rings.diagnostics,
      initialUncertainty: [
        ...rings.uncertainty,
        ...excerptReads.uncertainty,
        ...prepared.evidenceUncertainty,
        ...documentEvidence.uncertainty,
        ...(needsNoEvidenceMarker ? [noEvidence(assembleOptions.nowMs())] : []),
      ],
    },
    assembleOptions,
  );
  return assemble.pack;
}

function finishAugmentationBudget(
  rings: RingRunSummary,
  budget: AugmentationBudgetMeter,
): RingRunSummary {
  const result = budget.finish(rings.governor);
  return {
    ...rings,
    governor: result.governor,
    uncertainty: dedupeUncertainty([
      ...rings.uncertainty,
      ...(result.marker === undefined ? [] : [result.marker]),
    ]),
  };
}

async function discoveredTraceForAugmentation(
  args: AssembleGroundedPackInputs,
  rings: RingRunSummary,
  budget: AugmentationBudgetMeter,
): Promise<DeterministicContextEvidence> {
  if (!budget.canContinue()) return { atoms: [], uncertainty: [] };
  const {
    input,
    deps,
    plan,
    searchScope,
    fs,
    nowMs,
    structuralContexts,
    workspaceIndex,
    deadlineAtMs,
  } = args;
  return collectDiscoveredSymbolTraceEvidence({
    scope: input.scope,
    query: input.query,
    anchors: plan.anchors,
    retrievalIntent: plan.retrievalIntent,
    searchScope,
    fs,
    nowMs,
    atoms: rings.atoms,
    signal: deps.signal,
    workspaceIndex,
    requestContext: structuralContexts.forLimits(GROUNDED_TRACE_SEARCH_LIMITS),
    deadlineAtMs,
    tryReserveSearchCall: budget.tryReserveSearchCall,
  });
}

async function augmentRingsWithDeterministicAtoms(
  args: AssembleGroundedPackInputs,
): Promise<RingRunSummary> {
  const { input, deps, plan, rings, searchScope, fs, nowMs, structuralContexts, deadlineAtMs } =
    args;
  const budget = createAugmentationBudgetMeter(plan, rings.governor, nowMs, deadlineAtMs);
  // Explicitly selected files are direct user scope, not another search. Preserve healthy files
  // when a planned ring consumed the search-call share (notably multi-source splits), while the
  // absolute deadline still prevents any new containment/stat work.
  const scopedRings =
    nowMs() < deadlineAtMs
      ? withExplicitScopeAtoms(rings, input, searchScope, fs, nowMs, deadlineAtMs, deps.signal)
      : rings;
  if (!budget.canContinue()) return finishAugmentationBudget(scopedRings, budget);
  const deterministicRings = await withDeterministicContextAtoms(
    scopedRings,
    input,
    plan,
    searchScope,
    fs,
    nowMs,
    deps.signal,
    structuralContexts,
    deadlineAtMs,
    budget,
  );
  const discoveredTrace = await discoveredTraceForAugmentation(args, deterministicRings, budget);
  return finishAugmentationBudget(
    {
      ...deterministicRings,
      atoms: [...deterministicRings.atoms, ...discoveredTrace.atoms],
      uncertainty: [...deterministicRings.uncertainty, ...discoveredTrace.uncertainty],
    },
    budget,
  );
}

interface GroundedAssemblyContext {
  readonly documentEvidence: DocumentEvidenceResult;
  readonly cached: ConnectedContextPack | undefined;
  readonly cacheIdentity: PackCacheIdentity | undefined;
  readonly assembleOptions: AssembleOptionsForGroundedPack;
}

function assemblyFileStateCacheIdentity(
  args: AssembleGroundedPackInputs,
  keptPaths: readonly string[],
): PackCacheIdentity | undefined {
  const { searchScope, fs, nowMs, deadlineAtMs, deps } = args;
  return fileStateCacheIdentity(keptPaths, searchScope, fs, nowMs, deadlineAtMs, deps.signal);
}

async function prepareGroundedAssembly(
  args: AssembleGroundedPackInputs,
  augmentedRings: RingRunSummary,
  prepared: PreparedPackAssembly,
): Promise<GroundedAssemblyContext> {
  const { input, deps, plan, searchScope, fs, nowMs, deadlineAtMs } = args;
  // Bounded small-document extraction for explicit `files` scopes (Issue #1285). Returns empty
  // evidence for every other scope kind, leaving the code-first path byte-identical.
  const documentEvidence = await collectConnectedDocumentEvidence({
    scope: input.scope,
    query: input.query,
    searchScope,
    fs,
    nowMs,
    signal: deps.signal,
    deadlineAtMs,
  });
  const hasDocumentEvidence =
    documentEvidence.atoms.length > 0 || documentEvidence.omitted.length > 0;
  const withinDeadline = nowMs() < deadlineAtMs;
  const cacheIdentity =
    deps.microIndex === undefined || hasDocumentEvidence || !withinDeadline
      ? undefined
      : assemblyFileStateCacheIdentity(args, prepared.keptPaths);
  const canStartAssemblySeams = nowMs() < deadlineAtMs;
  const assembleOptions = assembleOptionsFor(
    deps,
    nowMs,
    !hasDocumentEvidence && canStartAssemblySeams,
    canStartAssemblySeams,
    deadlineAtMs,
  );
  // The micro-index cache key does not model request-local document evidence, so a scope that
  // carried documents this run must not be served from (or written to) the shared cache.
  const cached = hasDocumentEvidence
    ? undefined
    : cachedGroundedPack({
        input,
        plan,
        rings: augmentedRings,
        atoms: prepared.atoms,
        ordered: prepared.ordered,
        cacheIdentity,
        initialUsage: prepared.initialUsage,
        assembleOptions,
      });
  return { documentEvidence, cached, cacheIdentity, assembleOptions };
}

// PR4-W1 (ADR-0055 D1): conditional diagnostics observer. When a ContextProfile is threaded
// through OrchestratorDeps, the fully assembled pack is enriched with an additive
// `diagnostics.contextBudget?`. The observer is pure and touches no field a prompt builder reads,
// so the wire output stays byte-identical (AC5). When the profile is absent, the pack is returned
// exactly as assembled — the unchanged-guarantee for legacy callers and existing tests.
function withGroundedContextDiagnostics(
  pack: ConnectedContextPack,
  deps: OrchestratorDeps,
): ConnectedContextPack {
  if (deps.contextProfile === undefined) {
    return pack;
  }
  return attachContextBudgetDiagnostics(pack, deps.contextProfile);
}

async function assembleGroundedPack(
  args: AssembleGroundedPackInputs,
): Promise<ConnectedContextPack> {
  const { input, deps, plan, searchScope, fs, nowMs, deadlineAtMs } = args;
  const augmentedRings = await augmentRingsWithDeterministicAtoms(args);
  const prepared = preparePackAssembly(input, plan, augmentedRings, nowMs);
  const ctx = await prepareGroundedAssembly(args, augmentedRings, prepared);
  if (ctx.cached !== undefined) {
    return withGroundedContextDiagnostics(ctx.cached, deps);
  }
  const excerptReads = await readKeptExcerpts(prepared.keptPaths, {
    searchScope,
    fs,
    budget: plan.budget,
    initialUsage: prepared.initialUsage,
    atomsByPath: prepared.atomsByPath,
    nowMs,
    signal: deps.signal,
    deadlineAtMs,
  });
  const pack = await assemblePackFromReads({
    input,
    plan,
    rings: augmentedRings,
    prepared,
    excerptReads,
    documentEvidence: ctx.documentEvidence,
    cacheIdentity: ctx.cacheIdentity,
    assembleOptions: ctx.assembleOptions,
  });
  return withGroundedContextDiagnostics(pack, deps);
}

// ─── Public entry ─────────────────────────────────────────────────────────────

interface ConnectedContextCompletionStatus {
  readonly readBudgetBlocked: boolean;
  readonly elapsedBudgetBlocked: boolean;
  readonly workspaceIndexProviderStatus: "not-evaluated" | "available" | "unavailable";
}

interface ConnectedContextExecution {
  readonly output: RetrievalOnlyOutput;
  readonly status: ConnectedContextCompletionStatus;
  readonly structural: StructuralRequestContextPoolDiagnostics;
  readonly workspaceIndex: WorkspaceIndexActivityDiagnostics;
  readonly workspaceIo: WorkspaceIoActivityDiagnostics;
}

interface ConnectedContextActivity {
  readonly elapsedMs: () => number;
  readonly started: () => void;
  readonly completed: (execution: ConnectedContextExecution) => void;
  readonly failed: (error: unknown, progress: ConnectedContextProgress) => void;
}

type ConnectedContextPhase =
  | "request-validation"
  | "planning"
  | "workspace-admission"
  | "budget-evaluation"
  | "workspace-detection"
  | "ring-retrieval"
  | "pack-assembly"
  | "empty-pack-assembly";

interface ConnectedContextProgress {
  phase: ConnectedContextPhase;
  plannedRingCount: number;
  structuralContexts?: StructuralRequestContextPool | undefined;
  workspaceIndexActivity?: WorkspaceIndexActivity | undefined;
  workspaceIoActivity?: WorkspaceIoActivity | undefined;
}

interface ConnectedContextRuntime {
  readonly fs: WorkspaceFs;
  readonly workspaceRoot: string;
  readonly detect: (root: string, fs: WorkspaceFs) => WorkspaceInfo;
  readonly nowMs: () => number;
  readonly activity: ConnectedContextActivity;
  readonly progress: ConnectedContextProgress;
  readonly workspaceIoActivity: WorkspaceIoActivity;
  readonly requestStartedAtMs: number;
}

const EMPTY_STRUCTURAL_DIAGNOSTICS: StructuralRequestContextPoolDiagnostics = {
  contextCount: 0,
  candidateInventoryBuildCount: 0,
  candidateFileCount: 0,
  candidateDirectoryCount: 0,
  codeIndexBuildCount: 0,
  symbolGraphBuildCount: 0,
  importGraphBuildCount: 0,
  endpointGraphBuildCount: 0,
  fileSearchCount: 0,
  textSearchCount: 0,
};

const NOT_EVALUATED_WORKSPACE_INDEX_DIAGNOSTICS = workspaceIndexActivityDiagnostics(
  "not-evaluated",
  emptyWorkspaceIndexActivityCounters(),
);

function liveRetrievalCompletion(
  workspaceIndexAvailable: boolean,
): ConnectedContextCompletionStatus {
  return {
    readBudgetBlocked: false,
    elapsedBudgetBlocked: false,
    workspaceIndexProviderStatus: workspaceIndexAvailable ? "available" : "unavailable",
  };
}

function stoppedRetrievalCompletion(
  readBudgetBlocked: boolean,
  elapsedBudgetBlocked: boolean,
): ConnectedContextCompletionStatus {
  return {
    readBudgetBlocked,
    elapsedBudgetBlocked,
    workspaceIndexProviderStatus: "not-evaluated",
  };
}

type ActivityScopeKind = "workspace-root" | "directory" | "files" | "invalid";
type ActivityQueryKind = RetrievalQuery["kind"] | "invalid";
type ActivityNumber = number | "invalid";
type ActivityBoolean = boolean | "invalid";

interface ConnectedContextActivityIdentity {
  readonly scopeKind: ActivityScopeKind;
  readonly relativePathCount: number;
  readonly explicitConnection: boolean;
  readonly scopeIdentitySha256: string;
  readonly queryKind: ActivityQueryKind;
  readonly queryIdentitySha256: string;
  readonly caseSensitive: ActivityBoolean;
  readonly maxResults: ActivityNumber;
  readonly searchCallsMax: ActivityNumber;
  readonly filesReadMax: ActivityNumber;
  readonly excerptBytesMax: ActivityNumber;
  readonly modelInputTokensMax: ActivityNumber;
  readonly modelOutputTokensMax: ActivityNumber;
  readonly elapsedMsMax: ActivityNumber;
  readonly rerankCallsMax: ActivityNumber;
}

function activityProperty(record: Readonly<Record<string, unknown>>, key: string): unknown {
  try {
    return record[key];
  } catch {
    return undefined;
  }
}

function activityString(record: Readonly<Record<string, unknown>>, key: string): string {
  const value = activityProperty(record, key);
  return typeof value === "string" ? value : "";
}

function activityNumber(record: Readonly<Record<string, unknown>>, key: string): ActivityNumber {
  const value = activityProperty(record, key);
  return typeof value === "number" && Number.isFinite(value) ? value : "invalid";
}

function activityBoolean(record: Readonly<Record<string, unknown>>, key: string): ActivityBoolean {
  const value = activityProperty(record, key);
  return typeof value === "boolean" ? value : "invalid";
}

function activityScopeKind(value: unknown): ActivityScopeKind {
  return value === "workspace-root" || value === "directory" || value === "files"
    ? value
    : "invalid";
}

function activityQueryKind(value: unknown): ActivityQueryKind {
  return value === "natural-language" ||
    value === "exact-symbol" ||
    value === "file-pattern" ||
    value === "regex"
    ? value
    : "invalid";
}

function activityRelativePaths(scope: Readonly<Record<string, unknown>>): readonly string[] {
  const value = activityProperty(scope, "relativePaths");
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function connectedContextActivityDigest(domain: string, parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of [domain, ...parts]) {
    hash.update(`${String(part.length)}:${part}`);
  }
  return hash.digest("hex");
}

function activityBudget(
  input: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const value = activityProperty(input, "budget");
  if (value === undefined) return { ...DEFAULT_EXPLORATION_BUDGET };
  return isRecord(value) ? value : {};
}

function queryActivityIdentity(
  input: Readonly<Record<string, unknown>>,
): Pick<
  ConnectedContextActivityIdentity,
  "queryKind" | "queryIdentitySha256" | "caseSensitive" | "maxResults"
> {
  const value = activityProperty(input, "query");
  const query = isRecord(value) ? value : {};
  const queryKind = activityQueryKind(activityProperty(query, "kind"));
  const caseSensitive = activityBoolean(query, "caseSensitive");
  const maxResults = activityNumber(query, "maxResults");
  return {
    queryKind,
    caseSensitive,
    maxResults,
    queryIdentitySha256: connectedContextActivityDigest("keiko.connected-context.query.v1", [
      queryKind,
      activityString(query, "text"),
      String(caseSensitive),
      String(maxResults),
    ]),
  };
}

function budgetActivityIdentity(
  input: Readonly<Record<string, unknown>>,
): Pick<
  ConnectedContextActivityIdentity,
  | "searchCallsMax"
  | "filesReadMax"
  | "excerptBytesMax"
  | "modelInputTokensMax"
  | "modelOutputTokensMax"
  | "elapsedMsMax"
  | "rerankCallsMax"
> {
  const budget = activityBudget(input);
  return {
    searchCallsMax: activityNumber(budget, "searchCallsMax"),
    filesReadMax: activityNumber(budget, "filesReadMax"),
    excerptBytesMax: activityNumber(budget, "excerptBytesMax"),
    modelInputTokensMax: activityNumber(budget, "modelInputTokensMax"),
    modelOutputTokensMax: activityNumber(budget, "modelOutputTokensMax"),
    elapsedMsMax: activityNumber(budget, "elapsedMsMax"),
    rerankCallsMax: activityNumber(budget, "rerankCallsMax"),
  };
}

function connectedContextActivityIdentity(
  input: OrchestratorInput,
): ConnectedContextActivityIdentity {
  const inputRecord = isRecord(input) ? input : {};
  const scopeValue = activityProperty(inputRecord, "scope");
  const scope = isRecord(scopeValue) ? scopeValue : {};
  const scopeKind = activityScopeKind(activityProperty(scope, "kind"));
  const relativePaths = activityRelativePaths(scope);
  const explicitConnection = activityProperty(scope, "explicitConnection") === true;
  const digest = connectedContextActivityDigest("keiko.connected-context.scope.v2", [
    activityString(scope, "scopeId"),
    activityString(inputRecord, "workspaceRoot"),
    scopeKind,
    String(explicitConnection),
    ...relativePaths,
  ]);
  return {
    scopeKind,
    relativePathCount: relativePaths.length,
    explicitConnection,
    scopeIdentitySha256: digest,
    ...queryActivityIdentity(inputRecord),
    ...budgetActivityIdentity(inputRecord),
  };
}

function commonActivityExtra(
  identity: ConnectedContextActivityIdentity,
): Readonly<Record<string, unknown>> {
  return {
    scopeKind: identity.scopeKind,
    relativePathCount: identity.relativePathCount,
    explicitConnection: identity.explicitConnection,
    scopeIdentitySha256: identity.scopeIdentitySha256,
    queryKind: identity.queryKind,
    queryIdentitySha256: identity.queryIdentitySha256,
    caseSensitive: identity.caseSensitive,
    maxResults: identity.maxResults,
    searchCallsMax: identity.searchCallsMax,
    filesReadMax: identity.filesReadMax,
    excerptBytesMax: identity.excerptBytesMax,
    modelInputTokensMax: identity.modelInputTokensMax,
    modelOutputTokensMax: identity.modelOutputTokensMax,
    elapsedMsMax: identity.elapsedMsMax,
    rerankCallsMax: identity.rerankCallsMax,
  };
}

function uncertaintyActivityExtra(
  markers: readonly UncertaintyMarker[],
): Readonly<Record<string, number>> {
  const counts: Record<UncertaintyMarkerKind, number> = {
    "no-evidence": 0,
    "stale-evidence": 0,
    "scope-incomplete": 0,
    "budget-clipped": 0,
    "tool-unavailable": 0,
    "low-confidence": 0,
    "unsupported-citation": 0,
    "incomplete-answer": 0,
    "unsupported-claim": 0,
    "entailment-unavailable": 0,
  };
  for (const marker of markers) counts[marker.kind] += 1;
  return {
    noEvidenceUncertaintyCount: counts["no-evidence"],
    staleEvidenceUncertaintyCount: counts["stale-evidence"],
    scopeIncompleteUncertaintyCount: counts["scope-incomplete"],
    budgetClippedUncertaintyCount: counts["budget-clipped"],
    toolUnavailableUncertaintyCount: counts["tool-unavailable"],
    lowConfidenceUncertaintyCount: counts["low-confidence"],
    unsupportedCitationUncertaintyCount: counts["unsupported-citation"],
    incompleteAnswerUncertaintyCount: counts["incomplete-answer"],
    unsupportedClaimUncertaintyCount: counts["unsupported-claim"],
    entailmentUnavailableUncertaintyCount: counts["entailment-unavailable"],
  };
}

function coverageActivityExtra(pack: ConnectedContextPack): Readonly<Record<string, unknown>> {
  const coverage = pack.diagnostics?.coverage;
  if (coverage === undefined) {
    return { coverageStatus: "not-reported", coverageReasons: [] };
  }
  return {
    coverageStatus: coverage.incomplete ? "incomplete" : "complete",
    coverageReasons: coverage.reasons,
    coverageFilesDiscovered: coverage.filesDiscovered,
    coverageFilesScanned: coverage.filesScanned,
    coverageFilesSkipped: coverage.filesSkipped,
    coverageDepthPruned: coverage.depthPrunedByDiscovery,
    coverageMaxFilesPruned: coverage.maxFilesPrunedByDiscovery,
  };
}

function completionActivityExtra(
  identity: ConnectedContextActivityIdentity,
  execution: ConnectedContextExecution,
): Readonly<Record<string, unknown>> {
  const { pack, plan } = execution.output;
  return {
    ...commonActivityExtra(identity),
    activityDetailStatus: "complete",
    plannedRingCount: plan.rings.length,
    usage: {
      searchCalls: pack.usage.searchCalls,
      filesRead: pack.usage.filesRead,
      excerptBytes: pack.usage.excerptBytes,
      modelInputTokens: pack.usage.modelInputTokens,
      modelOutputTokens: pack.usage.modelOutputTokens,
      elapsedMs: pack.usage.elapsedMs,
      rerankCalls: pack.usage.rerankCalls,
    },
    selectionCounts: {
      selectedFileCount: pack.files.length,
      omittedCount: pack.omitted.length,
    },
    uncertainty: {
      count: pack.uncertainty.length,
      ...uncertaintyActivityExtra(pack.uncertainty),
    },
    coverage: coverageActivityExtra(pack),
    retrievalStatus: execution.status,
    structural: execution.structural,
    workspaceIndex: execution.workspaceIndex,
    workspaceIo: execution.workspaceIo,
  };
}

function failureActivityExtra(
  identity: ConnectedContextActivityIdentity,
  error: unknown,
  progress: ConnectedContextProgress,
  cancelled: boolean,
): Readonly<Record<string, unknown>> {
  const frames = keikoStackFrames(error);
  const chain = causeChain(error);
  return {
    ...commonActivityExtra(identity),
    activityDetailStatus: "complete",
    outcome: cancelled ? "cancelled" : "failed",
    retrievalPhase: progress.phase,
    plannedRingCount: progress.plannedRingCount,
    structural: progress.structuralContexts?.diagnostics() ?? EMPTY_STRUCTURAL_DIAGNOSTICS,
    workspaceIndex:
      progress.workspaceIndexActivity?.diagnostics() ?? NOT_EVALUATED_WORKSPACE_INDEX_DIAGNOSTICS,
    workspaceIo:
      progress.workspaceIoActivity?.diagnostics() ?? emptyWorkspaceIoActivityDiagnostics(),
    ...(frames.length === 0 ? {} : { frames }),
    ...(chain.length === 0 ? {} : { causeChain: chain }),
  };
}

function safeConnectedContextErrorKind(error: unknown): string {
  try {
    return errorKindOf(error);
  } catch {
    return "unknown";
  }
}

function isConnectedContextCancellation(error: unknown, errorKind: string): boolean {
  try {
    if (error instanceof CancelledError) return true;
  } catch {
    // A hostile getPrototypeOf trap cannot be allowed to replace the original retrieval failure.
  }
  return errorKind === ERROR_CODES.CANCELLED;
}

function unavailableActivityExtra(
  identity: ConnectedContextActivityIdentity,
  workspaceIo: WorkspaceIoActivityDiagnostics,
): Readonly<Record<string, unknown>> {
  return { ...commonActivityExtra(identity), activityDetailStatus: "unavailable", workspaceIo };
}

function safeCompletionActivityExtra(
  identity: ConnectedContextActivityIdentity,
  execution: ConnectedContextExecution,
  correlationId: string,
): Readonly<Record<string, unknown>> {
  try {
    return completionActivityExtra(identity, execution);
  } catch (error) {
    reportServerLogFailure(error, { op: "search.connected-context.completed", correlationId });
    return unavailableActivityExtra(identity, execution.workspaceIo);
  }
}

function safeFailureActivityExtra(
  identity: ConnectedContextActivityIdentity,
  error: unknown,
  progress: ConnectedContextProgress,
  cancelled: boolean,
  correlationId: string,
): Readonly<Record<string, unknown>> {
  try {
    return failureActivityExtra(identity, error, progress, cancelled);
  } catch (projectionError) {
    reportServerLogFailure(projectionError, {
      op: "search.connected-context.failed",
      correlationId,
    });
    return {
      ...unavailableActivityExtra(
        identity,
        progress.workspaceIoActivity?.diagnostics() ?? emptyWorkspaceIoActivityDiagnostics(),
      ),
      outcome: cancelled ? "cancelled" : "failed",
      retrievalPhase: progress.phase,
      plannedRingCount: progress.plannedRingCount,
    };
  }
}

function createConnectedContextActivity(
  input: OrchestratorInput,
  deps: OrchestratorDeps,
  nowMs: () => number,
  logicalStartMs: number,
): ConnectedContextActivity {
  const sink = deps.activityLog ?? processServerLogSink();
  const logger = createServerLogger({ sink, level: "debug" });
  const correlationId = correlationIdOrUnknown(deps.correlationId);
  const identity = connectedContextActivityIdentity(input);
  const logElapsed = startLogTimer();
  return {
    elapsedMs: (): number => Math.max(0, nowMs() - logicalStartMs),
    started: (): void => {
      logger.info(() => ({
        category: "search",
        op: "search.connected-context.started",
        correlationId,
        extra: commonActivityExtra(identity),
      }));
    },
    completed: (execution): void => {
      logger.info(() => ({
        category: "search",
        op: "search.connected-context.completed",
        correlationId,
        durationMs: logElapsed(),
        extra: safeCompletionActivityExtra(identity, execution, correlationId),
      }));
    },
    failed: (error, progress): void => {
      const errorKind = safeConnectedContextErrorKind(error);
      const cancelled = isConnectedContextCancellation(error, errorKind);
      const event = (): ServerLogEvent => ({
        category: "search" as const,
        op: "search.connected-context.failed",
        correlationId,
        durationMs: logElapsed(),
        errorKind,
        extra: safeFailureActivityExtra(identity, error, progress, cancelled, correlationId),
      });
      if (cancelled) logger.warn(event);
      else logger.error(event);
    },
  };
}

function fallbackConnectedContextActivity(
  nowMs: () => number,
  logicalStartMs: number,
): ConnectedContextActivity {
  return {
    elapsedMs: (): number => Math.max(0, nowMs() - logicalStartMs),
    started: (): void => undefined,
    completed: (): void => undefined,
    failed: (): void => undefined,
  };
}

function safeActivityCorrelationId(deps: OrchestratorDeps): string {
  const record = isRecord(deps) ? deps : {};
  const value = activityProperty(record, "correlationId");
  return correlationIdOrUnknown(typeof value === "string" ? value : undefined);
}

function safeConnectedContextActivity(
  input: OrchestratorInput,
  deps: OrchestratorDeps,
  nowMs: () => number,
  logicalStartMs: number,
): ConnectedContextActivity {
  try {
    return createConnectedContextActivity(input, deps, nowMs, logicalStartMs);
  } catch (error) {
    reportServerLogFailure(error, {
      op: "search.connected-context.started",
      correlationId: safeActivityCorrelationId(deps),
    });
    return fallbackConnectedContextActivity(nowMs, logicalStartMs);
  }
}

function connectedContextExecution(
  pack: ConnectedContextPack,
  plan: ExplorationPlan,
  activity: ConnectedContextActivity,
  status: ConnectedContextCompletionStatus,
  structural: StructuralRequestContextPoolDiagnostics,
  workspaceIndex: WorkspaceIndexActivityDiagnostics,
  workspaceIo: WorkspaceIoActivityDiagnostics,
): ConnectedContextExecution {
  return {
    output: { pack, elapsedMs: activity.elapsedMs(), plan },
    status,
    structural,
    workspaceIndex,
    workspaceIo,
  };
}

function connectedContextSearchInputs(
  input: OrchestratorInput,
  deps: OrchestratorDeps,
  plan: ExplorationPlan,
  runtime: ConnectedContextRuntime,
  searchScope: SearchScope,
  structuralContexts: StructuralRequestContextPool,
  workspaceIndex: WorkspaceIndex | undefined,
  workspaceIndexActivity: WorkspaceIndexActivity,
  deadlineAtMs: number,
): SearchInputs {
  return {
    searchScope,
    query: input.query,
    anchors: plan.anchors,
    retrievalIntent: plan.retrievalIntent,
    fs: runtime.fs,
    nowMs: runtime.nowMs,
    signal: deps.signal,
    ...(workspaceIndex === undefined ? {} : { workspaceIndex }),
    workspaceIndexActivity,
    repoSemanticSearchProvider: deps.repoSemanticSearchProvider ?? deps.semanticSearchProvider,
    gitFileHistoryEvidence: deps.gitFileHistoryEvidence ?? defaultGitFileHistoryEvidenceProvider,
    correlationId: deps.correlationId,
    structuralContexts,
    deadlineAtMs,
  };
}

function emptyWorkspaceIoActivityDiagnostics(): WorkspaceIoActivityDiagnostics {
  return {
    readDirCalls: 0,
    readDirEntries: 0,
    statCalls: 0,
    realPathCalls: 0,
    existsCalls: 0,
    contentReadCalls: 0,
    contentReadBytes: 0,
  };
}

function addWorkspaceIoPayloadCount(
  counters: MutableWorkspaceIoActivityCounters,
  key: "readDirEntries" | "contentReadBytes",
  value: unknown,
): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return;
  counters[key] = Math.min(Number.MAX_SAFE_INTEGER, counters[key] + value);
}

function recordTextPayload(counters: MutableWorkspaceIoActivityCounters, value: string): string {
  try {
    addWorkspaceIoPayloadCount(counters, "contentReadBytes", Buffer.byteLength(value, "utf8"));
  } catch {
    // Observability must never replace the workspace result supplied by the owning port.
  }
  return value;
}

function recordDescriptorPayload(
  counters: MutableWorkspaceIoActivityCounters,
  value: WorkspaceDescriptorUtf8Read,
): void {
  try {
    addWorkspaceIoPayloadCount(counters, "contentReadBytes", value.sizeBytes);
  } catch {
    // Observability must never evaluate a hostile projection outside its own failure boundary.
  }
}

function recordBytePayload<T extends Uint8Array>(
  counters: MutableWorkspaceIoActivityCounters,
  value: T,
): T {
  try {
    addWorkspaceIoPayloadCount(counters, "contentReadBytes", value.byteLength);
  } catch {
    // Observability must never replace the workspace result supplied by the owning port.
  }
  return value;
}

function observedWorkspaceFileReader(
  reader: WorkspaceFileReader,
  counters: MutableWorkspaceIoActivityCounters,
): WorkspaceFileReader {
  return {
    close: (): Promise<void> => reader.close(),
    readRange: async (startByte, length): Promise<Uint8Array> => {
      counters.contentReadCalls += 1;
      return recordBytePayload(counters, await reader.readRange(startByte, length));
    },
  };
}

function workspaceFsProperty<Key extends keyof WorkspaceFs>(
  fs: WorkspaceFs,
  key: Key,
): WorkspaceFs[Key] | undefined {
  try {
    return fs[key];
  } catch {
    return undefined;
  }
}

function observedSynchronousContentReads(
  fs: WorkspaceFs,
  counters: MutableWorkspaceIoActivityCounters,
): Partial<WorkspaceFs> {
  const descriptorRead = workspaceFsProperty(fs, "readFileUtf8SameDescriptor");
  const containedDescriptorRead = workspaceFsProperty(fs, "readFileUtf8WithinRootSameDescriptor");
  const prefixRead = workspaceFsProperty(fs, "readFileUtf8Prefix");
  return {
    ...(descriptorRead === undefined
      ? {}
      : {
          readFileUtf8SameDescriptor: (
            path: string,
            maxBytes: number,
            hardLinkPolicy: WorkspaceHardLinkPolicy,
            expected: WorkspaceStat,
          ): WorkspaceDescriptorUtf8Read => {
            counters.contentReadCalls += 1;
            const result = descriptorRead.call(fs, path, maxBytes, hardLinkPolicy, expected);
            recordDescriptorPayload(counters, result);
            return result;
          },
        }),
    ...(containedDescriptorRead === undefined
      ? {}
      : {
          readFileUtf8WithinRootSameDescriptor: (
            canonicalRoot: string,
            path: string,
            maxBytes: number,
            hardLinkPolicy: WorkspaceHardLinkPolicy,
            completeness: WorkspaceDescriptorReadCompleteness,
          ): WorkspaceDescriptorUtf8Read => {
            counters.contentReadCalls += 1;
            const result = containedDescriptorRead.call(
              fs,
              canonicalRoot,
              path,
              maxBytes,
              hardLinkPolicy,
              completeness,
            );
            recordDescriptorPayload(counters, result);
            return result;
          },
        }),
    ...(prefixRead === undefined
      ? {}
      : {
          readFileUtf8Prefix: (
            path: string,
            maxBytes: number,
            hardLinkPolicy: WorkspaceHardLinkPolicy,
            expected: WorkspaceStat,
          ): string => {
            counters.contentReadCalls += 1;
            return recordTextPayload(
              counters,
              prefixRead.call(fs, path, maxBytes, hardLinkPolicy, expected),
            );
          },
        }),
  };
}

function observedAsyncByteRead(
  read: (
    path: string,
    maxBytes: number,
    hardLinkPolicy: WorkspaceHardLinkPolicy,
    expected: WorkspaceStat,
  ) => Promise<Uint8Array>,
  fs: WorkspaceFs,
  counters: MutableWorkspaceIoActivityCounters,
): (
  path: string,
  maxBytes: number,
  hardLinkPolicy: WorkspaceHardLinkPolicy,
  expected: WorkspaceStat,
) => Promise<Uint8Array> {
  return async (path, maxBytes, hardLinkPolicy, expected): Promise<Uint8Array> => {
    counters.contentReadCalls += 1;
    return recordBytePayload(
      counters,
      await read.call(fs, path, maxBytes, hardLinkPolicy, expected),
    );
  };
}

function observedAsyncContentReads(
  fs: WorkspaceFs,
  counters: MutableWorkspaceIoActivityCounters,
): Partial<WorkspaceFs> {
  const byteRead = workspaceFsProperty(fs, "readFileBytes");
  const rangeRead = workspaceFsProperty(fs, "readFileRange");
  const openReader = workspaceFsProperty(fs, "openFileReader");
  return {
    ...(byteRead === undefined
      ? {}
      : { readFileBytes: observedAsyncByteRead(byteRead, fs, counters) }),
    ...(rangeRead === undefined
      ? {}
      : {
          readFileRange: async (
            path: string,
            start: number,
            length: number,
            hardLinkPolicy: WorkspaceHardLinkPolicy,
            expected: WorkspaceStat,
          ): Promise<Uint8Array> => {
            counters.contentReadCalls += 1;
            return recordBytePayload(
              counters,
              await rangeRead.call(fs, path, start, length, hardLinkPolicy, expected),
            );
          },
        }),
    ...(openReader === undefined
      ? {}
      : {
          openFileReader: async (
            path: string,
            hardLinkPolicy: WorkspaceHardLinkPolicy,
            expected: WorkspaceStat,
          ): Promise<WorkspaceFileReader> => {
            counters.contentReadCalls += 1;
            return observedWorkspaceFileReader(
              await openReader.call(fs, path, hardLinkPolicy, expected),
              counters,
            );
          },
        }),
  };
}

function observedCanonicalWorkspaceRoot(
  fs: WorkspaceFs,
  counters: MutableWorkspaceIoActivityCounters,
  canonicalRoots: Map<string, string>,
  observedRealPath: (absolutePath: string) => string,
  absoluteRoot: string,
): string {
  const key = resolve(absoluteRoot);
  const cached = canonicalRoots.get(key);
  if (cached !== undefined) return cached;
  const canonicalRoot = workspaceFsProperty(fs, "canonicalWorkspaceRoot");
  if (canonicalRoot === undefined) {
    const canonical = observedRealPath(absoluteRoot);
    canonicalRoots.set(key, canonical);
    return canonical;
  }
  counters.realPathCalls += 1;
  const canonical = canonicalRoot.call(fs, absoluteRoot);
  canonicalRoots.set(key, canonical);
  return canonical;
}

function requestScopedWorkspaceFs(fs: WorkspaceFs): WorkspaceIoActivity {
  const counters: MutableWorkspaceIoActivityCounters = emptyWorkspaceIoActivityDiagnostics();
  const canonicalRoots = new Map<string, string>();
  const observedRealPath = (absolutePath: string): string => {
    counters.realPathCalls += 1;
    return fs.realPath(absolutePath);
  };
  const observedFs = preserveOwnedRootAuthority(fs, {
    readFileUtf8: (absolutePath): string => {
      counters.contentReadCalls += 1;
      return recordTextPayload(counters, fs.readFileUtf8(absolutePath));
    },
    stat: (absolutePath): WorkspaceStat => {
      counters.statCalls += 1;
      return fs.stat(absolutePath);
    },
    readDir: (absolutePath, maxEntries): readonly WorkspaceDirEntry[] => {
      counters.readDirCalls += 1;
      const entries = fs.readDir(absolutePath, maxEntries);
      try {
        addWorkspaceIoPayloadCount(counters, "readDirEntries", entries.length);
      } catch {
        // Observability must never replace the workspace result supplied by the owning port.
      }
      return entries;
    },
    realPath: observedRealPath,
    exists: (absolutePath): boolean => {
      counters.existsCalls += 1;
      return fs.exists(absolutePath);
    },
    ...observedSynchronousContentReads(fs, counters),
    ...observedAsyncContentReads(fs, counters),
    canonicalWorkspaceRoot: (absoluteRoot): string =>
      observedCanonicalWorkspaceRoot(fs, counters, canonicalRoots, observedRealPath, absoluteRoot),
  });
  return {
    fs: observedFs,
    diagnostics: (): WorkspaceIoActivityDiagnostics => ({ ...counters }),
  };
}

function liveStructuralContexts(
  searchScope: SearchScope,
  runtime: ConnectedContextRuntime,
  deadlineAtMs: number,
  workspaceIndexActivity: WorkspaceIndexActivity,
  signal: AbortSignal | undefined,
): StructuralRequestContextPool {
  return createStructuralRequestContextPool(
    searchScope,
    runtime.fs,
    runtime.nowMs,
    deadlineAtMs,
    workspaceIndexActivity,
    signal,
  );
}

interface LiveRetrievalContext {
  readonly deadlineAtMs: number;
  readonly searchScope: SearchScope;
  readonly structuralContexts: StructuralRequestContextPool;
  readonly workspaceIndexSource: WorkspaceIndex | undefined;
  readonly workspaceIndexActivity: WorkspaceIndexActivity;
  readonly workspaceIndex: WorkspaceIndex | undefined;
}

function detectConnectedContextWorkspace(root: string, fs: WorkspaceFs): WorkspaceInfo {
  return detectWorkspaceAt(root, fs, { scanSourceFilesForLanguages: false });
}

function prepareLiveRetrievalContext(
  input: OrchestratorInput,
  deps: OrchestratorDeps,
  plan: ExplorationPlan,
  runtime: ConnectedContextRuntime,
): LiveRetrievalContext {
  const deadlineAtMs = runtime.requestStartedAtMs + Math.max(0, plan.budget.elapsedMsMax);
  runtime.progress.phase = "workspace-detection";
  const workspace = runtime.detect(runtime.workspaceRoot, runtime.fs);
  const searchScope = buildSearchScope(input.scope, workspace);
  const workspaceIndexSource =
    runtime.nowMs() < deadlineAtMs ? deps.workspaceIndexForRoot?.(workspace.root) : undefined;
  const workspaceIndexActivity = createWorkspaceIndexActivity(workspaceIndexSource);
  runtime.progress.workspaceIndexActivity = workspaceIndexActivity;
  const structuralContexts = liveStructuralContexts(
    searchScope,
    runtime,
    deadlineAtMs,
    workspaceIndexActivity,
    deps.signal,
  );
  runtime.progress.structuralContexts = structuralContexts;
  return {
    deadlineAtMs,
    searchScope,
    structuralContexts,
    workspaceIndexSource,
    workspaceIndexActivity,
    workspaceIndex: workspaceIndexActivity.workspaceIndex,
  };
}

async function retrieveLiveConnectedContext(
  input: OrchestratorInput,
  deps: OrchestratorDeps,
  plan: ExplorationPlan,
  governor: GovernorState,
  runtime: ConnectedContextRuntime,
): Promise<ConnectedContextExecution> {
  const context = prepareLiveRetrievalContext(input, deps, plan, runtime);
  runtime.progress.phase = "ring-retrieval";
  const rings = await runAllRings(
    plan.rings,
    connectedContextSearchInputs(
      input,
      deps,
      plan,
      runtime,
      context.searchScope,
      context.structuralContexts,
      context.workspaceIndex,
      context.workspaceIndexActivity,
      context.deadlineAtMs,
    ),
    governor,
  );
  throwIfCancelled(deps.signal);
  runtime.progress.phase = "pack-assembly";
  const pack = await assembleGroundedPack({
    input,
    deps,
    plan,
    rings,
    searchScope: context.searchScope,
    fs: runtime.fs,
    nowMs: runtime.nowMs,
    structuralContexts: context.structuralContexts,
    workspaceIndex: context.workspaceIndex,
    deadlineAtMs: context.deadlineAtMs,
  });
  throwIfCancelled(deps.signal);
  return connectedContextExecution(
    pack,
    plan,
    runtime.activity,
    liveRetrievalCompletion(context.workspaceIndexSource !== undefined),
    context.structuralContexts.diagnostics(),
    context.workspaceIndexActivity.diagnostics(),
    runtime.workspaceIoActivity.diagnostics(),
  );
}

async function executeConnectedContextRetrieval(
  input: OrchestratorInput,
  deps: OrchestratorDeps,
  runtime: ConnectedContextRuntime,
): Promise<ConnectedContextExecution> {
  throwIfCancelled(deps.signal);
  runtime.progress.phase = "planning";
  const { plan, governor } = createReadyGovernedPlan(input, runtime.nowMs);
  runtime.progress.plannedRingCount = plan.rings.length;
  deps.recordPlan?.(plan);
  throwIfCancelled(deps.signal);
  runtime.progress.phase = "workspace-admission";
  const admittedRuntime: ConnectedContextRuntime = {
    ...runtime,
    workspaceRoot: assertGroundedWorkspaceRootAllowed(runtime.fs, input.workspaceRoot, deps),
  };
  runtime.progress.phase = "budget-evaluation";
  const readBudgetBlock = readBudgetStopReason(plan.budget);
  const deadlineAtMs = runtime.requestStartedAtMs + Math.max(0, plan.budget.elapsedMsMax);
  const elapsedBudgetBlock =
    runtime.nowMs() >= deadlineAtMs ? "budget-exhausted on elapsedMs" : undefined;
  const stopReason = readBudgetBlock ?? elapsedBudgetBlock;
  if (stopReason === undefined) {
    return retrieveLiveConnectedContext(input, deps, plan, governor, admittedRuntime);
  }
  runtime.progress.phase = "empty-pack-assembly";
  const stoppedGovernor =
    elapsedBudgetBlock === undefined
      ? governor
      : applyUsage(governor, usageDelta({ elapsedMs: plan.budget.elapsedMsMax }));
  const pack = await assembleEmptyGroundedPack({
    input,
    deps,
    plan,
    governor: stoppedGovernor,
    nowMs: runtime.nowMs,
    stopReason,
  });
  throwIfCancelled(deps.signal);
  return connectedContextExecution(
    pack,
    plan,
    runtime.activity,
    stoppedRetrievalCompletion(readBudgetBlock !== undefined, elapsedBudgetBlock !== undefined),
    EMPTY_STRUCTURAL_DIAGNOSTICS,
    NOT_EVALUATED_WORKSPACE_INDEX_DIAGNOSTICS,
    runtime.workspaceIoActivity.diagnostics(),
  );
}

// Epic #532 — retrieval-only pipeline: the ready-governed plan, workspace detection, ring run,
// and pack assembly (the original steps 1–4) WITHOUT the model answer. `deps.answerer` is part of
// the shared deps type but is intentionally not invoked here; the multi-source path answers once
// over the merged packs rather than per source.
function assertGroundedWorkspaceRootAllowed(
  fs: WorkspaceFs,
  workspaceRoot: string,
  deps: OrchestratorDeps,
): string {
  try {
    return resolveRecordedWorkspaceRoot(fs, workspaceRoot, deps);
  } catch (error) {
    if (error instanceof PathDeniedError) throw error;
    throw new WorkspaceNotFoundError("The workspace root is unavailable.", workspaceRoot, [
      workspaceRoot,
    ]);
  }
}

export async function retrieveConnectedContextPack(
  input: OrchestratorInput,
  deps: OrchestratorDeps,
): Promise<RetrievalOnlyOutput> {
  const nowMs = deps.nowMs ?? Date.now;
  const requestStartedAtMs = nowMs();
  const activity = safeConnectedContextActivity(input, deps, nowMs, requestStartedAtMs);
  const progress: ConnectedContextProgress = {
    phase: "request-validation",
    plannedRingCount: 0,
  };
  activity.started();
  try {
    const workspaceIoActivity = requestScopedWorkspaceFs(
      input.workspaceFs ?? deps.fs ?? nodeWorkspaceFs,
    );
    progress.workspaceIoActivity = workspaceIoActivity;
    const execution = await executeConnectedContextRetrieval(input, deps, {
      fs: workspaceIoActivity.fs,
      workspaceRoot: input.workspaceRoot,
      detect: deps.detectWorkspace ?? detectConnectedContextWorkspace,
      nowMs,
      activity,
      progress,
      workspaceIoActivity,
      requestStartedAtMs,
    });
    activity.completed(execution);
    return execution.output;
  } catch (error) {
    activity.failed(error, progress);
    throw error;
  }
}

// Knowledge M1.2 (#2563): fetch the injected entailment stage's markers for the answer, or `[]`
// when no stage is injected (keeps runGroundedExploration under the complexity/LOC bound).
async function entailmentMarkersFor(
  deps: OrchestratorDeps,
  answerContent: string,
  pack: ConnectedContextPack,
  nowMs: number,
): Promise<readonly UncertaintyMarker[]> {
  return (await deps.entailmentStage?.evaluate(answerContent, [pack], nowMs)) ?? [];
}

function citationCoverageMarkerFor(
  answerContent: string,
  pack: ConnectedContextPack,
  nowMs: number,
): UncertaintyMarker | undefined {
  const reconciliation = reconcileInlineCitations(answerContent, buildPackCitationIndex([pack]));
  const unsupported = unsupportedCitationMarker(reconciliation.unsupported, nowMs);
  if (unsupported !== undefined || reconciliation.citedScopePaths.size > 0) return unsupported;
  return missingCitationMarker(nowMs);
}

function exhaustedAnswerBudgetDimensions(
  answer: GroundedAnswerResult,
  pack: ConnectedContextPack,
  elapsedMs: number,
): readonly string[] {
  return [
    ...(answer.usage.promptTokens > pack.budget.modelInputTokensMax ? ["modelInputTokens"] : []),
    ...(answer.usage.completionTokens > pack.budget.modelOutputTokensMax
      ? ["modelOutputTokens"]
      : []),
    ...(elapsedMs > pack.budget.elapsedMsMax ? ["elapsedMs"] : []),
  ];
}

async function answerWithAvailableContext(
  input: OrchestratorInput,
  deps: OrchestratorDeps,
  pack: ConnectedContextPack,
  plan: OrchestratorOutput["plan"],
  sourceEvidenceAvailable: boolean,
  start: number,
  nowMs: () => number,
): Promise<OrchestratorOutput> {
  const answer = normalizeGroundedAnswerPayload(
    await deps.answerer.answer(input.answerQuestion ?? input.query.text, pack),
  );
  const elapsedMs = Math.max(0, nowMs() - start);
  const exhausted = exhaustedAnswerBudgetDimensions(answer, pack, elapsedMs);
  const unsupportedMarker = citationCoverageMarkerFor(answer.content, pack, nowMs());
  const entailmentMarkers = await entailmentMarkersFor(deps, answer.content, pack, nowMs());
  const groundedPack: ConnectedContextPack = {
    ...pack,
    usage: {
      ...pack.usage,
      modelInputTokens: Math.min(answer.usage.promptTokens, pack.budget.modelInputTokensMax),
      modelOutputTokens: Math.min(answer.usage.completionTokens, pack.budget.modelOutputTokensMax),
      elapsedMs: Math.min(Math.max(pack.usage.elapsedMs, elapsedMs), pack.budget.elapsedMsMax),
    },
    uncertainty: [
      ...pack.uncertainty,
      ...(exhausted.length === 0 ? [] : [answerBudgetClipped(exhausted, nowMs())]),
      ...(unsupportedMarker === undefined ? [] : [unsupportedMarker]),
      ...(answer.finishReason === "length" ? [incompleteAnswerMarker(nowMs())] : []),
      ...entailmentMarkers,
    ],
  };
  return {
    pack: groundedPack,
    assistantContent: answer.content,
    elapsedMs,
    modelInvoked: true,
    ...(plan === undefined ? {} : { plan }),
    ...(!sourceEvidenceAvailable ? { noEvidence: true } : {}),
  };
}

export async function runGroundedExploration(
  input: OrchestratorInput,
  deps: OrchestratorDeps,
): Promise<OrchestratorOutput> {
  // AC5 (#532): the single-source path measures its OWN total wall time (retrieval + answer) so the
  // observable elapsedMs is byte-identical to before this split. The retrieval-only elapsed returned
  // by retrieveConnectedContextPack is deliberately discarded here.
  const nowMs = deps.nowMs ?? Date.now;
  const start = nowMs();
  const { pack, plan } = await retrieveConnectedContextPack(input, deps);
  // GEN-AI-GROUNDING-002/-003 (RB-4): abstain BEFORE the model call when the assembled pack carries
  // no usable evidence. The local-knowledge and hybrid paths already short-circuit here; the folder
  // path must too, so the model is never asked to answer confidently over zero evidence and no
  // hallucinated answer is persisted as grounded. The `no-evidence` uncertainty marker is already on
  // the pack (assemblePackFromReads adds it when excerpts are empty).
  const sourceEvidenceAvailable = packHasUsableEvidence(pack);
  if (!sourceEvidenceAvailable && input.answerOnlyContextAvailable !== true) {
    const elapsedMs = Math.max(0, nowMs() - start);
    return {
      pack,
      assistantContent: GROUNDED_NO_EVIDENCE_ANSWER,
      elapsedMs,
      plan,
      noEvidence: true,
    };
  }
  return answerWithAvailableContext(input, deps, pack, plan, sourceEvidenceAvailable, start, nowMs);
}

// Re-export DEFAULT_SEARCH_LIMITS for parity with #179 callers that import limits via the
// orchestrator. Keeps `grounded-qa.ts` from needing a second workspace import path.
export { DEFAULT_SEARCH_LIMITS };
