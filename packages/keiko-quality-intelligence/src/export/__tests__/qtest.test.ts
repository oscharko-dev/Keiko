// qTest CSV export adapter tests (Epic #270, Issue #283).
//
// Validates: one-row-per-step shape, M1 regression (steps/expectedResults mismatch),
// empty-step zero-row edge case, deterministic ordering.

import { describe, expect, it } from "vitest";
import { QualityIntelligence } from "@oscharko-dev/keiko-contracts";
import type {
  QualityIntelligenceExportBundle,
  QualityIntelligenceTestCaseCandidate,
} from "@oscharko-dev/keiko-contracts";
import { QTEST_CSV_HEADERS, adaptToQtest } from "../adapters/qtest.js";

const Q = QualityIntelligence;
const RUN = Q.asQualityIntelligenceRunId("qi-run-qtest");

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
    priority: "P2",
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
    id: Q.asQualityIntelligenceExportBundleId("qi-export-qtest"),
    runId: RUN,
    targetAdapter: "qtest",
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

describe("adaptToQtest", () => {
  it("emits the QTEST_CSV_HEADERS row as the first CSV line", () => {
    const c = candidate("tc-1");
    const out = adaptToQtest(bundle([c]), [c]);
    const firstRow = out.split("\r\n")[0];
    expect(firstRow).toBe(QTEST_CSV_HEADERS.join(","));
  });

  it("produces one data row per step for a normal candidate (2 steps, 1 expected)", () => {
    const c = candidate("tc-1", { steps: ["Step A", "Step B"], expectedResults: ["Exp 1"] });
    const rows = parseRows(adaptToQtest(bundle([c]), [c]));
    // Header + 2 step rows
    expect(rows).toHaveLength(3);
    expect(rows[1]).toContain("Step A");
    expect(rows[2]).toContain("Step B");
  });

  // M1 regression: more expected results than steps
  it("M1: produces TWO rows when steps.length=1 and expectedResults.length=2", () => {
    const c = candidate("tc-1", {
      steps: ["Only step"],
      expectedResults: ["Expected A", "Expected B"],
    });
    const rows = parseRows(adaptToQtest(bundle([c]), [c]));
    // Header + 2 data rows (one per expected result since max(1,2)=2)
    expect(rows).toHaveLength(3);
    const dataRows = rows.slice(1);
    const allText = dataRows.map((r) => r.join(",")).join("\n");
    expect(allText).toContain("Expected A");
    expect(allText).toContain("Expected B");
  });

  it("M1: produces rows for BOTH expected values when steps.length=0 and expectedResults.length=2", () => {
    const c = candidate("tc-1", { steps: [], expectedResults: ["Exp A", "Exp B"] });
    const rows = parseRows(adaptToQtest(bundle([c]), [c]));
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
    const rows = parseRows(adaptToQtest(bundle([c]), [c]));
    // Header + 1 empty-step row
    expect(rows).toHaveLength(2);
  });

  it("sorts candidates by id ascending regardless of input order", () => {
    const a = candidate("tc-a", { title: "Alpha" });
    const z = candidate("tc-z", { title: "Zulu" });
    const out = adaptToQtest(bundle([z, a]), [z, a]);
    expect(out.indexOf("Alpha")).toBeLessThan(out.indexOf("Zulu"));
  });

  it("is deterministic: identical input yields byte-identical output", () => {
    const c = candidate("tc-1");
    const b = bundle([c]);
    expect(adaptToQtest(b, [c])).toBe(adaptToQtest(b, [c]));
  });

  it("throws when redactionAttested is false (TMS invariant)", () => {
    const c = candidate("tc-1");
    const b: QualityIntelligenceExportBundle = {
      id: Q.asQualityIntelligenceExportBundleId("qi-export-qtest"),
      runId: RUN,
      targetAdapter: "qtest",
      createdAt: "2026-06-01T00:00:00.000Z",
      integrityHashSha256Hex: "0".repeat(64),
      redactionAttested: false,
      contents: [{ candidateId: c.id, coverageMapRefs: [], findingRefs: [] }],
    };
    expect(() => adaptToQtest(b, [c])).toThrow(/redactionAttested/u);
  });

  it("step numbers start at 1 for the first step", () => {
    const c = candidate("tc-1", { steps: ["First", "Second"], expectedResults: ["E1", "E2"] });
    const rows = parseRows(adaptToQtest(bundle([c]), [c]));
    // StepNumber column is index 5 (0-based) in the header
    const stepNumIdx = QTEST_CSV_HEADERS.indexOf("StepNumber");
    expect(rows[1]?.[stepNumIdx]).toBe("1");
    expect(rows[2]?.[stepNumIdx]).toBe("2");
  });

  it("StepNumber is empty for expected-only trailing rows (no matching step)", () => {
    const c = candidate("tc-1", { steps: ["Step 1"], expectedResults: ["E1", "E2"] });
    const rows = parseRows(adaptToQtest(bundle([c]), [c]));
    const stepNumIdx = QTEST_CSV_HEADERS.indexOf("StepNumber");
    // Row 1 = step 1, Row 2 = extra expected (no step)
    expect(rows[1]?.[stepNumIdx]).toBe("1");
    expect(rows[2]?.[stepNumIdx]).toBe("");
  });
});
