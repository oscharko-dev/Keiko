import { describe, expect, it } from "vitest";
import {
  asQualityIntelligenceCoverageMapId,
  asQualityIntelligenceEvidenceAtomId,
  asQualityIntelligenceRunId,
  asQualityIntelligenceTestCaseId,
} from "../ids.js";
import { assertCoverageMapInvariant } from "../coverageMap.js";
import type { QualityIntelligenceCoverageMap } from "../coverageMap.js";

const goodMap = (confidence: number): QualityIntelligenceCoverageMap => ({
  id: asQualityIntelligenceCoverageMapId("cov-1"),
  runId: asQualityIntelligenceRunId("run-1"),
  mappings: [
    {
      atomId: asQualityIntelligenceEvidenceAtomId("atom-1"),
      candidateIds: [asQualityIntelligenceTestCaseId("tc-1")],
      coverageKind: "derived",
      confidence,
    },
  ],
});

describe("assertCoverageMapInvariant", () => {
  it("accepts a valid confidence of 0", () => {
    expect(() => {
      assertCoverageMapInvariant(goodMap(0));
    }).not.toThrow();
  });
  it("accepts a valid confidence of 1", () => {
    expect(() => {
      assertCoverageMapInvariant(goodMap(1));
    }).not.toThrow();
  });
  it("accepts a valid confidence of 0.5", () => {
    expect(() => {
      assertCoverageMapInvariant(goodMap(0.5));
    }).not.toThrow();
  });
  it("rejects a negative confidence", () => {
    expect(() => {
      assertCoverageMapInvariant(goodMap(-0.001));
    }).toThrow(RangeError);
  });
  it("rejects a confidence above 1", () => {
    expect(() => {
      assertCoverageMapInvariant(goodMap(1.001));
    }).toThrow(RangeError);
  });
  it("rejects NaN", () => {
    expect(() => {
      assertCoverageMapInvariant(goodMap(Number.NaN));
    }).toThrow(RangeError);
  });
  it("rejects positive Infinity", () => {
    expect(() => {
      assertCoverageMapInvariant(goodMap(Number.POSITIVE_INFINITY));
    }).toThrow(RangeError);
  });
  it("rejects a mapping with empty candidateIds", () => {
    const map: QualityIntelligenceCoverageMap = {
      id: asQualityIntelligenceCoverageMapId("cov-1"),
      runId: asQualityIntelligenceRunId("run-1"),
      mappings: [
        {
          atomId: asQualityIntelligenceEvidenceAtomId("atom-1"),
          candidateIds: [],
          coverageKind: "manual",
          confidence: 1,
        },
      ],
    };
    expect(() => {
      assertCoverageMapInvariant(map);
    }).toThrow(RangeError);
  });
});
