// Table projection for the docx parser. A table becomes one `Table row N: Header=value | ...` line
// per data row. Columns are grid columns, not cell positions: a `gridSpan` cell covers several
// columns and shifts the cells after it, and a `vMerge` continuation cell repeats the value of the
// cell it continues. A first row is the header when the document marks it (`w:tblHeader`, which is
// authoritative) or when its cells read as labels over data of a different shape or weight; a
// table whose first row looks like any other row keeps neutral `Column N` labels.

import type { RawBlock, RawCell, RawRow, RawTable } from "./docx-xml.js";

const MAX_HEADER_CHARACTERS = 60;
const MAX_HEADER_WORDS = 6;
const ID_CODE_PATTERN = /^[\p{Lu}]{1,6}[-_ ]?\d+[\w.-]*$/u;
const NUMERIC_PATTERN = /^[\p{N}\s.,:;/%+()€$-]+$/u;

interface GridCell {
  readonly col: number;
  readonly span: number;
  readonly text: string;
  readonly bold: boolean;
  readonly source: RawCell;
}

interface GridRow {
  readonly cells: readonly GridCell[];
  readonly headerMarked: boolean;
  readonly nested: boolean;
}

export function normalizeLine(value: string): string {
  return value.replaceAll(/\s+/gu, " ").trim();
}

function cellParagraphs(cell: RawCell): readonly { text: string; bold: boolean }[] {
  const out: { text: string; bold: boolean }[] = [];
  for (const block of cell.blocks) {
    if (block.kind !== "p") continue;
    const text = normalizeLine(block.paragraph.text);
    if (text.length > 0) out.push({ text, bold: block.paragraph.allBold });
  }
  return out;
}

function hasNestedTable(cell: RawCell): boolean {
  return cell.blocks.some((block) => block.kind === "tbl");
}

function columnLabel(index: number): string {
  return `Column ${String(index + 1)}`;
}

function normalizeHeaders(cells: readonly string[]): readonly string[] {
  const seen = new Map<string, number>();
  return cells.map((cell, index) => {
    const base = cell.length > 0 ? cell : columnLabel(index);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base} ${String(count + 1)}`;
  });
}

// ─── Grid ────────────────────────────────────────────────────────────────────

function gridCellOf(cell: RawCell, col: number, carry: Map<number, string>): GridCell {
  const paragraphs = cellParagraphs(cell);
  const own = paragraphs.map((paragraph) => paragraph.text).join(" ");
  if (cell.vMerge === "continue") {
    return { col, span: cell.span, text: carry.get(col) ?? own, bold: false, source: cell };
  }
  if (cell.vMerge === "restart") carry.set(col, own);
  else carry.delete(col);
  const bold = paragraphs.length > 0 && paragraphs.every((paragraph) => paragraph.bold);
  return { col, span: cell.span, text: own, bold, source: cell };
}

function gridRowOf(row: RawRow, carry: Map<number, string>): GridRow {
  let col = row.gridBefore;
  const cells: GridCell[] = [];
  for (const cell of row.cells) {
    cells.push(gridCellOf(cell, col, carry));
    col += cell.span;
  }
  const nested = row.cells.some(hasNestedTable);
  return { cells, headerMarked: row.headerMarked, nested };
}

function isBlankRow(row: GridRow): boolean {
  return !row.nested && row.cells.every((cell) => cell.text.length === 0);
}

function buildGrid(table: RawTable): readonly GridRow[] {
  const carry = new Map<number, string>();
  return table.rows.map((row) => gridRowOf(row, carry)).filter((row) => !isBlankRow(row));
}

// ─── Header evidence ─────────────────────────────────────────────────────────

function shapeOf(text: string): string {
  return text.replaceAll(/\p{L}+/gu, "a").replaceAll(/\p{N}+/gu, "9");
}

function isDataLike(text: string): boolean {
  return NUMERIC_PATTERN.test(text) || ID_CODE_PATTERN.test(text);
}

function isLabelLike(text: string): boolean {
  if (text.length === 0 || text.length > MAX_HEADER_CHARACTERS) return false;
  if (text.split(" ").length > MAX_HEADER_WORDS) return false;
  return /\p{L}/u.test(text) && !isDataLike(text);
}

function hasDistinctLabels(cells: readonly GridCell[]): boolean {
  const labels = new Set(cells.map((cell) => cell.text.toLowerCase()));
  return labels.size === cells.length;
}

/** Shapes seen in each single-column data cell, keyed by column. */
function dataShapes(rows: readonly GridRow[]): ReadonlyMap<number, ReadonlySet<string>> {
  const shapes = new Map<number, Set<string>>();
  for (const row of rows) {
    for (const cell of row.cells) {
      if (cell.span !== 1 || cell.text.length === 0) continue;
      const seen = shapes.get(cell.col) ?? new Set<string>();
      seen.add(shapeOf(cell.text));
      shapes.set(cell.col, seen);
    }
  }
  return shapes;
}

/** Some column holds one uniform data shape that the first row's label does not share. */
function labelsDifferInShape(first: GridRow, rest: readonly GridRow[]): boolean {
  const shapes = dataShapes(rest);
  return first.cells.some((cell) => {
    const column = cell.span === 1 ? shapes.get(cell.col) : undefined;
    return column?.size === 1 && !column.has(shapeOf(cell.text));
  });
}

function firstRowIsBolder(first: GridRow, rest: readonly GridRow[]): boolean {
  if (!first.cells.every((cell) => cell.bold)) return false;
  return rest.some((row) => row.cells.some((cell) => cell.text.length > 0 && !cell.bold));
}

function hasHeaderEvidence(first: GridRow, rest: readonly GridRow[]): boolean {
  if (first.nested || first.cells.length < 2) return false;
  if (first.cells.some((cell) => cell.text.length === 0)) return false;
  if (firstRowIsBolder(first, rest)) return true;
  const labels =
    first.cells.every((cell) => isLabelLike(cell.text)) && hasDistinctLabels(first.cells);
  return labels && labelsDifferInShape(first, rest);
}

function headerRowOf(grid: readonly GridRow[]): GridRow | undefined {
  const first = grid[0];
  if (first === undefined || grid.length < 2) return undefined;
  return first.headerMarked || hasHeaderEvidence(first, grid.slice(1)) ? first : undefined;
}

function headerLabels(header: GridRow | undefined): readonly string[] {
  if (header === undefined) return [];
  const raw: string[] = [];
  for (const cell of header.cells) {
    for (let col = cell.col; col < cell.col + cell.span; col += 1) raw[col] = cell.text;
  }
  return normalizeHeaders(Array.from({ length: raw.length }, (_, index) => raw[index] ?? ""));
}

// ─── Lines ───────────────────────────────────────────────────────────────────

interface ProjectedCell {
  readonly col: number;
  readonly text: string;
}

function rowLine(
  cells: readonly ProjectedCell[],
  rowNumber: number,
  labels: readonly string[],
): string {
  const projected = cells
    .map(({ col, text }) => `${labels[col] ?? columnLabel(col)}=${text}`)
    .join(" | ");
  return `Table row ${String(rowNumber)}: ${projected}`;
}

function flushCells(
  out: string[],
  cells: ProjectedCell[],
  rowNumber: number,
  labels: readonly string[],
): void {
  if (cells.length === 0) return;
  out.push(rowLine(cells, rowNumber, labels));
  cells.length = 0;
}

/** Lines of a row whose cells hold tables: text before, between and after the nested tables. */
function nestedRowLines(
  row: GridRow,
  rowNumber: number,
  labels: readonly string[],
): readonly string[] {
  const out: string[] = [];
  const pending: ProjectedCell[] = [];
  for (const cell of row.cells) {
    const parts: string[] = [];
    for (const block of cell.source.blocks) {
      if (block.kind === "p") {
        const text = normalizeLine(block.paragraph.text);
        if (text.length > 0) parts.push(text);
        continue;
      }
      if (parts.length > 0) pending.push({ col: cell.col, text: parts.splice(0).join(" ") });
      flushCells(out, pending, rowNumber, labels);
      out.push(...tableLines(block.table));
    }
    if (parts.length > 0) pending.push({ col: cell.col, text: parts.join(" ") });
  }
  flushCells(out, pending, rowNumber, labels);
  return out;
}

function nestedTablesOf(row: GridRow): readonly string[] {
  return row.cells.flatMap((cell) =>
    cell.source.blocks.flatMap((block: RawBlock) =>
      block.kind === "tbl" ? tableLines(block.table) : [],
    ),
  );
}

function tableLines(table: RawTable): readonly string[] {
  const grid = buildGrid(table);
  const header = headerRowOf(grid);
  const labels = headerLabels(header);
  const out: string[] = [];
  let rowNumber = 0;
  for (const row of grid) {
    if (row === header) {
      out.push(...nestedTablesOf(row));
      continue;
    }
    rowNumber += 1;
    if (row.nested) {
      out.push(...nestedRowLines(row, rowNumber, labels));
    } else {
      out.push(rowLine(row.cells, rowNumber, labels));
    }
  }
  return out;
}

/** Projects a table (and any table nested in its cells) to its `Table row N: ...` lines. */
export function projectTable(table: RawTable): readonly string[] {
  return tableLines(table);
}
