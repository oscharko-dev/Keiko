import { describe, expect, it } from "vitest";

import { QualityIntelligence } from "@oscharko-dev/keiko-contracts";

import { validateCandidates } from "../domain/validation.js";

const baseCandidate = (
  overrides: Partial<QualityIntelligence.QualityIntelligenceTestCaseCandidate>,
): QualityIntelligence.QualityIntelligenceTestCaseCandidate => ({
  id: QualityIntelligence.asQualityIntelligenceTestCaseId("qi-candidate-aaaaaaaaaaaa"),
  runId: QualityIntelligence.asQualityIntelligenceRunId("qi-run-validation-0001"),
  derivedFromAtomIds: [
    QualityIntelligence.asQualityIntelligenceEvidenceAtomId("qi-atom-validation-001"),
  ],
  title: "Verify the login flow",
  preconditions: ["The user is logged out"],
  steps: ["Open login page", "Enter credentials", "Submit form"],
  expectedResults: ["The user lands on the dashboard"],
  priority: "P1",
  riskClass: "functional",
  tags: [],
  status: "proposed",
  ...overrides,
});

const RUN_ID = QualityIntelligence.asQualityIntelligenceRunId("qi-run-validation-0001");

describe("validateCandidates", () => {
  it("returns no findings on a well-formed candidate", () => {
    expect(validateCandidates(RUN_ID, [baseCandidate({})])).toEqual([]);
  });

  it("returns no findings on empty input", () => {
    expect(validateCandidates(RUN_ID, [])).toEqual([]);
  });

  it("emits a logic-defect finding when the title is empty", () => {
    const findings = validateCandidates(RUN_ID, [baseCandidate({ title: "   " })]);
    const kinds = findings.map((finding) => finding.kind);
    expect(kinds).toContain("logic-defect");
  });

  it("emits a logic-defect finding when there are no steps", () => {
    const findings = validateCandidates(RUN_ID, [baseCandidate({ steps: [] })]);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((finding) => finding.kind === "logic-defect")).toBe(true);
  });

  it("emits a logic-defect finding when there are no expected results", () => {
    const findings = validateCandidates(RUN_ID, [baseCandidate({ expectedResults: [] })]);
    expect(findings.some((finding) => finding.kind === "logic-defect")).toBe(true);
  });

  it("emits a logic-defect finding when the step sequence contains a canonical repeat", () => {
    const findings = validateCandidates(RUN_ID, [
      baseCandidate({ steps: ["Open login page", "OPEN login PAGE", "Submit"] }),
    ]);
    expect(findings.some((finding) => finding.kind === "logic-defect")).toBe(true);
  });

  it("emits a semantic-defect finding on a trivial precondition-vs-result contradiction", () => {
    const findings = validateCandidates(RUN_ID, [
      baseCandidate({
        preconditions: ["the user is logged in"],
        expectedResults: ["the user is not logged in"],
      }),
    ]);
    expect(findings.some((finding) => finding.kind === "semantic-defect")).toBe(true);
  });
});
