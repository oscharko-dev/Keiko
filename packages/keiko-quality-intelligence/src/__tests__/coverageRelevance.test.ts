import { describe, expect, it } from "vitest";

import { QualityIntelligence } from "@oscharko-dev/keiko-contracts";

import {
  buildAtomCoverageStatuses,
  buildCoverageMap,
  classifyAtomCoverage,
  COVERAGE_THRESHOLD_COVERED,
  COVERAGE_THRESHOLD_WEAKLY_COVERED,
  runCoveragePercentage,
} from "../domain/coverageRelevance.js";
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

// ─── Helper for synthetic atoms/mappings ────────────────────────────────────

function makeAtom(id: string): QualityIntelligence.QualityIntelligenceEvidenceAtom {
  return {
    id: QualityIntelligence.asQualityIntelligenceEvidenceAtomId(id),
    kind: "requirement",
    sourceEnvelopeId: QualityIntelligence.asQualityIntelligenceSourceEnvelopeId("env-1"),
    canonicalHashSha256Hex: "a".repeat(64),
    redactionStatus: "not-required",
    lifecycleStatus: "draft",
  };
}

function makeMapping(
  atomId: string,
  confidence: number,
  candidateIds: readonly string[],
): QualityIntelligence.QualityIntelligenceCoverageMapping {
  return {
    atomId: QualityIntelligence.asQualityIntelligenceEvidenceAtomId(atomId),
    confidence,
    coverageKind: "derived",
    candidateIds: candidateIds.map((id) => QualityIntelligence.asQualityIntelligenceTestCaseId(id)),
  };
}

describe("classifyAtomCoverage", () => {
  it("classifies confidence >= 0.7 as covered", () => {
    const atom = makeAtom("atom-1");
    const mapping = makeMapping("atom-1", COVERAGE_THRESHOLD_COVERED, ["tc-1"]);
    const result = classifyAtomCoverage(atom, mapping);
    expect(result.status).toBe("covered");
    expect(result.atomId).toBe(atom.id);
    expect(result.coveringCandidateIds).toHaveLength(1);
  });

  it("classifies confidence exactly at 0.7 as covered (boundary)", () => {
    const atom = makeAtom("atom-1");
    const mapping = makeMapping("atom-1", 0.7, ["tc-1"]);
    expect(classifyAtomCoverage(atom, mapping).status).toBe("covered");
  });

  it("classifies confidence >= 0.3 and < 0.7 as weakly-covered", () => {
    const atom = makeAtom("atom-1");
    const mapping = makeMapping("atom-1", 0.5, ["tc-1"]);
    expect(classifyAtomCoverage(atom, mapping).status).toBe("weakly-covered");
  });

  it("classifies confidence exactly at 0.3 as weakly-covered (boundary)", () => {
    const atom = makeAtom("atom-1");
    const mapping = makeMapping("atom-1", COVERAGE_THRESHOLD_WEAKLY_COVERED, ["tc-1"]);
    expect(classifyAtomCoverage(atom, mapping).status).toBe("weakly-covered");
  });

  it("classifies confidence < 0.3 as uncovered", () => {
    const atom = makeAtom("atom-1");
    const mapping = makeMapping("atom-1", 0.1, []);
    expect(classifyAtomCoverage(atom, mapping).status).toBe("uncovered");
  });

  it("classifies undefined mapping as uncovered with confidence 0 and empty candidateIds", () => {
    const atom = makeAtom("atom-1");
    const result = classifyAtomCoverage(atom, undefined);
    expect(result.status).toBe("uncovered");
    expect(result.confidence).toBe(0);
    expect(result.coveringCandidateIds).toHaveLength(0);
  });
});

describe("buildAtomCoverageStatuses", () => {
  it("atoms with no mapping entry are classified as uncovered", () => {
    const atom = makeAtom("atom-orphan");
    const runId = QualityIntelligence.asQualityIntelligenceRunId("run-1");
    const map: QualityIntelligence.QualityIntelligenceCoverageMap = {
      id: QualityIntelligence.asQualityIntelligenceCoverageMapId("cov-1"),
      runId,
      mappings: [],
    };
    const statuses = buildAtomCoverageStatuses([atom], map);
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.status).toBe("uncovered");
  });

  it("sorts results by atomId ascending", () => {
    const atoms = ["atom-b", "atom-a", "atom-c"].map(makeAtom);
    const runId = QualityIntelligence.asQualityIntelligenceRunId("run-1");
    const map: QualityIntelligence.QualityIntelligenceCoverageMap = {
      id: QualityIntelligence.asQualityIntelligenceCoverageMapId("cov-1"),
      runId,
      mappings: [],
    };
    const statuses = buildAtomCoverageStatuses(atoms, map);
    const ids = statuses.map((s) => String(s.atomId));
    expect(ids).toEqual(["atom-a", "atom-b", "atom-c"]);
  });

  it("surfaces covering candidate ids for covered atoms", () => {
    const atom = makeAtom("atom-1");
    const runId = QualityIntelligence.asQualityIntelligenceRunId("run-1");
    const map: QualityIntelligence.QualityIntelligenceCoverageMap = {
      id: QualityIntelligence.asQualityIntelligenceCoverageMapId("cov-1"),
      runId,
      mappings: [makeMapping("atom-1", 0.9, ["tc-1", "tc-2"])],
    };
    const statuses = buildAtomCoverageStatuses([atom], map);
    expect(statuses[0]?.coveringCandidateIds).toHaveLength(2);
  });
});

describe("runCoveragePercentage", () => {
  it("returns 0 when the array is empty", () => {
    expect(runCoveragePercentage([])).toBe(0);
  });

  it("returns 100 when all atoms are covered", () => {
    const atom = makeAtom("atom-1");
    const runId = QualityIntelligence.asQualityIntelligenceRunId("run-1");
    const map: QualityIntelligence.QualityIntelligenceCoverageMap = {
      id: QualityIntelligence.asQualityIntelligenceCoverageMapId("cov-1"),
      runId,
      mappings: [makeMapping("atom-1", 0.9, ["tc-1"])],
    };
    const statuses = buildAtomCoverageStatuses([atom], map);
    expect(runCoveragePercentage(statuses)).toBe(100);
  });

  it("computes percentage correctly for a mixed set", () => {
    const atoms = ["atom-1", "atom-2", "atom-3", "atom-4"].map(makeAtom);
    const runId = QualityIntelligence.asQualityIntelligenceRunId("run-1");
    // atom-1: covered (0.9), atom-2: weakly-covered (0.5), atom-3: uncovered (no mapping)
    // atom-4: uncovered (0.1)
    const map: QualityIntelligence.QualityIntelligenceCoverageMap = {
      id: QualityIntelligence.asQualityIntelligenceCoverageMapId("cov-1"),
      runId,
      mappings: [
        makeMapping("atom-1", 0.9, ["tc-1"]),
        makeMapping("atom-2", 0.5, ["tc-2"]),
        makeMapping("atom-4", 0.1, []),
      ],
    };
    const statuses = buildAtomCoverageStatuses(atoms, map);
    // 1 covered out of 4 = 25%
    expect(runCoveragePercentage(statuses)).toBe(25);
  });
});
