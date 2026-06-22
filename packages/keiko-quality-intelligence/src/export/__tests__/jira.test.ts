// Jira Issues CSV export adapter tests (Epic #270, Issue #283).
//
// Validates: header schema, priority mapping (P0-P3), Labels composition,
// description section ordering, TMS redaction invariant enforcement.

import { describe, expect, it } from "vitest";
import { QualityIntelligence } from "@oscharko-dev/keiko-contracts";
import type {
  QualityIntelligenceExportBundle,
  QualityIntelligenceTestCaseCandidate,
} from "@oscharko-dev/keiko-contracts";
import { JIRA_CSV_HEADERS, adaptToJiraIssues } from "../adapters/jira.js";

const Q = QualityIntelligence;
const RUN = Q.asQualityIntelligenceRunId("qi-run-jira");

function candidate(
  id: string,
  title: string,
  overrides?: Partial<QualityIntelligenceTestCaseCandidate>,
): QualityIntelligenceTestCaseCandidate {
  return {
    id: Q.asQualityIntelligenceTestCaseId(id),
    runId: RUN,
    derivedFromAtomIds: [Q.asQualityIntelligenceEvidenceAtomId("qi-atom-1")],
    title,
    preconditions: ["User is logged in"],
    steps: ["Open the page", "Submit the form"],
    expectedResults: ["The record is saved"],
    priority: "P1",
    riskClass: "functional",
    tags: ["smoke"],
    status: "proposed",
    ...overrides,
  };
}

function bundle(
  candidates: readonly QualityIntelligenceTestCaseCandidate[],
  overrides?: Partial<QualityIntelligenceExportBundle>,
): QualityIntelligenceExportBundle {
  return {
    id: Q.asQualityIntelligenceExportBundleId("qi-export-jira"),
    runId: RUN,
    targetAdapter: "jira-issues",
    createdAt: "2026-06-01T00:00:00.000Z",
    integrityHashSha256Hex: "0".repeat(64),
    redactionAttested: true,
    contents: candidates.map((c) => ({ candidateId: c.id, coverageMapRefs: [], findingRefs: [] })),
    ...overrides,
  };
}

describe("adaptToJiraIssues", () => {
  it("emits the JIRA_CSV_HEADERS row as the first CSV line", () => {
    const c = candidate("tc-1", "Login succeeds");
    const out = adaptToJiraIssues(bundle([c]), [c]);
    const firstLine = out.split("\r\n")[0];
    expect(firstLine).toBe(JIRA_CSV_HEADERS.join(","));
  });

  describe("priority mapping", () => {
    it.each([
      ["P0", "Highest"],
      ["P1", "High"],
      ["P2", "Medium"],
      ["P3", "Low"],
    ] as const)("maps %s to %s", (priority, expected) => {
      const c = candidate("tc-1", "T", { priority });
      const out = adaptToJiraIssues(bundle([c]), [c]);
      // Skip the header row, check the data row
      const dataRow = out.split("\r\n")[1];
      expect(dataRow).toContain(expected);
    });
  });

  it("puts riskClass and tags together in the Labels column", () => {
    const c = candidate("tc-1", "T", { riskClass: "compliance", tags: ["auth", "smoke"] });
    const out = adaptToJiraIssues(bundle([c]), [c]);
    const dataRow = out.split("\r\n")[1];
    // Labels = riskClass + tags joined by space
    expect(dataRow).toContain("compliance auth smoke");
  });

  it("Labels = riskClass only when tags is empty", () => {
    const c = candidate("tc-1", "T", { riskClass: "regression", tags: [] });
    const out = adaptToJiraIssues(bundle([c]), [c]);
    const dataRow = out.split("\r\n")[1];
    expect(dataRow).toContain("regression");
    // No trailing space after riskClass (empty tags join adds nothing)
    expect(dataRow).not.toContain("regression ");
  });

  describe("buildDescription section ordering", () => {
    it("puts Preconditions before Steps before Expected", () => {
      const c = candidate("tc-1", "T", {
        preconditions: ["Pre"],
        steps: ["Step 1"],
        expectedResults: ["Expected 1"],
      });
      const out = adaptToJiraIssues(bundle([c]), [c]);
      const preIndex = out.indexOf("Preconditions:");
      const stepsIndex = out.indexOf("Steps:");
      const expectedIndex = out.indexOf("Expected:");
      expect(preIndex).toBeLessThan(stepsIndex);
      expect(stepsIndex).toBeLessThan(expectedIndex);
    });

    it("omits Preconditions section when empty", () => {
      const c = candidate("tc-1", "T", { preconditions: [] });
      const out = adaptToJiraIssues(bundle([c]), [c]);
      expect(out).not.toContain("Preconditions:");
    });

    it("omits Steps section when empty", () => {
      const c = candidate("tc-1", "T", { steps: [] });
      const out = adaptToJiraIssues(bundle([c]), [c]);
      expect(out).not.toContain("Steps:");
    });

    it("omits Expected section when empty", () => {
      const c = candidate("tc-1", "T", { expectedResults: [] });
      const out = adaptToJiraIssues(bundle([c]), [c]);
      expect(out).not.toContain("Expected:");
    });
  });

  it("sorts candidates by id ascending regardless of input order", () => {
    const a = candidate("tc-a", "Alpha");
    const z = candidate("tc-z", "Zulu");
    const out = adaptToJiraIssues(bundle([z, a]), [z, a]);
    expect(out.indexOf("Alpha")).toBeLessThan(out.indexOf("Zulu"));
  });

  it("is deterministic: identical input yields byte-identical output", () => {
    const c = candidate("tc-1", "A");
    const b = bundle([c]);
    expect(adaptToJiraIssues(b, [c])).toBe(adaptToJiraIssues(b, [c]));
  });

  it("throws when redactionAttested is false (TMS invariant)", () => {
    const c = candidate("tc-1", "T");
    const b = bundle([c], { redactionAttested: false });
    expect(() => adaptToJiraIssues(b, [c])).toThrow(/redactionAttested/u);
  });

  it("throws when integrityHashSha256Hex is malformed", () => {
    const c = candidate("tc-1", "T");
    const b = bundle([c], { integrityHashSha256Hex: "not-a-hash" });
    expect(() => adaptToJiraIssues(b, [c])).toThrow();
  });
});
