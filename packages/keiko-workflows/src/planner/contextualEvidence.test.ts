import { describe, expect, it } from "vitest";
import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import { extractAnchors } from "./anchors.js";
import {
  directDefinitionSymbol,
  isDirectEvidenceLookup,
  resolveQueryTargetDecision,
  requiresRelationshipOrHistoryRings,
} from "./plan.js";

function query(text: string): RetrievalQuery {
  return { kind: "natural-language", text, caseSensitive: false, maxResults: 20, emittedAtMs: 0 };
}
function anchors(text: string): ReturnType<typeof extractAnchors>["anchors"] {
  return extractAnchors({ text, maxAnchors: 20 }).anchors;
}

describe("contextual evidence query shape", () => {
  it.each([
    "Where was RetryWorker historically defined?",
    "Show the historical implementation of RetryWorker.",
    "Wo war RetryWorker historisch definiert?",
    "Zeige die historischen Definitionen von RetryWorker.",
  ])("retains history intent across ordinary word forms: %s", (text) => {
    expect(requiresRelationshipOrHistoryRings(query(text))).toBe(true);
    expect(isDirectEvidenceLookup(query(text), anchors(text))).toBe(false);
  });
  it.each([
    'Find the exact literal "historically".',
    'Find the exact literal "historische Definition".',
  ])("does not mistake quoted historical data for history work: %s", (text) => {
    expect(requiresRelationshipOrHistoryRings(query(text))).toBe(false);
    expect(resolveQueryTargetDecision(query(text), anchors(text)).kind).toBe("literal-search");
  });
  it.each([
    "Where are WindowFrame and ChatPanel implemented, and what values do they return?",
    "Where are InvoicePolicy and ParcelService defined and what value do they return?",
    "Where is RetryWorker implemented and what does RetryWorker return?",
  ])("fully parses compound definition and returned-value facts: %s", (text) => {
    expect(resolveQueryTargetDecision(query(text), anchors(text)).kind).toBe("direct-fact");
    expect(isDirectEvidenceLookup(query(text), anchors(text))).toBe(true);
  });

  it.each([
    "Where are InvoicePolicy and ParcelService defined and what value do they return to avoid errors?",
    "Where are InvoicePolicy and ParcelService defined and what values do they return? Explain why.",
    "Where are InvoicePolicy and ParcelService defined and how do they invoke RetryWorker?",
    "Where are InvoicePolicy and ParcelService defined and why does InvoicePolicy fail?",
    "Where are InvoicePolicy and ParcelService defined and what are their historical values?",
  ])("keeps unparsed contextual dimensions after compound facts: %s", (text) => {
    expect(resolveQueryTargetDecision(query(text), anchors(text)).kind).toBe("contextual");
    expect(isDirectEvidenceLookup(query(text), anchors(text))).toBe(false);
  });

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
    ['Find the exact literal "why failed implementation".', "literal-search"],
    ["Find the exact literal 'Missing failure'.", "literal-search"],
    ['What value is documented for "Missing failure"?', "direct-fact"],
  ])("does not derive contextual intent from quoted data: %s", (text, expected) => {
    expect(resolveQueryTargetDecision(query(text), anchors(text)).kind).toBe(expected);
  });

  it.each([
    "What does 'Smart Mode' do if it doesn't connect?",
    'Explain "Smart Mode',
    'Find the exact literal "Missing failure',
  ])("keeps ambiguous or contextual prose broad: %s", (text) => {
    expect(resolveQueryTargetDecision(query(text), anchors(text)).kind).toBe("contextual");
  });

  it("keeps explicitly typed exact-symbol contents literal", () => {
    const text = "why failed implementation";
    expect(
      resolveQueryTargetDecision({ ...query(text), kind: "exact-symbol" }, anchors(text)).kind,
    ).toBe("literal-search");
  });

  it("cannot authorize a complete literal command from a truncated target set", () => {
    const text = 'Find "First concept" and "Second concept".';
    expect(resolveQueryTargetDecision(query(text), anchors(text).slice(0, 1), 1).kind).toBe(
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
