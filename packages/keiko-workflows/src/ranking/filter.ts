// Negative-context filter for the ranker (Epic #177, Issue #182). Converts annotated
// candidates into a kept/omitted partition with explicit CandidateOmissionReason values.
// Priority is fixed (pre-set reason > generated > low-relevance > duplicate); a hard maxKept
// cap demotes the overflow to "budget-exhausted". Determinism: ties break on scopePath asc.

import type {
  CandidateFile,
  OmittedContextEntry,
} from "@oscharko-dev/keiko-contracts/connected-context";

// AnnotatedCandidate carries only annotation flags; the score is read from candidate.score
// so classification (low-relevance threshold) and ordering (compareKept) always use the
// same value. Storing a separate score risked divergence — see PR #251 Copilot finding.
export interface AnnotatedCandidate {
  readonly candidate: CandidateFile;
  readonly generatedHint: boolean;
  readonly duplicate: boolean;
}

export interface FilterOptions {
  readonly minScore: number;
  readonly maxKept: number;
  readonly omitGenerated: boolean;
  readonly omitNearDuplicates: boolean;
  readonly nowMs: () => number;
}

export const DEFAULT_FILTER_OPTIONS: Omit<FilterOptions, "nowMs"> = {
  minScore: 0.15,
  maxKept: 50,
  omitGenerated: true,
  omitNearDuplicates: true,
} as const;

export interface FilterResult {
  readonly kept: readonly CandidateFile[];
  readonly omitted: readonly OmittedContextEntry[];
}

function classifyReason(
  entry: AnnotatedCandidate,
  options: FilterOptions,
): CandidateFile["omitted"] {
  const preset = entry.candidate.omitted;
  if (preset !== undefined) {
    return preset;
  }
  if (entry.generatedHint && options.omitGenerated) {
    return "generated";
  }
  if (entry.candidate.score < options.minScore) {
    return "low-relevance";
  }
  if (entry.duplicate && options.omitNearDuplicates) {
    return "near-duplicate";
  }
  return undefined;
}

function compareKept(a: CandidateFile, b: CandidateFile): number {
  if (b.score !== a.score) {
    return b.score - a.score;
  }
  if (a.scopePath < b.scopePath) {
    return -1;
  }
  if (a.scopePath > b.scopePath) {
    return 1;
  }
  return 0;
}

function compareOmitted(a: OmittedContextEntry, b: OmittedContextEntry): number {
  if (a.scopePath < b.scopePath) {
    return -1;
  }
  if (a.scopePath > b.scopePath) {
    return 1;
  }
  return 0;
}

function toOmittedEntry(
  scopePath: string,
  reason: NonNullable<CandidateFile["omitted"]>,
  nowMs: number,
): OmittedContextEntry {
  return { scopePath, reason, omittedAtMs: nowMs };
}

interface Partitioned {
  readonly kept: CandidateFile[];
  readonly lowRelevance: CandidateFile[];
  readonly omittedEntries: OmittedContextEntry[];
}

function partition(
  entries: readonly AnnotatedCandidate[],
  options: FilterOptions,
  nowMs: number,
): Partitioned {
  const kept: CandidateFile[] = [];
  const lowRelevance: CandidateFile[] = [];
  const omittedEntries: OmittedContextEntry[] = [];
  for (const entry of entries) {
    const reason = classifyReason(entry, options);
    if (reason === undefined) {
      kept.push(entry.candidate);
    } else if (reason === "low-relevance") {
      lowRelevance.push(entry.candidate);
    } else {
      omittedEntries.push(toOmittedEntry(entry.candidate.scopePath, reason, nowMs));
    }
  }
  return { kept, lowRelevance, omittedEntries };
}

function normalizeMaxKept(maxKept: number): number {
  if (!Number.isFinite(maxKept)) {
    return 0;
  }
  return Math.max(0, Math.floor(maxKept));
}

function appendLowRelevanceOmissions(
  omittedEntries: OmittedContextEntry[],
  candidates: readonly CandidateFile[],
  nowMs: number,
): void {
  for (const candidate of candidates) {
    omittedEntries.push(toOmittedEntry(candidate.scopePath, "low-relevance", nowMs));
  }
}

export function filterCandidates(
  entries: readonly AnnotatedCandidate[],
  options: FilterOptions,
): FilterResult {
  const nowMs = options.nowMs();
  const { kept, lowRelevance, omittedEntries } = partition(entries, options, nowMs);
  const maxKept = normalizeMaxKept(options.maxKept);
  lowRelevance.sort(compareKept);
  if (kept.length === 0 && maxKept > 0) {
    const fallback = lowRelevance.shift();
    if (fallback !== undefined) {
      kept.push(fallback);
    }
  }
  appendLowRelevanceOmissions(omittedEntries, lowRelevance, nowMs);
  kept.sort(compareKept);
  const overflow = kept.splice(maxKept);
  for (const overflowed of overflow) {
    omittedEntries.push(toOmittedEntry(overflowed.scopePath, "budget-exhausted", nowMs));
  }
  omittedEntries.sort(compareOmitted);
  return { kept, omitted: omittedEntries };
}
