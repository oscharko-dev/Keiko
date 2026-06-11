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

import {
  isValidScopePath,
  type CandidateFile,
  type ConnectedContextPack,
  type EvidenceAtom,
  type ExplorationBudget,
  type ExplorationUsage,
  type OmittedContextEntry,
  type RetrievalQuery,
  type SelectedScope,
  type UncertaintyMarker,
} from "@oscharko-dev/keiko-contracts/connected-context";
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
  type RetrievalRing,
  type SearchAnchor,
} from "@oscharko-dev/keiko-workflows";
import {
  DEFAULT_SEARCH_LIMITS,
  FileTooLargeError,
  RepoSearchUnsupportedFileError,
  detectWorkspaceAt,
  gitHistoryAdapter,
  importGraphAdapter,
  readExcerpt,
  resolveWithinWorkspace,
  runStructuralAdapters,
  searchText,
  type SearchScope,
  type StructuralAdapterRegistry,
  testSourcePairingAdapter,
  type WorkspaceFs,
  type WorkspaceInfo,
  containedRealPathInfo,
} from "@oscharko-dev/keiko-workspace";
import { CancelledError } from "@oscharko-dev/keiko-model-gateway";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { normalizeGroundedAnswerPayload, type GroundedAnswerPayload } from "./grounded-answer.js";

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
}

export interface OrchestratorOutput {
  readonly pack: ConnectedContextPack;
  readonly assistantContent: string;
  readonly elapsedMs: number;
  readonly plan?: ExplorationPlan;
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
// route maps this to a 400 BAD_REQUEST with the planner's clarification reason in the message.
export class ClarificationNeededError extends Error {
  public constructor(public readonly clarification: ClarificationPrompt) {
    super(`clarification needed: ${clarification.reason}`);
    this.name = "ClarificationNeededError";
  }
}

// ─── Default deterministic answerer ───────────────────────────────────────────

export const echoAnswerer: GroundedAnswerer = {
  answer: (question, pack) => {
    try {
      const filePaths = pack.files.map((f) => f.scopePath).join(", ");
      const summary =
        `Inspected ${String(pack.files.length)} file(s) for: ${question}. ` +
        `Findings include: ${filePaths.length === 0 ? "(no evidence)" : filePaths}.`;
      return Promise.resolve(summary);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  },
};

// ─── Internal helpers ─────────────────────────────────────────────────────────

interface SearchInputs {
  readonly searchScope: SearchScope;
  readonly query: RetrievalQuery;
  readonly anchors: readonly SearchAnchor[];
  readonly fs: WorkspaceFs;
  readonly nowMs: () => number;
  readonly signal?: AbortSignal | undefined;
}

interface RingResult {
  readonly atoms: readonly EvidenceAtom[];
  readonly omitted: readonly OmittedContextEntry[];
  readonly uncertainty: readonly UncertaintyMarker[];
  readonly usage: ExplorationUsage;
}

const TEXT_ENCODER = new TextEncoder();

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new CancelledError("grounded repository request cancelled");
  }
}

function utf8ByteLength(value: string): number {
  return TEXT_ENCODER.encode(value).length;
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

function adapterDiagnostics(
  result: {
    readonly unavailable: readonly string[];
    readonly errored: readonly { readonly name: string }[];
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

function plannedSearchCallsForRing(ring: RetrievalRing, inputs: SearchInputs): number {
  return ring.kind === "structural" ? structuralQueriesForRing(ring, inputs).length : 1;
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

interface RunRingStructuralResult {
  readonly atoms: readonly EvidenceAtom[];
  readonly unavailable: readonly string[];
  readonly errored: readonly { readonly name: string }[];
  readonly elapsedMs: number;
}

async function runRing(ring: RetrievalRing, inputs: SearchInputs): Promise<RingResult> {
  if (ring.kind === "lexical") {
    const result = await searchText(inputs.searchScope, inputs.query, ring.searchLimits, {
      fs: inputs.fs,
      nowMs: inputs.nowMs,
    });
    // Lexical scanning is transient: each candidate file is read to match lines, then discarded.
    // It does NOT consume the excerpt budget. Charging result.filesScanned against filesReadMax
    // (Epic #177 retrieval defect) let a wide scan exhaust the budget the excerpt READ phase needs
    // and starved multi-file scopes — the scan could only ever examine ~4 files. The reserved
    // search call (one per ring) plus elapsedMs already bound the scan; the files whose content
    // actually enters the pack are charged when their excerpts are read in the assembler.
    return {
      atoms: result.atoms,
      omitted: omittedFromSearchCandidates(result.candidates, inputs.nowMs()),
      uncertainty: [],
      usage: usageDelta({ elapsedMs: result.elapsedMs }),
    };
  }
  // Keep the planner's ring split authoritative: the structural ring should only run the
  // structural adapters, while the git-history ring should only run the repo-level history
  // adapter. Reusing the full default registry for both rings duplicates atoms and inflates
  // downstream ranking signals whenever a workspace-root query plans both rings.
  const registry: StructuralAdapterRegistry =
    ring.kind === "structural"
      ? { adapters: [testSourcePairingAdapter, importGraphAdapter] }
      : { adapters: [gitHistoryAdapter] };
  const queries =
    ring.kind === "structural" ? structuralQueriesForRing(ring, inputs) : [inputs.query];
  const results = await Promise.all(
    queries.map((query) =>
      runStructuralAdapters(registry, inputs.searchScope, query, ring.searchLimits, inputs.fs, {
        nowMs: inputs.nowMs,
      }),
    ),
  );
  const elapsedMs = results.reduce((sum, result) => sum + result.elapsedMs, 0);
  const cap = Math.min(ring.searchLimits.maxMatchesReturned, inputs.query.maxResults);
  const atoms = ring.kind === "git-history" ? [] : mergeAtomsByStableId(results, cap);
  const uncertainty = dedupeUncertainty(
    results.flatMap((result) => adapterDiagnostics(result, inputs.nowMs())),
  );
  return {
    atoms,
    omitted: [],
    uncertainty,
    usage: usageDelta({ elapsedMs }),
  };
}

interface RingRunSummary {
  readonly atoms: readonly EvidenceAtom[];
  readonly omitted: readonly OmittedContextEntry[];
  readonly governor: GovernorState;
  readonly uncertainty: readonly UncertaintyMarker[];
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
  return { atoms, omitted, governor, uncertainty };
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
  return {
    kept: [...preferred, ...lockfiles],
    omitted: nextOmitted,
  };
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
}

async function readPathExcerptWindows(
  scopePath: string,
  inputs: ExcerptInputs,
  remainingBytes: number,
): Promise<ReadPathExcerptWindowsResult> {
  const windows: ExcerptWindow[] = [];
  let bytesConsumed = 0;
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
    windows.push({ ...window, content: result.content });
    bytesConsumed += utf8ByteLength(result.content);
  }
  return { windows, bytesConsumed, omittedWindowCount: selection.omittedWindowCount };
}

async function readKeptExcerpts(
  keptPaths: readonly string[],
  inputs: ExcerptInputs,
): Promise<ExcerptReadSummary> {
  const excerpts = new Map<string, readonly ExcerptWindow[]>();
  const uncertainty: UncertaintyMarker[] = [];
  let remainingFiles = Math.max(0, inputs.budget.filesReadMax - inputs.initialUsage.filesRead);
  let remainingBytes = Math.max(
    0,
    inputs.budget.excerptBytesMax - inputs.initialUsage.excerptBytes,
  );
  for (const scopePath of keptPaths) {
    throwIfCancelled(inputs.signal);
    if (remainingFiles <= 0 || remainingBytes <= 0) {
      const dimensions = exhaustedDimensions(remainingFiles, remainingBytes);
      uncertainty.push(budgetClipped(`budget-exhausted on ${dimensions}`, inputs.nowMs()));
      break;
    }
    try {
      const result = await readPathExcerptWindows(scopePath, inputs, remainingBytes);
      const { windows } = result;
      if (windows.length > 0) {
        excerpts.set(scopePath, windows);
        if (result.omittedWindowCount > 0) {
          uncertainty.push({
            kind: "scope-incomplete",
            claim: `excerpt window limit omitted ${String(result.omittedWindowCount)} additional matching range(s) in ${scopePath}`,
            impactedAtomIds: [],
            emittedAtMs: inputs.nowMs(),
          });
        }
        remainingFiles -= 1;
        remainingBytes -= result.bytesConsumed;
      }
    } catch (error) {
      // A single unreadable file (unsupported/binary, or larger than the excerpt read cap) must
      // degrade to a skipped excerpt, never crash the whole grounded answer. Other kept files and
      // the rest of the pipeline continue; the file simply contributes no excerpt content.
      if (error instanceof RepoSearchUnsupportedFileError || error instanceof FileTooLargeError) {
        continue;
      }
      throw error;
    }
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

type AssembleOptionsForGroundedPack =
  | { readonly nowMs: () => number }
  | { readonly nowMs: () => number; readonly microIndex: MicroIndex };

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
  readonly cacheIdentity: PackCacheIdentity | undefined;
  readonly assembleOptions: AssembleOptionsForGroundedPack;
}

async function assembleEmptyGroundedPack({
  input,
  deps,
  plan,
  governor,
  nowMs,
  stopReason,
}: EmptyGroundedPackInputs): Promise<ConnectedContextPack> {
  const assembleOptions =
    deps.microIndex === undefined ? { nowMs } : { nowMs, microIndex: deps.microIndex };
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
  const ranking = rankCandidates({ atoms, anchors: plan.anchors }, { nowMs });
  const ordered = refineCandidateOrdering(
    ranking.kept,
    ranking.omitted,
    input.query.text,
    plan.anchors,
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
  cacheIdentity,
  assembleOptions,
}: FinalContextPackInputs): Promise<ConnectedContextPack> {
  const assemble = await assembleContextPack(
    {
      scope: input.scope,
      query: input.query,
      budget: plan.budget,
      atoms: prepared.atoms,
      ranked: prepared.ordered.kept,
      omittedFromRanking: [...rings.omitted, ...prepared.ordered.omitted],
      excerpts: excerptReads.excerpts,
      cacheIdentity,
      initialUsage: prepared.initialUsage,
      initialUncertainty: [
        ...rings.uncertainty,
        ...excerptReads.uncertainty,
        ...prepared.evidenceUncertainty,
      ],
    },
    assembleOptions,
  );
  return assemble.pack;
}

async function assembleGroundedPack({
  input,
  deps,
  plan,
  rings,
  searchScope,
  fs,
  nowMs,
}: AssembleGroundedPackInputs): Promise<ConnectedContextPack> {
  const prepared = preparePackAssembly(input, plan, rings, nowMs);
  const cacheIdentity =
    deps.microIndex === undefined
      ? undefined
      : fileStateCacheIdentity(prepared.keptPaths, searchScope, fs);
  const assembleOptions =
    deps.microIndex === undefined ? { nowMs } : { nowMs, microIndex: deps.microIndex };
  const cached = cachedGroundedPack({
    input,
    deps,
    plan,
    rings,
    ordered: prepared.ordered,
    cacheIdentity,
    initialUsage: prepared.initialUsage,
    assembleOptions,
  });
  if (cached !== undefined) {
    return cached;
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
  return await assemblePackFromReads({
    input,
    plan,
    rings,
    prepared,
    excerptReads,
    cacheIdentity,
    assembleOptions,
  });
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
  const rings = await runAllRings(
    plan.rings,
    { searchScope, query: input.query, anchors: plan.anchors, fs, nowMs, signal: deps.signal },
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
  const answer = normalizeGroundedAnswerPayload(await deps.answerer.answer(input.query.text, pack));
  const elapsedMs = Math.max(0, nowMs() - start);
  const exhaustedAnswerDimensions = [
    ...(answer.usage.promptTokens > pack.budget.modelInputTokensMax ? ["modelInputTokens"] : []),
    ...(answer.usage.completionTokens > pack.budget.modelOutputTokensMax
      ? ["modelOutputTokens"]
      : []),
    ...(elapsedMs > pack.budget.elapsedMsMax ? ["elapsedMs"] : []),
  ];
  const groundedPack: ConnectedContextPack = {
    ...pack,
    usage: {
      ...pack.usage,
      modelInputTokens: Math.min(answer.usage.promptTokens, pack.budget.modelInputTokensMax),
      modelOutputTokens: Math.min(answer.usage.completionTokens, pack.budget.modelOutputTokensMax),
      elapsedMs: Math.min(Math.max(pack.usage.elapsedMs, elapsedMs), pack.budget.elapsedMsMax),
    },
    uncertainty:
      exhaustedAnswerDimensions.length === 0
        ? pack.uncertainty
        : [...pack.uncertainty, answerBudgetClipped(exhaustedAnswerDimensions, nowMs())],
  };
  return { pack: groundedPack, assistantContent: answer.content, elapsedMs, plan };
}

// Re-export DEFAULT_SEARCH_LIMITS for parity with #179 callers that import limits via the
// orchestrator. Keeps `grounded-qa.ts` from needing a second workspace import path.
export { DEFAULT_SEARCH_LIMITS };
