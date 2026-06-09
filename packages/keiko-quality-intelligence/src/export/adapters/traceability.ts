// Requirement-to-test traceability export adapters (Epic #734, Issue #740).
//
// Pure-domain leaf. Renders the per-atom coverage matrix as an audit-ready, BIDIRECTIONAL
// requirement<->test traceability matrix in CSV (spreadsheet-safe) and Markdown:
//   * Requirements -> Tests: each requirement atom and the tests that cover it (+ status).
//   * Tests -> Requirements: each test and the requirements it traces to.
// Both directions are derived purely from the coverage matrix rows (refs + status only, never raw
// atom text), so the adapter depends on nothing outside keiko-contracts/keiko-quality-intelligence
// (ADR-0019 direction rule). Deterministic: rows are sorted by id, confidence is fixed-precision,
// and there are no timestamps — so the export is byte-stable.

import type { CoverageStatus } from "../../domain/coverageRelevance.js";
import { encodeSpreadsheetSafeRow, startsWithFormulaLead } from "./spreadsheetSafeCsv.js";

/** One requirement row of the traceability matrix (refs + status only — no raw atom text). */
export interface QualityIntelligenceTraceabilityRow {
  readonly atomId: string;
  readonly status: CoverageStatus;
  readonly confidence: number;
  readonly coveringCandidateIds: readonly string[];
}

/** CSV header row for the requirement -> tests direction. */
export const TRACEABILITY_HEADERS: readonly string[] = Object.freeze([
  "Requirement ID",
  "Status",
  "Confidence",
  "Covering Tests",
  "Test Count",
]);

/** CSV header row for the test -> requirements (reverse) direction. */
export const TRACEABILITY_REVERSE_HEADERS: readonly string[] = Object.freeze([
  "Test ID",
  "Requirements Covered",
  "Requirement Count",
]);

const byAtomIdAsc = (
  a: QualityIntelligenceTraceabilityRow,
  b: QualityIntelligenceTraceabilityRow,
): number => (a.atomId < b.atomId ? -1 : a.atomId > b.atomId ? 1 : 0);

const ascending = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const fixed2 = (value: number): string => value.toFixed(2);

const joinSemicolon = (values: readonly string[]): string => values.join(" ; ");

/** One reverse row: a test and the requirement atoms it traces to. */
interface ReverseRow {
  readonly candidateId: string;
  readonly requirementIds: readonly string[];
}

/**
 * Invert the requirement->test rows into deterministic test->requirement rows. A test that covers
 * several requirements appears once with all of them; ordering is fully sorted so the output is
 * byte-stable.
 */
function invertToReverseRows(
  rows: readonly QualityIntelligenceTraceabilityRow[],
): readonly ReverseRow[] {
  const byCandidate = new Map<string, Set<string>>();
  for (const row of rows) {
    for (const candidateId of row.coveringCandidateIds) {
      const set = byCandidate.get(candidateId) ?? new Set<string>();
      set.add(row.atomId);
      byCandidate.set(candidateId, set);
    }
  }
  return [...byCandidate.entries()]
    .map(([candidateId, set]) => ({
      candidateId,
      requirementIds: [...set].sort(ascending),
    }))
    .sort((a, b) => ascending(a.candidateId, b.candidateId));
}

// Escape Markdown table delimiters so an id containing a pipe cannot break the row structure, and
// neutralise a spreadsheet formula lead (=,+,-,@) so a cell stays inert if the table is pasted into
// a spreadsheet. Backslashes are escaped FIRST so a literal backslash cannot consume the following
// escape and a pre-existing `\|` cannot smuggle an unescaped pipe through (CWE-20).
const mdCell = (value: string): string => {
  const safe = startsWithFormulaLead(value) ? `'${value}` : value;
  return safe.replace(/\\/gu, "\\\\").replace(/\|/gu, "\\|");
};

const mdRow = (cells: readonly string[]): string => `| ${cells.map(mdCell).join(" | ")} |`;

/**
 * Render the coverage matrix as a spreadsheet-safe, BIDIRECTIONAL CSV traceability matrix: a
 * requirement->tests section followed by a blank line and a tests->requirements section. Each cell
 * is formula-injection-safe via the shared encoder.
 */
export function adaptToTraceabilityCsv(
  rows: readonly QualityIntelligenceTraceabilityRow[],
): string {
  const sorted = [...rows].sort(byAtomIdAsc);
  let body = encodeSpreadsheetSafeRow(["Requirements to tests"]);
  body += encodeSpreadsheetSafeRow(TRACEABILITY_HEADERS);
  for (const row of sorted) {
    body += encodeSpreadsheetSafeRow([
      row.atomId,
      row.status,
      fixed2(row.confidence),
      joinSemicolon(row.coveringCandidateIds),
      String(row.coveringCandidateIds.length),
    ]);
  }
  body += "\r\n";
  body += encodeSpreadsheetSafeRow(["Tests to requirements"]);
  body += encodeSpreadsheetSafeRow(TRACEABILITY_REVERSE_HEADERS);
  for (const reverse of invertToReverseRows(sorted)) {
    body += encodeSpreadsheetSafeRow([
      reverse.candidateId,
      joinSemicolon(reverse.requirementIds),
      String(reverse.requirementIds.length),
    ]);
  }
  return body;
}

/**
 * Render the coverage matrix as a BIDIRECTIONAL Markdown traceability document: a Requirements ->
 * Tests table followed by a Tests -> Requirements table. Deterministic, pipe-escaped and
 * formula-lead-neutralised.
 */
export function adaptToTraceabilityMarkdown(
  rows: readonly QualityIntelligenceTraceabilityRow[],
): string {
  const sorted = [...rows].sort(byAtomIdAsc);
  const lines: string[] = [
    "# Requirement to test traceability matrix",
    "",
    "## Requirements → Tests",
    "",
    `| ${TRACEABILITY_HEADERS.join(" | ")} |`,
    `| ${TRACEABILITY_HEADERS.map(() => "---").join(" | ")} |`,
  ];
  for (const row of sorted) {
    const tests =
      row.coveringCandidateIds.length > 0 ? joinSemicolon(row.coveringCandidateIds) : "—";
    lines.push(
      mdRow([
        row.atomId,
        row.status,
        fixed2(row.confidence),
        tests,
        String(row.coveringCandidateIds.length),
      ]),
    );
  }
  lines.push("", "## Tests → Requirements", "");
  lines.push(`| ${TRACEABILITY_REVERSE_HEADERS.join(" | ")} |`);
  lines.push(`| ${TRACEABILITY_REVERSE_HEADERS.map(() => "---").join(" | ")} |`);
  const reverseRows = invertToReverseRows(sorted);
  if (reverseRows.length === 0) {
    lines.push(mdRow(["—", "—", "0"]));
  }
  for (const reverse of reverseRows) {
    lines.push(
      mdRow([
        reverse.candidateId,
        joinSemicolon(reverse.requirementIds),
        String(reverse.requirementIds.length),
      ]),
    );
  }
  return lines.join("\n") + "\n";
}
