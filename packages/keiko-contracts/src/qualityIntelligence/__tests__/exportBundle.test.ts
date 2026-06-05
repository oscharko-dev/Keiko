import { describe, expect, it } from "vitest";
import {
  asQualityIntelligenceCoverageMapId,
  asQualityIntelligenceExportBundleId,
  asQualityIntelligenceRunId,
  asQualityIntelligenceTestCaseId,
  asQualityIntelligenceValidationFindingId,
} from "../ids.js";
import {
  QUALITY_INTELLIGENCE_EXPORT_ADAPTERS,
  QUALITY_INTELLIGENCE_TMS_ADAPTERS,
  assertExportBundleInvariant,
} from "../exportBundle.js";
import type {
  QualityIntelligenceExportAdapter,
  QualityIntelligenceExportBundle,
} from "../exportBundle.js";

const HASH = "0".repeat(64);

const makeBundle = (
  targetAdapter: QualityIntelligenceExportAdapter,
  redactionAttested: boolean,
): QualityIntelligenceExportBundle => ({
  id: asQualityIntelligenceExportBundleId("bundle-1"),
  runId: asQualityIntelligenceRunId("run-1"),
  targetAdapter,
  createdAt: "2026-06-05T00:00:00Z",
  integrityHashSha256Hex: HASH,
  redactionAttested,
  contents: [
    {
      candidateId: asQualityIntelligenceTestCaseId("tc-1"),
      coverageMapRefs: [asQualityIntelligenceCoverageMapId("cov-1")],
      findingRefs: [asQualityIntelligenceValidationFindingId("finding-1")],
    },
  ],
});

describe("QualityIntelligenceExportBundle", () => {
  it("classifies TMS adapters correctly", () => {
    expect(QUALITY_INTELLIGENCE_TMS_ADAPTERS.has("jira-issues")).toBe(true);
    expect(QUALITY_INTELLIGENCE_TMS_ADAPTERS.has("qtest")).toBe(true);
    expect(QUALITY_INTELLIGENCE_TMS_ADAPTERS.has("xray")).toBe(true);
    expect(QUALITY_INTELLIGENCE_TMS_ADAPTERS.has("polarion")).toBe(true);
    expect(QUALITY_INTELLIGENCE_TMS_ADAPTERS.has("alm")).toBe(true);
    expect(QUALITY_INTELLIGENCE_TMS_ADAPTERS.has("csv")).toBe(false);
    expect(QUALITY_INTELLIGENCE_TMS_ADAPTERS.has("json")).toBe(false);
    expect(QUALITY_INTELLIGENCE_TMS_ADAPTERS.has("spreadsheet-safe-csv")).toBe(false);
  });

  it("enumerates eight adapters", () => {
    expect(QUALITY_INTELLIGENCE_EXPORT_ADAPTERS).toHaveLength(8);
  });
});

describe("assertExportBundleInvariant", () => {
  it("rejects every TMS adapter when redactionAttested is false", () => {
    for (const adapter of QUALITY_INTELLIGENCE_TMS_ADAPTERS) {
      expect(() => {
        assertExportBundleInvariant(makeBundle(adapter, false));
      }).toThrow(Error);
    }
  });

  it("accepts every TMS adapter when redactionAttested is true", () => {
    for (const adapter of QUALITY_INTELLIGENCE_TMS_ADAPTERS) {
      expect(() => {
        assertExportBundleInvariant(makeBundle(adapter, true));
      }).not.toThrow();
    }
  });

  it("accepts non-TMS adapters with redactionAttested false", () => {
    for (const adapter of ["csv", "json", "spreadsheet-safe-csv"] as const) {
      expect(() => {
        assertExportBundleInvariant(makeBundle(adapter, false));
      }).not.toThrow();
    }
  });

  it("rejects a malformed integrity hash regardless of adapter", () => {
    const bundle: QualityIntelligenceExportBundle = {
      ...makeBundle("csv", true),
      integrityHashSha256Hex: "not-hex",
    };
    expect(() => {
      assertExportBundleInvariant(bundle);
    }).toThrow(Error);
  });
});
