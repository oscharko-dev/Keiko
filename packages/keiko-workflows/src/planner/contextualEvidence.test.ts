import { describe, expect, it } from "vitest";
import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import { extractAnchors } from "./anchors.js";
import {
  directDefinitionSymbol,
  isDirectEvidenceLookup,
  requiresContextualEvidence,
  resolveQueryTargetDecision,
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

  it("cannot authorize a complete literal command from a truncated target set", () => {
    const text = 'Find "First concept" and "Second concept".';
    expect(resolveQueryTargetDecision(query(text), anchors(text).slice(0, 1)).kind).toBe(
      "contextual",
    );
  });

  it.each([
    "What exactly does `retry_count` do?",
    'Describe "Smart Mode".',
    'Tell me about "Smart Mode".',
    "What value should `retry_count` have to avoid interruptions?",
    "Find `retry_count` and explain its purpose.",
    'Search for "retry_count" and describe its operation.',
    "Don't just find `retry_count`; give its context.",
    'Décris "Smart Mode" dans ce dossier.',
  ])("does not certify unparsed prose as a literal request: %s", (text) => {
    const decision = resolveQueryTargetDecision(query(text), anchors(text));
    expect(decision.kind).toBe("contextual");
    expect(decision.targets.length).toBeGreaterThan(0);
    expect(decision.definitionSymbol).toBeUndefined();
  });
});
