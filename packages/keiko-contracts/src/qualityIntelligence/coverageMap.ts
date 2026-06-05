// Quality Intelligence coverage map (Epic #270, Issue #277).
//
// A coverage map relates evidence atoms to the test-case candidates derived from
// them, with a per-mapping confidence in the half-closed range [0, 1]. The runtime
// helper `assertCoverageMapInvariant` enforces the float bound. Pure; no IO.

import type {
  QualityIntelligenceCoverageMapId,
  QualityIntelligenceEvidenceAtomId,
  QualityIntelligenceRunId,
  QualityIntelligenceTestCaseId,
} from "./ids.js";

export type QualityIntelligenceCoverageKind = "derived" | "asserted" | "manual";

export const QUALITY_INTELLIGENCE_COVERAGE_KINDS: readonly QualityIntelligenceCoverageKind[] = [
  "derived",
  "asserted",
  "manual",
] as const;

export interface QualityIntelligenceCoverageMapping {
  readonly atomId: QualityIntelligenceEvidenceAtomId;
  readonly candidateIds: readonly QualityIntelligenceTestCaseId[];
  readonly coverageKind: QualityIntelligenceCoverageKind;
  /** Confidence in `[0, 1]`. NaN, ±Infinity, and out-of-range values are rejected. */
  readonly confidence: number;
}

export interface QualityIntelligenceCoverageMap {
  readonly id: QualityIntelligenceCoverageMapId;
  readonly runId: QualityIntelligenceRunId;
  readonly mappings: readonly QualityIntelligenceCoverageMapping[];
}

const isValidConfidence = (value: number): boolean =>
  Number.isFinite(value) && value >= 0 && value <= 1;

/**
 * Throws `RangeError` on any out-of-range confidence (NaN, ±Infinity, < 0, > 1) and
 * on a mapping with an empty `candidateIds` list. Returns `void` on success.
 */
export const assertCoverageMapInvariant = (map: QualityIntelligenceCoverageMap): void => {
  for (let index = 0; index < map.mappings.length; index += 1) {
    const mapping = map.mappings[index];
    if (mapping === undefined) {
      throw new RangeError(`Coverage map mapping[${String(index)}] is missing`);
    }
    if (!isValidConfidence(mapping.confidence)) {
      throw new RangeError(
        `Coverage map mapping[${String(index)}] has out-of-range confidence ${String(
          mapping.confidence,
        )}`,
      );
    }
    if (mapping.candidateIds.length === 0) {
      throw new RangeError(
        `Coverage map mapping[${String(index)}] must reference at least one candidate`,
      );
    }
  }
};
