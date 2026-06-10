import { describe, expect, it } from "vitest";
import {
  asQualityIntelligenceAuditSummaryId,
  asQualityIntelligenceCoverageMapId,
  asQualityIntelligenceEvidenceAtomId,
  asQualityIntelligenceExportBundleId,
  asQualityIntelligenceReviewRecordId,
  asQualityIntelligenceRunId,
  asQualityIntelligenceSourceEnvelopeId,
  asQualityIntelligenceTestCaseId,
  asQualityIntelligenceValidationFindingId,
  validateQualityIntelligenceIdString,
} from "../ids.js";

type Constructor = (value: string) => string;

const constructors: readonly (readonly [string, Constructor])[] = [
  ["RunId", asQualityIntelligenceRunId],
  ["TestCaseId", asQualityIntelligenceTestCaseId],
  ["CoverageMapId", asQualityIntelligenceCoverageMapId],
  ["ValidationFindingId", asQualityIntelligenceValidationFindingId],
  ["ReviewRecordId", asQualityIntelligenceReviewRecordId],
  ["ExportBundleId", asQualityIntelligenceExportBundleId],
  ["SourceEnvelopeId", asQualityIntelligenceSourceEnvelopeId],
  ["EvidenceAtomId", asQualityIntelligenceEvidenceAtomId],
  ["AuditSummaryId", asQualityIntelligenceAuditSummaryId],
];

// Control-character literals declared via explicit \u escapes so editors and
// formatters cannot silently strip them.
const NUL = "\u0000";
const DEL = "\u007f";
const C1_CONTROL = "\u0085"; // NEL (Next Line)
const NON_NFKC_LIGATURE = "ﬁeld"; // U+FB01 "fi" ligature; NFKC -> "field"
const COMPOSED_E_ACUTE = "qi-éclair"; // already NFKC-normalised composed form

describe("QI id constructors — rejection", () => {
  for (const [name, ctor] of constructors) {
    it(`${name} rejects empty string`, () => {
      expect(() => ctor("")).toThrow(TypeError);
    });
    it(`${name} rejects whitespace-only string`, () => {
      expect(() => ctor("   ")).toThrow(TypeError);
    });
    it(`${name} rejects path-traversal segment`, () => {
      expect(() => ctor("foo..bar")).toThrow(TypeError);
    });
    it(`${name} rejects forward slash`, () => {
      expect(() => ctor("foo/bar")).toThrow(TypeError);
    });
    it(`${name} rejects backslash`, () => {
      expect(() => ctor("foo\\bar")).toThrow(TypeError);
    });
    it(`${name} rejects NUL`, () => {
      expect(() => ctor(`foo${NUL}bar`)).toThrow(TypeError);
    });
    it(`${name} rejects DEL`, () => {
      expect(() => ctor(`foo${DEL}bar`)).toThrow(TypeError);
    });
    it(`${name} rejects C1 control (NEL)`, () => {
      expect(() => ctor(`foo${C1_CONTROL}bar`)).toThrow(TypeError);
    });
    it(`${name} rejects over-long string`, () => {
      expect(() => ctor("x".repeat(257))).toThrow(TypeError);
    });
    it(`${name} rejects non-NFKC value (compatibility ligature)`, () => {
      expect(() => ctor(NON_NFKC_LIGATURE)).toThrow(TypeError);
    });
  }
});

describe("QI id constructors — acceptance", () => {
  for (const [name, ctor] of constructors) {
    it(`${name} accepts NFKC-normalised ASCII`, () => {
      const value = `qi-${name.toLowerCase()}-01`;
      expect(ctor(value)).toBe(value);
    });
    it(`${name} accepts max-length value`, () => {
      const value = "a".repeat(256);
      expect(ctor(value)).toBe(value);
    });
    it(`${name} accepts NFKC-normalised composed UTF-8`, () => {
      expect(COMPOSED_E_ACUTE.normalize("NFKC")).toBe(COMPOSED_E_ACUTE);
      expect(ctor(COMPOSED_E_ACUTE)).toBe(COMPOSED_E_ACUTE);
    });
  }
});

describe("validateQualityIntelligenceIdString", () => {
  it("returns ok for a valid string", () => {
    expect(validateQualityIntelligenceIdString("abc-123", "RunId")).toEqual({ ok: true });
  });
  it("returns a typed failure for non-string input", () => {
    const result = validateQualityIntelligenceIdString(42, "RunId");
    expect(result).toEqual({ ok: false, reason: "RunId must be a string" });
  });
  it("returns a typed failure for null", () => {
    const result = validateQualityIntelligenceIdString(null, "RunId");
    expect(result).toEqual({ ok: false, reason: "RunId must be a string" });
  });
});

describe("Brand sanity", () => {
  it("constructed value is a plain string at runtime", () => {
    const run = asQualityIntelligenceRunId("run-001");
    expect(typeof run).toBe("string");
    expect(JSON.parse(JSON.stringify({ run })) as { run: string }).toEqual({ run: "run-001" });
  });
});
