import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UiStoreError } from "./errors.js";
import {
  nullableNumberColumn,
  nullableTextColumn,
  numberColumn,
  textColumn,
  type UiStoreSqlRow,
} from "./sql-row.js";

function thrownBy(read: () => string | number | null): UiStoreError {
  try {
    read();
  } catch (error) {
    if (error instanceof UiStoreError) return error;
    throw error;
  }
  throw new Error("expected the reader to throw");
}

describe("UiStore SQLite column readers", () => {
  let db: DatabaseSync;

  // A table without STRICT stores whatever it is given, so a drifted value reaches the readers.
  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE t (text_value, number_value, blob_value)");
  });

  afterEach(() => {
    db.close();
  });

  function storedRow(
    text: SQLInputValue,
    number: SQLInputValue,
    blob: SQLInputValue,
  ): UiStoreSqlRow {
    db.exec("DELETE FROM t");
    db.prepare("INSERT INTO t VALUES (?, ?, ?)").run(text, number, blob);
    const row = db.prepare("SELECT text_value, number_value, blob_value FROM t").get();
    if (row === undefined) throw new Error("fixture row missing");
    return row;
  }

  it("reads stored text and numbers as they are", () => {
    const row = storedRow("chat-1", 42, null);
    expect(textColumn(row, "text_value")).toBe("chat-1");
    expect(numberColumn(row, "number_value")).toBe(42);
    expect(nullableTextColumn(row, "text_value")).toBe("chat-1");
    expect(nullableNumberColumn(row, "number_value")).toBe(42);
  });

  it("reads NULL as null only through the nullable readers", () => {
    const row = storedRow(null, null, null);
    expect(nullableTextColumn(row, "text_value")).toBeNull();
    expect(nullableNumberColumn(row, "number_value")).toBeNull();
    expect(() => textColumn(row, "text_value")).toThrow(UiStoreError);
    expect(() => numberColumn(row, "number_value")).toThrow(UiStoreError);
  });

  it("fails closed on a value of another storage class", () => {
    const row = storedRow(7, "7", new Uint8Array([1]));
    expect(() => textColumn(row, "text_value")).toThrow(UiStoreError);
    expect(() => nullableTextColumn(row, "text_value")).toThrow(UiStoreError);
    expect(() => numberColumn(row, "number_value")).toThrow(UiStoreError);
    expect(() => nullableNumberColumn(row, "number_value")).toThrow(UiStoreError);
    expect(() => textColumn(row, "blob_value")).toThrow(UiStoreError);
    expect(() => numberColumn(row, "blob_value")).toThrow(UiStoreError);
  });

  it("fails closed on a column the SELECT did not return", () => {
    const row = storedRow("chat-1", 1, null);
    expect(() => textColumn(row, "missing")).toThrow(UiStoreError);
    expect(() => nullableTextColumn(row, "missing")).toThrow(UiStoreError);
    expect(() => numberColumn(row, "missing")).toThrow(UiStoreError);
    expect(() => nullableNumberColumn(row, "missing")).toThrow(UiStoreError);
  });

  it("names no column or value in the error", () => {
    const row = storedRow(7, null, null);
    const failure = thrownBy(() => textColumn(row, "text_value"));
    expect(failure.code).toBe("INTERNAL");
    expect(failure.status).toBe(500);
    expect(failure.message).not.toContain("text_value");
    expect(failure.message).not.toContain("7");
  });
});
