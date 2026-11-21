import { describe, expect, it } from "vitest";
import { KnowledgeStoreError } from "./errors.js";
import {
  admittedTextColumn,
  blobColumn,
  nullableAdmittedTextColumn,
  nullableBlobColumn,
  nullableNumberColumn,
  nullableTextColumn,
  numberColumn,
  textColumn,
  type KnowledgeSqlRow,
  vocabularyAdmission,
} from "./sql-row.js";

const ROW: KnowledgeSqlRow = {
  text: "value",
  number: 42,
  blob: new Uint8Array([1, 2, 3]),
  empty: null,
  big: 7n,
};

type ColumnReader = (row: KnowledgeSqlRow, column: string) => string | number | Uint8Array | null;

const READERS: readonly (readonly [string, ColumnReader])[] = [
  ["textColumn", textColumn],
  ["nullableTextColumn", nullableTextColumn],
  ["numberColumn", numberColumn],
  ["nullableNumberColumn", nullableNumberColumn],
  ["blobColumn", blobColumn],
  ["nullableBlobColumn", nullableBlobColumn],
];

describe("knowledge column readers", () => {
  it.each([
    ["textColumn", textColumn, "text", "value"],
    ["nullableTextColumn", nullableTextColumn, "text", "value"],
    ["nullableTextColumn", nullableTextColumn, "empty", null],
    ["numberColumn", numberColumn, "number", 42],
    ["nullableNumberColumn", nullableNumberColumn, "number", 42],
    ["nullableNumberColumn", nullableNumberColumn, "empty", null],
    ["blobColumn", blobColumn, "blob", new Uint8Array([1, 2, 3])],
    ["nullableBlobColumn", nullableBlobColumn, "blob", new Uint8Array([1, 2, 3])],
    ["nullableBlobColumn", nullableBlobColumn, "empty", null],
  ] as const)("%s reads column %s", (_name, read: ColumnReader, column, expected) => {
    expect(read(ROW, column)).toEqual(expected);
  });

  it.each([
    [textColumn, "empty"],
    [numberColumn, "empty"],
    [blobColumn, "empty"],
    [textColumn, "number"],
    [textColumn, "blob"],
    [numberColumn, "text"],
    [numberColumn, "big"],
    [blobColumn, "text"],
    [nullableTextColumn, "number"],
    [nullableNumberColumn, "text"],
    [nullableBlobColumn, "text"],
  ] as const)("refuses a stored value of another storage class (%#)", (read, column) => {
    expect(() => read(ROW, column)).toThrow(KnowledgeStoreError);
    expect(() => read(ROW, column)).toThrow(/unexpected type/u);
  });

  it("refuses a column the row does not carry, whichever reader asks", () => {
    for (const [name, read] of READERS) {
      expect(() => read(ROW, "missing"), name).toThrow(KnowledgeStoreError);
    }
  });
});

describe("admitted text column readers", () => {
  const isColour = vocabularyAdmission(["red", "green"] as const);
  const COLOURS: KnowledgeSqlRow = { known: "red", unknown: "blue", empty: null, number: 1 };

  it("reads a member of the admitted set", () => {
    expect(admittedTextColumn(COLOURS, "known", isColour)).toBe("red");
    expect(nullableAdmittedTextColumn(COLOURS, "known", isColour)).toBe("red");
    expect(nullableAdmittedTextColumn(COLOURS, "empty", isColour)).toBeNull();
  });

  it("refuses a stored text outside the admitted set", () => {
    expect(() => admittedTextColumn(COLOURS, "unknown", isColour)).toThrow(/does not admit/u);
    expect(() => nullableAdmittedTextColumn(COLOURS, "unknown", isColour)).toThrow(
      KnowledgeStoreError,
    );
  });

  it("refuses a value of another storage class before the admission runs", () => {
    expect(() => admittedTextColumn(COLOURS, "number", isColour)).toThrow(/unexpected type/u);
    expect(() => admittedTextColumn(COLOURS, "empty", isColour)).toThrow(/unexpected type/u);
  });

  it("admits exactly the vocabulary members", () => {
    expect(isColour("green")).toBe(true);
    expect(isColour("Green")).toBe(false);
    expect(isColour("")).toBe(false);
  });
});
