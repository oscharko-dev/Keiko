// Xray CSV export adapter tests (Epic #270, Issue #283).
//
// Validates: TCID column = candidate.id, Data column empty, Manual TestType,
// M1 regression (expected results not dropped when steps < expected), deterministic ordering.

import { describe, expect, it } from "vitest";
import { QualityIntelligence } from "@oscharko-dev/keiko-contracts";
import type {
  QualityIntelligenceExportBundle,
  QualityIntelligenceTestCaseCandidate,
} from "@oscharko-dev/keiko-contracts";
import { XRAY_CSV_HEADERS, adaptToXray } from "../adapters/xray.js";

const Q = QualityIntelligence;
const RUN = Q.asQualityIntelligenceRunId("qi-run-xray");

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
    steps: ["Open the page", "Click submit"],
    expectedResults: ["Form is saved"],
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
    id: Q.asQualityIntelligenceExportBundleId("qi-export-xray"),
    runId: RUN,
    targetAdapter: "xray",
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

describe("adaptToXray", () => {
  it("emits the XRAY_CSV_HEADERS row as the first CSV line", () => {
    const c = candidate("tc-1");
    const out = adaptToXray(bundle([c]), [c]);
    const firstRow = out.split("\r\n")[0];
    expect(firstRow).toBe(XRAY_CSV_HEADERS.join(","));
  });

  it("TCID column equals the candidate id", () => {
    const c = candidate("tc-abc");
    const rows = parseRows(adaptToXray(bundle([c]), [c]));
    const tcidIdx = XRAY_CSV_HEADERS.indexOf("TCID");
    expect(rows[1]?.[tcidIdx]).toBe(c.id);
  });

  it("Data column is empty for all rows", () => {
    const c = candidate("tc-1", { steps: ["S1", "S2"], expectedResults: ["E1", "E2"] });
    const rows = parseRows(adaptToXray(bundle([c]), [c]));
    const dataIdx = XRAY_CSV_HEADERS.indexOf("Data");
    for (const row of rows.slice(1)) {
      expect(row[dataIdx]).toBe("");
    }
  });

  it("TestType column is 'Manual' for all rows", () => {
    const c = candidate("tc-1", { steps: ["S1", "S2"], expectedResults: ["E1", "E2"] });
    const rows = parseRows(adaptToXray(bundle([c]), [c]));
    const typeIdx = XRAY_CSV_HEADERS.indexOf("TestType");
    for (const row of rows.slice(1)) {
      expect(row[typeIdx]).toBe("Manual");
    }
  });

  // M1 regression: more expected results than steps
  it("M1: produces TWO rows when steps.length=1 and expectedResults.length=2", () => {
    const c = candidate("tc-1", {
      steps: ["Only step"],
      expectedResults: ["Expected A", "Expected B"],
    });
    const rows = parseRows(adaptToXray(bundle([c]), [c]));
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
    const rows = parseRows(adaptToXray(bundle([c]), [c]));
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
    const rows = parseRows(adaptToXray(bundle([c]), [c]));
    // Header + 1 empty-step row
    expect(rows).toHaveLength(2);
  });

  it("sorts candidates by id ascending regardless of input order", () => {
    const a = candidate("tc-a", { title: "Alpha" });
    const z = candidate("tc-z", { title: "Zulu" });
    const out = adaptToXray(bundle([z, a]), [z, a]);
    expect(out.indexOf("Alpha")).toBeLessThan(out.indexOf("Zulu"));
  });

  it("is deterministic: identical input yields byte-identical output", () => {
    const c = candidate("tc-1");
    const b = bundle([c]);
    expect(adaptToXray(b, [c])).toBe(adaptToXray(b, [c]));
  });

  it("throws when redactionAttested is false (TMS invariant)", () => {
    const c = candidate("tc-1");
    const b: QualityIntelligenceExportBundle = {
      id: Q.asQualityIntelligenceExportBundleId("qi-export-xray"),
      runId: RUN,
      targetAdapter: "xray",
      createdAt: "2026-06-01T00:00:00.000Z",
      integrityHashSha256Hex: "0".repeat(64),
      redactionAttested: false,
      contents: [{ candidateId: c.id, coverageMapRefs: [], findingRefs: [] }],
    };
    expect(() => adaptToXray(b, [c])).toThrow(/redactionAttested/u);
  });
});
