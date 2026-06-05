// Spreadsheet-safe CSV cell encoding (Epic #270, Issue #283).
//
// Mitigates CSV formula-injection (OWASP CSV Injection / "DDE injection") by
// prefixing any cell whose first character is one of `=`, `+`, `-`, `@`, `\t`,
// `\r`, `\n` with a single quote so a spreadsheet (Excel, LibreOffice Calc,
// Google Sheets) renders it as literal text rather than evaluating a formula
// or invoking an external DDE link.
//
// The escape rules:
//   - Cells starting with one of the dangerous lead characters get a `'`
//     prefix (single straight quote).
//   - Cells containing `"`, `,`, `\r`, or `\n` are wrapped in `"` quotes; any
//     embedded `"` is doubled per RFC 4180.
//
// The two rules compose — a cell like `=cmd|"calc"` becomes `"'=cmd|""calc"""`.
//
// Pure-domain leaf. NO IO, NO new runtime dependency, NO regex.

import type { QualityIntelligenceExportBundle } from "@oscharko-dev/keiko-contracts";
import { assertExportBundleInvariant } from "@oscharko-dev/keiko-contracts";
import type { QualityIntelligenceTestCaseCandidate } from "@oscharko-dev/keiko-contracts";

/**
 * Lead characters that a spreadsheet may interpret as a formula or DDE invocation.
 * Frozen for reference-stability; consumers should not mutate.
 */
export const SPREADSHEET_FORMULA_LEAD_CHARS: ReadonlySet<string> = new Set<string>([
  "=",
  "+",
  "-",
  "@",
  "\t",
  "\r",
  "\n",
]);

/**
 * Returns `true` if `value` would be interpreted as a formula or DDE invocation
 * by a typical spreadsheet because of its leading character.
 */
export function startsWithFormulaLead(value: string): boolean {
  if (value.length === 0) {
    return false;
  }
  return SPREADSHEET_FORMULA_LEAD_CHARS.has(value.charAt(0));
}

/**
 * Encodes a single cell value as RFC-4180 CSV with formula-injection
 * mitigation applied. Pure — input string yields the same output every time.
 */
export function encodeSpreadsheetSafeCell(value: string): string {
  const prefixed = startsWithFormulaLead(value) ? `'${value}` : value;
  const needsQuoting =
    prefixed.includes(",") ||
    prefixed.includes('"') ||
    prefixed.includes("\r") ||
    prefixed.includes("\n");
  if (!needsQuoting) {
    return prefixed;
  }
  // Double every embedded quote per RFC 4180.
  const doubled = prefixed.split('"').join('""');
  return `"${doubled}"`;
}

/**
 * Encodes a row by joining cell-encoded values with `,` and terminating with
 * `\r\n` (RFC 4180 line ending).
 */
export function encodeSpreadsheetSafeRow(cells: readonly string[]): string {
  const encoded: string[] = [];
  for (const cell of cells) {
    encoded.push(encodeSpreadsheetSafeCell(cell));
  }
  return `${encoded.join(",")}\r\n`;
}

/**
 * Schema headers for the generic spreadsheet-safe CSV format. Deliberately
 * minimal — TMS-specific shape lives in the TMS-specific adapters.
 */
export const SPREADSHEET_SAFE_CSV_HEADERS: readonly string[] = Object.freeze([
  "CandidateId",
  "Title",
  "Priority",
  "RiskClass",
  "Status",
  "Tags",
  "Preconditions",
  "Steps",
  "ExpectedResults",
]);

const joinSemicolon = (values: readonly string[]): string => values.join(" ; ");

/**
 * Builds the spreadsheet-safe-CSV body for a bundle. The TMS invariant from
 * the contracts package is asserted up front so a non-attested TMS-targeted
 * bundle cannot slip through. `candidates` is filtered to the entries
 * referenced by the bundle, sorted deterministically by candidate id.
 */
export function adaptToSpreadsheetSafeCsv(
  bundle: QualityIntelligenceExportBundle,
  candidates: readonly QualityIntelligenceTestCaseCandidate[],
): string {
  assertExportBundleInvariant(bundle);
  const byId = new Map<string, QualityIntelligenceTestCaseCandidate>();
  for (const candidate of candidates) {
    byId.set(candidate.id, candidate);
  }
  const entryIds = bundle.contents.map((entry) => entry.candidateId);
  const sortedIds = [...entryIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  let body = encodeSpreadsheetSafeRow(SPREADSHEET_SAFE_CSV_HEADERS);
  for (const id of sortedIds) {
    const candidate = byId.get(id);
    if (candidate === undefined) {
      continue;
    }
    body += encodeSpreadsheetSafeRow([
      candidate.id,
      candidate.title,
      candidate.priority,
      candidate.riskClass,
      candidate.status,
      joinSemicolon(candidate.tags),
      joinSemicolon(candidate.preconditions),
      joinSemicolon(candidate.steps),
      joinSemicolon(candidate.expectedResults),
    ]);
  }
  return body;
}
