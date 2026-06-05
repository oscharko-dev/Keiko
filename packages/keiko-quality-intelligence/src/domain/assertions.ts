// Shared invariant helpers for the quality-intelligence domain modules
// (Epic #270, Issue #272).
//
// Pure, deterministic, no IO. Inspired structurally by the deterministic
// guards in the upstream Test Intelligence (TI) reference repo at
// packages/core-engine/src/intent-derivation.ts and coverage-relevance.ts,
// but rewritten to consume only the contracts surface exposed by
// keiko-contracts via the QualityIntelligence namespace. TI is NOT a
// runtime dependency: ADR-0023 D12 + supply-chain gate forbid it.

import type { QualityIntelligence } from "@oscharko-dev/keiko-contracts";

/**
 * NFKC-normalise + trim a free-text fragment, returning the empty string for
 * `undefined`. Used to make heuristics invariant to compatibility-equivalent
 * code points (full-width digits, decomposed accents) without rewriting any
 * value-bearing field.
 */
export const normaliseText = (value: string | undefined): string => {
  if (value === undefined) {
    return "";
  }
  return value.normalize("NFKC").trim();
};

/**
 * Returns true when `value` is a non-empty string of unicode-aware characters
 * after NFKC normalisation + trim. Used as a structural guard before counting
 * a fragment as evidence.
 */
export const isMeaningfulText = (value: string | undefined): boolean =>
  normaliseText(value).length > 0;

/**
 * Type guard mapping an arbitrary string to a known QI priority. Pure; used
 * to keep the test-design model's priority field type-correct.
 */
export const isKnownPriority = (
  value: string,
): value is QualityIntelligence.QualityIntelligencePriority => {
  for (const candidate of [
    "P0",
    "P1",
    "P2",
    "P3",
  ] as readonly QualityIntelligence.QualityIntelligencePriority[]) {
    if (candidate === value) {
      return true;
    }
  }
  return false;
};

/**
 * Returns a stable, lexicographic, NFKC-normalised copy of the supplied
 * fragments. Equal fragments after normalisation collapse to a single entry.
 * Used by deduplication and canonicalisation routines.
 */
export const canonicaliseFragmentList = (fragments: readonly string[]): readonly string[] => {
  const seen = new Set<string>();
  for (const fragment of fragments) {
    const normalised = normaliseText(fragment);
    if (normalised.length === 0) {
      continue;
    }
    seen.add(normalised);
  }
  return Array.from(seen).sort();
};
