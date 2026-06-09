// Quality Intelligence coverage relevance (Epic #270, Issue #272).
//
// Builds a deterministic `QualityIntelligenceCoverageMap` linking each
// evidence atom to the candidates derived from it, scoring each mapping
// with a simple structural confidence in [0, 1]. NO model judges — model-
// based coverage scoring lives in #279.
//
// Structurally inspired by
// Test Intelligence reference (TI) packages/core-engine/src/coverage-relevance.ts
// (`isCoverageRelevantElementLike`, `normalizeCoverageText`) — but the TI
// reference scores UI element coverage; our Keiko port scores atom-to-
// candidate provenance coverage.

import { QualityIntelligence } from "@oscharko-dev/keiko-contracts";
import { sha256Hex } from "@oscharko-dev/keiko-security";

// ─── Coverage classification ────────────────────────────────────────────────────

/** Thresholds for atom coverage classification. */
export const COVERAGE_THRESHOLD_COVERED = 0.7 as const;
export const COVERAGE_THRESHOLD_WEAKLY_COVERED = 0.3 as const;

/**
 * Classification of a single evidence atom: whether its confidence places it in a
 * covered, weakly-covered, or uncovered state. "uncovered" means zero or insufficient
 * structural evidence that a candidate tests this requirement atom.
 */
export type CoverageStatus = "covered" | "weakly-covered" | "uncovered";

export interface AtomCoverageStatus {
  readonly atomId: QualityIntelligence.QualityIntelligenceEvidenceAtomId;
  readonly status: CoverageStatus;
  readonly confidence: number;
  readonly coveringCandidateIds: readonly QualityIntelligence.QualityIntelligenceTestCaseId[];
}

/**
 * Classify a single atom given its coverage-map mapping (undefined when the atom has
 * no mapping entry — i.e. no candidate cited it at all).
 */
export function classifyAtomCoverage(
  atom: QualityIntelligence.QualityIntelligenceEvidenceAtom,
  mapping: QualityIntelligence.QualityIntelligenceCoverageMapping | undefined,
): AtomCoverageStatus {
  if (mapping === undefined || mapping.confidence < COVERAGE_THRESHOLD_WEAKLY_COVERED) {
    return {
      atomId: atom.id,
      status: "uncovered",
      confidence: mapping?.confidence ?? 0,
      coveringCandidateIds: Object.freeze([]),
    };
  }
  const status: CoverageStatus =
    mapping.confidence >= COVERAGE_THRESHOLD_COVERED ? "covered" : "weakly-covered";
  return {
    atomId: atom.id,
    status,
    confidence: mapping.confidence,
    coveringCandidateIds: mapping.candidateIds,
  };
}

/**
 * Classify every atom in `atoms` against the supplied coverage map. Atoms with no
 * mapping are classified as "uncovered". The result is sorted by atomId ascending.
 */
export function buildAtomCoverageStatuses(
  atoms: readonly QualityIntelligence.QualityIntelligenceEvidenceAtom[],
  coverageMap: QualityIntelligence.QualityIntelligenceCoverageMap,
): readonly AtomCoverageStatus[] {
  const byAtomId = new Map<string, QualityIntelligence.QualityIntelligenceCoverageMapping>();
  for (const mapping of coverageMap.mappings) {
    byAtomId.set(String(mapping.atomId), mapping);
  }
  const statuses: AtomCoverageStatus[] = atoms.map((atom) =>
    classifyAtomCoverage(atom, byAtomId.get(String(atom.id))),
  );
  statuses.sort((a, b) =>
    String(a.atomId) < String(b.atomId) ? -1 : String(a.atomId) > String(b.atomId) ? 1 : 0,
  );
  return Object.freeze(statuses);
}

/**
 * Returns the percentage of atoms classified as "covered" out of all atoms. Returns
 * 0 when the array is empty (deterministic, no division by zero).
 */
export function runCoveragePercentage(statuses: readonly AtomCoverageStatus[]): number {
  if (statuses.length === 0) return 0;
  const covered = statuses.filter((s) => s.status === "covered").length;
  return (covered / statuses.length) * 100;
}

export interface BuildCoverageMapInput {
  readonly runId: QualityIntelligence.QualityIntelligenceRunId;
  readonly atoms: readonly QualityIntelligence.QualityIntelligenceEvidenceAtom[];
  readonly candidates: readonly QualityIntelligence.QualityIntelligenceTestCaseCandidate[];
}

const compareString = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/**
 * A citing test counts as a *focused* cover of an atom when it derives from at most this many
 * atoms — i.e. the test is reasonably specific to the requirement rather than a sprawling
 * integration test that incidentally touches it. An atom whose only covering tests are all
 * broader than this is classified "weakly-covered" (covered only incidentally).
 *
 * Conservative for regulated use: a dedicated test (focus 1) always yields "covered"; coverage
 * is NEVER diluted by the total run size (see the regression test for the historical bug where
 * `citedCount / candidates.length` reported a perfectly-covered run as 0%).
 */
export const FOCUS_COVERED_MAX = 3 as const;

const clamp01 = (value: number, max: number): number => Math.max(0, Math.min(max, value));

/**
 * Deterministic, run-size-INDEPENDENT structural confidence in [0, 1] that an atom is covered.
 *
 * Inputs are atom-local: `citerCount` is the number of candidates that DIRECTLY derive from the
 * atom, and `bestFocus` is the smallest `derivedFromAtomIds` length among those citers (1 = a test
 * dedicated to this atom alone). Confidence is monotonic non-decreasing in `citerCount` so more
 * tracing tests never lowers confidence.
 *
 *   - no citers              -> 0           (uncovered)
 *   - >=1 focused citer      -> [0.7, 1.0]  (covered; threshold COVERAGE_THRESHOLD_COVERED)
 *   - only broad citers      -> [0.3, 0.7)  (weakly-covered; incidental coverage only)
 */
export const coverageConfidence = (citerCount: number, bestFocus: number): number => {
  if (citerCount <= 0) return 0;
  const focused = Math.max(1, bestFocus) <= FOCUS_COVERED_MAX;
  const saturation = 1 - 1 / (1 + citerCount); // 0.5, 0.667, 0.75, ... (in [0.5, 1))
  return focused
    ? clamp01(COVERAGE_THRESHOLD_COVERED + 0.3 * saturation, 1) // 0.85, 0.90, 0.925, ...
    : clamp01(COVERAGE_THRESHOLD_WEAKLY_COVERED + 0.4 * saturation, 0.699); // 0.5, 0.567, ...
};

const deriveCoverageMapIdString = (
  runId: QualityIntelligence.QualityIntelligenceRunId,
  atomHashes: readonly string[],
  candidateIds: readonly string[],
): string => {
  const payload = [
    "v1",
    String(runId),
    [...atomHashes].sort().join(""),
    [...candidateIds].sort().join(""),
  ].join("");
  return `qi-coverage-${sha256Hex(payload).slice(0, 32)}`;
};

/**
 * Build a coverage map for the supplied run. The returned map is validated
 * against `assertCoverageMapInvariant` before being returned — callers can
 * trust every confidence value lies in [0, 1] and every mapping cites at
 * least one candidate.
 *
 * Atoms whose structural score is 0 (no candidate cites them and no step
 * mentions them) are omitted from the returned mappings — including a zero-
 * confidence mapping would violate the contract invariant (every mapping
 * must cite at least one candidate).
 */
export const buildCoverageMap = (
  input: BuildCoverageMapInput,
): QualityIntelligence.QualityIntelligenceCoverageMap => {
  const { runId, atoms, candidates } = input;

  const sortedAtoms = [...atoms].sort((left, right) =>
    compareString(left.canonicalHashSha256Hex, right.canonicalHashSha256Hex),
  );

  const mappings: QualityIntelligence.QualityIntelligenceCoverageMapping[] = [];
  for (const atom of sortedAtoms) {
    const candidateIds: QualityIntelligence.QualityIntelligenceTestCaseId[] = [];
    // Track the most-focused citing test (smallest derivedFromAtomIds) so an atom covered only by
    // sprawling tests is classified weakly-covered, while a dedicated test yields "covered". The
    // confidence is atom-local — it does NOT depend on how many candidates the run produced.
    let bestFocus = Number.POSITIVE_INFINITY;
    for (const candidate of candidates) {
      if (candidate.derivedFromAtomIds.includes(atom.id)) {
        candidateIds.push(candidate.id);
        bestFocus = Math.min(bestFocus, candidate.derivedFromAtomIds.length);
      }
    }
    if (candidateIds.length === 0) {
      continue;
    }
    const confidence = coverageConfidence(candidateIds.length, bestFocus);
    if (confidence <= 0) {
      continue;
    }
    mappings.push(
      Object.freeze({
        atomId: atom.id,
        candidateIds: Object.freeze([...candidateIds].sort(compareString)),
        coverageKind: "derived" as const,
        confidence,
      }),
    );
  }

  const idString = deriveCoverageMapIdString(
    runId,
    sortedAtoms.map((atom) => atom.canonicalHashSha256Hex),
    candidates.map((candidate) => candidate.id),
  );

  const map: QualityIntelligence.QualityIntelligenceCoverageMap = Object.freeze({
    id: QualityIntelligence.asQualityIntelligenceCoverageMapId(idString),
    runId,
    mappings: Object.freeze(mappings),
  });

  QualityIntelligence.assertCoverageMapInvariant(map);
  return map;
};
