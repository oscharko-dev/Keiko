// Public facade for candidate ranking and negative-context filtering (Epic #177, Issue #182).
// Pure composition of signals → scoring → filter. Validates scopePath via the contracts'
// isValidScopePath (defense-in-depth) and accounts every CANDIDATE_OMISSION_REASONS key in
// the returned diagnostics so UI/audit consumers can render zeros without conditionals.

import {
  CANDIDATE_OMISSION_REASONS,
  isValidScopePath,
  type CandidateFile,
  type CandidateOmissionReason,
  type EvidenceAtom,
  type OmittedContextEntry,
} from "@oscharko-dev/keiko-contracts/connected-context";

import {
  DEFAULT_FILTER_OPTIONS,
  filterCandidates,
  type AnnotatedCandidate,
  type FilterOptions,
  type FilterResult,
} from "./filter.js";
import { DEFAULT_SCORING_WEIGHTS, computeScore, type ScoringWeights } from "./scoring.js";
import {
  DEFAULT_GENERATED_PATTERNS,
  extractSignals,
  type RankingHints,
  type RankingInput,
} from "./signals.js";

export interface RankingOptions {
  readonly weights?: ScoringWeights;
  readonly filter?: Omit<FilterOptions, "nowMs">;
  readonly nowMs?: () => number;
}

export interface RankingDiagnostics {
  readonly totalAtoms: number;
  readonly uniqueCandidates: number;
  readonly keptCount: number;
  readonly omittedCounts: Readonly<Record<CandidateOmissionReason, number>>;
  readonly elapsedMs: number;
}

export interface RankingResult extends FilterResult {
  readonly diagnostics: RankingDiagnostics;
}

interface ValidationSplit {
  readonly valid: Map<string, EvidenceAtom[]>;
  readonly invalidPaths: readonly string[];
}

function resolveHints(hints: RankingHints | undefined): Required<RankingHints> {
  return {
    generatedPathPatterns: hints?.generatedPathPatterns ?? DEFAULT_GENERATED_PATTERNS,
    duplicateOf: hints?.duplicateOf ?? new Map<string, string>(),
  };
}

function resolveFilterOptions(
  filter: Omit<FilterOptions, "nowMs"> | undefined,
  nowMs: () => number,
): FilterOptions {
  const base = filter ?? DEFAULT_FILTER_OPTIONS;
  return {
    minScore: base.minScore,
    maxKept: base.maxKept,
    omitGenerated: base.omitGenerated,
    omitNearDuplicates: base.omitNearDuplicates,
    nowMs,
  };
}

function groupAtomsByPath(atoms: readonly EvidenceAtom[]): ValidationSplit {
  const valid = new Map<string, EvidenceAtom[]>();
  const invalidPaths = new Set<string>();
  for (const candidate of atoms) {
    if (!isValidScopePath(candidate.scopePath, { mustBeRelative: true })) {
      invalidPaths.add(candidate.scopePath);
      continue;
    }
    const existing = valid.get(candidate.scopePath);
    if (existing === undefined) {
      valid.set(candidate.scopePath, [candidate]);
    } else {
      existing.push(candidate);
    }
  }
  return { valid, invalidPaths: [...invalidPaths] };
}

function buildAnnotated(
  group: ReadonlyMap<string, readonly EvidenceAtom[]>,
  input: RankingInput,
  hints: Required<RankingHints>,
  weights: ScoringWeights,
): AnnotatedCandidate[] {
  const annotated: AnnotatedCandidate[] = [];
  for (const [scopePath, atomsForPath] of group) {
    const signals = extractSignals(atomsForPath, input.anchors, hints);
    const score = computeScore(signals, weights);
    const candidate: CandidateFile = {
      scopePath,
      score,
      signals: signals.signals,
      omitted: undefined,
    };
    annotated.push({
      candidate,
      generatedHint: signals.generatedHint,
      duplicate: hints.duplicateOf.has(scopePath),
    });
  }
  return annotated;
}

function emptyOmittedCounts(): Record<CandidateOmissionReason, number> {
  const counts = {} as Record<CandidateOmissionReason, number>;
  for (const reason of CANDIDATE_OMISSION_REASONS) {
    counts[reason] = 0;
  }
  return counts;
}

function tallyOmittedCounts(
  omitted: readonly OmittedContextEntry[],
  outsideScopeCount: number,
): Record<CandidateOmissionReason, number> {
  const counts = emptyOmittedCounts();
  for (const entry of omitted) {
    counts[entry.reason] += 1;
  }
  counts["outside-scope"] += outsideScopeCount;
  return counts;
}

export function rankCandidates(input: RankingInput, options: RankingOptions = {}): RankingResult {
  const clock = options.nowMs ?? Date.now;
  // Capture a single emission timestamp so every OmittedContextEntry created by this call carries
  // the same omittedAtMs. The end-of-run clock read below measures elapsed time only.
  const startMs = clock();
  const frozenStartMs: () => number = () => startMs;
  const hints = resolveHints(input.hints);
  const weights = options.weights ?? DEFAULT_SCORING_WEIGHTS;
  const { valid, invalidPaths } = groupAtomsByPath(input.atoms);
  const annotated = buildAnnotated(valid, input, hints, weights);
  const filterOptions = resolveFilterOptions(options.filter, frozenStartMs);
  const filterResult = filterCandidates(annotated, filterOptions);
  // Invalid paths cannot be represented as OmittedContextEntry values without breaking
  // ConnectedContextPack validation, so keep them diagnostics-only.
  const omittedCounts = tallyOmittedCounts(filterResult.omitted, invalidPaths.length);
  const elapsedMs = Math.max(0, clock() - startMs);
  const diagnostics: RankingDiagnostics = {
    totalAtoms: input.atoms.length,
    uniqueCandidates: valid.size,
    keptCount: filterResult.kept.length,
    omittedCounts,
    elapsedMs,
  };
  return { kept: filterResult.kept, omitted: filterResult.omitted, diagnostics };
}
