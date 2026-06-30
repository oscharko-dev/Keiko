import { describe, expect, it } from "vitest";

import { lexicalRelevance, tokenize } from "./relevance.js";
import { buildRecord } from "./_support.js";

describe("tokenize", () => {
  it("lowercases and splits on non-word characters", () => {
    expect(tokenize("Hello, World! 123.")).toEqual(["hello", "world", "123"]);
  });

  it("deduplicates repeated tokens", () => {
    expect(tokenize("apple Apple apple")).toEqual(["apple"]);
  });

  it("folds German umlauts, ß, and common function words", () => {
    expect(tokenize("Was ist die Größe der Straße?")).toEqual(["grosse", "strasse"]);
  });

  it("normalizes simple German inflection suffixes deterministically", () => {
    expect(tokenize("Datenbank-Konfigurationen und Konfiguration")).toEqual([
      "datenbank",
      "konfiguration",
    ]);
  });

  it("returns an empty array for empty input", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("   ,;.")).toEqual([]);
  });
});

describe("lexicalRelevance", () => {
  it("returns 0 when query is empty", () => {
    const record = buildRecord({ body: "anything" });
    expect(lexicalRelevance("", record)).toBe(0);
    expect(lexicalRelevance(undefined, record)).toBe(0);
  });

  it("returns 0 for a non-empty query that tokenises to nothing", () => {
    // Punctuation-only query is non-empty but yields no tokens — the empty-query-token guard fires.
    expect(lexicalRelevance("!!! ,,, ...", buildRecord({ body: "alpha beta" }))).toBe(0);
  });

  it("returns 0 when the record itself has no tokens", () => {
    expect(lexicalRelevance("alpha", buildRecord({ body: "", tags: [] }))).toBe(0);
  });

  it("returns 1.0 when query tokens exactly match record tokens", () => {
    const record = buildRecord({ body: "alpha beta" });
    expect(lexicalRelevance("alpha beta", record)).toBe(1);
  });

  it("returns Jaccard intersection / union for partial overlap", () => {
    const record = buildRecord({ body: "alpha beta gamma" });
    // query={alpha,delta}, record={alpha,beta,gamma}; intersection=1, union=4
    expect(lexicalRelevance("alpha delta", record)).toBeCloseTo(0.25);
  });

  it("matches German query and memory pairs despite umlauts and stopwords", () => {
    const record = buildRecord({ body: "Die Datenbank-Konfiguration liegt in München." });
    expect(lexicalRelevance("Was ist die Datenbank Konfiguration fuer Muenchen?", record)).toBeGreaterThan(
      0,
    );
  });

  it("includes tags in the record token set", () => {
    // body={alpha}, tag={beta} -> doc={alpha,beta}. Query={beta}: intersection=1, union=2.
    const withTag = buildRecord({ body: "alpha", tags: ["beta"] });
    expect(lexicalRelevance("beta", withTag)).toBeCloseTo(0.5);
    // Same query against a record WITHOUT the tag: zero. The tag was the only signal.
    const noTag = buildRecord({ body: "alpha" });
    expect(lexicalRelevance("beta", noTag)).toBe(0);
  });

  it("returns 0 when no tokens overlap", () => {
    const record = buildRecord({ body: "alpha" });
    expect(lexicalRelevance("zeta", record)).toBe(0);
  });

  it("is deterministic across repeated calls", () => {
    const record = buildRecord({ body: "alpha beta gamma" });
    const a = lexicalRelevance("alpha gamma", record);
    const b = lexicalRelevance("alpha gamma", record);
    expect(a).toBe(b);
  });
});
