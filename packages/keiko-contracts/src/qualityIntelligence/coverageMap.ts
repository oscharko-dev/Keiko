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

/**
 * Confidence in `[0, 1]`. NaN, ±Infinity, and out-of-range values are invalid — see
 * {@link isQualityIntelligenceConfidence}. Shared by every `confidence` field on the QI contract
 * surface (coverage mapping, requirement-quality finding, UI finding summary, UI atom coverage) so
 * the unit is documented and enforced in exactly one place (KEIKO-0185). Not "just `number`": this
 * is the one name those four fields import and retype against, and the return-type target of the
 * exported guard below — not a single-site local alias, so it earns its keep despite S6564.
 */
export type QualityIntelligenceConfidence = number; // NOSONAR typescript:S6564 — see TSDoc above

/** Runtime guard for {@link QualityIntelligenceConfidence}: finite and within `[0, 1]`. */
export const isQualityIntelligenceConfidence = (
  value: number,
): value is QualityIntelligenceConfidence => Number.isFinite(value) && value >= 0 && value <= 1;

export interface QualityIntelligenceCoverageMapping {
  readonly atomId: QualityIntelligenceEvidenceAtomId;
  readonly candidateIds: readonly QualityIntelligenceTestCaseId[];
  readonly coverageKind: QualityIntelligenceCoverageKind;
  /** Confidence in `[0, 1]`. NaN, ±Infinity, and out-of-range values are rejected. */
  readonly confidence: QualityIntelligenceConfidence;
}

export interface QualityIntelligenceCoverageMap {
  readonly id: QualityIntelligenceCoverageMapId;
  readonly runId: QualityIntelligenceRunId;
  readonly mappings: readonly QualityIntelligenceCoverageMapping[];
}

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
    if (!isQualityIntelligenceConfidence(mapping.confidence)) {
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
