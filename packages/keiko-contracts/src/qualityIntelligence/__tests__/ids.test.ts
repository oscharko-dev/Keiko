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
const SUPPLEMENTARY_PLANE_CHAR = "\u{1F600}"; // 😀 U+1F600, a 2-UTF-16-code-unit character

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

describe("QI id constructors — supplementary-plane character handling", () => {
  // A lone surrogate's code unit (and a real supplementary-plane code point) always falls well
  // outside the C0/DEL/C1 control ranges `hasControlCharacter` checks, so an id carrying an emoji
  // must be accepted, not mistaken for a control character.
  it("accepts an id containing a supplementary-plane character", () => {
    const value = `qi-run-${SUPPLEMENTARY_PLANE_CHAR}-01`;
    expect(asQualityIntelligenceRunId(value)).toBe(value);
  });

  it("still rejects a real control character sitting right next to a supplementary-plane character", () => {
    expect(() => asQualityIntelligenceRunId(`${SUPPLEMENTARY_PLANE_CHAR}${NUL}`)).toThrow(
      TypeError,
    );
  });
});

describe("validateQualityIntelligenceIdString", () => {
  it("returns ok for a valid string", () => {
    expect(validateQualityIntelligenceIdString("abc-123", "RunId")).toEqual({ ok: true });
  });
  it("returns ok for a valid string with internal hyphen", () => {
    expect(validateQualityIntelligenceIdString("run-001", "RunId")).toEqual({ ok: true });
  });
  it("returns a typed failure for non-string input", () => {
    const result = validateQualityIntelligenceIdString(42, "RunId");
    expect(result).toEqual({ ok: false, reason: "RunId must be a string" });
  });
  it("returns a typed failure for null", () => {
    const result = validateQualityIntelligenceIdString(null, "RunId");
    expect(result).toEqual({ ok: false, reason: "RunId must be a string" });
  });
  it("returns a typed failure for undefined", () => {
    const result = validateQualityIntelligenceIdString(undefined, "RunId");
    expect(result).toEqual({ ok: false, reason: "RunId must be a string" });
  });
  it("rejects string with both leading and trailing whitespace", () => {
    expect(validateQualityIntelligenceIdString(" run-001 ", "RunId")).toEqual({
      ok: false,
      reason: "RunId must not have leading or trailing whitespace",
    });
  });
  it("rejects string with trailing whitespace only", () => {
    expect(validateQualityIntelligenceIdString("run-001 ", "RunId")).toEqual({
      ok: false,
      reason: "RunId must not have leading or trailing whitespace",
    });
  });
  it("rejects string with leading whitespace only", () => {
    expect(validateQualityIntelligenceIdString(" run-001", "RunId")).toEqual({
      ok: false,
      reason: "RunId must not have leading or trailing whitespace",
    });
  });
  it("rejects string with leading tab", () => {
    expect(validateQualityIntelligenceIdString("\trun-001", "RunId")).toEqual({
      ok: false,
      reason: "RunId must not have leading or trailing whitespace",
    });
  });
});

describe("QI id constructors — surrounding-whitespace rejection", () => {
  for (const [name, ctor] of constructors) {
    it(`${name} rejects surrounding whitespace (" x ")`, () => {
      expect(() => ctor(" x ")).toThrow(TypeError);
    });
  }
});

describe("QI id constructors — regression: clean id still accepted", () => {
  for (const [name, ctor] of constructors) {
    it(`${name} accepts "run-001"`, () => {
      expect(ctor("run-001")).toBe("run-001");
    });
  }
});

// KEIKO-0252: branded ids are rendered in the browser (run summaries, evidence refs, candidate
// lists), and the sibling display-surface guard already rejects these code points — but the id
// validator checked only C0/C1/DEL controls, which none of them are, and NFKC does not remove them.
// An id containing U+202E renders as a different id than the one stored; a zero-width character
// makes two visually identical ids distinct, defeating the visual comparison a reviewer relies on.
describe("bidi and zero-width rejection", () => {
  const CONSTRUCTORS = [
    asQualityIntelligenceRunId,
    asQualityIntelligenceTestCaseId,
    asQualityIntelligenceCoverageMapId,
    asQualityIntelligenceValidationFindingId,
    asQualityIntelligenceReviewRecordId,
    asQualityIntelligenceExportBundleId,
    asQualityIntelligenceSourceEnvelopeId,
    asQualityIntelligenceEvidenceAtomId,
    asQualityIntelligenceAuditSummaryId,
  ];

  it.each([0x202e, 0x200b, 0x2066, 0x2060, 0x206f, 0x061c, 0xfeff])(
    "rejects an id containing U+%s in every branded constructor",
    (codePoint) => {
      const value = `run${String.fromCodePoint(codePoint)}001`;
      expect(validateQualityIntelligenceIdString(value, "runId").ok).toBe(false);
      for (const construct of CONSTRUCTORS) {
        expect(() => construct(value)).toThrow(TypeError);
      }
    },
  );

  it("names the reason distinctly from the control-character rejection", () => {
    const result = validateQualityIntelligenceIdString(
      `run${String.fromCodePoint(0x202e)}001`,
      "runId",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("runId contains invisible or reordering characters");
  });
});

describe("Brand sanity", () => {
  it("constructed value is a plain string at runtime", () => {
    const run = asQualityIntelligenceRunId("run-001");
    expect(typeof run).toBe("string");
    expect(JSON.parse(JSON.stringify({ run })) as { run: string }).toEqual({ run: "run-001" });
  });
});
