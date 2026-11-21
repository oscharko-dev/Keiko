import type { SQLOutputValue } from "node:sqlite";
import { KnowledgeStoreError } from "./errors.js";

// node:sqlite types every row as an open record of SQLOutputValue. These readers check each
// column against the type the store schema declares for it, so a column missing from the SELECT
// or a drifted schema fails closed with a KnowledgeStoreError instead of reaching a typed row.
export type KnowledgeSqlRow = Readonly<Record<string, SQLOutputValue>>;

function columnTypeMismatch(column: string): KnowledgeStoreError {
  return new KnowledgeStoreError(
    `A stored knowledge column holds a value of an unexpected type: ${column}`,
  );
}

export function textColumn(row: KnowledgeSqlRow, column: string): string {
  const value = row[column];
  if (typeof value !== "string") throw columnTypeMismatch(column);
  return value;
}

export function nullableTextColumn(row: KnowledgeSqlRow, column: string): string | null {
  return row[column] === null ? null : textColumn(row, column);
}

export function numberColumn(row: KnowledgeSqlRow, column: string): number {
  const value = row[column];
  if (typeof value !== "number") throw columnTypeMismatch(column);
  return value;
}

export function nullableNumberColumn(row: KnowledgeSqlRow, column: string): number | null {
  return row[column] === null ? null : numberColumn(row, column);
}

export function blobColumn(row: KnowledgeSqlRow, column: string): Uint8Array {
  const value = row[column];
  if (!(value instanceof Uint8Array)) throw columnTypeMismatch(column);
  return value;
}

export function nullableBlobColumn(row: KnowledgeSqlRow, column: string): Uint8Array | null {
  return row[column] === null ? null : blobColumn(row, column);
}

// A text column whose admitted values are narrower than `string`: a branded id or a closed
// vocabulary. `admits` states the whole runtime definition of that narrower type, so a stored
// value it refuses fails closed instead of being asserted into the type.
export type TextAdmission<T extends string> = (value: string) => value is T;

function columnValueRefused(column: string): KnowledgeStoreError {
  return new KnowledgeStoreError(
    `A stored knowledge column holds a value it does not admit: ${column}`,
  );
}

export function admittedTextColumn<T extends string>(
  row: KnowledgeSqlRow,
  column: string,
  admits: TextAdmission<T>,
): T {
  const value = textColumn(row, column);
  if (!admits(value)) throw columnValueRefused(column);
  return value;
}

export function nullableAdmittedTextColumn<T extends string>(
  row: KnowledgeSqlRow,
  column: string,
  admits: TextAdmission<T>,
): T | null {
  return row[column] === null ? null : admittedTextColumn(row, column, admits);
}

// Admits exactly the members of a closed vocabulary, looked up in a Set built once.
export function vocabularyAdmission<T extends string>(members: readonly T[]): TextAdmission<T> {
  const admitted: ReadonlySet<string> = new Set(members);
  return (value: string): value is T => admitted.has(value);
}
