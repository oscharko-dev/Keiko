// Requirement-to-test traceability export adapters (Epic #734, Issue #740).
//
// Pure-domain leaf. Renders the per-atom coverage matrix as an audit-ready, BIDIRECTIONAL
// requirement<->test traceability matrix in CSV (spreadsheet-safe) and Markdown:
//   * Requirements -> Tests: each requirement atom and the tests that cover it (+ status).
//   * Tests -> Requirements: each test and the requirements it traces to.
// Both directions are derived purely from the coverage matrix rows plus optional ALREADY-REDACTED
// display fields — a requirement excerpt per row and a candidate-title lookup (#790) — never raw
// atom text, so the adapter depends on nothing outside keiko-contracts/keiko-quality-intelligence
// (ADR-0019 direction rule). Deterministic: rows are sorted by id, confidence is fixed-precision,
// and there are no timestamps — so the export is byte-stable for identical inputs.

import type { CoverageStatus } from "../../domain/coverageRelevance.js";
import { escapeMarkdownActiveSyntax, inlineField } from "../textSafety.js";
import { encodeSpreadsheetSafeRow, startsWithFormulaLead } from "./spreadsheetSafeCsv.js";

/**
 * One requirement row of the traceability matrix: refs + status, plus an optional short REDACTED
 * requirement excerpt (#790) so an auditor can read WHICH requirement a row traces without
 * cross-referencing atom ids. Absent on runs recorded before the excerpt existed.
 */
export interface QualityIntelligenceTraceabilityRow {
  readonly atomId: string;
  readonly status: CoverageStatus;
  readonly confidence: number;
  readonly coveringCandidateIds: readonly string[];
  readonly requirementExcerptRedacted?: string;
}

/** Optional display enrichment: candidate id -> already-redacted candidate title (#790). */
export interface QualityIntelligenceTraceabilityDisplayOptions {
  readonly candidateTitleById?: ReadonlyMap<string, string>;
}

/** Markdown header row for the requirement -> tests direction. */
export const TRACEABILITY_HEADERS: readonly string[] = Object.freeze([
  "Requirement ID",
  "Requirement (redacted excerpt)",
  "Status",
  "Confidence",
  "Covering Tests",
  "Test Count",
]);

/** Markdown header row for the test -> requirements (reverse) direction. */
export const TRACEABILITY_REVERSE_HEADERS: readonly string[] = Object.freeze([
  "Test ID",
  "Test Title",
  "Requirements Covered",
  "Requirement Count",
]);

/** CSV uses one normalised table with a record discriminator instead of two header blocks. */
export const TRACEABILITY_CSV_HEADERS: readonly string[] = Object.freeze([
  "RecordType",
  "Requirement ID",
  "Requirement (redacted excerpt)",
  "Status",
  "Confidence",
  "Test ID",
  "Test Title",
]);

/** Placeholder for an absent display value (legacy rows / unknown candidate). Em-dash, not a formula lead. */
const ABSENT = "—";

const byAtomIdAsc = (
  a: QualityIntelligenceTraceabilityRow,
  b: QualityIntelligenceTraceabilityRow,
): number => (a.atomId < b.atomId ? -1 : a.atomId > b.atomId ? 1 : 0);

const ascending = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const fixed2 = (value: number): string => value.toFixed(2);

const fixed2German = (value: number): string => value.toFixed(2).replace(".", ",");

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
// a spreadsheet. inlineField runs FIRST so embedded newlines/tabs cannot split one logical row across
// two physical Markdown lines (CWE-1284). Backslashes are escaped BEFORE pipes so a literal backslash
// cannot consume the following escape and a pre-existing `\|` cannot smuggle an unescaped pipe (CWE-20).
const mdCell = (value: string): string => {
  const oneLine = inlineField(value);
  const safe = startsWithFormulaLead(oneLine) ? `'${oneLine}` : oneLine;
  let escaped = "";
  for (const char of escapeMarkdownActiveSyntax(safe)) {
    if (char === "\\" || char === "|") escaped += `\\${char}`;
    else escaped += char;
  }
  return escaped;
};

const mdRow = (cells: readonly string[]): string => `| ${cells.map(mdCell).join(" | ")} |`;

/**
 * Render the coverage matrix as a spreadsheet-safe, BIDIRECTIONAL CSV traceability matrix in a
 * single table. `RecordType` distinguishes requirement->test rows from test->requirement rows, so
 * spreadsheet importers and auditors see one stable header schema instead of two incompatible
 * header blocks in one file. Each cell is formula-injection-safe via the shared encoder.
 */
// eslint-disable-next-line complexity
export function adaptToTraceabilityCsv(
  rows: readonly QualityIntelligenceTraceabilityRow[],
  display: QualityIntelligenceTraceabilityDisplayOptions = {},
): string {
  const sorted = [...rows].sort(byAtomIdAsc);
  let body = encodeSpreadsheetSafeRow(TRACEABILITY_CSV_HEADERS);
  for (const row of sorted) {
    const covering = [...row.coveringCandidateIds].sort(ascending);
    const testIds = covering.length > 0 ? covering : [ABSENT];
    for (const candidateId of testIds) {
      body += encodeSpreadsheetSafeRow([
        "requirement-to-test",
        inlineField(row.atomId),
        inlineField(row.requirementExcerptRedacted ?? ABSENT),
        row.status,
        fixed2German(row.confidence),
        inlineField(candidateId),
        candidateId === ABSENT
          ? ABSENT
          : inlineField(display.candidateTitleById?.get(candidateId) ?? ABSENT),
      ]);
    }
  }
  for (const reverse of invertToReverseRows(sorted)) {
    for (const requirementId of reverse.requirementIds) {
      const requirement = sorted.find((row) => row.atomId === requirementId);
      body += encodeSpreadsheetSafeRow([
        "test-to-requirement",
        inlineField(requirementId),
        inlineField(requirement?.requirementExcerptRedacted ?? ABSENT),
        requirement?.status ?? ABSENT,
        requirement === undefined ? ABSENT : fixed2German(requirement.confidence),
        inlineField(reverse.candidateId),
        inlineField(display.candidateTitleById?.get(reverse.candidateId) ?? ABSENT),
      ]);
    }
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
  display: QualityIntelligenceTraceabilityDisplayOptions = {},
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
      row.coveringCandidateIds.length > 0 ? joinSemicolon(row.coveringCandidateIds) : ABSENT;
    lines.push(
      mdRow([
        row.atomId,
        row.requirementExcerptRedacted ?? ABSENT,
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
    lines.push(mdRow([ABSENT, ABSENT, ABSENT, "0"]));
  }
  for (const reverse of reverseRows) {
    lines.push(
      mdRow([
        reverse.candidateId,
        display.candidateTitleById?.get(reverse.candidateId) ?? ABSENT,
        joinSemicolon(reverse.requirementIds),
        String(reverse.requirementIds.length),
      ]),
    );
  }
  return lines.join("\n") + "\n";
}
