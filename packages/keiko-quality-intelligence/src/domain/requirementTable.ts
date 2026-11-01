// Requirement rows of a table (#4179, Epic #4173): `| FR-2 | Bar | Soll |`.
//
// A row defines a requirement when its first cell is exactly an identifier. A header row that names
// the columns (any language in the vocabulary) assigns the roles; without one the second cell is the
// title and a cell equal to a priority value is the priority.

import { ID_EXACT, collapse } from "./requirementText.js";
import {
  foldTerm,
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
  const roles = cells.map((cell) => vocabulary.tableRoles.get(foldTerm(cell)));
  return roles.filter((role) => role !== undefined).length >= 2 ? roles : undefined;
}

function firstIdCell(cells: readonly string[]): string | undefined {
  const match = ID_EXACT.exec(collapse((cells[0] ?? "").replaceAll("*", "")));
  return match?.[1];
}

interface RowParts {
  title: string;
  priority: string | undefined;
  statement: string[];
  criteria: string[];
}

function assignByRole(cells: readonly string[], roles: ColumnRoles, parts: RowParts): void {
  cells.forEach((cell, index) => {
    const role = roles[index];
    if (cell.length === 0 || index === 0) return;
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

/** The requirement a table row defines, or undefined when its first cell is not an identifier. */
export function parseTableRow(
  cells: readonly string[],
  roles: ColumnRoles | undefined,
  vocabulary: CompiledVocabulary,
): TableRow | undefined {
  const id = firstIdCell(cells);
  if (id === undefined || isSeparatorRow(cells)) return undefined;
  const parts: RowParts = { title: "", priority: undefined, statement: [], criteria: [] };
  if (roles === undefined) assignByPosition(cells, vocabulary, parts);
  else assignByRole(cells, roles, parts);
  return {
    id,
    title: parts.title,
    ...(parts.priority === undefined ? {} : { priority: parts.priority }),
    statement: parts.statement.join(" "),
    criteria: parts.criteria,
  };
}
