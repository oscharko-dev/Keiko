// Generic Keiko-native CSV export adapter tests (Epic #270, Issue #283).
//
// Validates: exact header schema (all 13 columns including RunId and DerivedFromAtomIds),
// deterministic ordering by candidate id, formula-lead title is escaped.

import { describe, expect, it } from "vitest";
import { QualityIntelligence } from "@oscharko-dev/keiko-contracts";
import type {
  QualityIntelligenceExportBundle,
  QualityIntelligenceTestCaseCandidate,
} from "@oscharko-dev/keiko-contracts";
import { CSV_HEADERS, adaptToCsv } from "../adapters/csv.js";

const Q = QualityIntelligence;
const RUN = Q.asQualityIntelligenceRunId("qi-run-csv");

function candidate(
  id: string,
  overrides?: Partial<QualityIntelligenceTestCaseCandidate>,
): QualityIntelligenceTestCaseCandidate {
  return {
    id: Q.asQualityIntelligenceTestCaseId(id),
    runId: RUN,
    derivedFromAtomIds: [
      Q.asQualityIntelligenceEvidenceAtomId("qi-atom-1"),
      Q.asQualityIntelligenceEvidenceAtomId("qi-atom-2"),
    ],
    title: `Test ${id}`,
    preconditions: ["User is logged in"],
    steps: ["Open the page", "Submit the form"],
    expectedResults: ["The record is saved"],
    priority: "P1",
    riskClass: "functional",
    tags: ["smoke", "regression"],
    status: "proposed",
    ...overrides,
  };
}

function bundle(
  candidates: readonly QualityIntelligenceTestCaseCandidate[],
): QualityIntelligenceExportBundle {
  return {
    id: Q.asQualityIntelligenceExportBundleId("qi-export-csv"),
    runId: RUN,
    // csv adapter is NOT TMS-bound so no redactionAttested requirement
    targetAdapter: "csv",
    createdAt: "2026-06-01T00:00:00.000Z",
    integrityHashSha256Hex: "0".repeat(64),
    redactionAttested: false,
    contents: candidates.map((c) => ({ candidateId: c.id, coverageMapRefs: [], findingRefs: [] })),
  };
}

describe("adaptToCsv", () => {
  it("emits exactly the expected CSV_HEADERS as the first row", () => {
    const c = candidate("tc-1");
    const out = adaptToCsv(bundle([c]), [c]);
    const firstRow = out.split("\r\n")[0];
    expect(firstRow).toBe(CSV_HEADERS.join(","));
  });

  it("CSV_HEADERS contains all required columns including RunId and DerivedFromAtomIds", () => {
    expect(CSV_HEADERS).toContain("CandidateId");
    expect(CSV_HEADERS).toContain("RunId");
    expect(CSV_HEADERS).toContain("Title");
    expect(CSV_HEADERS).toContain("Priority");
    expect(CSV_HEADERS).toContain("RiskClass");
    expect(CSV_HEADERS).toContain("Status");
    expect(CSV_HEADERS).toContain("Tags");
    expect(CSV_HEADERS).toContain("Preconditions");
    expect(CSV_HEADERS).toContain("Steps");
    expect(CSV_HEADERS).toContain("ExpectedResults");
    expect(CSV_HEADERS).toContain("DerivedFromAtomIds");
    expect(CSV_HEADERS).toContain("CoverageMapRefs");
    expect(CSV_HEADERS).toContain("FindingRefs");
  });

  it("CSV_HEADERS has exactly 13 columns", () => {
    expect(CSV_HEADERS).toHaveLength(13);
  });

  it("data row includes the candidateId in the first column", () => {
    const c = candidate("tc-abc");
    const out = adaptToCsv(bundle([c]), [c]);
    const dataRow = out.split("\r\n")[1];
    expect(dataRow).toContain(c.id);
  });

  it("data row includes the runId", () => {
    const c = candidate("tc-1");
    const out = adaptToCsv(bundle([c]), [c]);
    expect(out).toContain(RUN);
  });

  it("data row includes derivedFromAtomIds joined by ' ; '", () => {
    const c = candidate("tc-1");
    const out = adaptToCsv(bundle([c]), [c]);
    expect(out).toContain("qi-atom-1 ; qi-atom-2");
  });

  it("sorts candidates by id ascending regardless of input order", () => {
    const a = candidate("tc-a", { title: "Alpha" });
    const z = candidate("tc-z", { title: "Zulu" });
    const out = adaptToCsv(bundle([z, a]), [z, a]);
    expect(out.indexOf("Alpha")).toBeLessThan(out.indexOf("Zulu"));
  });

  it("escapes a formula-lead title with a single quote prefix", () => {
    const c = candidate("tc-1", { title: "=FORMULA" });
    const out = adaptToCsv(bundle([c]), [c]);
    // The title cell gets the ' prefix when it starts with '='
    expect(out).toContain("'=FORMULA");
    // The raw formula must NOT appear unescaped
    expect(out).not.toContain(",=FORMULA,");
  });

  it("is deterministic: identical input yields byte-identical output", () => {
    const c = candidate("tc-1");
    const b = bundle([c]);
    expect(adaptToCsv(b, [c])).toBe(adaptToCsv(b, [c]));
  });

  it("works when redactionAttested is false (csv is not TMS-bound)", () => {
    const c = candidate("tc-1");
    const b = bundle([c]);
    // Must not throw — csv adapter has no TMS attestation requirement
    expect(() => adaptToCsv(b, [c])).not.toThrow();
  });

  it("throws when integrityHashSha256Hex is malformed", () => {
    const c = candidate("tc-1");
    const b: QualityIntelligenceExportBundle = {
      ...bundle([c]),
      integrityHashSha256Hex: "bad-hash",
    };
    expect(() => adaptToCsv(b, [c])).toThrow();
  });
});
