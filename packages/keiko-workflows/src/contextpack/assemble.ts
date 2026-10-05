// Public facade for the connected-context pack assembler (Epic #177, Issue #183). Bridges
// ranked candidates (#182) + already-redacted excerpt content into a ConnectedContextPack
// per the #178 contract. Pure orchestration: compaction + budget checkpointing + reranker
// seam + optional micro-index. No IO. The audit ledger (#187) owns persistence and
// `ledgerRef` is therefore always undefined here.

import { createHash } from "node:crypto";

import { compareStrings } from "@oscharko-dev/keiko-contracts/runtime/comparators";
import {
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  MAX_OMITTED_CONTEXT_ENTRIES,
  connectedContextOmittedCounts,
  validateOmittedContextEntries,
  type CandidateFile,
  type ConnectedContextPack,
  type ContextPackDiagnostics,
  type ConnectedFileEntry,
  type ConnectedFileRole,
  type ContextExcerpt,
  type EvidenceAtom,
  type LineRange,
  type ExplorationBudget,
  type ExplorationUsage,
  type OmittedContextEntry,
  type RetrievalQuery,
  type SelectedScope,
  type UncertaintyMarker,
} from "@oscharko-dev/keiko-contracts/connected-context";
import { connectedContextPackStableId, evidenceAtomStableId } from "@oscharko-dev/keiko-workspace";

import { compactExcerpt, nextAtomFitsBudget, type BudgetCheckpoint } from "./compaction.js";
import { makeIndexKey, type MicroIndex } from "./microIndex.js";
import { disabledReranker, type RerankerSeam } from "./reranker.js";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface AssembleInput {
  readonly scope: SelectedScope;
  readonly query: RetrievalQuery;
  readonly budget: ExplorationBudget;
  readonly atoms: readonly EvidenceAtom[];
  readonly ranked: readonly CandidateFile[];
  readonly omittedFromRanking: readonly OmittedContextEntry[];
  readonly excerpts: ReadonlyMap<string, ExcerptSource>;
  readonly cacheIdentity?: readonly string[] | undefined;
  readonly initialUsage?: ExplorationUsage;
  readonly initialUncertainty?: readonly UncertaintyMarker[];
  // Optional explainable-ranking diagnostics (M2) carried verbatim onto the produced pack.
  readonly diagnostics?: ContextPackDiagnostics | undefined;
}

export interface ExcerptWindow {
  // Partial views can share source lines; this opaque identity keeps disjoint views separate.
  readonly identity?: string | undefined;
  readonly startLine: number;
  readonly endLine: number;
  readonly content: string;
}

export type ExcerptSource = string | ExcerptWindow | readonly ExcerptWindow[];

export interface AssembleOptions {
  readonly maxBytesPerExcerptByPath?: ReadonlyMap<string, number>;
  readonly maxBytesPerExcerpt?: number;
  readonly includeSurroundingContext?: boolean;
  readonly editablePaths?: ReadonlySet<string>;
  readonly reranker?: RerankerSeam;
  readonly microIndex?: MicroIndex;
  readonly nowMs?: () => number;
}

export class ContextPackValidationError extends TypeError {
  readonly code = "CONTEXT_PACK_OMISSIONS_INVALID";

  constructor(
    readonly violationCount: number,
    readonly validationReasons: readonly string[] = [],
  ) {
    super(`Context pack omitted entries invalid (${String(violationCount)} violations).`);
    this.name = "ContextPackValidationError";
  }
}

export interface AssembleResult {
  readonly pack: ConnectedContextPack;
  readonly fromIndex: boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_MAX_BYTES_PER_EXCERPT = 8 * 1024;

// ─── Internal helpers ─────────────────────────────────────────────────────────

interface ResolvedOptions {
  readonly maxBytesPerExcerptByPath: ReadonlyMap<string, number>;
  readonly includeSurroundingContext: boolean;
  readonly maxBytesPerExcerpt: number;
  readonly editablePaths: ReadonlySet<string>;
  readonly reranker: RerankerSeam;
  readonly microIndex: MicroIndex | undefined;
  readonly nowMs: () => number;
}

function resolveOptions(options: AssembleOptions | undefined): ResolvedOptions {
  const supplied = options ?? {};
  return {
    maxBytesPerExcerptByPath: supplied.maxBytesPerExcerptByPath ?? new Map(),
    includeSurroundingContext: supplied.includeSurroundingContext ?? false,
    maxBytesPerExcerpt: supplied.maxBytesPerExcerpt ?? DEFAULT_MAX_BYTES_PER_EXCERPT,
    editablePaths: supplied.editablePaths ?? new Set<string>(),
    reranker: supplied.reranker ?? disabledReranker,
    microIndex: supplied.microIndex,
    nowMs: supplied.nowMs ?? Date.now,
  };
}

function zeroUsage(): ExplorationUsage {
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

function groupAtomsByPath(
  atoms: readonly EvidenceAtom[],
): ReadonlyMap<string, readonly EvidenceAtom[]> {
  const map = new Map<string, EvidenceAtom[]>();
  for (const atom of atoms) {
    const existing = map.get(atom.scopePath);
    if (existing === undefined) {
      map.set(atom.scopePath, [atom]);
    } else {
      existing.push(atom);
    }
  }
  return map;
}

function deriveSelectionReason(candidate: CandidateFile): string {
  const first = candidate.signals[0];
  if (first === undefined) {
    return "ranked candidate";
  }
  return `ranked by ${first.name}`;
}

function resolveRole(scopePath: string, editablePaths: ReadonlySet<string>): ConnectedFileRole {
  return editablePaths.has(scopePath) ? "editable" : "read-only";
}

interface RerankerOutcome {
  readonly ordered: readonly CandidateFile[];
  readonly reranked: boolean;
}

async function applyReranker(
  reranker: RerankerSeam,
  ranked: readonly CandidateFile[],
  atomsByPath: ReadonlyMap<string, readonly EvidenceAtom[]>,
  budget: ExplorationBudget,
  usage: ExplorationUsage,
): Promise<RerankerOutcome> {
  // The seam is only invoked when the budget actually allows rerank calls. This keeps
  // ExplorationBudget.rerankCallsMax authoritative even when a custom reranker is supplied
  // and avoids billing a rerank call against a run whose budget set rerankCallsMax=0.
  if (usage.rerankCalls >= budget.rerankCallsMax) {
    return { ordered: ranked, reranked: false };
  }
  const availability = await reranker.isAvailable();
  if (!availability.available) {
    return { ordered: ranked, reranked: false };
  }
  const reordered = await reranker.rerank(ranked, atomsByPath, ranked.length);
  return { ordered: reordered, reranked: true };
}

interface BuildPlan {
  readonly files: ConnectedFileEntry[];
  usage: ExplorationUsage;
  readonly uncertainty: UncertaintyMarker[];
  readonly extraOmitted: OmittedContextEntry[];
  unavailableExcerpts: number;
  unavailableRanges: number;
  truncatedExcerpts: number;
  incompatibleWindows: number;
}

function cloneUsage(usage: ExplorationUsage | undefined): ExplorationUsage {
  if (usage === undefined) {
    return zeroUsage();
  }
  return { ...usage };
}

function emptyBuildPlan(
  initialUsage: ExplorationUsage | undefined,
  initialUncertainty: readonly UncertaintyMarker[] | undefined,
): BuildPlan {
  return {
    files: [],
    usage: cloneUsage(initialUsage),
    uncertainty: [...(initialUncertainty ?? [])],
    extraOmitted: [],
    unavailableExcerpts: 0,
    unavailableRanges: 0,
    truncatedExcerpts: 0,
    incompatibleWindows: 0,
  };
}

function compactAtomsForCandidate(
  atomsForPath: readonly EvidenceAtom[],
  source: ExcerptSource,
  maxBytesPerExcerpt: number,
  context: { readonly includeSurroundingContext: boolean; readonly scopeId: string },
): {
  readonly excerpts: ContextExcerpt[];
  readonly totalBytes: number;
  readonly truncatedExcerpts: number;
  readonly incompatibleWindows: number;
} {
  const excerpts: ContextExcerpt[] = [];
  let totalBytes = 0;
  let truncatedExcerpts = 0;
  if (context.includeSurroundingContext) {
    return compactIdentifiedContextWindows(
      atomsForPath,
      source,
      maxBytesPerExcerpt,
      context.scopeId,
    );
  }
  for (const atom of atomsForPath) {
    const rawContent = contentForAtom(atom, source);
    if (rawContent === undefined) {
      continue;
    }
    const result = compactExcerpt({ atom, rawContent, maxBytes: maxBytesPerExcerpt });
    excerpts.push(result.excerpt);
    totalBytes += result.bytesConsumed;
    truncatedExcerpts += Number(result.truncated);
  }
  return { excerpts, totalBytes, truncatedExcerpts, incompatibleWindows: 0 };
}

function contextWindowsForAtom(
  source: readonly ExcerptWindow[],
  atom: EvidenceAtom,
): readonly ExcerptWindow[] {
  const matching = source.filter((window) => coversAtom(window, atom));
  if (matching.length > 0) {
    const legacy = matching.find((window) => window.identity === undefined);
    return matching.filter((window) => window.identity !== undefined || window === legacy);
  }
  // A single shortened read can still provide useful evidence for part of a broad range.
  // Multiple uncovered windows must not fabricate continuity across a gap or conflicting read.
  if (source.length !== 1) return [];
  const window = source[0];
  const range = atom.lineRange;
  return window !== undefined &&
    range !== undefined &&
    window.startLine <= range.endLine &&
    window.endLine >= range.startLine
    ? [window]
    : [];
}

interface CompactedContextWindows {
  readonly excerpts: ContextExcerpt[];
  readonly seen: Set<string>;
  readonly bodies: Map<string, ContextExcerpt>;
  truncatedExcerpts: number;
}

function appendCompactContextWindow(
  state: CompactedContextWindows,
  atom: EvidenceAtom,
  window: ExcerptWindow,
  maxBytes: number,
  scopeId: string,
): void {
  const bodyIdentity = JSON.stringify([window.startLine, window.endLine, window.identity]);
  const identity = JSON.stringify([bodyIdentity, atom.edge]);
  if (state.seen.has(identity)) return;
  state.seen.add(identity);
  const shared = state.bodies.get(bodyIdentity);
  const excerpt =
    shared === undefined
      ? compactContextWindow(atom, window, maxBytes, scopeId)
      : metadataForSharedWindow(atom, window, shared, scopeId);
  if (shared === undefined && excerpt.contentBytes === 0) return;
  if (shared === undefined) {
    state.truncatedExcerpts += Number(Buffer.byteLength(window.content) > excerpt.contentBytes);
    state.bodies.set(bodyIdentity, excerpt);
  }
  state.excerpts.push(excerpt);
}

function compactIdentifiedContextWindows(
  atoms: readonly EvidenceAtom[],
  source: ExcerptSource,
  maxBytes: number,
  scopeId: string,
): {
  readonly excerpts: ContextExcerpt[];
  readonly totalBytes: number;
  readonly truncatedExcerpts: number;
  readonly incompatibleWindows: number;
} {
  const state: CompactedContextWindows = {
    excerpts: [],
    seen: new Set(),
    bodies: new Map(),
    truncatedExcerpts: 0,
  };
  const merged = mergeContextWindows(normalizeExcerptWindows(source));
  const windows = merged.windows;
  // Prompt admission ranks the excerpt carrying the bytes; metadata-only siblings cannot lend
  // it their score later. Preserve every edge, but assign each shared body to its strongest atom.
  const rankedAtoms = [...atoms].sort((left, right) => right.score - left.score);
  for (const atom of rankedAtoms) {
    for (const window of contextWindowsForAtom(windows, atom)) {
      appendCompactContextWindow(state, atom, window, maxBytes, scopeId);
    }
  }
  return {
    excerpts: state.excerpts,
    totalBytes: state.excerpts.reduce((sum, excerpt) => sum + excerpt.contentBytes, 0),
    truncatedExcerpts: state.truncatedExcerpts,
    incompatibleWindows: merged.incompatibleWindows,
  };
}

function compactContextWindow(
  atom: EvidenceAtom,
  window: ExcerptWindow,
  maxBytes: number,
  scopeId: string,
): ContextExcerpt {
  const result = compactExcerpt({ atom, rawContent: window.content, maxBytes });
  const lineRange = {
    startLine: window.startLine,
    endLine: Math.min(
      window.endLine,
      window.startLine +
        Math.max(0, compactedLineCount(result.excerpt.content, result.truncated) - 1),
    ),
  };
  return { ...result.excerpt, atom: contextWindowAtom(atom, window, lineRange, scopeId) };
}

function metadataForSharedWindow(
  atom: EvidenceAtom,
  window: ExcerptWindow,
  shared: ContextExcerpt,
  scopeId: string,
): ContextExcerpt {
  const range = shared.atom.lineRange ?? { startLine: window.startLine, endLine: window.endLine };
  return { content: "", contentBytes: 0, atom: contextWindowAtom(atom, window, range, scopeId) };
}

function contextWindowAtom(
  atom: EvidenceAtom,
  window: ExcerptWindow,
  lineRange: LineRange,
  scopeId: string,
): EvidenceAtom {
  const queryFingerprint =
    window.identity === undefined
      ? atom.provenance.queryFingerprint
      : sha256Hex(JSON.stringify([atom.provenance.queryFingerprint, window.identity]));
  return {
    ...atom,
    lineRange,
    provenance: { ...atom.provenance, queryFingerprint },
    stableId: evidenceAtomStableId({
      scopeId,
      scopePath: atom.scopePath,
      lineRange,
      provenanceKind: atom.provenance.kind,
      provenanceTool: atom.provenance.tool,
      queryFingerprint,
      edge: atom.edge,
    }),
  };
}

function lineCount(content: string): number {
  if (content.length === 0) {
    return 0;
  }
  return content.split("\n").length;
}

function compactedLineCount(content: string, truncated: boolean): number {
  return lineCount(content) - Number(truncated && content.endsWith("\n"));
}

function mergeContextWindow(left: ExcerptWindow, right: ExcerptWindow): ExcerptWindow | undefined {
  if (right.startLine > left.endLine + 1) return undefined;
  const overlap = Math.min(left.endLine, right.endLine) - right.startLine + 1;
  // Different partial-view identities require actual overlap to prove compatibility.
  if (overlap === 0 && left.identity !== right.identity) return undefined;
  const leftLines = left.content.split("\n");
  const rightLines = right.content.split("\n");
  for (let index = 0; index < overlap; index += 1) {
    if (leftLines[right.startLine - left.startLine + index] !== rightLines[index]) return undefined;
  }
  const identity =
    left.identity === right.identity
      ? left.identity
      : sha256Hex(JSON.stringify([left.identity, right.identity, left.startLine, right.endLine]));
  return {
    ...(identity === undefined ? {} : { identity }),
    startLine: left.startLine,
    endLine: Math.max(left.endLine, right.endLine),
    content: [...leftLines, ...rightLines.slice(overlap)].join("\n"),
  };
}

interface MergedContextWindows {
  readonly windows: ExcerptWindow[];
  incompatibleWindows: number;
  maxEndLine: number;
}

function appendOpenContextWindow(state: MergedContextWindows, window: ExcerptWindow): void {
  const previousMaxEnd = state.maxEndLine;
  state.maxEndLine = Math.max(previousMaxEnd, window.endLine);
  if (previousMaxEnd + 1 < window.startLine) {
    state.windows.push(window);
    return;
  }
  for (let index = state.windows.length - 1; index >= 0; index -= 1) {
    const previous = state.windows[index];
    if (previous === undefined || previous.endLine + 1 < window.startLine) continue;
    const combined = mergeContextWindow(previous, window);
    if (combined === undefined) {
      if (previous.endLine >= window.startLine) state.incompatibleWindows += 1;
      continue;
    }
    state.windows[index] = combined;
    return;
  }
  state.windows.push(window);
}

function mergeContextWindows(windows: readonly ExcerptWindow[]): MergedContextWindows {
  const ordered = [...windows].sort(
    (left, right) => left.startLine - right.startLine || left.endLine - right.endLine,
  );
  const state: MergedContextWindows = { windows: [], incompatibleWindows: 0, maxEndLine: 0 };
  for (const window of ordered) appendOpenContextWindow(state, window);
  return state;
}

function isExcerptWindowArray(source: ExcerptSource): source is readonly ExcerptWindow[] {
  return Array.isArray(source);
}

function normalizeExcerptWindows(source: ExcerptSource): readonly ExcerptWindow[] {
  if (typeof source === "string") {
    return [{ startLine: 1, endLine: lineCount(source), content: source }];
  }
  if (isExcerptWindowArray(source)) {
    return source;
  }
  return [source];
}

function coversAtom(window: ExcerptWindow, atom: EvidenceAtom): boolean {
  const range = atom.lineRange;
  return (
    range === undefined || (window.startLine <= range.startLine && window.endLine >= range.endLine)
  );
}

function sliceWindowForAtom(window: ExcerptWindow, atom: EvidenceAtom): string {
  const range = atom.lineRange;
  if (range === undefined) {
    return window.content;
  }
  const lines = window.content.split("\n");
  const startIndex = Math.max(0, range.startLine - window.startLine);
  const endIndex = Math.min(lines.length, range.endLine - window.startLine + 1);
  if (startIndex >= endIndex) {
    return "";
  }
  return lines.slice(startIndex, endIndex).join("\n");
}

function contentForAtom(atom: EvidenceAtom, source: ExcerptSource): string | undefined {
  const windows = normalizeExcerptWindows(source);
  const selected = windows.find((window) => coversAtom(window, atom));
  if (selected === undefined) {
    return undefined;
  }
  return sliceWindowForAtom(selected, atom);
}

function appendUsage(usage: ExplorationUsage, addedBytes: number): ExplorationUsage {
  return {
    ...usage,
    filesRead: usage.filesRead + 1,
    excerptBytes: usage.excerptBytes + addedBytes,
  };
}

interface ProcessContext {
  readonly maxBytesPerExcerptByPath: ReadonlyMap<string, number>;
  readonly includeSurroundingContext: boolean;
  readonly scopeId: string;
  readonly atomsByPath: ReadonlyMap<string, readonly EvidenceAtom[]>;
  readonly excerpts: ReadonlyMap<string, ExcerptSource>;
  readonly budget: ExplorationBudget;
  readonly maxBytesPerExcerpt: number;
  readonly editablePaths: ReadonlySet<string>;
  readonly nowMs: number;
}

type ProcessOutcome = "continue" | "budget-clipped" | "excerpt-unavailable";

function recordBudgetClip(plan: BuildPlan, candidate: CandidateFile, nowMs: number): void {
  plan.uncertainty.push({
    kind: "budget-clipped",
    claim: `context pack truncated at ${candidate.scopePath}`,
    // The clipped candidate is omitted from pack.files, so its atoms are not valid
    // uncertainty references under the connected-context contract.
    impactedAtomIds: [],
    emittedAtMs: nowMs,
  });
  plan.extraOmitted.push({
    scopePath: candidate.scopePath,
    reason: "budget-exhausted",
    omittedAtMs: nowMs,
  });
}

function recordUnavailableExcerpt(
  plan: BuildPlan,
  candidate: CandidateFile,
  nowMs: number,
): ProcessOutcome {
  plan.extraOmitted.push({
    scopePath: candidate.scopePath,
    reason: "tool-unavailable",
    omittedAtMs: nowMs,
  });
  plan.unavailableExcerpts += 1;
  return "excerpt-unavailable";
}

function recordPreMarkedOmission(
  plan: BuildPlan,
  candidate: CandidateFile,
  nowMs: number,
): boolean {
  if (candidate.omitted === undefined) {
    return false;
  }
  plan.extraOmitted.push({
    scopePath: candidate.scopePath,
    reason: candidate.omitted,
    omittedAtMs: nowMs,
  });
  return true;
}

function appendAssembledCandidate(
  plan: BuildPlan,
  candidate: CandidateFile,
  ctx: ProcessContext,
  excerpts: readonly ContextExcerpt[],
  totalBytes: number,
): void {
  plan.files.push({
    scopePath: candidate.scopePath,
    role: resolveRole(candidate.scopePath, ctx.editablePaths),
    selectionReason: deriveSelectionReason(candidate),
    excerpts,
  });
  plan.usage = appendUsage(plan.usage, totalBytes);
}

function recordUnavailableAtomRanges(
  plan: BuildPlan,
  atoms: readonly EvidenceAtom[],
  excerpts: readonly ContextExcerpt[],
): void {
  const windows = excerpts
    .filter((excerpt) => excerpt.contentBytes > 0)
    .map((excerpt) => ({
      startLine: excerpt.atom.lineRange?.startLine ?? 1,
      endLine: excerpt.atom.lineRange?.endLine ?? lineCount(excerpt.content),
      content: excerpt.content,
    }));
  plan.unavailableRanges += atoms.filter(
    (atom) => !windows.some((window) => coversAtom(window, atom)),
  ).length;
}

function candidateExcerptByteLimit(candidate: CandidateFile, ctx: ProcessContext): number {
  const qualified = ctx.maxBytesPerExcerptByPath.get(candidate.scopePath);
  return qualified === undefined
    ? ctx.maxBytesPerExcerpt
    : Math.min(qualified, ctx.budget.excerptBytesMax);
}

function processCandidate(
  plan: BuildPlan,
  candidate: CandidateFile,
  ctx: ProcessContext,
): ProcessOutcome {
  // Respect a pre-set omission reason from the ranker (e.g. "generated", "ignored").
  // The candidate's atoms may still exist in input.atoms (the ranker only drops them from
  // its kept list), but they must not enter pack.files — that would contradict the
  // omission semantics of CandidateFile.omitted.
  if (recordPreMarkedOmission(plan, candidate, ctx.nowMs)) {
    return "continue";
  }
  const excerptSource = ctx.excerpts.get(candidate.scopePath);
  if (excerptSource === undefined) {
    return recordUnavailableExcerpt(plan, candidate, ctx.nowMs);
  }
  const atomsForPath = ctx.atomsByPath.get(candidate.scopePath) ?? [];
  if (atomsForPath.length === 0) {
    return "continue";
  }
  const { excerpts, totalBytes, truncatedExcerpts, incompatibleWindows } = compactAtomsForCandidate(
    atomsForPath,
    excerptSource,
    candidateExcerptByteLimit(candidate, ctx),
    ctx,
  );
  if (excerpts.length === 0) {
    return recordUnavailableExcerpt(plan, candidate, ctx.nowMs);
  }
  const checkpoint: BudgetCheckpoint = {
    atoms: atomsForPath,
    budget: ctx.budget,
    currentUsage: plan.usage,
  };
  if (!nextAtomFitsBudget(checkpoint, totalBytes).fits) {
    recordBudgetClip(plan, candidate, ctx.nowMs);
    return "budget-clipped";
  }
  plan.truncatedExcerpts += truncatedExcerpts;
  plan.incompatibleWindows += incompatibleWindows;
  recordUnavailableAtomRanges(plan, atomsForPath, excerpts);
  appendAssembledCandidate(plan, candidate, ctx, excerpts, totalBytes);
  return "continue";
}

function recordRemainingBudgetOmissions(
  plan: BuildPlan,
  remaining: readonly CandidateFile[],
  nowMs: number,
): void {
  for (const candidate of remaining) {
    plan.extraOmitted.push({
      scopePath: candidate.scopePath,
      reason: candidate.omitted ?? "budget-exhausted",
      omittedAtMs: nowMs,
    });
  }
}

function appendUnavailableSummary(plan: BuildPlan, nowMs: number): void {
  if (
    plan.unavailableExcerpts === 0 &&
    plan.unavailableRanges === 0 &&
    plan.truncatedExcerpts === 0 &&
    plan.incompatibleWindows === 0
  )
    return;
  plan.uncertainty.push({
    kind: "scope-incomplete",
    claim: `${String(plan.unavailableExcerpts)} candidate excerpts unavailable and ${String(plan.unavailableRanges)} cited ranges unavailable and ${String(plan.truncatedExcerpts)} excerpts truncated and ${String(plan.incompatibleWindows)} conflicting source window comparisons during context assembly`,
    impactedAtomIds: [],
    emittedAtMs: nowMs,
  });
}

function buildPlan(
  ordered: readonly CandidateFile[],
  ctx: ProcessContext,
  initialUsage: ExplorationUsage | undefined,
  initialUncertainty: readonly UncertaintyMarker[] | undefined,
): BuildPlan {
  const plan = emptyBuildPlan(initialUsage, initialUncertainty);
  for (const [index, candidate] of ordered.entries()) {
    const outcome = processCandidate(plan, candidate, ctx);
    if (outcome === "budget-clipped") {
      recordRemainingBudgetOmissions(plan, ordered.slice(index + 1), ctx.nowMs);
      break;
    }
  }
  appendUnavailableSummary(plan, ctx.nowMs);
  if (
    plan.files.length === 0 &&
    plan.unavailableExcerpts > 0 &&
    !plan.uncertainty.some((marker) => marker.kind === "no-evidence")
  ) {
    plan.uncertainty.push({
      kind: "no-evidence",
      claim: "no candidate excerpt supplied usable evidence",
      impactedAtomIds: [],
      emittedAtMs: ctx.nowMs,
    });
  }
  return plan;
}

function cacheConnectedExcerpt(excerpt: ContextExcerpt): object {
  return {
    atom: cacheAtom(excerpt.atom),
    contentHash: sha256Hex(excerpt.content),
    contentBytes: excerpt.contentBytes,
  };
}

function cacheConnectedFile(file: ConnectedFileEntry): object {
  return {
    scopePath: file.scopePath,
    role: file.role,
    selectionReason: file.selectionReason,
    excerpts: file.excerpts.map(cacheConnectedExcerpt),
  };
}

function compareOmissions(left: OmittedContextEntry, right: OmittedContextEntry): number {
  return (
    omissionDetailPriority(left) - omissionDetailPriority(right) ||
    compareStrings(left.scopePath, right.scopePath) ||
    compareStrings(left.reason, right.reason)
  );
}

function mergeOmittedEntries(
  ranked: readonly OmittedContextEntry[],
  assembled: readonly OmittedContextEntry[],
  selectedPaths: ReadonlySet<string> = new Set(),
): readonly OmittedContextEntry[] {
  const byPath = new Map<string, OmittedContextEntry>();
  for (const entry of [...ranked].sort(compareOmissions)) {
    if (selectedPaths.has(entry.scopePath) || byPath.has(entry.scopePath)) continue;
    byPath.set(entry.scopePath, entry);
  }
  for (const entry of assembled) {
    if (selectedPaths.has(entry.scopePath)) continue;
    const existing = byPath.get(entry.scopePath);
    if (existing !== undefined && entry.reason === "tool-unavailable") continue;
    byPath.set(entry.scopePath, entry);
  }
  return [...byPath.values()].sort(compareOmissions);
}

function buildStableId(
  input: AssembleInput,
  plan: BuildPlan,
  omitted: readonly OmittedContextEntry[],
): string {
  const fingerprint = sha256Hex(
    JSON.stringify({
      scope: cacheScope(input.scope),
      query: cacheQuery(input.query),
      files: plan.files.map(cacheConnectedFile),
      omitted: omitted.map(cacheOmitted),
      uncertainty: plan.uncertainty.map(cacheUncertainty),
    }),
  );
  return connectedContextPackStableId({
    scopeId: input.scope.scopeId,
    queryKind: input.query.kind,
    queryText: input.query.text,
    atomStableIds: [`pack-fp-${fingerprint}`],
  });
}

function omissionDetailPriority(entry: OmittedContextEntry): number {
  if (entry.reason === "size-exceeded") return 0;
  return entry.reason === "budget-exhausted" ? 2 : 1;
}

function retainedOmissionDetails(
  omitted: readonly OmittedContextEntry[],
): readonly OmittedContextEntry[] {
  if (omitted.length <= MAX_OMITTED_CONTEXT_ENTRIES) return omitted;
  // Prefer eligibility metadata used to explain excluded files over budget-only detail.
  const retained: OmittedContextEntry[] = [];
  for (const priority of [0, 1, 2]) {
    for (const entry of omitted) {
      if (omissionDetailPriority(entry) !== priority) continue;
      retained.push(entry);
      if (retained.length === MAX_OMITTED_CONTEXT_ENTRIES) return retained;
    }
  }
  return retained;
}

function buildPack(input: AssembleInput, plan: BuildPlan, nowMs: number): ConnectedContextPack {
  const omitted = mergeOmittedEntries(
    input.omittedFromRanking,
    plan.extraOmitted,
    new Set(plan.files.map((file) => file.scopePath)),
  );
  const validation = validateOmittedContextEntries(
    omitted,
    input.scope,
    plan.files.map((file) => file.scopePath),
  );
  if (!validation.ok)
    throw new ContextPackValidationError(validation.reasons.length, validation.reasons);
  return {
    schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
    stableId: buildStableId(input, plan, omitted),
    scope: input.scope,
    query: input.query,
    budget: input.budget,
    usage: plan.usage,
    files: plan.files,
    omitted: retainedOmissionDetails(omitted),
    ...(omitted.length > MAX_OMITTED_CONTEXT_ENTRIES
      ? { omittedCounts: connectedContextOmittedCounts({ omitted }) }
      : {}),
    uncertainty: plan.uncertainty,
    emittedAtMs: nowMs,
    ledgerRef: undefined,
    ...(input.diagnostics !== undefined ? { diagnostics: input.diagnostics } : {}),
  };
}

// ─── Public facade ────────────────────────────────────────────────────────────

// Cache-key contributors that change the produced pack. Two runs with the same atoms but
// different budgets, per-excerpt caps, editable-file sets, or reranker MUST hash to
// different keys — otherwise we could serve a cached pack that violates the new budget or
// carries the wrong file roles/order.
function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function cacheLineRange(range: EvidenceAtom["lineRange"]): object | undefined {
  if (range === undefined) {
    return undefined;
  }
  return { startLine: range.startLine, endLine: range.endLine };
}

function cacheScope(scope: SelectedScope): object {
  return {
    schemaVersion: scope.schemaVersion,
    scopeId: scope.scopeId,
    workspaceRoot: scope.workspaceRoot,
    kind: scope.kind,
    relativePaths: scope.relativePaths,
    conversationId: scope.conversationId,
    connectedAtMs: scope.connectedAtMs,
    explicitConnection: scope.explicitConnection,
  };
}

function cacheQuery(query: RetrievalQuery): object {
  return {
    kind: query.kind,
    text: query.text,
    caseSensitive: query.caseSensitive,
    maxResults: query.maxResults,
  };
}

function cacheAtom(atom: EvidenceAtom): object {
  return {
    stableId: atom.stableId,
    scopePath: atom.scopePath,
    lineRange: cacheLineRange(atom.lineRange),
    score: atom.score,
    provenance: atom.provenance,
    redactionState: atom.redactionState,
    ledgerRef: atom.ledgerRef,
  };
}

function cacheUsage(usage: ExplorationUsage | undefined): object | undefined {
  if (usage === undefined) {
    return undefined;
  }
  return {
    searchCalls: usage.searchCalls,
    filesRead: usage.filesRead,
    excerptBytes: usage.excerptBytes,
    modelInputTokens: usage.modelInputTokens,
    modelOutputTokens: usage.modelOutputTokens,
    rerankCalls: usage.rerankCalls,
  };
}

function cacheUncertainty(marker: UncertaintyMarker): object {
  return {
    kind: marker.kind,
    claim: marker.claim,
    impactedAtomIds: marker.impactedAtomIds,
  };
}

function cacheCandidate(candidate: CandidateFile): object {
  return {
    scopePath: candidate.scopePath,
    score: candidate.score,
    signals: candidate.signals.map((signal) => ({ name: signal.name, value: signal.value })),
    omitted: candidate.omitted,
  };
}

function cacheOmitted(entry: OmittedContextEntry): object {
  return {
    scopePath: entry.scopePath,
    reason: entry.reason,
  };
}

// Diagnostics are carried verbatim onto the pack, so two runs that differ ONLY in ranking
// explanation must not collide on a cached pack. Returns undefined when absent (serializes away,
// keeping legacy cache keys byte-identical).
function cacheDiagnostics(diagnostics: ContextPackDiagnostics | undefined): object | undefined {
  if (diagnostics === undefined) {
    return undefined;
  }
  return {
    rankedCandidates: diagnostics.rankedCandidates.map((entry) => ({
      scopePath: entry.scopePath,
      bucket: entry.bucket,
      score: entry.score,
      ecosystem: entry.ecosystem,
      signals: entry.signals.map((signal) => ({ name: signal.name, value: signal.value })),
    })),
  };
}

function cacheExcerptWindow(window: ExcerptWindow): object {
  return {
    startLine: window.startLine,
    endLine: window.endLine,
    contentHash: sha256Hex(window.content),
    ...(window.identity === undefined ? {} : { identity: window.identity }),
  };
}

function cacheExcerpts(excerpts: ReadonlyMap<string, ExcerptSource>): readonly object[] {
  return [...excerpts.entries()]
    .sort(([a], [b]) => compareStrings(a, b))
    .map(([scopePath, source]) => ({
      scopePath,
      windows: normalizeExcerptWindows(source).map(cacheExcerptWindow),
    }));
}

function cacheExcerptIdentity(input: AssembleInput): readonly object[] | readonly string[] {
  if (input.cacheIdentity !== undefined) {
    return [...input.cacheIdentity].sort((left, right) => compareStrings(left, right));
  }
  return cacheExcerpts(input.excerpts);
}

// Compile-time exhaustiveness guard (KEIKO-0998): every AssembleInput key must be listed below,
// mapped to a short note on how buildCacheAtomIds' fingerprint covers it (directly as a same-named
// fingerprint key, or indirectly — cacheIdentity and excerpts both feed cacheExcerptIdentity).
// Current uncertainty contributes independently of the supplied file-state identity. `satisfies
// Record<keyof AssembleInput, string>` makes TypeScript reject this object if AssembleInput gains,
// loses, or renames a field without a matching update here, instead of relying solely on
// docs/context-engineering/decision-log.md's "Critical gotchas" note and code review to catch the
// omission. Exported so the guard is a real module reference (no compiler "unused" concern) and
// so tests can pin the field-coverage documentation without duplicating it.
export const ASSEMBLE_INPUT_CACHE_FIELD_COVERAGE = {
  scope: "fingerprint key `scope` (via cacheScope)",
  query: "fingerprint key `query` (via cacheQuery)",
  budget: "fingerprint key `budget`",
  atoms: "fingerprint key `atoms` (via cacheAtom)",
  ranked: "fingerprint key `ranked` (via cacheCandidate)",
  omittedFromRanking: "fingerprint key `omittedFromRanking` (via cacheOmitted)",
  excerpts: "fingerprint key `excerpts` (via cacheExcerptIdentity)",
  cacheIdentity: "folded into `excerpts` via cacheExcerptIdentity",
  initialUsage: "fingerprint key `initialUsage` (via cacheUsage)",
  initialUncertainty: "fingerprint key `initialUncertainty` (via cacheUncertainty)",
  diagnostics: "fingerprint key `diagnostics` (via cacheDiagnostics)",
} as const satisfies Record<keyof AssembleInput, string>;

function buildCacheAtomIds(input: AssembleInput, resolved: ResolvedOptions): readonly string[] {
  const fingerprintSource = JSON.stringify({
    scope: cacheScope(input.scope),
    query: cacheQuery(input.query),
    atoms: input.atoms.map(cacheAtom),
    budget: input.budget,
    initialUsage: cacheUsage(input.initialUsage),
    initialUncertainty: input.initialUncertainty?.map(cacheUncertainty),
    ranked: input.ranked.map(cacheCandidate),
    omittedFromRanking: mergeOmittedEntries(input.omittedFromRanking, []).map(cacheOmitted),
    diagnostics: cacheDiagnostics(input.diagnostics),
    excerpts: cacheExcerptIdentity(input),
    maxBytesPerExcerpt: resolved.maxBytesPerExcerpt,
    maxBytesPerExcerptByPath: [...resolved.maxBytesPerExcerptByPath].sort(([left], [right]) =>
      compareStrings(left, right),
    ),
    includeSurroundingContext: resolved.includeSurroundingContext,
    editablePaths: [...resolved.editablePaths].sort((left, right) => compareStrings(left, right)),
    rerankerName: resolved.reranker.name,
  });
  return [`fp-${sha256Hex(fingerprintSource)}`];
}

export function contextPackIndexKey(input: AssembleInput, options?: AssembleOptions): string {
  const resolved = resolveOptions(options);
  return makeIndexKey({
    scopeId: input.scope.scopeId,
    queryKind: input.query.kind,
    queryText: input.query.text,
    atomStableIds: buildCacheAtomIds(input, resolved),
  });
}

export async function assembleContextPack(
  input: AssembleInput,
  options?: AssembleOptions,
): Promise<AssembleResult> {
  const resolved = resolveOptions(options);
  const key = resolved.microIndex === undefined ? undefined : contextPackIndexKey(input, options);
  const cached = key === undefined ? undefined : resolved.microIndex?.get(key);
  if (cached !== undefined) {
    return { pack: cached, fromIndex: true };
  }
  const atomsByPath = groupAtomsByPath(input.atoms);
  const initialUsage = cloneUsage(input.initialUsage);
  const rerankerOutcome = await applyReranker(
    resolved.reranker,
    input.ranked,
    atomsByPath,
    input.budget,
    initialUsage,
  );
  const now = resolved.nowMs();
  const plan = buildPlan(
    rerankerOutcome.ordered,
    {
      atomsByPath,
      includeSurroundingContext: resolved.includeSurroundingContext,
      scopeId: input.scope.scopeId,
      excerpts: input.excerpts,
      budget: input.budget,
      maxBytesPerExcerpt: resolved.maxBytesPerExcerpt,
      maxBytesPerExcerptByPath: resolved.maxBytesPerExcerptByPath,
      editablePaths: resolved.editablePaths,
      nowMs: now,
    },
    initialUsage,
    input.initialUncertainty,
  );
  if (rerankerOutcome.reranked) {
    plan.usage = { ...plan.usage, rerankCalls: plan.usage.rerankCalls + 1 };
  }
  const pack = buildPack(input, plan, now);
  if (key !== undefined) resolved.microIndex?.set(key, pack);
  return { pack, fromIndex: false };
}
