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

  // ─── Logic-defect severity assertions ─────────────────────────────────────
  // Each assertion targets the exact severity so a "always emit 'low'" mutant
  // is killed immediately (the current severities are high/high/high/medium).

  it("emits a HIGH logic-defect when the title is empty after trim", () => {
    // Kills: mutant that changes severity from "high" to anything else.
    const findings = validateCandidates(RUN_ID, [baseCandidate({ title: "   " })]);
    const defect = findings.find((f) => f.kind === "logic-defect" && f.summary.includes("title"));
    expect(defect).toBeDefined();
    expect(defect?.kind).toBe("logic-defect");
    expect(defect?.severity).toBe("high");
  });

  it("emits a HIGH logic-defect when there are no steps", () => {
    // Kills: mutant that changes "high" to "medium"/"low" for the no-steps rule.
    const findings = validateCandidates(RUN_ID, [baseCandidate({ steps: [] })]);
    const defect = findings.find((f) => f.kind === "logic-defect" && f.summary.includes("steps"));
    expect(defect).toBeDefined();
    expect(defect?.severity).toBe("high");
  });

  it("emits a HIGH logic-defect when there are no expected results", () => {
    // Kills: mutant that changes "high" to "medium"/"low" for the no-results rule.
    const findings = validateCandidates(RUN_ID, [baseCandidate({ expectedResults: [] })]);
    const defect = findings.find(
      (f) => f.kind === "logic-defect" && f.summary.includes("expected results"),
    );
    expect(defect).toBeDefined();
    expect(defect?.severity).toBe("high");
  });

  it("emits a MEDIUM logic-defect when the step sequence contains a canonical repeat", () => {
    // Kills: mutant that changes "medium" to "high"/"low" for the step-repeat rule.
    const findings = validateCandidates(RUN_ID, [
      baseCandidate({ steps: ["Open login page", "OPEN login PAGE", "Submit"] }),
    ]);
    const defect = findings.find((f) => f.kind === "logic-defect" && f.summary.includes("repeat"));
    expect(defect).toBeDefined();
    expect(defect?.severity).toBe("medium");
  });

  // ─── Contradiction XOR parity — true-positive (strengthen existing test) ──

  it("emits a MEDIUM semantic-defect on a trivial precondition-vs-result contradiction", () => {
    // Kills: mutant that changes severity, OR that emits no finding on opposite parity.
    // precondition positive "logged in" + expected negative "not logged in" → XOR = true → contradiction.
    const findings = validateCandidates(RUN_ID, [
      baseCandidate({
        preconditions: ["the user is logged in"],
        expectedResults: ["the user is not logged in"],
      }),
    ]);
    const defect = findings.find((f) => f.kind === "semantic-defect");
    expect(defect).toBeDefined();
    expect(defect?.kind).toBe("semantic-defect");
    expect(defect?.severity).toBe("medium");
  });

  // ─── XOR parity false-positive guard ──────────────────────────────────────

  it("does NOT emit a semantic-defect when both precondition and expected-result are negated (consistent)", () => {
    // Kills: mutant that removes the XOR check and emits a defect whenever cores match
    // regardless of parity (i.e. the old broken XNOR/equality-only path).
    // Both sides: "the user is not logged in" → negatedPre=true, negatedResult=true → XOR=false → no contradiction.
    const findings = validateCandidates(RUN_ID, [
      baseCandidate({
        preconditions: ["the user is not logged in"],
        expectedResults: ["the user is not logged in"],
      }),
    ]);
    const semanticDefects = findings.filter((f) => f.kind === "semantic-defect");
    expect(semanticDefects).toHaveLength(0);
  });

  it("emits a semantic-defect when precondition is negated and expected-result is positive (reverse contradiction)", () => {
    // Kills: mutant that only fires when pre=positive AND result=negated (wrong directionality).
    // precondition "not logged in" (negated) + expected "logged in" (positive) → XOR=true → contradiction.
    const findings = validateCandidates(RUN_ID, [
      baseCandidate({
        preconditions: ["the user is not logged in"],
        expectedResults: ["the user is logged in"],
      }),
    ]);
    const defect = findings.find((f) => f.kind === "semantic-defect");
    expect(defect).toBeDefined();
    expect(defect?.severity).toBe("medium");
  });

  // ─── Additional baseline guard ─────────────────────────────────────────────

  it("does NOT emit a semantic-defect when both precondition and expected-result are positive (consistent)", () => {
    // Kills: mutant that treats any core-match (regardless of negation) as a contradiction.
    const findings = validateCandidates(RUN_ID, [
      baseCandidate({
        preconditions: ["the user is logged in"],
        expectedResults: ["the user is logged in"],
      }),
    ]);
    expect(findings.filter((f) => f.kind === "semantic-defect")).toHaveLength(0);
  });
});
