import { describe, expect, it } from "vitest";
import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import { extractAnchors } from "./anchors.js";
import {
  directDefinitionSymbol,
  isDirectEvidenceLookup,
  requiresContextualEvidence,
} from "./plan.js";

function query(text: string): RetrievalQuery {
  return { kind: "natural-language", text, caseSensitive: false, maxResults: 20, emittedAtMs: 0 };
}
function anchors(text: string): ReturnType<typeof extractAnchors>["anchors"] {
  return extractAnchors({ text, maxAnchors: 20 }).anchors;
}

describe("contextual evidence query shape", () => {
  it.each([
    "Why does implementation of RetryWorker fail?",
    "Why does the declaration of RetryWorker cause an exception?",
    "Explain the implementation of RetryWorker.",
  ])("does not narrow contextual evidence to a definition: %s", (text) => {
    expect(directDefinitionSymbol(query(text), anchors(text))).toBeUndefined();
    expect(isDirectEvidenceLookup(query(text), anchors(text))).toBe(false);
  });

  it("retains the ordinary direct definition shape", () => {
    const text = "Where is RetryWorker implemented?";
    expect(directDefinitionSymbol(query(text), anchors(text))).toBe("retryworker");
    expect(isDirectEvidenceLookup(query(text), anchors(text))).toBe(true);
  });

  it.each([
    'Find the exact literal "why failed implementation".',
    "Find the exact literal 'Missing failure'.",
    'What value is documented for "Missing failure"?',
  ])("does not derive contextual intent from quoted data: %s", (text) => {
    expect(requiresContextualEvidence(query(text))).toBe(false);
  });

  it.each([
    "What does 'Smart Mode' do if it doesn't connect?",
    'Explain "Smart Mode',
    'Find the exact literal "Missing failure',
  ])("keeps ambiguous or contextual prose broad: %s", (text) => {
    expect(requiresContextualEvidence(query(text))).toBe(true);
  });

  it("keeps explicitly typed exact-symbol contents literal", () => {
    expect(
      requiresContextualEvidence({ ...query("why failed implementation"), kind: "exact-symbol" }),
    ).toBe(false);
  });
});
