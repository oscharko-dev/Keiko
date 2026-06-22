// Polarion CSV export adapter tests (Epic #270, Issue #283).
//
// Validates: severity mapping (P0->blocker .. P3->minor), TestSteps = semicolon-joined steps,
// expectedResults appear in Description and are not dropped, deterministic ordering.

import { describe, expect, it } from "vitest";
import { QualityIntelligence } from "@oscharko-dev/keiko-contracts";
import type {
  QualityIntelligenceExportBundle,
  QualityIntelligenceTestCaseCandidate,
} from "@oscharko-dev/keiko-contracts";
import { POLARION_CSV_HEADERS, adaptToPolarion } from "../adapters/polarion.js";

const Q = QualityIntelligence;
const RUN = Q.asQualityIntelligenceRunId("qi-run-polarion");

function candidate(
  id: string,
  overrides?: Partial<QualityIntelligenceTestCaseCandidate>,
): QualityIntelligenceTestCaseCandidate {
  return {
    id: Q.asQualityIntelligenceTestCaseId(id),
    runId: RUN,
    derivedFromAtomIds: [Q.asQualityIntelligenceEvidenceAtomId("qi-atom-1")],
    title: `Test ${id}`,
    preconditions: ["User is logged in"],
    steps: ["Open the page", "Submit the form"],
    expectedResults: ["The record is saved", "User sees confirmation"],
    priority: "P1",
    riskClass: "functional",
    tags: ["smoke"],
    status: "proposed",
    ...overrides,
  };
}

function bundle(
  candidates: readonly QualityIntelligenceTestCaseCandidate[],
): QualityIntelligenceExportBundle {
  return {
    id: Q.asQualityIntelligenceExportBundleId("qi-export-polarion"),
    runId: RUN,
    targetAdapter: "polarion",
    createdAt: "2026-06-01T00:00:00.000Z",
    integrityHashSha256Hex: "0".repeat(64),
    redactionAttested: true,
    contents: candidates.map((c) => ({ candidateId: c.id, coverageMapRefs: [], findingRefs: [] })),
  };
}

describe("adaptToPolarion", () => {
  it("emits the POLARION_CSV_HEADERS row as the first CSV line", () => {
    const c = candidate("tc-1");
    const out = adaptToPolarion(bundle([c]), [c]);
    const firstRow = out.split("\r\n")[0];
    expect(firstRow).toBe(POLARION_CSV_HEADERS.join(","));
  });

  describe("severity mapping", () => {
    it.each([
      ["P0", "blocker"],
      ["P1", "critical"],
      ["P2", "major"],
      ["P3", "minor"],
    ] as const)("maps priority %s to severity %s", (priority, severity) => {
      const c = candidate("tc-1", { priority });
      const out = adaptToPolarion(bundle([c]), [c]);
      const dataRow = out.split("\r\n")[1];
      expect(dataRow).toContain(severity);
    });
  });

  it("TestSteps column is semicolon-joined steps", () => {
    const c = candidate("tc-1", { steps: ["Step 1", "Step 2", "Step 3"] });
    const out = adaptToPolarion(bundle([c]), [c]);
    // Polarion produces one row per candidate, so all steps are in the TestSteps column
    expect(out).toContain("Step 1 ; Step 2 ; Step 3");
  });

  it("expectedResults appear in Description (Polarion keeps all expected — none dropped)", () => {
    const c = candidate("tc-1", {
      expectedResults: ["Result A", "Result B", "Result C"],
    });
    const out = adaptToPolarion(bundle([c]), [c]);
    expect(out).toContain("Result A");
    expect(out).toContain("Result B");
    expect(out).toContain("Result C");
  });

  it("expectedResults are joined with ' ; ' in Description", () => {
    const c = candidate("tc-1", { expectedResults: ["Exp A", "Exp B"] });
    const out = adaptToPolarion(bundle([c]), [c]);
    expect(out).toContain("Exp A ; Exp B");
  });

  it("omits Preconditions prefix in Description when preconditions is empty", () => {
    const c = candidate("tc-1", { preconditions: [], expectedResults: ["Only expected"] });
    const out = adaptToPolarion(bundle([c]), [c]);
    expect(out).not.toContain("Preconditions:");
    expect(out).toContain("Only expected");
  });

  it("produces one data row per candidate (Polarion flat shape, not one-per-step)", () => {
    const c = candidate("tc-1", { steps: ["S1", "S2", "S3"] });
    const out = adaptToPolarion(bundle([c]), [c]);
    const dataRows = out.split("\r\n").filter((line) => line.length > 0);
    // Header + 1 data row only
    expect(dataRows).toHaveLength(2);
  });

  it("sorts candidates by id ascending regardless of input order", () => {
    const a = candidate("tc-a", { title: "Alpha" });
    const z = candidate("tc-z", { title: "Zulu" });
    const out = adaptToPolarion(bundle([z, a]), [z, a]);
    expect(out.indexOf("Alpha")).toBeLessThan(out.indexOf("Zulu"));
  });

  it("is deterministic: identical input yields byte-identical output", () => {
    const c = candidate("tc-1");
    const b = bundle([c]);
    expect(adaptToPolarion(b, [c])).toBe(adaptToPolarion(b, [c]));
  });

  it("throws when redactionAttested is false (TMS invariant)", () => {
    const c = candidate("tc-1");
    const b: QualityIntelligenceExportBundle = {
      id: Q.asQualityIntelligenceExportBundleId("qi-export-polarion"),
      runId: RUN,
      targetAdapter: "polarion",
      createdAt: "2026-06-01T00:00:00.000Z",
      integrityHashSha256Hex: "0".repeat(64),
      redactionAttested: false,
      contents: [{ candidateId: c.id, coverageMapRefs: [], findingRefs: [] }],
    };
    expect(() => adaptToPolarion(b, [c])).toThrow(/redactionAttested/u);
  });
});
