// Public facade for the connected-context pack assembler (Epic #177, Issue #183). Bridges
// ranked candidates (#182) + already-redacted excerpt content into a ConnectedContextPack
// per the #178 contract. Pure orchestration: compaction + budget checkpointing + reranker
// seam + optional micro-index. No IO. The audit ledger (#187) owns persistence and
// `ledgerRef` is therefore always undefined here.

import {
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  type CandidateFile,
  type ConnectedContextPack,
  type ConnectedFileEntry,
  type ConnectedFileRole,
  type ContextExcerpt,
  type EvidenceAtom,
  type ExplorationBudget,
  type ExplorationUsage,
  type OmittedContextEntry,
  type RetrievalQuery,
  type SelectedScope,
  type UncertaintyMarker,
} from "@oscharko-dev/keiko-contracts/connected-context";
import { connectedContextPackStableId } from "@oscharko-dev/keiko-workspace";

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
  readonly excerpts: ReadonlyMap<string, string>;
}

export interface AssembleOptions {
  readonly maxBytesPerExcerpt?: number;
  readonly editablePaths?: ReadonlySet<string>;
  readonly reranker?: RerankerSeam;
  readonly microIndex?: MicroIndex;
  readonly nowMs?: () => number;
}

export interface AssembleResult {
  readonly pack: ConnectedContextPack;
  readonly fromIndex: boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_MAX_BYTES_PER_EXCERPT = 8 * 1024;

// ─── Internal helpers ─────────────────────────────────────────────────────────

interface ResolvedOptions {
  readonly maxBytesPerExcerpt: number;
  readonly editablePaths: ReadonlySet<string>;
  readonly reranker: RerankerSeam;
  readonly microIndex: MicroIndex | undefined;
  readonly nowMs: () => number;
}

function resolveOptions(options: AssembleOptions | undefined): ResolvedOptions {
  return {
    maxBytesPerExcerpt: options?.maxBytesPerExcerpt ?? DEFAULT_MAX_BYTES_PER_EXCERPT,
    editablePaths: options?.editablePaths ?? new Set<string>(),
    reranker: options?.reranker ?? disabledReranker,
    microIndex: options?.microIndex,
    nowMs: options?.nowMs ?? Date.now,
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

async function applyReranker(
  reranker: RerankerSeam,
  ranked: readonly CandidateFile[],
  atomsByPath: ReadonlyMap<string, readonly EvidenceAtom[]>,
): Promise<readonly CandidateFile[]> {
  const availability = await reranker.isAvailable();
  if (!availability.available) {
    return ranked;
  }
  return reranker.rerank(ranked, atomsByPath, ranked.length);
}

interface BuildPlan {
  readonly files: ConnectedFileEntry[];
  usage: ExplorationUsage;
  readonly uncertainty: UncertaintyMarker[];
  readonly extraOmitted: OmittedContextEntry[];
}

function emptyBuildPlan(): BuildPlan {
  return {
    files: [],
    usage: zeroUsage(),
    uncertainty: [],
    extraOmitted: [],
  };
}

function compactAtomsForCandidate(
  atomsForPath: readonly EvidenceAtom[],
  rawContent: string,
  maxBytesPerExcerpt: number,
): { readonly excerpts: ContextExcerpt[]; readonly totalBytes: number } {
  const excerpts: ContextExcerpt[] = [];
  let totalBytes = 0;
  for (const atom of atomsForPath) {
    const result = compactExcerpt({ atom, rawContent, maxBytes: maxBytesPerExcerpt });
    excerpts.push(result.excerpt);
    totalBytes += result.bytesConsumed;
  }
  return { excerpts, totalBytes };
}

function appendUsage(usage: ExplorationUsage, addedBytes: number): ExplorationUsage {
  return {
    ...usage,
    filesRead: usage.filesRead + 1,
    excerptBytes: usage.excerptBytes + addedBytes,
  };
}

interface ProcessContext {
  readonly atomsByPath: ReadonlyMap<string, readonly EvidenceAtom[]>;
  readonly excerpts: ReadonlyMap<string, string>;
  readonly budget: ExplorationBudget;
  readonly maxBytesPerExcerpt: number;
  readonly editablePaths: ReadonlySet<string>;
  readonly nowMs: number;
}

type ProcessOutcome = "continue" | "budget-clipped";

function recordBudgetClip(
  plan: BuildPlan,
  candidate: CandidateFile,
  atomsForPath: readonly EvidenceAtom[],
  nowMs: number,
): void {
  plan.uncertainty.push({
    kind: "budget-clipped",
    claim: `context pack truncated at ${candidate.scopePath}`,
    impactedAtomIds: atomsForPath.map((a) => a.stableId),
    emittedAtMs: nowMs,
  });
  plan.extraOmitted.push({
    scopePath: candidate.scopePath,
    reason: "budget-exhausted",
    omittedAtMs: nowMs,
  });
}

function processCandidate(
  plan: BuildPlan,
  candidate: CandidateFile,
  ctx: ProcessContext,
): ProcessOutcome {
  const rawContent = ctx.excerpts.get(candidate.scopePath);
  if (rawContent === undefined) {
    plan.uncertainty.push({
      kind: "no-evidence",
      claim: `excerpt unavailable for ${candidate.scopePath}`,
      impactedAtomIds: [],
      emittedAtMs: ctx.nowMs,
    });
    return "continue";
  }
  const atomsForPath = ctx.atomsByPath.get(candidate.scopePath) ?? [];
  if (atomsForPath.length === 0) {
    return "continue";
  }
  const { excerpts, totalBytes } = compactAtomsForCandidate(
    atomsForPath,
    rawContent,
    ctx.maxBytesPerExcerpt,
  );
  const checkpoint: BudgetCheckpoint = {
    atoms: atomsForPath,
    budget: ctx.budget,
    currentUsage: plan.usage,
  };
  if (!nextAtomFitsBudget(checkpoint, totalBytes).fits) {
    recordBudgetClip(plan, candidate, atomsForPath, ctx.nowMs);
    return "budget-clipped";
  }
  plan.files.push({
    scopePath: candidate.scopePath,
    role: resolveRole(candidate.scopePath, ctx.editablePaths),
    selectionReason: deriveSelectionReason(candidate),
    excerpts,
  });
  plan.usage = appendUsage(plan.usage, totalBytes);
  return "continue";
}

function buildPlan(ordered: readonly CandidateFile[], ctx: ProcessContext): BuildPlan {
  const plan = emptyBuildPlan();
  for (const candidate of ordered) {
    const outcome = processCandidate(plan, candidate, ctx);
    if (outcome === "budget-clipped") {
      return plan;
    }
  }
  return plan;
}

function buildStableId(
  scope: SelectedScope,
  query: RetrievalQuery,
  atoms: readonly EvidenceAtom[],
): string {
  return connectedContextPackStableId({
    scopeId: scope.scopeId,
    queryKind: query.kind,
    queryText: query.text,
    atomStableIds: atoms.map((a) => a.stableId),
  });
}

function buildPack(input: AssembleInput, plan: BuildPlan, nowMs: number): ConnectedContextPack {
  return {
    schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
    stableId: buildStableId(input.scope, input.query, input.atoms),
    scope: input.scope,
    query: input.query,
    budget: input.budget,
    usage: plan.usage,
    files: plan.files,
    omitted: [...input.omittedFromRanking, ...plan.extraOmitted],
    uncertainty: plan.uncertainty,
    emittedAtMs: nowMs,
    ledgerRef: undefined,
  };
}

// ─── Public facade ────────────────────────────────────────────────────────────

export async function assembleContextPack(
  input: AssembleInput,
  options?: AssembleOptions,
): Promise<AssembleResult> {
  const resolved = resolveOptions(options);
  const key = makeIndexKey({
    scopeId: input.scope.scopeId,
    queryKind: input.query.kind,
    queryText: input.query.text,
    atomStableIds: input.atoms.map((a) => a.stableId),
  });
  const cached = resolved.microIndex?.get(key);
  if (cached !== undefined) {
    return { pack: cached, fromIndex: true };
  }
  const atomsByPath = groupAtomsByPath(input.atoms);
  const ordered = await applyReranker(resolved.reranker, input.ranked, atomsByPath);
  const now = resolved.nowMs();
  const plan = buildPlan(ordered, {
    atomsByPath,
    excerpts: input.excerpts,
    budget: input.budget,
    maxBytesPerExcerpt: resolved.maxBytesPerExcerpt,
    editablePaths: resolved.editablePaths,
    nowMs: now,
  });
  const pack = buildPack(input, plan, now);
  resolved.microIndex?.set(key, pack);
  return { pack, fromIndex: false };
}
