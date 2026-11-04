// The one table projection the CSV/TSV and XLSX parsers share (#4235).
//
// Both formats hand over rows of non-empty cells; this module decides what the rows MEAN and
// writes the text retrieval and the requirement inventory read:
//
//   Name!7: Header A=value | Header B=value
//
// Doing it once, here, is the point: a spreadsheet and the same data exported as CSV must project
// to the same lines, and a defect in how a header is recognised must be fixed in one place.
//
//   * The header is found from evidence, not assumed to be the first row. A title row above it,
//     a one-line preamble or a metadata pair is not a header; the header is the first row whose
//     cells are all label-like and that spans (almost) as many columns as the rows below it.
//   * A second table on the same sheet, set apart by a blank row and starting with a label-like
//     row, gets its own labels.
//   * A table that has a header and no data row emits its header as a plain line, never as a data
//     row labelled with itself. Rows that are not part of a labelled table (a title, a note under
//     the table) are emitted as plain lines so no content vanishes.
//   * Cell text cannot forge structure: the ` | ` separator inside a value and `=`/`|` inside a
//     header label are neutralised at the producer, so the consumer never reads a cell as two.

import type { ParsedUnit, ParserDiagnostic } from "@oscharko-dev/keiko-contracts";

import { diagnostic, shouldStop } from "./_internal.js";
import { joinedLines } from "./block-text.js";
import type { ParserOptions, ParserSelectionInput } from "./types.js";

export interface TabularCell {
  readonly columnIndex: number;
  readonly value: string;
}

export interface TabularRow {
  // 1-based position of the row in the source (sheet row, CSV record).
  readonly rowNumber: number;
  readonly cells: readonly TabularCell[];
}

export interface ProjectedLine {
  readonly tableName: string;
  readonly rowNumber: number;
  readonly text: string;
}

// How many rows below a header candidate are compared to learn how wide the table is.
const WIDTH_WINDOW = 12;
// A header must span at least this share of the widest nearby row.
const HEADER_COVERAGE = 0.5;
const MAX_HEADER_CELL_CHARS = 120;
// `FR-1`, `REQ_12`, `NFR 3.1`: an identifier-shaped cell marks a data row, never a header.
const IDENTIFIER_SHAPE = /^\p{Lu}{1,8}[-_ ]?\d+(?:\.\d+)*$/u;

/** Header text without line breaks, hyphenated breaks joined, and without projection syntax. */
export function cleanHeaderLabel(value: string): string {
  return value
    .replaceAll(/(\p{Ll})-[ \t]*[\r\n]+[ \t]*(?=\p{Ll})/gu, "$1")
    .replaceAll(/[=|]/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .trim();
}

// A line inside a cell that opens like a projected row (`Sheet!9: ID=FR-1`); group 1 is the part up
// to and including the `!`.
const ROW_PREFIX_AT_LINE_START = /\n([^\n:]{1,120}!)(?=\d{1,9}:)/gu;
const DOCUMENT_ROW_AT_LINE_START = /\n(Table row )(?=\d{1,9}:)/gu;

/** The ` | ` between two fields of a row, written in a value as a broken bar. */
export function neutraliseFieldSeparator(value: string): string {
  return value.replaceAll(" | ", " ¦ ");
}

/**
 * A cell value that cannot be read as the start of another cell or of another row, and that keeps
 * its row whole: every line of the cell stays, one kind of line break, and no blank line, which
 * would end the row. A line of a multi-line cell that looks like a row (`Sheet!9: ID=FR-1`,
 * `Table row 9: ID=FR-1`) is told apart by one more space: no indentation helps, the sheet part of a
 * row prefix may itself start with spaces.
 */
export function neutraliseValue(value: string): string {
  return neutraliseFieldSeparator(joinedLines(value))
    .replaceAll(ROW_PREFIX_AT_LINE_START, "\n$1 ")
    .replaceAll(DOCUMENT_ROW_AT_LINE_START, "\n$1 ");
}

// Text a header can be made of: it has a letter and is no formula, no number written with an
// exponent (`1E-7`) and no key of a key-value pair (`Projekt:`, whose value stands beside it).
function hasLabelShape(text: string): boolean {
  if (text.length === 0 || text.length > MAX_HEADER_CELL_CHARS) return false;
  if (!/\p{L}/u.test(text) || text.startsWith("=") || text.endsWith(":")) return false;
  return !Number.isFinite(Number(text));
}

function isLabelLike(value: string): boolean {
  const text = value.trim();
  return hasLabelShape(text) && !IDENTIFIER_SHAPE.test(text);
}

// An identifier-shaped cell (`Q1`, `KW 12`) names a column when the cell under it is not one: the
// column holds quantities, not identifiers. Two identifier-shaped cells in a column are data.
function isHeaderLabel(cell: TabularCell, below: TabularRow | undefined): boolean {
  if (isLabelLike(cell.value)) return true;
  const text = cell.value.trim();
  if (!hasLabelShape(text)) return false;
  const under = below?.cells.find((other) => other.columnIndex === cell.columnIndex);
  return under !== undefined && !IDENTIFIER_SHAPE.test(under.value.trim());
}

function widestAhead(rows: readonly TabularRow[], index: number): number {
  let widest = 0;
  const end = Math.min(rows.length, index + WIDTH_WINDOW);
  for (let i = index; i < end; i += 1) widest = Math.max(widest, rows[i]?.cells.length ?? 0);
  return widest;
}

function coversTable(rows: readonly TabularRow[], index: number, width: number): boolean {
  const ahead = widestAhead(rows, index);
  if (ahead >= 2 && width < 2) return false;
  return width >= Math.ceil(HEADER_COVERAGE * ahead);
}

function isHeaderRow(rows: readonly TabularRow[], index: number, atStart: boolean): boolean {
  const row = rows[index];
  if (row === undefined || row.cells.length === 0) return false;
  const next = rows[index + 1];
  if (!row.cells.every((cell) => isHeaderLabel(cell, next))) return false;
  if (!coversTable(rows, index, row.cells.length)) return false;
  if (atStart) return true;
  // A later table starts after a blank row and is followed directly by its first data row.
  return next !== undefined && next.rowNumber - row.rowNumber === 1;
}

function followsBlankRow(rows: readonly TabularRow[], index: number): boolean {
  return (rows[index]?.rowNumber ?? 0) - (rows[index - 1]?.rowNumber ?? 0) > 1;
}

// How far below a pair of cells a wider header may start and still make the pair a preamble.
const PREAMBLE_LOOKAHEAD = 8;

// A wider header that is stable: the rows right below it are as wide as it is.
function isStableHeader(rows: readonly TabularRow[], index: number, narrower: number): boolean {
  const row = rows[index];
  if (row === undefined || row.cells.length <= narrower || !isHeaderRow(rows, index, true)) {
    return false;
  }
  return [rows[index + 1], rows[index + 2]].some(
    (next) => next !== undefined && next.cells.length >= row.cells.length,
  );
}

/**
 * Whether the row is a preamble, not the header: one or two cells (`Autor | Müller`) directly
 * above, with no blank row between, a wider header whose data rows keep that width. A two-column
 * header whose data is wider and ragged is not mistaken for one, the wider row has to be a header
 * itself.
 */
function isPreamble(rows: readonly TabularRow[], index: number): boolean {
  const width = rows[index]?.cells.length ?? 0;
  if (width > 2) return false;
  const end = Math.min(rows.length, index + 1 + PREAMBLE_LOOKAHEAD);
  for (let next = index + 1; next < end; next += 1) {
    if (followsBlankRow(rows, next)) return false;
    if (isStableHeader(rows, next, width)) return true;
  }
  return false;
}

function buildHeaders(row: TabularRow): ReadonlyMap<number, string> {
  const headers = new Map<number, string>();
  const seen = new Map<string, number>();
  for (const cell of row.cells) {
    const base = cleanHeaderLabel(cell.value);
    if (base.length === 0) continue;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    headers.set(cell.columnIndex, count === 0 ? base : `${base} ${String(count + 1)}`);
  }
  return headers;
}

function plainLine(tableName: string, row: TabularRow): ProjectedLine {
  const text = row.cells.map((cell) => neutraliseValue(cell.value)).join(" | ");
  return {
    tableName,
    rowNumber: row.rowNumber,
    text: `${tableName}!${String(row.rowNumber)}: ${text}\n`,
  };
}

function labelledLine(
  tableName: string,
  row: TabularRow,
  headers: ReadonlyMap<number, string>,
  fallbackLabel: (columnIndex: number) => string,
): ProjectedLine {
  const text = row.cells
    .map(
      (cell) =>
        `${headers.get(cell.columnIndex) ?? fallbackLabel(cell.columnIndex)}=${neutraliseValue(cell.value)}`,
    )
    .join(" | ");
  return {
    tableName,
    rowNumber: row.rowNumber,
    text: `${tableName}!${String(row.rowNumber)}: ${text}\n`,
  };
}

interface TableState {
  headers: ReadonlyMap<number, string>;
  // The header row of a table that has not produced a data row yet.
  pendingHeader: TabularRow | undefined;
}

type RowRole = "header" | "plain" | "data";

// A lone cell after a blank row, under a table of several columns, is a note, unless it stands
// under the label of a column other than the first: that column holds values.
function isNote(row: TabularRow, state: TableState): boolean {
  const [only] = row.cells;
  if (row.cells.length !== 1 || only === undefined || state.headers.size < 2) return false;
  const firstColumn = Math.min(...state.headers.keys());
  return only.columnIndex === firstColumn || !state.headers.has(only.columnIndex);
}

function laterRoleOf(rows: readonly TabularRow[], index: number, state: TableState): RowRole {
  const row = rows[index];
  if (row === undefined) return "data";
  const gapBefore = row.rowNumber - (rows[index - 1]?.rowNumber ?? 0) > 1;
  if (gapBefore && isHeaderRow(rows, index, false)) return "header";
  return gapBefore && isNote(row, state) ? "plain" : "data";
}

function roleOf(
  rows: readonly TabularRow[],
  index: number,
  firstHeader: number,
  state: TableState,
): RowRole {
  if (firstHeader < 0) return "data";
  if (index === firstHeader) return "header";
  return index < firstHeader ? "plain" : laterRoleOf(rows, index, state);
}

/**
 * Projects the non-empty rows of one table-bearing source (a sheet, a CSV file) into lines. Rows
 * must be in source order; a missing row number between two rows is a blank row.
 */
export function projectTable(
  tableName: string,
  rows: readonly TabularRow[],
  fallbackLabel: (columnIndex: number) => string,
): readonly ProjectedLine[] {
  const lines: ProjectedLine[] = [];
  const firstHeader = rows.findIndex(
    (_row, index) => isHeaderRow(rows, index, true) && !isPreamble(rows, index),
  );
  const state: TableState = { headers: new Map(), pendingHeader: undefined };
  rows.forEach((row, index) => {
    const role = roleOf(rows, index, firstHeader, state);
    if (role === "header") {
      if (state.pendingHeader !== undefined) lines.push(plainLine(tableName, state.pendingHeader));
      state.pendingHeader = row;
      state.headers = buildHeaders(row);
    } else if (role === "plain") {
      lines.push(plainLine(tableName, row));
    } else {
      state.pendingHeader = undefined;
      lines.push(labelledLine(tableName, row, state.headers, fallbackLabel));
    }
  });
  if (state.pendingHeader !== undefined) lines.push(plainLine(tableName, state.pendingHeader));
  return lines;
}

export interface EmittedLines {
  readonly units: readonly ParsedUnit[];
  readonly diagnostics: readonly ParserDiagnostic[];
  readonly normalizedText: string;
}

/** One `csv-row` unit per projected line; `rowIndex` is the 0-based source row for every format. */
export function emitProjectedLines(
  lines: readonly ProjectedLine[],
  input: ParserSelectionInput,
  options: ParserOptions,
): EmittedLines {
  const units: ParsedUnit[] = [];
  const diagnostics: ParserDiagnostic[] = [];
  const parts: string[] = [];
  let offset = 0;
  const startedAt = options.now();
  for (const line of lines) {
    const limit = shouldStop(startedAt, options, units.length);
    if (limit.stop && limit.code !== undefined && limit.message !== undefined) {
      diagnostics.push(diagnostic(limit.code, limit.message, input.documentId, "info"));
      break;
    }
    const start = offset;
    parts.push(line.text);
    offset += line.text.length;
    units.push({
      kind: "csv-row",
      documentId: input.documentId,
      tableName: line.tableName,
      rowIndex: Math.max(0, line.rowNumber - 1),
      characterStart: start,
      characterEnd: offset,
    });
  }
  return { units, diagnostics, normalizedText: parts.join("") };
}
