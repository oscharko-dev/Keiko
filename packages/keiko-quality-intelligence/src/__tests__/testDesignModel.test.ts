import { describe, expect, it } from "vitest";

import type { QualityIntelligence } from "@oscharko-dev/keiko-contracts";

import { deriveIntent } from "../domain/intentDerivation.js";
import type { IntentSummary } from "../domain/intentDerivation.js";
import { bankingDefault, regressionDefault } from "../domain/policyProfile.js";
import { designTestCaseCandidates } from "../domain/testDesignModel.js";
import { loadFixture, type LoadedFixture } from "./_fixtureLoader.js";

// Unsafe bidi / zero-width / C0-C1 / DEL code points that must never reach a
// persisted (hence exported) candidate field. A code-point Set scan is used
// instead of a control-range regex literal (forbidden by no-control-regex).
const UNSAFE_CODE_POINTS = new Set<number>([
  0x0007, 0x007f, 0x009d, 0x061c, 0xfeff, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b,
  0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
]);

const hasUnsafeCodePoint = (value: string): boolean => {
  for (const ch of value) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined && UNSAFE_CODE_POINTS.has(cp)) {
      return true;
    }
  }
  return false;
};

const allFieldStrings = (
  candidate: QualityIntelligence.QualityIntelligenceTestCaseCandidate,
): readonly string[] => [
  candidate.title,
  ...candidate.preconditions,
  ...candidate.steps,
  ...candidate.expectedResults,
  ...candidate.tags,
];

// noUncheckedIndexedAccess + no-non-null-assertion: narrow via a throw-helper.
const firstEnvelope = (
  fixture: LoadedFixture,
): QualityIntelligence.QualityIntelligenceSourceEnvelope => {
  const envelope = fixture.envelopes[0];
  if (envelope === undefined) {
    throw new Error("fixture exposes no source envelopes");
  }
  return envelope;
};

// Build code points without embedding literal control/bidi bytes in the source file.
const RLO = String.fromCodePoint(0x202e);
const ZW = String.fromCodePoint(0x200b);
const C1 = String.fromCodePoint(0x009d);
const BOM = String.fromCodePoint(0xfeff);

describe("designTestCaseCandidates", () => {
  it("returns the empty array for an empty atom list", () => {
    const fixture = loadFixture("regressionRequirement.synthetic.json");
    const intent = deriveIntent(fixture.envelopes, regressionDefault);
    const result = designTestCaseCandidates({
      runId: fixture.runId,
      intent,
      atoms: [],
    });
    expect(result).toEqual([]);
  });

  it("derives one candidate per atom", () => {
    const fixture = loadFixture("regressionRequirement.synthetic.json");
    const intent = deriveIntent(fixture.envelopes, regressionDefault);
    const result = designTestCaseCandidates({
      runId: fixture.runId,
      intent,
      atoms: fixture.atoms,
    });
    expect(result.length).toBe(fixture.atoms.length);
    for (const candidate of result) {
      expect(candidate.status).toBe("proposed");
      expect(candidate.runId).toBe(fixture.runId);
      expect(candidate.steps.length).toBeGreaterThan(0);
      expect(candidate.expectedResults.length).toBeGreaterThan(0);
    }
  });

  it("derives deterministic candidate IDs: same input -> same IDs", () => {
    const fixture = loadFixture("bankingRequirement.synthetic.json");
    const intent = deriveIntent(fixture.envelopes, bankingDefault);
    const first = designTestCaseCandidates({
      runId: fixture.runId,
      intent,
      atoms: fixture.atoms,
    });
    const second = designTestCaseCandidates({
      runId: fixture.runId,
      intent,
      atoms: fixture.atoms,
    });
    expect(first.map((candidate) => candidate.id)).toEqual(second.map((candidate) => candidate.id));
  });

  it("derives the same candidate IDs when the input atom order is shuffled", () => {
    const fixture = loadFixture("bankingRequirement.synthetic.json");
    const intent = deriveIntent(fixture.envelopes, bankingDefault);
    const inOrder = designTestCaseCandidates({
      runId: fixture.runId,
      intent,
      atoms: fixture.atoms,
    });
    const reversed = designTestCaseCandidates({
      runId: fixture.runId,
      intent,
      atoms: [...fixture.atoms].reverse(),
    });
    const inOrderIds = [...inOrder.map((candidate) => candidate.id)].sort();
    const reversedIds = [...reversed.map((candidate) => candidate.id)].sort();
    expect(inOrderIds).toEqual(reversedIds);
  });

  it("round-trips through JSON without mutation", () => {
    const fixture = loadFixture("regressionRequirement.synthetic.json");
    const intent = deriveIntent(fixture.envelopes, regressionDefault);
    const candidates = designTestCaseCandidates({
      runId: fixture.runId,
      intent,
      atoms: fixture.atoms,
    });
    const round: unknown = JSON.parse(JSON.stringify(candidates));
    expect(round).toEqual(candidates);
  });
});

// Epic #711 / Issue #724 residual: the deterministic-baseline candidate builder is the
// production-default export path when no model is configured (local-first install). Its
// candidate fields must be export-safe — free of bidi/zero-width/control code points — just
// like the model path was hardened in #1038 (parseGeneratedCandidates). Untrusted text enters
// the deterministic builder only via `intent` (derived from source displayLabel, which
// sanitiseLabel does NOT strip these code points from), so the chokepoint lives in
// designTestCaseCandidates.
describe("designTestCaseCandidates — export-safe candidate text", () => {
  it("strips bidi/zero-width/control code points out of every candidate field", () => {
    const fixture = loadFixture("regressionRequirement.synthetic.json");
    const spoofedLabel = `Login ${ZW}flow user must approve ${RLO}reganam${C1} role ${BOM}grant`;
    const envelope = { ...firstEnvelope(fixture), displayLabel: spoofedLabel };
    const intent = deriveIntent([envelope], regressionDefault);

    // Precondition: the spoofing code points DID survive ingestion-side derivation, so this
    // test exercises the real residual rather than a sanitised input. If this fails the test
    // is no longer guarding the documented gap.
    expect(intent.requirementCandidates.some(hasUnsafeCodePoint)).toBe(true);

    const candidates = designTestCaseCandidates({
      runId: fixture.runId,
      intent,
      atoms: fixture.atoms,
    });
    expect(candidates.length).toBeGreaterThan(0);

    for (const candidate of candidates) {
      for (const field of allFieldStrings(candidate)) {
        expect(hasUnsafeCodePoint(field)).toBe(false);
      }
    }

    // The requirement text still flows through (only the spoofing code points are removed),
    // proving the field was exercised and not merely emptied.
    const everyExpectedResult = candidates.flatMap((candidate) => candidate.expectedResults);
    expect(everyExpectedResult.some((line) => line.includes("user must approve reganam"))).toBe(
      true,
    );
  });

  it("collapses a zero-width-spoofed theme into a single canonical tag (no duplicate)", () => {
    const fixture = loadFixture("regressionRequirement.synthetic.json");
    // Two tokens that differ only by an inner zero-width space: "login" and "log" + ZW + "in".
    const envelope = { ...firstEnvelope(fixture), displayLabel: `login log${ZW}in` };
    const intent = deriveIntent([envelope], regressionDefault);

    const candidates = designTestCaseCandidates({
      runId: fixture.runId,
      intent,
      atoms: fixture.atoms,
    });

    for (const candidate of candidates) {
      const themeTags = candidate.tags.filter((tag) => tag === "theme:login");
      expect(themeTags.length).toBe(1);
      expect(new Set(candidate.tags).size).toBe(candidate.tags.length);
      for (const tag of candidate.tags) {
        expect(hasUnsafeCodePoint(tag)).toBe(false);
      }
    }
  });

  it("drops a fragment that becomes empty after stripping (no blank precondition)", () => {
    const fixture = loadFixture("regressionRequirement.synthetic.json");
    const intent: IntentSummary = {
      themes: [],
      requirementCandidates: [`${ZW}${ZW}${ZW}`, "Genuine requirement that must hold"],
      riskHints: [],
      priorityHint: "unknown",
    };

    const candidates = designTestCaseCandidates({
      runId: fixture.runId,
      intent,
      atoms: fixture.atoms,
    });

    for (const candidate of candidates) {
      // The all-zero-width fragment strips to "" and is dropped entirely; only the genuine
      // requirement survives. Against the unfixed builder the zero-width fragment is retained,
      // so the length-1 assertion is what makes this mutation-proof.
      expect(candidate.preconditions).toEqual(["Genuine requirement that must hold"]);
      for (const precondition of candidate.preconditions) {
        expect(hasUnsafeCodePoint(precondition)).toBe(false);
      }
    }
  });

  it("does not shift candidate IDs when the source label carries spoofing code points", () => {
    const fixture = loadFixture("regressionRequirement.synthetic.json");
    const base = firstEnvelope(fixture);
    const cleanIntent = deriveIntent(
      [{ ...base, displayLabel: "Login flow user must approve role grant" }],
      regressionDefault,
    );
    const spoofedIntent = deriveIntent(
      [
        {
          ...base,
          displayLabel: `Login ${ZW}flow user must approve ${RLO}reganam${C1} role ${BOM}grant`,
        },
      ],
      regressionDefault,
    );
    const cleanIds = designTestCaseCandidates({
      runId: fixture.runId,
      intent: cleanIntent,
      atoms: fixture.atoms,
    }).map((candidate) => candidate.id);
    const spoofedIds = designTestCaseCandidates({
      runId: fixture.runId,
      intent: spoofedIntent,
      atoms: fixture.atoms,
    }).map((candidate) => candidate.id);
    expect(spoofedIds).toEqual(cleanIds);
  });
});
