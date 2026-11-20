import { describe, expect, it } from "vitest";
import { MemoryStorageError } from "./errors.js";
import {
  blobColumn,
  closedVocabulary,
  idColumn,
  nullableIdColumn,
  nullableNumberColumn,
  nullableTextColumn,
  nullableVocabularyColumn,
  numberColumn,
  storedId,
  textColumn,
  vocabularyColumn,
  vocabularyMember,
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

type Shade = "light" | "dark";

const SHADES = closedVocabulary<Shade>(["light", "dark"]);

function isShortCode(value: string): value is `c-${string}` {
  return value.startsWith("c-");
}

const VOCABULARY_ROW: VaultSqlRow = {
  shade: "dark",
  other: "grey",
  code: "c-1",
  bad: "x",
  gap: null,
};

describe("vault vocabulary readers", () => {
  it("return the typed member for a stored value inside the vocabulary", () => {
    expect(vocabularyMember(SHADES, "light")).toBe("light");
    expect(vocabularyColumn(VOCABULARY_ROW, "shade", SHADES)).toBe("dark");
    expect(nullableVocabularyColumn(VOCABULARY_ROW, "shade", SHADES)).toBe("dark");
    expect(nullableVocabularyColumn(VOCABULARY_ROW, "gap", SHADES)).toBeNull();
  });

  it("refuse a stored value outside the vocabulary", () => {
    expectSchemaMismatch(() => vocabularyMember(SHADES, "grey"));
    expectSchemaMismatch(() => vocabularyMember(SHADES, "Light"));
    expectSchemaMismatch(() => vocabularyColumn(VOCABULARY_ROW, "other", SHADES));
    expectSchemaMismatch(() => vocabularyColumn(VOCABULARY_ROW, "gap", SHADES));
    expectSchemaMismatch(() => nullableVocabularyColumn(VOCABULARY_ROW, "other", SHADES));
    expectSchemaMismatch(() => vocabularyColumn(VOCABULARY_ROW, "missing", SHADES));
  });
});

describe("vault branded id readers", () => {
  it("return a stored id the brand predicate admits", () => {
    expect(storedId("c-7", isShortCode)).toBe("c-7");
    expect(idColumn(VOCABULARY_ROW, "code", isShortCode)).toBe("c-1");
    expect(nullableIdColumn(VOCABULARY_ROW, "code", isShortCode)).toBe("c-1");
    expect(nullableIdColumn(VOCABULARY_ROW, "gap", isShortCode)).toBeNull();
  });

  it("refuse a stored id the brand predicate rejects", () => {
    expectSchemaMismatch(() => storedId("x", isShortCode));
    expectSchemaMismatch(() => idColumn(VOCABULARY_ROW, "bad", isShortCode));
    expectSchemaMismatch(() => idColumn(VOCABULARY_ROW, "gap", isShortCode));
    expectSchemaMismatch(() => nullableIdColumn(VOCABULARY_ROW, "bad", isShortCode));
    expectSchemaMismatch(() => idColumn(VOCABULARY_ROW, "missing", isShortCode));
  });
});
