// Micro Focus ALM CSV export adapter tests (Epic #270, Issue #283).
//
// Validates: Designer constant, Subject = Subject/{riskClass}, M1 regression
// (expected results not dropped when steps < expected), StepName empty for
// expected-only trailing rows, TMS invariant.

import { describe, expect, it } from "vitest";
import { QualityIntelligence } from "@oscharko-dev/keiko-contracts";
import type {
  QualityIntelligenceExportBundle,
  QualityIntelligenceTestCaseCandidate,
} from "@oscharko-dev/keiko-contracts";
import { ALM_CSV_HEADERS, adaptToAlm } from "../adapters/alm.js";

const Q = QualityIntelligence;
const RUN = Q.asQualityIntelligenceRunId("qi-run-alm");

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
): QualityIntelligenceExportBundle {
  return {
    id: Q.asQualityIntelligenceExportBundleId("qi-export-alm"),
    runId: RUN,
    targetAdapter: "alm",
    createdAt: "2026-06-01T00:00:00.000Z",
    integrityHashSha256Hex: "0".repeat(64),
    redactionAttested: true,
    contents: candidates.map((c) => ({ candidateId: c.id, coverageMapRefs: [], findingRefs: [] })),
  };
}

/** Parse CSV output into rows of raw strings (splits on CRLF, ignores trailing empty). */
function parseRows(csv: string): string[][] {
  return csv
    .split("\r\n")
    .filter((line) => line.length > 0)
    .map((line) => line.split(","));
}

describe("adaptToAlm", () => {
  it("emits the ALM_CSV_HEADERS row as the first CSV line", () => {
    const c = candidate("tc-1");
    const out = adaptToAlm(bundle([c]), [c]);
    const firstRow = out.split("\r\n")[0];
    expect(firstRow).toBe(ALM_CSV_HEADERS.join(","));
  });

  it("Designer column is always 'keiko-quality-intelligence'", () => {
    const c = candidate("tc-1");
    const rows = parseRows(adaptToAlm(bundle([c]), [c]));
    const designerIdx = ALM_CSV_HEADERS.indexOf("Designer");
    for (const row of rows.slice(1)) {
      expect(row[designerIdx]).toBe("keiko-quality-intelligence");
    }
  });

  it("Subject column is Subject/{riskClass}", () => {
    const c = candidate("tc-1", { riskClass: "compliance" });
    const rows = parseRows(adaptToAlm(bundle([c]), [c]));
    const subjectIdx = ALM_CSV_HEADERS.indexOf("Subject");
    expect(rows[1]?.[subjectIdx]).toBe("Subject/compliance");
  });

  it("Subject changes when riskClass changes", () => {
    const c = candidate("tc-1", { riskClass: "regression" });
    const rows = parseRows(adaptToAlm(bundle([c]), [c]));
    const subjectIdx = ALM_CSV_HEADERS.indexOf("Subject");
    expect(rows[1]?.[subjectIdx]).toBe("Subject/regression");
  });

  // M1 regression: more expected results than steps
  it("M1: produces TWO rows when steps.length=1 and expectedResults.length=2", () => {
    const c = candidate("tc-1", {
      steps: ["Only step"],
      expectedResults: ["Expected A", "Expected B"],
    });
    const rows = parseRows(adaptToAlm(bundle([c]), [c]));
    // Header + 2 rows (max(1,2)=2)
    expect(rows).toHaveLength(3);
    const allText = rows
      .slice(1)
      .map((r) => r.join(","))
      .join("\n");
    expect(allText).toContain("Expected A");
    expect(allText).toContain("Expected B");
  });

  it("M1: produces rows for BOTH expected values when steps.length=0 and expectedResults.length=2", () => {
    const c = candidate("tc-1", { steps: [], expectedResults: ["Exp A", "Exp B"] });
    const rows = parseRows(adaptToAlm(bundle([c]), [c]));
    // Header + 2 rows (max(0,2)=2)
    expect(rows).toHaveLength(3);
    const allText = rows
      .slice(1)
      .map((r) => r.join(","))
      .join("\n");
    expect(allText).toContain("Exp A");
    expect(allText).toContain("Exp B");
  });

  it("M1: produces a single empty-step row when steps=0 and expectedResults=0", () => {
    const c = candidate("tc-1", { steps: [], expectedResults: [] });
    const rows = parseRows(adaptToAlm(bundle([c]), [c]));
    // Header + 1 empty-step row
    expect(rows).toHaveLength(2);
  });

  it("StepName is empty for expected-only trailing rows (no matching step)", () => {
    const c = candidate("tc-1", { steps: ["Step 1"], expectedResults: ["E1", "E2"] });
    const rows = parseRows(adaptToAlm(bundle([c]), [c]));
    const stepNameIdx = ALM_CSV_HEADERS.indexOf("StepName");
    // Row 1 = "Step 1", Row 2 = expected-only (no step)
    expect(rows[1]?.[stepNameIdx]).toBe("Step 1");
    expect(rows[2]?.[stepNameIdx]).toBe("");
  });

  it("sorts candidates by id ascending regardless of input order", () => {
    const a = candidate("tc-a", { title: "Alpha" });
    const z = candidate("tc-z", { title: "Zulu" });
    const out = adaptToAlm(bundle([z, a]), [z, a]);
    expect(out.indexOf("Alpha")).toBeLessThan(out.indexOf("Zulu"));
  });

  it("is deterministic: identical input yields byte-identical output", () => {
    const c = candidate("tc-1");
    const b = bundle([c]);
    expect(adaptToAlm(b, [c])).toBe(adaptToAlm(b, [c]));
  });

  it("throws when redactionAttested is false (TMS invariant)", () => {
    const c = candidate("tc-1");
    const b: QualityIntelligenceExportBundle = {
      id: Q.asQualityIntelligenceExportBundleId("qi-export-alm"),
      runId: RUN,
      targetAdapter: "alm",
      createdAt: "2026-06-01T00:00:00.000Z",
      integrityHashSha256Hex: "0".repeat(64),
      redactionAttested: false,
      contents: [{ candidateId: c.id, coverageMapRefs: [], findingRefs: [] }],
    };
    expect(() => adaptToAlm(b, [c])).toThrow(/redactionAttested/u);
  });
});
