// Traceability export adapter tests (Epic #734, Issue #740).
//
// Determinism + formula-injection safety are load-bearing: the exported matrix is an audit
// artifact, so identical input must yield byte-identical output and no cell may start a
// spreadsheet formula. The matrix is BIDIRECTIONAL — requirement->test AND test->requirement.

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
  it("emits a requirements->tests section, sorted by atom id", () => {
    const csv = adaptToTraceabilityCsv(rows);
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[0]).toContain("Requirements to tests");
    expect(lines[1]).toContain("Requirement ID");
    // atom-1 sorts before atom-2.
    expect(lines[2]).toContain("atom-1");
    expect(lines[3]).toContain("atom-2");
  });

  it("emits a test->requirements (reverse) section that inverts the matrix", () => {
    const csv = adaptToTraceabilityCsv(rows);
    expect(csv).toContain("Tests to requirements");
    expect(csv).toContain("Test ID,Requirements Covered,Requirement Count");
    // tc-1 and tc-2 each cover atom-1.
    expect(csv).toMatch(/tc-1,atom-1,1/u);
    expect(csv).toMatch(/tc-2,atom-1,1/u);
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
        coveringCandidateIds: ["=evil()"],
      },
    ];
    const csv = adaptToTraceabilityCsv(danger);
    // The raw "=cmd()" must not appear at the start of a cell (it is prefixed/quoted by the encoder).
    expect(csv).not.toMatch(/(^|,)=cmd\(\)/mu);
    expect(csv).not.toMatch(/(^|,)=evil\(\)/mu);
  });
});

describe("adaptToTraceabilityMarkdown", () => {
  it("emits both direction tables", () => {
    const md = adaptToTraceabilityMarkdown(rows);
    expect(md).toContain("## Requirements → Tests");
    expect(md).toContain("## Tests → Requirements");
    expect(md).toContain("| Requirement ID | Status | Confidence | Covering Tests | Test Count |");
    expect(md).toContain("| atom-1 | covered | 0.90 | tc-1 ; tc-2 | 2 |");
    expect(md).toMatch(/\| atom-2 \| uncovered \| 0\.00 \| — \| 0 \|/u);
    // Reverse table rows.
    expect(md).toContain("| Test ID | Requirements Covered | Requirement Count |");
    expect(md).toContain("| tc-1 | atom-1 | 1 |");
    expect(md).toContain("| tc-2 | atom-1 | 1 |");
  });

  it("neutralises a formula-lead atom id in Markdown", () => {
    const danger: readonly QualityIntelligenceTraceabilityRow[] = [
      { atomId: "=cmd()", status: "uncovered", confidence: 0, coveringCandidateIds: [] },
    ];
    const md = adaptToTraceabilityMarkdown(danger);
    expect(md).toContain("| '=cmd() |");
  });

  it("is deterministic", () => {
    expect(adaptToTraceabilityMarkdown(rows)).toBe(adaptToTraceabilityMarkdown(rows));
  });
});
