// Requirement-to-test traceability export adapters (Epic #734, Issue #740).
//
// Pure-domain leaf. Renders the per-atom coverage matrix as an audit-ready requirement↔test
// traceability matrix in CSV (spreadsheet-safe) and Markdown. Deterministic: rows are sorted by
// atom id, confidence is fixed-precision, and there are no timestamps — so the export is
// byte-stable. Takes a minimal row shape (refs + status only, never raw atom text), so it depends
// on nothing outside keiko-contracts/keiko-quality-intelligence (ADR-0019 direction rule).

import type { CoverageStatus } from "../../domain/coverageRelevance.js";
import { encodeSpreadsheetSafeRow } from "./spreadsheetSafeCsv.js";

/** One requirement row of the traceability matrix (refs + status only — no raw atom text). */
export interface QualityIntelligenceTraceabilityRow {
  readonly atomId: string;
  readonly status: CoverageStatus;
  readonly confidence: number;
  readonly coveringCandidateIds: readonly string[];
}

/** CSV header row for the traceability matrix. */
export const TRACEABILITY_HEADERS: readonly string[] = Object.freeze([
  "Requirement ID",
  "Status",
  "Confidence",
  "Covering Tests",
  "Test Count",
]);

const byAtomIdAsc = (
  a: QualityIntelligenceTraceabilityRow,
  b: QualityIntelligenceTraceabilityRow,
): number => (a.atomId < b.atomId ? -1 : a.atomId > b.atomId ? 1 : 0);

const fixed2 = (value: number): string => value.toFixed(2);

const joinSemicolon = (values: readonly string[]): string => values.join(" ; ");

// Escape Markdown table delimiters so an id containing a pipe cannot break the row structure.
// Backslashes are escaped FIRST so a literal backslash cannot consume the following escape and a
// pre-existing `\|` cannot smuggle an unescaped pipe through (CWE-20 incomplete-sanitization).
const mdCell = (value: string): string => value.replace(/\\/gu, "\\\\").replace(/\|/gu, "\\|");

/**
 * Render the coverage matrix as a spreadsheet-safe CSV traceability matrix: one row per
 * requirement atom (sorted by atom id), each with its coverage status, confidence, the covering
 * test ids, and the count. Formula-injection-safe via the shared cell encoder.
 */
export function adaptToTraceabilityCsv(
  rows: readonly QualityIntelligenceTraceabilityRow[],
): string {
  const sorted = [...rows].sort(byAtomIdAsc);
  let body = encodeSpreadsheetSafeRow(TRACEABILITY_HEADERS);
  for (const row of sorted) {
    body += encodeSpreadsheetSafeRow([
      row.atomId,
      row.status,
      fixed2(row.confidence),
      joinSemicolon(row.coveringCandidateIds),
      String(row.coveringCandidateIds.length),
    ]);
  }
  return body;
}

/**
 * Render the coverage matrix as a Markdown traceability table: one row per requirement atom
 * (sorted by atom id). Deterministic and pipe-escaped.
 */
export function adaptToTraceabilityMarkdown(
  rows: readonly QualityIntelligenceTraceabilityRow[],
): string {
  const sorted = [...rows].sort(byAtomIdAsc);
  const lines: string[] = [
    "# Requirement to test traceability matrix",
    "",
    `| ${TRACEABILITY_HEADERS.join(" | ")} |`,
    `| ${TRACEABILITY_HEADERS.map(() => "---").join(" | ")} |`,
  ];
  for (const row of sorted) {
    const tests =
      row.coveringCandidateIds.length > 0 ? joinSemicolon(row.coveringCandidateIds) : "—";
    lines.push(
      `| ${mdCell(row.atomId)} | ${row.status} | ${fixed2(row.confidence)} | ${mdCell(tests)} | ${String(row.coveringCandidateIds.length)} |`,
    );
  }
  return lines.join("\n") + "\n";
}
