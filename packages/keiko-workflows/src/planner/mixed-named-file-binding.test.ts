import { describe, expect, it } from "vitest";
import { resolveQueryTargetDecision } from "./plan.js";

const FILE = "src/main.ts";
function decision(text: string): ReturnType<typeof resolveQueryTargetDecision> {
  return resolveQueryTargetDecision(
    { kind: "natural-language", text, caseSensitive: false, maxResults: 50, emittedAtMs: 1 },
    [],
  );
}

describe("named source clauses beside explicitly general advice", () => {
  it.each([
    `Explain how ${FILE} applies the operator's policy.`,
    `Explain how ${FILE} doesn't discard the user's policy.`,
    `Explain how ${FILE} applies policy, with current implementation citations.`,
    `Explain ${FILE}. Keep it under 150 words.`,
    `Explain ${FILE}. Give a general process.`,
    `Explain how ${FILE} applies the operator's policy, with current implementation citations. Then separately give a general recommendation for communicating uncertainty. Keep it under 150 words.`,
    `Read ${FILE}; independently suggest general advice about organizing decisions.`,
    `Read ${FILE}. Separately provide general guidance on arranging work.`,
    `Erkläre wie ${FILE} arbeitet. Gib getrennt eine allgemeine Empfehlung zum Vergleichen von Möglichkeiten.`,
  ])("retains only positively requested source targets: %s", (text) => {
    expect(decision(text).namedFileOnly).toBe(true);
  });

  it("does not derive a source definition from the attached citation directive", () => {
    const result = decision(`Explain ${FILE}, with current implementation citations.`);
    expect(result.definitionRequested).toBe(false);
    expect(result.targets.some((target) => target.term === "citations")).toBe(false);
  });

  it.each([
    `Read ${FILE}. Give a general recommendation based on this manual.`,
    `Read ${FILE}. Give a general recommendation for interpreting the attached source.`,
    `Read ${FILE}. Give a general recommendation for decisions and explain pump reset delays.`,
    `Read ${FILE}. Explain pump reset delays.`,
    `Read ${FILE}. Give advice about pump reset delays.`,
    `Read ${FILE}. Gib eine allgemeine Empfehlung laut diesem Handbuch.`,
    `Read ${FILE}. Find "operator's policy".`,
    `Explain how ${FILE} doesn't fail. Find 'limits'.`,
  ])("keeps independently bound or unclassified source clauses broad: %s", (text) => {
    expect(decision(text).namedFileOnly).toBeUndefined();
  });
});
