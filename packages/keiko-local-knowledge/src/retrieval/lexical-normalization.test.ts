import { describe, expect, it } from "vitest";

import {
  LEXICAL_ANALYZER_KEY,
  analyzeLexicalText,
  lexicalExactTerms,
  lexicalExactText,
  lexicalIndexedText,
  lexicalQueryTermGroups,
  lexicalQueryTerms,
  lexicalTextTokens,
} from "./lexical-normalization.js";

describe("lexical analyzer", () => {
  it("exposes a stable analyzer key for reindex-relevant strategy keys", () => {
    expect(LEXICAL_ANALYZER_KEY).toBe("keiko-multilingual-bm25-analyzer-v2");
  });

  it("preserves German umlauts while allowing ae/oe/ue query variants", () => {
    const indexed = lexicalIndexedText("Überweisung für Verträge");
    expect(indexed).toContain("Überweisung");
    expect(indexed).toContain("überweisung");
    expect(indexed).toContain("verträge");
    expect(indexed).toContain("vertrag");
    expect(indexed).not.toContain("Uberweisung");

    const groups = lexicalQueryTermGroups(["Ueberweisung", "Vertraege"]);
    expect(groups[0]?.terms).toEqual(expect.arrayContaining(["ueberweisung", "überweisung"]));
    expect(groups[1]?.terms).toEqual(expect.arrayContaining(["vertraege", "verträge", "vertrag"]));
  });

  it("adds German singular/stem candidates for common inflections", () => {
    const terms = lexicalQueryTerms(["Rechnungen", "Zahlungen", "Kunden", "Verträge"]);
    expect(terms).toEqual(
      expect.arrayContaining(["rechnung", "zahlung", "kunde", "verträge", "vertrag"]),
    );

    const analyzed = analyzeLexicalText("Rechnungen Zahlungen Kunden Verträge");
    expect(analyzed.indexTerms).toEqual(
      expect.arrayContaining(["rechnung", "zahlung", "kunde", "vertrag"]),
    );
  });

  it("keeps ss and sharp-s originals while adding query-side variants", () => {
    const indexed = lexicalIndexedText("Straße Strasse");
    expect(indexed).toContain("straße");
    expect(indexed).toContain("strasse");

    expect(lexicalQueryTerms(["Strasse"])).toEqual(expect.arrayContaining(["strasse", "straße"]));
    expect(lexicalQueryTerms(["Straße"])).toEqual(expect.arrayContaining(["straße", "strasse"]));
  });

  it("extracts exact code, identifier, ticket, number, and path terms", () => {
    const text = "processPayment_v2 reads customer_id for TS_999 in src/foo.ts and build 42.";
    expect(lexicalExactTerms(text)).toEqual(
      expect.arrayContaining(["processpayment_v2", "customer_id", "ts_999", "src/foo.ts", "42"]),
    );
    const exact = lexicalExactText(text);
    expect(exact).toContain("processPayment_v2");
    expect(exact).toContain("processpayment_v2");
    expect(exact).toContain("src/foo.ts");
  });

  it("does not drop non-Latin scripts through Latin-only token rules", () => {
    const analyzed = analyzeLexicalText("契約書 支払い 고객번호");
    expect(lexicalTextTokens("契約書 支払い 고객번호")).toEqual(
      expect.arrayContaining(["契約書", "支払い", "고객번호"]),
    );
    expect(analyzed.indexTerms).toEqual(expect.arrayContaining(["契約書", "契約", "約書"]));
    expect(analyzed.indexTerms).toEqual(expect.arrayContaining(["支払い", "支払"]));
    expect(analyzed.indexTerms).toEqual(expect.arrayContaining(["고객번호", "고객"]));
  });
});
