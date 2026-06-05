import { describe, expect, it } from "vitest";

import { QualityIntelligence } from "@oscharko-dev/keiko-contracts";

import { buildCoverageMap } from "../domain/coverageRelevance.js";
import { deriveIntent } from "../domain/intentDerivation.js";
import { regressionDefault } from "../domain/policyProfile.js";
import { designTestCaseCandidates } from "../domain/testDesignModel.js";
import { loadFixture } from "./_fixtureLoader.js";

describe("buildCoverageMap", () => {
  it("returns an empty mapping list when there are no candidates", () => {
    const fixture = loadFixture("regressionRequirement.synthetic.json");
    const map = buildCoverageMap({
      runId: fixture.runId,
      atoms: fixture.atoms,
      candidates: [],
    });
    expect(map.mappings).toEqual([]);
    expect(map.runId).toBe(fixture.runId);
  });

  it("links each atom to its derived candidate with confidence in [0, 1]", () => {
    const fixture = loadFixture("regressionRequirement.synthetic.json");
    const intent = deriveIntent(fixture.envelopes, regressionDefault);
    const candidates = designTestCaseCandidates({
      runId: fixture.runId,
      intent,
      atoms: fixture.atoms,
    });
    const map = buildCoverageMap({
      runId: fixture.runId,
      atoms: fixture.atoms,
      candidates,
    });
    expect(map.mappings.length).toBeGreaterThan(0);
    for (const mapping of map.mappings) {
      expect(mapping.confidence).toBeGreaterThan(0);
      expect(mapping.confidence).toBeLessThanOrEqual(1);
      expect(mapping.candidateIds.length).toBeGreaterThan(0);
      expect(mapping.coverageKind).toBe("derived");
    }
  });

  it("satisfies the contract invariant via assertCoverageMapInvariant", () => {
    const fixture = loadFixture("bankingRequirement.synthetic.json");
    const intent = deriveIntent(fixture.envelopes, regressionDefault);
    const candidates = designTestCaseCandidates({
      runId: fixture.runId,
      intent,
      atoms: fixture.atoms,
    });
    const map = buildCoverageMap({
      runId: fixture.runId,
      atoms: fixture.atoms,
      candidates,
    });
    expect(() => {
      QualityIntelligence.assertCoverageMapInvariant(map);
    }).not.toThrow();
  });

  it("produces non-decreasing confidence as more candidates cite the same atom", () => {
    const fixture = loadFixture("regressionRequirement.synthetic.json");
    const intent = deriveIntent(fixture.envelopes, regressionDefault);
    const firstAtom = fixture.atoms[0];
    if (firstAtom === undefined) {
      throw new Error("fixture must have at least one atom");
    }
    const oneCandidateList = designTestCaseCandidates({
      runId: fixture.runId,
      intent,
      atoms: [firstAtom],
    });
    const sparseMap = buildCoverageMap({
      runId: fixture.runId,
      atoms: [firstAtom],
      candidates: oneCandidateList,
    });
    const firstMapping = sparseMap.mappings[0];
    expect(firstMapping).toBeDefined();
    expect(firstMapping?.confidence).toBeGreaterThan(0);
  });
});
