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
  it("emits one normalised table sorted by atom id", () => {
    const csv = adaptToTraceabilityCsv(rows);
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[0]).toContain("RecordType,Requirement ID");
    // atom-1 sorts before atom-2.
    expect(lines[1]).toContain("atom-1");
    expect(csv).toContain("atom-2");
    expect(csv).not.toContain("Requirements to tests");
    expect(csv).not.toContain("Tests to requirements");
  });

  it("emits test-to-requirement records that invert the matrix", () => {
    const csv = adaptToTraceabilityCsv(rows);
    // tc-1 and tc-2 each cover atom-1; the title cell falls back to an em-dash without a lookup.
    expect(csv).toMatch(/test-to-requirement,atom-1,—,covered,"0,90",tc-1,—/u);
    expect(csv).toMatch(/test-to-requirement,atom-1,—,covered,"0,90",tc-2,—/u);
  });

  it("reports covering test ids and decimal-comma confidence", () => {
    const csv = adaptToTraceabilityCsv(rows);
    expect(csv).toContain('requirement-to-test,atom-1,—,covered,"0,90",tc-1,—');
    expect(csv).toContain('requirement-to-test,atom-1,—,covered,"0,90",tc-2,—');
    expect(csv).not.toContain("0.90");
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
    expect(md).toContain(
      "| Requirement ID | Requirement (redacted excerpt) | Status | Confidence | Covering Tests | Test Count |",
    );
    expect(md).toContain("| atom-1 | — | covered | 0.90 | tc-1 ; tc-2 | 2 |");
    expect(md).toMatch(/\| atom-2 \| — \| uncovered \| 0\.00 \| — \| 0 \|/u);
    // Reverse table rows (title falls back to an em-dash without a candidate-title lookup).
    expect(md).toContain("| Test ID | Test Title | Requirements Covered | Requirement Count |");
    expect(md).toContain("| tc-1 | — | atom-1 | 1 |");
    expect(md).toContain("| tc-2 | — | atom-1 | 1 |");
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

// ─── Requirement excerpts + candidate titles (#790) ────────────────────────────

const readableRows: readonly QualityIntelligenceTraceabilityRow[] = [
  {
    atomId: "atom-1",
    status: "covered",
    confidence: 0.9,
    coveringCandidateIds: ["tc-1"],
    requirementExcerptRedacted: "Lock the account after five failed logins.",
  },
  // Legacy row recorded before #790: no excerpt.
  { atomId: "atom-2", status: "uncovered", confidence: 0, coveringCandidateIds: [] },
];

const titles = new Map([["tc-1", "Verify lockout engages on the fifth failed login"]]);

describe("traceability readability (#790)", () => {
  it("CSV: emits the requirement excerpt and joins candidate titles in the reverse section", () => {
    const csv = adaptToTraceabilityCsv(readableRows, { candidateTitleById: titles });
    expect(csv).toContain("Lock the account after five failed logins.");
    expect(csv).toContain("Verify lockout engages on the fifth failed login");
    // The legacy row degrades to the em-dash placeholder, never to a crash or an empty shift.
    expect(csv).toMatch(/requirement-to-test,atom-2,—,uncovered,"0,00",—,—/u);
  });

  it("Markdown: emits the excerpt and title columns with em-dash fallbacks", () => {
    const md = adaptToTraceabilityMarkdown(readableRows, { candidateTitleById: titles });
    expect(md).toContain(
      "| atom-1 | Lock the account after five failed logins. | covered | 0.90 | tc-1 | 1 |",
    );
    expect(md).toContain("| atom-2 | — | uncovered | 0.00 | — | 0 |");
    expect(md).toContain(
      "| tc-1 | Verify lockout engages on the fifth failed login | atom-1 | 1 |",
    );
  });

  it("neutralises a formula-lead excerpt and pipe-escapes it in Markdown", () => {
    const danger: readonly QualityIntelligenceTraceabilityRow[] = [
      {
        atomId: "atom-1",
        status: "uncovered",
        confidence: 0,
        coveringCandidateIds: [],
        requirementExcerptRedacted: "=SUM(A1) | drop table",
      },
    ];
    const csv = adaptToTraceabilityCsv(danger);
    expect(csv).not.toMatch(/(^|,)=SUM\(A1\)/mu);
    const md = adaptToTraceabilityMarkdown(danger);
    expect(md).toContain("'=SUM(A1) \\| drop table");
  });

  it("is deterministic with display options supplied", () => {
    const display = { candidateTitleById: titles };
    expect(adaptToTraceabilityCsv(readableRows, display)).toBe(
      adaptToTraceabilityCsv(readableRows, display),
    );
    expect(adaptToTraceabilityMarkdown(readableRows, display)).toBe(
      adaptToTraceabilityMarkdown(readableRows, display),
    );
  });
});

// ---------------------------------------------------------------------------
// T3 — all-uncovered run placeholder (currently mutation-blind)
// ---------------------------------------------------------------------------
// When every row has coveringCandidateIds: [] the Tests→Requirements section
// must emit the placeholder row "| — | — | — | 0 |" because there are no
// reverse rows to invert. RED if the reverseRows.length === 0 guard is removed.

describe("T3: all-uncovered run emits placeholder in Tests→Requirements section", () => {
  const allUncovered: readonly QualityIntelligenceTraceabilityRow[] = [
    { atomId: "atom-1", status: "uncovered", confidence: 0, coveringCandidateIds: [] },
    { atomId: "atom-2", status: "uncovered", confidence: 0, coveringCandidateIds: [] },
  ];

  it("Markdown: Tests→Requirements section contains the placeholder row", () => {
    const md = adaptToTraceabilityMarkdown(allUncovered);
    const reverseIdx = md.indexOf("## Tests → Requirements");
    const reverseSection = md.slice(reverseIdx);
    expect(reverseSection).toContain("| — | — | — | 0 |");
  });

  it("Markdown: placeholder is the only data row in Tests→Requirements section", () => {
    const md = adaptToTraceabilityMarkdown(allUncovered);
    const reverseIdx = md.indexOf("## Tests → Requirements");
    const reverseSection = md.slice(reverseIdx);
    const dataLines = reverseSection
      .split("\n")
      .filter((l) => l.startsWith("|") && !l.includes("---"));
    // header row + 1 placeholder data row = 2 total
    expect(dataLines).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// T4 — CSV single-table invariant
// ---------------------------------------------------------------------------

describe("T4: CSV contains a single normalised table", () => {
  it("contains no blank section separator", () => {
    const csv = adaptToTraceabilityCsv(rows);
    expect(csv).not.toContain("\r\n\r\n");
  });

  it("uses RecordType values for both logical directions", () => {
    const csv = adaptToTraceabilityCsv(rows);
    expect(csv).toContain("requirement-to-test");
    expect(csv).toContain("test-to-requirement");
  });
});
