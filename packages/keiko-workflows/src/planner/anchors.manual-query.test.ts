import { describe, expect, it } from "vitest";
import { extractRetrievalChannels } from "./references.js";

const SUBJECT = "What temperature trips the Vesper dosing interlock?";

describe("manual subject anchors survive presentation instructions", () => {
  it.each([
    `${SUBJECT} Cite the authoritative manual. Keep the answer under 100 words.`,
    `Cite the authoritative manual. Keep the answer under 100 words. ${SUBJECT}`,
    "Welche Temperatur löst die Vesper Dosieranlage aus? Antworte kurz mit Quellenangabe.",
  ])("retains the literal subject within the existing eight-anchor working set: %s", (text) => {
    const result = extractRetrievalChannels(text, 8);
    const terms = result.anchors.map((anchor) => anchor.term);
    expect(terms).toContain("vesper");
    expect(terms).toContain(text.startsWith("Welche") ? "temperatur" : "temperature");
    if (!text.startsWith("Welche")) expect(terms).toContain("trips");
    expect(result.anchors.length).toBeLessThanOrEqual(8);
    expect(result.references).toEqual([]);
  });

  it("preserves quoted and technical targets inside a presentation request", () => {
    const result = extractRetrievalChannels("Cite `ManualMode` and src/Manual.ts briefly.", 8);
    expect(result.anchors).toContainEqual({ term: "manualmode", kind: "identifier", weight: 0.9 });
    expect(result.references).toEqual([{ path: "src/Manual.ts", origin: "query" }]);
  });

  it.each(["answer", "manual", "cite", "words", "100"])(
    "retains %s when it is the requested subject rather than a presentation clause",
    (term) => {
      expect(extractRetrievalChannels(`What does ${term} mean?`, 8).anchors).toContainEqual({
        term,
        kind: "literal",
        weight: 0.5,
      });
    },
  );
});
