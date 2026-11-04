// Requirement rows of a table (#4179, Epic #4173): `| FR-2 | Bar | Soll |`.
//
// A row defines a requirement when its identifier cell is exactly an identifier: the first column
// whose header role is id (`Lfd. Nr. | ID | Titel`), or the first cell when the header names no id
// column or there is no header (#4235). A header row that names the columns (any language in the
// vocabulary) assigns the roles; without one the second cell is the title and a cell equal to a
// priority value is the priority.

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

/** Column roles of a header row; undefined unless at least two cells name a known role. */
export function parseTableHeader(
  cells: readonly string[],
  vocabulary: CompiledVocabulary,
): ColumnRoles | undefined {
  const roles = cells.map((cell) => tableRoleOf(vocabulary, cell));
  return roles.filter((role) => role !== undefined).length >= 2 ? roles : undefined;
}

function identifierIn(cell: string | undefined): string | undefined {
  return ID_EXACT.exec(collapse((cell ?? "").replaceAll("*", "")))?.[1];
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

function assignByRole(
  cells: readonly string[],
  roles: ColumnRoles,
  idIndex: number,
  parts: RowParts,
): void {
  cells.forEach((cell, index) => {
    const role = roles[index];
    if (cell.length === 0 || index === idIndex) return;
    if (role === "title") parts.title = cell;
    else if (role === "priority") parts.priority = cell;
    else if (role === "criteria") parts.criteria.push(cell);
    else if (role === "statement") parts.statement.push(cell);
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
  else assignByRole(cells, roles, identifier.index, parts);
  return {
    id: identifier.id,
    title: parts.title,
    ...(parts.priority === undefined ? {} : { priority: parts.priority }),
    statement: parts.statement.join(" "),
    criteria: parts.criteria,
  };
}

// ─── Spreadsheet projection ──────────────────────────────────────────────────

/**
 * The text a table extraction stores for one row: `Sheet!2: ID=FR-1 | Titel=Foo | Priorität=Muss`
 * (the xlsx and CSV parsers label every cell with its column header; a CSV row reads `csv!2:`). A cell that holds line breaks (a list
 * of acceptance criteria) continues on the lines that follow, up to the next row. A blank line
 * inside a free-text cell (criteria, statement) is a paragraph break of that cell; it ends any
 * other row, whose cells are single labels.
 */
export interface ProjectedRow {
  readonly cells: string[];
  readonly roles: (TableColumnRole | undefined)[];
}

// A worksheet name may hold `=`, `|` and `!` but never `:` (Excel forbids `\ / ? * [ ] :`), so the
// first colon ends the `Sheet!Row:` prefix. A header label is at most 120 characters in the
// projection (plus the ` 2` of a repeated one); the bound here stays above that, so no header the
// projection labels a cell with is too long to be read as a label.
const MAX_LABEL_CHARS = 160;
const PROJECTION_PREFIX = new RegExp(
  String.raw`^[^\n:]{1,120}!\d{1,9}:[ \t]+(?=[^=|\n]{1,${String(MAX_LABEL_CHARS)}}=)`,
  "u",
);
const PROJECTED_CELL_BREAK = new RegExp(
  String.raw` \| (?=[^=|\n]{1,${String(MAX_LABEL_CHARS)}}=)`,
  "u",
);
// A projected line that holds no labelled cell (a title, a note, a header-only table).
const PLAIN_PROJECTION_PREFIX = /^[^\n:]{1,120}!\d{1,9}:(?:[ \t]|$)/u;

function appendProjectedCells(
  row: ProjectedRow,
  parts: readonly string[],
  vocabulary: CompiledVocabulary,
): boolean {
  for (const part of parts) {
    const equals = part.indexOf("=");
    if (equals < 1) return false;
    row.roles.push(tableRoleOf(vocabulary, part.slice(0, equals)));
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
  if (prefix === null) {
    return PLAIN_PROJECTION_PREFIX.test(raw) ? { cells: [], roles: [] } : undefined;
  }
  const row: ProjectedRow = { cells: [], roles: [] };
  const parts = raw.slice(prefix[0].length).split(PROJECTED_CELL_BREAK);
  return appendProjectedCells(row, parts, vocabulary) ? row : { cells: [], roles: [] };
}

const PARAGRAPH_ROLES: ReadonlySet<TableColumnRole | undefined> = new Set([
  "criteria",
  "statement",
]);

/** Whether the row's last cell is free text, so a blank line is a paragraph break inside it. */
export function endsInParagraphCell(row: ProjectedRow): boolean {
  return PARAGRAPH_ROLES.has(row.roles.at(-1));
}

/** A line inside a multi-line cell: it completes the last cell, then may open further cells. */
export function continueProjectedRow(
  row: ProjectedRow,
  raw: string,
  vocabulary: CompiledVocabulary,
): void {
  const last = row.cells.length - 1;
  if (last < 0) return;
  const [first = "", ...rest] = raw.split(PROJECTED_CELL_BREAK);
  row.cells[last] = `${row.cells[last] ?? ""}\n${first}`;
  appendProjectedCells(row, rest, vocabulary);
}

/** The requirement a finished projected row defines; every line of a criteria cell is one item. */
export function parseProjectedRow(
  row: ProjectedRow,
  vocabulary: CompiledVocabulary,
): TableRow | undefined {
  const cells: string[] = [];
  const roles: (TableColumnRole | undefined)[] = [];
  row.cells.forEach((cell, index) => {
    const role = row.roles[index];
    for (const piece of role === "criteria" ? cell.split("\n") : [cell]) {
      cells.push(collapse(piece));
      roles.push(role);
    }
  });
  // A table whose headers name no role the reader knows is read by position, like a pipe table
  // without a header, instead of defining a requirement with no title and no text.
  const named = roles.some((role) => role !== undefined);
  return parseTableRow(cells, named ? roles : undefined, vocabulary);
}
