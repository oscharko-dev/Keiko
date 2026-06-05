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

export interface BuildCoverageMapInput {
  readonly runId: QualityIntelligence.QualityIntelligenceRunId;
  readonly atoms: readonly QualityIntelligence.QualityIntelligenceEvidenceAtom[];
  readonly candidates: readonly QualityIntelligence.QualityIntelligenceTestCaseCandidate[];
}

const compareString = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const scoreMapping = (
  atom: QualityIntelligence.QualityIntelligenceEvidenceAtom,
  candidates: readonly QualityIntelligence.QualityIntelligenceTestCaseCandidate[],
): number => {
  if (candidates.length === 0) {
    return 0;
  }
  // Structural relevance: how many candidates explicitly cite this atom in
  // their derivedFromAtomIds. A direct citation contributes 1.0, an
  // implicit/proximal candidate (kind referenced in steps) contributes a
  // fractional boost capped at 1.0.
  let citedCount = 0;
  let proximalCount = 0;
  for (const candidate of candidates) {
    if (candidate.derivedFromAtomIds.includes(atom.id)) {
      citedCount += 1;
      continue;
    }
    for (const step of candidate.steps) {
      if (step.includes(atom.id)) {
        proximalCount += 1;
        break;
      }
    }
  }
  if (citedCount === 0 && proximalCount === 0) {
    return 0;
  }
  const directShare = citedCount / candidates.length;
  const proximalShare = proximalCount / candidates.length;
  const raw = directShare + 0.25 * proximalShare;
  return Math.max(0, Math.min(1, raw));
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
    for (const candidate of candidates) {
      if (candidate.derivedFromAtomIds.includes(atom.id)) {
        candidateIds.push(candidate.id);
      }
    }
    if (candidateIds.length === 0) {
      continue;
    }
    const confidence = scoreMapping(atom, candidates);
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
