import { describe, expect, it } from "vitest";

import { QualityIntelligence } from "@oscharko-dev/keiko-contracts";

import {
  buildAtomCoverageStatuses,
  buildCoverageMap,
  classifyAtomCoverage,
  COVERAGE_THRESHOLD_COVERED,
  COVERAGE_THRESHOLD_WEAKLY_COVERED,
  coverageConfidence,
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

// ─── Helper for synthetic candidates with controllable citation/focus ────────

function makeCandidate(
  id: string,
  derivedFromAtomIds: readonly string[],
): QualityIntelligence.QualityIntelligenceTestCaseCandidate {
  return {
    id: QualityIntelligence.asQualityIntelligenceTestCaseId(id),
    runId: QualityIntelligence.asQualityIntelligenceRunId("run-1"),
    derivedFromAtomIds: derivedFromAtomIds.map((a) =>
      QualityIntelligence.asQualityIntelligenceEvidenceAtomId(a),
    ),
    title: `Test ${id}`,
    preconditions: [],
    steps: ["do the thing"],
    expectedResults: ["the behaviour matches the cited evidence"],
    priority: "P2",
    riskClass: "functional",
    tags: [],
    status: "proposed",
  };
}

describe("coverageConfidence (run-size independence)", () => {
  it("is independent of the total number of candidates in the run", () => {
    // Same atom-local inputs (1 focused citer) => same confidence regardless of run size.
    expect(coverageConfidence(1, 1)).toBeCloseTo(coverageConfidence(1, 1));
    expect(coverageConfidence(1, 1)).toBeGreaterThanOrEqual(COVERAGE_THRESHOLD_COVERED);
  });

  it("classifies a single dedicated (focused) test as covered, not weak", () => {
    expect(coverageConfidence(1, 1)).toBeGreaterThanOrEqual(COVERAGE_THRESHOLD_COVERED);
  });

  it("is monotonic non-decreasing in the citer count", () => {
    expect(coverageConfidence(2, 1)).toBeGreaterThanOrEqual(coverageConfidence(1, 1));
    expect(coverageConfidence(3, 1)).toBeGreaterThanOrEqual(coverageConfidence(2, 1));
  });

  it("classifies broad-only coverage as weakly-covered (below the covered threshold)", () => {
    const conf = coverageConfidence(1, 9);
    expect(conf).toBeGreaterThanOrEqual(COVERAGE_THRESHOLD_WEAKLY_COVERED);
    expect(conf).toBeLessThan(COVERAGE_THRESHOLD_COVERED);
  });

  it("returns 0 for an atom with no citers", () => {
    expect(coverageConfidence(0, 1)).toBe(0);
  });
});

describe("buildCoverageMap — coverage is not diluted by run size (regression for the 0% bug)", () => {
  it("reports a perfectly-covered run as covered, NOT uncovered, regardless of run size", () => {
    // 8 atoms, each covered by exactly 3 dedicated (focus-1) tests = 24 candidates total.
    // The historical bug divided citedCount by candidates.length (24), yielding confidence 0.125
    // for every atom => all "uncovered", coverage 0%. The fix makes confidence atom-local.
    const atomCount = 8;
    const atoms = Array.from({ length: atomCount }, (_, i) => makeAtom(`atom-${String(i)}`));
    const candidates = atoms.flatMap((_atom, i) =>
      [0, 1, 2].map((k) => makeCandidate(`tc-${String(i)}-${String(k)}`, [`atom-${String(i)}`])),
    );
    const map = buildCoverageMap({
      runId: QualityIntelligence.asQualityIntelligenceRunId("run-1"),
      atoms,
      candidates,
    });
    const statuses = buildAtomCoverageStatuses(atoms, map);
    expect(statuses.every((s) => s.status === "covered")).toBe(true);
    expect(runCoveragePercentage(statuses)).toBe(100);
  });

  it("a run where each atom has exactly one dedicated test is 100% covered (no 1-test=0% surprise)", () => {
    const atoms = Array.from({ length: 6 }, (_, i) => makeAtom(`atom-${String(i)}`));
    const candidates = atoms.map((_atom, i) =>
      makeCandidate(`tc-${String(i)}`, [`atom-${String(i)}`]),
    );
    const map = buildCoverageMap({
      runId: QualityIntelligence.asQualityIntelligenceRunId("run-1"),
      atoms,
      candidates,
    });
    const statuses = buildAtomCoverageStatuses(atoms, map);
    expect(runCoveragePercentage(statuses)).toBe(100);
    statuses.forEach((s) => {
      expect(s.coveringCandidateIds.length).toBe(1);
    });
  });

  it("surfaces a genuinely uncovered atom while the rest are covered", () => {
    const atoms = ["atom-0", "atom-1", "atom-2"].map(makeAtom);
    // atom-2 has no citing candidate.
    const candidates = [makeCandidate("tc-0", ["atom-0"]), makeCandidate("tc-1", ["atom-1"])];
    const map = buildCoverageMap({
      runId: QualityIntelligence.asQualityIntelligenceRunId("run-1"),
      atoms,
      candidates,
    });
    const statuses = buildAtomCoverageStatuses(atoms, map);
    const uncovered = statuses.filter((s) => s.status === "uncovered");
    expect(uncovered).toHaveLength(1);
    expect(String(uncovered[0]?.atomId)).toBe("atom-2");
    expect(runCoveragePercentage(statuses)).toBeCloseTo((2 / 3) * 100);
  });

  it("classifies an atom covered only by a sprawling test as weakly-covered", () => {
    const atoms = Array.from({ length: 6 }, (_, i) => makeAtom(`atom-${String(i)}`));
    // A single broad test that derives from all 6 atoms — incidental coverage only.
    const broad = makeCandidate(
      "tc-broad",
      atoms.map((a) => String(a.id)),
    );
    const map = buildCoverageMap({
      runId: QualityIntelligence.asQualityIntelligenceRunId("run-1"),
      atoms,
      candidates: [broad],
    });
    const statuses = buildAtomCoverageStatuses(atoms, map);
    expect(statuses.every((s) => s.status === "weakly-covered")).toBe(true);
    expect(runCoveragePercentage(statuses)).toBe(0);
  });
});
