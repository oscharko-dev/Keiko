import { describe, expect, it } from "vitest";
import { MemoryStorageError } from "./errors.js";
import {
  blobColumn,
  nullableNumberColumn,
  nullableTextColumn,
  numberColumn,
  textColumn,
  type VaultSqlRow,
} from "./statements.js";

const ROW: VaultSqlRow = {
  text: "value",
  number: 42,
  blob: new Uint8Array([1, 2, 3]),
  empty: null,
  big: 7n,
};

function expectSchemaMismatch(read: () => void): void {
  try {
    read();
  } catch (error) {
    expect(error).toBeInstanceOf(MemoryStorageError);
    expect(error).toMatchObject({ code: "schema-mismatch" });
    return;
  }
  expect.unreachable("the column reader accepted a value of the wrong type");
}

describe("vault column readers", () => {
  it("return a column whose stored value matches the declared type", () => {
    expect(textColumn(ROW, "text")).toBe("value");
    expect(numberColumn(ROW, "number")).toBe(42);
    expect(blobColumn(ROW, "blob")).toEqual(new Uint8Array([1, 2, 3]));
    expect(nullableTextColumn(ROW, "text")).toBe("value");
    expect(nullableNumberColumn(ROW, "number")).toBe(42);
  });

  it("return null for a NULL column only through the nullable readers", () => {
    expect(nullableTextColumn(ROW, "empty")).toBeNull();
    expect(nullableNumberColumn(ROW, "empty")).toBeNull();
    expectSchemaMismatch(() => textColumn(ROW, "empty"));
    expectSchemaMismatch(() => numberColumn(ROW, "empty"));
    expectSchemaMismatch(() => blobColumn(ROW, "empty"));
  });

  it("refuse a value of another storage class", () => {
    expectSchemaMismatch(() => textColumn(ROW, "number"));
    expectSchemaMismatch(() => textColumn(ROW, "blob"));
    expectSchemaMismatch(() => numberColumn(ROW, "text"));
    expectSchemaMismatch(() => numberColumn(ROW, "big"));
    expectSchemaMismatch(() => blobColumn(ROW, "text"));
    expectSchemaMismatch(() => nullableTextColumn(ROW, "number"));
    expectSchemaMismatch(() => nullableNumberColumn(ROW, "text"));
  });

  it("refuse a column the row does not carry", () => {
    expectSchemaMismatch(() => textColumn(ROW, "missing"));
    expectSchemaMismatch(() => nullableTextColumn(ROW, "missing"));
    expectSchemaMismatch(() => numberColumn(ROW, "missing"));
    expectSchemaMismatch(() => nullableNumberColumn(ROW, "missing"));
    expectSchemaMismatch(() => blobColumn(ROW, "missing"));
  });
});
