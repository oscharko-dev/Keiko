import { describe, expect, it } from "vitest";
import {
  asQualityIntelligenceEvidenceAtomId,
  asQualityIntelligenceRunId,
  asQualityIntelligenceTestCaseId,
  asQualityIntelligenceValidationFindingId,
} from "../ids.js";
import {
  QUALITY_INTELLIGENCE_SEVERITIES,
  QUALITY_INTELLIGENCE_SEVERITY_RANK,
  QUALITY_INTELLIGENCE_VALIDATION_FINDING_KINDS,
} from "../validationFinding.js";
import type {
  QualityIntelligenceSeverity,
  QualityIntelligenceValidationFinding,
  QualityIntelligenceValidationFindingKind,
} from "../validationFinding.js";
import { assertQualityIntelligenceNever } from "../assertNever.js";

const makeFinding = (
  kind: QualityIntelligenceValidationFindingKind,
): QualityIntelligenceValidationFinding => ({
  kind,
  id: asQualityIntelligenceValidationFindingId(`finding-${kind}`),
  runId: asQualityIntelligenceRunId("run-001"),
  candidateId: asQualityIntelligenceTestCaseId("tc-001"),
  severity: "medium",
  summary: "redacted finding summary",
  evidenceAtomIds: [asQualityIntelligenceEvidenceAtomId("atom-1")],
});

const narrow = (f: QualityIntelligenceValidationFinding): string => {
  switch (f.kind) {
    case "logic-defect":
      return f.kind;
    case "faithfulness-defect":
      return f.kind;
    case "semantic-defect":
      return f.kind;
    case "mutation-defect":
      return f.kind;
    case "policy-violation":
      return f.kind;
    case "manual-rejection":
      return f.kind;
    case "coverage-gap":
      return f.kind;
    case "test-quality":
      return f.kind;
    default:
      return assertQualityIntelligenceNever(f);
  }
};

describe("QualityIntelligenceValidationFinding", () => {
  it("enumerates all eight kinds", () => {
    expect(QUALITY_INTELLIGENCE_VALIDATION_FINDING_KINDS).toEqual<
      readonly QualityIntelligenceValidationFindingKind[]
    >([
      "logic-defect",
      "faithfulness-defect",
      "semantic-defect",
      "mutation-defect",
      "policy-violation",
      "manual-rejection",
      "coverage-gap",
      "test-quality",
    ]);
  });

  it("narrows exhaustively over every kind", () => {
    for (const kind of QUALITY_INTELLIGENCE_VALIDATION_FINDING_KINDS) {
      expect(narrow(makeFinding(kind))).toBe(kind);
    }
  });

  it("permits absent candidateId for run-scoped findings", () => {
    const f: QualityIntelligenceValidationFinding = {
      kind: "policy-violation",
      id: asQualityIntelligenceValidationFindingId("finding-run-1"),
      runId: asQualityIntelligenceRunId("run-001"),
      severity: "high",
      summary: "policy violation against run",
      evidenceAtomIds: [],
    };
    expect(f.candidateId).toBeUndefined();
  });
});

describe("severity ordering", () => {
  it("ranks critical < high < medium < low (lower = more severe)", () => {
    const ordered: readonly QualityIntelligenceSeverity[] = [
      ...QUALITY_INTELLIGENCE_SEVERITIES,
    ].sort((a, b) => QUALITY_INTELLIGENCE_SEVERITY_RANK[a] - QUALITY_INTELLIGENCE_SEVERITY_RANK[b]);
    expect(ordered).toEqual<readonly QualityIntelligenceSeverity[]>([
      "critical",
      "high",
      "medium",
      "low",
    ]);
  });

  it("assigns a unique rank to each severity", () => {
    const ranks = QUALITY_INTELLIGENCE_SEVERITIES.map((s) => QUALITY_INTELLIGENCE_SEVERITY_RANK[s]);
    expect(new Set(ranks).size).toBe(ranks.length);
  });
});
