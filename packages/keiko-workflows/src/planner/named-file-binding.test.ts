import { describe, expect, it } from "vitest";
import { resolveQueryTargetDecision } from "./plan.js";

const FILE = "src/main.ts";

function namedFileOnly(text: string): boolean {
  return (
    resolveQueryTargetDecision(
      {
        kind: "natural-language",
        text,
        caseSensitive: false,
        maxResults: 50,
        emittedAtMs: 1,
      },
      [],
    ).namedFileOnly === true
  );
}

describe("canonical completely parsed named-file requests", () => {
  it.each([
    `Read ${FILE}.`,
    `Explain ${FILE}. Cite implementation lines, under 100 words.`,
    `Explain \`${FILE}\`. Cite implementation lines, under 100 words.`,
    `Explain "${FILE}:301". Cite implementation lines.`,
    `Explain how ${FILE} separates learned knowledge from source evidence. Cite implementation lines, under 100 words.`,
    `Explain the trip temperature in manuals/operation.html. Cite the manual and keep the answer under 100 words.`,
    `Explain ${FILE} and src/second.ts. Cite implementation lines.`,
    `What value is documented for ${FILE}?`,
    `Welche Werte stehen zu ${FILE}? Bitte zitiere Quellzeilen.`,
  ])("accepts a fully bound request: %s", (text) => {
    expect(namedFileOnly(text)).toBe(true);
  });

  it.each([
    `Read ${FILE} while also explaining pump reset delays. Cite implementation lines.`,
    `Read ${FILE} unknown meaningful continuation.`,
    `Explain ${FILE} alongside pump reset delays.`,
    `Explain how ${FILE} works while also explaining pump reset delays.`,
    `Explain how ${FILE} works as well as pump reset delays.`,
    `Explain ${FILE}, explain pump reset delays.`,
    `Read ${FILE}. What are the pump reset delays?`,
    `Erkläre ${FILE} und beschreibe pump reset delays.`,
    `Erkläre wie ${FILE} arbeitet während du pump reset delays erklärst.`,
    `Read ${FILE} and explain "pump reset delays".`,
    "Explain learned knowledge and source evidence.",
  ])("keeps unknown or independently requested prose broad: %s", (text) => {
    expect(namedFileOnly(text)).toBe(false);
  });

  it("cannot certify paths clipped by the canonical reference projection", () => {
    const paths = Array.from({ length: 7 }, (_, index) => `src/part-${String(index)}.ts`);
    expect(namedFileOnly(`Explain ${paths.join(" ")}.`)).toBe(false);
  });
});
