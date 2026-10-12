import { describe, expect, it } from "vitest";
import { extractRetrievalChannels } from "./references.js";
import { extractAnchors } from "./anchors.js";
import { resolveQueryTargetDecision } from "./plan.js";

const SUBJECT = "What temperature trips the Vesper dosing interlock?";

describe("unquoted compound document identifiers", () => {
  it.each(["Unit-G42", "BATCH-7-Z", "ISO-9001", "engine-room-2", "HarborDock-8ac"])(
    "retains the complete %s target without changing a contextual request into a lookup",
    (identifier) => {
      const text = `For ${identifier}, how long may a shipment wait, what happens afterward, and who records the event? Cite the operational source.`;
      const anchors = extractAnchors({ text, maxAnchors: 8 }).anchors;
      const decision = resolveQueryTargetDecision(
        { kind: "natural-language", text, caseSensitive: false, maxResults: 50, emittedAtMs: 1 },
        anchors,
      );
      expect(decision.kind).toBe("contextual");
      expect(decision.definitionSymbol).toBeUndefined();
      expect(anchors).toContainEqual({
        term: identifier.toLowerCase(),
        kind: "literal",
        weight: 0.85,
      });
      expect(decision.targets).toEqual([]);
    },
  );

  it.each(["owner-approved", "source-only", "2026-10-12", "22-49"])(
    "does not promote ordinary prose or a numeric range/date: %s",
    (term) => {
      const anchors = extractAnchors({ text: `Explain the ${term} documentation.`, maxAnchors: 8 });
      expect(anchors.anchors.filter((anchor) => anchor.kind === "identifier")).toEqual([]);
    },
  );

  it("keeps quoted targets and paths under their existing interpretation", () => {
    const anchors = extractAnchors({
      text: 'Compare "Unit-G42" with docs/BATCH-7.md and https://example.invalid/ISO-9001.',
      maxAnchors: 8,
    }).anchors;
    expect(anchors).toContainEqual({ term: "unit-g42", kind: "quoted", weight: 1 });
    expect(anchors).toContainEqual({
      term: "docs/batch-7.md",
      sourceTerm: "docs/BATCH-7.md",
      kind: "path",
      weight: 0.95,
    });
    expect(
      anchors.filter((anchor) => anchor.kind === "identifier").map((anchor) => anchor.term),
    ).not.toContain("batch-7");
  });

  it("keeps case-sensitive spellings and the existing aggregate target budget", () => {
    const text = "Compare Unit-G42 and batch-7-Z.";
    expect(extractAnchors({ text, maxAnchors: 8, caseSensitive: true }).anchors).toEqual(
      expect.arrayContaining([
        { term: "Unit-G42", kind: "literal", weight: 0.85 },
        { term: "batch-7-Z", kind: "literal", weight: 0.85 },
      ]),
    );
    const clipped = extractAnchors({ text, maxAnchors: 1 });
    expect(clipped.anchors).toHaveLength(1);
    expect(clipped.truncated).toBe(true);
    const overlong = extractAnchors({ text: `Where is ${"A".repeat(4096)}-7?`, maxAnchors: 8 });
    expect(overlong.truncated).toBe(true);
    expect(overlong.anchors.some((anchor) => anchor.kind === "identifier")).toBe(false);
  });
});

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

describe("presentation directives retain substantive question syntax", () => {
  it.each([
    "How do I cite the manual?",
    "Can I cite the authoritative manual?",
    "Where should I answer briefly?",
    "How can I keep the answer under 100 words?",
    "Warum antworte kurz mit Quellenangabe?",
  ])("does not mask the requested subject in %s", (text) => {
    const result = extractRetrievalChannels(text, 8);
    expect(result.anchors.length).toBeGreaterThan(0);
    expect(result.anchors.map((anchor) => anchor.term)).toContain(
      text.includes("cite") ? "cite" : text.includes("answer") ? "answer" : "antworte",
    );
  });

  it.each([". ", "; ", "\n", "? Please "])(
    "recognizes a separate imperative after %j",
    (boundary) => {
      const result = extractRetrievalChannels(
        `Vesper temperature${boundary}Cite the authoritative manual. Keep the answer under 100 words.`,
        8,
      );
      expect(result.anchors.map((anchor) => anchor.term)).toEqual(["temperature", "vesper"]);
    },
  );
});
