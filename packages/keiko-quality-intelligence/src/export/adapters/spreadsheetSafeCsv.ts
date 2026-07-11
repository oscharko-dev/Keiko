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

export const UTF8_BOM = "\ufeff";

export const EXCEL_CSV_SEPARATOR_HINT = "sep=;\r\n";

// Whitespace code points a spreadsheet import may strip BEFORE formula detection. Several importers
// (Excel/LibreOffice/Sheets) trim a leading whitespace run, so a cell like " =1+1" or a NBSP/tab-
// prefixed formula can still evaluate even though its literal first char is not a lead char.
const LEADING_WHITESPACE_CODE_POINTS: ReadonlySet<number> = new Set<number>([
  0x09, // tab
  0x0a, // line feed
  0x0b, // vertical tab
  0x0c, // form feed
  0x0d, // carriage return
  0x20, // space
  0xa0, // no-break space
  0x2007, // figure space
  0x2028, // line separator
  0x2029, // paragraph separator
  0x202f, // narrow no-break space
  0xfeff, // zero-width no-break space / BOM
]);

// The formula/DDE lead characters that remain dangerous once a leading whitespace run is stripped.
// The whitespace leads themselves (TAB/CR/LF) stay covered by the literal first-char check.
const FORMULA_LEAD_AFTER_WHITESPACE: ReadonlySet<string> = new Set<string>(["=", "+", "-", "@"]);

// Scan past a leading whitespace run; return true when the first non-whitespace character is a
// formula lead. Pure, no regex — scans UTF-16 code units (every listed whitespace point is BMP).
function firstNonWhitespaceIsFormulaLead(value: string): boolean {
  let index = 0;
  while (index < value.length && LEADING_WHITESPACE_CODE_POINTS.has(value.charCodeAt(index))) {
    index += 1;
  }
  // index === 0 → no leading whitespace (the literal first-char check already handled it);
  // index >= length → the cell is all whitespace.
  if (index === 0 || index >= value.length) {
    return false;
  }
  return FORMULA_LEAD_AFTER_WHITESPACE.has(value.charAt(index));
}

/**
 * Returns `true` if `value` would be interpreted as a formula or DDE invocation
 * by a typical spreadsheet because of its leading character — including the case where a leading
 * whitespace run precedes a formula lead, which importers may trim before evaluating.
 */
export function startsWithFormulaLead(value: string): boolean {
  if (value.length === 0) {
    return false;
  }
  if (SPREADSHEET_FORMULA_LEAD_CHARS.has(value.charAt(0))) {
    return true;
  }
  return firstNonWhitespaceIsFormulaLead(value);
}

/**
 * Encodes a single cell value as RFC-4180 CSV with formula-injection
 * mitigation applied. Pure — input string yields the same output every time.
 */
export function encodeSpreadsheetSafeCell(value: string): string {
  return encodeSpreadsheetSafeCellWithDelimiter(value, ",");
}

function encodeSpreadsheetSafeCellWithDelimiter(value: string, delimiter: string): string {
  const prefixed = startsWithFormulaLead(value) ? `'${value}` : value;
  const needsQuoting =
    prefixed.includes(delimiter) ||
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
 * Encodes a row by joining cell-encoded values with the delimiter and terminating
 * with `\r\n` (RFC 4180 line ending). The default delimiter stays comma so the
 * pure adapters remain stable; download routes may request semicolon rows for
 * Excel locales that use comma as decimal separator.
 */
export function encodeSpreadsheetSafeRow(cells: readonly string[], delimiter = ","): string {
  const encoded: string[] = [];
  for (const cell of cells) {
    encoded.push(encodeSpreadsheetSafeCellWithDelimiter(cell, delimiter));
  }
  return `${encoded.join(delimiter)}\r\n`;
}

// Mutable scan state shared by the quoted/unquoted character handlers below.
interface CsvParseState {
  rows: string[][];
  row: string[];
  cell: string;
  inQuotes: boolean;
}

// Consumes one character while inside a quoted cell: a doubled `""` is an embedded literal
// quote, a lone `"` closes the quoted region, anything else is appended to the cell. Returns
// the index to resume scanning from (mirrors the original inline extra-advance for `""`).
function consumeQuotedChar(body: string, index: number, state: CsvParseState): number {
  const ch = body.charAt(index);
  if (ch !== '"') {
    state.cell += ch;
    return index;
  }
  if (body.charAt(index + 1) === '"') {
    state.cell += '"';
    return index + 1;
  }
  state.inQuotes = false;
  return index;
}

// Pushes the current cell and row onto `rows`, then resets both for the next row.
function finalizeCsvRow(state: CsvParseState): void {
  state.row.push(state.cell);
  state.rows.push(state.row);
  state.row = [];
  state.cell = "";
}

// Consumes one character outside a quoted cell: an opening quote, the `,` delimiter, a
// `\r`/`\n` line ending, or a literal character appended to the current cell. Returns the
// index to resume scanning from (mirrors the original inline extra-advance for a CRLF pair).
function consumeUnquotedChar(body: string, index: number, state: CsvParseState): number {
  const ch = body.charAt(index);
  if (ch === '"' && state.cell.length === 0) {
    state.inQuotes = true;
    return index;
  }
  if (ch === ",") {
    state.row.push(state.cell);
    state.cell = "";
    return index;
  }
  if (ch === "\r" || ch === "\n") {
    const isCrlfPair = ch === "\r" && body.charAt(index + 1) === "\n";
    finalizeCsvRow(state);
    return isCrlfPair ? index + 1 : index;
  }
  state.cell += ch;
  return index;
}

function parseCsvRows(body: string): readonly (readonly string[])[] {
  const state: CsvParseState = { rows: [], row: [], cell: "", inQuotes: false };
  for (let i = 0; i < body.length; i += 1) {
    i = state.inQuotes ? consumeQuotedChar(body, i, state) : consumeUnquotedChar(body, i, state);
  }
  if (state.cell.length > 0 || state.row.length > 0) {
    finalizeCsvRow(state);
  }
  return state.rows;
}

export function convertCsvDelimiter(body: string, delimiter = ";"): string {
  let converted = "";
  for (const row of parseCsvRows(body)) {
    converted += encodeSpreadsheetSafeRow(row, delimiter);
  }
  return converted;
}

export function toExcelFriendlyCsv(body: string): string {
  return `${UTF8_BOM}${EXCEL_CSV_SEPARATOR_HINT}${convertCsvDelimiter(body, ";")}`;
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
