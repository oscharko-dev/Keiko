// Traceability export adapter tests (Epic #734, Issue #740).
//
// Determinism + formula-injection safety are load-bearing: the exported matrix is an audit
// artifact, so identical input must yield byte-identical output and no cell may start a
// spreadsheet formula.

import { describe, expect, it } from "vitest";
import {
  adaptToTraceabilityCsv,
  adaptToTraceabilityMarkdown,
  type QualityIntelligenceTraceabilityRow,
} from "../export/adapters/traceability.js";

const rows: readonly QualityIntelligenceTraceabilityRow[] = [
  { atomId: "atom-2", status: "uncovered", confidence: 0, coveringCandidateIds: [] },
  {
    atomId: "atom-1",
    status: "covered",
    confidence: 0.9,
    coveringCandidateIds: ["tc-1", "tc-2"],
  },
];

describe("adaptToTraceabilityCsv", () => {
  it("emits a header and one row per requirement atom, sorted by atom id", () => {
    const csv = adaptToTraceabilityCsv(rows);
    const lines = csv.trimEnd().split("\n");
    expect(lines[0]).toContain("Requirement ID");
    expect(lines).toHaveLength(3); // header + 2 atoms
    // atom-1 sorts before atom-2.
    expect(lines[1]).toContain("atom-1");
    expect(lines[2]).toContain("atom-2");
  });

  it("reports covering test ids and the test count", () => {
    const csv = adaptToTraceabilityCsv(rows);
    expect(csv).toContain("tc-1 ; tc-2");
    expect(csv).toMatch(/atom-1.*covered.*0\.90/u);
  });

  it("is deterministic: identical input yields byte-identical output", () => {
    expect(adaptToTraceabilityCsv(rows)).toBe(adaptToTraceabilityCsv(rows));
  });

  it("is formula-injection safe: a cell starting with '=' is neutralised", () => {
    const danger: readonly QualityIntelligenceTraceabilityRow[] = [
      {
        atomId: "=cmd()",
        status: "uncovered",
        confidence: 0,
        coveringCandidateIds: [],
      },
    ];
    const csv = adaptToTraceabilityCsv(danger);
    // The raw "=cmd()" must not appear at the start of a cell (it is prefixed/quoted by the encoder).
    expect(csv).not.toMatch(/(^|,)=cmd\(\)/mu);
  });
});

describe("adaptToTraceabilityMarkdown", () => {
  it("emits a Markdown table with a header and one row per atom", () => {
    const md = adaptToTraceabilityMarkdown(rows);
    expect(md).toContain("| Requirement ID | Status | Confidence | Covering Tests | Test Count |");
    expect(md).toContain("| atom-1 | covered | 0.90 | tc-1 ; tc-2 | 2 |");
    expect(md).toMatch(/\| atom-2 \| uncovered \| 0\.00 \| — \| 0 \|/u);
  });

  it("is deterministic", () => {
    expect(adaptToTraceabilityMarkdown(rows)).toBe(adaptToTraceabilityMarkdown(rows));
  });
});
