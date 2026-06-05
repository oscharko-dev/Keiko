// Quality Intelligence deduplication (Epic #270, Issue #272).
//
// Given a list of `QualityIntelligenceTestCaseCandidate` records, returns the
// deduplicated subset using deterministic equivalence: two candidates are
// considered equivalent iff their canonical equivalence signature collides.
// The signature is computed from
//   * the NFKC-normalised + lower-cased + whitespace-collapsed title
//   * the canonicalised step sequence (each step normalised the same way)
//   * the canonicalised expected-result sequence
//   * the priority and risk-class fields
//
// NO embeddings, NO model judges — model-assisted dedup lives in #279.
//
// When two candidates are equivalent we keep the one with the lexicographic-
// ally smallest `id` so the function is order-independent.
//
// Structurally inspired by
// Test Intelligence reference (TI) packages/core-engine/src/test-case-dedupe.ts
// (`detectTestCaseDuplicatesExtended`), but stripped of the embedding cosine
// path that issue #279 owns; the deterministic canonical-signature path is
// what we port here.

import type { QualityIntelligence } from "@oscharko-dev/keiko-contracts";
import { sha256Hex } from "@oscharko-dev/keiko-security";

import { normaliseText } from "./assertions.js";

const collapseWhitespace = (value: string): string => value.replace(/\s+/gu, " ").trim();

const canonicaliseLine = (value: string): string =>
  collapseWhitespace(normaliseText(value).toLowerCase());

const canonicaliseSequence = (values: readonly string[]): readonly string[] => {
  const out: string[] = [];
  for (const value of values) {
    const canonical = canonicaliseLine(value);
    if (canonical.length === 0) {
      continue;
    }
    out.push(canonical);
  }
  return out;
};

const compareString = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const compareCandidateById = (
  left: QualityIntelligence.QualityIntelligenceTestCaseCandidate,
  right: QualityIntelligence.QualityIntelligenceTestCaseCandidate,
): number => compareString(String(left.id), String(right.id));

/**
 * Compute the canonical equivalence signature for a candidate. Exported so
 * callers (validators, audit-summary builders) can inspect what makes two
 * candidates collide without re-implementing the rule.
 *
 * @returns Lower-case hex sha256 of the canonical projection.
 */
export const computeCandidateEquivalenceSignature = (
  candidate: QualityIntelligence.QualityIntelligenceTestCaseCandidate,
): string => {
  const projection = JSON.stringify({
    v: "1",
    title: canonicaliseLine(candidate.title),
    steps: canonicaliseSequence(candidate.steps),
    expectedResults: canonicaliseSequence(candidate.expectedResults),
    priority: candidate.priority,
    riskClass: candidate.riskClass,
  });
  return sha256Hex(projection);
};

/**
 * Returns the deduplicated subset of `candidates`. Order is the original
 * input order with duplicates removed (the lexicographically-smallest `id`
 * within each equivalence class is the survivor). Empty input returns the
 * empty array.
 */
export const deduplicateCandidates = (
  candidates: readonly QualityIntelligence.QualityIntelligenceTestCaseCandidate[],
): readonly QualityIntelligence.QualityIntelligenceTestCaseCandidate[] => {
  if (candidates.length === 0) {
    return Object.freeze([] as readonly QualityIntelligence.QualityIntelligenceTestCaseCandidate[]);
  }

  const survivorBySignature = new Map<
    string,
    QualityIntelligence.QualityIntelligenceTestCaseCandidate
  >();
  for (const candidate of candidates) {
    const signature = computeCandidateEquivalenceSignature(candidate);
    const incumbent = survivorBySignature.get(signature);
    if (incumbent === undefined) {
      survivorBySignature.set(signature, candidate);
      continue;
    }
    if (compareCandidateById(candidate, incumbent) < 0) {
      survivorBySignature.set(signature, candidate);
    }
  }

  const survivorIds = new Set<string>();
  for (const survivor of survivorBySignature.values()) {
    survivorIds.add(String(survivor.id));
  }

  const out: QualityIntelligence.QualityIntelligenceTestCaseCandidate[] = [];
  for (const candidate of candidates) {
    if (survivorIds.has(String(candidate.id))) {
      out.push(candidate);
      survivorIds.delete(String(candidate.id));
    }
  }
  return Object.freeze(out);
};
