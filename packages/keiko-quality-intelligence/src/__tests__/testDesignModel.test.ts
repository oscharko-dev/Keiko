import { describe, expect, it } from "vitest";

import { deriveIntent } from "../domain/intentDerivation.js";
import { bankingDefault, regressionDefault } from "../domain/policyProfile.js";
import { designTestCaseCandidates } from "../domain/testDesignModel.js";
import { loadFixture } from "./_fixtureLoader.js";

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
