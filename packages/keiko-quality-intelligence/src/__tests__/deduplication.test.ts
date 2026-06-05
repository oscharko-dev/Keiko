import { describe, expect, it } from "vitest";

import { QualityIntelligence } from "@oscharko-dev/keiko-contracts";

import {
  computeCandidateEquivalenceSignature,
  deduplicateCandidates,
} from "../domain/deduplication.js";

const baseCandidate = (
  overrides: Partial<QualityIntelligence.QualityIntelligenceTestCaseCandidate>,
): QualityIntelligence.QualityIntelligenceTestCaseCandidate => ({
  id: QualityIntelligence.asQualityIntelligenceTestCaseId("qi-candidate-aaaaaaaaaaaa"),
  runId: QualityIntelligence.asQualityIntelligenceRunId("qi-run-dedupe-0001"),
  derivedFromAtomIds: [
    QualityIntelligence.asQualityIntelligenceEvidenceAtomId("qi-atom-dedupe-001"),
  ],
  title: "Verify the login flow",
  preconditions: ["The user account exists"],
  steps: ["Open login page", "Enter credentials", "Submit form"],
  expectedResults: ["The user lands on the dashboard"],
  priority: "P1",
  riskClass: "functional",
  tags: ["theme:login"],
  status: "proposed",
  ...overrides,
});

describe("deduplicateCandidates", () => {
  it("returns the empty array on empty input", () => {
    expect(deduplicateCandidates([])).toEqual([]);
  });

  it("collapses two candidates whose canonical projection is identical", () => {
    const left = baseCandidate({
      id: QualityIntelligence.asQualityIntelligenceTestCaseId("qi-candidate-aaaaaaaaaaaa"),
    });
    const right = baseCandidate({
      id: QualityIntelligence.asQualityIntelligenceTestCaseId("qi-candidate-bbbbbbbbbbbb"),
      title: "  Verify the LOGIN flow  ", // whitespace + case-insensitive duplicate
    });
    const result = deduplicateCandidates([left, right]);
    expect(result.length).toBe(1);
    expect(result[0]?.id).toBe(left.id); // lexicographically smallest survives
  });

  it("preserves two candidates whose steps differ semantically", () => {
    const left = baseCandidate({});
    const right = baseCandidate({
      id: QualityIntelligence.asQualityIntelligenceTestCaseId("qi-candidate-bbbbbbbbbbbb"),
      steps: ["Open login page", "Enter different credentials", "Submit form"],
    });
    const result = deduplicateCandidates([left, right]);
    expect(result.length).toBe(2);
  });

  it("produces the same equivalence signature for whitespace-equivalent candidates", () => {
    const left = baseCandidate({});
    const right = baseCandidate({
      title: "\tverify the login flow\n",
    });
    expect(computeCandidateEquivalenceSignature(left)).toBe(
      computeCandidateEquivalenceSignature(right),
    );
  });

  it("produces different signatures for differing priority", () => {
    const left = baseCandidate({ priority: "P1" });
    const right = baseCandidate({ priority: "P3" });
    expect(computeCandidateEquivalenceSignature(left)).not.toBe(
      computeCandidateEquivalenceSignature(right),
    );
  });
});
