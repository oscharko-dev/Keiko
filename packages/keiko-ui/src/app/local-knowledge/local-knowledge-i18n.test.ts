import { describe, expect, it } from "vitest";
import { UNSUPPORTED_DOCUMENT_GUIDANCE_CODES } from "@oscharko-dev/keiko-contracts/runtime/local-knowledge-records";

import { translateLocalKnowledge, unsupportedGuidanceText } from "./local-knowledge-i18n";

describe("local knowledge translations", () => {
  it("interpolates every named value in selected-document summaries", () => {
    expect(
      translateLocalKnowledge("en", "localKnowledge.detail.connect.selectedDocuments", {
        count: 3,
        root: "/repo/docs",
      }),
    ).toBe("Selected documents: 3 from /repo/docs");
    expect(
      translateLocalKnowledge("de", "localKnowledge.detail.diagnostics.groupAria", {
        severity: "Warnung",
        code: "PARSER_LIMIT",
        count: 2,
      }),
    ).toBe("Warnung: PARSER_LIMIT (2x)");
  });
});

// 0.3.0 release audit — the server may only send an unsupported-document REASON CODE; the operator
// copy is owned here. The list is read from the contract, so a code added there without catalog
// entries fails this suite instead of shipping an untranslated (or missing) next step.
describe("unsupported-document remediation copy", () => {
  it("resolves every contract code to distinct English and German text", () => {
    const english = new Set<string>();
    const german = new Set<string>();
    for (const code of UNSUPPORTED_DOCUMENT_GUIDANCE_CODES) {
      const en = unsupportedGuidanceText(code, (key, values) =>
        translateLocalKnowledge("en", key, values),
      );
      const de = unsupportedGuidanceText(code, (key, values) =>
        translateLocalKnowledge("de", key, values),
      );
      expect(en.length).toBeGreaterThan(0);
      expect(de.length).toBeGreaterThan(0);
      expect(de).not.toBe(en);
      expect(en).not.toContain(code);
      english.add(en);
      german.add(de);
    }
    expect(english).toHaveLength(UNSUPPORTED_DOCUMENT_GUIDANCE_CODES.length);
    expect(german).toHaveLength(UNSUPPORTED_DOCUMENT_GUIDANCE_CODES.length);
  });

  it("falls back to the generic remediation for an unknown or malformed code", () => {
    const en = (key: Parameters<typeof translateLocalKnowledge>[1]): string =>
      translateLocalKnowledge("en", key);
    const generic = unsupportedGuidanceText("unsupported-format", en);
    for (const unknown of ["", " ", "pdf-needs-ocr ", "PDF-NEEDS-OCR", "__proto__", "toString"]) {
      expect(unsupportedGuidanceText(unknown, en)).toBe(generic);
    }
  });
});
