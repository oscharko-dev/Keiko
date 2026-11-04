// Requirement rows of a table (#4179, Epic #4173): `| FR-2 | Bar | Soll |`.
//
// A row defines a requirement when its identifier cell is exactly an identifier: the first column
// whose header role is id (`Lfd. Nr. | ID | Titel`), or the first cell when the header names no id
// column or there is no header (#4235). What a table holds is decided by its header, per table:
//   * A header that names an identifier column or at least two requirement columns assigns the roles
//     (any language in the vocabulary). A header naming only the identifier reads the other columns
//     by position.
//   * A header that names something else (`Code | Bedeutung`) is a table of other things: its rows
//     define nothing, however much their first cell looks like an identifier.
//   * A table whose first row starts with an identifier has no header: the second cell is the title
//     and a cell equal to a priority value is the priority.
//   * A header that names a statement column but no identifier column gives rows without one: a row
//     whose statement states an obligation is a derived unit, whatever else the table holds.

import { ID_EXACT, collapse } from "./requirementText.js";
import {
  foldTerm,
  tableRoleOf,
  type CompiledVocabulary,
  type TableColumnRole,
} from "./requirementVocabulary.js";

export type ColumnRoles = readonly (TableColumnRole | undefined)[];

export interface TableRow {
  readonly id: string;
  readonly title: string;
  readonly priority?: string;
  readonly statement: string;
  readonly criteria: readonly string[];
}

const SEPARATOR_CELL = /^:?-{2,}:?$/u;

/** The cells of a pipe-delimited line, or undefined when the line is not a table row. */
export function tableCells(raw: string): readonly string[] | undefined {
  if (!raw.includes("|")) return undefined;
  const cells = raw.split("|").map((cell) => collapse(cell));
  if (cells[0] === "") cells.shift();
  if (cells.at(-1) === "") cells.pop();
  return cells.length >= 2 ? cells : undefined;
}

export function isSeparatorRow(cells: readonly string[]): boolean {
  return cells.every((cell) => SEPARATOR_CELL.test(cell.replaceAll(" ", "")));
}

/** How the rows of one table are read. */
export type TableReading =
  | { readonly kind: "positional" }
  | { readonly kind: "roles"; readonly roles: ColumnRoles }
  /** A table of other things, with what its header still names (`Anforderung | Verantwortlich`). */
  | { readonly kind: "foreign"; readonly named?: ColumnRoles };

function knownRoles(roles: ColumnRoles): readonly TableColumnRole[] {
  return roles.filter((role) => role !== undefined);
}

function namesRequirementColumns(roles: ColumnRoles): boolean {
  const known = knownRoles(roles);
  return known.length >= 2 || known.includes("id");
}

/** A header naming only the identifier says nothing about the rest: those columns go by position. */
function withPositionalColumns(roles: ColumnRoles): ColumnRoles {
  if (knownRoles(roles).length !== 1) return roles;
  let titled = false;
  return roles.map((role) => {
    if (role !== undefined) return role;
    if (titled) return "statement";
    titled = true;
    return "title";
  });
}

/** The columns a header names, whatever else it holds. */
export function namedColumns(
  cells: readonly string[],
  vocabulary: CompiledVocabulary,
): ColumnRoles {
  return cells.map((cell) => tableRoleOf(vocabulary, cell));
}

/** Column roles of a header row; undefined unless it names requirement columns. */
export function parseTableHeader(
  cells: readonly string[],
  vocabulary: CompiledVocabulary,
): ColumnRoles | undefined {
  const roles = namedColumns(cells, vocabulary);
  return namesRequirementColumns(roles) ? withPositionalColumns(roles) : undefined;
}

function identifierIn(cell: string | undefined): string | undefined {
  return ID_EXACT.exec(collapse((cell ?? "").replaceAll("*", "")))?.[1];
}

/** Whether the row opens with an identifier, so it is data and cannot be a header. */
export function startsWithIdentifier(cells: readonly string[]): boolean {
  return identifierIn(cells[0]) !== undefined;
}

interface IdentifierCell {
  readonly id: string;
  readonly index: number;
}

/**
 * The identifier of a row and the column it is in. With a header, the first column whose role is
 * id and whose cell is an identifier (`Lfd. Nr. | ID | Titel`: the counter is not one); without
 * an id column in the header, or without a header, the first cell.
 */
function identifierCell(
  cells: readonly string[],
  roles: ColumnRoles | undefined,
): IdentifierCell | undefined {
  const idColumns = (roles ?? []).flatMap((role, index) => (role === "id" ? [index] : []));
  for (const index of idColumns.length > 0 ? idColumns : [0]) {
    const id = identifierIn(cells[index]);
    if (id !== undefined) return { id, index };
  }
  return undefined;
}

interface RowParts {
  title: string;
  priority: string | undefined;
  statement: string[];
  criteria: string[];
}

/** A lone priority word is a rating: it states nothing, whichever column it stands in. */
function addStatementCell(cell: string, vocabulary: CompiledVocabulary, parts: RowParts): void {
  if (vocabulary.priorityValues.has(foldTerm(cell))) parts.priority ??= cell;
  else parts.statement.push(cell);
}

function assignByRole(
  { cells, roles }: { readonly cells: readonly string[]; readonly roles: ColumnRoles },
  idIndex: number,
  vocabulary: CompiledVocabulary,
  parts: RowParts,
): void {
  cells.forEach((cell, index) => {
    const role = roles[index];
    if (cell.length === 0 || index === idIndex) return;
    if (role === "title") parts.title = cell;
    else if (role === "priority") parts.priority = cell;
    else if (role === "criteria") parts.criteria.push(cell);
    else if (role === "statement") addStatementCell(cell, vocabulary, parts);
  });
}

function assignByPosition(
  cells: readonly string[],
  vocabulary: CompiledVocabulary,
  parts: RowParts,
): void {
  cells.slice(1).forEach((cell, index) => {
    if (cell.length === 0) return;
    if (vocabulary.priorityValues.has(foldTerm(cell)) && parts.priority === undefined)
      parts.priority = cell;
    else if (index === 0) parts.title = cell;
    else parts.statement.push(cell);
  });
}

/** The requirement a table row defines, or undefined when the row holds no identifier. */
export function parseTableRow(
  cells: readonly string[],
  roles: ColumnRoles | undefined,
  vocabulary: CompiledVocabulary,
): TableRow | undefined {
  const identifier = identifierCell(cells, roles);
  if (identifier === undefined || isSeparatorRow(cells)) return undefined;
  const parts: RowParts = { title: "", priority: undefined, statement: [], criteria: [] };
  if (roles === undefined) assignByPosition(cells, vocabulary, parts);
  else assignByRole({ cells, roles }, identifier.index, vocabulary, parts);
  return {
    id: identifier.id,
    title: parts.title,
    ...(parts.priority === undefined ? {} : { priority: parts.priority }),
    statement: parts.statement.join(" "),
    criteria: parts.criteria,
  };
}

/** A row that holds no identifier: what its named columns say, if one of them is a statement. */
export type UnidentifiedRow = Omit<TableRow, "id">;

export function parseUnidentifiedRow(
  cells: readonly string[],
  roles: ColumnRoles,
  vocabulary: CompiledVocabulary,
): UnidentifiedRow | undefined {
  const parts: RowParts = { title: "", priority: undefined, statement: [], criteria: [] };
  assignByRole({ cells, roles }, -1, vocabulary, parts);
  if (parts.statement.length === 0) return undefined;
  return {
    title: parts.title,
    ...(parts.priority === undefined ? {} : { priority: parts.priority }),
    statement: parts.statement.join(" "),
    criteria: parts.criteria,
  };
}

export interface RowAddition {
  readonly statement: string;
  readonly criteria: readonly string[];
}

const ADDITION_ROLES: ReadonlySet<TableColumnRole | undefined> = new Set(["statement", "criteria"]);

/**
 * What a row without an identifier adds to the requirement above it: the free-text cells of a
 * requirement listed over several rows. A row that fills any other cell names something of its own.
 */
export function parseContinuationRow(
  cells: readonly string[],
  roles: ColumnRoles,
  vocabulary: CompiledVocabulary,
): RowAddition | undefined {
  const filled = cells.flatMap((cell, index) => (cell.length > 0 ? [index] : []));
  if (filled.length === 0 || !filled.every((index) => ADDITION_ROLES.has(roles[index]))) {
    return undefined;
  }
  const parts: RowParts = { title: "", priority: undefined, statement: [], criteria: [] };
  assignByRole({ cells, roles }, -1, vocabulary, parts);
  return { statement: parts.statement.join(" "), criteria: parts.criteria };
}

function withoutRepeats(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

/** One requirement listed over several rows: identifier, title and priority repeat. */
export function isSameRequirement(left: TableRow, right: TableRow): boolean {
  return left.id === right.id && left.title === right.title && left.priority === right.priority;
}

/** The row extended by what a later row of the same requirement adds. */
export function extendedRow<Row extends UnidentifiedRow>(row: Row, addition: RowAddition): Row {
  const repeats = addition.statement === row.statement || addition.statement.length === 0;
  return {
    ...row,
    statement: repeats ? row.statement : collapse(`${row.statement} ${addition.statement}`),
    criteria: withoutRepeats([...row.criteria, ...addition.criteria]),
  };
}

// ─── Spreadsheet projection ──────────────────────────────────────────────────

/**
 * The text a table extraction stores for one row, every cell labelled with its column header:
 *   * a workbook row, `Sheet!2: ID=FR-1 | Titel=Foo | Priorität=Muss` (xlsx, CSV as `csv!2:`, and a
 *     JSON array of objects under its pointer). A cell that holds line breaks (a list of acceptance
 *     criteria) continues on the lines that follow, up to the next row. A cell never holds a blank
 *     line, so a blank line ends the row and the table.
 *   * a document table row, `Table row 2: ID=FR-1 | Titel=Foo` (Word, PowerPoint, HTML). Such a table
 *     stands between paragraphs, and a blank line is what ends it.
 * A parser that knows of no header labels the cells `Column 1`, `Column 2`, ...
 */
export interface ProjectedRow {
  readonly cells: string[];
  readonly roles: (TableColumnRole | undefined)[];
  readonly labels: string[];
  /** What the row belongs to: the worksheet or pointer of a workbook row, nothing in a document. */
  readonly table: string;
  readonly number: number;
}

// A worksheet name may hold `=`, `|` and `!` but never `:` (Excel forbids `\ / ? * [ ] :`), so the
// first colon ends the `Sheet!Row:` prefix. A header label is at most 120 characters in the
// projection (plus the ` 2` of a repeated one); the bound here stays above that, so no header the
// projection labels a cell with is too long to be read as a label.
const MAX_LABEL_CHARS = 160;
const LABEL_AHEAD = String.raw`(?=[^=|\n]{1,${String(MAX_LABEL_CHARS)}}=)`;
const PROJECTION_PREFIX = new RegExp(
  String.raw`^(?:Table row (?<rowInDocument>\d{1,9})|(?<table>[^\n:]{1,120})!(?<rowInTable>\d{1,9})):[ \t]+${LABEL_AHEAD}`,
  "u",
);
const PROJECTED_CELL_BREAK = new RegExp(String.raw` \| ${LABEL_AHEAD}`, "u");
// A projected line that holds no labelled cell (a title, a note, a header-only table).
const PLAIN_PROJECTION = /^[^\n:]{1,120}!\d{1,9}:(?:[ \t]|$)/u;
const DOCUMENT_PROJECTION = /^Table row \d{1,9}:[ \t]/u;
const NEUTRAL_LABEL = /^Column (?:\d+|[A-Z]{1,3})$/u;
/** The line of a JSON record: a row of a JSON document never continues on another line. */
const POINTER_RECORD = /^\/[^\n:]{0,120}: /u;

function appendProjectedCells(
  row: ProjectedRow,
  parts: readonly string[],
  vocabulary: CompiledVocabulary,
): boolean {
  for (const part of parts) {
    const equals = part.indexOf("=");
    if (equals < 1) return false;
    const label = part.slice(0, equals);
    row.labels.push(label);
    row.roles.push(tableRoleOf(vocabulary, label));
    row.cells.push(part.slice(equals + 1));
  }
  return true;
}

/**
 * The row a projected line starts, or undefined when the line is not one. A projected line with no
 * labelled cell is a row without cells: it ends the row before it (the title of the next sheet is
 * no further criterion of the last requirement) and defines nothing.
 */
export function openProjectedRow(
  raw: string,
  vocabulary: CompiledVocabulary,
): ProjectedRow | undefined {
  const prefix = PROJECTION_PREFIX.exec(raw);
  if (prefix === null) return undefined;
  const row: ProjectedRow = {
    cells: [],
    roles: [],
    labels: [],
    table: prefix.groups?.table ?? "",
    number: Number(prefix.groups?.rowInDocument ?? prefix.groups?.rowInTable),
  };
  const parts = raw.slice(prefix[0].length).split(PROJECTED_CELL_BREAK);
  return appendProjectedCells(row, parts, vocabulary) ? row : undefined;
}

/** Whether the next row belongs to the same table: the same sheet, with a later row number. */
export function continuesProjectedTable(last: ProjectedRow, next: ProjectedRow): boolean {
  return last.table === next.table && next.number > last.number;
}

/** A line that ends the row above it because it is a record of its own. */
export function isPointerRecord(raw: string): boolean {
  return POINTER_RECORD.test(raw);
}

/** A projected line with no labelled cell: a title or note of a sheet, never part of the last cell. */
export function isPlainProjection(raw: string): boolean {
  return PLAIN_PROJECTION.test(raw);
}

export function isDocumentProjection(raw: string): boolean {
  return DOCUMENT_PROJECTION.test(raw);
}

/** A line a table extraction wrote, whether or not it holds labelled cells. */
export function isProjectedLine(raw: string): boolean {
  return isPlainProjection(raw) || isDocumentProjection(raw);
}

/**
 * How a projected table is read, from the columns of all its rows: a row lists only the cells it
 * fills, so one row alone may not show the header.
 */
export function readingOfProjectedTable(
  rows: readonly ProjectedRow[],
  vocabulary: CompiledVocabulary,
): TableReading {
  const labels = [...new Set(rows.flatMap((row) => row.labels))];
  if (labels.every((label) => NEUTRAL_LABEL.test(label))) return { kind: "positional" };
  const roles = namedColumns(labels, vocabulary);
  return namesRequirementColumns(roles) ? { kind: "roles", roles } : { kind: "foreign" };
}

/** A line inside a multi-line cell: it completes the last cell, then may open further cells. */
export function continueProjectedRow(
  row: ProjectedRow,
  raw: string,
  vocabulary: CompiledVocabulary,
): void {
  const last = row.cells.length - 1;
  const [first = "", ...rest] = raw.split(PROJECTED_CELL_BREAK);
  row.cells[last] = `${row.cells[last] ?? ""}\n${first}`;
  appendProjectedCells(row, rest, vocabulary);
}

export interface ProjectedCells {
  readonly cells: readonly string[];
  /** The role of each cell; undefined for a table without a header. */
  readonly roles: ColumnRoles | undefined;
}

/** The cells of a projected row by what their labels name; every line of a criteria cell is one. */
export function namedCellsOf(row: ProjectedRow): {
  readonly cells: readonly string[];
  readonly roles: ColumnRoles;
} {
  const cells: string[] = [];
  const roles: (TableColumnRole | undefined)[] = [];
  row.cells.forEach((cell, index) => {
    const role = row.roles[index];
    for (const piece of role === "criteria" ? cell.split("\n") : [cell]) {
      cells.push(collapse(piece));
      roles.push(role);
    }
  });
  return { cells, roles };
}

/** The cells of a finished projected row, read by its table. */
export function projectedCells(row: ProjectedRow, reading: TableReading): ProjectedCells {
  const { cells, roles } = namedCellsOf(row);
  return { cells, roles: reading.kind === "roles" ? projectedRoles(roles, reading) : undefined };
}

function projectedRoles(
  roles: ColumnRoles,
  reading: Extract<TableReading, { kind: "roles" }>,
): ColumnRoles {
  return knownRoles(reading.roles).length === 1 ? withPositionalColumns(roles) : roles;
}
