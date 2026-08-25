import { describe, expect, it } from "vitest";
import {
  asQualityIntelligenceCoverageMapId,
  asQualityIntelligenceExportBundleId,
  asQualityIntelligenceRunId,
  asQualityIntelligenceTestCaseId,
  asQualityIntelligenceValidationFindingId,
} from "../ids.js";
import {
  QUALITY_INTELLIGENCE_EXPORT_ADAPTER_TARGETS,
  QUALITY_INTELLIGENCE_EXPORT_ADAPTERS,
  QUALITY_INTELLIGENCE_MODEL_PARAMETER_ALLOWLIST,
  QUALITY_INTELLIGENCE_TMS_ADAPTERS,
  assertExportBundleInvariant,
} from "../exportBundle.js";
import type {
  QualityIntelligenceExportAdapter,
  QualityIntelligenceExportBundle,
  QualityIntelligenceExportModelProvenance,
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

// KEIKO-0385: the TMS classification was a hand-listed Set, so it failed OPEN — an adapter nobody
// remembered to add was silently treated as portable and escaped the redaction-attestation
// requirement, the one control between a QI export and an external tracker. The total Record makes
// a new adapter a compile error until it is classified; this pins that no adapter goes unclassified
// at runtime either.
describe("export adapter classification is total (KEIKO-0385)", () => {
  it("classifies every declared adapter", () => {
    for (const adapter of QUALITY_INTELLIGENCE_EXPORT_ADAPTERS) {
      expect(QUALITY_INTELLIGENCE_EXPORT_ADAPTER_TARGETS[adapter]).toMatch(/^(tms|portable)$/u);
    }
    expect(Object.keys(QUALITY_INTELLIGENCE_EXPORT_ADAPTER_TARGETS).sort()).toEqual(
      [...QUALITY_INTELLIGENCE_EXPORT_ADAPTERS].sort(),
    );
  });

  it("derives the TMS set from the classification rather than a second list", () => {
    for (const adapter of QUALITY_INTELLIGENCE_EXPORT_ADAPTERS) {
      expect(QUALITY_INTELLIGENCE_TMS_ADAPTERS.has(adapter)).toBe(
        QUALITY_INTELLIGENCE_EXPORT_ADAPTER_TARGETS[adapter] === "tms",
      );
    }
  });
});

// KEIKO-0603: seedUsed is now required (number | null, never absent) and modelParameters is
// checked against an allow-list, following the completedAt required-nullable precedent
// (bffWire.ts) and closing the redaction hole a bare Record<string, unknown> left open on the one
// QI contract explicitly destined for an external TMS.
describe("QualityIntelligenceExportModelProvenance (KEIKO-0603)", () => {
  const bundleWithModelProvenance = (
    modelProvenance: QualityIntelligenceExportModelProvenance,
  ): QualityIntelligenceExportBundle => ({
    ...makeBundle("csv", false),
    modelProvenance,
  });

  const STAGE = { modelId: "m-1", provider: "test-provider", revision: "rev-1" } as const;

  it("compiles and accepts seedUsed: null (no seed was used or recorded)", () => {
    const bundle = bundleWithModelProvenance({
      generation: STAGE,
      judge: STAGE,
      seedUsed: null,
    });
    expect(() => {
      assertExportBundleInvariant(bundle);
    }).not.toThrow();
  });

  it("compiles and accepts seedUsed: <number> (a specific seed was used)", () => {
    const bundle = bundleWithModelProvenance({
      generation: STAGE,
      judge: STAGE,
      seedUsed: 42,
    });
    expect(() => {
      assertExportBundleInvariant(bundle);
    }).not.toThrow();
  });

  it("accepts every real writer's key, both generation- and judge-side together (traced from generationPort.ts / judgePort.ts / modelRoutedTestDesign.ts)", () => {
    const bundle = bundleWithModelProvenance({
      generation: STAGE,
      judge: STAGE,
      seedUsed: 7,
      modelParameters: {
        temperature: 0,
        topP: 1,
        responseFormatEnforced: true,
        responseFormat: "json_schema",
        seed: 7,
        judgeTemperature: 0,
        judgeSeedUsed: true,
        judgeSeed: 7,
        judgeResponseFormat: "json_schema",
        generationFallbackReason: "model routing unavailable",
      },
    });
    expect(() => {
      assertExportBundleInvariant(bundle);
    }).not.toThrow();
    // Every key exercised above must actually be on the allow-list this test relies on, or the
    // test would be vacuous the moment the allow-list drifted out from under it.
    for (const key of Object.keys(bundle.modelProvenance?.modelParameters ?? {})) {
      expect(QUALITY_INTELLIGENCE_MODEL_PARAMETER_ALLOWLIST).toContain(key);
    }
  });

  it("rejects a modelParameters key not on the allow-list (mustFailBeforeFix: apiKey)", () => {
    // Before KEIKO-0603, modelParameters was an unconstrained Record<string, unknown> and this
    // call did not throw at all -- any key, including one shaped like a credential, passed
    // assertExportBundleInvariant unchanged.
    const bundle = bundleWithModelProvenance({
      generation: STAGE,
      judge: STAGE,
      seedUsed: null,
      modelParameters: { apiKey: "x" },
    });
    expect(() => {
      assertExportBundleInvariant(bundle);
    }).toThrow(Error);
  });

  // KEIKO-0603 follow-up (reviewer P1): the rejected key itself is attacker-supplied and may
  // carry credential material. The thrown Error must NOT interpolate the raw key — a fixed
  // content-free reason code plus a count keeps the redaction gate intact when the error
  // propagates into operator diagnostics or logs.
  it("does not echo the rejected key name into the thrown Error message (KEIKO-0603 follow-up)", () => {
    const sensitiveKey = "sk-live-token-2ab3f9e1";
    const bundle = bundleWithModelProvenance({
      generation: STAGE,
      judge: STAGE,
      seedUsed: null,
      modelParameters: { [sensitiveKey]: "x" },
    });
    let caught: unknown;
    try {
      assertExportBundleInvariant(bundle);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).not.toContain(sensitiveKey);
    expect(message).not.toContain("sk-live");
  });

  it("accepts a bundle with no modelProvenance at all (the field itself stays optional)", () => {
    expect(() => {
      assertExportBundleInvariant(makeBundle("csv", false));
    }).not.toThrow();
  });
});
