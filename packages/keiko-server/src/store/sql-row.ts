import type { SQLOutputValue } from "node:sqlite";
import { UiStoreError } from "./errors.js";

/** The row node:sqlite returns from `StatementSync.get` and `StatementSync.all`. */
export type UiStoreSqlRow = Readonly<Record<string, SQLOutputValue>>;

type StoredValueCheck<T extends SQLOutputValue> = (value: SQLOutputValue) => value is T;

const isStoredText: StoredValueCheck<string> = (value): value is string =>
  typeof value === "string";
const isStoredNumber: StoredValueCheck<number> = (value): value is number =>
  typeof value === "number";

// Reads one column and checks its stored value against the type the UiStore schema declares. A
// column the SELECT did not return, or a value of another type (a drifted or tampered database),
// fails closed. The message names no column, path or value, so the BFF error envelope stays safe.
function storedColumn<T extends SQLOutputValue>(
  row: UiStoreSqlRow,
  column: string,
  accepts: StoredValueCheck<T>,
): T {
  const value = row[column];
  if (value !== undefined && accepts(value)) return value;
  throw new UiStoreError("INTERNAL", "A stored record holds a value of an unexpected type.", 500);
}

function nullableStoredColumn<T extends SQLOutputValue>(
  row: UiStoreSqlRow,
  column: string,
  accepts: StoredValueCheck<T>,
): T | null {
  return row[column] === null ? null : storedColumn(row, column, accepts);
}

/** Reads a TEXT column. */
export const textColumn = (row: UiStoreSqlRow, column: string): string =>
  storedColumn(row, column, isStoredText);

/** Reads a nullable TEXT column. */
export const nullableTextColumn = (row: UiStoreSqlRow, column: string): string | null =>
  nullableStoredColumn(row, column, isStoredText);

/** Reads an INTEGER or REAL column as a number. */
export const numberColumn = (row: UiStoreSqlRow, column: string): number =>
  storedColumn(row, column, isStoredNumber);

/** Reads a nullable INTEGER or REAL column. */
export const nullableNumberColumn = (row: UiStoreSqlRow, column: string): number | null =>
  nullableStoredColumn(row, column, isStoredNumber);
