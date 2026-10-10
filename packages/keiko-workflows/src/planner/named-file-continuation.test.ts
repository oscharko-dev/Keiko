import { describe, expect, it } from "vitest";
import { resolveQueryTargetDecision } from "./plan.js";

const FILE = "src/main.ts";
function decision(text: string): ReturnType<typeof resolveQueryTargetDecision> {
  return resolveQueryTargetDecision(
    { kind: "natural-language", text, caseSensitive: false, maxResults: 50, emittedAtMs: 1 },
    [],
  );
}

describe("request-local facts following an explicit named-file orientation", () => {
  it.each([
    `Return to ${FILE}.`,
    `Return to ${FILE}. Which function applies the operator's policy?`,
    `Read ${FILE}. Which method returns the selected value?`,
    `Open ${FILE}. What value does it return?`,
    `Kehre zu ${FILE} zurück. Welche Funktion wendet die Richtlinie an?`,
    `Zurück zu ${FILE}. Welche Methode liefert das Ergebnis?`,
    `Return to ${FILE}. Which function applies the operator's policy before source validation? Cite the current implementation lines, under 100 words.`,
  ])("binds only the positively parsed local fact: %s", (text) => {
    expect(decision(text).namedFileOnly).toBe(true);
  });

  it("does not derive a definition target from a current implementation citation instruction", () => {
    const result = decision(
      `Read ${FILE}. Cite the current implementation lines, under 100 words.`,
    );
    expect(result.definitionRequested).toBe(false);
    expect(result.targets.some((target) => target.term === "lines")).toBe(false);
  });

  it.each([
    `Return to ${FILE}. Which function applies policy in the entire repository?`,
    `Return to ${FILE}. Which function applies policy across all attached folders?`,
    `Return to ${FILE}. Which function applies policy in the requested workspace scope?`,
    `Return to ${FILE}. Which function calls another service?`,
    `Return to ${FILE}. Explain the history of the policy.`,
    `Return to ${FILE}. Where is DifferentService defined?`,
    `Return to ${FILE}. What are the pump reset delays?`,
    `Return to ${FILE}. Find "operator's policy".`,
    `Return to ${FILE}. Which function applies 'policy'?`,
    `Return to ${FILE}. Additional facts please.`,
    `Which function applies policy? Return to ${FILE}.`,
    `Return to ${FILE} and src/other.ts. Which function applies policy?`,
  ])("retains independent, ambiguous or unparsed source work: %s", (text) => {
    expect(decision(text).namedFileOnly).toBeUndefined();
  });
});
