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
    // Quality Center (Epic #711) is a disabled, dry-run-only external target → TMS-classified.
    expect(QUALITY_INTELLIGENCE_TMS_ADAPTERS.has("quality-center")).toBe(true);
    expect(QUALITY_INTELLIGENCE_TMS_ADAPTERS.has("csv")).toBe(false);
    expect(QUALITY_INTELLIGENCE_TMS_ADAPTERS.has("json")).toBe(false);
    expect(QUALITY_INTELLIGENCE_TMS_ADAPTERS.has("spreadsheet-safe-csv")).toBe(false);
    // Markdown / plain-text (Epic #711) are local, redaction-safe formats → not TMS.
    expect(QUALITY_INTELLIGENCE_TMS_ADAPTERS.has("markdown")).toBe(false);
    expect(QUALITY_INTELLIGENCE_TMS_ADAPTERS.has("plain-text")).toBe(false);
  });

  it("enumerates eleven adapters (Epic #711 adds markdown, plain-text, quality-center)", () => {
    expect(QUALITY_INTELLIGENCE_EXPORT_ADAPTERS).toHaveLength(11);
    expect(QUALITY_INTELLIGENCE_EXPORT_ADAPTERS).toContain("markdown");
    expect(QUALITY_INTELLIGENCE_EXPORT_ADAPTERS).toContain("plain-text");
    expect(QUALITY_INTELLIGENCE_EXPORT_ADAPTERS).toContain("quality-center");
  });

  it("does not include server-only binary modes 'pdf' or 'zip-bundle' in the domain adapter list", () => {
    // Kills mutation: someone accidentally adds "pdf" or "zip-bundle" to the domain union.
    // These are assembled by keiko-server's exportAssembly.ts and served as binary blobs;
    // they must NOT appear in the domain export-adapter contract so UI and TMS code
    // cannot accidentally route binary-blob requests through the text-adapter pipeline.
    expect(QUALITY_INTELLIGENCE_EXPORT_ADAPTERS).not.toContain("pdf");
    expect(QUALITY_INTELLIGENCE_EXPORT_ADAPTERS).not.toContain("zip-bundle");
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
