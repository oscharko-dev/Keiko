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
import {
  CONNECTED_CONTEXT_SCHEMA_VERSION,
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
  type ExcerptWindow,
  type ExplorationPlan,
  type GovernorState,
  type MicroIndex,
  type RerankerSeam,
  type RetrievalIntent,
  type RetrievalRing,
  type SearchAnchor,
} from "@oscharko-dev/keiko-workflows";
import {
  CANONICAL_MANIFEST_BASENAMES,
  DEFAULT_SEARCH_LIMITS,
  FileTooLargeError,
  RepoSearchUnsupportedFileError,
  createEcosystemStructureAdapters,
  detectWorkspaceAt,
  endpointContractAdapter,
  findFiles,
  gitHistoryAdapter,
  importGraphAdapter,
  isCanonicalMetadataFile,
  isEcosystemSourceFile,
  isDenied,
  readExcerpt,
  resolveWithinWorkspace,
  runStructuralAdapters,
  searchText,
  symbolGraphAdapter,
  type SearchScope,
  type SemanticSearchProvider,
  type StructuralAdapterRegistry,
  type StructuralCoverageDiagnostics,
  testSourcePairingAdapter,
  type WorkspaceDirEntry,
  type WorkspaceFs,
  type WorkspaceIndex,
  type WorkspaceInfo,
  containedRealPathInfo,
  evidenceAtomStableId,
} from "@oscharko-dev/keiko-workspace";
import { CancelledError } from "@oscharko-dev/keiko-model-gateway";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { normalizeGroundedAnswerPayload, type GroundedAnswerPayload } from "./grounded-answer.js";
import {
  GROUNDED_NO_EVIDENCE_ANSWER,
  buildPackCitationIndex,
  incompleteAnswerMarker,
  packHasUsableEvidence,
  reconcileInlineCitations,
  unsupportedCitationMarker,
} from "./grounded-faithfulness.js";
import { collectFollowSymbolTraceEvidence } from "./grounded-symbol-trace.js";
import {
  defaultGitFileHistoryEvidenceProvider,
  type GitFileHistoryEvidenceProvider,
} from "./grounded-git-history-evidence.js";
import {
  collectConnectedDocumentEvidence,
  isConnectedDocumentPath,
  type DocumentEvidenceResult,
} from "./grounded-document-evidence.js";
import { attachContextBudgetDiagnostics } from "./grounded-context-diagnostics.js";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface GroundedAnswerer {
  // The seam the route uses: production supplies a Model Gateway-backed answerer, while tests can
  // keep deterministic answerers.
  answer(question: string, pack: ConnectedContextPack): Promise<GroundedAnswerPayload>;
}

export interface OrchestratorInput {
  readonly scope: SelectedScope;
  readonly query: RetrievalQuery;
  readonly workspaceRoot: string;
  readonly budget?: ExplorationBudget;
}

export interface OrchestratorDeps {
  readonly answerer: GroundedAnswerer;
  readonly nowMs?: () => number;
  readonly signal?: AbortSignal | undefined;
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
export function clarificationUserMessage(error: ClarificationNeededError): string {
  const { reason, suggestedQuestions } = error.clarification;
  const intro =
    reason === "scope-empty"
      ? "Die verbundene Quelle enthält nichts Durchsuchbares."
      : reason === "scope-invalid"
        ? "Die verbundene Quelle konnte nicht durchsucht werden."
        : "Keiko braucht mehr Kontext, um die verbundenen Quellen gezielt zu durchsuchen.";
  const anchorHint =
    reason === "no-anchors" || reason === "too-generic"
      ? " Nenne eine konkrete Datei, einen Identifier, eine Fehlermeldung oder eine exakte Phrase."
      : "";
  const examples = suggestedQuestions.slice(0, 2);
  const exampleText =
    examples.length > 0 ? ` Zum Beispiel: ${examples.map((q) => `"${q}"`).join(" oder ")}` : "";
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
  readonly repoSemanticSearchProvider?: SemanticSearchProvider | undefined;
  readonly gitFileHistoryEvidence: GitFileHistoryEvidenceProvider;
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

function noEvidence(nowMs: number): UncertaintyMarker {
  return {
    kind: "no-evidence",
    claim: "No repository evidence matched the connected scope for this question.",
    impactedAtomIds: [],
    emittedAtMs: nowMs,
  };
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
  if (coverage.filesSkipped <= 0 && partiallyIndexed <= 0) {
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
      )} file(s); structural edges may be missing from the context pack`,
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
  return ring.kind === "structural"
    ? structuralQueriesForRing(ring, inputs).length + MAX_STRUCTURAL_FOLLOW_UP_QUERIES
    : 1;
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

function isRankableFileAtom(atom: EvidenceAtom, inputs: SearchInputs): boolean {
  return (
    isValidScopePath(atom.scopePath, { mustBeRelative: true }) &&
    !isGitMetadataPath(atom.scopePath) &&
    !isDenied(atom.scopePath) &&
    fileExistsInSearchScope(inputs.searchScope, inputs.fs, atom.scopePath)
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
  for (const atom of atoms) {
    const edge = atom.edge;
    const target = edge?.target;
    if (
      target === undefined ||
      target.scopePath === atom.scopePath ||
      !isValidScopePath(target.scopePath, { mustBeRelative: true }) ||
      isDenied(target.scopePath) ||
      !fileExistsInSearchScope(inputs.searchScope, inputs.fs, target.scopePath)
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
    out.push({
      schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
      stableId,
      scopePath: target.scopePath,
      lineRange: target.lineRange,
      score: Math.max(0, Math.min(1, atom.score * 0.96)),
      provenance: {
        kind: "structural",
        tool: "structural-edge-target",
        queryFingerprint: atom.provenance.queryFingerprint,
      },
      edge,
      redactionState: "redacted",
      emittedAtMs: inputs.nowMs(),
      ledgerRef: undefined,
    });
  }
  return out;
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
  const result = await searchText(inputs.searchScope, inputs.query, ring.searchLimits, {
    fs: inputs.fs,
    nowMs: inputs.nowMs,
    searchHints: { retrievalIntent: inputs.retrievalIntent },
    ...(inputs.workspaceIndex === undefined ? {} : { workspaceIndex: inputs.workspaceIndex }),
    ...(inputs.repoSemanticSearchProvider !== undefined
      ? { semanticSearchProvider: inputs.repoSemanticSearchProvider }
      : {}),
  });
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
): Promise<readonly RunRingStructuralResult[]> {
  return Promise.all(
    queries.map((query) =>
      runStructuralAdapters(registry, inputs.searchScope, query, ring.searchLimits, inputs.fs, {
        nowMs: inputs.nowMs,
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
  const results = await runAdapterQueries(registry, ring, queries, inputs);
  const followUpQueries =
    ring.kind === "structural"
      ? structuralFollowUpQueries(
          mergeAtomsByStableId(results, ring.searchLimits.maxMatchesReturned),
          inputs.query,
        )
      : [];
  const followUpResults = await runAdapterQueries(registry, ring, followUpQueries, inputs);
  return [...results, ...followUpResults];
}

async function gitFileAtomsForRing(
  ring: NonLexicalRing,
  inputs: SearchInputs,
  cap: number,
): Promise<{ readonly atoms: readonly EvidenceAtom[]; readonly elapsedMs: number }> {
  if (ring.kind !== "git-history") {
    return { atoms: [], elapsedMs: 0 };
  }
  const startedAtMs = inputs.nowMs();
  const atoms = await inputs.gitFileHistoryEvidence({
    searchScope: inputs.searchScope,
    query: inputs.query,
    fs: inputs.fs,
    nowMs: inputs.nowMs,
    signal: inputs.signal,
    maxFiles: cap,
  });
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
  return dedupeAtoms(
    [...merged, ...gitAtoms].filter((atom) => isRankableFileAtom(atom, inputs)),
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

interface RingReservation {
  readonly governor: GovernorState;
  readonly marker?: UncertaintyMarker | undefined;
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

async function runAllRings(
  rings: readonly RetrievalRing[],
  inputs: SearchInputs,
  initialGovernor: GovernorState,
): Promise<RingRunSummary> {
  const blockedByReadBudget = readBudgetStopReason(initialGovernor.plan.budget);
  if (blockedByReadBudget !== undefined) {
    return {
      atoms: [],
      omitted: [],
      governor: complete(initialGovernor),
      uncertainty: [budgetClipped(blockedByReadBudget, inputs.nowMs())],
    };
  }
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
const EXCERPT_CONTEXT_LINES = 2;
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
const SYMBOL_FILE_SEARCH_LIMITS = {
  maxFilesScanned: 10_000,
  maxMatchesReturned: SYMBOL_FILE_MATCHES_MAX,
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
  return [...roots].sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readWorkspacePatterns(
  searchScope: SearchScope,
  fs: WorkspaceFs,
  existsCache?: FileExistenceCache,
): readonly string[] {
  if (!fileExistsInSearchScope(searchScope, fs, "package.json", existsCache)) {
    return [];
  }
  try {
    const abs = resolveWithinWorkspace(searchScope.workspace.root, "package.json");
    const contained = containedRealPathInfo(fs, searchScope.workspace.root, abs);
    const parsed: unknown = JSON.parse(fs.readFileUtf8(contained.path));
    if (!isRecord(parsed)) {
      return [];
    }
    const workspaces = parsed.workspaces;
    if (Array.isArray(workspaces)) {
      return workspaces.filter((entry): entry is string => typeof entry === "string");
    }
    if (isRecord(workspaces) && Array.isArray(workspaces.packages)) {
      return workspaces.packages.filter((entry): entry is string => typeof entry === "string");
    }
  } catch {
    return [];
  }
  return [];
}

function normalizeWorkspacePattern(pattern: string): string | undefined {
  let normalized = pattern.trim().replace(/\\/gu, "/");
  while (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }
  normalized = normalized.replace(/\/+$/u, "");
  if (normalized.length === 0 || normalized.startsWith("../") || normalized.includes("/../")) {
    return undefined;
  }
  return normalized;
}

function safeReadDir(
  searchScope: SearchScope,
  fs: WorkspaceFs,
  scopePath: string,
): readonly WorkspaceDirEntry[] {
  if (scopePath.length > 0 && !isValidScopePath(scopePath, { mustBeRelative: true })) {
    return [];
  }
  try {
    const abs = resolveWithinWorkspace(searchScope.workspace.root, scopePath);
    const contained = containedRealPathInfo(fs, searchScope.workspace.root, abs);
    if (!fs.stat(contained.path).isDirectory) {
      return [];
    }
    return fs.readDir(contained.path);
  } catch {
    return [];
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
): readonly string[] {
  return safeReadDir(searchScope, fs, dir)
    .filter((entry) => !entry.isDirectory && !entry.isSymbolicLink)
    .map((entry) => joinScopePath(dir, entry.name))
    .filter((scopePath) => isCanonicalMetadataFile(scopePath) && !isDenied(scopePath))
    .sort();
}

function expandWorkspacePattern(
  pattern: string,
  searchScope: SearchScope,
  fs: WorkspaceFs,
): readonly string[] {
  const normalized = normalizeWorkspacePattern(pattern);
  if (normalized === undefined) {
    return [];
  }
  if (!normalized.includes("*")) {
    const dir = normalized.endsWith("/package.json")
      ? normalized.slice(0, -"/package.json".length)
      : normalized;
    return canonicalManifestScopePathsInDir(dir, searchScope, fs);
  }
  if (!normalized.endsWith("/*") || normalized.slice(0, -2).includes("*")) {
    return [];
  }
  const base = normalized.slice(0, -2);
  return safeReadDir(searchScope, fs, base)
    .filter((entry) => entry.isDirectory && !entry.isSymbolicLink)
    .map((entry) => entry.name)
    .sort()
    .slice(0, MAX_MONOREPO_SERVICE_DIRS)
    .flatMap((name) =>
      canonicalManifestScopePathsInDir(joinScopePath(base, name), searchScope, fs),
    );
}

function workspacePackageManifestPaths(
  input: OrchestratorInput,
  searchScope: SearchScope,
  fs: WorkspaceFs,
  existsCache?: FileExistenceCache,
): readonly string[] {
  if (input.scope.kind !== "workspace-root" || input.scope.relativePaths.length !== 0) {
    return [];
  }
  const patterns = new Set<string>(readWorkspacePatterns(searchScope, fs, existsCache));
  for (const dir of WORKSPACE_PACKAGE_DIRS) {
    patterns.add(`${dir}/*`);
  }
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const pattern of [...patterns].sort()) {
    for (const scopePath of expandWorkspacePattern(pattern, searchScope, fs)) {
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
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function symbolDefinitionPatterns(term: string): readonly RegExp[] {
  const escaped = escapeRegex(term);
  return [
    new RegExp(`\\b(?:export\\s+)?(?:async\\s+)?function\\s+${escaped}\\b`, "iu"),
    new RegExp(`\\b(?:export\\s+)?(?:class|interface|type|enum)\\s+${escaped}\\b`, "iu"),
    new RegExp(`\\b(?:export\\s+)?(?:const|let|var)\\s+${escaped}\\b`, "iu"),
    new RegExp(
      `\\b(?:public\\s+|private\\s+|protected\\s+|abstract\\s+|final\\s+|data\\s+)*(?:class|interface|record|enum)\\s+${escaped}\\b`,
      "iu",
    ),
    new RegExp(
      `\\b(?:public\\s+|private\\s+|protected\\s+|static\\s+|final\\s+)*[A-Za-z_$][\\w$<>, ?.[\\]]+\\s+${escaped}\\s*\\(`,
      "iu",
    ),
    new RegExp(`\\b(?:def|func|fn|fun)\\s+${escaped}\\s*\\(`, "iu"),
    new RegExp(`\\btype\\s+${escaped}\\s+(?:struct|interface)\\b`, "iu"),
    new RegExp(`\\b(?:struct|trait|enum|class)\\s+${escaped}\\b`, "iu"),
  ];
}

function lineDefinesSymbol(line: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(line));
}

function firstLineIndex(lines: readonly string[], predicate: (line: string) => boolean): number {
  return lines.findIndex(predicate);
}

function firstSymbolLine(
  searchScope: SearchScope,
  fs: WorkspaceFs,
  scopePath: string,
  term: string,
): number | undefined {
  try {
    const abs = resolveWithinWorkspace(searchScope.workspace.root, scopePath);
    const contained = containedRealPathInfo(fs, searchScope.workspace.root, abs);
    const stat = fs.stat(contained.path);
    if (!stat.isFile || stat.size > SYMBOL_LINE_SCAN_BYTES_MAX) {
      return undefined;
    }
    const loweredTerm = term.toLowerCase();
    const definitionPatterns = symbolDefinitionPatterns(term);
    const lines = fs.readFileUtf8(contained.path).split("\n");
    const definitionIndex = firstLineIndex(lines, (line) =>
      lineDefinesSymbol(line, definitionPatterns),
    );
    const index =
      definitionIndex >= 0
        ? definitionIndex
        : firstLineIndex(lines, (line) => line.toLowerCase().includes(loweredTerm));
    return index < 0 ? undefined : index + 1;
  } catch {
    return undefined;
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

// Walk the tree ONCE for `**/term.*` and keep only `term.<code-ext>` definition files. The single
// walk replaces the prior
// per-extension globs (up to 27 redundant full-tree walks per question, ~4.7s on a 3.5k-file repo).
async function symbolDefinitionMatchesForTerm(
  term: string,
  input: OrchestratorInput,
  plan: ExplorationPlan,
  searchScope: SearchScope,
  fs: WorkspaceFs,
  nowMs: () => number,
): Promise<{
  readonly matches: readonly SymbolDefinitionMatch[];
  readonly uncertainty: readonly UncertaintyMarker[];
}> {
  const result = await findFiles(
    searchScope,
    symbolFileQuery(input, `**/${term}.*`),
    SYMBOL_FILE_SEARCH_LIMITS,
    {
      fs,
      nowMs,
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
  searchScope: SearchScope,
  fs: WorkspaceFs,
  nowMs: () => number,
  signal: AbortSignal | undefined,
): Promise<{
  readonly matches: readonly SymbolDefinitionMatch[];
  readonly uncertainty: readonly UncertaintyMarker[];
}> {
  const results = await Promise.all(
    terms.map((term) => {
      throwIfCancelled(signal);
      return symbolDefinitionMatchesForTerm(term, input, plan, searchScope, fs, nowMs);
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
): void {
  const { atom, term } = match;
  const lineNumber = firstSymbolLine(searchScope, fs, atom.scopePath, term);
  if (lineNumber === undefined) {
    return;
  }
  pushUniqueAtom(
    atoms,
    seen,
    symbolLineAtom(
      input.scope,
      atom.scopePath,
      lineNumber,
      atom.provenance.queryFingerprint,
      nowMs,
    ),
  );
}

async function symbolFileAtoms(
  input: OrchestratorInput,
  plan: ExplorationPlan,
  searchScope: SearchScope,
  fs: WorkspaceFs,
  nowMs: () => number,
  signal: AbortSignal | undefined,
): Promise<SymbolDiscoveryResult> {
  const terms = symbolFileAnchorTerms(plan);
  if (terms.length === 0) {
    return { atoms: [], uncertainty: [] };
  }
  const collected = await collectSymbolDefinitionMatches(
    terms,
    input,
    plan,
    searchScope,
    fs,
    nowMs,
    signal,
  );
  const atoms: EvidenceAtom[] = [];
  const uncertainty: UncertaintyMarker[] = [...collected.uncertainty];
  const seen = new Set<string>();
  let remainingLineReads = MAX_SYMBOL_LINE_READS;
  let overflowCount = 0;
  for (const match of [...collected.matches].sort(compareSymbolMatches)) {
    pushUniqueAtom(atoms, seen, match.atom);
    if (remainingLineReads <= 0) {
      overflowCount += 1;
      continue;
    }
    remainingLineReads -= 1;
    pushSymbolLineAtom(input, searchScope, fs, nowMs, match, atoms, seen);
  }
  const overflowMarker = symbolLineReadOverflow(overflowCount, terms, nowMs);
  if (overflowMarker !== undefined) {
    uncertainty.push(overflowMarker);
  }
  return { atoms, uncertainty };
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
  const entry =
    entryName.length > 0
      ? cachedDirectoryEntries(searchScope, fs, parentScopePath, existsCache).find(
          (candidate) => candidate.name === entryName,
        )
      : undefined;
  if (entry === undefined) {
    existsCache?.files.set(scopePath, false);
    return false;
  }
  if (!entry.isSymbolicLink) {
    const exists = entry.isFile;
    existsCache?.files.set(scopePath, exists);
    return exists;
  }
  let exists: boolean;
  try {
    const abs = resolveWithinWorkspace(searchScope.workspace.root, scopePath);
    const contained = containedRealPathInfo(fs, searchScope.workspace.root, abs);
    exists = fs.stat(contained.path).isFile;
  } catch {
    exists = false;
  }
  existsCache?.files.set(scopePath, exists);
  return exists;
}

interface FileExistenceCache {
  readonly files: Map<string, boolean>;
  readonly directories: Map<string, readonly WorkspaceDirEntry[]>;
}

function createFileExistenceCache(): FileExistenceCache {
  return { files: new Map(), directories: new Map() };
}

function basenameScopePath(scopePath: string): string {
  const index = scopePath.lastIndexOf("/");
  return index === -1 ? scopePath : scopePath.slice(index + 1);
}

function cachedDirectoryEntries(
  searchScope: SearchScope,
  fs: WorkspaceFs,
  scopePath: string,
  existsCache?: FileExistenceCache,
): readonly WorkspaceDirEntry[] {
  const cached = existsCache?.directories.get(scopePath);
  if (cached !== undefined) return cached;
  const entries = safeReadDir(searchScope, fs, scopePath);
  existsCache?.directories.set(scopePath, entries);
  return entries;
}

function selectedFileScopeAtoms(
  input: OrchestratorInput,
  searchScope: SearchScope,
  fs: WorkspaceFs,
  nowMs: () => number,
  existsCache?: FileExistenceCache,
): readonly EvidenceAtom[] {
  if (input.scope.explicitConnection !== true || input.scope.kind !== "files") {
    return [];
  }
  const atoms: EvidenceAtom[] = [];
  const seen = new Set<string>();
  const queryFingerprint = selectedFileQueryFingerprint(input.query);
  for (const entry of input.scope.relativePaths) {
    if (!isValidScopePath(entry, { mustBeRelative: true })) {
      continue;
    }
    const scopePath = entry.replace(/\\/gu, "/");
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
    if (fileExistsInSearchScope(searchScope, fs, scopePath, existsCache)) {
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
): readonly string[] {
  const paths: string[] = [];
  for (const scopePath of canonicalManifestScopePathsInDir(root, searchScope, fs)) {
    if (paths.length >= MAX_ROOT_GLOB_MANIFESTS) {
      break;
    }
    if (acceptInjectionScopePath(scopePath, seen)) {
      paths.push(scopePath);
    }
  }
  return paths;
}

function projectMetadataAtoms(
  input: OrchestratorInput,
  intent: RetrievalIntent,
  searchScope: SearchScope,
  fs: WorkspaceFs,
  nowMs: () => number,
  queryFingerprint: string,
  existsCache?: FileExistenceCache,
): readonly EvidenceAtom[] {
  if (!wantsProjectMetadata(input, intent)) {
    return [];
  }
  const atoms: EvidenceAtom[] = [];
  const seen = new Set<string>();
  for (const root of metadataRootsForScope(input.scope)) {
    for (const filename of PROJECT_METADATA_FILENAMES) {
      const scopePath = joinScopePath(root, filename);
      if (
        acceptInjectionScopePath(scopePath, seen) &&
        fileExistsInSearchScope(searchScope, fs, scopePath, existsCache)
      ) {
        atoms.push(metadataAtom(input.scope, scopePath, queryFingerprint, nowMs));
      }
    }
    // Glob-manifest sweep of the directory itself (bounded), so a root-level *.csproj / *.tf that
    // the fixed-name list cannot enumerate is still injected. Exact names already seen are deduped.
    for (const scopePath of rootGlobManifestPaths(root, searchScope, fs, seen)) {
      atoms.push(metadataAtom(input.scope, scopePath, queryFingerprint, nowMs));
    }
  }
  for (const scopePath of workspacePackageManifestPaths(input, searchScope, fs, existsCache)) {
    if (acceptInjectionScopePath(scopePath, seen)) {
      atoms.push(metadataAtom(input.scope, scopePath, queryFingerprint, nowMs));
    }
  }
  return atoms;
}

function repositoryOverviewAtoms(
  input: OrchestratorInput,
  intent: RetrievalIntent,
  searchScope: SearchScope,
  fs: WorkspaceFs,
  nowMs: () => number,
  queryFingerprint: string,
  existsCache?: FileExistenceCache,
): readonly EvidenceAtom[] {
  if (!wantsRepositoryOverview(intent)) {
    return [];
  }
  const atoms: EvidenceAtom[] = [];
  const seen = new Set<string>();
  for (const root of metadataRootsForScope(input.scope)) {
    for (const filename of REPOSITORY_OVERVIEW_FILENAMES) {
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

async function deterministicContextEvidence(
  input: OrchestratorInput,
  plan: ExplorationPlan,
  searchScope: SearchScope,
  fs: WorkspaceFs,
  nowMs: () => number,
  signal: AbortSignal | undefined,
): Promise<DeterministicContextEvidence> {
  const existsCache = createFileExistenceCache();
  const metadataQueryFingerprint = projectMetadataQueryFingerprint(input.query);
  const [symbolDiscovery, traceEvidence] = await Promise.all([
    symbolFileAtoms(input, plan, searchScope, fs, nowMs, signal),
    collectFollowSymbolTraceEvidence({
      scope: input.scope,
      query: input.query,
      anchors: plan.anchors,
      retrievalIntent: plan.retrievalIntent,
      searchScope,
      fs,
      nowMs,
      signal,
    }),
  ]);
  return {
    atoms: [
      ...symbolDiscovery.atoms,
      ...traceEvidence.atoms,
      ...projectMetadataAtoms(
        input,
        plan.retrievalIntent,
        searchScope,
        fs,
        nowMs,
        metadataQueryFingerprint,
        existsCache,
      ),
      ...repositoryOverviewAtoms(
        input,
        plan.retrievalIntent,
        searchScope,
        fs,
        nowMs,
        metadataQueryFingerprint,
        existsCache,
      ),
    ],
    uncertainty: [...symbolDiscovery.uncertainty, ...traceEvidence.uncertainty],
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
): Promise<RingRunSummary> {
  const deterministic = await deterministicContextEvidence(
    input,
    plan,
    searchScope,
    fs,
    nowMs,
    signal,
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
): RingRunSummary {
  const selectedAtoms = selectedFileScopeAtoms(
    input,
    searchScope,
    fs,
    nowMs,
    createFileExistenceCache(),
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
  queryText: string,
  anchors: readonly SearchAnchor[],
  diagnostics: ContextPackDiagnostics | undefined,
  nowMs: number,
): CandidateOrdering {
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
  const orderedPreferred = queryTargetsRouteImplementation(queryText)
    ? orderPreferredCandidates(preferred, diagnostics)
    : preferred;
  return {
    kept: [...orderedPreferred, ...lockfiles],
    omitted: nextOmitted,
  };
}

const ROUTE_METHOD_QUERY_RE = /\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/iu;
const ROUTE_PATH_QUERY_RE = /\/[A-Za-z0-9:_?&=./-]+/u;
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
  const order = new Map(ranked.map((candidate, index) => [candidate.scopePath, index]));
  return [...kept].sort((a, b) => comparePreferredCandidate(a, b, order));
}

function comparePreferredCandidate(
  a: CandidateFile,
  b: CandidateFile,
  order: ReadonlyMap<string, number>,
): number {
  const diagnosticOrder = compareDiagnosticOrder(order.get(a.scopePath), order.get(b.scopePath));
  if (diagnosticOrder !== 0) {
    return diagnosticOrder;
  }
  if (b.score !== a.score) {
    return b.score - a.score;
  }
  return a.scopePath < b.scopePath ? -1 : a.scopePath > b.scopePath ? 1 : 0;
}

function compareDiagnosticOrder(aIndex: number | undefined, bIndex: number | undefined): number {
  if (aIndex !== undefined && bIndex !== undefined) {
    return aIndex - bIndex;
  }
  if (aIndex !== undefined) {
    return -1;
  }
  return bIndex !== undefined ? 1 : 0;
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
  return {
    startLine: Math.max(1, range.startLine - EXCERPT_CONTEXT_LINES),
    endLine: range.endLine + EXCERPT_CONTEXT_LINES,
  };
}

function mergeLineWindows(windows: readonly LineWindow[]): readonly LineWindow[] {
  const sorted = [...windows].sort((a, b) =>
    a.startLine === b.startLine ? a.endLine - b.endLine : a.startLine - b.startLine,
  );
  const merged: LineWindow[] = [];
  for (const window of sorted) {
    const previous = merged[merged.length - 1];
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

function strongestAtomScoreForWindow(
  window: LineWindow,
  atomsForPath: readonly EvidenceAtom[],
): number {
  let score = 0;
  for (const atom of atomsForPath) {
    if (windowContainsAtom(window, atom) && atom.score > score) {
      score = atom.score;
    }
  }
  return score;
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
  const merged = mergeLineWindows(atomsForPath.map(lineWindowForAtom));
  const selected = [...merged]
    .sort((a, b) => {
      const scoreDelta =
        strongestAtomScoreForWindow(b, atomsForPath) - strongestAtomScoreForWindow(a, atomsForPath);
      return scoreDelta === 0 ? a.startLine - b.startLine : scoreDelta;
    })
    .slice(0, MAX_EXCERPT_WINDOWS_PER_FILE)
    .sort((a, b) =>
      a.startLine === b.startLine ? a.endLine - b.endLine : a.startLine - b.startLine,
    );
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
  const selection = excerptLineWindows(inputs.atomsByPath.get(scopePath));
  for (const window of selection.windows) {
    throwIfCancelled(inputs.signal);
    const availableBytes = remainingBytes - bytesConsumed;
    if (availableBytes <= 0) {
      break;
    }
    const maxBytes = Math.min(8192, availableBytes);
    const result = await readExcerpt(
      inputs.searchScope,
      { scopePath, startLine: window.startLine, endLine: window.endLine, maxBytes },
      { fs: inputs.fs },
    );
    throwIfCancelled(inputs.signal);
    if (result.truncated) {
      truncatedWindowCount += 1;
    }
    windows.push({ ...window, content: result.content });
    bytesConsumed += utf8ByteLength(result.content);
  }
  return {
    windows,
    bytesConsumed,
    omittedWindowCount: selection.omittedWindowCount,
    truncatedWindowCount,
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

async function readKeptExcerpts(
  keptPaths: readonly string[],
  inputs: ExcerptInputs,
): Promise<ExcerptReadSummary> {
  const excerpts = new Map<string, readonly ExcerptWindow[]>();
  const uncertainty: UncertaintyMarker[] = [];
  const remainingFiles = Math.max(0, inputs.budget.filesReadMax - inputs.initialUsage.filesRead);
  const remainingBytes = Math.max(
    0,
    inputs.budget.excerptBytesMax - inputs.initialUsage.excerptBytes,
  );
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
  return { excerpts, uncertainty };
}

function buildSearchScope(scope: SelectedScope, workspace: WorkspaceInfo): SearchScope {
  return {
    workspace,
    scopeId: scope.scopeId,
    relativePaths: scope.relativePaths,
  };
}

function fileStateCacheIdentity(
  keptPaths: readonly string[],
  searchScope: SearchScope,
  fs: WorkspaceFs,
): PackCacheIdentity | undefined {
  const identity: string[] = [];
  try {
    for (const scopePath of keptPaths) {
      const target = containedRealPathInfo(
        fs,
        searchScope.workspace.root,
        resolveWithinWorkspace(searchScope.workspace.root, scopePath),
      );
      const stat = fs.stat(target.path);
      if (!stat.isFile || stat.mtimeMs === undefined) {
        return undefined;
      }
      identity.push(
        `${scopePath}:${target.realRelative}:${stat.size.toString()}:${stat.mtimeMs.toString()}`,
      );
    }
  } catch {
    return undefined;
  }
  return identity.sort();
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
  readonly deps: OrchestratorDeps;
  readonly plan: ExplorationPlan;
  readonly rings: RingRunSummary;
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

function assembleOptionsFor(
  deps: OrchestratorDeps,
  nowMs: () => number,
  includeMicroIndex: boolean,
): AssembleOptionsForGroundedPack {
  return {
    nowMs,
    ...(includeMicroIndex && deps.microIndex !== undefined ? { microIndex: deps.microIndex } : {}),
    ...(deps.contextPackReranker === undefined ? {} : { reranker: deps.contextPackReranker }),
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
  const assembleOptions = assembleOptionsFor(deps, nowMs, true);
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
  deps,
  plan,
  rings,
  ordered,
  cacheIdentity,
  initialUsage,
  assembleOptions,
}: GroundedPackCacheLookupInputs): ConnectedContextPack | undefined {
  if (deps.microIndex === undefined || cacheIdentity === undefined) {
    return undefined;
  }
  const key = contextPackIndexKey(
    {
      scope: input.scope,
      query: input.query,
      budget: plan.budget,
      atoms: rings.atoms,
      ranked: ordered.kept,
      omittedFromRanking: [...rings.omitted, ...ordered.omitted],
      excerpts: new Map(),
      cacheIdentity,
      initialUsage,
      diagnostics: rings.diagnostics,
    },
    assembleOptions,
  );
  return deps.microIndex.get(key);
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
  const ordered = refineCandidateOrdering(
    ranking.kept,
    ranking.omitted,
    input.query.text,
    plan.anchors,
    rings.diagnostics,
    nowMs(),
  );
  return {
    atoms,
    initialUsage,
    ordered,
    atomsByPath: groupEvidenceAtomsByPath(atoms),
    evidenceUncertainty:
      atoms.length === 0 || ordered.kept.length === 0 ? [noEvidence(nowMs())] : [],
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

async function augmentRingsWithDeterministicAtoms({
  input,
  deps,
  plan,
  rings,
  searchScope,
  fs,
  nowMs,
}: AssembleGroundedPackInputs): Promise<RingRunSummary> {
  const scopedRings = withExplicitScopeAtoms(rings, input, searchScope, fs, nowMs);
  return withDeterministicContextAtoms(
    scopedRings,
    input,
    plan,
    searchScope,
    fs,
    nowMs,
    deps.signal,
  );
}

interface GroundedAssemblyContext {
  readonly documentEvidence: DocumentEvidenceResult;
  readonly cached: ConnectedContextPack | undefined;
  readonly cacheIdentity: PackCacheIdentity | undefined;
  readonly assembleOptions: AssembleOptionsForGroundedPack;
}

async function prepareGroundedAssembly(
  args: AssembleGroundedPackInputs,
  augmentedRings: RingRunSummary,
  prepared: PreparedPackAssembly,
): Promise<GroundedAssemblyContext> {
  const { input, deps, plan, searchScope, fs, nowMs } = args;
  // Bounded small-document extraction for explicit `files` scopes (Issue #1285). Returns empty
  // evidence for every other scope kind, leaving the code-first path byte-identical.
  const documentEvidence = await collectConnectedDocumentEvidence({
    scope: input.scope,
    query: input.query,
    searchScope,
    fs,
    nowMs,
    signal: deps.signal,
  });
  const hasDocumentEvidence =
    documentEvidence.atoms.length > 0 || documentEvidence.omitted.length > 0;
  const cacheIdentity =
    deps.microIndex === undefined || hasDocumentEvidence
      ? undefined
      : fileStateCacheIdentity(prepared.keptPaths, searchScope, fs);
  const assembleOptions = assembleOptionsFor(deps, nowMs, !hasDocumentEvidence);
  // The micro-index cache key does not model request-local document evidence, so a scope that
  // carried documents this run must not be served from (or written to) the shared cache.
  const cached = hasDocumentEvidence
    ? undefined
    : cachedGroundedPack({
        input,
        deps,
        plan,
        rings: augmentedRings,
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
  const { input, deps, plan, searchScope, fs, nowMs } = args;
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

// Epic #532 — retrieval-only pipeline: the ready-governed plan, workspace detection, ring run,
// and pack assembly (the original steps 1–4) WITHOUT the model answer. `deps.answerer` is part of
// the shared deps type but is intentionally not invoked here; the multi-source path answers once
// over the merged packs rather than per source.
export async function retrieveConnectedContextPack(
  input: OrchestratorInput,
  deps: OrchestratorDeps,
): Promise<RetrievalOnlyOutput> {
  const fs = deps.fs ?? nodeWorkspaceFs;
  const detect = deps.detectWorkspace ?? detectWorkspaceAt;
  const nowMs = deps.nowMs ?? Date.now;
  const start = nowMs();
  throwIfCancelled(deps.signal);

  const { plan, governor } = createReadyGovernedPlan(input, nowMs);
  deps.recordPlan?.(plan);
  throwIfCancelled(deps.signal);

  const blockedByReadBudget = readBudgetStopReason(plan.budget);
  if (blockedByReadBudget !== undefined) {
    const pack = await assembleEmptyGroundedPack({
      input,
      deps,
      plan,
      governor,
      nowMs,
      stopReason: blockedByReadBudget,
    });
    throwIfCancelled(deps.signal);
    return { pack, elapsedMs: Math.max(0, nowMs() - start), plan };
  }

  const workspace = detect(input.workspaceRoot, fs);
  const searchScope = buildSearchScope(input.scope, workspace);
  const workspaceIndex = deps.workspaceIndexForRoot?.(workspace.root);
  const rings = await runAllRings(
    plan.rings,
    {
      searchScope,
      query: input.query,
      anchors: plan.anchors,
      retrievalIntent: plan.retrievalIntent,
      fs,
      nowMs,
      signal: deps.signal,
      ...(workspaceIndex === undefined ? {} : { workspaceIndex }),
      repoSemanticSearchProvider: deps.repoSemanticSearchProvider ?? deps.semanticSearchProvider,
      gitFileHistoryEvidence: deps.gitFileHistoryEvidence ?? defaultGitFileHistoryEvidenceProvider,
    },
    governor,
  );
  throwIfCancelled(deps.signal);
  const pack = await assembleGroundedPack({ input, deps, plan, rings, searchScope, fs, nowMs });
  throwIfCancelled(deps.signal);
  return { pack, elapsedMs: Math.max(0, nowMs() - start), plan };
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
  if (!packHasUsableEvidence(pack)) {
    const elapsedMs = Math.max(0, nowMs() - start);
    return {
      pack,
      assistantContent: GROUNDED_NO_EVIDENCE_ANSWER,
      elapsedMs,
      plan,
      noEvidence: true,
    };
  }
  const answer = normalizeGroundedAnswerPayload(await deps.answerer.answer(input.query.text, pack));
  const elapsedMs = Math.max(0, nowMs() - start);
  const exhaustedAnswerDimensions = [
    ...(answer.usage.promptTokens > pack.budget.modelInputTokensMax ? ["modelInputTokens"] : []),
    ...(answer.usage.completionTokens > pack.budget.modelOutputTokensMax
      ? ["modelOutputTokens"]
      : []),
    ...(elapsedMs > pack.budget.elapsedMsMax ? ["elapsedMs"] : []),
  ];
  // GEN-AI-GROUNDING-001/-008 (RB-4): reconcile the model's inline `[path:line]` citations against
  // the evidence pack that was actually sent to it. References to files the model never received are
  // surfaced as an unsupported-citation marker instead of being displayed as grounded claims.
  const reconciliation = reconcileInlineCitations(answer.content, buildPackCitationIndex([pack]));
  const unsupportedMarker = unsupportedCitationMarker(reconciliation.unsupported, nowMs());
  // GEN-AI-GATEWAY-001 (RB-4): a truncated completion is surfaced, not consumed as complete.
  const truncated = answer.finishReason === "length";
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
      ...(exhaustedAnswerDimensions.length === 0
        ? []
        : [answerBudgetClipped(exhaustedAnswerDimensions, nowMs())]),
      ...(unsupportedMarker === undefined ? [] : [unsupportedMarker]),
      ...(truncated ? [incompleteAnswerMarker(nowMs())] : []),
    ],
  };
  return { pack: groundedPack, assistantContent: answer.content, elapsedMs, plan };
}

// Re-export DEFAULT_SEARCH_LIMITS for parity with #179 callers that import limits via the
// orchestrator. Keeps `grounded-qa.ts` from needing a second workspace import path.
export { DEFAULT_SEARCH_LIMITS };
