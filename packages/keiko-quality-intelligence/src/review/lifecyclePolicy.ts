// Quality Intelligence review lifecycle policy (Epic #270, Issue #282).
//
// Pure predicates over the QualityIntelligenceReviewRecord contract. Used by
// the runtime (#273) and the audit ledger (#274) to decide whether a record is
// still live, whether it may be paired for four-eyes governance, and whether
// downstream consumers should treat its state as final.

import type { QualityIntelligence } from "@oscharko-dev/keiko-contracts";

const TERMINAL_STATES: ReadonlySet<QualityIntelligence.QualityIntelligenceReviewState> = new Set([
  "approved",
  "rejected",
  "withdrawn",
]);

/**
 * Return true iff the supplied review state is terminal — i.e. no further
 * transition is legal under `applyReviewTransition`.
 *
 * Terminal: `approved`, `rejected`, `withdrawn`. Non-terminal: `open`,
 * `changes-requested`.
 */
export const isTerminalReviewState = (
  state: QualityIntelligence.QualityIntelligenceReviewState,
): boolean => TERMINAL_STATES.has(state);

/**
 * Return true iff `record` is eligible to be paired with a second review for
 * four-eyes governance. A record is eligible when:
 *
 *   * its state is non-terminal, AND
 *   * it has not already been paired (`fourEyesPairedRecordId` is absent).
 *
 * Eligibility is a structural predicate only — the actual reviewer-identity
 * disjointness check lives in `assertFourEyesPair`.
 */
export const canPairForFourEyes = (
  record: QualityIntelligence.QualityIntelligenceReviewRecord,
): boolean => {
  if (isTerminalReviewState(record.state)) {
    return false;
  }
  if (record.fourEyesPairedRecordId !== undefined) {
    return false;
  }
  return true;
};
